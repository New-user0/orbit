import { describe, expect } from "bun:test"
import { Document, Event, Info, type Entry, type Scope } from "@orbit/schema/config"
import { ConfigPolicy } from "@orbit/schema/config/policy"
import { Permission } from "@orbit/schema/permission"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { Bus } from "@orbit/core/bus"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Provider } from "@orbit/core/provider"
import { Session } from "@orbit/core/session"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)

const scoped = (scope: Scope | undefined, ...policies: ConfigPolicy.Info[]) =>
  new Document({ type: "document", scope, info: decode({ experimental: { policies } }) })
const document = (...policies: ConfigPolicy.Info[]) => scoped(undefined, ...policies)
const provider = (effect: ConfigPolicy.Effect, resource: string): ConfigPolicy.Info => ({
  action: "provider.use",
  resource,
  effect,
})
const permission = (effect: ConfigPolicy.Effect, resource: string): ConfigPolicy.Info => ({
  action: "permission",
  resource,
  effect,
})

const addPlugin = Effect.fn(function* (entries: Entry[]) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigPolicyPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
})

const evaluate = Effect.fn(function* (action: string, resources: string[], effect: Permission.Effect = "allow") {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("permission", "evaluate", {
    sessionID: Session.ID.make("ses_policy"),
    action,
    resources,
    effect,
  })
  return { effect: event.effect, message: event.message }
})

describe("ConfigPolicyPlugin.Plugin", () => {
  it.effect("filters plugin-provided providers with ordered wildcard policies", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.openai, () => {})
        catalog.update(Provider.ID.anthropic, () => {})
        catalog.update(Provider.ID.make("company-internal"), () => {})
      })
      yield* addPlugin([
        document(provider("deny", "*"), provider("allow", "anthropic"), provider("allow", "company-*")),
      ])

      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()
      expect(yield* catalog.get(Provider.ID.anthropic)).toBeDefined()
      expect(yield* catalog.get(Provider.ID.make("company-internal"))).toBeDefined()
    }),
  )

  it.effect("prevents project policy from overriding user-global policy", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* addPlugin([document(provider("deny", "openai")), document(provider("allow", "openai"))])

      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()
    }),
  )

  // Authority runs project < local < flag < user < remote < managed. Entries are listed in arbitrary order because
  // the scope decides the winner, not the position.
  const deny = provider("deny", "openai")
  const allow = provider("allow", "openai")
  for (const [name, entries, available] of [
    [
      "lets user policy outrank project and local policy",
      [scoped("user", deny), scoped("project", allow), scoped("local", allow)],
      false,
    ],
    [
      "lets user policy outrank project and local policy listed before it",
      [scoped("local", allow), scoped("project", allow), scoped("user", deny)],
      false,
    ],
    ["lets remote policy outrank user policy", [scoped("remote", allow), scoped("user", deny)], true],
    ["lets remote policy outrank user policy listed before it", [scoped("user", deny), scoped("remote", allow)], true],
    ["lets flag policy outrank project policy", [scoped("project", deny), scoped("flag", allow)], true],
    ["lets flag policy outrank local policy", [scoped("local", deny), scoped("flag", allow)], true],
    ["lets user policy outrank flag policy", [scoped("user", deny), scoped("flag", allow)], false],
    [
      "lets a managed-scope document outrank every other scope",
      [scoped("managed", deny), scoped("remote", allow)],
      false,
    ],
    ["counts a document without a scope as user policy", [document(deny), scoped("project", allow)], false],
    ["ranks a document without a scope below remote policy", [document(deny), scoped("remote", allow)], true],
    [
      "keeps the earlier of two documents in one scope in charge",
      [scoped("project", deny), scoped("project", allow)],
      false,
    ],
  ] as const) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
        yield* addPlugin([...entries])

        expect((yield* catalog.get(Provider.ID.openai)) !== undefined).toBe(available)
      }),
    )
  }

  it.effect("ranks permission statements by scope too", () =>
    Effect.gen(function* () {
      yield* addPlugin([
        scoped("project", permission("allow", "shell:*")),
        scoped("user", permission("deny", "shell:rm *")),
        scoped("local", permission("allow", "shell:*")),
      ])

      // A later allow lifts an earlier broad deny, so only the scope ranking keeps the user's deny in force.
      expect((yield* evaluate("shell", ["rm -rf /"])).effect).toBe("deny")
      expect((yield* evaluate("shell", ["ls"])).effect).toBe("allow")
    }),
  )

  it.live("reloads changed policies", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const bus = yield* Bus.Service
      const test = yield* Config.Test
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* ConfigPolicyPlugin.Plugin.effect(host)
      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()

      yield* test.setEntries([document(provider("allow", "openai"))])
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(catalog.get(Provider.ID.openai).pipe(Effect.map((provider) => provider !== undefined)))
    }).pipe(Effect.provide(Config.testLayer([document(provider("deny", "openai"))]))),
  )

  it.effect("denies permissions matched as action:resource", () =>
    Effect.gen(function* () {
      yield* addPlugin([document(permission("deny", "shell:git push *"))])

      expect(yield* evaluate("shell", ["git push"])).toEqual({
        effect: "deny",
        message: "Blocked by configuration policy",
      })
      expect(yield* evaluate("shell", ["git push origin main"])).toEqual({
        effect: "deny",
        message: "Blocked by configuration policy",
      })
      // Compound commands check several resources; any denied resource denies the operation.
      expect((yield* evaluate("shell", ["git status", "git push"])).effect).toBe("deny")
      expect(yield* evaluate("shell", ["git status"])).toEqual({ effect: "allow", message: undefined })
      expect(yield* evaluate("edit", ["git push"])).toEqual({ effect: "allow", message: undefined })
    }),
  )

  it.effect("turns an ask into a deny but never grants", () =>
    Effect.gen(function* () {
      yield* addPlugin([document(permission("deny", "webfetch:*"), permission("allow", "shell:*"))])

      expect((yield* evaluate("webfetch", ["https://example.com"], "ask")).effect).toBe("deny")
      expect((yield* evaluate("shell", ["ls"], "ask")).effect).toBe("ask")
    }),
  )

  it.effect("lets a later allow lift an earlier broad deny", () =>
    Effect.gen(function* () {
      yield* addPlugin([document(permission("deny", "shell:*"), permission("allow", "shell:git status *"))])

      expect((yield* evaluate("shell", ["git status --short"])).effect).toBe("allow")
      expect((yield* evaluate("shell", ["rm -rf /"])).effect).toBe("deny")
    }),
  )

  it.effect("denies every permission with a bare wildcard", () =>
    Effect.gen(function* () {
      yield* addPlugin([document(permission("deny", "*"))])

      expect((yield* evaluate("question", ["*"])).effect).toBe("deny")
      expect((yield* evaluate("read", ["/tmp/notes.txt"])).effect).toBe("deny")
      expect((yield* evaluate("github_delete_repository", ["*"])).effect).toBe("deny")
    }),
  )

  it.effect("evaluates organization provider statements after every authored document", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.openai, () => {})
        catalog.update(Provider.ID.anthropic, () => {})
        catalog.update(Provider.ID.orbit, () => {})
      })
      yield* managed.set({ statements: [provider("deny", "*"), provider("allow", "orbit")] })
      yield* addPlugin([document(provider("allow", "anthropic"))])

      expect(yield* catalog.get(Provider.ID.anthropic)).toBeUndefined()
      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()
      expect(yield* catalog.get(Provider.ID.orbit)).toBeDefined()
    }),
  )

  it.effect("evaluates organization statements after documents from every scope", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* managed.set({ statements: [provider("allow", "openai")] })
      yield* addPlugin([scoped("remote", provider("deny", "openai")), scoped("managed", provider("deny", "openai"))])

      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )

  it.effect("lets an organization allow restore a provider denied by the user", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* managed.set({ statements: [provider("allow", "openai")] })
      yield* addPlugin([document(provider("deny", "openai"))])

      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )

  it.effect("names the organization when its permission statement decides", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set({ statements: [permission("deny", "shell:sudo *")], organization: "Acme" })
      yield* addPlugin([document(permission("allow", "shell:*"))])

      expect(yield* evaluate("shell", ["sudo ls"])).toEqual({ effect: "deny", message: "Blocked by Acme's policy" })
      expect((yield* evaluate("shell", ["ls"])).effect).toBe("allow")

      yield* managed.set({ statements: [permission("deny", "shell:sudo *")] })
      expect(yield* evaluate("shell", ["sudo ls"])).toEqual({
        effect: "deny",
        message: "Blocked by your organization's policy",
      })
    }),
  )

  it.effect("rebuilds the catalog from replaced organization statements", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* addPlugin([])
      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()

      yield* managed.set({ statements: [provider("deny", "openai")] })
      yield* catalog.reload()
      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()

      yield* managed.set({ statements: [] })
      yield* catalog.reload()
      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )
})

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for policy reload")
})
