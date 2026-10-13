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
    await fs.writeFile(path.join(project, ".env"), "e")
    await fs.writeFile(path.join(project, "sub", "secret.txt"), "s")
    await Promise.all(Array.from({ length: 520 }, (_, index) => fs.writeFile(path.join(project, "many", `f${index}`), "x")))
  })
  return project
})

const run = (command: string, layer: "managed" | "configured", rule: Permission.Rule | undefined) =>
  Effect.gen(function* () {
    const project = yield* layout
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
        shell: "sh",
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
  const rows: [string, boolean][] = [
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
  ]
  for (const layer of ["managed", "configured"] as const)
    for (const [command, stopped] of rows)
      it.live(`${layer}: ${command} ${stopped ? "is stopped" : "is not stopped"} under a .env deny`, () =>
        Effect.gen(function* () {
          const { exit } = yield* run(command, layer, { action: "Read", resource: "<project>/.env", effect: "deny" })
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
