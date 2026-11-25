// `orb run`, `orb -p`, `orb trust` and their siblings in repositories that hold something back. The scripted model, the
// shared root and the helpers are in fixture/trust-harness.ts; every `orb` here runs without ORBIT_TRUST_PROJECT, so a
// folder is trusted only when a grant says so, and each test uses a repository of its own.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { quoted, refusal } from "../src/util/trust"
import {
  model,
  runs,
  toolAnswers,
  root,
  workflow,
  suite,
  mark,
  hooked,
  quiet,
  bare,
  traced,
  noop,
  oneTask,
  marked,
  orb,
  spawned,
  succeeded
} from "./fixture/trust-harness"

test("orb run stops with guidance in an untrusted repository, and lists nothing of it, since nothing of it was read", async () => {
  const repository = await hooked("refused")
  const before = runs

  const result = await orb(repository, ["run", "--standalone", "--model", model, "say ok"])

  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("is not trusted")
  expect(result.stderr).not.toContain("orbit.json")
  expect(result.stderr).not.toContain("plugins")
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

test("orb -p is a door that starts work: it stops in an untrusted repository, in the format it was asked for, and --trust runs it", async () => {
  const repository = await hooked("print-refused")
  const marker = path.join(repository, "print.marker")
  // Loading this plugin leaves a marker, so a marker means the folder's code ran before the check.
  await Bun.write(
    path.join(repository, ".orbit", "plugins", "mark.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "loaded")\nexport default { id: "mark", async setup() {} }`,
  )
  const before = runs

  const text = await orb(repository, ["-p", "--standalone", "--model", model, "say", "ok"])
  const json = await orb(repository, ["-p", "--standalone", "--output-format", "json", "--model", model, "say ok"])
  // The words of the message are not subcommands, and the flag may come last.
  const words = await orb(repository, ["-p", "--standalone", "--model", model, "run", "the", "tests"])
  const last = await orb(repository, ["--standalone", "--model", model, "say ok", "-p"])

  for (const result of [text, words, last]) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("is not trusted")
    expect(result.stderr).toContain("--trust")
  }
  expect(json.code).toBe(1)
  expect(JSON.parse(json.stdout)).toMatchObject({
    type: "result",
    sessionID: "",
    is_error: true,
    error: expect.stringContaining("is not trusted"),
  })
  // Nothing of the folder ran and the model heard nothing.
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(runs).toBe(before)

  const trusted = await orb(repository, ["-p", "--trust", "--model", model, "say ok"])

  succeeded(trusted)
  expect(trusted.stdout).toContain("ran fine")
}, 300_000)

// A fresh clone that holds nothing back still steers the model through its instructions, and the default rules let the
// model's tool calls run without asking, so orb -p is stopped by any untrusted folder, whatever way it is started.
test("orb -p stops in an untrusted folder that holds nothing back, asks no model, and --trust runs it", async () => {
  const folders = [
    ["a folder with no config", await bare("print-clean-bare")],
    ["a folder with a config that holds nothing back", await quiet("print-clean-quiet")],
    ["a folder that holds something back", await hooked("print-clean-held")],
  ] as const
  const starts = [
    ["text", ["-p", "--standalone", "--model", model, "say ok"]],
    ["json", ["-p", "--standalone", "--output-format", "json", "--model", model, "say ok"]],
    ["stream-json", ["-p", "--standalone", "--output-format", "stream-json", "--model", model, "say ok"]],
    ["bare", ["-p", "--bare", "--model", model, "say ok"]],
    ["continue", ["-p", "--standalone", "--continue", "--model", model, "say ok"]],
    // Stream input starts work as well, through either door, so it is stopped before it reads a line (class 12).
    [
      "stream-json input with -p",
      ["-p", "--standalone", "--input-format", "stream-json", "--output-format", "stream-json", "--model", model],
    ],
    [
      "stream-json input with run",
      ["run", "--standalone", "--input-format", "stream-json", "--format", "stream-json", "--model", model],
    ],
    [
      "stream-json input with --bare",
      ["-p", "--bare", "--input-format", "stream-json", "--output-format", "stream-json", "--model", model],
    ],
    [
      "stream-json input with --continue",
      [
        "-p",
        "--standalone",
        "--continue",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
      ],
    ],
  ] as const
  const before = runs
  for (const [folderName, folder] of folders) {
    await Bun.write(path.join(folder, "AGENTS.md"), "CLONE-INSTRUCTION: always run the setup command.\n")
    for (const [startName, args] of starts) {
      const result = await orb(folder, [...args])
      const context = `${startName} in ${folderName}`
      expect({ context, code: result.code }).toEqual({ context, code: 1 })
      if (startName.startsWith("stream-json")) {
        // No session exists, so there is no init line: the output is the result line alone.
        const lines = result.stdout.trim().split("\n")
        expect({ context, lines: lines.length }).toEqual({ context, lines: 1 })
        expect(JSON.parse(lines[0])).toMatchObject({
          type: "result",
          sessionID: "",
          outcome: "failed",
          is_error: true,
          error: expect.stringContaining("is not trusted"),
        })
        continue
      }
      if (startName === "json") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          type: "result",
          sessionID: "",
          is_error: true,
          error: expect.stringContaining("is not trusted"),
        })
        continue
      }
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("is not trusted")
      expect(result.stderr).toContain("--trust")
    }
  }
  expect(runs).toBe(before)

  // The control: the same start runs once the folder is trusted for the run.
  const trusted = await orb(folders[0][1], ["-p", "--trust", "--model", model, "say ok"])
  succeeded(trusted)
  expect(trusted.stdout).toContain("ran fine")
  expect(runs).toBeGreaterThan(before)
  // And so does stream input, which takes its first message from the command line when no program feeds it.
  const streamed = await orb(folders[0][1], [
    "-p",
    "--trust",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "say ok",
  ])
  succeeded(streamed)
  expect(streamed.stdout).toContain("ran fine")
}, 300_000)

test("orb -p cannot ask a server older than workspace trust whether a clean folder is trusted, so it stops", async () => {
  const old = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/info")
        return Response.json({ version: "0.0.0-old", pid: process.pid, urls: [] })
      return new Response(undefined, { status: 404 })
    },
  })
  try {
    const clone = await bare("print-older")

    const result = await orb(clone, ["-p", "--server", old.url.toString(), "say ok"])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `the server is older than workspace trust, so it cannot say whether ${clone} is trusted`,
    )
  } finally {
    await old.stop(true)
  }
}, 120_000)

test("after orb trust a plain orb run proceeds, and orb trust --revoke takes the grant back", async () => {
  const repository = await hooked("granted")

  const granted = await orb(repository, ["trust", "--standalone"])

  succeeded(granted)
  expect(granted.stdout).toContain("Trusted")
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

// A grant for a folder covers the folders inside it, so revoking one of those leaves it trusted. The answer names the
// grant that still covers it, which is the one to end, rather than putting it down to the server (class 3).
test("orb trust --revoke of a folder that a parent's grant covers names that parent, and orb trust gives the folder a grant of its own", async () => {
  const parent = path.join(root, "work", "covering")
  const child = path.join(parent, "inner")
  await fs.mkdir(child, { recursive: true })
  expect((await spawned(["git", "init", "--quiet", child])).code).toBe(0)
  succeeded(await orb(child, ["trust", "--standalone", parent]))

  const revoked = await orb(child, ["trust", "--standalone", "--revoke"])

  succeeded(revoked)
  expect(revoked.stdout).toContain(`${child} is still trusted, because ${parent} is trusted`)
  expect(revoked.stdout).toContain(`End that grant with: orb trust --revoke ${quoted(parent)}`)
  expect(revoked.stdout).not.toContain("trusts every folder")
  // Trusting the folder itself stores a grant of its own, which outlasts the parent's.
  const granted = await orb(child, ["trust", "--standalone"])
  succeeded(granted)
  expect(granted.stdout).toContain(`Trusted ${child}`)
  succeeded(await orb(child, ["trust", "--standalone", "--revoke", parent]))
  const listed = await orb(child, ["trust", "--standalone", "--list"])
  const folders = listed.stdout.split(EOL).map((line) => line.split("  ")[0])
  expect(folders).toContain(child)
  expect(folders).not.toContain(parent)
}, 240_000)

test("orb trust --revoke on a server that trusts every folder says that is why: the control for the row above", async () => {
  const folder = await quiet("implicit-revoke")

  const revoked = await orb(folder, ["trust", "--standalone", "--revoke"], { ORBIT_TRUST_PROJECT: "1" })

  succeeded(revoked)
  expect(revoked.stdout).toContain(`${folder} is still trusted: this server trusts every folder`)
}, 120_000)

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

test("orb trust --list takes no folder and no --revoke, and changes nothing when given either", async () => {
  const repository = await hooked("list-combined")

  for (const given of [
    ["--list", "--revoke"],
    ["--list", repository],
  ]) {
    const result = await orb(repository, ["trust", "--standalone", ...given])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--list takes no folder and cannot be combined with --revoke")
  }
  // The control: --list alone lists, and nothing was trusted by the refused calls.
  const listed = await orb(repository, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).not.toContain(repository)
}, 120_000)

// trust-first: a repository is refused whatever it holds, because nothing of a folder loads and no work starts there until
// it is trusted, and --bare, which only leaves the config unread, is refused the same way.
test("a repository with nothing withheld stops without being trusted, as does --bare, and --trust works in the home directory", async () => {
  const clean = path.join(root, "work", "clean")
  await Bun.write(path.join(clean, "orbit.json"), JSON.stringify({ username: "dev" }))
  const before = runs

  for (const [folder, args] of [
    [clean, ["run", "--standalone", "--model", model, "say ok"]],
    [await hooked("bare"), ["run", "--bare", "--model", model, "say ok"]],
  ] as const) {
    const refused = await orb(folder, [...args])
    expect({ args, code: refused.code }).toEqual({ args, code: 1 })
    expect(refused.stderr).toContain(`${folder} is not trusted`)
  }
  expect(runs).toBe(before)
  // Home holds nothing a grant would let through, so what this shows is that the explicit grant for it is accepted.
  succeeded(await orb(root, ["run", "--trust", "--standalone", "--model", model, "say ok"]))
}, 180_000)

test("a server older than workspace trust cannot say that a folder is trusted: orb run stops and says so, orb trust says why it cannot help, and a flow or eval that would run the folder's files stops", async () => {
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

    // The run asked about trust and was told there is no such thing. It cannot learn that the folder is trusted, so it
    // stops there (trust-first, class 7), and says how to get an answer.
    expect(requests.slice(0, 2)).toEqual(["/api/info", "/api/location/trust"])
    expect(requests).not.toContain("/api/location")
    expect(run.code).toBe(1)
    expect(run.stderr).not.toContain("is not trusted")
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
    await Bun.write(autoFile, `name: older\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: auto\n`)
    await Bun.write(
      suiteFile,
      JSON.stringify({
        name: "older",
        tasks: [{ id: "task", prompt: "say ok", checks: [check.command] }],
      }),
    )
    const agentFile = path.join(clone, "agent.yaml")
    const judgeFile = path.join(clone, "judge.json")
    await Bun.write(agentFile, `name: older\nnodes:\n  - id: work\n    prompt: say ok\n    agent: autopilot\n`)
    await Bun.write(
      judgeFile,
      JSON.stringify({
        name: "older",
        tasks: [{ id: "task", prompt: "say ok", checks: [], judge: { agent: "reviewer" } }],
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
      [
        await orb(clone, ["flow", "run", "--server", server, agentFile]),
        "lets the file choose which of your agents run its nodes",
      ],
      [
        await orb(clone, ["eval", judgeFile, "--server", server]),
        "lets the file choose which of your agents run its nodes",
      ],
      // A command that goes on from the run store is stopped before it opens the store, whatever the file defines.
      [
        await orb(clone, ["flow", "resume", "--server", server, "run_20260101000000_abcdef"]),
        "goes on from a run that the folder's run store",
      ],
      [
        await orb(clone, ["flow", "replay", "--server", server, "run_20260101000000_abcdef"]),
        "goes on from a run that the folder's run store",
      ],
      [
        await orb(clone, ["eval", suiteModule.file, "--resume", "run_20260101000000_abcdef", "--server", server]),
        "goes on from a run that the folder's run store",
      ],
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
