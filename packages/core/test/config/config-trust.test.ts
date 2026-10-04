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
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// The real configuration loader over a project in a home of its own, with trust that nothing grants on its own.
function loader(folders: Folders, options: { readonly implicit?: boolean } = {}) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
    Config.node.replace(
      Config.configured({
        content: JSON.stringify({ shell: "flag-shell", hooks: { SessionEnd: [flagHook] } }),
      }),
    ),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: options.implicit ?? false })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(folders.repo) }))),
    ),
    Global.node.replace(Global.layerWith({ config: folders.globalConfig, home: folders.home })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
}

interface Folders {
  readonly home: string
  readonly globalConfig: string
  readonly repo: string
}

const hook = (command: string) => ({ matcher: "shell", hooks: [{ type: "command", command }] })
const flagHook = { hooks: [{ type: "command", command: "echo flag" }] }

// A project that asks for most of what trust holds back, in every file that can carry it, beside the user's own config.
const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders: Folders = {
    home: path.join(root, "home"),
    globalConfig: path.join(root, "home", ".config", "orbit"),
    repo: path.join(root, "work", "repo"),
  }
  const write = (file: string, contents: unknown) =>
    fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(contents)))
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
        expect(project?.withheld).toEqual(["hooks", "mcp", "permissions", "shell", "network"])
        expect(project?.info.hooks).toBeUndefined()
        expect(project?.info.mcp).toBeUndefined()
        expect(project?.info.shell).toBeUndefined()
        expect(project?.info.websearch).toBeUndefined()
        expect(project?.info.permissions).toEqual([{ action: "shell", resource: "rm *", effect: "deny" }])
        expect<unknown>(project?.info.model).toEqual({ providerID: "project", model: "model" })

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

        // The repository's inert settings still outrank the user's. Everything else it asked for is out of reach.
        expect<unknown>(Config.latest(entries, "model")).toEqual({ providerID: "project", model: "model" })
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
          withheld: ["hooks", "mcp", "permissions", "shell", "network"],
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
          { path: files.project, kinds: ["hooks", "mcp", "permissions", "shell", "network"] },
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
})
