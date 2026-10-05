import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// `orb flow` end to end: a real standalone server, a scripted local model and a real git repository. Each agent node
// asks to write <node>.txt, so the merged checkout shows exactly which nodes ran and merged.
const requests: Array<{ node: string; step: "write" | "reply"; model: string; prompt: string }> = []
const failing = new Set<string>()
let inflight = 0
let concurrent = 0

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
      quantization_level: "Q4_K_M",
    }
    if (pathname === "/api/tags")
      return Response.json({
        models: ["tiny:1b", "spare:1b"].map((name) => ({
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
    const messages: Array<{ role: string; content?: unknown }> = body.messages ?? []
    const prompt = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
    const node = prompt.match(/write (\w+)\.txt/)?.[1]
    const content = prompt.match(/ saying (\w+)/)?.[1] ?? node
    // Title generation and other requests without tools get a plain reply.
    if (!body.tools || !node) return stream([{ delta: { role: "assistant", content: "Flow task" }, finish: "stop" }])
    const step = messages.at(-1)?.role === "tool" ? "reply" : "write"
    requests.push({ node, step, model: body.model, prompt })
    if (failing.has(node) || failing.has(`${node}@${body.model}`))
      return Response.json(
        { error: { message: "model crashed", type: "invalid_request_error" } },
        { status: 400, headers: { "content-type": "application/json" } },
      )
    if (step === "reply")
      return stream([{ delta: { role: "assistant", content: `Wrote ${node}.txt` }, finish: "stop" }])
    inflight++
    concurrent = Math.max(concurrent, inflight)
    await Bun.sleep(400)
    inflight--
    return stream([
      {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${node}`,
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: `${node}.txt`, content: `${content}\n` }) },
            },
          ],
        },
        finish: "tool_calls",
      },
    ])
  },
})

function stream(chunks: Array<{ delta: unknown; finish: string }>) {
  const events = chunks.flatMap((chunk) => [
    { choices: [{ index: 0, delta: chunk.delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: chunk.finish }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } },
  ])
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-"))
const workflow = path.join(root, "three.ts")

beforeAll(async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      providers: {
        ollama: {
          settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` },
          // Priced per million tokens, so 1000 input and 100 output tokens cost $0.0012.
          models: { "tiny:1b": { cost: { input: 1, output: 2 } } },
        },
      },
    }),
  )
  await Bun.write(
    workflow,
    `export default {
  name: "three",
  async run(ctx) {
    const results = await ctx.parallel(
      ["a", "b", "c"].map((node) => () => ctx.agent(node, { prompt: \`write \${node}.txt\`, model: "ollama/tiny:1b" })),
    )
    return ctx.merge("merge", results)
  },
}
`,
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("parallel agents run in separate worktrees and merge into the checkout", async () => {
  const repository = await repo("parallel")
  requests.length = 0
  concurrent = 0

  const result = await orb(repository, ["flow", "run", "--standalone", workflow])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "merged", merged: expect.any(Array) })
  expect(await files(repository)).toEqual(["a.txt", "b.txt", "c.txt", "readme.md"])
  expect(concurrent).toBeGreaterThan(1)
  const shown = JSON.parse(
    (await orb(repository, ["flow", "show", await runID(repository), "--format", "json"])).stdout,
  )
  expect(shown.run.status).toBe("succeeded")
  expect(shown.nodes.map((node: { id: string; status: string }) => [node.id, node.status]).toSorted()).toEqual([
    ["a", "succeeded"],
    ["b", "succeeded"],
    ["c", "succeeded"],
    ["merge", "succeeded"],
  ])
}, 180_000)

test("resume reruns only the node that failed", async () => {
  const repository = await repo("resume")
  requests.length = 0
  failing.add("c")

  const failed = await orb(repository, ["flow", "run", "--standalone", workflow])

  expect(failed.code).toBe(1)
  expect(failed.stderr).toContain("c failed")
  expect(await files(repository)).toEqual(["readme.md"])
  const id = await runID(repository)
  const before = requests.length
  expect(requests.filter((request) => request.node === "c").length).toBeGreaterThan(0)
  failing.clear()

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(requests.slice(before).map((request) => request.node)).toEqual(["c", "c"])
  expect(resumed.stderr).toContain("= a (recorded)")
  expect(resumed.stderr).toContain("= b (recorded)")
  expect(await files(repository)).toEqual(["a.txt", "b.txt", "c.txt", "readme.md"])
  const listed = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)
  expect(listed.map((run: { id: string; status: string }) => [run.id, run.status])).toEqual([[id, "succeeded"]])
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

async function files(directory: string) {
  const child = Bun.spawn(["git", "ls-files"], { cwd: directory, stdout: "pipe" })
  return (await new Response(child.stdout).text()).split("\n").filter(Boolean).toSorted()
}

async function runID(directory: string) {
  return JSON.parse((await orb(directory, ["flow", "ls", "--format", "json"])).stdout)[0].id as string
}

// Git must see the configuration orb ran with: on Windows the isolated home hides a global core.autocrlf, so a file
// orb checked out with CRLF would otherwise look modified.
function gitEnv() {
  return isolatedEnv(root, { USERPROFILE: root })
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

test("a failing model is retried, then the fallback model completes the node", async () => {
  const repository = await repo("fallback")
  const file = path.join(root, "fallback.ts")
  await Bun.write(
    file,
    `export default {
  name: "fallback",
  run: (ctx) =>
    ctx.agent("r", {
      prompt: "write r.txt",
      model: "ollama/tiny:1b",
      worktree: false,
      retry: { maxAttempts: 2, retryOn: ["invalid"], backoff: { initial: 10 }, fallbackModels: ["ollama/spare:1b"] },
    }),
}
`,
  )
  requests.length = 0
  failing.add("r@tiny:1b")

  const result = await orb(repository, ["flow", "run", "--standalone", file])
  failing.clear()

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(requests.map((request) => `${request.model}:${request.step}`)).toEqual([
    "tiny:1b:write",
    "tiny:1b:write",
    "spare:1b:write",
    "spare:1b:reply",
  ])
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "succeeded",
    model: "ollama/spare:1b",
    attempts: 3,
    text: "Wrote r.txt",
  })
  expect(await Bun.file(path.join(repository, "r.txt")).text()).toBe("r\n")
  const status = Bun.spawn(["git", "status", "--porcelain"], { cwd: repository, stdout: "pipe", env: gitEnv() })
  expect(await new Response(status.stdout).text()).toBe("?? r.txt\n")
}, 180_000)

test("a merge conflict is reported and leaves the checkout clean", async () => {
  const repository = await repo("conflict")
  const file = path.join(root, "conflict.ts")
  await Bun.write(
    file,
    `export default {
  name: "conflict",
  async run(ctx) {
    const results = await ctx.parallel(
      ["x", "y"].map((node) => () => ctx.agent(node, { prompt: \`write same.txt saying \${node}\`, model: "ollama/tiny:1b" })),
    )
    return ctx.merge("merge", results)
  },
}
`,
  )

  const result = await orb(repository, ["flow", "run", "--standalone", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  const merged = JSON.parse(result.stdout)
  expect(merged).toMatchObject({ status: "conflict", conflict: { files: ["same.txt"] } })
  expect(merged.merged).toHaveLength(1)
  const status = Bun.spawn(["git", "status", "--porcelain"], { cwd: repository, stdout: "pipe", env: gitEnv() })
  expect(await new Response(status.stdout).text()).toBe("")
  expect(await Bun.file(path.join(repository, "same.txt")).text()).toMatch(/^[xy]\r?\n$/)
}, 180_000)

test("a gate pauses the run until a person approves it, then resume continues past it", async () => {
  const repository = await repo("gate")
  const file = path.join(root, "gate.ts")
  await Bun.write(
    file,
    `export default {
  name: "gated",
  async run(ctx) {
    const work = await ctx.agent("g", { prompt: "write g.txt" })
    const decision = await ctx.gate("ship", { message: "Merge g into the checkout?" })
    if (!decision.approved) return { shipped: false }
    // Runs only after the resume, which passes no --model: the run's recorded default must still apply.
    await ctx.agent("after", { prompt: "write after.txt", worktree: false })
    await ctx.merge("merge", [work])
    return { shipped: true, note: decision.note }
  },
}
`,
  )
  requests.length = 0

  const paused = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])

  expect(paused.code).toBe(2)
  expect(paused.stderr).toContain("ship: Merge g into the checkout?")
  expect(await files(repository)).toEqual(["readme.md"])
  const id = await runID(repository)
  expect((await orb(repository, ["flow", "ls", "--format", "json"])).stdout).toContain('"status": "waiting"')
  expect((await orb(repository, ["flow", "show", id])).stdout).toContain("? ship")
  const calls = requests.length

  const approved = await orb(repository, ["flow", "approve", id, "ship", "--note", "looks good"])
  expect(approved.code).toBe(0)
  expect((await orb(repository, ["flow", "approve", id, "ship"])).code).not.toBe(0)
  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(resumed.stdout)).toEqual({ shipped: true, note: "looks good" })
  expect(requests.slice(calls).map((request) => request.node)).toEqual(["after", "after"])
  expect(await files(repository)).toEqual(["g.txt", "readme.md"])
}, 180_000)

test("a budget pauses the run before it overspends, and cost reports spend by node", async () => {
  const repository = await repo("budget")
  const file = path.join(root, "budget.ts")
  await Bun.write(
    file,
    `export default {
  name: "budgeted",
  async run(ctx) {
    for (const node of ["p", "q", "r"])
      await ctx.agent(node, { prompt: \`write \${node}.txt\`, model: "ollama/tiny:1b", worktree: false })
    return "done"
  },
}
`,
  )
  requests.length = 0

  // Each node makes two model calls of 1100 tokens: p and q fit under 3000 tokens, r would not start.
  const paused = await orb(repository, ["flow", "run", "--standalone", "--max-tokens", "3000", file])

  expect(paused.code).toBe(2)
  expect(paused.stderr).toContain("budget: Budget reached")
  expect([...new Set(requests.map((request) => request.node))]).toEqual(["p", "q"])
  const id = await runID(repository)
  expect((await orb(repository, ["flow", "approve", id, "budget"])).code).toBe(0)

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect([...new Set(requests.map((request) => request.node))]).toEqual(["p", "q", "r"])
  const cost = JSON.parse((await orb(repository, ["flow", "cost", id, "--format", "json"])).stdout)
  expect(cost.rows.map((row: { node: string }) => row.node)).toEqual(["p", "q", "r"])
  expect(cost.rows[0]).toMatchObject({ model: "ollama/tiny:1b", attempts: 1, input: 2000, output: 200 })
  expect(cost.total).toMatchObject({ attempts: 3, input: 6000, output: 600 })
  expect(cost.total.cost).toBeCloseTo(0.0072, 6)
  expect((await orb(repository, ["flow", "cost", id])).stdout).toContain("total")
}, 240_000)

test("a model that does not exist is named in the error, and the fallback model runs", async () => {
  const repository = await repo("missing-model")
  const file = path.join(root, "missing.ts")
  await Bun.write(
    file,
    `export default {
  name: "missing",
  run: (ctx) =>
    ctx.agent("m", {
      prompt: "write m.txt",
      model: "ollama/no-such-model",
      worktree: false,
      retry: { maxAttempts: 1, fallbackModels: ["ollama/tiny:1b"] },
    }),
}
`,
  )

  const result = await orb(repository, ["flow", "run", "--standalone", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(result.stderr).toContain(
    "! m attempt 1: invalid: Model ollama/no-such-model is not available. Available ollama models: ollama/spare:1b, ollama/tiny:1b.",
  )
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", model: "ollama/tiny:1b", attempts: 2 })
}, 120_000)

test("uncommitted changes stop the merge with a clear message, and resume merges once they are committed", async () => {
  const repository = await repo("dirty")
  await Bun.write(path.join(repository, "readme.md"), "edited but not committed\n")
  requests.length = 0

  const failed = await orb(repository, ["flow", "run", "--standalone", workflow])

  expect(failed.code).toBe(1)
  expect(failed.stderr).toContain("! uncommitted changes in readme.md")
  expect(failed.stderr).toContain("merge: your checkout has uncommitted changes in readme.md. Commit or stash them")
  const calls = requests.length
  await Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "edit"], {
    cwd: repository,
  }).exited

  const resumed = await orb(repository, ["flow", "resume", "--standalone", await runID(repository)])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(requests.length).toBe(calls)
  expect(await files(repository)).toEqual(["a.txt", "b.txt", "c.txt", "readme.md"])
}, 240_000)

test("replay re-runs a recorded run without models, reports changed inputs, and stops where the workflow diverges", async () => {
  const repository = await repo("replay")
  const recorded = await orb(repository, ["flow", "run", "--standalone", workflow])
  expect(recorded.code).toBe(0)
  const id = await runID(repository)
  const calls = requests.length
  const worktrees = await fs.readdir(path.join(repository, ".orbit", "worktrees"))

  // A module workflow is code, so a replay asks a server whether the folder is trusted before it loads one: a private
  // server here, though the replay itself calls no model.
  const same = await orb(repository, ["flow", "replay", "--standalone", id])

  expect({ code: same.code, stderr: same.code === 0 ? "" : same.stderr }).toEqual({ code: 0, stderr: "" })
  expect(same.stderr).toContain(`replaying ${id} as`)
  expect(same.stderr).toContain("= a (replayed)")
  expect(same.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(JSON.parse(same.stdout)).toEqual(JSON.parse(recorded.stdout))
  expect(requests.length).toBe(calls)
  expect(await fs.readdir(path.join(repository, ".orbit", "worktrees"))).toEqual(worktrees)

  const edited = path.join(root, "three-edited.ts")
  await Bun.write(edited, (await Bun.file(workflow).text()).replace("write ${node}.txt", "write ${node}.txt carefully"))
  const changed = await orb(repository, ["flow", "replay", "--standalone", id, "--file", edited])
  expect(changed.code).toBe(0)
  expect(changed.stderr).toContain("~ a: its inputs differ from the recording")
  expect(changed.stderr).toContain("Nodes whose inputs changed since the recording: a, b, c")

  const longer = path.join(root, "three-longer.ts")
  await Bun.write(longer, (await Bun.file(workflow).text()).replace('["a", "b", "c"]', '["a", "b", "c", "d"]'))
  const diverged = await orb(repository, ["flow", "replay", "--standalone", id, "--file", longer])
  expect(diverged.code).toBe(1)
  expect(diverged.stderr).toContain(`Replay diverged: d is not in the recording of ${id}`)
  expect(requests.length).toBe(calls)

  const watched = await orb(repository, ["flow", "watch", id])
  expect(watched.code).toBe(0)
  expect(watched.stdout).toContain(`${id}  three  succeeded`)
  expect(watched.stdout).toContain("✓ merge")
}, 240_000)

test("a YAML workflow runs nodes as their needs finish, fills templates, and pauses at its gate", async () => {
  const repository = await repo("yaml")
  const file = path.join(root, "flow.yaml")
  await Bun.write(
    file,
    `name: yaml-flow
nodes:
  - id: a
    prompt: write a.txt
  - id: b
    prompt: write b.txt
  - id: c
    needs: [a, b]
    prompt: "write c.txt now that a said: {{a.text}} (task {{input.task}})"
  - id: tests
    type: check
    needs: [c]
    in: c
    command: ${process.platform === "win32" ? "if exist c.txt (exit 0) else (exit 1)" : "test -f c.txt"}
  - id: approve
    type: gate
    needs: [tests]
    message: Merge a, b and c?
  - id: merge
    type: merge
    needs: [approve]
    branches: [a, b, c]
output: merge
`,
  )
  requests.length = 0
  concurrent = 0

  const paused = await orb(repository, [
    "flow",
    "run",
    "--standalone",
    "--model",
    "ollama/tiny:1b",
    file,
    "--input",
    "task=demo",
  ])

  expect(paused.code).toBe(2)
  expect(paused.stderr).toContain("✓ tests: ")
  expect(paused.stderr).toContain("approve: Merge a, b and c?")
  expect(concurrent).toBe(2)
  const c = requests.find((request) => request.node === "c" && request.step === "write")
  expect(c?.prompt).toContain("now that a said: Wrote a.txt (task demo)")
  const id = await runID(repository)
  expect((await orb(repository, ["flow", "approve", id, "approve"])).code).toBe(0)

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect({ code: resumed.code, stderr: resumed.code === 0 ? "" : resumed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "merged", merged: expect.any(Array) })
  expect(await files(repository)).toEqual(["a.txt", "b.txt", "c.txt", "readme.md"])
}, 240_000)

test("ctx.map runs an agent for every item", async () => {
  const repository = await repo("map")
  const file = path.join(root, "map.ts")
  await Bun.write(
    file,
    `export default {
  name: "mapped",
  run: (ctx) =>
    ctx.map(["m", "n"], (name) => ctx.agent(name, { prompt: \`write \${name}.txt\`, worktree: false }), { concurrency: 2 })
      .then((results) => results.map((result) => result.text)),
}
`,
  )

  const result = await orb(repository, ["flow", "run", "--standalone", "--model", "ollama/tiny:1b", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(result.stdout)).toEqual(["Wrote m.txt", "Wrote n.txt"])
}, 120_000)

test("a model whose breaker is open is skipped for its fallback", async () => {
  const repository = await repo("breaker")
  const { Store } = await import("@orbit/flow")
  const store = Store.at(repository)
  for (const run of ["run_x", "run_y", "run_z"])
    store.append(run, "n", "attempt.ended", { model: "ollama/tiny:1b", error: { class: "transient" } })
  store.close()
  const file = path.join(root, "breaker.ts")
  await Bun.write(
    file,
    `export default {
  name: "breaker",
  run: (ctx) =>
    ctx.agent("k", {
      prompt: "write k.txt",
      model: "ollama/tiny:1b",
      worktree: false,
      retry: { fallbackModels: ["ollama/spare:1b"] },
    }),
}
`,
  )
  requests.length = 0

  const result = await orb(repository, ["flow", "run", "--standalone", file])

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(result.stderr).toContain("! k: skipping ollama/tiny:1b, which failed 3 times in the last minute")
  expect(requests.map((request) => request.model)).toEqual(["spare:1b", "spare:1b"])
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", model: "ollama/spare:1b" })
}, 120_000)

test("orb flow trace shows a timeline, prints OTLP, and sends it only to a collector it is given", async () => {
  const repository = await repo("trace")
  const file = path.join(root, "trace.ts")
  await Bun.write(
    file,
    `export default {
  name: "traced",
  run: (ctx) =>
    ctx.agent("t", {
      prompt: "write t.txt",
      model: "ollama/no-such-model",
      worktree: false,
      retry: { maxAttempts: 1, fallbackModels: ["ollama/tiny:1b"] },
    }),
}
`,
  )
  expect((await orb(repository, ["flow", "run", "--standalone", file])).code).toBe(0)
  const id = await runID(repository)

  const timeline = await orb(repository, ["flow", "trace", id])
  expect(timeline.stdout).toContain("✓ run traced")
  expect(timeline.stdout).toContain("  ✓ t ")
  expect(timeline.stdout).toContain("    ✗ attempt ollama/no-such-model")
  expect(timeline.stdout).toContain("    ✓ attempt ollama/tiny:1b")

  const exported = JSON.parse((await orb(repository, ["flow", "trace", id, "--format", "otlp"])).stdout)
  const spans = exported.resourceSpans[0].scopeSpans[0].spans
  expect(spans.map((span: { name: string }) => span.name)).toEqual([
    "run traced",
    "t",
    "attempt ollama/no-such-model",
    "attempt ollama/tiny:1b",
  ])
  expect(new Set(spans.map((span: { traceId: string }) => span.traceId)).size).toBe(1)
  expect(spans[1].parentSpanId).toBe(spans[0].spanId)
  expect(spans[3].parentSpanId).toBe(spans[1].spanId)
  expect(spans[2].status).toEqual({ code: 2 })
  expect(spans[3].attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "2000" } })

  const received: unknown[] = []
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/traces") received.push(await request.json())
      return Response.json({})
    },
  })
  const sent = await orb(repository, ["flow", "trace", id, "--otlp", `http://127.0.0.1:${collector.port}`])
  await collector.stop(true)
  expect(sent.stdout).toContain(`Sent 4 spans of ${id}`)
  expect(received).toEqual([exported])
}, 120_000)
