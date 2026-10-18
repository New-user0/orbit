import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { App } from "@orbit/core/app"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { ModelsDev } from "@orbit/core/models-dev"
import { Session } from "@orbit/core/session"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Agent } from "@orbit/schema/agent"
import { Document, Info } from "@orbit/schema/config"
import { Location } from "@orbit/schema/location"
import { AbsolutePath } from "@orbit/schema/schema"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "note-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

// A real server with the file watcher off, so that whatever the list holds after a note came from the explicit rescan.
// HOME is not isolated for the whole process, so these tests post only the project scope and read the user target by GET.
const server = (options: { readonly excludes?: (project: string) => string[] } = {}) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-note-")).path
    const home = path.join(root, "home")
    const config = path.join(root, "config")
    const project = path.join(root, "project")
    yield* Effect.promise(() => Promise.all([home, config, project].map((dir) => fs.mkdir(dir, { recursive: true }))))
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("side", "side_text") })))
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
      App.node.replace(App.node),
      Bus.node.replace(Bus.node),
      ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: true })),
      llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
      SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) })),
      ...(options.excludes
        ? [
            Config.node.replace(
              Config.testLayer([
                new Document({
                  type: "document",
                  scope: "user",
                  info: new Info({ instructions_exclude: options.excludes(project) }),
                }),
              ]),
            ),
          ]
        : []),
    ]
    const context = yield* Layer.build(createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const sessions = Context.get(context, Session.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const query = `?location[directory]=${encodeURIComponent(project)}`
    return {
      root,
      config,
      project,
      targets: () =>
        Effect.promise(() => handler(new Request(`http://orbit.local/api/location/instructions/note${query}`))),
      post: (body: unknown) =>
        Effect.promise(() =>
          handler(
            new Request(`http://orbit.local/api/location/instructions/note${query}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        ),
      preview: (id: string) =>
        Effect.promise(async () => {
          const response = await handler(new Request(`http://orbit.local/api/experimental/session/${id}/instructions`))
          expect(response.status).toBe(200)
          return (await response.json()) as { data: { initial?: string; update?: string; status: { files: { path: string }[] } } }
        }),
      session: () =>
        sessions.create({
          id: Session.ID.create(),
          agent: Agent.ID.make("build"),
          model: model.ref,
          location: Location.Ref.make({ directory: AbsolutePath.make(project) }),
        }),
    }
  })

it.live("lists three targets with absolute paths, in the order user, project, local", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const response = yield* s.targets()
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { data: { scope: string; path: string }[] }
    expect(body.data.map((item) => item.scope)).toEqual(["user", "project", "local"])
    for (const item of body.data) expect(path.isAbsolute(item.path)).toBe(true)
    expect(body.data.map((item) => path.basename(item.path))).toEqual(["ORBIT.md", "AGENTS.md", "ORBIT.local.md"])
  }).pipe(Effect.scoped),
)

it.live("adds a project note, returns the written path as loaded, and a session preview then shows it", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const session = yield* s.session()
    const response = yield* s.post({ scope: "project", text: "  prefer bun  " })
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { data: { path: string; created: boolean; loaded: boolean } }
    expect(body.data).toMatchObject({ path: path.join(s.project, "AGENTS.md"), created: true, loaded: true })
    expect(yield* Effect.promise(() => fs.readFile(path.join(s.project, "AGENTS.md"), "utf8"))).toBe("- prefer bun\n")
    // The preview reads the session's location, whose instruction list the note changed: no watcher was running.
    const preview = (yield* s.preview(session.id)).data
    expect(`${preview.initial ?? ""}${preview.update ?? ""}`).toContain("prefer bun")
  }).pipe(Effect.scoped),
)

it.live("rejects empty, blank and over-long text and an unknown scope with a 400, and writes nothing", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const bodies = [
      { scope: "project", text: "" },
      { scope: "project", text: "  \n\t " },
      { scope: "project", text: "x".repeat(2_001) },
      { scope: "elsewhere", text: "x" },
    ]
    for (const body of bodies) expect((yield* s.post(body)).status).toBe(400)
    expect((yield* s.post({ scope: "project", text: "x".repeat(2_000) })).status).toBe(200)
    expect(yield* Effect.promise(() => fs.readdir(s.project))).toEqual(["AGENTS.md"])
  }).pipe(Effect.scoped),
)

it.live("answers 503 for the instructions service when the file's place holds a directory, and creates nothing", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* Effect.promise(() => fs.mkdir(path.join(s.project, "AGENTS.md")))
    const response = yield* s.post({ scope: "project", text: "x" })
    expect(response.status).toBe(503)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "ServiceUnavailableError", service: "instructions" })
    expect(yield* Effect.promise(() => fs.readdir(path.join(s.project, "AGENTS.md")))).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("carries a refusal as field scope with the reason as kind", () =>
  Effect.gen(function* () {
    const s = yield* server({ excludes: (project) => [path.join(project, "ORBIT.md").replaceAll("\\", "/")] })
    yield* Effect.promise(() => fs.writeFile(path.join(s.project, "ORBIT.md"), "kept\n"))
    const response = yield* s.post({ scope: "project", text: "x" })
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "InvalidRequestError", field: "scope", kind: "excluded" })
    expect(yield* Effect.promise(() => fs.readFile(path.join(s.project, "ORBIT.md"), "utf8"))).toBe("kept\n")
  }).pipe(Effect.scoped),
)
