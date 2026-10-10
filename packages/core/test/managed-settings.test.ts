import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Ref, Stream } from "effect"
import { Event, type Document, type Info } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// The managed folder, the project and the global config folder live in one temp folder; the real /etc/orbit and
// %ProgramFiles%\Orbit are never read because the directory is always given.
const layers = (root: string, directory = path.join(root, "managed")) =>
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, ManagedPolicy.node, ManagedSettings.node]), [
      ManagedSettings.node.replace(ManagedSettings.configured({ directory })),
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(path.join(root, "project")) })),
        ),
      ),
      Global.node.replace(Global.layerWith({ config: path.join(root, "global"), home: path.join(root, "home") })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ]),
    Watcher.testLayer,
  )

const pluginLayers = (root: string) =>
  Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([Config.node, Bus.node, ManagedPolicy.node, ManagedSettings.node, ConfigPluginSource.node]),
      [
        ManagedSettings.node.replace(ManagedSettings.configured({ directory: path.join(root, "managed") })),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(path.join(root, "project")) })),
          ),
        ),
        Global.node.replace(Global.layerWith({ config: path.join(root, "global"), home: path.join(root, "home") })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(emptyWellknownNode),
        Watcher.node.replace(Watcher.testLayer),
      ],
    ),
    Watcher.testLayer,
  )

const reader = AppNodeBuilder.build(LayerNode.group([FSUtil.node]))

const write = (directory: string, files: Record<string, unknown>) =>
  Effect.promise(async () => {
    await Promise.all(
      Object.entries(files).map(async ([name, content]) => {
        const file = path.join(directory, name)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, typeof content === "string" ? content : JSON.stringify(content))
      }),
    )
  })

const read = (directory: string) => ManagedSettings.read(directory).pipe(Effect.provide(reader))

const rule = (effect: "allow" | "deny" | "ask", resource: string) => ({ action: "Bash", resource, effect })

// Follows keys through a decoded value without asserting its shape.
const field = (value: unknown, ...keys: string[]) =>
  keys.reduce<unknown>(
    (current, key) => (typeof current === "object" && current !== null ? Object.fromEntries(Object.entries(current))[key] : undefined),
    value,
  )

describe("ManagedSettings.read", () => {
  it.live("applies the base file first and then the drop-ins by filename", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { shell: "base", output_style: "base" },
        // Written out of order on purpose: the filename decides, not the write order or the directory listing.
        "managed-settings.d/20-late.json": { shell: "late" },
        "managed-settings.d/10-early.json": { shell: "early", output_style: "early" },
        "managed-settings.d/notes.txt": { shell: "ignored" },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.sources.map((source) => path.relative(tmp.path, source).replaceAll("\\", "/"))).toEqual([
        "managed-settings.json",
        "managed-settings.d/10-early.json",
        "managed-settings.d/20-late.json",
      ])
      expect(snapshot.info.shell).toBe("late")
      expect(snapshot.info.output_style).toBe("early")
      expect(snapshot.diagnostics).toEqual([])
    }),
  )

  it.live("concatenates arrays, removes repeated strings and lets scalars take the last value", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": {
          permissions: [rule("deny", "rm *")],
          shell: "one",
          managed: { mcp: { deny: ["a", "b"] }, disable_hooks: true, organization: "First" },
        },
        "managed-settings.d/10.json": {
          permissions: [rule("deny", "sudo *")],
          shell: "two",
          managed: { mcp: { deny: ["b", "c"] }, disable_hooks: false, organization: "Second" },
        },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.info.permissions).toEqual([rule("deny", "rm *"), rule("deny", "sudo *")])
      expect(snapshot.info.shell).toBe("two")
      expect(snapshot.restrictions).toEqual({
        organization: "Second",
        disable_hooks: false,
        mcp: { deny: ["a", "b", "c"] },
      })
    }),
  )

  it.live("skips a malformed drop-in, reports it, and keeps the denies of its siblings", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { managed: { mcp: { deny: ["base"] } } },
        "managed-settings.d/10-broken.json": '{ "managed": { "mcp": { "deny": ["lost"] } ',
        "managed-settings.d/20-array.json": "[]",
        "managed-settings.d/30-ok.json": { managed: { mcp: { deny: ["ok"] } } },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.restrictions.mcp?.deny).toEqual(["base", "ok"])
      expect(snapshot.diagnostics.map((item) => [path.basename(item.source), item.path, item.kind]).toSorted()).toEqual(
        [
          ["10-broken.json", "$", "invalid"],
          ["20-array.json", "$", "invalid"],
        ],
      )
    }),
  )

  it.live("loses only the entry that does not decode, never the entries around it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": {
          managed: {
            mcp: { deny: ["before", 7, "after"], allow: "not-a-list" },
            network: { denied_domains: ["bad.example"] },
            disable_hooks: "yes",
            plugins: 3,
          },
        },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.restrictions).toEqual({
        mcp: { deny: ["before", "after"] },
        network: { denied_domains: ["bad.example"] },
      })
      expect(snapshot.diagnostics.map((item) => item.path).toSorted()).toEqual([
        "$.managed.disable_hooks",
        "$.managed.mcp.allow",
        "$.managed.mcp.deny.1",
        "$.managed.plugins",
      ])
    }),
  )

  it.live("yields an empty snapshot for a missing directory and does not create it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const missing = path.join(tmp.path, "not-there")

      const snapshot = yield* read(missing)

      expect(snapshot.sources).toEqual([])
      expect(snapshot.restrictions).toEqual({})
      expect(snapshot.diagnostics).toEqual([])
      expect(snapshot.info.shell).toBeUndefined()
      expect(
        yield* Effect.promise(() =>
          fs.stat(missing).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.live("ignores managed.env with a diagnostic that points at the top-level env", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, { "managed-settings.json": { managed: { env: { SECRET: "x" } } } })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.restrictions).toEqual({})
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          path: "$.managed.env",
          kind: "unsupported",
          message: expect.stringContaining("env"),
        }),
      ])
    }),
  )

  it.live("substitutes variables per file", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "organization.txt": "Acme",
        "managed-settings.json": '{ // comment\n "managed": { "organization": "{file:organization.txt}" }, }',
      })

      expect((yield* read(tmp.path)).restrictions.organization).toBe("Acme")
    }),
  )
})

const secured = process.platform !== "win32" && process.getuid?.() !== 0
const base = { managed: { mcp: { deny: ["x"] } } }

describe("ManagedSettings.read unreadable input", () => {
  const rows = [
    {
      name: "a file that cannot be read",
      skip: !secured,
      setup: (directory: string) =>
        write(directory, { "managed-settings.json": base }).pipe(
          Effect.andThen(Effect.promise(() => fs.chmod(path.join(directory, "managed-settings.json"), 0o000))),
        ),
      at: (directory: string) => path.join(directory, "managed-settings.json"),
      listed: true,
    },
    {
      name: "a drop-in that cannot be read",
      skip: !secured,
      setup: (directory: string) =>
        write(directory, { "managed-settings.d/10.json": base }).pipe(
          Effect.andThen(Effect.promise(() => fs.chmod(path.join(directory, "managed-settings.d", "10.json"), 0o000))),
        ),
      at: (directory: string) => path.join(directory, "managed-settings.d", "10.json"),
      listed: true,
    },
    {
      name: "a drop-in folder that cannot be listed",
      skip: !secured,
      setup: (directory: string) =>
        write(directory, { "managed-settings.d/10.json": base }).pipe(
          Effect.andThen(Effect.promise(() => fs.chmod(path.join(directory, "managed-settings.d"), 0o000))),
        ),
      at: (directory: string) => path.join(directory, "managed-settings.d"),
      listed: false,
    },
    {
      name: "a file that an access list denies",
      skip: process.platform !== "win32",
      setup: (directory: string) =>
        write(directory, { "managed-settings.json": base }).pipe(
          Effect.andThen(
            Effect.acquireRelease(
              Effect.sync(() =>
                Bun.spawnSync(["icacls", path.join(directory, "managed-settings.json"), "/deny", "*S-1-1-0:(R)"]),
              ),
              () =>
                Effect.sync(() =>
                  Bun.spawnSync(["icacls", path.join(directory, "managed-settings.json"), "/remove:d", "*S-1-1-0"]),
                ),
            ),
          ),
        ),
      at: (directory: string) => path.join(directory, "managed-settings.json"),
      listed: true,
    },
    {
      name: "managed-settings.d that is a file",
      skip: false,
      setup: (directory: string) => write(directory, { "managed-settings.d": "not a folder" }),
      at: (directory: string) => path.join(directory, "managed-settings.d"),
      listed: false,
    },
  ]

  rows
    .filter((row) => !row.skip)
    .forEach((row) =>
      it.live(`reports ${row.name} instead of treating it as missing`, () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* row.setup(tmp.path)
          // Give the folder back its permissions so the temporary folder can be removed.
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              Promise.all(
                ["managed-settings.json", "managed-settings.d", "managed-settings.d/10.json"].map((name) =>
                  fs.chmod(path.join(tmp.path, name), 0o700).catch(() => undefined),
                ),
              ),
            ),
          )

          const snapshot = yield* read(tmp.path)

          expect(snapshot.diagnostics).toContainEqual(
            expect.objectContaining({ source: row.at(tmp.path), path: "$", kind: "invalid" }),
          )
          expect(snapshot.sources.includes(row.at(tmp.path))).toBe(row.listed)
        }),
      ),
    )

  it.live("treats a missing drop-in folder as absent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, { "managed-settings.json": { shell: "x" } })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.sources).toHaveLength(1)
      expect(snapshot.diagnostics).toEqual([])
    }),
  )
})

describe("ManagedSettings.read unknown input", () => {
  it.live("reports a variable that cannot be resolved and skips only that file", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": '{ "managed": { "organization": "{file:missing.txt}" } }',
        "managed-settings.d/10.json": { managed: { mcp: { deny: ["kept"] } } },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.restrictions.mcp?.deny).toEqual(["kept"])
      expect(snapshot.diagnostics).toEqual([expect.objectContaining({ path: "$", kind: "invalid" })])
    }),
  )

  const unknownKeys: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["a misspelled flag", { disable_bypass_permision: true }, "$.managed.disable_bypass_permision"],
    ["a misspelled section", { networks: {} }, "$.managed.networks"],
    ["a misspelled mcp list", { mcp: { denied: ["x"] } }, "$.managed.mcp.denied"],
    ["a misspelled plugins list", { plugins: { blocked: ["x"] } }, "$.managed.plugins.blocked"],
    ["a misspelled network list", { network: { denied_domain: ["x"] } }, "$.managed.network.denied_domain"],
  ]
  unknownKeys.forEach(([name, managed, at]) =>
    it.live(`reports ${name}`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, { "managed-settings.json": { managed } })

        const snapshot = yield* read(tmp.path)

        expect(snapshot.diagnostics.map((item) => [item.path, item.kind])).toEqual([[at, "unsupported"]])
      }),
    ),
  )
})

describe("ManagedSettings.read merge and names", () => {
  it.live("replaces a model selection as one value, so a later file keeps no variant of an earlier one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { model: "alpha/big#high", agents: { review: { model: "alpha/big#high" } } },
        "managed-settings.d/10.json": { model: "beta/small", agents: { review: { model: "beta/small" } } },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.info.model as unknown).toEqual({ providerID: "beta", model: "small" })
      expect(snapshot.info.agents?.review?.model as unknown).toEqual({ providerID: "beta", model: "small" })
    }),
  )

  it.live("handles drop-in extensions that differ in case by what the file system does", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.d/10-a.JSON": { shell: "upper" },
        "managed-settings.d/20-b.jsonc": { shell: "jsonc" },
      })

      const snapshot = yield* read(tmp.path)
      const insensitive = process.platform === "win32" || process.platform === "darwin"

      expect(snapshot.info.shell).toBe(insensitive ? "upper" : undefined)
      expect(snapshot.diagnostics.map((item) => [path.basename(item.source), item.kind]).toSorted()).toEqual(
        insensitive
          ? [["20-b.jsonc", "unsupported"]]
          : [
              ["10-a.JSON", "unsupported"],
              ["20-b.jsonc", "unsupported"],
            ],
      )
    }),
  )
})

describe("managed settings folder override", () => {
  const overrides: ReadonlyArray<readonly [string, string]> = [
    ["an empty one", ""],
    ["a dot", "."],
    ["a relative one", "managed"],
  ]
  overrides.forEach(([name, directory]) =>
    it.live(`ignores ${name} and never reads the working folder`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, {
          "project/managed-settings.json": { permissions: [rule("allow", "*")] },
          "project/managed/managed-settings.json": { permissions: [rule("allow", "*")] },
        })
        const previous = process.cwd()
        yield* Effect.acquireRelease(
          Effect.sync(() => process.chdir(path.join(tmp.path, "project"))),
          () => Effect.sync(() => process.chdir(previous)),
        )
        yield* Effect.gen(function* () {
          yield* Config.Service
          expect((yield* ManagedPolicy.Service).current().rules).toEqual([])
        }).pipe(Effect.provide(layers(tmp.path, directory)))
      }),
    ),
  )
})

describe("managed key outside managed settings", () => {
  it.effect("is dropped from the document with a diagnostic", () =>
    Effect.sync(() => {
      const result = ConfigNormalize.normalize({ shell: "zsh", managed: { mcp: { deny: ["*"] } } })

      expect(result.type).toBe("normalized")
      if (result.type !== "normalized") return
      expect(result.encoded).not.toHaveProperty("managed")
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: ["managed"], kind: "unsupported" }))
    }),
  )

  it.live("is ignored in user config", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "global/orbit.json": { shell: "zsh", managed: { mcp: { deny: ["*"] } } },
        "project/.keep": "",
      })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        const policy = yield* ManagedPolicy.Service

        expect(Config.latest(entries, "shell")).toBe("zsh")
        expect(policy.current().restrictions).toEqual({})
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )
})

describe("ManagedSettings service", () => {
  it.live("feeds ManagedPolicy with statements, rules, restrictions and the organization", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const managed = path.join(tmp.path, "managed")
      yield* write(managed, {
        "managed-settings.json": {
          permissions: [rule("deny", "rm *")],
          experimental: { policies: [{ action: "provider.use", resource: "openai", effect: "deny" }] },
          agents: { reviewer: { permissions: [rule("deny", "curl *")] }, plain: { description: "no rules" } },
          managed: { organization: "Acme", network: { denied_domains: ["bad.example"] } },
        },
      })
      yield* Effect.gen(function* () {
        yield* Config.Service
        const policy = (yield* ManagedPolicy.Service).current()

        expect(policy.statements).toEqual([{ action: "provider.use", resource: "openai", effect: "deny" }])
        expect(policy.rules).toEqual([rule("deny", "rm *")])
        expect(policy.agentRules).toEqual({ reviewer: [rule("deny", "curl *")] })
        expect(policy.restrictions).toEqual({ organization: "Acme", network: { denied_domains: ["bad.example"] } })
        expect(policy.organization).toBe("Acme")
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("appends the managed document last and leaves it absent without files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "global/orbit.json": { shell: "user" },
        "project/orbit.json": { shell: "project" },
        "managed/managed-settings.json": { shell: "managed" },
      })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        const documents = entries.filter((entry): entry is Document => entry.type === "document")

        expect(documents.map((document) => document.scope)).toEqual(["user", "project", "managed"])
        expect(documents.at(-1)?.path).toBe(AbsolutePath.make(path.join(tmp.path, "managed", "managed-settings.json")))
        expect(Config.latest(entries, "shell")).toBe("managed")
      }).pipe(Effect.provide(layers(tmp.path)))

      yield* fs_rm(path.join(tmp.path, "managed"))
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        expect(entries.some((entry) => entry.type === "document" && entry.scope === "managed")).toBe(false)
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("reloads Config with the managed document when the watcher reports a change", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "managed", "managed-settings.json")
      yield* write(tmp.path, { "managed/managed-settings.json": { shell: "first" }, "project/.keep": "" })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.sleep("10 millis")

        yield* write(tmp.path, { "managed/managed-settings.json": { shell: "second" } })
        yield* watcher.emit({ type: "update", path: file })

        expect(yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))).toHaveLength(1)
        expect(Config.latest(yield* config.entries(), "shell")).toBe("second")
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("publishes config.updated for an edit that changes only restrictions", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "managed", "managed-settings.json")
      yield* write(tmp.path, {
        "managed/managed-settings.json": { shell: "same", managed: { mcp: { deny: ["a"] } } },
        "project/.keep": "",
      })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const policy = yield* ManagedPolicy.Service
        const before = yield* config.entries()
        const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.sleep("10 millis")

        yield* write(tmp.path, {
          "managed/managed-settings.json": { shell: "same", managed: { mcp: { deny: ["a", "b"] } } },
        })
        yield* watcher.emit({ type: "update", path: file })

        expect(yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))).toHaveLength(1)
        expect(yield* config.entries()).toEqual(before)
        expect(policy.current().restrictions.mcp?.deny).toEqual(["a", "b"])
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("does not publish for a change that alters nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "managed", "managed-settings.json")
      yield* write(tmp.path, { "managed/managed-settings.json": { shell: "same" }, "project/.keep": "" })
      yield* Effect.gen(function* () {
        yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const seen = yield* Ref.make(0)
        yield* bus.subscribe(Event.Updated).pipe(
          Stream.runForEach(() => Ref.update(seen, (count) => count + 1)),
          Effect.forkScoped,
        )
        yield* Effect.sleep("10 millis")

        yield* watcher.emit({ type: "update", path: file })
        yield* Effect.sleep("500 millis")

        expect(yield* Ref.get(seen)).toBe(0)
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("does not watch a managed directory that does not exist", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, { "project/.keep": "" })
      yield* Effect.gen(function* () {
        yield* Config.Service
        const watcher = yield* Watcher.Test
        const subscriptions = yield* watcher.subscriptions()

        expect(subscriptions.filter((item) => item.path.startsWith(path.join(tmp.path, "managed")))).toEqual([])
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )
})

describe("ManagedSettings.read command lists", () => {
  // A command is one argument list: a later file replaces it, and never joins the argument lists of two files.
  const rows = [
    {
      name: "formatter.fmt.command",
      files: [
        { formatter: { fmt: { command: ["npx", "-y", "fmt-a", "$FILE"] } } },
        { formatter: { fmt: { command: ["npx", "-y", "fmt-b", "$FILE"] } } },
      ],
      pick: (info: Info) => field(info, "formatter", "fmt", "command"),
      expected: ["npx", "-y", "fmt-b", "$FILE"],
    },
    {
      name: "lsp.l.command",
      files: [
        { lsp: { l: { command: ["npx", "-y", "ls-a"], extensions: [".a"] } } },
        { lsp: { l: { command: ["npx", "-y", "ls-b"], extensions: [".b"] } } },
      ],
      pick: (info: Info) => field(info, "lsp", "l", "command"),
      expected: ["npx", "-y", "ls-b"],
    },
    {
      name: "mcp.servers.s.command",
      files: [
        { mcp: { servers: { s: { type: "local", command: ["node", "a.js"] } } } },
        { mcp: { servers: { s: { type: "local", command: ["node", "b.js"] } } } },
      ],
      pick: (info: Info) => field(info, "mcp", "servers", "s", "command"),
      expected: ["node", "b.js"],
    },
  ]

  rows.forEach((row) =>
    it.live(`${row.name} comes from one file`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, {
          "managed-settings.json": row.files[0],
          "managed-settings.d/10.json": row.files[1],
        })

        const snapshot = yield* read(tmp.path)

        expect(row.pick(snapshot.info)).toEqual(row.expected)
      }),
    ),
  )

  it.live("still concatenates lists of independent entries", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { instructions: ["a.md"], sandbox: { write: ["/a"] } },
        "managed-settings.d/10.json": { instructions: ["b.md"], sandbox: { write: ["/b"] } },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.info.instructions).toEqual(["a.md", "b.md"])
      expect(snapshot.info.sandbox?.write).toEqual(["/a", "/b"])
    }),
  )
})

describe("ManagedSettings.read mcp servers", () => {
  // A server is one definition, as across documents: a later file never inherits a header or a client secret that an
  // earlier file wrote for another host.
  const rows = [
    {
      name: "url with headers",
      first: { type: "remote", url: "https://a.example/mcp", headers: { Authorization: "Bearer A" } },
      second: { type: "remote", url: "https://b.example/mcp" },
      expected: { type: "remote", url: "https://b.example/mcp" },
    },
    {
      name: "oauth",
      first: { type: "remote", url: "https://a.example/mcp", oauth: { client_id: "a", client_secret: "secret-a" } },
      second: { type: "remote", url: "https://b.example/mcp", oauth: { client_id: "b" } },
      expected: { type: "remote", url: "https://b.example/mcp", oauth: { client_id: "b" } },
    },
    {
      name: "a local server without the env of the one before",
      first: { type: "local", command: ["node", "a.js"], environment: { TOKEN: "secret-a" } },
      second: { type: "local", command: ["node", "b.js"] },
      expected: { type: "local", command: ["node", "b.js"] },
    },
  ]

  rows.forEach((row) =>
    it.live(`${row.name} comes from one file`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, {
          "managed-settings.json": { mcp: { servers: { s: row.first, keep: { type: "local", command: ["k"] } } } },
          "managed-settings.d/10.json": { mcp: { servers: { s: row.second } } },
        })

        const snapshot = yield* read(tmp.path)

        expect(JSON.parse(JSON.stringify(field(snapshot.info, "mcp", "servers", "s")))).toEqual(row.expected)
        // Servers the later file does not name stay.
        expect(field(snapshot.info, "mcp", "servers", "keep", "command")).toEqual(["k"])
        expect(snapshot.diagnostics).toEqual([])
      }),
    ),
  )
})

describe("ManagedSettings.read records of whole definitions", () => {
  // Each entry is one definition across documents, so an entry never inherits a key of the one before it. Every row
  // fails under a key-by-key merge.
  const rows = [
    {
      name: "lsp env",
      key: "lsp",
      first: { "ls-a": { command: ["a"], env: { TOKEN: "secret-a" }, initialization: { endpoint: "https://a.example" } } },
      second: { "ls-a": { command: ["b"] } },
      expected: { command: ["b"] },
    },
    {
      name: "a disabled lsp server",
      key: "lsp",
      first: { "ls-a": { disabled: true } },
      second: { "ls-a": { command: ["b"] } },
      expected: { command: ["b"] },
    },
    {
      name: "formatter environment",
      key: "formatter",
      first: { fmt: { command: ["a"], environment: { TOKEN: "secret-a" } } },
      second: { fmt: { command: ["b"] } },
      expected: { command: ["b"] },
    },
    {
      name: "a disabled formatter",
      key: "formatter",
      first: { fmt: { disabled: true } },
      second: { fmt: { command: ["b"] } },
      expected: { command: ["b"] },
    },
    {
      name: "a reference branch",
      key: "references",
      first: { lib: { repository: "https://a.example/repo.git", branch: "secret-branch" } },
      second: { lib: { repository: "https://b.example/repo.git" } },
      expected: { repository: "https://b.example/repo.git" },
    },
    {
      name: "a command agent",
      key: "commands",
      first: { fix: { template: "a", agent: "build", description: "from a" } },
      second: { fix: { template: "b" } },
      expected: { template: "b" },
    },
  ]

  rows.forEach((row) =>
    it.live(`${row.name} comes from one file`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, {
          "managed-settings.json": { [row.key]: row.first },
          "managed-settings.d/10.json": { [row.key]: row.second },
        })

        const snapshot = yield* read(tmp.path)
        const name = Object.keys(row.second)[0]

        expect(JSON.parse(JSON.stringify(field(snapshot.info, row.key, name)))).toEqual(row.expected)
        expect(snapshot.diagnostics).toEqual([])
      }),
    ),
  )

  it.live("an agent that leaves out disabled comes back, and keeps the keys it did not change", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { agents: { build: { disabled: true, steps: 2 } } },
        "managed-settings.d/10.json": { agents: { build: { description: "back" } } },
      })

      const snapshot = yield* read(tmp.path)

      expect(field(snapshot.info, "agents", "build", "disabled")).toBeUndefined()
      expect(field(snapshot.info, "agents", "build", "steps")).toBe(2)
      expect(field(snapshot.info, "agents", "build", "description")).toBe("back")
    }),
  )

  it.live("an agent that sets disabled stays disabled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": { agents: { build: { steps: 2 } } },
        "managed-settings.d/10.json": { agents: { build: { disabled: true } } },
      })

      const snapshot = yield* read(tmp.path)

      expect(field(snapshot.info, "agents", "build", "disabled")).toBe(true)
      expect(field(snapshot.info, "agents", "build", "steps")).toBe(2)
    }),
  )
})

describe("ManagedSettings.read unknown keys at every depth", () => {
  const rows = [
    { name: "sandbox.enabeld", file: { sandbox: { enabeld: true, network: false } }, at: "$.sandbox.enabeld" },
    {
      name: "a server's disable",
      file: { mcp: { servers: { s: { type: "local", command: ["x"], disable: true } } } },
      at: "$.mcp.servers.s.disable",
    },
    {
      name: "an agent's permisions",
      file: { agents: { build: { permisions: [rule("deny", "rm *")] } } },
      at: "$.agents.build.permisions",
    },
    { name: "compaction.autto", file: { compaction: { autto: true } }, at: "$.compaction.autto" },
    {
      name: "a key in a list of rules",
      file: { permissions: [{ ...rule("deny", "rm *"), efect: "deny" }] },
      at: "$.permissions.0.efect",
    },
    {
      name: "a misspelled key of a local server, next to the skip",
      file: { mcp: { servers: { s: { type: "local", comand: ["x"] } } } },
      at: "$.mcp.servers.s.comand",
      also: "$.mcp.servers.s",
    },
    {
      name: "a nested key of a remote server",
      file: { mcp: { servers: { s: { type: "remote", url: "https://a.example", oauth: { client_secrett: "x" } } } } },
      at: "$.mcp.servers.s.oauth.client_secrett",
    },
  ]

  rows.forEach((row) =>
    it.live(`reports ${row.name}`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, { "managed-settings.json": row.file })

        const snapshot = yield* read(tmp.path)

        expect(snapshot.diagnostics).toContainEqual(
          expect.objectContaining({ path: row.at, kind: "unsupported", message: "ignored an unknown key" }),
        )
        // Only the row that the normalizer also skips has a second diagnostic; the others have exactly one.
        expect(snapshot.diagnostics).toHaveLength("also" in row ? 2 : 1)
      }),
    ),
  )

  it.live("adds no diagnostic for a document that uses the known keys at depth", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": {
          sandbox: { enabled: true, network: false, write: ["/a"] },
          mcp: {
            servers: {
              s: { type: "local", command: ["x"], disabled: true },
              r: { type: "remote", url: "https://a.example", headers: { A: "b" }, oauth: { client_id: "c" } },
            },
          },
          agents: { build: { permissions: [rule("deny", "rm *")], steps: 3 } },
          compaction: { auto: true, keep: { tokens: 10 } },
          permissions: [rule("deny", "rm *")],
        },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.diagnostics).toEqual([])
    }),
  )

  it.live("one malformed entry costs only itself", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": {
          agents: { bad: "not an object", also: null, good: { permisions: [], steps: 2 } },
          sandbox: "yes",
          permissions: [rule("deny", "rm *"), 7],
          shell: "kept",
        },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.info.shell).toBe("kept")
      expect(snapshot.info.permissions).toEqual([rule("deny", "rm *")])
      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({ path: "$.agents.good.permisions", kind: "unsupported" }),
      )
    }),
  )

  it.live("does not repeat a path the normalizer reported", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, { "managed-settings.json": { server: { port: 1 }, shell: "zsh" } })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.diagnostics.filter((item) => item.path === "$.server")).toHaveLength(1)
    }),
  )
})

describe("ManagedSettings.read unknown keys outside managed", () => {
  const rows = [
    { name: "a misspelled permissions", file: { permisions: [rule("deny", "rm *")], shell: "kept" }, at: "$.permisions" },
    {
      name: "a misspelled experimental.policies",
      file: { experimental: { policy: [{ action: "provider.use", resource: "x", effect: "deny" }] } },
      at: "$.experimental.policy",
    },
    { name: "an unknown top-level key", file: { shel: "zsh" }, at: "$.shel" },
  ]

  rows.forEach((row) =>
    it.live(`reports ${row.name}`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, { "managed-settings.json": row.file })

        const snapshot = yield* read(tmp.path)

        expect(snapshot.diagnostics).toEqual([
          expect.objectContaining({ path: row.at, kind: "unsupported", message: "ignored an unknown key" }),
        ])
      }),
    ),
  )

  it.live("adds no diagnostic for $schema, a migrated legacy key or a known experimental key", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.json": {
          $schema: "https://example.invalid/schema.json",
          autoshare: false,
          mcp: { legacy: { type: "local", command: ["x"] } },
          compaction: { preserve_recent_tokens: 10, reserved: 5 },
          disabled_providers: ["openai"],
          experimental: { policies: [], subagent_depth: 2, mcp_timeout: 5000 },
          shell: "zsh",
        },
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.diagnostics).toEqual([])
      expect(snapshot.info.shell).toBe("zsh")
    }),
  )
})

describe("ManagedSettings.read broken links", () => {
  const rows = [
    { name: "a drop-in", link: "managed-settings.d/10-link.json", sibling: { "managed-settings.d/20-ok.json": { shell: "ok" } } },
    { name: "the base file", link: "managed-settings.json", sibling: { "managed-settings.d/20-ok.json": { shell: "ok" } } },
    // Only where file names ignore case does a differently cased link name the base file.
    ...(process.platform === "win32" || process.platform === "darwin"
      ? [
          {
            name: "the base file in another case",
            link: "Managed-Settings.json",
            sibling: { "managed-settings.d/20-ok.json": { shell: "ok" } },
          },
        ]
      : []),
  ]

  rows.forEach((row) =>
    it.live(`reports ${row.name} that is a link to a missing file`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(tmp.path, row.sibling)
        const created = yield* Effect.promise(() =>
          fs
            .symlink(path.join(tmp.path, "missing.json"), path.join(tmp.path, row.link))
            .then(() => true)
            // Windows without Developer Mode cannot make links; the row runs on Linux and with Developer Mode.
            .catch(() => false),
        )
        if (!created) return

        const snapshot = yield* read(tmp.path)

        expect(snapshot.diagnostics).toContainEqual(
          expect.objectContaining({ source: path.join(tmp.path, row.link.toLowerCase()), path: "$", kind: "invalid" }),
        )
        expect(snapshot.info.shell).toBe("ok")
      }),
    ),
  )
})

describe("ManagedSettings paths in a drop-in", () => {
  it.live("resolve against the managed folder, not the drop-in folder", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "project/.keep": "",
        "managed/managed-settings.d/10.json": { shell: "managed" },
      })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        const document = entries.find((entry): entry is Document => entry.type === "document" && entry.scope === "managed")

        expect(document?.path).toBe(AbsolutePath.make(path.join(tmp.path, "managed", "managed-settings.json")))
      }).pipe(Effect.provide(layers(tmp.path)))
    }),
  )

  it.live("a relative plugin path in a drop-in resolves against the managed folder", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "project/.keep": "",
        "managed/managed-settings.d/10.json": { plugins: ["./planted"] },
      })
      yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        const operations = yield* source.operations()

        expect(operations.map((operation) => operation.target)).toContain(path.join(tmp.path, "managed", "planted"))
      }).pipe(Effect.scoped, Effect.provide(pluginLayers(tmp.path)))
    }),
  )

  it.live("a {file:} variable resolves against the file that holds it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(tmp.path, {
        "managed-settings.d/x.txt": "from-dropin-folder",
        "managed-settings.d/10.json": '{ "shell": "{file:./x.txt}" }',
      })

      const snapshot = yield* read(tmp.path)

      expect(snapshot.info.shell).toBe("from-dropin-folder")
    }),
  )
})

const fs_rm = (target: string) => Effect.promise(() => fs.rm(target, { recursive: true, force: true }))
