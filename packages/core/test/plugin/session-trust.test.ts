import { expect } from "bun:test"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { pluginTestNodes, pluginTestReplacements } from "./fixture"

// The real ProjectTrust over a store that trusts no folder by itself, instead of the trusted mock of PluginTestLayer.
// This host has no session Instance, so a session's folder is asked through its Location's own services.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([pluginTestNodes, WorkspaceTrust.node]), [
    ...pluginTestReplacements,
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
  ]),
)

it.live("a plugin's session doors refuse a folder that is not trusted, and work once it is (class 3, class 12)", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const trust = yield* WorkspaceTrust.Service
    const context = yield* PluginHost.make(plugins)
    const directory = AbsolutePath.make((yield* tmpdirScoped("orbit-plugin-session-trust-")).path)
    // Made through core, which no route stands in front of, so the session exists in a folder nothing trusts.
    const session = yield* sessions.create({ title: "Elsewhere", location: Location.Ref.make({ directory }) })
    const refused = { _tag: "WorkspaceTrust.UntrustedError", directory }

    expect(yield* context.session.create({ location: { directory } }).pipe(Effect.flip)).toMatchObject(refused)
    expect(
      yield* context.session.prompt({ sessionID: session.id, text: "hi", resume: false }).pipe(Effect.flip),
    ).toMatchObject(refused)

    // The trusted control: the same calls go through once the folder is trusted.
    yield* trust.grant(directory, { persist: false, via: "test" })
    expect(yield* context.session.create({ location: { directory } })).toMatchObject({ location: { directory } })
    expect(yield* context.session.prompt({ sessionID: session.id, text: "hi", resume: false })).toMatchObject({
      sessionID: session.id,
    })
  }),
)
