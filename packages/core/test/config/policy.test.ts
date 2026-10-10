import { describe, expect } from "bun:test"
import { Document, Event, Info, type Entry, type Scope } from "@orbit/schema/config"
import { ConfigPolicy } from "@orbit/schema/config/policy"
import { Permission } from "@orbit/schema/permission"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { Bus } from "@orbit/core/bus"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Plugin } from "@orbit/core/plugin"
import { PermissionWeb } from "@orbit/core/permission/web"
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

const evaluate = Effect.fn(function* (
  action: string,
  resources: string[],
  effect: Permission.Effect = "allow",
  aliases?: Record<string, string[]>,
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

// A webfetch evaluation as the tools ask it: the URL is the resource and its host an alias, and a write also asks
// about `METHOD url`, which has none.
const webfetch = (url: string, method = "GET") => {
  const web = PermissionWeb.request(url, method)
  return evaluate("webfetch", web.resources, "allow", web.aliases)
}

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

  // Authority runs project < local < flag < user < remote; organization statements follow all of them. Entries are listed in arbitrary order because
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
    // A managed document does not take part: its statements arrive through ManagedPolicy (see the test below).
    ["leaves a managed-scope document out of the ranking", [scoped("managed", deny), scoped("remote", allow)], true],
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

  it.effect("reads an old tool name in a policy as the renamed tool, and no other", () =>
    Effect.gen(function* () {
      yield* addPlugin([
        document(
          permission("deny", "shell:git push *"),
          permission("deny", "edit:*.env"),
          permission("deny", "WebFetch:https://blocked.example/*"),
        ),
      ])

      const denied = { effect: "deny", message: "Blocked by configuration policy" } as const
      expect(yield* evaluate("Bash", ["git push origin main"])).toEqual(denied)
      expect(yield* evaluate("Edit", ["config/.env"])).toEqual(denied)
      expect(yield* evaluate("webfetch", ["https://blocked.example/a"])).toEqual(denied)
      expect(yield* evaluate("WebFetch", ["https://blocked.example/a"])).toEqual(denied)
      // The spelling of one tool never reaches another.
      expect(yield* evaluate("Read", ["git push origin main"])).toEqual({ effect: "allow", message: undefined })
      expect(yield* evaluate("Bash", ["config/.env"])).toEqual({ effect: "allow", message: undefined })
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

  it.effect("blocks a URL through an organization URL statement", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set("connection", { statements: [permission("deny", "webfetch:https://pastebin.com/*")] })
      yield* addPlugin([])

      expect(yield* webfetch("https://pastebin.com/raw/abc")).toEqual({
        effect: "deny",
        message: "Blocked by your organization's policy",
      })
      expect((yield* webfetch("https://pastebin.com/")).effect).toBe("deny")
      expect(yield* webfetch("https://example.com/a")).toEqual({ effect: "allow", message: undefined })
    }),
  )

  it.effect("blocks a URL through a host-form statement and a configured URL policy", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set("connection", {
        statements: [permission("deny", "webfetch:pastebin.com")],
        organization: "Acme",
      })
      yield* addPlugin([document(permission("deny", "webfetch:https://gist.example.com/*"))])

      expect(yield* webfetch("https://pastebin.com/raw/abc")).toEqual({
        effect: "deny",
        message: "Blocked by Acme's policy",
      })
      // A hook that ignores aliases decides on the URL alone, which the host statement does not match.
      expect((yield* evaluate("webfetch", ["https://pastebin.com/raw/abc"])).effect).toBe("allow")
      expect(yield* webfetch("https://gist.example.com/a")).toEqual({
        effect: "deny",
        message: "Blocked by configuration policy",
      })
      expect(yield* webfetch("https://example.com/a")).toEqual({ effect: "allow", message: undefined })
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
      expect((yield* webfetch("https://docs.example.com/a")).effect).toBe("allow")
      expect((yield* webfetch("https://docs.example.com/private/key")).effect).toBe("deny")
      expect((yield* webfetch("https://other.example.com/a")).effect).toBe("deny")
      // The host is an alias of the URL only, so it never lifts the broad deny for the `POST url` resource.
      expect((yield* webfetch("https://docs.example.com/a", "POST")).effect).toBe("deny")
    }),
  )

  it.effect("blocks a write through a statement that matches the URL, its host or the method form", () =>
    Effect.gen(function* () {
      yield* addPlugin([
        document(
          permission("deny", "webfetch:https://urls.example.com/*"),
          permission("deny", "webfetch:hosts.example.com"),
          permission("deny", "webfetch:POST https://writes.example.com/*"),
        ),
      ])

      for (const url of ["https://urls.example.com/a", "https://hosts.example.com/a", "https://writes.example.com/a"])
        expect(yield* webfetch(url, "POST")).toEqual({ effect: "deny", message: "Blocked by configuration policy" })
      // The method form blocks only that method, and the other statements block reads as well.
      expect((yield* webfetch("https://writes.example.com/a")).effect).toBe("allow")
      expect((yield* webfetch("https://hosts.example.com/a")).effect).toBe("deny")
      expect((yield* webfetch("https://elsewhere.example.com/a", "POST")).effect).toBe("allow")
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
      yield* managed.set("connection", { statements: [provider("deny", "*"), provider("allow", "orbit")] })
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
      yield* managed.set("connection", { statements: [provider("allow", "openai")] })
      yield* addPlugin([scoped("remote", provider("deny", "openai")), scoped("managed", provider("deny", "openai"))])

      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )

  it.effect("lets an organization allow restore a provider denied by the user", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* managed.set("connection", { statements: [provider("allow", "openai")] })
      yield* addPlugin([document(provider("deny", "openai"))])

      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )

  it.effect("names the organization when its permission statement decides", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      yield* managed.set("connection", { statements: [permission("deny", "shell:sudo *")], organization: "Acme" })
      yield* addPlugin([document(permission("allow", "shell:*"))])

      expect(yield* evaluate("shell", ["sudo ls"])).toEqual({ effect: "deny", message: "Blocked by Acme's policy" })
      expect((yield* evaluate("shell", ["ls"])).effect).toBe("allow")

      yield* managed.set("connection", { statements: [permission("deny", "shell:sudo *")] })
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

      yield* managed.set("connection", { statements: [provider("deny", "openai")] })
      yield* catalog.reload()
      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()

      yield* managed.set("connection", { statements: [] })
      yield* catalog.reload()
      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()
    }),
  )

  it.effect("merges file and connection statements and keeps one source when the other is set", () =>
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      const restrictions = { disable_hooks: true }
      const rules = [{ action: "shell", resource: "rm *", effect: "deny" as const }]
      yield* managed.set("file", {
        statements: [provider("deny", "file-one")],
        rules,
        restrictions,
        organization: "FileOrg",
      })
      yield* managed.set("connection", { statements: [provider("deny", "connection-one")], organization: "ConsoleOrg" })

      expect(managed.current()).toEqual({
        statements: [provider("deny", "file-one"), provider("deny", "connection-one")],
        rules,
        restrictions,
        organization: "FileOrg",
      })

      yield* managed.set("connection", { statements: [] })
      expect(managed.current().statements).toEqual([provider("deny", "file-one")])
      expect(managed.current().rules).toEqual(rules)

      yield* managed.set("file", { statements: [] })
      expect(managed.current()).toEqual({ statements: [], rules: [], restrictions: {} })

      yield* managed.set("connection", { statements: [], organization: "ConsoleOrg" })
      expect(managed.current().organization).toBe("ConsoleOrg")
    }),
  )

  it.effect("ranks a managed document only through the organization statements", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const managed = yield* ManagedPolicy.Service
      yield* catalog.transform((catalog) => catalog.update(Provider.ID.openai, () => {}))
      yield* addPlugin([scoped("managed", provider("deny", "openai"))])
      // The document says deny, but its statements reach the ranking through ManagedPolicy, which holds none here.
      expect(yield* catalog.get(Provider.ID.openai)).toBeDefined()

      yield* managed.set("file", { statements: [provider("deny", "openai")] })
      yield* catalog.reload()
      expect(yield* catalog.get(Provider.ID.openai)).toBeUndefined()
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
