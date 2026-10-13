// A shell read that names its files through a wildcard reaches every file the wildcard matches, so a Read deny written for
// one of them (the person's or the managed one) must stop `cat secr*.txt` as it stops `cat secret.txt` (class 8, the
// shell-paths round). The real Permission service decides; ShellGuard asks it about each match.
import { describe, expect } from "bun:test"
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

  // More matches than are checked one by one: the command carries a finding that makes it a question, never a silent read.
  it.live("a wildcard with too many matches is a Bash question, not a silent read", () =>
    Effect.gen(function* () {
      expect((yield* run("cat many/f1*", "configured", undefined)).findings).toEqual([])
      expect((yield* run("cat many/*", "configured", undefined)).findings).toEqual(["glob-read"])
    }),
  )
})
