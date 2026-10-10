import { describe, expect, test } from "bun:test"
import path from "path"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { Global } from "@orbit/util/global"
import { Agent } from "@orbit/core/agent"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { PermissionTable } from "@orbit/core/permission/sql"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { ShellParse } from "@orbit/core/shell/parse"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
      Global.node,
    ]),
    [Location.node.replace(current)],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  it.effect("closes a prompt for clients when the call waiting on it is interrupted", () =>
    Effect.gen(function* () {
      yield* setup()
      const bus = yield* Bus.Service
      const replies: Array<unknown> = []
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.sync(() => replies.push(event.data)) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const waiting = yield* waitForRequest()

      yield* Fiber.interrupt(waiting.fiber)

      expect(replies).toEqual([
        { sessionID: waiting.request.sessionID, requestID: waiting.request.id, reply: "reject" },
      ])
      expect(yield* waiting.service.list()).toEqual([])
    }),
  )

  it.effect("publishes no second reply for a prompt that was already answered", () =>
    Effect.gen(function* () {
      yield* setup()
      const bus = yield* Bus.Service
      const replies: Array<unknown> = []
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.sync(() => replies.push(event.data)) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const waiting = yield* waitForRequest()

      yield* waiting.service.reply({ requestID: waiting.request.id, reply: "once" })
      yield* Fiber.join(waiting.fiber)

      expect(replies).toHaveLength(1)
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  test("matches Windows rule resources against slash-normalized file access resources", () => {
    const rules: Permission.Ruleset = [
      { action: "external_directory", resource: "C:\\Users\\x\\proj\\*", effect: "allow" },
    ]
    expect(Permission.evaluate("external_directory", "C:/Users/x/proj/src/*", rules).effect).toBe("allow")
    expect(Permission.evaluate("external_directory", "C:/Users/x/other/*", rules).effect).toBe("ask")
  })

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("merges session rules after agent rules and before saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const service = yield* Permission.Service
      const setSession = (permission: Permission.Ruleset) =>
        db
          .update(SessionTable)
          .set({ permission })
          .where(eq(SessionTable.id, Session.ID.make("ses_test")))
          .run()
          .pipe(Effect.orDie)

      yield* setSession([{ action: "edit", resource: "/original/**", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["/original/src/index.ts"] }))).toMatchObject({
        effect: "deny",
      })

      yield* setRules([])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
      yield* setSession([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
      yield* setSession([{ action: "bash", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("applies rules and saved approvals written with old tool names to the renamed tools", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "edit", resource: "*.env", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service
      let count = 0
      const ask = (input: Partial<Permission.AssertInput>) =>
        service.ask(assertion({ ...input, id: Permission.ID.create(`per_names_${count++}`) }))
      const blocked = yield* service
        .assert(assertion({ action: "Bash", resources: ["rm -rf build"] }))
        .pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect((yield* ask({ action: "Edit", resources: ["a.env"] })).effect).toBe("ask")
      expect((yield* ask({ action: "Read", resources: ["a.ts"] })).effect).toBe("allow")
      // An allow for one tool does not reach another.
      expect((yield* ask({ action: "Bash", resources: ["ls"] })).effect).toBe("ask")

      // A saved approval from before the rename allows the renamed tool, and a configured deny still wins.
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["ls"] })
      expect((yield* ask({ action: "Bash", resources: ["ls"] })).effect).toBe("allow")
      expect((yield* ask({ action: "Glob", resources: ["ls"] })).effect).toBe("ask")
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toMatchObject([
        { id, projectID: Project.ID.global, action: "read", resource: "src/*" },
      ])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  for (const guard of ["configured deny", "missing Session"] as const) {
    it.effect(`skips pending auto-approval after always for ${guard}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setup([], Session.ID.make("ses_other"))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("reviewer"), (agent) => {
            agent.permissions = []
          }),
        )
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
          agent: Agent.ID.make("reviewer"),
        })
        if (guard === "configured deny") {
          yield* agents.transform((editor) =>
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
            }),
          )
        }
        if (guard === "missing Session") {
          const { db } = yield* Database.Service
          yield* db.delete(SessionTable).where(eq(SessionTable.id, other.request.sessionID)).run().pipe(Effect.orDie)
        }
        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        expect(yield* selected.service.list()).toEqual([other.request])
        expect(other.fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(other.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
})

describe("Permission resource aliases", () => {
  // A request whose resource is a host and whose alias is the normalized URL that rules may also be written against.
  // An "always" reply saves the host only.
  const webfetch = (input: Partial<Permission.AssertInput> = {}) =>
    assertion({
      action: "webfetch",
      resources: ["docs.example.com"],
      aliases: { "docs.example.com": ["https://docs.example.com/a"] },
      save: ["docs.example.com"],
      ...input,
    })
  const pastebin = (input: Partial<Permission.AssertInput> = {}) =>
    webfetch({
      resources: ["pastebin.com"],
      aliases: { "pastebin.com": ["https://pastebin.com/raw/abc"] },
      save: ["pastebin.com"],
      ...input,
    })
  const denyPastebinUrls: Permission.Ruleset = [
    { action: "webfetch", resource: "https://pastebin.com/*", effect: "deny" },
  ]

  test("picks the last rule matching the resource or any alias", () => {
    const denyAll: Permission.Rule = { action: "webfetch", resource: "*", effect: "deny" }
    const allowHost: Permission.Rule = { action: "webfetch", resource: "docs.example.com", effect: "allow" }
    const denyPrivate: Permission.Rule = {
      action: "webfetch",
      resource: "https://docs.example.com/private/*",
      effect: "deny",
    }
    const docs = (rules: Permission.Ruleset, path: string) =>
      Permission.evaluate("webfetch", "docs.example.com", rules, [`https://docs.example.com/${path}`]).effect

    expect(docs([denyAll, allowHost], "a")).toBe("allow")
    // A deny that matches an alias outranks an earlier host allow, but only for the URLs it matches.
    expect(docs([denyAll, allowHost, denyPrivate], "private/key")).toBe("deny")
    expect(docs([denyAll, allowHost, denyPrivate], "a")).toBe("allow")
    // Rule order still decides: an allow before a catch-all deny loses.
    expect(docs([allowHost, denyAll], "a")).toBe("deny")
    // Without aliases only the resource is matched.
    expect(Permission.evaluate("webfetch", "docs.example.com", [allowHost, denyPrivate]).effect).toBe("allow")
    expect(
      Permission.evaluate("webfetch", "other.example.com", [denyAll, allowHost], ["https://other.example.com/"]).effect,
    ).toBe("deny")
  })

  it.effect("lets a host allow cover every URL on that host", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "webfetch", resource: "docs.example.com", effect: "allow" }])
      const service = yield* Permission.Service

      expect(yield* service.ask(webfetch())).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(webfetch({ aliases: { "docs.example.com": ["https://docs.example.com/b?page=2"] } })),
      ).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(
          webfetch({
            resources: ["other.example.com"],
            aliases: { "other.example.com": ["https://other.example.com/a"] },
          }),
        ),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("blocks a session URL deny even though the resource is the host", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ permission: denyPastebinUrls })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const service = yield* Permission.Service

      // Matched against the host alone, nothing in the deny applies.
      expect(yield* service.ask(assertion({ action: "webfetch", resources: ["pastebin.com"] }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(pastebin())).toMatchObject({ effect: "deny" })
      expect(yield* service.assert(pastebin()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.ask(webfetch())).toMatchObject({ effect: "allow" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("keeps a path-scoped URL allow to its path", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "webfetch", resource: "https://github.com/org/*", effect: "allow" }])
      const service = yield* Permission.Service
      const github = (path: string) =>
        webfetch({
          resources: ["github.com"],
          aliases: { "github.com": [`https://github.com${path}`] },
          save: ["github.com"],
        })

      expect(yield* service.ask(github("/org/x"))).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(github("/other"))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("lets a host allow lift an earlier deny of everything", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "docs.example.com", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(webfetch())).toMatchObject({ effect: "allow" })
      yield* service.assert(webfetch())
      expect(
        yield* service.ask(
          webfetch({
            resources: ["other.example.com"],
            aliases: { "other.example.com": ["https://other.example.com/a"] },
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("saves only the host for an always reply and keeps aliases off the request", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest(webfetch())

      expect(request).toMatchObject({ resources: ["docs.example.com"], save: ["docs.example.com"] })
      expect(request).not.toHaveProperty("aliases")
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const saved = yield* PermissionSaved.Service
      const rules = yield* saved.list({ projectID: Project.ID.global })
      expect(rules).toHaveLength(1)
      expect(rules[0]).toMatchObject({ action: "webfetch", resource: "docs.example.com" })
      expect(
        yield* service.ask(
          webfetch({
            id: Permission.ID.create("per_next"),
            aliases: { "docs.example.com": ["https://docs.example.com/b"] },
          }),
        ),
      ).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(pastebin())).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("re-evaluates pending requests with their aliases after another always reply", () =>
    Effect.gen(function* () {
      yield* setup()
      const selected = yield* waitForRequest(webfetch({ save: ["*"] }))
      const sibling = yield* waitForRequest(
        webfetch({
          id: Permission.ID.create("per_sibling"),
          resources: ["example.org"],
          aliases: { "example.org": ["https://example.org/"] },
          save: ["example.org"],
        }),
      )
      const blocked = yield* waitForRequest(pastebin({ id: Permission.ID.create("per_pastebin") }))
      // The URL deny arrives after the requests were queued, as when a session rule changes mid-turn.
      yield* setRules(denyPastebinUrls)

      yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
      yield* Fiber.join(selected.fiber)
      yield* Fiber.join(sibling.fiber)
      expect(yield* selected.service.list()).toEqual([blocked.request])
      expect(blocked.fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(blocked.fiber)
      expect(yield* selected.service.list()).toEqual([])
    }),
  )

  it.effect("keeps the aliases of a request queued by ask", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      expect(yield* service.ask(pastebin({ id: Permission.ID.create("per_pastebin") }))).toMatchObject({
        effect: "ask",
      })
      const selected = yield* waitForRequest(webfetch({ save: ["*"] }))
      yield* setRules(denyPastebinUrls)

      yield* service.reply({ requestID: selected.request.id, reply: "always" })
      yield* Fiber.join(selected.fiber)
      expect((yield* service.list()).map((request) => request.id)).toEqual([Permission.ID.create("per_pastebin")])
    }),
  )

  it.effect("hands aliases to evaluate hooks", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const hooks = yield* PluginHooks.Service
      const seen: Array<Readonly<Record<string, ReadonlyArray<string>>> | undefined> = []
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          seen.push(event.aliases)
          if (
            Object.values(event.aliases ?? {}).some((aliases) =>
              aliases.some((alias) => alias.startsWith("https://pastebin.com/")),
            )
          )
            event.effect = "deny"
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(webfetch())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(pastebin())).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(seen).toEqual([
        { "docs.example.com": ["https://docs.example.com/a"] },
        { "pastebin.com": ["https://pastebin.com/raw/abc"] },
        undefined,
      ])
    }),
  )

  describe("per resource", () => {
    // A write: the URL has the host as an alias, and `POST url` has none.
    const url = "https://docs.example.com/a"
    const write = (input: Partial<Permission.AssertInput> = {}) =>
      assertion({
        action: "webfetch",
        resources: [url, `POST ${url}`],
        aliases: { [url]: ["docs.example.com"] },
        save: ["https://docs.example.com/*", "POST https://docs.example.com/*"],
        ...input,
      })
    const read = (input: Partial<Permission.AssertInput> = {}) => write({ resources: [url], ...input })

    it.effect("never lets the alias of one resource allow another resource", () =>
      Effect.gen(function* () {
        yield* setup([{ action: "webfetch", resource: "docs.example.com", effect: "allow" }])
        const service = yield* Permission.Service

        expect(yield* service.ask(read())).toMatchObject({ effect: "allow" })
        // The host allow matches the URL through its alias. `POST url` has none, so the write still asks.
        expect(yield* service.ask(write())).toMatchObject({ effect: "ask" })
      }),
    )

    it.effect("blocks a write through a deny that only the URL's alias matches", () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "*", resource: "*", effect: "allow" },
          { action: "webfetch", resource: "docs.example.com", effect: "deny" },
        ])
        const service = yield* Permission.Service

        expect(yield* service.ask(write())).toMatchObject({ effect: "deny" })
        expect(yield* service.assert(write()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
        expect(yield* service.list()).toEqual([])
      }),
    )

    it.effect("allows a write once the URL and the method form are both allowed", () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" },
          { action: "webfetch", resource: "POST https://docs.example.com/*", effect: "allow" },
        ])
        const service = yield* Permission.Service

        expect(yield* service.ask(write())).toMatchObject({ effect: "allow" })
        expect(yield* service.ask(write({ resources: [url, `PUT ${url}`] }))).toMatchObject({ effect: "ask" })
      }),
    )

    it.effect("keeps a pending write waiting after a host always reply", () =>
      Effect.gen(function* () {
        yield* setup()
        const selected = yield* waitForRequest(webfetch({ save: ["docs.example.com"] }))
        const pending = yield* waitForRequest(write({ id: Permission.ID.create("per_write") }))

        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        // The saved host allow covers the write's URL through its alias but never `POST url`.
        expect(yield* selected.service.list()).toEqual([pending.request])
        expect(pending.fiber.pollUnsafe()).toBeUndefined()
        expect(yield* selected.service.ask(read({ id: Permission.ID.create("per_read") }))).toMatchObject({
          effect: "allow",
        })
        yield* Fiber.interrupt(pending.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )

    it.effect("approves a pending write once an always reply saves its origin and its method form", () =>
      Effect.gen(function* () {
        yield* setup()
        const selected = yield* waitForRequest(write({ id: Permission.ID.create("per_first") }))
        const other = "https://docs.example.com/b"
        const pending = yield* waitForRequest(
          write({
            id: Permission.ID.create("per_second"),
            resources: [other, `POST ${other}`],
            aliases: { [other]: ["docs.example.com"] },
          }),
        )

        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        yield* Fiber.join(pending.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )

    it.effect("hands each resource's own aliases to evaluate hooks", () =>
      Effect.gen(function* () {
        yield* setup([{ action: "*", resource: "*", effect: "allow" }])
        const hooks = yield* PluginHooks.Service
        const seen: Array<Readonly<Record<string, ReadonlyArray<string>>> | undefined> = []
        yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => void seen.push(event.aliases)))
        const service = yield* Permission.Service

        expect(yield* service.ask(write())).toMatchObject({ effect: "allow" })
        expect(seen).toEqual([{ [url]: ["docs.example.com"] }])
      }),
    )
  })
})

// Orbit lets every agent reach its own folders outside the project without a question: shell and tool output, the
// temporary folder and the global config folder. A repository that is not trusted can ship a link into one of them, so
// a place reached through such a link is decided by the person's own rules and approvals only (class 4, class 8).
describe("Permission for a place a link leads out to", () => {
  const folders = Effect.gen(function* () {
    const global = yield* Global.Service
    const resource = (folder: string) => path.join(folder, "*").replaceAll("\\", "/")
    return {
      rules: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "ask" },
        ...Agent.folders(global),
      ] satisfies Permission.Ruleset,
      places: [
        resource(global.config),
        resource(global.tmp),
        resource(path.join(global.data, "shell", "shl_1")),
        resource(path.join(global.data, "tool-output")),
      ],
      config: resource(global.config),
    }
  })
  const external = (resource: string, escaped: boolean) =>
    assertion({
      id: Permission.ID.create(),
      action: "external_directory",
      resources: [resource],
      save: [resource],
      ...(escaped ? { escaped: [resource] } : {}),
    })

  it.effect("lets Orbit's own allows decide a folder named directly, and not one a link leads to", () =>
    Effect.gen(function* () {
      const fixture = yield* folders
      yield* setup(fixture.rules)
      const service = yield* Permission.Service
      for (const place of fixture.places) {
        expect([place, (yield* service.ask(external(place, false))).effect]).toEqual([place, "allow"])
        expect([place, (yield* service.ask(external(place, true))).effect]).toEqual([place, "ask"])
      }
    }),
  )

  // The person's rule is written in another form than Orbit's own allow (`**`): one with the very same value as an allow
  // of Orbit's is taken for Orbit's and does not decide such a place (Known gaps, task permissions-23).
  it.effect("lets the person's own rules decide a folder a link leads to", () =>
    Effect.gen(function* () {
      const fixture = yield* folders
      yield* setup([
        ...fixture.rules,
        { action: "external_directory", resource: fixture.config.replace(/\*$/, "**"), effect: "allow" },
      ])
      const service = yield* Permission.Service
      expect(yield* service.ask(external(fixture.config, true))).toMatchObject({ effect: "allow" })
      yield* setRules([...fixture.rules, { action: "external_directory", resource: fixture.config, effect: "deny" }])
      expect(yield* service.ask(external(fixture.config, true))).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(external(fixture.config, false))).toMatchObject({ effect: "deny" })
    }),
  )

  // The very same action, folder and effect as one of Orbit's own allows: Orbit's are marked where they are made, so the
  // person's copy is the person's rule, and a deny of the same value still wins over it.
  it.effect("lets the person's rule with the value of one of Orbit's own allows decide a folder a link leads to", () =>
    Effect.gen(function* () {
      const fixture = yield* folders
      const global = yield* Global.Service
      const same = Agent.folders(global).map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      }))
      expect(same.map((rule) => rule.resource.replaceAll("\\", "/"))).toContain(fixture.config)
      // The rules Orbit makes are its own; a plain object with the very same value is not.
      expect(Agent.folders(global).map(Agent.isOwnFolder)).toEqual([true, true, true, true])
      expect(same.map(Agent.isOwnFolder)).toEqual([false, false, false, false])

      // Orbit's allows alone do not decide the place; the person's rule with the same value does.
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "ask" },
        ...Agent.folders(global),
      ])
      const service = yield* Permission.Service
      for (const place of fixture.places) expect((yield* service.ask(external(place, true))).effect).toBe("ask")
      yield* setRules([
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "ask" },
        ...Agent.folders(global),
        ...same,
      ])
      for (const place of fixture.places) expect((yield* service.ask(external(place, true))).effect).toBe("allow")
      // The same value as a deny and as an ask decides as well.
      for (const effect of ["deny", "ask"] as const) {
        yield* setRules([
          { action: "*", resource: "*", effect: "allow" },
          ...Agent.folders(global),
          ...same.map((rule) => ({ ...rule, effect })),
        ])
        for (const place of fixture.places) expect((yield* service.ask(external(place, true))).effect).toBe(effect)
      }
    }),
  )

  it.effect("holds only the resources a link leads to, and lets an always reply save the person's approval", () =>
    Effect.gen(function* () {
      const fixture = yield* folders
      yield* setup(fixture.rules)
      const tmp = fixture.places[1]!
      const selected = yield* waitForRequest({
        action: "external_directory",
        resources: [tmp, fixture.config],
        save: [tmp, fixture.config],
        escaped: [fixture.config],
      })
      expect(selected.request).not.toHaveProperty("escaped")
      yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
      yield* Fiber.join(selected.fiber)
      expect(
        yield* selected.service.ask(
          assertion({
            id: Permission.ID.create("per_next"),
            action: "external_directory",
            resources: [fixture.config],
            escaped: [fixture.config],
          }),
        ),
      ).toMatchObject({ effect: "allow" })
    }),
  )
})

describe("shell scanner permission impact", () => {
  // Fixed cases require matching outcomes; remaining differences are investigation snapshots, not contracts.
  // These service-level cases all have command resources; tool tests cover skipped checks and directories.
  // Outcome pairs are [legacy, native].
  for (const fixture of [
    {
      name: "timed command preserves wrapper approvals",
      shell: "bash",
      command: "time -p git status",
      approved: ["time *"],
      exact: ["time -p git status"],
      denied: "time -p git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "coprocess command preserves wrapper approvals",
      shell: "bash",
      command: "coproc git status",
      approved: ["coproc *"],
      exact: ["coproc git status"],
      denied: "coproc git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "declarations and unset",
      shell: "bash",
      command: "export X=value; unset X; git status",
      approved: ["git status *"],
      exact: ["git status"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export with an approved command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export retains checks on the command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "git describe *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a conditional list",
      shell: "bash",
      command: "printf ok && git status > output",
      approved: ["printf *", "git status *"],
      exact: ["printf ok", "git status"],
      denied: "git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a pipeline",
      shell: "bash",
      command: "printf ok | cat < input > output",
      approved: ["printf *", "cat *"],
      exact: ["printf ok", "cat"],
      denied: "cat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect followed by a command",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      approved: ["printf *"],
      exact: ["printf done"],
      denied: "FOO=bar > output; printf done",
      savedEffect: ["ask", "allow"],
      exactEffect: ["ask", "allow"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "assignment redirect with an approved command substitution",
      shell: "bash",
      command: "VERSION=$(git describe --tags) > build/version.txt",
      approved: ["git describe *"],
      exact: ["git describe --tags"],
      denied: "VERSION=$(git describe --tags) > build/version.txt",
      savedEffect: ["ask", "allow"],
      exactEffect: ["ask", "allow"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "substitution in a saved prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      approved: ["git *", "printf *"],
      exact: ["git $(printf diff) --stat", "printf diff"],
      denied: "git $(printf diff) --stat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "standalone PowerShell scriptblock caller",
      shell: "pwsh",
      command: "ForEach-Object { Write-Output value }",
      approved: ["Write-Output *"],
      exact: ["Write-Output value"],
      denied: "ForEach-Object *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "tab-separated PowerShell command",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      approved: ["git status *", "Write-Output *"],
      exact: ["git status", "Write-Output done"],
      denied: "git\tstatus",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "PowerShell equals-joined argument",
      shell: "pwsh",
      command: "git --work-tree=src status",
      approved: ["git --work-tree *"],
      exact: ["git --work-tree"],
      denied: "git --work-tree",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "allow"],
    },
  ] as const) {
    for (const scenario of [
      { name: "no approval", saved: [], rules: [], expected: ["ask", "ask"] },
      { name: "saved wildcard", saved: ["*"], rules: [], expected: ["allow", "allow"] },
      { name: "saved command approvals", saved: fixture.approved, rules: [], expected: fixture.savedEffect },
      {
        name: "exact configured approvals",
        saved: [],
        rules: fixture.exact.map((resource): Permission.Rule => ({ action: "shell", resource, effect: "allow" })),
        expected: fixture.exactEffect,
      },
      {
        name: "exact saved approvals",
        saved: fixture.exact,
        rules: [],
        expected: fixture.exactEffect,
      },
      {
        name: "configured deny despite saved wildcard",
        saved: ["*"],
        rules: [{ action: "shell", resource: fixture.denied, effect: "deny" }] satisfies Permission.Ruleset,
        expected: fixture.deniedEffect,
      },
    ] as const) {
      it.live(`${fixture.name}: ${scenario.name}`, () =>
        Effect.gen(function* () {
          yield* setup(scenario.rules)
          const saved = yield* PermissionSaved.Service
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: scenario.saved })
          const service = yield* Permission.Service

          for (const [index, portable] of [false, true].entries()) {
            const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project", { portable })
            expect(parsed.commands.length).toBeGreaterThan(0)
            expect(parsed.directories).toEqual([])
            const result = yield* service.ask(
              assertion({
                action: "shell",
                resources: parsed.commands.map((command) => command.resource),
                save: parsed.commands.map((command) => command.save),
              }),
            )
            expect(result.effect, portable ? "native" : "legacy").toBe(scenario.expected[index])
            const pending = yield* service.list()
            expect(pending).toHaveLength(result.effect === "ask" ? 1 : 0)
            if (result.effect !== "ask") continue
            expect(pending[0]?.resources).toEqual(parsed.commands.map((command) => command.resource))
            expect(pending[0]?.save).toEqual(parsed.commands.map((command) => command.save))
            yield* service.reply({ requestID: result.id, reply: "once" })
            expect(yield* service.list()).toEqual([])
          }
        }),
      )
    }
  }

  // Grant/repeat rows select the granting parser; repeat columns select the parser used afterwards.
  for (const fixture of [
    {
      name: "numeric npm script prefix",
      shell: "bash",
      command: "npm run 123",
      grants: [["npm run *"], ["npm run 123 *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "npm run build",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "numeric AWS option prefix",
      shell: "bash",
      command: "aws --cli-read-timeout 60 s3 ls",
      grants: [["aws --cli-read-timeout s3 *"], ["aws --cli-read-timeout 60 *"]],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "aws --cli-read-timeout 60 ec2 describe-instances",
      nextEffect: ["ask", "allow"],
    },
    {
      name: "substitution prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      grants: [
        ["git --stat *", "printf *"],
        ["git $(printf diff) *", "printf *"],
      ],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "git --stat",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "redirect prefix",
      shell: "bash",
      command: "printf ok && git status > output",
      grants: [
        ["printf *", "git status *"],
        ["printf *", "git status *"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status --short",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "assignment redirect prefix",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      grants: [["printf *"], ["printf *"]],
      // Identical saved rules cover only the native resource, regardless of which parser saved them.
      repeat: [
        ["ask", "allow"],
        ["ask", "allow"],
      ],
      next: "printf next",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "PowerShell tab prefix",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      grants: [["Write-Output *"], ["git\tstatus *", "Write-Output *"]],
      repeat: [
        ["allow", "ask"],
        ["allow", "allow"],
      ],
      next: "git status",
      nextEffect: ["ask", "ask"],
    },
  ] as const) {
    for (const [origin, portable] of [false, true].entries()) {
      it.live(`${fixture.name}: always allow from ${portable ? "native" : "legacy"}, then use either parser`, () =>
        Effect.gen(function* () {
          yield* setup()
          const service = yield* Permission.Service
          const saved = yield* PermissionSaved.Service
          const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project", { portable })
          const first = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(first.effect).toBe("ask")
          expect(yield* service.list()).toHaveLength(1)
          yield* service.reply({ requestID: first.id, reply: "always" })
          expect(yield* service.list()).toEqual([])
          expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource).sort()).toEqual(
            [...fixture.grants[portable ? 1 : 0]].sort(),
          )

          for (const [index, target] of [false, true].entries()) {
            for (const command of [fixture.command, fixture.next]) {
              const parsed = yield* ShellParse.scan(command, fixture.shell, "/project", { portable: target })
              const result = yield* service.ask(
                assertion({
                  action: "shell",
                  resources: parsed.commands.map((command) => command.resource),
                  save: parsed.commands.map((command) => command.save),
                }),
              )
              expect(result.effect, `${target ? "native" : "legacy"}: ${command}`).toBe(
                command === fixture.next ? fixture.nextEffect[origin] : fixture.repeat[origin]?.[index],
              )
              if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
              expect(yield* service.list()).toEqual([])
            }
          }
        }),
      )
    }
  }
})
