// clients-ux-23 part 2: `GET /api/session/:sessionID/cost` answers the whole session's cost summary from database rows
// (FU-M2-026). It has no Location: it reads no folder, so it needs no trust gate and answers for a session in an
// untrusted folder without opening a file (class 12). An unknown session is a typed 404 (classes 7 and 13).
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { App } from "@orbit/core/app"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { ModelsDev } from "@orbit/core/models-dev"
import { Session } from "@orbit/core/session"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionTable } from "@orbit/core/session/sql"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Agent } from "@orbit/schema/agent"
import { Location } from "@orbit/schema/location"
import { AbsolutePath } from "@orbit/schema/schema"
import { SessionCost } from "@orbit/schema/session-cost"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "cost-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

const MARKER = "COST-ROUTE-MARKER"

const server = (options: { readonly trusted: boolean }) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-session-cost-")).path
    const project = path.join(root, "project")
    yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
    yield* Effect.promise(() => Bun.$`git init -q`.cwd(project).quiet())
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("side", "side_text") })))
    const reads: string[] = []
    const replacements: LayerNode.Replacements = [
      Global.node.replace(
        Global.layerWith({
          home: path.join(root, "home"),
          config: path.join(root, "config"),
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
      // Records every file the server reads.
      FSUtil.node.replace(
        Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                readFileStringSafe: (file) => Effect.sync(() => reads.push(file)).pipe(Effect.andThen(fs.readFileStringSafe(file))),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
      ),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: options.trusted })),
      llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
      SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) })),
    ]
    const context = yield* Layer.build(createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const sessions = Context.get(context, Session.Service)
    const db = Context.get(context, Database.Service).db
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    return {
      project,
      reads,
      db,
      llm,
      sessions,
      session: () =>
        sessions.create({
          id: Session.ID.create(),
          agent: Agent.ID.make("build"),
          model: model.ref,
          location: Location.Ref.make({ directory: AbsolutePath.make(project) }),
        }),
      cost: (id: string) =>
        Effect.promise(async () => {
          const response = await handler(new Request(`http://orbit.local/api/session/${id}/cost`))
          const text = await response.text()
          return { status: response.status, text, body: text ? JSON.parse(text) : {} }
        }),
    }
  })

const decode = Schema.decodeUnknownSync(SessionCost.Info)

// PS1: the route answers the summary, and an unknown session is a typed SessionNotFoundError.
it.live("the cost route answers the summary and refuses an unknown session with SessionNotFoundError", () =>
  Effect.gen(function* () {
    const s = yield* server({ trusted: true })
    const session = yield* s.session()
    yield* s.llm.serve(() => TestLLM.textWithUsage("answer", "text_cost", 4_000))
    yield* s.sessions.prompt({ sessionID: session.id, text: "hello", resume: false })
    yield* s.sessions.resume(session.id)
    // Spend the projector could not itemize: a rewind removed its response, so only the session's total holds it.
    yield* s.db.update(SessionTable).set({ cost: 0.25 }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)

    const answer = yield* s.cost(session.id)
    expect(answer.status).toBe(200)
    const info = decode(answer.body.data)
    expect(info.rows.length).toBeGreaterThan(0)
    expect(info.rows.reduce((sum, row) => sum + row.responses, 0)).toBeGreaterThan(0)
    expect(info.cost).toBeCloseTo(0.25)
    expect(info.other).toBeCloseTo(0.25)
    expect(info.lines).toEqual({ added: 0, removed: 0 })

    const missing = yield* s.cost("ses_cost_missing")
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ _tag: "SessionNotFoundError" })
  }).pipe(Effect.scoped),
)

// PS2, class 12: the route has no Location, so a session in a folder that is not trusted (`implicit: false`) is answered,
// and no file is opened, the folder's marker included.
it.live("the cost route answers for a session in an untrusted folder and reads no file", () =>
  Effect.gen(function* () {
    const s = yield* server({ trusted: false })
    yield* Effect.promise(() => Bun.write(path.join(s.project, "ORBIT.md"), `rules ${MARKER}`))
    const session = yield* s.session()
    s.reads.length = 0

    const answer = yield* s.cost(session.id)
    expect(answer.status).toBe(200)
    expect(answer.text).not.toContain(MARKER)
    expect(decode(answer.body.data).rows).toEqual([])
    expect(s.reads).toEqual([])
  }).pipe(Effect.scoped),
)
