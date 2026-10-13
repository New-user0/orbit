// A shell read that names its files through a wildcard reaches every file the wildcard matches, so a Read deny written for
// one of them (the person's or the managed one) must stop `cat secr*.txt` as it stops `cat secret.txt` (class 8, the
// shell-paths round). The real Permission service decides; ShellGuard asks it about each match.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Global } from "@orbit/util/global"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { ShellGuard } from "@orbit/core/shell/guard"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.make("ses_glob_read")
const slash = (value: string) => value.replaceAll("\\", "/")
const noHost = PowerShellParse.Service.of({ parse: () => Effect.succeed({ valid: false, reason: "no-host" }) })

const layout = Effect.gen(function* () {
  const project = path.join((yield* tmpdirScoped()).path, "project")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(project, "sub"), { recursive: true })
    await fs.mkdir(path.join(project, "many"))
    await fs.writeFile(path.join(project, "secret.txt"), "s")
    await fs.writeFile(path.join(project, "other.txt"), "o")
    await fs.writeFile(path.join(project, "Zeta.txt"), "z")
    await fs.writeFile(path.join(project, ".env"), "e")
    await fs.writeFile(path.join(project, "Token.txt"), "t")
    await fs.writeFile(path.join(project, "_key.txt"), "k")
    await fs.writeFile(path.join(project, "sub", "secret.txt"), "s")
    await fs.mkdir(path.join(project, "src", "a", "b"), { recursive: true })
    await fs.writeFile(path.join(project, "src", "a", "m.ts"), "m")
    await fs.writeFile(path.join(project, "src", "a", "b", "n.ts"), "n")
    // One long name, for the words with many stars.
    await fs.writeFile(path.join(project, "a".repeat(60)), "a")
    // A folder link in a folder: a wildcard never enters it.
    await fs.mkdir(path.join(project, "hold"))
    await fs.symlink(path.join(project, "sub"), path.join(project, "hold", "link"), "junction")
    await Promise.all(Array.from({ length: 520 }, (_, index) => fs.writeFile(path.join(project, "many", `f${index}`), "x")))
  })
  return project
})

const run = (command: string, layer: "managed" | "configured", rule: Permission.Rule | undefined, shell = "sh", setup?: (project: string) => Promise<void>) =>
  Effect.gen(function* () {
    const project = yield* layout
    if (setup) yield* Effect.promise(() => setup(project))
    const rules = rule ? [{ ...rule, resource: rule.resource.replace("<project>", slash(project)) }] : []
    return yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "g", directory: project, title: "g", version: "test", agent: "test" })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* (yield* Agent.Service).transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }, ...(layer === "configured" ? rules : [])]
        }),
      )
      if (layer === "managed") yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules })
      const access = yield* FileAccess.Service
      const input = {
        command,
        shell,
        cwd: yield* access.resolve({ path: project, kind: "directory" }),
        env: {},
        portable: true,
        base: { sessionID },
      }
      const prepared = yield* ShellGuard.prepare(input)
      return {
        // What stops the call: a deny of any request it makes, before anything is asked.
        exit: yield* Effect.exit(ShellGuard.denyPass(prepared)),
        findings: ((prepared.shell?.metadata?.findings ?? []) as { reason: string }[]).map((item) => item.reason),
      }
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            Bus.node,
            SessionStore.node,
            PermissionSaved.node,
            Agent.node,
            PluginHooks.node,
            ManagedPolicy.node,
            Permission.node,
            Global.node,
            FileAccess.node,
            ProjectTrust.node,
            FSUtil.node,
            PowerShellParse.node,
            Location.node,
          ]),
          [
            Location.node.replace(
              Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
            ),
            PowerShellParse.node.replace(Layer.succeed(PowerShellParse.Service, noHost)),
          ],
        ),
      ),
    )
  })

describe("a Read deny and a wildcard in a shell read", () => {
  // [command, whether the deny of <project>/secret.txt stops it]
  const rows: [string, boolean][] = [
    ["cat secret.txt", true],
    ["cat secr*.txt", true],
    ["cat secret.tx?", true],
    ["cat s[e]cret.txt", true],
    ["cat ./secr*", true],
    ["head *", true],
    ["cat *.txt", true],
    ["cat sub/../secr*.txt", true],
    // Windows reads a doubled separator as the start of a share and asks about the whole command instead.
    ...(process.platform === "win32" ? [] : ([["cat .//secr*.txt", true]] as [string, boolean][])),
    ["cat oth*.txt", false],
    ["cat sub/nothing*", false],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, stopped] of rows)
      it.live(`${layer}: ${command} ${stopped ? "is stopped" : "is not stopped (control)"}`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource: "<project>/secret.txt", effect: "deny" })
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )

  it.live("a deny of a file in a folder below stops a wildcard that reaches it", () =>
    Effect.gen(function* () {
      const { exit } = yield* run("cat sub/s*", "managed", { action: "Read", resource: "<project>/sub/secret.txt", effect: "deny" })
      expect(Exit.isFailure(exit)).toBe(true)
      const control = yield* run("cat sub/s*", "managed", undefined)
      expect(Exit.isSuccess(control.exit)).toBe(true)
    }),
  )

  // More matches than are checked one by one: the command is decided anyway. It carries a finding, and a deny rule that could
  // match below the folder stops it, since the files it reaches are not known (class 8).
  it.live("a wildcard with too many matches is decided, not read silently", () =>
    Effect.gen(function* () {
      expect((yield* run("cat many/f1*", "configured", undefined)).findings).toEqual([])
      const many = yield* run("cat many/*", "configured", undefined)
      expect(many.findings).toEqual(["glob-read"])
      expect(Exit.isSuccess(many.exit)).toBe(true)
      const denied = yield* run("cat many/*", "configured", { action: "Read", resource: "<project>/many/f5", effect: "deny" })
      expect(denied.findings).toEqual(["glob-read"])
      expect(Exit.isFailure(denied.exit)).toBe(true)
    }),
  )
})

// A leading dot is not matched by bash's `*` unless dotglob is on, so a `.env` deny does not refuse `grep -n foo *`; a
// wildcard that names the dot does, and so does input that can switch dotglob on.
describe("a Read deny on a dotfile and a wildcard", () => {
  const rows: [string, boolean, string?][] = [
    ["grep -n foo *", false],
    ["ls *", false],
    ["ls -la *", false],
    ["wc -l *", false],
    ["cat *", false],
    ["cat *.txt", false],
    ["cat .env", true],
    ["cat .e*", true],
    ["cat .*", true],
    ["cat ./.e*", true],
    ["shopt -s dotglob; cat *", true],
    ["shopt -s dotglob && grep -n foo *", true],
    ["GLOBIGNORE=x; cat *", true],
    // Spellings the shell reads as dotglob or GLOBIGNORE after quote removal; real bash 5.2 and zsh 5.9 print .env for each.
    ["shopt -s dot''glob; cat *", true],
    ["shopt -s dotglo\\b; cat *", true],
    ['shopt -s "dot"glob; cat *', true],
    ["declare GLOB''IGNORE=x; cat *", true],
    ["export GLOB\\IGNORE=x; cat *", true],
    ["setopt -4; cat *", true, "zsh"],
    ["set -4; cat *", true, "zsh"],
    ["setopt g_lob_dots; cat *", true, "zsh"],
    ["setopt glob''dots; cat *", true, "zsh"],
    ["eval 'shopt -s dotglob'; cat *", true],
    ["bash -c 'shopt -s dotglob; cat *'", true],
    // Options set where the launch reader consumes them (a nested shell, a wrapper, a trap); real bash 5.2 and zsh 5.9 print .env for each.
    ["bash -O dotglob -c 'cat *'", true],
    ["env BASHOPTS=dotglob bash -c 'cat *'", true],
    ["zsh -o globdots -c 'cat *'", true],
    ["zsh -4 -c 'cat *'", true],
    ["trap 'shopt -s dotglob' DEBUG; cat *", true],
    ["bash -c 'cat *'", false],
    ["cat * | wc -l", false],
    // Spellings that parsing alone does not name; real bash 5.2 prints .env for each.
    ["bash -O dotglob -c 'cat *'", true],
    ["bash +O extglob -c 'cat *'", true],
    ["bash -o posix -c 'cat *'", true],
    ["env BASHOPTS=dotglob bash -c 'cat *'", true],
    ["read GLOBIGNORE <<< x; cat *", true],
    ["printf -v GLOBIGNORE x; cat *", true],
    ["for GLOBIGNORE in x; do cat *; done", true],
    ["let GLOBIGNORE=1; cat *", true],
    ["trap 'shopt -s dotglob' DEBUG; cat *", true],
    ["zsh -o globdots -c 'cat *'", true],
    ["bash -c 'cat *'", false],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, stopped, shell] of rows)
      it.live(`${layer}: ${command} ${stopped ? "is stopped" : "is not stopped"} under a .env deny`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource: "<project>/.env", effect: "deny" }, shell)
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )
})

// `**` is two stars in bash and PowerShell, so `src/**/*.ts` reads one folder level; it recurses only where globstar is on
// (a parsed `shopt -s globstar`, or zsh). A deny of a file two levels down stops the recursive spellings only.
describe("a Read deny and a double star", () => {
  const rows: [string, boolean, string?][] = [
    ["grep -n foo src/**/*.ts", false],
    ["wc -l src/**/*.ts", false],
    ["grep -n foo **/*.ts", false],
    ["shopt -s globstar; grep -n foo src/**/*.ts", true],
    ["shopt -s globstar && grep -n foo src/**/*.ts", true],
    ["grep -n foo src/**/*.ts", true, "zsh"],
    ["grep -n foo src/*/*.ts", false],
    ["bash -O globstar -c 'cat src/**/n.ts'", true],
    // zsh reads three stars before a slash as a recursion that follows links; bash reads them as one star.
    ["cat ***/n.ts", true, "zsh"],
    ["cat src/***/n.ts", true, "zsh"],
    ["shopt -s globstar; cat ***/n.ts", false],
    ["bash -O globstar -c 'grep -n foo src/**/*.ts'", true],
    ["env BASHOPTS=globstar bash -c 'grep -n foo src/**/*.ts'", true],
    ["trap 'shopt -s globstar' DEBUG; grep -n foo src/**/*.ts", true],
    ["zsh -c 'grep -n foo src/**/*.ts'", true],
    ["bash -c 'grep -n foo src/**/*.ts'", false],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, stopped, shell] of rows)
      it.live(`${layer}: ${command} ${stopped ? "is stopped" : "is not stopped"} (${shell ?? "sh"}) under a deny of src/a/b/n.ts`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource: "<project>/src/a/b/n.ts", effect: "deny" }, shell)
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )
})

// Bracket classes that real bash 5.2 expands to the denied file (class 8). `Zeta.txt` is the case-folding row: a class or a
// negation must not lose a capital because the name was lower-cased first.
describe("a Read deny and a bracket class", () => {
  // [command, denied file, whether the deny stops it]
  const rows: [string, string, boolean][] = [
    ["cat [[:graph:]]*", "secret.txt", true],
    ["cat [[:word:]]*", "secret.txt", true],
    ["cat [[:ascii:]]*", "secret.txt", true],
    ["cat [[:print:]]*", "secret.txt", true],
    ["cat [[=s=]]ecret.txt", "secret.txt", true],
    ["cat [[.s.]]ecret.txt", "secret.txt", true],
    ["cat [[:upper:]]*", "Zeta.txt", true],
    ["cat [[:upper:]]eta.txt", "Zeta.txt", true],
    ["cat [!z]*", "Zeta.txt", true],
    ["cat [^z]*", "Zeta.txt", true],
    ["cat [A-z]eta.txt", "Zeta.txt", true],
    // A form the matcher does not know matches any character, so the word still reaches the file.
    ["cat [[:nope:]]*", "secret.txt", true],
    ["cat [[=ss=]]ecret.txt", "secret.txt", true],
    ["cat Z*", "secret.txt", false],
    ["cat Q*", "Zeta.txt", false],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, file, stopped] of rows)
      it.live(`${layer}: ${command} ${stopped ? "is stopped" : "is not stopped"} under a deny of ${file}`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource: `<project>/${file}`, effect: "deny" })
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )
})

// Repeated `**` over a deep chain used to multiply the work by about six per segment (zsh, or bash after an assignment). The
// words are decided within a second whatever the shell; the test has its own deadline since the run is asynchronous.
describe("a Read deny and a repeated double star", () => {
  const deep = async (project: string) => {
    await fs.mkdir(path.join(project, ...Array.from({ length: 30 }, () => "d")), { recursive: true })
  }
  const word = "**/**/**/**/**/**/**/**/zz"
  for (const [command, shell] of [
    [`cat ${word}`, "zsh"],
    [`X=1; cat ${word}`, "sh"],
  ] as const)
    it.live(`${command.slice(0, 20)} is decided within a second (${shell})`, () =>
      Effect.gen(function* () {
        const started = Date.now()
        const { exit } = yield* run(command, "configured", { action: "Read", resource: "<project>/secret.txt", effect: "deny" }, shell, deep)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(Date.now() - started).toBeLessThan(1_000)
      }),
    )
})

// On Windows a path through a link to a share connects to the host. Each row listens on its own port (the WebDAV client
// remembers a failed host and port, which would hide a connection in a later row) and the wildcard must not reach it.
// A row passes without asserting where the link cannot be made (it needs the symlink privilege).
describe.skipIf(process.platform !== "win32")("a wildcard and a link to a share", () => {
  // [command, where the link to the share sits, relative to the project]
  const rows: [string, string, string?][] = [
    ["cat */link/x", "a/link"],
    ["cat */link/*", "a/link"],
    ["cat docs/*/../x", "docs"],
    ["Get-Content */link/x", "a/link", "pwsh"],
  ]
  for (const [command, where, shell] of rows)
    it.live(`${command} opens no connection`, () =>
      Effect.gen(function* () {
        let seen = 0
        const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void seen++, data() {} } })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        let made = true
        yield* run(command, "configured", undefined, shell, async (project) => {
          await fs.mkdir(path.dirname(path.join(project, where)), { recursive: true })
          await fs
            .symlink(`\\\\127.0.0.1@${server.port}\\DavWWWRoot\\x`, path.join(project, where), "dir")
            .catch(() => void (made = false))
        })
        yield* Effect.promise(() => Bun.sleep(300))
        if (made) expect(seen).toBe(0)
      }).pipe(Effect.scoped),
    )
})

// A link is never entered by a wildcard: `*` stops at it, and a word that must go through it is undecided, so the call asks
// (a finding) and a deny that could match below stops it (class 4, class 6, class 8). `hold/link` leads to `sub`.
describe("a wildcard and a link below it", () => {
  const rows: [string, boolean, boolean][] = [
    // [command, whether it carries the glob-read finding, whether a deny of sub/secret.txt stops it]
    ["cat */link/secret.txt", true, true],
    ["cat */link/*", true, true],
    ["cat h*/link/secret.txt", true, true],
    ["cat hold/*/secret.txt", true, false],
    ["cat hold/*", false, false],
    ["cat s*/secret.txt", false, true],
    ["cat oth*.txt", false, false],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, finding, stopped] of rows)
      it.live(`${layer}: ${command} ${finding ? "asks" : "does not ask"} and ${stopped ? "is stopped" : "is not stopped"}`, () =>
        Effect.gen(function* () {
          const control = yield* run(command, layer, undefined)
          expect(control.findings.includes("glob-read")).toBe(finding)
          const { exit } = yield* run(command, layer, { action: "Read", resource: "<project>/sub/secret.txt", effect: "deny" })
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )
})

// A wildcard that cannot be expanded to the files it reaches is still decided: a deny rule that could match below its
// folder stops it, and without such a rule it runs (class 8). The rule is `<project>/secret.txt` unless the row says so.
describe("a Read deny and a wildcard that cannot be expanded", () => {
  const many = Array.from({ length: 40 }, (_, index) => `s${index}*`).join(" ")
  // [command, rule resource, whether the deny stops it]
  const rows: [string, string, boolean][] = [
    // (1) a `..` after a wildcard
    ["cat su*/../secr*.txt", "<project>/secret.txt", true],
    ["cat ./su*/../secr*.txt", "<project>/secret.txt", true],
    ["cat su*/../oth*.txt", "<project>/secret.txt", false],
    // (2) more matches than are checked one by one
    ["cat many/*", "<project>/many/f5", true],
    ["cat many/*", "<project>/other.txt", false],
    // (3) names that match in another case, with nocaseglob on
    ["shopt -s nocaseglob; cat SECR*.txt", "<project>/secret.txt", true],
    ["cat SECR*.TXT", "<project>/secret.txt", true],
    // (4) more distinct wildcards than one command may expand
    [`cat ${many}`, "<project>/secret.txt", true],
    [`cat ${many}`, "/elsewhere/**", false],
    // (5) a character class holds a `:` that is no stream name
    ["cat secre[[:alpha:]].txt", "<project>/secret.txt", true],
    ["cat oth[[:alpha:]]r.txt", "<project>/secret.txt", false],
    // (6) classes the shell reads by case, by range or by a name the old library knew, each with a plain-name control
    ["cat Token.txt", "<project>/Token.txt", true],
    ["cat [[:upper:]]oken.txt", "<project>/Token.txt", true],
    ["cat [[:graph:]]oken.txt", "<project>/Token.txt", true],
    ["cat [[:print:]]oken.txt", "<project>/Token.txt", true],
    ["cat [[:upper:][:digit:]]oken.txt", "<project>/Token.txt", true],
    ["cat [[:digit:]]oken.txt", "<project>/Token.txt", false],
    ["cat _key.txt", "<project>/_key.txt", true],
    ["cat [A-z]key.txt", "<project>/_key.txt", true],
    ["cat [0-9]key.txt", "<project>/_key.txt", false],
    // (7) a negated class under case folding, and a class named after an Object.prototype key (no defect, decided)
    ["cat [!x]ecret.txt", "<project>/secret.txt", true],
    ["cat [^[:upper:]]ecret.txt", "<project>/secret.txt", true],
    ["cat [[:constructor:]]ecret.txt", "<project>/secret.txt", true],
    ["cat [[:__proto__:]]ecret.txt", "<project>/secret.txt", true],
    ["cat [[:toString:]]ecret.txt", "<project>/secret.txt", true],
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, resource, stopped] of rows)
      it.live(`${layer}: ${command.slice(0, 50)} ${stopped ? "is stopped" : "is not stopped"} under ${resource}`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource, effect: "deny" })
          expect(Exit.isFailure(exit)).toBe(stopped)
        }),
      )
})

// One shell call may not tie up the server: a command of about 10,000 characters made of quoted brace words and wildcards
// is decided within a deadline. It runs in a child process, because a loop in the scan would block this runner's timer.
const budgetChild = "a command of 10000 characters of brace and wildcard words is decided within the budget"
if (process.env.ORBIT_GLOB_BUDGET_CHILD === "1")
  describe("glob budget (child)", () => {
    it.live(budgetChild, () =>
      Effect.gen(function* () {
        const words = Array.from({ length: 600 }, (_, index) => `'{1..99999}'${index}* many/f${index}*`).join(" ")
        const command = `cat ${words.slice(0, words.lastIndexOf(" ", 9_900))}`
        const started = Date.now()
        const { exit } = yield* run(command, "configured", { action: "Read", resource: "<project>/secret.txt", effect: "deny" })
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Date.now() - started).toBeLessThan(20_000)
      }),
      60_000,
    )
  })

describe("glob budget", () => {
  test("a 10,000 character input of brace and wildcard words ends before the deadline", async () => {
    const child = Bun.spawn(["bun", "test", "test/shell-glob-read.test.ts", "-t", budgetChild], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, ORBIT_GLOB_BUDGET_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 90_000)
    const code = await child.exited
    clearTimeout(timer)
    expect(code).toBe(0)
  }, 100_000)
})

// A word with many stars over a long name made the library's backtracking matcher stall the process for minutes (it grows
// about five times per star). The linear matcher answers at once; the child process has a deadline the runner's timer
// cannot give a synchronous loop.
const starsChild = "a wildcard word with twelve stars over a sixty character name is decided at once"
if (process.env.ORBIT_GLOB_STARS_CHILD === "1")
  describe("glob stars (child)", () => {
    it.live(
      starsChild,
      () =>
        Effect.gen(function* () {
          const started = Date.now()
          const { exit } = yield* run("cat *a*a*a*a*a*a*a*a*a*a*a*b *a*a*a*a*a*a*a*a*a*a*a*a", "configured", {
            action: "Read",
            resource: "<project>/secret.txt",
            effect: "deny",
          })
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(Date.now() - started).toBeLessThan(3_000)
        }),
      60_000,
    )
  })

describe("glob stars", () => {
  test("a many-star word ends within seconds", async () => {
    const child = Bun.spawn(["bun", "test", "test/shell-glob-read.test.ts", "-t", starsChild], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, ORBIT_GLOB_STARS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const code = await child.exited
    clearTimeout(timer)
    expect(code).toBe(0)
  }, 70_000)
})
