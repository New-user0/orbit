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
// @ts-expect-error foundations-19 adds this module; remove the directive with the build.
import { SessionRetention } from "@orbit/core/session/retention"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { emptyCredentialNode, emptyManagedNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { it } from "../lib/effect"

// The setting as the spec gives it (S3); the cast stands in for the module's own type until the build adds it.
const setting = SessionRetention.setting as Effect.Effect<number | undefined, never, Config.Service>

// The person's file and the project's file, as raw text, and whether the project's folder is trusted.
const read = (input: { readonly user?: string; readonly project?: string; readonly trusted?: boolean }) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    yield* Effect.promise(async () => {
      await fs.mkdir(global, { recursive: true })
      await fs.mkdir(project, { recursive: true })
      if (input.user !== undefined) await fs.writeFile(path.join(global, "orbit.json"), input.user)
      if (input.project !== undefined) await fs.writeFile(path.join(project, "orbit.json"), input.project)
    })
    const directory = AbsolutePath.make(project)
    return yield* setting.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
          Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory })))),
          Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
          Credential.node.replace(emptyCredentialNode),
          WellKnown.node.replace(emptyWellknownNode),
          ManagedSettings.node.replace(emptyManagedNode),
          Watcher.node.replace(Watcher.testLayer),
          ...(input.trusted === false
            ? [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))]
            : []),
        ]),
      ),
    )
  })

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

  it.live("skips the pass when a document does not parse", () =>
    Effect.gen(function* () {
      expect(yield* read({ user: '{ "cleanup_period_days": 90,, ' })).toBeUndefined()
      expect(yield* read({ user: JSON.stringify({ cleanup_period_days: 90 }), project: "{ not json" })).toBeUndefined()
    }),
  )
})
