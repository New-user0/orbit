import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { startSlot } from "./fixture/start-gate"
import { removeTree } from "../../core/test/fixture/remove-tree"

// A team against a scripted model. Each member's session starts with an introduction naming it, so the model knows
// who is speaking from the first user message, and which turn it is from how many user messages the flow sent it. The
// server may add instruction updates (a date that changed, a git snapshot taken late) to a session between two turns;
// the chat-completions request carries each as a user-role message that starts with `<system-update>`, so they are
// listed apart in `updates` and do not count as turns (FU-M3-421).
const turns: Array<{
  member: string
  turn: number
  prompt: string
  history: number
  users: string[]
  updates: string[]
  request: unknown[]
}> = []
const failures = { reviewer: 0 }
// A lead request that the server holds: `arrived` resolves when the lead's first turn asks, and the answer waits for
// `answer`, so a test can stop the process while that turn is still running.
const held: { lead?: { arrived: PromiseWithResolvers<void>; answer: PromiseWithResolvers<void> } } = {}

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
    const all = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content))
    const isUpdate = (text: string) => text.startsWith('"<system-update>')
    const users = all.filter((text) => !isUpdate(text))
    const updates = all.filter(isUpdate)
    const member = users[0]?.match(/You are \\"(\w+)\\"/)?.[1] ?? "unknown"
    const turn = users.length
    const prompt = users.at(-1) ?? ""
    if (messages.at(-1)?.role === "tool") return reply('<message to="reviewer">Done: answer.txt has 42.</message>')
    turns.push({ member, turn, prompt, history: messages.length, users, updates, request: messages })
    const hold = member === "lead" && turn === 1 ? held.lead : undefined
    if (hold) {
      held.lead = undefined
      hold.arrived.resolve()
      await hold.answer.promise
    }
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

// The updates that may reach a lead between two processes: a date that changed, a git snapshot taken late. A row that
// does not force either asserts there is no other, so a spurious or duplicated update shows here and not nowhere.
function unexpectedUpdates() {
  return turns
    .flatMap((item) => item.updates)
    .filter((text) => !text.includes("Today's date is now:") && !text.includes("taken partway through the session"))
}

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
  await removeTree(root)
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

// FU-M3-421: once, on a loaded Linux runner, the resumed lead's request held a third user message ("lead#3"). Two ways
// that would be a product defect, a lead session holding a message the flow did not send, are each forced here, and
// neither gives one. The instruction updates that legitimately reach a resumed lead are forced further down.
// 1. The resume runs in another spelling of the same folder (a link on Linux, a junction on Windows), which would make
//    the server move the session and add its "location switched" message, if it took the spelling for another folder.
test("a team resumed through another spelling of its folder sends its lead no message of its own", async () => {
  const repository = await repo("team-spelling")
  const spelled = path.join(root, "team-spelling-link")
  await fs.symlink(repository, spelled, "junction")
  const file = path.join(flows, "team-spelling.ts")
  await Bun.write(file, resumable)
  turns.length = 0
  failures.reviewer = 1

  const failed = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])
  expect(failed.code).toBe(1)
  const resumed = await orb(spelled, ["flow", "resume", "--standalone", await runID(repository)])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(resumed.stdout)).toEqual({ done: true, turns: 4 })
  expect(unexpectedUpdates()).toEqual([])
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
    "lead#1",
    "coder#1",
    "reviewer#1",
    "reviewer#1",
    "lead#2",
  ])
}, 240_000)

// 2. The first process stops while the lead's first turn is still running, which keeps that session's execution claim
//    (a stop or a process death keeps it, AGENTS.md), so the resumed process could also recover the claimed run. The
//    resumed lead asks again from its introduction, once.
test("a team resumed after its process stopped during a lead turn asks the lead once, with no recovered message", async () => {
  const repository = await repo("team-stopped")
  const file = path.join(flows, "team-stopped.ts")
  await Bun.write(file, resumable)
  turns.length = 0
  const hold = { arrived: Promise.withResolvers<void>(), answer: Promise.withResolvers<void>() }
  held.lead = hold

  const stopped = await startSlot(async () => {
    const child = Bun.spawn(
      [process.execPath, "run", "src/index.ts", "flow", "run", "--standalone", "--model", "ollama/tiny:1b", file],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: environment(repository),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    await hold.arrived.promise
    child.kill()
    return child.exited
  })
  hold.answer.resolve()
  expect(stopped).not.toBe(0)
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual(["lead#1"])
  const resumed = await orb(repository, ["flow", "resume", "--standalone", await runID(repository)])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(resumed.stdout)).toEqual({ done: true, turns: 4 })
  expect(unexpectedUpdates()).toEqual([])
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
    "lead#1",
    "lead#1",
    "coder#1",
    "reviewer#1",
    "lead#2",
  ])
}, 240_000)

// The two instruction updates that can reach a resumed lead between its turns, each forced here (FU-M3-421). They are
// the server's documented behaviour (later frozen updates enter history as durable System messages), so the resumed
// lead's request holds one more message than the flow sent, and the turn counts only what the flow sent. Before the
// count left updates out, both rows saw "lead#3" where "lead#2" belongs.
// Not on Windows: there `gitExecutable` is an absolute path that `which` resolved at module load (packages/core/src/util/git-executable.ts), so a git shim on PATH is never run.
test.skipIf(process.platform === "win32")(
  "a lead whose first git snapshot failed is told of the late one and still counts two turns",
  async () => {
    const repository = await repo("team-late")
    const file = path.join(flows, "team-late.ts")
    await Bun.write(file, resumable)
    turns.length = 0
    failures.reviewer = 1
    // A git that fails its first `status --short` (the one the snapshot takes for the lead's first step) and runs the
    // real one for every other call. The resumed process runs the real git, so the snapshot is taken then, partway
    // through the session.
    const git = Bun.which("git")
    expect(git).not.toBeNull()
    const shims = path.join(root, "shims")
    await fs.mkdir(shims, { recursive: true })
    await Bun.write(
      path.join(shims, "git"),
      `#!/bin/sh
for a in "$@"; do [ "$a" = status ] && s=1; [ "$a" = --short ] && t=1; done
if [ -n "$s" ] && [ -n "$t" ] && [ ! -e "$SHIM_MARKER" ]; then : > "$SHIM_MARKER"; echo "fatal: forced failure" >&2; exit 128; fi
exec '${git}' "$@"
`,
    )
    await fs.chmod(path.join(shims, "git"), 0o755)
    const failed = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file], {
      PATH: `${shims}${path.delimiter}${process.env.PATH}`,
      SHIM_MARKER: path.join(root, "shim-marker"),
    })
    expect(failed.code).toBe(1)
    expect(await Bun.file(path.join(root, "shim-marker")).exists()).toBe(true)
    const resumed = await orb(repository, ["flow", "resume", "--standalone", await runID(repository)])

    expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
    expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
      "lead#1",
      "coder#1",
      "reviewer#1",
      "reviewer#1",
      "lead#2",
    ])
    expect(turns.at(-1)?.updates).toHaveLength(1)
    expect(turns.at(-1)?.updates[0]).toContain("Git facts for this folder, taken partway through the session")
  },
  240_000,
)

// Not on Windows: Bun 1.4.5 there ignores `TZ`, so the two processes would agree on the date.
test.skipIf(process.platform === "win32")(
  "a lead resumed on another date is told the date changed and still counts two turns",
  async () => {
    const repository = await repo("team-date")
    const file = path.join(flows, "team-date.ts")
    await Bun.write(file, resumable)
    turns.length = 0
    failures.reviewer = 1
    // The two zones are 26 hours apart, so the local date differs whatever the time of day.
    const failed = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file], {
      TZ: "Etc/GMT-14",
    })
    expect(failed.code).toBe(1)
    const resumed = await orb(repository, ["flow", "resume", "--standalone", await runID(repository)], {
      TZ: "Etc/GMT+12",
    })

    expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
    expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
      "lead#1",
      "coder#1",
      "reviewer#1",
      "reviewer#1",
      "lead#2",
    ])
    expect(turns.at(-1)?.updates).toHaveLength(1)
    expect(turns.at(-1)?.updates[0]).toContain("Today's date is now:")
  },
  240_000,
)

const resumable = `export default {
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
`

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

// A child holds a start slot while it runs, so a loaded runner never has more cold children than the start gate allows.
function environment(directory: string, extra: Record<string, string> = {}) {
  return isolatedEnv(root, {
    USERPROFILE: root,
    PWD: directory,
    ORBIT_CONFIG: undefined,
    ORBIT_CONFIG_CONTENT: undefined,
    OLLAMA_CONTEXT_LENGTH: undefined,
    ...extra,
  })
}

function orb(directory: string, args: string[], extra: Record<string, string> = {}) {
  return startSlot(async () => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
      cwd: path.join(import.meta.dir, ".."),
      env: environment(directory, extra),
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
  })
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
  // A lead whose session holds a user message the flow did not send (FU-M3-421, seen once on a loaded Linux runner, not
  // reproduced in 64 loaded runs on Linux and 16 on Windows) shows it here, with each request in full, so the next
  // failure names the message.
  if (turns.some((item) => item.member === "lead" && item.turn > 2)) console.error(JSON.stringify(turns, null, 1))
  expect(unexpectedUpdates()).toEqual([])
  expect(turns.map((item) => `${item.member}#${item.turn}`)).toEqual([
    "lead#1",
    "coder#1",
    "reviewer#1",
    "reviewer#1",
    "lead#2",
  ])
}, 240_000)
