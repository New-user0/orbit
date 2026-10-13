import { describe, expect } from "bun:test"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Session } from "@orbit/core/session"
import { ShellSelect } from "@orbit/core/shell/select"
import { SessionMessage } from "@orbit/schema/session-message"
import { Effect, Exit, Layer, Schema } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(
  Layer.mergeAll(
    PluginTestLayer,
    Config.testLayer(),
    AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
  ),
)
const decode = Schema.decodeUnknownSync(Info)
const base = {
  sessionID: Session.ID.make("ses_hooks_guard"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_hooks_guard"),
  id: Tool.CallID.make("call_hooks_guard"),
}
const withTrust = (trusted: boolean) => Layer.mock(ProjectTrust.Service, { trusted: () => Effect.succeed(trusted) })

// The class: a hook that guards a call but cannot run because the folder is not trusted. A blocking event never reads
// "cannot run" as "no block". Each cell has a marker the hook writes into its working folder, and a trusted control.
describe("LifecycleHooksPlugin guards in an untrusted folder", () => {
  for (const scope of ["user", "managed", "project"] as const) {
    for (const trusted of [false, true]) {
      for (const outcome of [
        { name: "blocks", code: 2, blocked: true },
        { name: "allows", code: 0, blocked: false },
        { name: "errors", code: 1, blocked: false },
      ]) {
        it.live(`PreToolUse hook of ${scope} that ${outcome.name}, folder ${trusted ? "trusted" : "untrusted"}`, () =>
          Effect.gen(function* () {
            const registry = yield* PluginHooks.Service
            const config = yield* Config.Test
            const where = yield* Location.Service
            yield* config.setEntries([
              new Document({
                type: "document",
                scope,
                info: decode({
                  hooks: {
                    PreToolUse: [
                      {
                        matcher: "read",
                        hooks: [{ type: "command", command: `echo ran > marker.txt; exit ${outcome.code}` }],
                      },
                    ],
                  },
                }),
              }),
            ])
            yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
            const refused = (tool: string) =>
              registry
                .trigger("tool", "execute.before", { ...base, tool, input: {} })
                .pipe(Effect.exit, Effect.map(Exit.isFailure))

            // Untrusted, the call the guard applies to is refused whatever the hook would have said, and it never ran.
            expect(yield* refused("read")).toBe(trusted ? outcome.blocked : true)
            expect(yield* Effect.promise(() => Bun.file(path.join(where.directory, "marker.txt")).exists())).toBe(
              trusted,
            )
            // A call that no hook applies to goes through either way.
            expect(yield* refused("shell")).toBe(false)
          }).pipe(Effect.provide(withTrust(trusted))),
        )
      }
    }
  }

  for (const scope of ["user", "managed"] as const) {
    it.live(`${scope} hooks of an event that cannot stop a call wait without running`, () =>
      Effect.gen(function* () {
        const registry = yield* PluginHooks.Service
        const config = yield* Config.Test
        const where = yield* Location.Service
        yield* config.setEntries([
          new Document({
            type: "document",
            scope,
            info: decode({
              hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ran > marker.txt; echo added" }] }] },
            }),
          }),
        ])
        yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
        const prompt = {
          sessionID: base.sessionID,
          messageID: base.messageID,
          prompt: { text: "go" },
          delivery: "steer" as const,
        }
        yield* registry.trigger("session", "prompt", prompt)
        expect(prompt.prompt.text).toBe("go")
        expect(yield* Effect.promise(() => Bun.file(path.join(where.directory, "marker.txt")).exists())).toBe(false)
      }).pipe(Effect.provide(withTrust(false))),
    )
  }
})
