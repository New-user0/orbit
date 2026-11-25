import { Effect, Schema, Stream } from "effect"
import { Document, Info } from "@orbit/schema/config"
import type { ConfigPolicy } from "@orbit/schema/config/policy"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { host } from "../plugin/host"

// Runs the real configuration policy plugin on the stack's own hooks and its own `PermissionPolicy`, so a statement
// reaches Permission as in a server: as an `experimental.policies` entry of the person's document, or as a statement of
// their organization.
export const installPolicy = Effect.fn(function* (from: "user" | "organization", statements: ConfigPolicy.Info[]) {
  const hooks = yield* PluginHooks.Service
  const managed = yield* ManagedPolicy.Service
  if (from === "organization") yield* managed.set("connection", { statements })
  const unused = () => Effect.die("unused")
  const context = host({
    event: { subscribe: () => Stream.empty },
    provider: { list: unused, get: unused, transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void },
    permission: { list: unused, get: unused, reply: unused, hook: (name, callback) => hooks.register("permission", name, callback) },
  })
  const document = new Document({
    type: "document",
    scope: "user",
    info: Schema.decodeUnknownSync(Info)({ experimental: { policies: from === "user" ? statements : [] } }),
  })
  yield* ConfigPolicyPlugin.Plugin.effect(context).pipe(Effect.provide(Config.testLayer([document])))
})
