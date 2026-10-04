import { describe, expect } from "bun:test"
import { Document, Event, Info, type Entry } from "@orbit/schema/config"
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

const document = (...policies: ConfigPolicy.Info[]) =>
  new Document({ type: "document", info: decode({ experimental: { policies } }) })
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

const evaluate = Effect.fn(function* (
  action: string,
  resources: string[],
  effect: Permission.Effect = "allow",
  aliases?: string[],
) {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("permission", "evaluate", {
    sessionID: Session.ID.make("ses_policy"),
    action,
    resources,
    aliases,
    effect,
  })
  return { effect: event.effect, message: event.message }
})

// A webfetch evaluation: the host is the resource and the normalized URL is its alias.
const webfetch = (host: string, url: string) => evaluate("webfetch", [host], "allow", [url])

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

  it.effect("blocks a host resource through an organization URL statement", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set({ statements: [permission("deny", "webfetch:https://pastebin.com/*")] })
      yield* addPlugin([])

      expect(yield* webfetch("pastebin.com", "https://pastebin.com/raw/abc")).toEqual({
        effect: "deny",
        message: "Blocked by your organization's policy",
      })
      expect((yield* webfetch("pastebin.com", "https://pastebin.com/")).effect).toBe("deny")
      expect(yield* webfetch("example.com", "https://example.com/a")).toEqual({ effect: "allow", message: undefined })
      // A hook that ignores aliases decides on the host alone, which the URL statement does not match.
      expect((yield* evaluate("webfetch", ["pastebin.com"])).effect).toBe("allow")
    }),
  )

  it.effect("blocks a host resource through a host-form statement and a configured URL policy", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set({ statements: [permission("deny", "webfetch:pastebin.com")], organization: "Acme" })
      yield* addPlugin([document(permission("deny", "webfetch:https://gist.example.com/*"))])

      expect(yield* webfetch("pastebin.com", "https://pastebin.com/raw/abc")).toEqual({
        effect: "deny",
        message: "Blocked by Acme's policy",
      })
      expect((yield* evaluate("webfetch", ["pastebin.com"])).effect).toBe("deny")
      expect(yield* webfetch("gist.example.com", "https://gist.example.com/a")).toEqual({
        effect: "deny",
        message: "Blocked by configuration policy",
      })
      expect(yield* webfetch("example.com", "https://example.com/a")).toEqual({ effect: "allow", message: undefined })
    }),
  )

  it.effect("decides on the last policy matching the host or the URL", () =>
    Effect.gen(function* () {
      yield* addPlugin([
        document(
          permission("deny", "webfetch:*"),
          permission("allow", "webfetch:docs.example.com"),
          permission("deny", "webfetch:https://docs.example.com/private/*"),
        ),
      ])

      // The host allow lifts the broad deny; the later URL deny still outranks it for the URLs it matches.
      expect((yield* webfetch("docs.example.com", "https://docs.example.com/a")).effect).toBe("allow")
      expect((yield* webfetch("docs.example.com", "https://docs.example.com/private/key")).effect).toBe("deny")
      expect((yield* webfetch("other.example.com", "https://other.example.com/a")).effect).toBe("deny")
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
