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
  readonly managed?: string
  readonly trusted?: boolean
}

const read = (input: Input) =>
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
    const served = input.remote === undefined ? undefined : remote(input.remote)
    return yield* setting.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
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
      ),
    )
  })

// A well-known source the person signed in to, which serves `config` as its remote document.
function remote(config: WellKnown.Config) {
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
          entries: () => Effect.succeed([entry]),
          snapshot: () => [entry],
          refresh: () => Effect.succeed(false),
          add: () => Effect.die("unused Wellknown.add"),
          remove: () => Effect.die("unused Wellknown.remove"),
          resolve: () => Effect.succeed([config]),
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
