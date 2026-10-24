// foundations-19: the period the retention pass keeps sessions for, as `SessionRetention.setting` reads it from the
// config of the folder the server runs in. The reference reads its merged settings, so every scope may set it (a
// trusted project's value outranks the person's own); after trust-first an untrusted project's file is not read at all,
// so it can neither set the period nor stop the pass (classes 1 and 8). The reference skips the pass when the settings
// have errors and a file names the period, so a typo never falls back to the 30-day default (class 7). Orbit also skips it
// when a file does not parse: the period it held cannot be known (spec C3).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { AbsolutePath } from "@orbit/core/schema"
import { Integration } from "@orbit/schema/integration"
import { SessionRetention } from "@orbit/core/session/retention"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { emptyCredentialNode, emptyManagedNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { it } from "../lib/effect"

// The setting as the spec gives it (S3); the cast stands in for the module's own type until the build adds it.
const setting = SessionRetention.setting as Effect.Effect<number | undefined, never, Config.Service>

// The documents of each scope Config reads, as raw text (the remote one as the object a well-known source serves), and
// whether the project's folder is trusted.
type Input = {
  readonly user?: string
  readonly home?: string
  readonly project?: string
  readonly local?: string
  readonly file?: string
  readonly content?: string
  readonly remote?: WellKnown.Config
  // A well-known source that cannot be loaded: its list of entries, or the remote document of its one entry, fails.
  readonly offline?: "entries" | "resolve"
  readonly managed?: string
  readonly trusted?: boolean
}

const read = (input: Input) =>
  configured(input).pipe(Effect.flatMap((built) => setting.pipe(Effect.provide(built.layer))))

// The files of `input` on disk and a Config layer that reads them; the watcher is a test one, so only a reload rereads.
const configured = (input: Input) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    const global = path.join(root, "global")
    const home = path.join(global, "home")
    const project = path.join(root, "project")
    const managed = path.join(root, "managed")
    const flag = path.join(root, "flag.json")
    yield* Effect.promise(async () => {
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(project, { recursive: true })
      await fs.mkdir(managed, { recursive: true })
      if (input.user !== undefined) await fs.writeFile(path.join(global, "orbit.json"), input.user)
      if (input.home !== undefined) await fs.writeFile(path.join(home, "orbit.json"), input.home)
      if (input.project !== undefined) await fs.writeFile(path.join(project, "orbit.json"), input.project)
      if (input.local !== undefined) await fs.writeFile(path.join(project, "orbit.local.json"), input.local)
      if (input.file !== undefined) await fs.writeFile(flag, input.file)
      if (input.managed !== undefined) await fs.writeFile(path.join(managed, "managed-settings.json"), input.managed)
    })
    const directory = AbsolutePath.make(project)
    const served =
      input.remote === undefined && input.offline === undefined ? undefined : remote(input.remote ?? {}, input.offline)
    return {
      user: path.join(global, "orbit.json"),
      files: {
        user: path.join(global, "orbit.json"),
        home: path.join(home, "orbit.json"),
        project: path.join(project, "orbit.json"),
        local: path.join(project, "orbit.local.json"),
        file: flag,
      },
      layer: AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
        Config.node.replace(
          Config.configured({ file: input.file === undefined ? undefined : flag, content: input.content }),
        ),
        Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory })))),
        Global.node.replace(Global.layerWith({ config: global, home })),
        Credential.node.replace(served?.credential ?? emptyCredentialNode),
        WellKnown.node.replace(served?.wellknown ?? emptyWellknownNode),
        ManagedSettings.node.replace(
          input.managed === undefined ? emptyManagedNode : ManagedSettings.configured({ directory: managed }),
        ),
        Watcher.node.replace(Watcher.testLayer),
        ...(input.trusted === false
          ? [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))]
          : []),
      ]),
    }
  })

// A well-known source the person signed in to, which serves `config` as its remote document, or fails where `offline`
// says, as one does without a network.
function remote(config: WellKnown.Config, offline?: Input["offline"]) {
  const integrationID = Integration.ID.make("https://example.com")
  const entry: WellKnown.Entry = {
    origin: "https://example.com",
    integrationID,
    manifest: { auth: { command: ["login"], env: "TOKEN" } },
  }
  return {
    credential: makeGlobalNode({
      service: Credential.Service,
      layer: Layer.succeed(
        Credential.Service,
        Credential.Service.of({
          all: () => Effect.die("unused Credential.all"),
          list: () =>
            Effect.succeed([
              new Credential.Info({
                id: Credential.ID.create(),
                integrationID,
                label: "default",
                value: Credential.Key.make({ type: "key", key: "secret" }),
              }),
            ]),
          get: () => Effect.die("unused Credential.get"),
          create: () => Effect.die("unused Credential.create"),
          activate: () => Effect.die("unused Credential.activate"),
          update: () => Effect.die("unused Credential.update"),
          remove: () => Effect.die("unused Credential.remove"),
        }),
      ),
      deps: [],
    }),
    wellknown: makeGlobalNode({
      service: WellKnown.Service,
      layer: Layer.succeed(
        WellKnown.Service,
        WellKnown.Service.of({
          entries: () => (offline === "entries" ? Effect.fail(new Error("offline")) : Effect.succeed([entry])),
          snapshot: () => [entry],
          refresh: () => Effect.succeed(false),
          add: () => Effect.die("unused Wellknown.add"),
          remove: () => Effect.die("unused Wellknown.remove"),
          resolve: () => (offline === "resolve" ? Effect.fail(new Error("offline")) : Effect.succeed([config])),
        }),
      ),
      deps: [],
    }),
  }
}

describe("SessionRetention.setting", () => {
  it.live("reads the period from the user file, 30 when it is not set, and 0 as 0", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 9 }) })).toBe(9)
      expect(yield* read({ user: "{}" })).toBe(30)
      expect(yield* read({})).toBe(30)
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 0 }) })).toBe(0)
    }),
  )

  it.live("a trusted project's value outranks the user's", () =>
    Effect.gen(function* () {
      expect(
        yield* read({
          user: JSON.stringify({ cleanup_period_days: 9 }),
          project: JSON.stringify({ cleanup_period_days: 3 }),
        }),
      ).toBe(3)
    }),
  )

  // Control in the same test: the trusted folder's value applies.
  it.live("an untrusted project's value is not read", () =>
    Effect.gen(function* () {
      const user = JSON.stringify({ cleanup_period_days: 9 })
      expect(yield* read({ user, project: JSON.stringify({ cleanup_period_days: 1 }), trusted: false })).toBe(9)
      // A broken file there is not read either, so it does not stop the pass.
      expect(yield* read({ user, project: "{ not json", trusted: false })).toBe(9)
      expect(yield* read({ user, project: JSON.stringify({ cleanup_period_days: 1 }), trusted: true })).toBe(1)
    }),
  )

  for (const [name, value] of [
    ["negative", -1],
    ["text", "7"],
    ["a fraction", 1.5],
  ] as const)
    it.live(`skips the pass when the period is ${name}`, () =>
      Effect.gen(function* () {
        expect(yield* read({ user: JSON.stringify({ cleanup_period_days: value }) })).toBeUndefined()
      }),
    )

  it.live("skips the pass when the document that sets the period is rejected for another key", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 9, snapshots: "yes" }) })).toBeUndefined()
    }),
  )

  it.live("skips the pass when another document is rejected and the period is set", () =>
    Effect.gen(function* () {
      expect(
        yield* read({
          user: JSON.stringify({ cleanup_period_days: 9 }),
          project: JSON.stringify({ snapshots: "yes" }),
        }),
      ).toBeUndefined()
    }),
  )

  it.live("keeps the default when a rejected document does not name the period", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: JSON.stringify({ snapshots: "yes" }) })).toBe(30)
    }),
  )

  // A document whose root is not an object has no keys to look the period up in, so it counts as one that did not parse.
  it.live("skips the pass when a document is not an object", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: "[]" })).toBeUndefined()
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 9 }), project: '"text"' })).toBeUndefined()
    }),
  )

  it.live("skips the pass when a document does not parse", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: '{ "cleanup_period_days": 90,, ' })).toBeUndefined()
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 90 }), project: "{ not json" })).toBeUndefined()
    }),
  )
})

// The server lives for days and reads its files again when they change. A reload that breaks the period must skip the
// pass as a first load does, not keep the verdict of the clean load before it and fall back to the default (class 7).
// The fixed file after each break is the control: the reload then gives its value.
describe("SessionRetention.setting: after a reload", () => {
  it.live("skips the pass once a reload breaks the period and reads it again once the file is fixed", () =>
    Effect.gen(function* () {
      const built = yield* configured({ user: JSON.stringify({ cleanup_period_days: 365 }) })
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const rewrite = (text: string) =>
          Effect.promise(() => fs.writeFile(built.user, text)).pipe(Effect.andThen(config.reload!()))
        expect(yield* setting).toBe(365)
        yield* rewrite(JSON.stringify({ cleanup_period_days: "365" }))
        expect(yield* setting).toBeUndefined()
        yield* rewrite(JSON.stringify({ cleanup_period_days: 120 }))
        expect(yield* setting).toBe(120)
        yield* rewrite('{ "cleanup_period_days": 120,, ')
        expect(yield* setting).toBeUndefined()
        yield* rewrite(JSON.stringify({ cleanup_period_days: 60 }))
        expect(yield* setting).toBe(60)
      }).pipe(Effect.provide(built.layer))
    }),
  )
})

// Class 7 over every document of the load: a scope's rejected document stops the pass as the user's does. `beside`
// adds the user's own valid period of 90 (the scope's document replaces it in the user scope). A remote document comes
// as an object, so it cannot fail to parse. Each row's control is a valid document in the same scope.
describe("SessionRetention.setting: every scope", () => {
  const period = (value: unknown) => JSON.stringify({ cleanup_period_days: value })
  const scopes = [
    ["user", "user"],
    ["home", "home"],
    ["project", "project"],
    ["local", "local"],
    ["flag file", "file"],
    ["ORBIT_CONFIG_CONTENT", "content"],
    ["remote", "remote"],
    ["managed", "managed"],
  ] as const
  for (const [name, at] of scopes) {
    const put = (text: string, beside: boolean): Input => ({
      ...(beside ? { user: period(90) } : {}),
      [at]: at === "remote" ? JSON.parse(text) : text,
    })

    it.live(`${name}: a period that is text or negative skips the pass`, () =>
      Effect.gen(function* () {
        expect(yield* read(put(period(7), false))).toBe(7)
        expect(yield* read(put(period("7"), false))).toBeUndefined()
        expect(yield* read(put(period(-1), true))).toBeUndefined()
      }),
    )

    it.live(`${name}: a rejected key that is not the period keeps the default only while no period is set`, () =>
      Effect.gen(function* () {
        expect(yield* read(put(JSON.stringify({ snapshots: "yes" }), false))).toBe(30)
        expect(yield* read(put(JSON.stringify({ snapshots: "yes" }), true))).toBe(name === "user" ? 30 : undefined)
        expect(yield* read(put(JSON.stringify({ snapshots: true }), true))).toBe(name === "user" ? 30 : 90)
      }),
    )

    // A value set twice of which one was kept is a conflict, not an error: the document is taken as written, so it
    // stops nothing, as in the reference. The control without a second value gives the same period.
    it.live(`${name}: a conflict does not skip the pass`, () =>
      Effect.gen(function* () {
        const conflict = { system_prompt: "a", system_prompt_file: "b.md" }
        expect(yield* read(put(JSON.stringify(conflict), true))).toBe(name === "user" ? 30 : 90)
        expect(yield* read(put(JSON.stringify({ ...conflict, cleanup_period_days: 9 }), false))).toBe(9)
        expect(yield* read(put(JSON.stringify({ system_prompt: "a" }), true))).toBe(name === "user" ? 30 : 90)
      }),
    )

    if (at !== "remote")
      it.live(`${name}: a document that does not parse skips the pass`, () =>
        Effect.gen(function* () {
          // With no period set anywhere: the broken document may have held one.
          expect(yield* read(put("{ not json", false))).toBeUndefined()
          expect(yield* read(put("{ not json", true))).toBeUndefined()
          expect(yield* read(put("{}", true))).toBe(name === "user" ? 30 : 90)
        }),
      )
  }
})

// A source whose content could not be obtained may hold any period, so the pass is skipped as for one that does not
// parse (class 7, error and timeout). The reference falls back on its cached copy of the remote settings; Orbit keeps
// none, so an offline load must not run a 30-day pass against an organization's longer one. The control is the same
// source loaded.
describe("SessionRetention.setting: a source that cannot be loaded", () => {
  it.live("skips the pass when the remote document cannot be fetched", () =>
    Effect.gen(function* () {
      expect(yield* read({ remote: { cleanup_period_days: 365 } })).toBe(365)
      expect(yield* read({ remote: { cleanup_period_days: 365 }, offline: "resolve" })).toBeUndefined()
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 90 }), offline: "resolve" })).toBeUndefined()
    }),
  )

  it.live("skips the pass when the well-known sources cannot be listed", () =>
    Effect.gen(function* () {
      expect(yield* read({ remote: {} })).toBe(30)
      expect(yield* read({ offline: "entries" })).toBeUndefined()
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 90 }), offline: "entries" })).toBeUndefined()
    }),
  )

  // Root reads a file whatever its mode, and Windows reports a denied read as another error, which fails the load.
  describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file that cannot be read", () => {
    for (const at of ["user", "home", "project", "local", "file"] as const)
      it.live(`${at}: skips the pass, and the readable file is the control`, () =>
        Effect.gen(function* () {
          const input = { [at]: JSON.stringify({ cleanup_period_days: 365 }) }
          expect(yield* read(input)).toBe(365)
          const built = yield* configured(input)
          yield* Effect.promise(() => fs.chmod(built.files[at], 0o000))
          expect(yield* setting.pipe(Effect.provide(built.layer))).toBeUndefined()
        }),
      )
  })
})
