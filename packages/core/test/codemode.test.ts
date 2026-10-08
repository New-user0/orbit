import { describe, expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { ConfigWebPlugin } from "@orbit/core/config/plugin/web"
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
import { ConfigExperimental } from "@orbit/schema/config/experimental"
import type { ConfigPolicy } from "@orbit/schema/config/policy"
import { Event } from "@orbit/schema/event"
import { SessionMessage } from "@orbit/schema/session-message"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Network } from "@orbit/util/network"
import { Cause, Effect, Exit, Fiber, Layer, PubSub, References, Schema, Stream } from "effect"
import path from "node:path"
import { location } from "./fixture/location"
import { it, testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { allowAllPermission } from "./lib/permission"
import { host } from "./plugin/host"

const registry = AppNodeBuilder.build(Tool.node, [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Permission.node.replace(allowAllPermission),
])

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
    }).pipe(Effect.scoped, Effect.provide(registry)),
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

// A local server is all these tests can talk to, so the configuration allows local servers unless a test asks for the
// default, which refuses them.
const seed = Effect.fn(function* (rules: Permission.Ruleset = [], options: { readonly local?: boolean } = {}) {
  const tools = yield* Tool.Service
  yield* tools.transform((editor) => editor.web({ allowLocal: options.local ?? true }))
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

// What the server answers with a redirect: the status and where to. `local` spells the same server as another origin.
const redirects: Record<string, readonly [number, (local: string) => string]> = {
  "/to-local": [302, (local) => `${local}/landed`],
  "/to-metadata": [302, () => "http://169.254.169.254/latest/meta-data/"],
  // A name that only the configuration's resolver leads anywhere.
  "/to-name": [302, (local) => `http://hop.example.test:${new URL(local).port}/landed`],
  "/to-file": [302, () => "file:///etc/hosts"],
  "/within": [302, () => "/landed"],
  "/moved": [301, () => "/landed"],
  "/see-other": [303, () => "/landed"],
  "/temporary": [307, () => "/landed"],
  "/permanent": [308, () => "/landed"],
  "/loop": [302, () => "/loop"],
}

const serve = Effect.acquireRelease(
  Effect.sync(() => {
    const hits: Array<string> = []
    const requests: Array<{ readonly method: string; readonly headers: Headers; readonly body: string }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        hits.push(`${request.method} ${url.pathname}${url.search}`)
        requests.push({ method: request.method, headers: request.headers, body: await request.text() })
        const redirect = redirects[url.pathname]
        if (redirect === undefined) return new Response("served")
        return new Response(null, {
          status: redirect[0],
          headers: { location: redirect[1](`http://localhost:${url.port}`) },
        })
      },
    })
    // The same server under a second name, which is another origin: a program that moves between the two crosses origins.
    return {
      hits,
      requests,
      origin: `http://127.0.0.1:${server.port}`,
      local: `http://localhost:${server.port}`,
      server,
    }
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

// What a tool declares about how to find it reaches the search function that a program calls, through the registry.
describe("CodeMode search hints", () => {
  const tool = (name: string, searchHint?: string) => ({
    name,
    description: `The ${name} tool`,
    input: Schema.Struct({}),
    output: Schema.String,
    traits: searchHint === undefined ? undefined : { searchHint },
    execute: () => Effect.succeed({ output: name }),
  })
  // What a program that searches a snapshot for a query returns.
  const search = (snapshot: Tool.Snapshot, query: string, returned: string) =>
    snapshot
      .execute({
        sessionID,
        ...identity,
        call: {
          type: "tool-call",
          id: callID,
          name: "execute",
          input: { code: `const found = search({ query: ${JSON.stringify(query)} }); return ${returned}` },
        },
      })
      .pipe(Effect.map((result) => (result.output as { readonly output: string }).output))
  // The paths it finds, in rank order.
  const found = (snapshot: Tool.Snapshot, query: string) =>
    search(snapshot, query, 'found.items.map((item) => item.path).join(",")')

  it.effect("finds a deferred tool by its searchHint, and by nothing else it says", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.add(tool("charge", "refund receipt"))
        editor.add({ ...tool("lookup", "refund receipt"), options: { namespace: "orders" } })
        editor.add(tool("upload"))
        // A tool that is offered directly is not in what a program can search, whatever its hint says.
        editor.add({ ...tool("direct", "refund receipt"), options: { codemode: false } })
      })
      const snapshot = yield* tools.snapshot()

      expect(yield* found(snapshot, "refund")).toBe("tools.charge,tools.orders.lookup")
      expect(yield* found(snapshot, "receipts")).toBe("tools.charge,tools.orders.lookup")
      expect(yield* found(snapshot, "upload")).toBe("tools.upload")
      expect(yield* found(snapshot, "zebra")).toBe("")
      // The hint ranks the tool, and is no part of what the catalog or a search says about it.
      const listed = JSON.stringify(snapshot.codeModeCatalog)
      expect(listed).toContain("charge")
      expect(listed).not.toContain("receipt")
      const shown = yield* search(snapshot, "refund", "found")
      expect(shown).toContain("tools.charge")
      expect(shown).not.toContain("receipt")
    }).pipe(Effect.scoped, Effect.provide(registry)),
  )

  it.effect("searches the hints that the registry held when the snapshot was taken", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => editor.add(tool("charge", "refund")))
      const before = yield* tools.snapshot()
      yield* tools.transform((editor) =>
        editor.update("charge", (charge) => {
          charge.traits = { searchHint: "invoice" }
        }),
      )
      const after = yield* tools.snapshot()
      yield* tools.transform((editor) =>
        editor.update("charge", (charge) => {
          charge.traits = undefined
        }),
      )
      const without = yield* tools.snapshot()

      expect([yield* found(before, "refund"), yield* found(before, "invoice")]).toEqual(["tools.charge", ""])
      expect([yield* found(after, "refund"), yield* found(after, "invoice")]).toEqual(["", "tools.charge"])
      expect([yield* found(without, "refund"), yield* found(without, "invoice")]).toEqual(["", ""])
    }).pipe(Effect.scoped, Effect.provide(registry)),
  )
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
        action: "WebFetch",
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
        action: "WebFetch",
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
        `WebFetch POST ${origin}/*`,
        `WebFetch ${origin}/*`,
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
        output: "Permission denied: WebFetch",
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
        expect(result.output).toMatchObject({ output: "Permission denied: WebFetch" })
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

// A redirect is a request to a place the program never named, so each one is asked about like the program's own.
describe("CodeMode fetch redirects", () => {
  web.live("asks again before it follows a redirect to another host, and sends nothing until it is approved", () =>
    Effect.gen(function* () {
      const { hits, origin, local } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(`return await (await fetch("${origin}/to-local")).text()`).pipe(Effect.forkScoped)

      const first = yield* nextRequest()
      expect(first.resources).toEqual([`${origin}/to-local`])
      yield* permission.reply({ requestID: first.id, reply: "once" })

      const second = yield* nextRequest()
      expect(second).toMatchObject({
        sessionID,
        action: "WebFetch",
        resources: [`${local}/landed`],
        save: [`${local}/*`],
        metadata: { method: "GET", url: `${local}/landed` },
        source: { type: "tool", messageID: identity.messageID, id: callID },
      })
      // The redirect has been answered, but the place it names has not.
      expect(hits).toEqual(["GET /to-local"])

      yield* permission.reply({ requestID: second.id, reply: "once" })
      expect((yield* Fiber.join(fiber)).output).toMatchObject({
        output: "served",
        toolCalls: [{ tool: "fetch", status: "completed", input: { method: "GET", url: `${origin}/to-local` } }],
      })
      expect(hits).toEqual(["GET /to-local", "GET /landed"])
    }),
  )

  web.live("ends the call and sends nothing more when the user declines the redirect", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      // A plain decline ends the step, so the program cannot catch its way past it.
      const fiber = yield* run(
        `try { await fetch("${origin}/to-local") } catch (e) { return "caught" }; return "after"`,
      ).pipe(Effect.forkScoped)

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "once" })
      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "reject" })

      expect(declined(yield* Fiber.await(fiber))).toBe(true)
      expect(hits).toEqual(["GET /to-local"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("shows the program a redirect that a rule blocks as an error it can catch", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([
        { action: "*", resource: "*", effect: "allow" },
        { action: "webfetch", resource: "localhost", effect: "deny" },
      ])

      const result = yield* run(
        `try { await fetch("${origin}/to-local") } catch (e) { return e.message }; return "unreachable"`,
      )

      expect(result.output).toMatchObject({
        output: "Permission denied: WebFetch",
        toolCalls: [{ tool: "fetch", status: "error", input: { method: "GET", url: `${origin}/to-local` } }],
      })
      expect(hits).toEqual(["GET /to-local"])
    }),
  )

  web.live("follows a redirect that the rules allow without asking, and reports where it landed", () =>
    Effect.gen(function* () {
      const { hits, origin, local } = yield* serve
      yield* seed([
        { action: "webfetch", resource: `${origin}/*`, effect: "allow" },
        { action: "webfetch", resource: `${local}/*`, effect: "allow" },
      ])
      const permission = yield* Permission.Service

      const result = yield* run(
        `const moved = await fetch("${origin}/to-local"); const plain = await fetch("${origin}/plain")
         return [moved.status, moved.redirected, moved.url, await moved.text(), plain.redirected, plain.url]`,
      )

      expect(JSON.parse(result.output.output)).toEqual([
        200,
        true,
        `${local}/landed`,
        "served",
        false,
        `${origin}/plain`,
      ])
      expect(hits).toEqual(["GET /to-local", "GET /landed", "GET /plain"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("asks again for a redirect inside the origin, which a once approval does not cover", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(`return await (await fetch("${origin}/within")).text()`).pipe(Effect.forkScoped)

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "once" })
      const second = yield* nextRequest()
      expect(second.resources).toEqual([`${origin}/landed`])
      expect(hits).toEqual(["GET /within"])

      yield* permission.reply({ requestID: second.id, reply: "once" })
      expect((yield* Fiber.join(fiber)).output).toMatchObject({ output: "served" })
      expect(hits).toEqual(["GET /within", "GET /landed"])
    }),
  )

  web.live("lets an always approval of the origin cover a redirect inside it", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(`return await (await fetch("${origin}/within")).text()`).pipe(Effect.forkScoped)

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "always" })

      expect((yield* Fiber.join(fiber)).output).toMatchObject({ output: "served" })
      expect(hits).toEqual(["GET /within", "GET /landed"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("fails a redirect to a URL that is not http(s) before it asks", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([{ action: "webfetch", resource: `${origin}/*`, effect: "allow" }])
      const permission = yield* Permission.Service

      const result = yield* run(
        `try { await fetch("${origin}/to-file") } catch (e) { return e.message }; return "unreachable"`,
      )

      expect(result.output).toMatchObject({ output: "URL must use http:// or https://" })
      expect(hits).toEqual(["GET /to-file"])
      expect(yield* permission.list()).toEqual([])
    }),
  )

  web.live("follows at most 10 redirects", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([{ action: "*", resource: "*", effect: "allow" }])

      const result = yield* run(
        `try { await fetch("${origin}/loop") } catch (e) { return e.message }; return "unreachable"`,
      )

      expect(result.output).toMatchObject({ output: "fetch stopped after following 10 redirects" })
      // The request itself and the 10 redirects after it.
      expect(hits).toEqual(Array(11).fill("GET /loop"))
    }),
  )

  // The same rules fetch applies itself: a 303 turns a write into a read that has no body, and so does a 301 or 302 for
  // a POST. Every other redirect repeats the request.
  web.live("repeats or rewrites the request the way fetch does", () =>
    Effect.gen(function* () {
      const { hits, requests, origin } = yield* serve
      yield* seed([{ action: "*", resource: "*", effect: "allow" }])

      for (const [method, path, followed, kept] of [
        ["POST", "/moved", "GET", false],
        ["PUT", "/moved", "PUT", true],
        ["POST", "/see-other", "GET", false],
        ["PUT", "/see-other", "GET", false],
        ["POST", "/temporary", "POST", true],
        ["POST", "/permanent", "POST", true],
        ["PUT", "/permanent", "PUT", true],
      ] as const) {
        hits.length = 0
        requests.length = 0
        yield* run(
          `await fetch("${origin}${path}", { method: "${method}", body: "payload", headers: { "content-type": "text/plain" } })`,
        )

        expect(hits).toEqual([`${method} ${path}`, `${followed} /landed`])
        expect(requests.map((request) => [request.body, request.headers.get("content-type")])).toEqual([
          ["payload", "text/plain"],
          kept ? ["payload", "text/plain"] : ["", null],
        ])
      }

      hits.length = 0
      yield* run(`await fetch("${origin}/see-other", { method: "head" })`)
      expect(hits).toEqual(["HEAD /see-other", "HEAD /landed"])
    }),
  )

  web.live("takes its credentials along inside an origin and leaves them behind when a redirect leaves it", () =>
    Effect.gen(function* () {
      const { requests, origin } = yield* serve
      yield* seed([{ action: "*", resource: "*", effect: "allow" }])
      const headers = `{ headers: { authorization: "Bearer token", cookie: "a=1", "x-trace": "t" } }`
      const sent = () =>
        requests.map((request) => ["authorization", "cookie", "x-trace"].map((name) => request.headers.get(name)))

      yield* run(`await fetch("${origin}/within", ${headers})`)
      expect(sent()).toEqual([
        ["Bearer token", "a=1", "t"],
        ["Bearer token", "a=1", "t"],
      ])

      requests.length = 0
      yield* run(`await fetch("${origin}/to-local", ${headers})`)
      expect(sent()).toEqual([
        ["Bearer token", "a=1", "t"],
        [null, null, "t"],
      ])
    }),
  )

  web.live("stops asking when the execution is interrupted with a redirect still waiting for an answer", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const fiber = yield* run(`return await (await fetch("${origin}/to-local")).text()`).pipe(Effect.forkScoped)

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "once" })
      yield* nextRequest()
      yield* Fiber.interrupt(fiber)

      // The ask goes with the execution, not at some later point when nobody is waiting for it.
      for (let attempt = 0; attempt < 200 && (yield* permission.list()).length > 0; attempt++)
        yield* Effect.sleep("5 millis")
      expect(yield* permission.list()).toEqual([])
      expect(hits).toEqual(["GET /to-local"])
    }),
  )

  web.live("asks about a redirect in the context of the execution, not in a new root fiber", () =>
    Effect.gen(function* () {
      const { origin, local } = yield* serve
      yield* seed()
      const permission = yield* Permission.Service
      const hooks = yield* PluginHooks.Service
      // The minimum log level stands for what the context of an execution holds besides its services, such as loggers and
      // a tracer: a hook sees it for each request the program makes, and a root fiber has only the default.
      const seen: Array<readonly [string, string]> = []
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.service(References.MinimumLogLevel).pipe(
          Effect.map((level) => void seen.push([event.resources[0], level])),
        ),
      )
      const fiber = yield* run(`return await (await fetch("${origin}/to-local")).text()`).pipe(
        Effect.provideService(References.MinimumLogLevel, "Error"),
        Effect.forkScoped,
      )

      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "once" })
      yield* permission.reply({ requestID: (yield* nextRequest()).id, reply: "once" })
      yield* Fiber.join(fiber)

      // The redirect is asked about where the program's own request is, not in a root fiber that has only the defaults.
      expect(seen).toEqual([
        [`${origin}/to-local`, "Error"],
        [`${local}/landed`, "Error"],
      ])
    }),
  )
})

// A request that nobody approved, for an address on this machine or the networks around it, is not one the user could
// have meant. The address is checked after the ask, whatever the rules say.
describe("CodeMode fetch addresses", () => {
  const failures = (urls: ReadonlyArray<string>) =>
    run(
      `const out = []
       for (const url of ${JSON.stringify(urls)}) { try { await fetch(url); out.push("sent") } catch (e) { out.push(e.message) } }
       return out`,
    ).pipe(Effect.map((result) => JSON.parse(result.output.output) as ReadonlyArray<string>))
  const allowAll: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
  const hint = " Set experimental.allow_local_fetch to true in the configuration to let fetch reach local servers."

  web.live("refuses this machine and the private networks unless the configuration allows local servers", () =>
    Effect.gen(function* () {
      const { hits, origin, local } = yield* serve
      yield* seed(allowAll, { local: false })
      const port = new URL(origin).port

      expect(
        yield* failures([
          `${origin}/a`,
          `${local}/a`,
          `http://0x7f.1:${port}/a`,
          `http://[::1]:${port}/a`,
          "http://10.0.0.1/",
          "http://192.168.1.1:8080/",
        ]),
      ).toEqual([
        `fetch cannot reach 127.0.0.1: it is a loopback address.${hint}`,
        `fetch cannot reach localhost (127.0.0.1): it is a loopback address.${hint}`,
        `fetch cannot reach 127.0.0.1: it is a loopback address.${hint}`,
        `fetch cannot reach [::1]: it is a loopback address.${hint}`,
        `fetch cannot reach 10.0.0.1: it is a private network address.${hint}`,
        `fetch cannot reach 192.168.1.1: it is a private network address.${hint}`,
      ])
      expect(hits).toEqual([])
    }),
  )

  web.live("refuses link-local and cloud metadata addresses even when local servers are allowed", () =>
    Effect.gen(function* () {
      yield* seed(allowAll)

      expect(
        yield* failures([
          "http://169.254.169.254/latest/meta-data/",
          "http://0xa9fea9fe/",
          "http://[::ffff:169.254.169.254]/",
          "http://[fd00:ec2::254]/",
          // The IPv6 endpoints of the other clouds' credentials, inside the unique local range that is otherwise only private.
          "http://[fd20:ce::254]/",
          "http://[fd00:c1::a9fe:a9fe]/",
          "http://[fd00:ec2::23]/",
          // The Akamai (Linode) and Scaleway metadata services, which have an IPv6 address in the same range.
          "http://[fd00:a9fe:a9fe::1]/v1/token",
          "http://[fd00:42::42]/conf",
          "http://100.100.100.200/",
          // Oracle Cloud Infrastructure Classic, inside a range that is otherwise only private.
          "http://192.0.0.192/",
          // An IPv6 address that a translator or a tunnel delivers to the metadata address.
          "http://[64:ff9b::a9fe:a9fe]/",
          "http://[64:ff9b:1::a9fe:a9fe]/",
          "http://[2002:a9fe:a9fe::]/",
          "http://[2001:0:4136:e378:8000:63bf:5601:5601]/",
          "http://169.254.1.1/",
          "http://[fe80::1]/",
        ]),
      ).toEqual([
        "fetch cannot reach 169.254.169.254: it is a cloud metadata address.",
        "fetch cannot reach 169.254.169.254: it is a cloud metadata address.",
        "fetch cannot reach [::ffff:a9fe:a9fe]: it is a cloud metadata address.",
        "fetch cannot reach [fd00:ec2::254]: it is a cloud metadata address.",
        "fetch cannot reach [fd20:ce::254]: it is a cloud metadata address.",
        "fetch cannot reach [fd00:c1::a9fe:a9fe]: it is a cloud metadata address.",
        "fetch cannot reach [fd00:ec2::23]: it is a cloud metadata address.",
        "fetch cannot reach [fd00:a9fe:a9fe::1]: it is a cloud metadata address.",
        "fetch cannot reach [fd00:42::42]: it is a cloud metadata address.",
        "fetch cannot reach 100.100.100.200: it is a cloud metadata address.",
        "fetch cannot reach 192.0.0.192: it is a cloud metadata address.",
        "fetch cannot reach [64:ff9b::a9fe:a9fe]: it is a cloud metadata address.",
        "fetch cannot reach [64:ff9b:1::a9fe:a9fe]: it is a cloud metadata address.",
        "fetch cannot reach [2002:a9fe:a9fe::]: it is a cloud metadata address.",
        "fetch cannot reach [2001:0:4136:e378:8000:63bf:5601:5601]: it is a cloud metadata address.",
        "fetch cannot reach 169.254.1.1: it is a link-local address.",
        "fetch cannot reach [fe80::1]: it is a link-local address.",
      ])
    }),
  )

  web.live("refuses a redirect to a metadata address, and sends nothing to it", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed(allowAll)

      const result = yield* run(
        `try { await fetch("${origin}/to-metadata") } catch (e) { return e.message }; return "unreachable"`,
      )

      expect(result.output).toMatchObject({
        output: "fetch cannot reach 169.254.169.254: it is a cloud metadata address.",
        toolCalls: [{ tool: "fetch", status: "error" }],
      })
      expect(hits).toEqual(["GET /to-metadata"])
    }),
  )

  web.live("asks first and refuses afterwards, so a host nobody approved is never looked up", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed([], { local: false })
      const permission = yield* Permission.Service
      const fiber = yield* run(
        `try { await fetch("${origin}/a") } catch (e) { return e.message }; return "unreachable"`,
      ).pipe(Effect.forkScoped)

      const request = yield* nextRequest()
      expect(request.resources).toEqual([`${origin}/a`])
      yield* permission.reply({ requestID: request.id, reply: "once" })

      expect((yield* Fiber.join(fiber)).output).toMatchObject({
        output: `fetch cannot reach 127.0.0.1: it is a loopback address.${hint}`,
      })
      expect(hits).toEqual([])
    }),
  )

  web.live("reads the allowance for local servers from the configuration, and follows a change to it", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed(allowAll, { local: false })
      const config = yield* Config.Test
      const updates = yield* PubSub.unbounded<ReturnType<typeof updated>>()
      yield* ConfigWebPlugin.Plugin.effect(host({ event: { subscribe: () => Stream.fromPubSub(updates) } }))
      const outcome = run(
        `try { return await (await fetch("${origin}/a")).text() } catch (e) { return e.message }`,
      ).pipe(Effect.map((result) => result.output.output))
      const setting = (allow: boolean) =>
        config.setEntries([
          new Document({
            type: "document",
            info: new Info({ experimental: new ConfigExperimental.Info({ allow_local_fetch: allow }) }),
          }),
        ])
      // The plugin picks a change up from the event, a moment after it is published.
      const settles = Effect.fn(function* (expected: string) {
        yield* PubSub.publish(updates, updated())
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((yield* outcome) === expected) return
          yield* Effect.sleep("10 millis")
        }
        expect(yield* outcome).toBe(expected)
      })

      expect(yield* outcome).toBe(`fetch cannot reach 127.0.0.1: it is a loopback address.${hint}`)
      expect(hits).toEqual([])

      yield* setting(true)
      yield* settles("served")

      yield* setting(false)
      yield* settles(`fetch cannot reach 127.0.0.1: it is a loopback address.${hint}`)
    }).pipe(Effect.provide(Config.testLayer())),
  )
})

// A request goes to the addresses that it was checked as, and the name only says what it is for. A name is resolved again
// by whatever connects to it, and an attacker's name can answer differently the second time (DNS rebinding), so these
// tests use names under .test, which no resolver leads anywhere: a request reaches the local server only by connecting
// to the address that the configuration's resolver answered with.
describe("CodeMode fetch connections", () => {
  const allowAll: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
  const resolving = Effect.fn(function* (lookup: (name: string) => Promise<ReadonlyArray<string>>) {
    const tools = yield* Tool.Service
    yield* tools.transform((editor) => editor.web({ lookup }))
  })
  const attempt = (url: string, init = "") =>
    run(`try { return await (await fetch("${url}"${init})).text() } catch (e) { return e.message }`).pipe(
      Effect.map((result) => result.output.output),
    )

  web.live("connects to the address that was checked, and the name only goes in the Host header", () =>
    Effect.gen(function* () {
      const { hits, requests, server } = yield* serve
      yield* seed(allowAll)
      const asked: Array<string> = []
      // The first answer is a place that may be reached, which the local server stands in for, and every later one is the
      // metadata service, as a name that rebinds would give.
      yield* resolving(async (name) => {
        asked.push(name)
        return asked.length === 1 ? ["127.0.0.1"] : ["169.254.169.254"]
      })
      const url = `http://rebind.example.test:${server.port}`

      expect(yield* attempt(`${url}/first`)).toBe("served")

      expect(hits).toEqual(["GET /first"])
      expect(requests[0].headers.get("host")).toBe(`rebind.example.test:${server.port}`)
      // The answer that was checked is the one that was connected to, so nothing resolved the name again for the connection.
      expect(asked).toEqual(["rebind.example.test"])

      // The next request is checked on its own, and the answer it gets now is the metadata service.
      expect(yield* attempt(`${url}/second`)).toBe(
        "fetch cannot reach rebind.example.test (169.254.169.254): it is a cloud metadata address.",
      )
      expect(hits).toEqual(["GET /first"])
    }),
  )

  web.live("keeps a Host header that the program sets", () =>
    Effect.gen(function* () {
      const { requests, server } = yield* serve
      yield* seed(allowAll)
      yield* resolving(async () => ["127.0.0.1"])

      const init = `, { headers: { host: "virtual.example.test" } }`
      expect(yield* attempt(`http://named.example.test:${server.port}/a`, init)).toBe("served")

      expect(requests.map((request) => request.headers.get("host"))).toEqual(["virtual.example.test"])
    }),
  )

  web.live("connects to the addresses that were checked for each redirect, and for a redirect only", () =>
    Effect.gen(function* () {
      const { hits, requests, origin } = yield* serve
      yield* seed(allowAll)
      const asked: Array<string> = []
      yield* resolving(async (name) => {
        asked.push(name)
        return ["127.0.0.1"]
      })

      // The first request is to an address, which nothing resolves; the redirect names a host that something has to.
      expect(yield* attempt(`${origin}/to-name`)).toBe("served")

      expect(hits).toEqual(["GET /to-name", "GET /landed"])
      expect(asked).toEqual(["hop.example.test"])
      expect(requests.map((request) => request.headers.get("host"))).toEqual([
        new URL(origin).host,
        `hop.example.test:${new URL(origin).port}`,
      ])
    }),
  )

  web.live("reports the name that a request was for, and not the address it went to", () =>
    Effect.gen(function* () {
      const { server } = yield* serve
      yield* seed(allowAll)
      yield* resolving(async () => ["127.0.0.1"])
      const url = `http://reported.example.test:${server.port}/page?x=1`

      const result = yield* run(
        `const reply = await fetch("${url}#top"); return [reply.url, reply.redirected, await reply.text()]`,
      )

      expect(JSON.parse(result.output.output)).toEqual([url, false, "served"])
    }),
  )

  web.live("refuses a redirect to a name that now leads to the metadata service, and sends nothing to it", () =>
    Effect.gen(function* () {
      const { hits, origin } = yield* serve
      yield* seed(allowAll)
      yield* resolving(async () => ["169.254.169.254"])

      expect(yield* attempt(`${origin}/to-name`)).toBe(
        "fetch cannot reach hop.example.test (169.254.169.254): it is a cloud metadata address.",
      )
      expect(hits).toEqual(["GET /to-name"])
    }),
  )

  web.live("refuses a name that does not resolve, whether the resolver fails or has no answer", () =>
    Effect.gen(function* () {
      const { hits, server } = yield* serve
      yield* seed(allowAll)
      const answers = [async () => Promise.reject(new Error("SERVFAIL")), async () => []]
      const refused = "fetch cannot reach gone.example.test: it does not resolve to an address."

      for (const answer of answers) {
        yield* resolving(answer)
        expect(yield* attempt(`http://gone.example.test:${server.port}/a`)).toBe(refused)
      }
      expect(hits).toEqual([])
    }),
  )

  // Without a resolver of its own the configuration asks the system's. A name under .invalid is reserved to never resolve,
  // and a request to it used to be sent on, to fail only when fetch resolved it again for the connection.
  web.live(
    "refuses a name that the system resolver does not know",
    () =>
      Effect.gen(function* () {
        const { hits, server } = yield* serve
        yield* seed(allowAll)

        expect(yield* attempt(`http://orbit-no-such-host.invalid:${server.port}/a`)).toBe(
          "fetch cannot reach orbit-no-such-host.invalid: it does not resolve to an address.",
        )
        expect(hits).toEqual([])
      }),
    30_000,
  )

  web.live("tries the next address when nothing listens at the one before, and sends the request once", () =>
    Effect.gen(function* () {
      const { hits, server } = yield* serve
      yield* seed(allowAll)
      // Nothing listens at 127.0.0.2, as a server on localhost can listen on only one of its two addresses.
      yield* resolving(async () => ["127.0.0.2", "127.0.0.1"])

      expect(yield* attempt(`http://either.example.test:${server.port}/a`)).toBe("served")
      expect(hits).toEqual(["GET /a"])
    }),
  )

  describe("over TLS", () => {
    // The certificate of the test server is valid for localhost and 127.0.0.1, and is issued by a private test CA.
    const fixture = (name: string) => path.join(import.meta.dir, "..", "..", "util", "test", "fixture", "tls", name)
    const secure = Effect.acquireRelease(
      Effect.promise(async () => {
        const hits: Array<string> = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          tls: {
            cert: await Bun.file(fixture("server.pem")).text(),
            key: await Bun.file(fixture("server.key")).text(),
          },
          fetch: (request) => {
            hits.push(`${request.method} ${new URL(request.url).pathname}`)
            return new Response("served over TLS")
          },
        })
        return { hits, server }
      }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    )
    // What `orb` installs for every request it makes, a program's fetch included: it trusts the private CA.
    const trusting = Effect.acquireRelease(
      Effect.sync(() => {
        const original = globalThis.fetch
        Network.install({ ORBIT_CA_CERTS: fixture("ca.pem") })
        return original
      }),
      (original) =>
        Effect.sync(() => {
          globalThis.fetch = original
        }),
    )

    web.live("checks the certificate against the name that the request is for, and not the address", () =>
      Effect.gen(function* () {
        const { hits, server } = yield* secure
        yield* seed(allowAll)
        yield* resolving(async () => ["127.0.0.1"])

        // Checking the name does not replace checking the chain: the CA of the certificate is not trusted yet.
        expect(yield* attempt(`https://localhost:${server.port}/untrusted`)).not.toBe("served over TLS")
        expect(hits).toEqual([])

        yield* trusting
        // localhost is in the certificate. The request goes to 127.0.0.1 and is for localhost, so the certificate is
        // checked for the name; an address is connected to as it is, and the certificate is valid for this one too.
        expect(yield* attempt(`https://localhost:${server.port}/name`)).toBe("served over TLS")
        expect(yield* attempt(`https://127.0.0.1:${server.port}/address`)).toBe("served over TLS")
        expect(hits).toEqual(["GET /name", "GET /address"])

        // The certificate is valid for 127.0.0.1, where this name is sent, but not for the name, and it is the name that
        // the error blames.
        expect(yield* attempt(`https://other.example.test:${server.port}/other`)).toMatch(
          /altnames: Host: other\.example\.test/,
        )
        expect(hits).toEqual(["GET /name", "GET /address"])
      }),
    )
  })
})

function updated() {
  return { id: Event.ID.create(), created: Date.now(), type: "config.updated" as const, data: {} }
}
