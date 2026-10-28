// clients-ux-23 part 1: `GET /api/session/:sessionID/context/usage` answers context-memory-8's analysis of what the next
// request would carry, by category. It reads a folder's instruction sources for a session with no baseline yet and runs
// the `context` hooks, so it asks `requireTrusted()` for the session's own Location first (classes 1, 3 and 12), sends
// nothing to a model and records nothing (classes 6 and 12), and carries every refusal typed (classes 7 and 13).
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Orbit } from "@orbit/client"
import { App } from "@orbit/core/app"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { EventTable } from "@orbit/core/event/sql"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { ModelsDev } from "@orbit/core/models-dev"
import { Session } from "@orbit/core/session"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable } from "@orbit/core/session/sql"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { Agent } from "@orbit/schema/agent"
import { Location } from "@orbit/schema/location"
import { AbsolutePath } from "@orbit/schema/schema"
import { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "usage-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

const MARKER = "CONTEXT-USAGE-MARKER"
const DEFERRED = ["mcp-deferred", "tools-deferred"]
const RESERVE = ["auto-buffer", "compact-buffer"]

type Answer = { readonly status: number; readonly text: string; readonly body: Record<string, unknown> }

/**
 * A real server over an in-memory database, with a temporary home, global config folder and project. `trusted: false`
 * trusts no folder until a test grants one through the trust route (`implicit: false`). `project` names the project's
 * folder; `managed` points the administrator's settings at a folder whose ORBIT.md cannot be read while
 * `unreadable.managed` is set.
 */
const server = (
  options: { readonly trusted?: boolean; readonly provider?: boolean; readonly managed?: string; readonly project?: string } = {},
) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-context-usage-")).path
    const home = path.join(root, "home")
    const config = path.join(root, "config")
    const project = path.join(root, options.project ?? "project")
    const other = path.join(root, "other")
    yield* Effect.promise(() => Promise.all([home, config, project, other].map((dir) => fs.mkdir(dir, { recursive: true }))))
    yield* Effect.promise(() => Bun.$`git init -q`.cwd(project).quiet())
    yield* Effect.promise(() => Bun.$`git init -q`.cwd(other).quiet())
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("side", "side_text") })))
    const unreadable = { managed: false }
    const reads: string[] = []
    const replacements: LayerNode.Replacements = [
      Global.node.replace(
        Global.layerWith({
          home,
          config,
          data: path.join(root, "data"),
          cache: path.join(root, "cache"),
          state: path.join(root, "state"),
          tmp: path.join(root, "tmp"),
        }),
      ),
      Database.node.replace(Database.configured({ path: ":memory:" })),
      Bus.node.replace(Bus.node),
      App.node.replace(App.node),
      ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      // Records every file read, and makes the administrator's ORBIT.md unreadable while `unreadable.managed` is set.
      FSUtil.node.replace(
        Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                readFileStringSafe: (file) =>
                  Effect.sync(() => reads.push(file)).pipe(
                    Effect.andThen(
                      unreadable.managed &&
                        path.basename(file) === "ORBIT.md" &&
                        path.dirname(file).toLowerCase() === options.managed?.toLowerCase()
                        ? Effect.undefined
                        : fs.readFileStringSafe(file),
                    ),
                  ),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
      ),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: options.trusted ?? true })),
      llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
      ...(options.provider === false
        ? []
        : [
            SessionRunnerModel.node.replace(
              Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
            ),
          ]),
      ...(options.managed ? [ManagedSettings.node.replace(ManagedSettings.configured({ directory: options.managed }))] : []),
    ]
    const context = yield* Layer.build(createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const sessions = Context.get(context, Session.Service)
    const db = Context.get(context, Database.Service).db
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const send = (url: string, init?: RequestInit) =>
      Effect.promise(async (): Promise<Answer> => {
        const response = await handler(new Request(`http://orbit.local${url}`, init))
        const text = await response.text()
        return { status: response.status, text, body: text ? JSON.parse(text) : {} }
      })
    const rows = (table: typeof InstructionStateTable | typeof SessionMessageTable | typeof SessionInboxTable | typeof EventTable) =>
      db
        .select()
        .from(table)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((found) => found.length),
        )
    return {
      root,
      project,
      other,
      llm,
      reads,
      unreadable,
      sessions,
      rows,
      handler,
      write: (file: string, text: string) =>
        Effect.promise(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, text)
        }),
      /** Trusts a folder until the server stops, or ends every grant for it. */
      trust: (directory: string, trusted: boolean) =>
        send(`/api/location/trust?location[directory]=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(trusted ? { trust: true, persist: false } : { trust: false }),
        }).pipe(Effect.tap((answer) => Effect.sync(() => expect(answer.status).toBe(200)))),
      /** A session started in `directory`, which is the project by default. */
      session: (directory = project, agent = "build") =>
        sessions.create({
          id: Session.ID.create(),
          agent: Agent.ID.make(agent),
          model: model.ref,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        }),
      /** Runs one step that calls a tool and then answers. A side request (the title) has no tools and gets text. */
      step: (id: Session.ID, text: string) =>
        Effect.gen(function* () {
          const script: TestLLM.Response[] = [
            TestLLM.tool(`call_${text}`, "Read", { file_path: path.join(project, "notes.txt") }),
            TestLLM.textWithUsage(`answer ${text}`, `text_${text}`, 4_000),
          ]
          yield* llm.serve((request) =>
            (request.tools?.length ?? 0) > 0
              ? (script.shift() ?? TestLLM.text("done", `done_${text}`))
              : TestLLM.text("side", "side_text"),
          )
          yield* sessions.prompt({ sessionID: id, text, resume: false })
          yield* sessions.resume(id)
        }),
      /** The route, with `directory` in the header that names a request's folder when it is set. */
      usage: (id: string, directory?: string) =>
        send(`/api/session/${id}/context/usage`, {
          headers: directory === undefined ? {} : { "x-orbit-directory": encodeURIComponent(directory) },
        }),
    }
  })

const decode = Schema.decodeUnknownSync(SessionContextUsage.Info)

// SV1, the plan's "sum ≤ limit": the rows that count, the reserve and the free space never pass the window, and equal it
// while there is free space left. Deferred rows are listed but count in no sum.
it.live("rows without deferred ones, the reserve and free space never pass the window, and equal it while free space is above 0", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`)
    yield* s.write(path.join(s.project, "notes.txt"), "notes ".repeat(500))
    const session = yield* s.session()
    yield* s.step(session.id, "first")

    const answer = yield* s.usage(session.id)
    expect(answer.status).toBe(200)
    const info = decode(answer.body.data)
    expect(info.window).toBe(200_000)
    expect(info.messages.toolCalls + info.messages.toolResults).toBeGreaterThan(0)
    const sum = info.categories
      .filter((item) => !DEFERRED.includes(item.kind))
      .reduce((total, item) => total + item.tokens, 0)
    const free = info.categories.find((item) => item.kind === "free")?.tokens ?? 0
    expect(info.categories.some((item) => RESERVE.includes(item.kind))).toBe(true)
    expect(sum).toBeLessThanOrEqual(info.window!)
    expect(free).toBeGreaterThan(0)
    expect(sum).toBe(info.window!)
  }).pipe(Effect.scoped),
)

// SV2, classes 1, 12 and 14: a folder that is not trusted (built with `implicit: false`) gets 403 before anything of it is
// read, with no marker text in the body and no baseline stored; the trusted control lists the marker's file. A session
// whose baseline was stored while trusted is refused too once its folder is not, since the hooks would read
// `system_prompt_file`.
it.live("an untrusted folder is refused before any instruction file is read, and the trusted control lists the marker", () =>
  Effect.gen(function* () {
    const rows = [
      { name: "fresh untrusted", grant: false, stored: false, status: 403 },
      { name: "fresh trusted", grant: true, stored: false, status: 200 },
      { name: "stored baseline, then untrusted", grant: true, stored: true, status: 403 },
    ]
    for (const row of rows) {
      const s = yield* server({ trusted: false })
      const marker = path.join(s.project, "ORBIT.md")
      yield* s.write(marker, `rules ${MARKER}`)
      yield* s.write(path.join(s.project, "notes.txt"), "notes")
      if (row.grant) yield* s.trust(s.project, true)
      const session = yield* s.session()
      if (row.stored) {
        yield* s.step(session.id, "first")
        expect(yield* s.rows(InstructionStateTable)).toBeGreaterThan(0)
        yield* s.trust(s.project, false)
      }
      const states = yield* s.rows(InstructionStateTable)
      s.reads.length = 0

      const answer = yield* s.usage(session.id)

      expect({ row: row.name, status: answer.status }).toEqual({ row: row.name, status: row.status })
      if (row.status === 403) {
        expect(answer.body._tag).toBe("UntrustedFolderError")
        expect(answer.text).not.toContain(MARKER)
        expect(answer.text).not.toContain("ORBIT.md")
        expect(s.reads.filter((file) => file.endsWith(".md"))).toEqual([])
        expect(yield* s.rows(InstructionStateTable)).toBe(states)
        continue
      }
      expect(decode(answer.body.data).files.map((file) => file.path)).toContain(marker)
    }
  }).pipe(Effect.scoped),
)

// SV3, class 3: the folder checked is the session's own. A request whose header names a trusted folder does not open an
// untrusted session's folder, and one that names an untrusted folder does not close a trusted session's.
it.live("the folder checked is the session's own, not the folder the request names", () =>
  Effect.gen(function* () {
    const s = yield* server({ trusted: false })
    yield* s.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`)
    yield* s.write(path.join(s.other, "ORBIT.md"), "other rules")
    yield* s.trust(s.other, true)
    const untrusted = yield* s.session(s.project)
    const trusted = yield* s.session(s.other)

    const refused = yield* s.usage(untrusted.id, s.other)
    expect(refused.status).toBe(403)
    expect(refused.body._tag).toBe("UntrustedFolderError")
    expect(refused.text).not.toContain(MARKER)

    const answered = yield* s.usage(trusted.id, s.project)
    expect(answered.status).toBe(200)
    const files = decode(answered.body.data).files.map((file) => file.path)
    expect(files).toContain(path.join(s.other, "ORBIT.md"))
    expect(files).not.toContain(path.join(s.project, "ORBIT.md"))
  }).pipe(Effect.scoped),
)

// SV4, class 13: a child session is refused with a typed 409 that names its parent, before any source is read.
it.live("a child session is refused with MainSessionOnlyError naming its parent", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`)
    const parent = yield* s.session()
    const child = yield* s.sessions.create({ id: Session.ID.create(), parentID: parent.id, agent: Agent.ID.make("build") })

    const answer = yield* s.usage(child.id)

    expect(answer.status).toBe(409)
    expect(answer.body).toMatchObject({ _tag: "MainSessionOnlyError", sessionID: child.id, parentID: parent.id })
    expect(String(answer.body.message)).toContain(parent.id)
    expect(answer.text).not.toContain(MARKER)
  }).pipe(Effect.scoped),
)

// SV5, class 7: each failure has its own typed answer.
it.live("unknown session, unresolvable model, unknown agent and a blocked source are typed errors", () =>
  Effect.gen(function* () {
    const missing = yield* (yield* server()).usage("ses_context_usage_missing")
    expect({ status: missing.status, tag: missing.body._tag }).toEqual({ status: 404, tag: "SessionNotFoundError" })

    const unresolved = yield* server({ provider: false })
    const unknownModel = yield* unresolved.usage((yield* unresolved.session()).id)
    expect({ status: unknownModel.status, tag: unknownModel.body._tag, service: unknownModel.body.service }).toEqual({
      status: 503,
      tag: "ServiceUnavailableError",
      service: "model",
    })

    const agents = yield* server()
    const unknownAgent = yield* agents.usage((yield* agents.session(agents.project, "no-such-agent")).id)
    expect({ status: unknownAgent.status, tag: unknownAgent.body._tag, agent: unknownAgent.body.agentID }).toEqual({
      status: 404,
      tag: "AgentNotFoundError",
      agent: "no-such-agent",
    })

    const managed = path.join((yield* tmpdirScoped("orbit-context-usage-managed-")).path, "managed")
    const blocked = yield* server({ managed })
    yield* blocked.write(path.join(managed, "ORBIT.md"), "policy")
    blocked.unreadable.managed = true
    const unavailable = yield* blocked.usage((yield* blocked.session()).id)
    expect({ status: unavailable.status, tag: unavailable.body._tag, service: unavailable.body.service }).toEqual({
      status: 503,
      tag: "ServiceUnavailableError",
      service: "instructions",
    })
    expect(String(unavailable.body.message)).toContain("core/instructions")
  }).pipe(Effect.scoped),
)

// SV6, classes 6 and 12: the route is read only. It asks no model, and adds no message, durable event or inbox row.
it.live("the route sends no model request and records nothing", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`)
    yield* s.write(path.join(s.project, "notes.txt"), "notes")
    const used = yield* s.session()
    yield* s.step(used.id, "first")
    const fresh = yield* s.session()
    const before = {
      requests: (yield* s.llm.requests()).length,
      messages: yield* s.rows(SessionMessageTable),
      events: yield* s.rows(EventTable),
      inbox: yield* s.rows(SessionInboxTable),
      states: yield* s.rows(InstructionStateTable),
    }

    expect((yield* s.usage(used.id)).status).toBe(200)
    expect((yield* s.usage(fresh.id)).status).toBe(200)
    yield* Effect.sleep("200 millis")

    expect({
      requests: (yield* s.llm.requests()).length,
      messages: yield* s.rows(SessionMessageTable),
      events: yield* s.rows(EventTable),
      inbox: yield* s.rows(SessionInboxTable),
      states: yield* s.rows(InstructionStateTable),
    }).toEqual(before)
  }).pipe(Effect.scoped),
)

// SV7, class 9 (the wire half) and the SDK entry point: the generated client hands back the payload as the server sent it,
// a folder name that holds a pipe and an escape character included (Windows names cannot hold either, so there the name
// holds a space, a hash and an accent). Escaping is each client's own, at its sink.
it.live("the generated client returns the payload with every string unchanged", () =>
  Effect.gen(function* () {
    const name = process.platform === "win32" ? "proj #é" : "proj|\x1b]0;x\x07"
    const s = yield* server({ project: name })
    yield* s.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`)
    const session = yield* s.session()
    const client = Orbit.make({
      baseUrl: "http://orbit.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => s.handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })

    const viaClient = yield* Effect.promise(() => client.session.contextUsage({ sessionID: session.id }))
    const raw = yield* s.usage(session.id)

    expect(viaClient).toEqual(raw.body.data as typeof viaClient)
    const info = decode(viaClient)
    expect(info.files.map((file) => file.path)).toContain(path.join(s.root, name, "ORBIT.md"))

    // The typed refusal reaches an SDK caller as an error it can narrow.
    const child = yield* s.sessions.create({ id: Session.ID.create(), parentID: session.id, agent: Agent.ID.make("build") })
    const refused = yield* Effect.promise(() =>
      client.session.contextUsage({ sessionID: child.id }).then(
        () => undefined,
        (error: unknown) => error as { _tag?: string; parentID?: string },
      ),
    )
    expect(refused).toMatchObject({ _tag: "MainSessionOnlyError", parentID: session.id })
  }).pipe(Effect.scoped),
)
