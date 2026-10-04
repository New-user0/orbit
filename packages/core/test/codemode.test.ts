import { describe, expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { Document, Info } from "@orbit/schema/config"
import type { ConfigPolicy } from "@orbit/schema/config/policy"
import { SessionMessage } from "@orbit/schema/session-message"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { location } from "./fixture/location"
import { it, testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { allowAllPermission } from "./lib/permission"
import { host } from "./plugin/host"

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.namespace({ name: "empty", description: "No tools registered yet" })
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog).toStrictEqual({
        tools: [
          {
            type: "tool",
            name: "echo",
            description: "Echo text",
            signature: "tools.echo({\n  text: string,\n}): Promise<string>",
            pinned: true,
          },
          {
            type: "namespace",
            name: "empty",
            description: "No tools registered yet",
            tools: [],
          },
        ],
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(Tool.node, [
          Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
          Permission.node.replace(allowAllPermission),
        ]),
      ),
    ),
  )
})

// The real Permission node decides every fetch a program makes, and a local server shows what actually reached the
// network.
const web = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      ManagedPolicy.node,
      Permission.node,
      Tool.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      Image.node.replace(imagePassthrough),
    ],
  ),
)

const sessionID = Session.ID.make("ses_codemode_web")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_codemode_web") }
const callID = "call_codemode_web"

const seed = Effect.fn(function* (rules: Permission.Ruleset = []) {
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
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(identity.agent, (agent) => {
      agent.permissions = [...rules]
    }),
  )
})

const serve = Effect.acquireRelease(
  Effect.sync(() => {
    const hits: Array<string> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        hits.push(`${request.method} ${url.pathname}${url.search}`)
        return new Response("served")
      },
    })
    return { hits, origin: `http://127.0.0.1:${server.port}`, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
)

const run = (code: string) =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    const snapshot = yield* tools.snapshot()
    return yield* snapshot.execute({
      sessionID,
      ...identity,
      call: { type: "tool-call", id: callID, name: "execute", input: { code } },
    })
  })

const nextRequest = (attempts = 1000): Effect.Effect<Permission.Request, Error, Permission.Service> =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const [request] = yield* permission.list()
    if (request) return request
    if (attempts === 0) return yield* Effect.fail(new Error("the program never asked for permission"))
    yield* Effect.sleep("5 millis")
    return yield* nextRequest(attempts - 1)
  })

const declined = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError)

// Runs the real configuration policy plugin against the registry's own hooks, so a policy statement reaches Permission
// the way it does in a server.
const installPolicy = Effect.fn(function* (...statements: ConfigPolicy.Info[]) {
  const hooks = yield* PluginHooks.Service
  const unused = () => Effect.die("unused")
  const context = host({
    event: { subscribe: () => Stream.empty },
    provider: {
      list: unused,
      get: unused,
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
    permission: {
      list: unused,
      get: unused,
      reply: unused,
      hook: (name, callback) => hooks.register("permission", name, callback),
    },
  })
  const document = new Document({
    type: "document",
    info: Schema.decodeUnknownSync(Info)({ experimental: { policies: statements } }),
  })
  yield* ConfigPolicyPlugin.Plugin.effect(context).pipe(Effect.provide(Config.testLayer([document])))
})

describe("CodeMode fetch permission", () => {
  web.live("asks for the origin before anything is sent", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(`return await (await fetch("${origin}/page?x=1#top")).text()`).pipe(Effect.forkScoped)

      const request = yield* nextRequest()
      expect(request).toMatchObject({
        sessionID,
        action: "webfetch",
        resources: [`${origin}/page?x=1`],
        save: [`${origin}/*`],
        // Every call in the program shares the execute call's ID, so the metadata tells them apart.
        metadata: { method: "GET", url: `${origin}/page?x=1` },
        source: { type: "tool", messageID: identity.messageID, id: callID },
      })
      expect(request).not.toHaveProperty("aliases")
      expect(hits).toEqual([])

      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect((yield* Fiber.join(fiber)).output).toMatchObject({
        output: "served",
        toolCalls: [{ tool: "fetch", status: "completed", input: { method: "GET", url: `${origin}/page?x=1#top` } }],
      })
      expect(hits).toEqual(["GET /page?x=1"])
    }),
  )

  web.live("ends the call with the decline when the user rejects, and sends nothing", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      // The program cannot catch its way past a plain reject.
      const fiber = yield* run(`try { await fetch("${origin}/a") } catch (e) { return "caught" }; return "after"`).pipe(
        Effect.forkScoped,
      )

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "reject" })

      expect(declined(yield* Fiber.await(fiber))).toBe(true)
      expect(hits).toEqual([])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("shows the program a rejection with feedback as an error it can catch", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(
        `try { await fetch("${origin}/a") } catch (e) { return e.message }; return "unreachable"`,
      ).pipe(Effect.forkScoped)

      yield* permission.reply({
        requestID: (yield* nextRequest()).id,
        reply: "reject",
        message: "Use the staging host",
      })

      expect((yield* Fiber.join(fiber)).output).toMatchObject({
        output: "Use the staging host",
        toolCalls: [{ tool: "fetch", status: "error", input: { method: "GET", url: `${origin}/a` } }],
      })
      expect(hits).toEqual([])
    }),
  )

  web.live("needs no ask for an origin the rules allow", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([{ action: "webfetch", resource: `${origin}/*`, effect: "allow" }])
      const permission = yield* Permission.Service

      const result = yield* run(`return await (await fetch("${origin}/a")).text()`)

      expect(result.output).toMatchObject({ output: "served" })
      expect(hits).toEqual(["GET /a"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("still asks for a write to an origin the rules allow, and an always reply saves both patterns", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([{ action: "webfetch", resource: `${origin}/*`, effect: "allow" }])
      const permission = yield* Permission.Service
      const post = (path: string) => `(await fetch("${origin}${path}", { method: "post", body: "x" })).status`
      const fiber = yield* run(`return await ${post("/a")}`).pipe(Effect.forkScoped)

      const request = yield* nextRequest()
      expect(request).toMatchObject({
        action: "webfetch",
        resources: [`${origin}/a`, `POST ${origin}/a`],
        save: [`${origin}/*`, `POST ${origin}/*`],
        metadata: { method: "POST", url: `${origin}/a` },
      })
      expect(hits).toEqual([])

      yield* permission.reply({ requestID: request.id, reply: "always" })
      expect((yield* Fiber.join(fiber)).output).toMatchObject({ output: "200" })
      expect(hits).toEqual(["POST /a"])
      const saved = yield* PermissionSaved.Service.use((rules) => rules.list({ projectID: Project.ID.global }))
      expect(saved.map((rule) => `${rule.action} ${rule.resource}`).toSorted()).toEqual([
        `webfetch POST ${origin}/*`,
        `webfetch ${origin}/*`,
      ])

      // The saved patterns cover that origin from now on, for reads and for writes.
      const again = yield* run(`return [await ${post("/b")}, (await fetch("${origin}/c")).status]`)
      expect(JSON.parse(again.output.output)).toEqual([200, 200])
      expect(hits).toEqual(["POST /a", "POST /b", "GET /c"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("blocks a write through a URL deny, with an error the program can catch", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([
        { action: "*", resource: "*", effect: "allow" },
        { action: "webfetch", resource: `${origin}/*`, effect: "deny" },
      ])
      const permission = yield* Permission.Service

      const result = yield* run(
        `try { await fetch("${origin}/a", { method: "POST", body: "x" }) } catch (e) { return e.message }; return "unreachable"`,
      )

      expect(result.output).toMatchObject({
        output: "Permission denied: webfetch",
        toolCalls: [{ tool: "fetch", status: "error", input: { method: "POST", url: `${origin}/a` } }],
      })
      expect(hits).toEqual([])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  // A rule or an approval written for the host is an alias of the URL, so it covers reads of that host but never the
  // write resource `METHOD url`, which has no aliases.
  const hostRule = [{ action: "webfetch", resource: "127.0.0.1", effect: "allow" }] as const
  for (const [name, grant] of [
    ["a host allow rule", () => seed(hostRule)],
    [
      "a saved host approval",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* PermissionSaved.Service.use((rules) =>
            rules.add({ projectID: Project.ID.global, action: "webfetch", resources: ["127.0.0.1"] }),
          )
        }),
    ],
  ] as const) {
    web.live(`lets ${name} cover a read of the host but still asks for a write to it`, () =>
      Effect.gen(function* () {
        const { hits, origin } = yield* serve
        yield* grant()
        const permission = yield* Permission.Service

        const read = yield* run(`return await (await fetch("${origin}/read")).text()`)
        expect(read.output).toMatchObject({ output: "served" })
        expect(yield* permission.list()).toEqual([])

        const fiber = yield* run(`return (await fetch("${origin}/write", { method: "PUT", body: "x" })).status`).pipe(
          Effect.forkScoped,
        )
        const request = yield* nextRequest()
        expect(request.resources).toEqual([`${origin}/write`, `PUT ${origin}/write`])
        yield* permission.reply({ requestID: request.id, reply: "reject" })

        expect(declined(yield* Fiber.await(fiber))).toBe(true)
        expect(hits).toEqual(["GET /read"])
      }),
    )
  }

  web.live("blocks a write, and a read, through a host deny", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([
        { action: "*", resource: "*", effect: "allow" },
        { action: "webfetch", resource: "127.0.0.1", effect: "deny" },
      ])
      const permission = yield* Permission.Service

      for (const init of ['{ method: "POST", body: "x" }', "{}"]) {
        const result = yield* run(
          `try { await fetch("${origin}/a", ${init}) } catch (e) { return e.message }; return "unreachable"`,
        )
        expect(result.output).toMatchObject({ output: "Permission denied: webfetch" })
      }
      expect(hits).toEqual([])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  // A permission policy is matched as `webfetch:` plus the URL, its host or `METHOD url`, so a statement written any of
  // these ways blocks a write, and the method form blocks only that method.
  for (const [name, resource, blocksReads] of [
    ["the URL", (origin: string) => `${origin}/*`, true],
    ["its host", () => "127.0.0.1", true],
    ["the method form", (origin: string) => `POST ${origin}/*`, false],
  ] as const) {
    web.live(`blocks a write through a permission policy for ${name}`, () =>
      Effect.gen(function* () {
        const { hits, origin } = yield* serve
        yield* seed([{ action: "*", resource: "*", effect: "allow" }])
        yield* installPolicy({ action: "permission", resource: `webfetch:${resource(origin)}`, effect: "deny" })

        const write = yield* run(
          `try { await fetch("${origin}/a", { method: "POST", body: "x" }) } catch (e) { return e.message }; return "unreachable"`,
        )
        expect(write.output).toMatchObject({ output: "Blocked by configuration policy" })
        expect(hits).toEqual([])

        const read = yield* run(
          `try { return await (await fetch("${origin}/b")).text() } catch (e) { return e.message }`,
        )
        expect(read.output).toMatchObject({ output: blocksReads ? "Blocked by configuration policy" : "served" })
        expect(hits).toEqual(blocksReads ? [] : ["GET /b"])
      }),
    )
  }

  web.live("fails a URL that is not http(s) before any permission ask or I/O", () =>
    Effect.gen(function* () {
      const { hits } = yield* serve
      // With no rules every ask would wait for a reply, so finishing at all shows that nothing was asked.
      yield* seed()
      const permission = yield* Permission.Service

      for (const url of ["file:///x", "data:text/plain,hi", "s3://bucket/key", "javascript:alert(1)", "ftp://host/x"]) {
        const result = yield* run(`try { await fetch("${url}") } catch (e) { return e.message }; return "unreachable"`)
        expect(result.output).toMatchObject({ output: "URL must use http:// or https://" })
      }
      expect(hits).toEqual([])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  // Bun's fetch takes an array or an object with a url for the URL, and a method it can coerce or ignore. Anything the
  // permission check cannot read the same way is refused rather than guessed at.
  web.live("refuses arguments the permission check cannot read", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([{ action: "*", resource: "*", effect: "allow" }])

      for (const [call, message] of [
        [`fetch(["${origin}/a"])`, "fetch needs a URL string or a URL"],
        [`fetch({ url: "${origin}/a" })`, "fetch needs a URL string or a URL"],
        [`fetch("${origin}/a", { method: ["POST"] })`, "fetch method must be a string"],
        [`fetch("${origin}/a", { method: "PO ST" })`, "HTTP method must be a name such as GET or POST"],
        [`fetch("${origin}/a", { method: "*" })`, "HTTP method must be a name such as GET or POST"],
      ] as const) {
        const result = yield* run(`try { await ${call} } catch (e) { return e.message }; return "unreachable"`)
        expect(result.output).toMatchObject({ output: message })
      }
      expect(hits).toEqual([])
    }),
  )
})
