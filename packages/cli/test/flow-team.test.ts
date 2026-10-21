import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// A team against a scripted model. Each member's session starts with an introduction naming it, so the model knows
// who is speaking from the first user message, and which turn it is from how many user messages the session holds.
const turns: Array<{ member: string; turn: number; prompt: string; history: number }> = []
const failures = { reviewer: 0 }

const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    const details = {
      format: "gguf",
      family: "llama",
      families: ["llama"],
      parameter_size: "1B",
      quantization_level: "Q4",
    }
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "tiny:1b", model: "tiny:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
        ],
      })
    if (pathname === "/api/show")
      return Response.json({
        parameters: "",
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    if (pathname === "/api/ps") return Response.json({ models: [] })
    const body = await request.json()
    if (!body.tools) return reply("Team task")
    const messages: Array<{ role: string; content?: unknown }> = body.messages
    const users = messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content))
    const member = users[0]?.match(/You are \\"(\w+)\\"/)?.[1] ?? "unknown"
    const turn = users.length
    const prompt = users.at(-1) ?? ""
    if (messages.at(-1)?.role === "tool") return reply('<message to="reviewer">Done: answer.txt has 42.</message>')
    turns.push({ member, turn, prompt, history: messages.length })
    if (member === "lead" && turn === 1)
      return reply(
        'Plan ready.\n<note key="plan">coder writes answer.txt; reviewer checks it</note>\n<message to="coder">Write 42 into answer.txt.</message>',
      )
    if (member === "lead") return reply("<done>answer.txt contains 42, reviewed.</done>")
    if (member === "coder")
      return stream(
        [
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${turns.length}`,
                type: "function",
                function: { name: "Write", arguments: JSON.stringify({ file_path: "answer.txt", content: "42\n" }) },
              },
            ],
          },
        ],
        "tool_calls",
      )
    if (member === "reviewer" && failures.reviewer > 0) {
      failures.reviewer--
      return Response.json({ error: { message: "model crashed", type: "invalid_request_error" } }, { status: 400 })
    }
    if (member === "reviewer") return reply('<message to="lead">Looks correct.</message>')
    // The member of the stalled team: talks to someone who does not exist, then has nothing more to say.
    if (turn === 1) return reply('<message to="ghost">Are you there?</message>')
    return reply("Still thinking.")
  },
})

function reply(text: string) {
  return stream([{ role: "assistant", content: text }], "stop")
}

function stream(deltas: unknown[], finish: string) {
  const events = [
    ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } },
  ]
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-team-"))
// The workflows live in a folder of their own: the root is the home directory of the isolated environment, which no
// server trusts without a grant, and a command that loads a file needs the folder that holds it trusted.
const flows = path.join(root, "flows")

beforeAll(async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a team's lead assigns work, members message each other, and the lead finishes", async () => {
  const repository = await repo("team")
  const file = path.join(flows, "team.ts")
  await Bun.write(
    file,
    `export default {
  name: "team",
  async run(ctx) {
    const result = await ctx.team("feature", {
      goal: "answer.txt must contain the answer, reviewed.",
      members: {
        lead: { role: "Plan and coordinate." },
        coder: { role: "Write the files." },
        reviewer: { role: "Review the work. Do not edit files." },
      },
    })
    await ctx.merge("merge", [result])
    return { done: result.done, summary: result.summary, rounds: result.rounds, turns: result.turns, board: result.board, messages: result.messages }
  },
}
`,
  )
  turns.length = 0

  const result = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(result.stdout)).toEqual({
    done: true,
    summary: "answer.txt contains 42, reviewed.",
    rounds: 4,
    turns: 4,
    board: { plan: "coder writes answer.txt; reviewer checks it" },
    messages: [
      { from: "lead", to: "coder", text: "Write 42 into answer.txt." },
      { from: "coder", to: "reviewer", text: "Done: answer.txt has 42." },
      { from: "reviewer", to: "lead", text: "Looks correct." },
    ],
  })
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual(["lead#1", "coder#1", "reviewer#1", "lead#2"])
  // Messages and the board reach the next turn, and the lead's second turn continues its own session.
  expect(turns[1]?.prompt).toContain("[from lead] Write 42 into answer.txt.")
  expect(turns[1]?.prompt).toContain("plan: coder writes answer.txt")
  expect(turns[3]?.prompt).toContain("[from reviewer] Looks correct.")
  expect(turns[3]?.history).toBeGreaterThan(turns[0]?.history ?? 0)
  // Git for Windows may check files out with CRLF line endings (core.autocrlf).
  expect((await Bun.file(path.join(repository, "answer.txt")).text()).replace(/\r\n/g, "\n")).toBe("42\n")
  const shown = await orb(repository, ["flow", "show", "--standalone", await runID(repository)])
  expect(shown.stdout).toContain("feature: lead → coder: Write 42 into answer.txt.")
  expect(shown.stdout).toContain("feature: lead noted plan:")
  const calls = turns.length
  // A replay calls no model, but it asks a server whether the folder is trusted before it reads the run store.
  const replayed = await orb(repository, ["flow", "replay", "--standalone", await runID(repository)])
  expect({ code: replayed.code, stderr: replayed.code === 0 ? "" : replayed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(replayed.stderr).toContain("replay matches the recorded output")
  expect(turns.length).toBe(calls)
}, 240_000)

test("a team stops when nobody has anything to do and the lead does not finish", async () => {
  const repository = await repo("stall")
  const file = path.join(flows, "stall.ts")
  await Bun.write(
    file,
    `export default {
  name: "stall",
  run: (ctx) => ctx.team("solo", { goal: "Say hello.", members: { solo: { role: "Do everything." } }, worktree: false }),
}
`,
  )
  turns.length = 0

  const result = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("the team stopped: nobody had anything pending and the lead did not finish")
  // Turn 2 tells it the message went nowhere; turn 3 is the nudge; then the team stops.
  expect(turns.map((item) => item.turn)).toEqual([1, 2, 3])
  expect(turns[1]?.prompt).toContain("was not delivered: there is no such member")
  expect(turns[2]?.prompt).toContain("Nobody on the team has anything pending")
}, 240_000)

async function repo(name: string) {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "readme.md"), "fixture\n")
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
  ])
    await Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "ignore" }).exited
  return directory
}

async function runID(directory: string) {
  return JSON.parse((await orb(directory, ["flow", "ls", "--standalone", "--format", "json"])).stdout)[0].id as string
}

async function orb(directory: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: directory,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("a resumed team reuses the turns that ran and continues from the failed one", async () => {
  const repository = await repo("team-resume")
  const file = path.join(flows, "team-resume.ts")
  await Bun.write(
    file,
    `export default {
  name: "team",
  run: (ctx) =>
    ctx.team("feature", {
      goal: "answer.txt must contain the answer, reviewed.",
      members: {
        lead: { role: "Plan and coordinate." },
        coder: { role: "Write the files." },
        reviewer: { role: "Review the work. Do not edit files." },
      },
    }).then((result) => ({ done: result.done, turns: result.turns })),
}
`,
  )
  turns.length = 0
  failures.reviewer = 1

  const failed = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])

  expect(failed.code).toBe(1)
  expect(turns.map((item) => item.member)).toEqual(["lead", "coder", "reviewer"])
  const resumed = await orb(repository, ["flow", "resume", "--standalone", await runID(repository)])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(resumed.stdout)).toEqual({ done: true, turns: 4 })
  expect(resumed.stderr).toContain("= feature/lead#1 (recorded)")
  expect(resumed.stderr).toContain("= feature/coder#2 (recorded)")
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
    "lead#1",
    "coder#1",
    "reviewer#1",
    "reviewer#1",
    "lead#2",
  ])
}, 240_000)
