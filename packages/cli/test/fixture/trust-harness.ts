// The scripted model, the private servers' shared root and the helpers of the trust suite: trust.test.ts and the
// trust-*.test.ts files beside it. Each file that imports this gets its own model server and root, made before its
// tests and removed after them.
import { afterAll, beforeAll, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./environment"
import { startSlot } from "./start-gate"
import { removeTree } from "../../../core/test/fixture/remove-tree"


// `orb run` and its siblings against a real private server and a scripted model, in repositories that hold something
// back. Every `orb` here runs without ORBIT_TRUST_PROJECT, which is how the shared background service behaves, so a
// folder is trusted only when a grant says so. The private servers share one database, so a grant that is stored
// outlives the process that made it, and each test uses a repository of its own.
export const model = "ollama/trust:1b"
export let runs = 0
// How long the model server takes to answer /api/show, which is what a private server's first model discovery waits on.
let showDelay = 0
// What the model was told the last time a tool answered it.
export const toolAnswers: string[] = []
// The agents that a request of the model was made as, which are the ones that a system prompt of the form AGENT-<name>
// names. A test clears it before the run it looks at.
export const askedAs = new Set<string>()
// The models that a request was made for, in order, which a test compares with the model that the person chose.
export const askedFor: string[] = []
// A file that the model asks to read the next time it is asked to review a change, as a reviewer that a clone steers can.
let readOnReview: string | undefined
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
export const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "trust:1b", model: "trust:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
          {
            name: "pricey:70b",
            model: "pricey:70b",
            modified_at: "2026-01-01T00:00:00Z",
            size: 1,
            digest: "d",
            details,
          },
        ],
      })
    if (pathname === "/api/show") {
      if (showDelay > 0) await Bun.sleep(showDelay)
      return Response.json({
        parameters: "",
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    }
    if (pathname === "/api/ps") return Response.json({ models: [] })
    const body: { model?: string; tools?: unknown; messages: Array<{ role: string; content?: unknown }> } =
      await request.json()
    if (body.tools) {
      runs++
      if (body.model) askedFor.push(body.model)
    }
    const agent = body.tools ? JSON.stringify(body.messages).match(/AGENT-(\w+)/)?.[1] : undefined
    if (agent) askedAs.add(agent)
    const last = body.messages.at(-1)
    if (last?.role === "tool") toolAnswers.push(JSON.stringify(last.content))
    // Asked to write a file, the model calls the write tool once; every other request gets a plain reply.
    const writes = body.tools && last?.role === "user" && JSON.stringify(last.content).includes("write blocked.txt")
    // The lead of a team ends it on its first turn, with the tag a lead finishes with.
    const finishes = body.tools && last?.role === "user" && JSON.stringify(last.content).includes("You lead.")
    // A reviewer approves, which is the word its reply has to start with.
    const approves =
      body.tools && last?.role === "user" && JSON.stringify(last.content).includes("Review a change another agent made")
    // A reviewer that was told to read a file asks for it once, in place of its verdict.
    const reads = approves ? readOnReview : undefined
    if (reads) readOnReview = undefined
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: reads
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read",
                      type: "function",
                      function: { name: "Read", arguments: JSON.stringify({ file_path: reads }) },
                    },
                  ],
                }
              : writes
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_write",
                        type: "function",
                        function: {
                          name: "Write",
                          arguments: JSON.stringify({ file_path: "blocked.txt", content: "no\n" }),
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: body.tools
                      ? finishes
                        ? "<done>finished</done>"
                        : approves
                          ? "APPROVED"
                          : "ran fine"
                      : "Trust",
                  },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: writes || reads ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
// Real, because the server names a folder by its real path and a test compares what it prints with the folders it made.
export const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trust-")))
export const workflow = path.join(root, "noop.ts")
export const suite = path.join(root, "suite.ts")
export const mark = path.join(root, "mark.js")

beforeAll(async () => {
  // The script of every command that a test file defines: it leaves <name>.marker beside itself, so the marker lands in
  // one place whichever folder the platform shell runs the command in.
  await Bun.write(mark, 'await Bun.write(`${import.meta.dir}/${process.argv[2]}.marker`, "ran")\n')
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      // The default model: a workflow or suite file in a clone cannot pick one, so the runs that it leaves to the user use this.
      model,
      providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } },
    }),
  )
  await Bun.write(workflow, `export default { name: "noop", run: () => "done" }\n`)
  await Bun.write(
    suite,
    `export default { name: "trust", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }\n`,
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await removeTree(root)
})

// The settings of a project that guards its files: a hook blocks every write.
// The matcher keeps the tool's old name on purpose: a guard written before the rename must still block `Write`.
export const guard = { hooks: { PreToolUse: [{ matcher: "write", hooks: [{ type: "command", command: "exit 2" }] }] } }

// The config of a user who is asked before every edit, and who has agents of their own. An agent's rules are added after
// the global ones, where the last match wins, so `autopilot` edits without being asked and every other agent is asked. Each
// agent's system prompt says which one a request of the model was made as, which `askedAs` collects.
export const user = {
  ORBIT_CONFIG_CONTENT: JSON.stringify({
    permissions: [{ action: "edit", resource: "*", effect: "ask" }],
    agents: {
      autopilot: { system: "AGENT-autopilot", permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
      reviewer: { system: "AGENT-reviewer" },
      captain: { system: "AGENT-captain" },
    },
  }),
}

// A repository with a hook in its settings and a plugin in its `.orbit` directory: what a clone can bring that runs
// code on its own.
export async function hooked(name: string) {
  const directory = path.join(root, "work", name)
  await Bun.write(path.join(directory, "orbit.json"), JSON.stringify(guard))
  await Bun.write(
    path.join(directory, ".orbit", "plugins", "greeter.ts"),
    `export default { id: "greeter", async setup() {} }`,
  )
  return directory
}

// A folder whose config holds nothing back.
export async function quiet(name: string) {
  const directory = path.join(root, "work", name)
  await Bun.write(path.join(directory, "orbit.json"), JSON.stringify({ username: "dev" }))
  return directory
}

// A folder with no config at all, which is what a fresh clone that brings only a workflow or a suite looks like: it holds
// nothing back, so the check on what is held back lets a command through.
export async function bare(name: string) {
  const directory = path.join(root, "work", name)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

// A module whose top-level code leaves a marker when it is imported, as the code of any workflow or suite can.
export async function traced(directory: string, name: string, body: string) {
  const file = path.join(directory, name)
  const marker = path.join(directory, `${name}.marker`)
  await Bun.write(
    file,
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "imported")\n${body}\n`,
  )
  return { file, marker }
}

export const noop = `export default { name: "traced", run: () => "done" }`
export const oneTask = `export default { name: "traced", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`

// A shell command that leaves a marker when the platform shell runs it, the same under sh and cmd, as the command of
// any workflow or suite can. It is written as a quoted YAML scalar, which a JSON string also is.
export function marked(name: string) {
  const command = `${process.execPath} ${mark} ${name}`
  return { command, quoted: JSON.stringify(command), marker: path.join(root, `${name}.marker`) }
}

// A git repository in a folder that has config of its own, as a folder of several repositories can. The folder is
// trusted on its own, so trusting the repository does not lift what the folder holds back.
export async function layered(name: string) {
  const parent = path.join(root, "work", name)
  const child = path.join(parent, "child")
  await Bun.write(path.join(parent, "orbit.json"), JSON.stringify(guard))
  await fs.mkdir(child, { recursive: true })
  expect((await spawned(["git", "init", "--quiet", child])).code).toBe(0)
  return { parent, child }
}

export async function orb(directory: string, given: string[], env: Record<string, string | undefined> = {}) {
  // A suite file in a clone cannot name its models, so an eval takes them from the flag unless the test passes its own.
  const args = given[0] === "eval" && !given.includes("--models") ? [...given, "--models", model] : given
  // The child holds a start slot while it runs, so its 240 s limit measures the child and never the queue behind the
  // other files' cold children. The refusal and the control of a door run the same way.
  return startSlot(() => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: isolatedEnv(root, {
        USERPROFILE: root,
        PWD: directory,
        ORBIT_TRUST_PROJECT: undefined,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        OLLAMA_CONTEXT_LENGTH: undefined,
        ...env,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    return finished(child, `orb ${args.join(" ")} in ${directory}`, 240_000)
  })
}

// A program the tests run in their folders, such as git. It is never started with `Bun.spawnSync`: a synchronous spawn
// that does not return stops the event loop, so neither the limit below nor the runner's own can say which command hung
// (CI runs held rows of this file for their whole limit with nothing in the log, and no `orb` limit fired).
export const spawned = (command: string[], cwd?: string) =>
  finished(Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), command.join(" "), 60_000)

// Waits for a child to print and end, for `limit` milliseconds at most. A child still running then is killed, and the
// failure names the command, what it printed, the processes still running and the end of the newest logs, so that a
// hang on a CI runner can be read from the CI log and does not hold the rows after it.
export async function finished(child: Bun.Subprocess<"ignore", "pipe", "pipe">, command: string, limit: number) {
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  const late = Promise.withResolvers<"late">()
  const timer = setTimeout(() => late.resolve("late"), limit)
  const code = await Promise.race([
    Promise.all([child.exited, stdout.done, stderr.done]).then(([code]) => code),
    late.promise,
  ])
  clearTimeout(timer)
  if (code !== "late") return { code, stdout: stdout.text(), stderr: stderr.text() }
  child.kill("SIGKILL")
  const processes =
    process.platform === "win32"
      ? ""
      : await new Response(Bun.spawn(["ps", "-eo", "pid,ppid,etimes,args"], { stdin: "ignore" }).stdout).text()
  throw new Error(
    [
      `${command} did not end within ${limit / 1000} s (exited: ${child.exitCode ?? "no"})`,
      `stdout:\n${stdout.text()}`,
      `stderr:\n${stderr.text()}`,
      `processes:\n${processes}`,
      `logs:\n${await logTails()}`,
    ].join("\n"),
  )
}

// What a child prints, as it prints it, so that what a process that never ends printed so far can still be shown.
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  const done = (async () => {
    for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }))
  })()
  return { done, text: () => chunks.join("") }
}

// The last lines of the two newest log files of the processes these tests start.
async function logTails() {
  const folder = path.join(root, "data", "orbit", "log")
  const names = await fs.readdir(folder).catch(() => [] as string[])
  const files = await Promise.all(
    names.map(async (name) => ({ name, modified: (await fs.stat(path.join(folder, name))).mtimeMs })),
  )
  const newest = files.toSorted((a, b) => b.modified - a.modified).slice(0, 2)
  const tails = await Promise.all(
    newest.map(async (file) =>
      [`== ${file.name}`, ...(await Bun.file(path.join(folder, file.name)).text()).split("\n").slice(-80)].join("\n"),
    ),
  )
  return tails.join("\n")
}

export const succeeded = (result: { code: number; stderr: string }) =>
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })

// How long the model server takes to answer /api/show from now on.
export function setShowDelay(ms: number) {
  showDelay = ms
}

// The file the model asks to read the next time it is asked to review a change, or none.
export function readOnNextReview(file: string | undefined) {
  readOnReview = file
}
