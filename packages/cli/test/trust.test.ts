import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TrustStatus } from "@orbit/client/promise"
import { SessionID } from "@orbit/schema/session-id"
import { refusal } from "../src/util/trust"
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
              : { role: "assistant", content: body.tools ? "ran fine" : "Trust" },
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

beforeAll(async () => {
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

test("a server older than workspace trust holds nothing back, so orb run goes on and says so, and orb trust says why it cannot help", async () => {
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
  } finally {
    await old.stop(true)
  }
}, 120_000)

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
