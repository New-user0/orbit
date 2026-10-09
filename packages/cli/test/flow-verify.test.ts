import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Verify loops and evals against a scripted model. The task is to write 42 into answer.txt: good:1b always does,
// bad:1b always writes 41, and learner:1b writes 41 until it is told its attempt failed. The reviewer approves a diff
// only when it adds 42.
const authored: Array<{ model: string; feedback: string }> = []
const reviews: string[] = []

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
        models: ["good:1b", "bad:1b", "learner:1b"].map((name) => ({
          name,
          model: name,
          modified_at: "2026-01-01T00:00:00Z",
          size: 1,
          digest: "d",
          details,
        })),
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
    if (!body.tools) return reply("Flow task")
    const messages: Array<{ role: string; content?: unknown }> = body.messages
    const prompt = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
    if (prompt.includes("Review a change")) {
      reviews.push(prompt)
      return reply(prompt.includes("+42") ? "APPROVED: it writes 42." : "The answer is wrong: it must be 42, not 41.")
    }
    const feedback = prompt.includes("did not pass verification") ? prompt : ""
    // Each attempt reads answer.txt before writing it, as the write tool requires for a file that already exists.
    if (messages.at(-1)?.role === "tool") {
      if (!JSON.stringify(messages.at(-2)).includes('"name":"Read"')) return reply("Wrote answer.txt")
      const answer = body.model === "good:1b" || (body.model === "learner:1b" && feedback) ? "42" : "41"
      return call("Write", { file_path: "answer.txt", content: `${answer}\n` })
    }
    authored.push({ model: body.model, feedback })
    return call("Read", { file_path: "answer.txt" })
  },
})

function call(name: string, input: unknown) {
  return stream(
    [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${name}_${authored.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
    ],
    "tool_calls",
  )
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-verify-"))
// The workflows and suites live in a folder of their own: the root is the home directory of the isolated environment,
// which no server trusts without a grant, and a command that loads a file needs the folder that holds it trusted.
const flows = path.join(root, "flows")
// A check that behaves the same under sh and cmd: Bun runs a script committed to each test repository.
const check = `${process.execPath} check.js`

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

test("a verify loop feeds failed checks back to the author until they pass, then merges", async () => {
  const repository = await repo("verify")
  const file = path.join(flows, "verify.ts")
  await Bun.write(
    file,
    `export default {
  name: "verify",
  async run(ctx) {
    const work = await ctx.verify("answer", {
      prompt: "write answer.txt containing the answer",
      model: "ollama/learner:1b",
      checks: [${JSON.stringify(check)}],
      judge: true,
    })
    const merged = await ctx.merge("merge", [work])
    return { verified: work.verified, iterations: work.iterations, review: work.review, merged: merged.status }
  },
}
`,
  )
  authored.length = 0
  reviews.length = 0

  const result = await orb(repository, ["flow", "run", "--standalone", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(result.stdout)).toEqual({
    verified: true,
    iterations: 2,
    review: "APPROVED: it writes 42.",
    merged: "merged",
  })
  expect(result.stderr).toContain("✗ answer#1.check1")
  expect(result.stderr).toContain("✓ answer verified in 2 iteration(s)")
  expect(authored).toHaveLength(2)
  expect(authored[1]?.feedback).toContain("check.js")
  // Checks fail first, so the reviewer only sees the passing attempt.
  expect(reviews).toHaveLength(1)
  // Git for Windows may check files out with CRLF line endings (core.autocrlf).
  expect((await Bun.file(path.join(repository, "answer.txt")).text()).replace(/\r\n/g, "\n")).toBe("42\n")
  const calls = authored.length + reviews.length
  // A replay calls no model, but it asks a server whether the folder is trusted before it loads the workflow module.
  const replayed = await orb(repository, ["flow", "replay", "--standalone", await runID(repository)])
  expect({ code: replayed.code, stderr: replayed.code === 0 ? "" : replayed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(replayed.stderr).toContain("replay matches the recorded output")
  expect(authored.length + reviews.length).toBe(calls)
}, 180_000)

test("a reviewer that never approves fails the node after maxIterations", async () => {
  const repository = await repo("judge")
  const file = path.join(flows, "judge.ts")
  await Bun.write(
    file,
    `export default {
  name: "judged",
  run: (ctx) =>
    ctx.verify("answer", {
      prompt: "write answer.txt containing the answer",
      model: "ollama/bad:1b",
      judge: { criteria: "The answer must be 42." },
      maxIterations: 2,
    }),
}
`,
  )
  reviews.length = 0

  const result = await orb(repository, ["flow", "run", "--standalone", file])

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("answer: not verified after 2 iteration(s)")
  expect(reviews).toHaveLength(2)
  expect(reviews[0]).toContain("The answer must be 42.")
}, 180_000)

test("orb eval compares models on a suite, and orb flow clean removes what the runs left", async () => {
  const repository = await repo("eval")
  const suite = path.join(flows, "suite.ts")
  await Bun.write(
    suite,
    `export default {
  name: "answers",
  models: ["ollama/good:1b", "ollama/bad:1b"],
  tasks: [{ id: "answer", prompt: "write answer.txt containing the answer", checks: [${JSON.stringify(check)}] }],
}
`,
  )

  const result = await orb(repository, ["eval", "--standalone", suite, "--format", "json"])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  const report = JSON.parse(result.stdout)
  expect(report.summary).toMatchObject([
    { model: "ollama/good:1b", passed: 1, total: 1, input: 3000, output: 300 },
    { model: "ollama/bad:1b", passed: 0, total: 1 },
  ])
  expect(report.scores.map((score: { task: string; passed: boolean }) => [score.task, score.passed])).toEqual([
    ["answer", true],
    ["answer", false],
  ])
  const table = await orb(repository, ["eval", "--standalone", suite, "--models", "ollama/learner:1b"])
  expect(table.stdout).toContain("ollama/learner:1b  0/1")
  expect(await branches(repository)).not.toEqual([])

  const cleaned = await orb(repository, ["flow", "clean"])

  expect(cleaned.code).toBe(0)
  expect(cleaned.stdout).toContain("Removed 3 worktree(s) and 3 branch(es) from 2 run(s)")
  expect(await branches(repository)).toEqual([])
  expect(await fs.readdir(path.join(repository, ".orbit"))).not.toContain("worktrees")
}, 240_000)

async function repo(name: string) {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "readme.md"), "fixture\n")
  await Bun.write(
    path.join(directory, "check.js"),
    'process.exit((await Bun.file("answer.txt").text().catch(() => "")).trim() === "42" ? 0 : 1)\n',
  )
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
  ])
    await Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "ignore" }).exited
  return directory
}

async function runID(directory: string) {
  return JSON.parse((await orb(directory, ["flow", "ls", "--format", "json"])).stdout)[0].id as string
}

async function branches(directory: string) {
  const child = Bun.spawn(["git", "branch", "--list", "orbit/*"], { cwd: directory, stdout: "pipe" })
  return (await new Response(child.stdout).text()).split("\n").filter(Boolean)
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
