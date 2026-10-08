import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Directory, Document, Event, type Entry } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { withEnv } from "../fixture/env"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// The real configuration loader over a project in a home of its own, with trust that nothing grants on its own. A
// project with a `canonical` folder is a linked worktree of the checkout that sits there.
function loader(folders: Folders, options: { readonly implicit?: boolean; readonly canonical?: string } = {}) {
  const here = location({ directory: AbsolutePath.make(folders.repo) })
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
    Config.node.replace(
      Config.configured({
        content: JSON.stringify({ shell: "flag-shell", hooks: { SessionEnd: [flagHook] } }),
      }),
    ),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: options.implicit ?? false })),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          options.canonical === undefined
            ? here
            : { ...here, project: { ...here.project, canonical: AbsolutePath.make(options.canonical) } },
        ),
      ),
    ),
    Global.node.replace(Global.layerWith({ config: folders.globalConfig, home: folders.home })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
}

interface Folders {
  readonly root: string
  readonly home: string
  readonly globalConfig: string
  /** The folder above the project, which discovery walks through. */
  readonly work: string
  readonly repo: string
}

const hook = (command: string) => ({ matcher: "shell", hooks: [{ type: "command", command }] })
const flagHook = { hooks: [{ type: "command", command: "echo flag" }] }

// The folders of a project in a home of its own, with no files in them.
const bare = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  return {
    root,
    home: path.join(root, "home"),
    globalConfig: path.join(root, "home", ".config", "orbit"),
    work: path.join(root, "work"),
    repo: path.join(root, "work", "repo"),
  } satisfies Folders
})

const write = (file: string, contents: unknown) =>
  fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents)))

// A project that asks for most of what trust holds back, in every file that can carry it, beside the user's own config.
const layout = Effect.gen(function* () {
  const folders = yield* bare
  yield* Effect.promise(() =>
    Promise.all([
      write(path.join(folders.globalConfig, "orbit.json"), {
        model: "user/model",
        websearch: false,
        sandbox: { enabled: true },
        hooks: { PreToolUse: [hook("echo user")] },
      }),
      write(path.join(folders.repo, "orbit.json"), {
        model: "project/model",
        shell: "project-shell",
        websearch: { provider: "random" },
        hooks: { PreToolUse: [hook("echo project")] },
        mcp: { servers: { docs: { type: "local", command: ["docs-server"] } } },
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "shell", resource: "rm *", effect: "deny" },
        ],
      }),
      write(path.join(folders.repo, "orbit.local.json"), { username: "dev", plugins: ["local-plugin"] }),
      write(path.join(folders.repo, CompatNames.vendor.directory, "settings.json"), {
        hooks: { PreToolUse: [hook("echo vendor")] },
      }),
      write(path.join(folders.repo, CompatNames.mcp), { mcpServers: { files: { command: "files-server" } } }),
      fs.mkdir(path.join(folders.repo, ".orbit"), { recursive: true }),
    ]),
  )
  return folders
})

const documents = (entries: readonly Entry[]) => entries.filter((entry): entry is Document => entry.type === "document")
const named = (entries: readonly Entry[], file: string) =>
  documents(entries).find((entry) => entry.path === AbsolutePath.make(file))

// The next config.updated, so a change is waited for rather than slept on.
const nextUpdate = Effect.gen(function* () {
  const bus = yield* Bus.Service
  return yield* bus
    .subscribe(Event.Updated)
    .pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("10 seconds"),
      Effect.forkScoped({ startImmediately: true }),
    )
})

describe("Config under workspace trust", () => {
  it.live("stamps and sanitizes the project and local entries of an untrusted folder", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        const project = named(entries, path.join(folders.repo, "orbit.json"))
        const local = named(entries, path.join(folders.repo, "orbit.local.json"))
        const vendor = named(entries, path.join(folders.repo, CompatNames.vendor.directory, "settings.json"))
        const mcp = named(entries, path.join(folders.repo, CompatNames.mcp))

        expect(project).toMatchObject({ scope: "project", trusted: false })
        expect(project?.withheld).toEqual(["hooks", "mcp", "permissions", "providers", "shell", "network"])
        expect(project?.info.hooks).toBeUndefined()
        expect(project?.info.mcp).toBeUndefined()
        expect(project?.info.shell).toBeUndefined()
        expect(project?.info.websearch).toBeUndefined()
        expect(project?.info.permissions).toEqual([{ action: "shell", resource: "rm *", effect: "deny" }])
        expect(project?.info.model).toBeUndefined()

        expect(local).toMatchObject({ scope: "local", trusted: false, withheld: ["plugins"] })
        expect(local?.info.plugins).toBeUndefined()
        expect(local?.info.username).toBe("dev")

        // The files of other products are project and local config like any other, so they are held back too.
        expect(vendor).toMatchObject({ scope: "project", trusted: false, withheld: ["hooks"] })
        expect(vendor?.info.hooks).toBeUndefined()
        expect(mcp).toMatchObject({ scope: "project", trusted: false, withheld: ["mcp"] })
        expect(mcp?.info.mcp).toBeUndefined()

        const directories = entries.filter((entry): entry is Directory => entry.type === "directory")
        const projectDirectory = directories.find(
          (entry) => entry.path === AbsolutePath.make(path.join(folders.repo, ".orbit")),
        )
        expect(projectDirectory).toMatchObject({ scope: "project", trusted: false })

        // Nothing of the user's or the flag's is touched.
        const user = named(entries, path.join(folders.globalConfig, "orbit.json"))
        expect(user?.scope).toBe("user")
        expect(user).not.toHaveProperty("trusted")
        expect(user?.info.hooks).toBeDefined()
        expect(user?.info.sandbox).toEqual({ enabled: true })
        const flag = documents(entries).find((entry) => entry.scope === "flag")
        expect(flag).not.toHaveProperty("trusted")
        expect(flag?.info.hooks).toBeDefined()
        expect(flag?.info.shell).toBe("flag-shell")
        expect(directories.filter((entry) => entry.scope !== "project" && entry.trusted !== undefined)).toEqual([])

        // Everything the repository asked for is out of reach, its model included: the user's choice stands.
        expect<unknown>(Config.latest(entries, "model")).toEqual({ providerID: "user", model: "model" })
        expect(Config.latest(entries, "shell")).toBe("flag-shell")
        expect(Config.latest(entries, "mcp")).toBeUndefined()
        expect(Config.latest(entries, "sandbox")).toEqual({ enabled: true })
        // A repository cannot turn on the keyless search pool over a user who turned search off.
        expect(Config.latest(entries, "websearch")).toBe(false)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("applies what was held back once the folder is trusted, and holds it back again when it is not", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const trust = yield* WorkspaceTrust.Service
        const project = path.join(folders.repo, "orbit.json")
        expect(named(yield* config.entries(), project)).toMatchObject({ trusted: false })

        const granted = yield* nextUpdate
        yield* trust.grant(folders.repo, { persist: true, via: "test" })
        yield* Fiber.join(granted)

        const after = yield* config.entries()
        const trusted = named(after, project)
        expect(trusted).not.toHaveProperty("trusted")
        expect(trusted).not.toHaveProperty("withheld")
        expect(trusted?.info.hooks).toBeDefined()
        expect(trusted?.info.mcp?.servers?.docs).toBeDefined()
        expect(trusted?.info.shell).toBe("project-shell")
        expect(trusted?.info.permissions).toHaveLength(2)
        expect(named(after, path.join(folders.repo, "orbit.local.json"))?.info.plugins).toEqual(["local-plugin"])
        expect(
          named(after, path.join(folders.repo, CompatNames.vendor.directory, "settings.json"))?.info.hooks,
        ).toBeDefined()
        expect(named(after, path.join(folders.repo, CompatNames.mcp))?.info.mcp?.servers?.files).toBeDefined()
        expect(documents(after).filter((entry) => entry.trusted === false)).toEqual([])
        expect(after.filter((entry) => entry.type === "directory" && entry.trusted === false)).toEqual([])
        // The project outranks the user again, and now so does its choice of web search.
        expect<unknown>(Config.latest(after, "websearch")).toEqual({ provider: "random" })
        expect(Config.latest(after, "shell")).toBe("flag-shell")

        const revoked = yield* nextUpdate
        yield* trust.revoke(folders.repo)
        yield* Fiber.join(revoked)
        const withheld = named(yield* config.entries(), project)
        expect(withheld).toMatchObject({
          trusted: false,
          withheld: ["hooks", "mcp", "permissions", "providers", "shell", "network"],
        })
        expect(withheld?.info.hooks).toBeUndefined()
        expect(Config.latest(yield* config.entries(), "websearch")).toBe(false)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("applies a grant that a session made without storing it", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const trust = yield* WorkspaceTrust.Service
        const granted = yield* nextUpdate
        yield* trust.grant(folders.repo, { persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect(named(yield* config.entries(), path.join(folders.repo, "orbit.json"))?.info.shell).toBe("project-shell")
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("reports through ProjectTrust what each file holds back, and grants and revokes for the project", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const project = yield* ProjectTrust.Service
        const files = {
          vendor: path.join(folders.repo, CompatNames.vendor.directory, "settings.json"),
          mcp: path.join(folders.repo, CompatNames.mcp),
          project: path.join(folders.repo, "orbit.json"),
          local: path.join(folders.repo, "orbit.local.json"),
        }

        const untrusted = yield* project.status()
        expect(untrusted).toMatchObject({ directory: folders.repo, trusted: false, persistent: true })
        expect(untrusted).not.toHaveProperty("source")
        // In the order the entries rank, each with what it lost; a file that held nothing back is not listed.
        expect<unknown>(untrusted.withheld).toEqual([
          { path: files.vendor, kinds: ["hooks"] },
          { path: files.mcp, kinds: ["mcp"] },
          { path: files.project, kinds: ["hooks", "mcp", "permissions", "providers", "shell", "network"] },
          { path: files.local, kinds: ["plugins"] },
        ])

        const granted = yield* nextUpdate
        // A trusted project has nothing held back, even before its config has reloaded.
        expect<unknown>(yield* project.grant({ persist: true, via: "test" })).toEqual({
          directory: folders.repo,
          trusted: true,
          persistent: true,
          source: "saved",
          withheld: [],
        })
        yield* Fiber.join(granted)
        expect(yield* project.status()).toMatchObject({ trusted: true, source: "saved", withheld: [] })

        const revoked = yield* nextUpdate
        expect(yield* project.revoke()).toMatchObject({ directory: folders.repo, trusted: false })
        yield* Fiber.join(revoked)
        expect<unknown>((yield* project.status()).withheld.map((item) => item.path)).toEqual(Object.values(files))
        expect((yield* config.entries()).some((entry) => entry.trusted === false)).toBe(true)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("stamps nothing while the folder is trusted", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        expect(entries.filter((entry) => entry.trusted !== undefined)).toEqual([])
        expect(named(entries, path.join(folders.repo, "orbit.json"))?.info.hooks).toBeDefined()
        expect(Config.latest(entries, "websearch")).toEqual({ provider: "random" })
      }).pipe(Effect.provide(loader(folders, { implicit: true })))
    }),
  )

  it.live("tells a revoke's caller what the files hold back before the config has reloaded", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const project = yield* ProjectTrust.Service
        const config = yield* Config.Service
        const granted = yield* nextUpdate
        yield* trust.grant(folders.repo, { persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect((yield* config.entries()).some((entry) => entry.trusted === false)).toBe(false)

        // The entries still hold the files as they were loaded for a trusted folder, and the next load is a moment off.
        const reloaded = yield* nextUpdate
        const revoked = yield* project.revoke()
        expect(revoked).toMatchObject({ trusted: false })
        expect(revoked.withheld.map((item) => [path.relative(folders.repo, item.path), item.kinds])).toEqual([
          [path.join(CompatNames.vendor.directory, "settings.json"), ["hooks"]],
          [CompatNames.mcp, ["mcp"]],
          ["orbit.json", ["hooks", "mcp", "permissions", "providers", "shell", "network"]],
          ["orbit.local.json", ["plugins"]],
        ])
        // It is the answer the loaded config gives once it has caught up.
        yield* Fiber.join(reloaded)
        expect(yield* project.status()).toEqual(revoked)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("keeps what a file refers to inside the folder while the folder is untrusted", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside", "secret.txt")
      // The tokens are read as text before the file is parsed, so a path in one has to be written with slashes.
      const slashes = (file: string) => file.replaceAll("\\", "/")
      const own = path.join(folders.repo, "orbit.json")
      yield* Effect.promise(() =>
        Promise.all([
          write(outside, "outside secret"),
          write(path.join(folders.repo, "notes.txt"), "inside notes"),
          write(own, {
            username: "{env:ORBIT_TRUST_PROBE}",
            agents: {
              inside: { system: "{file:./notes.txt}" },
              absolute: { system: `{file:${slashes(outside)}}` },
              up: { system: "{file:../../outside/secret.txt}" },
              linked: { system: "{file:./linked/secret.txt}" },
            },
          }),
          write(path.join(folders.globalConfig, "orbit.json"), {
            username: "{env:ORBIT_TRUST_PROBE}",
            agents: { mine: { system: `{file:${slashes(outside)}}` } },
          }),
        ]).then(() => fs.symlink(path.dirname(outside), path.join(folders.repo, "linked"), "junction")),
      )
      const system = (entries: readonly Entry[], agent: string) => named(entries, own)?.info.agents?.[agent]?.system

      yield* withEnv({ ORBIT_TRUST_PROBE: "probe value" }, () =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const trust = yield* WorkspaceTrust.Service
          const before = yield* config.entries()

          // The folder's own file is read, and nothing else: a variable is not looked up, and a file outside the
          // folder is not read, whether it is named outright, reached by leaving the folder, or through a link in it.
          expect(named(before, own)).toMatchObject({ trusted: false })
          expect(named(before, own)?.info.username).toBe("{env:ORBIT_TRUST_PROBE}")
          expect(system(before, "inside")).toBe("inside notes")
          expect(system(before, "absolute")).toBe(`{file:${slashes(outside)}}`)
          expect(system(before, "up")).toBe("{file:../../outside/secret.txt}")
          expect(system(before, "linked")).toBe("{file:./linked/secret.txt}")
          // The user's own config is never held to the folder.
          const user = named(before, path.join(folders.globalConfig, "orbit.json"))
          expect(user?.info.username).toBe("probe value")
          expect(user?.info.agents?.mine?.system).toBe("outside secret")

          const granted = yield* nextUpdate
          yield* trust.grant(folders.repo, { persist: false, via: "test" })
          yield* Fiber.join(granted)

          const after = yield* config.entries()
          expect(named(after, own)?.info.username).toBe("probe value")
          expect(system(after, "inside")).toBe("inside notes")
          expect(system(after, "absolute")).toBe("outside secret")
          expect(system(after, "up")).toBe("outside secret")
          expect(system(after, "linked")).toBe("outside secret")
        }).pipe(Effect.provide(loader(folders))),
      )
    }),
  )

  it.live("does not reach for a network share that a file of an untrusted folder names", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const own = path.join(folders.repo, "orbit.json")
      yield* Effect.promise(() => write(own, `{ "username": "{file://host/share/name.txt}" }`))
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        // Nothing opened a path that no machine here has: the reference is only text, and the file still loads.
        expect(named(yield* config.entries(), own)).toMatchObject({ trusted: false })
        expect(named(yield* config.entries(), own)?.info.username).toBe("{file://host/share/name.txt}")
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("decides the config above the project by the folder that holds it", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const own = path.join(folders.repo, "orbit.json")
      const above = path.join(folders.work, "orbit.json")
      const vendorAbove = path.join(folders.work, CompatNames.vendor.directory, "settings.json")
      yield* Effect.promise(() =>
        Promise.all([
          write(own, { shell: "project-shell", hooks: { PreToolUse: [hook("echo project")] } }),
          write(above, { model: "above/model", shell: "above-shell", hooks: { PreToolUse: [hook("echo above")] } }),
          write(vendorAbove, { hooks: { PreToolUse: [hook("echo vendor above")] } }),
        ]),
      )
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const trust = yield* WorkspaceTrust.Service
        const project = yield* ProjectTrust.Service
        const stamps = (entries: readonly Entry[]) =>
          [own, above, vendorAbove].map((file) => named(entries, file)?.trusted === false)

        expect(stamps(yield* config.entries())).toEqual([true, true, true])

        // A grant for the project reaches its own folder and not the folders around it.
        const granted = yield* nextUpdate
        yield* trust.grant(folders.repo, { persist: false, via: "test" })
        yield* Fiber.join(granted)
        const afterProject = yield* config.entries()
        expect(stamps(afterProject)).toEqual([false, true, true])
        expect(named(afterProject, own)?.info.hooks).toBeDefined()
        expect(named(afterProject, above)).toMatchObject({ withheld: ["hooks", "providers", "shell"] })
        expect(named(afterProject, above)?.info.hooks).toBeUndefined()
        expect(named(afterProject, above)?.info.model).toBeUndefined()
        expect(named(afterProject, vendorAbove)?.info.hooks).toBeUndefined()
        // The status says what is still held back, though the project is trusted, and which folder lifts it: the one
        // around the file, and around the vendor directory that holds the other.
        const status = yield* project.status()
        expect(status).toMatchObject({ directory: folders.repo, trusted: true })
        expect<unknown>(status.withheld).toEqual([
          { path: vendorAbove, kinds: ["hooks"], directory: folders.work },
          { path: above, kinds: ["hooks", "providers", "shell"], directory: folders.work },
        ])

        // The folder above is trusted on its own.
        const grantedAbove = yield* nextUpdate
        yield* trust.grant(folders.work, { persist: false, via: "test" })
        yield* Fiber.join(grantedAbove)
        const afterAbove = yield* config.entries()
        expect(stamps(afterAbove)).toEqual([false, false, false])
        expect(named(afterAbove, above)?.info.hooks).toBeDefined()
        expect(named(afterAbove, vendorAbove)?.info.hooks).toBeDefined()
        expect((yield* project.status()).withheld).toEqual([])

        // And taking the project's grant away leaves the folder above as it is.
        const revoked = yield* nextUpdate
        yield* trust.revoke(folders.repo)
        yield* Fiber.join(revoked)
        expect(stamps(yield* config.entries())).toEqual([true, false, false])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("covers a linked worktree with the decision for its main checkout", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const main = path.join(folders.root, "main")
      const own = path.join(folders.repo, "orbit.json")
      yield* Effect.promise(() =>
        Promise.all([fs.mkdir(main, { recursive: true }), write(own, { shell: "worktree-shell" })]),
      )
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const trust = yield* WorkspaceTrust.Service
        const project = yield* ProjectTrust.Service
        expect(named(yield* config.entries(), own)).toMatchObject({ trusted: false, withheld: ["shell"] })
        expect(yield* project.status()).toMatchObject({ directory: main, trusted: false })

        const granted = yield* nextUpdate
        yield* trust.grant(main, { persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect(named(yield* config.entries(), own)?.info.shell).toBe("worktree-shell")
        expect(named(yield* config.entries(), own)?.trusted).toBeUndefined()
      }).pipe(Effect.provide(loader(folders, { canonical: main })))
    }),
  )

  it.live("trusts the folders above a project as well on a server with implicit trust", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const above = path.join(folders.work, "orbit.json")
      yield* Effect.promise(() => write(above, { shell: "above-shell" }))
      yield* Effect.gen(function* () {
        const entries = yield* (yield* Config.Service).entries()
        expect(entries.filter((entry) => entry.trusted !== undefined)).toEqual([])
        expect(named(entries, above)?.info.shell).toBe("above-shell")
      }).pipe(Effect.provide(loader(folders, { implicit: true })))
    }),
  )

  it.live("refuses the files of an untrusted project that has no config of its own", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const skill = path.join(folders.repo, CompatNames.agents, "skills", "demo", "SKILL.md")
      const mine = path.join(folders.home, CompatNames.agents, "skills", "mine", "SKILL.md")
      yield* Effect.promise(() => Promise.all([write(skill, "Demo."), write(mine, "Mine.")]))
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const project = yield* ProjectTrust.Service
        // The root as the config reports it now.
        const rootAt = (...parts: string[]) =>
          config
            .compat()
            .pipe(
              Effect.map((compat) => compat.roots.find((item) => item.path === AbsolutePath.make(path.join(...parts)))),
            )

        // The repository has nothing that is config, so nothing is stamped and nothing is listed as held back.
        expect(yield* project.status()).toMatchObject({ trusted: false, withheld: [] })
        expect(yield* project.trusted()).toBe(false)
        // Its skills folder is a root all the same, and the verdict for the folder is on it.
        expect(yield* rootAt(folders.repo, CompatNames.agents)).toMatchObject({ scope: "project", trusted: false })
        expect(yield* rootAt(folders.home, CompatNames.agents)).toMatchObject({ scope: "user" })
        expect(yield* rootAt(folders.home, CompatNames.agents)).not.toHaveProperty("trusted")

        expect(yield* project.allows(skill)).toBe(false)
        expect(yield* project.allows(path.join(folders.repo, "docs", "anything.md"))).toBe(false)
        expect(yield* project.allows(mine)).toBe(true)

        // Both follow the decision at once, with no wait for the config to reload.
        yield* project.grant({ persist: false, via: "test" })
        expect(yield* project.trusted()).toBe(true)
        expect(yield* project.allows(skill)).toBe(true)
        expect(yield* rootAt(folders.repo, CompatNames.agents)).not.toHaveProperty("trusted")

        yield* project.revoke()
        expect(yield* project.trusted()).toBe(false)
        expect(yield* project.allows(skill)).toBe(false)
        expect(yield* project.allows(mine)).toBe(true)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("refuses the files of an untrusted project even when it keeps the user's own folders", () =>
    Effect.gen(function* () {
      // The project is the user's home, which no grant ever stores and no implicit trust covers.
      const folders = yield* bare
      const mine = path.join(folders.home, CompatNames.agents, "skills", "mine", "SKILL.md")
      const ownedByRepo = path.join(folders.home, "work", "repo", CompatNames.agents, "skills", "demo", "SKILL.md")
      yield* Effect.promise(() => Promise.all([write(mine, "Mine."), write(ownedByRepo, "Demo.")]))
      const inHome = { ...folders, repo: folders.home }
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(yield* project.status()).toMatchObject({ directory: folders.home, trusted: false, persistent: false })
        expect(yield* project.allows(mine)).toBe(true)
        expect(yield* project.allows(ownedByRepo)).toBe(false)
      }).pipe(Effect.provide(loader(inHome)))
    }),
  )
})
