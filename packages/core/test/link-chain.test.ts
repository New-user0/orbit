import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { LinkShare } from "@orbit/core/config/link-share"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { ShellAnalysis } from "@orbit/core/shell/analysis"
import { ShellGuard } from "@orbit/core/shell/guard"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { canLinkFile } from "./fixture/symlink"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

// Class 6 and 7, task permissions-23: each row must finish in well under the 45 to 60 seconds the connection took before. Windows follows a chain of up to 63 links, so a chain of 41 to 63 links in a
// repository that ends at a share, or at a file that is not there yet outside the project, has to be judged like a short
// one. A walk that gives up at its limit must answer "unresolved", never "no share" and never the name it had reached
// inside the project. Each share row has an address of its own (TEST-NET-style, never routable), because Windows remembers
// a host that failed. Rows that need a link to a file end where the account cannot make one.

setDefaultTimeout(30_000)
const win = process.platform === "win32"
const noHost = PowerShellParse.Service.of({ parse: () => Effect.succeed({ valid: false, reason: "no-host" }) })
const counts = [40, 41, 63, 85] as const
const sessionID = "ses_link_chain" as never

/** `names[0] -> names[1] -> ... -> target`, created from the end so that every link has its target. */
const chain = async (directory: string, names: readonly string[], target: string, type: "file" | "dir") => {
  await fs.mkdir(directory, { recursive: true })
  for (const index of names.keys().toArray().toReversed())
    await fs.symlink(index === names.length - 1 ? target : names[index + 1]!, path.join(directory, names[index]!), type)
}
const names = (count: number) => Array.from({ length: count }, (_, index) => `l${index}`)

// Where each address is used once: a row's host is `10.255.255.<base + row>`.
let next = 100
const host = () => `10.255.255.${next++}`

const provide = (project: string, trusted: boolean, recorded = recordedFileSystem()) => ({
  recorded,
  layer: Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([FileAccess.node, ProjectTrust.node, FSUtil.node, Location.node, PowerShellParse.node]),
      [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
        ),
        Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
        FSUtil.node.replace(recorded.layer),
        ...(trusted ? [] : untrustedProjectNodes),
      ],
    ),
  ),
})

// Nothing but `readLink` may name the first link or a path below it: any other call follows the chain and opens its end.
const followed = (calls: readonly string[], at: string) => {
  const root = at.toLowerCase()
  return calls.filter((call) => {
    const [method, ...rest] = call.split(" ")
    const file = rest.join(" ").toLowerCase()
    return method !== "readLink" && (file === root || file.startsWith(root + path.sep))
  })
}

describe.skipIf(!win || !canLinkFile)("a chain of links in the repository that ends at a share", () => {
  for (const count of counts) {
    const address = host()
    const label = count > 63 ? `${count} links (more than Windows follows)` : `${count} links`

    it.live(`LinkShare.of and ofSync name the end of ${label} without opening it`, () =>
      Effect.gen(function* () {
        const base = (yield* tmpdirScoped()).path
        yield* Effect.promise(() => chain(base, names(count), `\\\\${address}\\share`, "dir"))
        const recorded = recordedFileSystem()
        const files = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
        const started = Date.now()
        const found = yield* LinkShare.of(files, path.join(base, "l0", "x"))
        const sync = LinkShare.ofSync(path.join(base, "l0", "x"))
        expect(Date.now() - started).toBeLessThan(15_000)
        // The answer is never undefined: either the share, or a path that every caller refuses.
        if (count > 63) {
          expect(LinkShare.isUnresolved(found!)).toBe(true)
          expect(LinkShare.isUnresolved(sync!)).toBe(true)
        } else {
          expect(found?.toLowerCase().startsWith(`\\\\${address}\\share`)).toBe(true)
          expect(sync?.toLowerCase().startsWith(`\\\\${address}\\share`)).toBe(true)
        }
        expect(recorded.calls.filter((call) => !call.startsWith("readLink "))).toEqual([])
      }),
    )

    for (const trusted of [false, true])
      it.live(`FileAccess.resolve of ${label} touches no share (${trusted ? "trusted" : "untrusted"})`, () =>
        Effect.gen(function* () {
          const project = path.join((yield* tmpdirScoped()).path, "project")
          yield* Effect.promise(() => chain(project, names(count), `\\\\${address}\\share`, "dir"))
          const view = provide(project, trusted)
          const started = Date.now()
          yield* Effect.gen(function* () {
            const access = yield* FileAccess.Service
            yield* access.resolve({ path: "l0/x" }).pipe(Effect.exit)
            yield* access.resolve({ path: ".", kind: "directory" }).pipe(Effect.exit)
            yield* access.resolve({ path: "l0", kind: "directory" }).pipe(Effect.exit)
          }).pipe(view.layer)
          expect(Date.now() - started).toBeLessThan(15_000)
          expect(followed(view.recorded.calls, path.join(project, "l0"))).toEqual([])
        }),
      )

    it.live(`ShellGuard.facts names ${label} as a place that is not resolved, for an operand and for the workdir`, () =>
      Effect.gen(function* () {
        const project = path.join((yield* tmpdirScoped()).path, "project")
        yield* Effect.promise(() => chain(project, names(count), `\\\\${address}\\share`, "dir"))
        const view = provide(project, false)
        const started = Date.now()
        const results = yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          return yield* Effect.forEach(
            [
              { command: "cat l0/x", cwd: project },
              { command: "ls", cwd: path.join(project, "l0") },
            ],
            (row) =>
              Effect.gen(function* () {
                const ctx = { shell: "sh", platform: process.platform, path: path.win32, home: os.homedir(), cwd: row.cwd, env: {} }
                const found = yield* Effect.gen(function* () {
                  const cwd = yield* access.resolve({ path: row.cwd, kind: "directory" })
                  return yield* ShellGuard.facts({
                    analysis: yield* ShellAnalysis.inspect(row.command, ctx, { nested: true }).pipe(
                      Effect.provideService(PowerShellParse.Service, noHost),
                    ),
                    text: row.command,
                    ctx,
                    cwd,
                    directories: [],
                  })
                }).pipe(Effect.exit)
                // Either the workdir itself is refused, or the place is reported as one that could not be resolved.
                return found._tag === "Failure" || found.value.places.some((place) => place.status === "unresolved")
              }),
          )
        }).pipe(view.layer)
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(results).toEqual([true, true])
        expect(followed(view.recorded.calls, path.join(project, "l0"))).toEqual([])
      }),
    )

    it.live(`ShellAnalysis.opensShare and ShellTool.concurrent treat a workdir that is ${label} as a share`, () =>
      Effect.gen(function* () {
        const base = (yield* tmpdirScoped()).path
        const bin = path.join(base, "bin")
        yield* Effect.promise(async () => {
          await fs.mkdir(bin, { recursive: true })
          await fs.writeFile(path.join(bin, "ls.exe"), "")
        })
        yield* Effect.promise(() => chain(path.join(base, "w"), names(count), `\\\\${address}\\share`, "dir"))
        const context = (cwd: string) =>
          ({
            shell: "C:\\Program Files\\Git\\bin\\bash.exe",
            platform: "win32",
            path: path.win32,
            home: os.homedir(),
            cwd,
            env: { Path: bin },
            local: () => false,
          }) satisfies Parameters<typeof ShellTool.concurrent>[1]
        const started = Date.now()
        expect(ShellAnalysis.opensShare(context(path.join(base, "w", "l0")))).toBe(true)
        // The plain folder beside it is the control: it may run beside others, the chain may not.
        const run = (cwd: string) =>
          Effect.runPromise(
            ShellTool.concurrent("ls", context(cwd)).pipe(Effect.provideService(PowerShellParse.Service, noHost)),
          )
        expect(yield* Effect.promise(() => run(base))).toBe(true)
        expect(yield* Effect.promise(() => run(path.join(base, "w", "l0")))).toBe(false)
        expect(Date.now() - started).toBeLessThan(15_000)
      }),
    )
  }
})


// A chain that ends at a file outside the project that is not there yet. The walk that decides where a write lands must
// not stop at its limit and call the last name inside the project the place.
describe.skipIf(!canLinkFile)("a chain of links that ends at a file outside the project that is not there yet", () => {
  for (const count of counts)
    for (const trusted of [false, true]) {
      const label = `${count} links, ${trusted ? "trusted" : "untrusted"}`

      it.live(`${label}: the write is judged where it lands`, () =>
        Effect.gen(function* () {
          const tmp = (yield* tmpdirScoped()).path
          const project = path.join(tmp, "project")
          const outside = path.join(tmp, "outside")
          yield* Effect.promise(async () => {
            await fs.mkdir(outside, { recursive: true })
            await chain(project, names(count), path.join(outside, "new.txt"), "file")
          })
          const real = FSUtil.resolve(outside)
          const view = provide(project, trusted)
          const seen = yield* Effect.gen(function* () {
            const access = yield* FileAccess.Service
            const trust = yield* ProjectTrust.Service
            const target = yield* access.resolve({ path: "l0", kind: "file" }).pipe(Effect.exit)
            const ctx = { shell: "sh", platform: process.platform, path: win ? path.win32 : path.posix, home: os.homedir(), cwd: project, env: {} }
            const guard = yield* Effect.forEach(["printf x > l0", "touch l0"], (command) =>
              Effect.gen(function* () {
                return yield* ShellGuard.facts({
                  analysis: yield* ShellAnalysis.inspect(command, ctx, { nested: true }).pipe(
                    Effect.provideService(PowerShellParse.Service, noHost),
                  ),
                  text: command,
                  ctx,
                  cwd: yield* access.resolve({ path: project, kind: "directory" }),
                  directories: [],
                })
              }),
            )
            return { target, guard, leads: yield* trust.leads(path.join(project, "l0")) }
          }).pipe(view.layer)
          // Where it lands: outside the project, however many links lead there.
          // A chain longer than the walk follows is not resolved, which every caller refuses or asks about.
          const resolved = count <= LinkShare.LIMIT
          if (resolved) expect(path.dirname(seen.leads).toLowerCase()).toBe(real.toLowerCase())
          else expect(LinkShare.isUnresolved(seen.leads)).toBe(true)
          expect(seen.target._tag).toBe(resolved ? "Success" : "Failure")
          if (seen.target._tag === "Success") {
            expect(seen.target.value.externalDirectory?.directory.toLowerCase()).toBe(real.toLowerCase())
            // Only a project that is not trusted marks the folder as one a link leads to.
            expect(seen.target.value.externalDirectory?.escaped).toBe(trusted ? undefined : true)
            expect(
              Permission.evaluate("Edit", slash(seen.target.value.leads ?? seen.target.value.place), [
                { action: "Edit", resource: "*", effect: "allow" },
                { action: "Edit", resource: `${slash(real)}/*`, effect: "deny" },
              ]).effect,
            ).toBe("deny")
          }
          for (const found of seen.guard) {
            expect(found.places.map((place) => place.status)).toEqual([resolved ? "external" : "unresolved"])
            if (resolved)
              expect(found.external.map((target) => target.externalDirectory?.directory.toLowerCase())).toEqual([
                real.toLowerCase(),
              ])
          }
          // The disk agrees: Windows writes through a chain of up to 63 links, and Linux refuses one of more than 40.
          const written = yield* Effect.promise(() =>
            fs.writeFile(path.join(project, "l0"), "x").then(
              () => "written",
              (error: NodeJS.ErrnoException) => error.code,
            ),
          )
          if (win) expect(written === "written").toBe(count <= 63)
          else expect(written).toBe(count > 40 ? "ELOOP" : "written")
        }),
      )
    }
})

const slash = (value: string) => value.replaceAll("\\", "/")
