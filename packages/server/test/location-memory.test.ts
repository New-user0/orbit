// clients-ux-42: `GET /api/location/memory` lists what `/memory` shows, and `POST /api/location/memory` makes one listed
// file or folder and returns where it really is. Both refuse a folder that is not trusted before any service looks at it
// (classes 1, 12), and every refusal reaches the client typed (class 13). A real embedded server, as
// `instruction-note.test.ts` builds it.
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { App } from "@orbit/core/app"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { ModelsDev } from "@orbit/core/models-dev"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LLMClient } from "../../ai/src"
import { TestLLM } from "../../ai/src/testing"
import { canLinkFile } from "../../core/test/fixture/symlink"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const linkType = process.platform === "win32" ? "junction" : "dir"

const server = (options: { readonly untrusted?: boolean; readonly configIsFile?: boolean } = {}) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-memory-")).path
    const home = path.join(root, "home")
    const config = path.join(root, "config")
    const data = path.join(root, "data")
    const project = path.join(root, "project")
    yield* Effect.promise(() => Promise.all([home, project].map((dir) => fs.mkdir(dir, { recursive: true }))))
    yield* Effect.promise(() => (options.configIsFile ? fs.writeFile(config, "not a folder") : fs.mkdir(config)))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(project, "orbit.json"),
        JSON.stringify({
          agents: {
            review: { memory: "user", description: "Reviews" },
            planner: { memory: "project", description: "Plans" },
            notes: { memory: "local", description: "Notes" },
          },
        }),
      ),
    )
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("side", "side_text") })))
    const replacements: LayerNode.Replacements = [
      Global.node.replace(
        Global.layerWith({
          home,
          config,
          data,
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
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: !options.untrusted })),
      llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    ]
    const context = yield* Layer.build(createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const url = `http://orbit.local/api/location/memory?location[directory]=${encodeURIComponent(project)}`
    return {
      root,
      config,
      data,
      project,
      list: () => Effect.promise(() => handler(new Request(url))),
      ensure: (target: unknown) =>
        Effect.promise(() =>
          handler(
            new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ target }),
            }),
          ),
        ),
    }
  })

const body = (response: Response) => Effect.promise(() => response.json() as Promise<Record<string, unknown>>)
const exists = (file: string) => Effect.promise(() => fs.access(file).then(() => true, () => false))

type Listing = {
  data: {
    files: { path: string; role?: string; exists: boolean }[]
    folders: { type: string; agent?: string; scope?: string; path: string; exists: boolean }[]
    enabled: boolean
    git: boolean
    available: boolean
  }
}

it.live("lists the location's instruction files and memory folders", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* Effect.promise(() => fs.writeFile(path.join(s.project, "AGENTS.md"), "root"))
    const response = yield* s.list()
    expect(response.status).toBe(200)
    const listing = (yield* body(response)) as unknown as Listing
    expect(listing.data).toMatchObject({ enabled: true, git: false, available: true })
    expect(listing.data.files.map((file) => [path.basename(file.path), file.role, file.exists])).toEqual([
      ["AGENTS.md", "project", true],
      ["ORBIT.md", "user", false],
    ])
    expect(listing.data.folders.map((item) => [item.type, item.agent, item.scope])).toEqual([
      ["memory", undefined, undefined],
      ["agent", "review", "user"],
      ["agent", "planner", "project"],
      ["agent", "notes", "local"],
    ])
    for (const item of [...listing.data.files, ...listing.data.folders]) expect(path.isAbsolute(item.path)).toBe(true)
    // Listing makes nothing.
    expect(yield* exists(path.join(s.project, ".orbit"))).toBe(false)
  }).pipe(Effect.scoped),
)

it.live("creates an agent's memory folder for its scope and returns its real path", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const real = yield* Effect.promise(() => fs.realpath(s.project))
    const expected = {
      review: path.join(yield* Effect.promise(() => fs.realpath(s.root)), "data", "memory", "agents", "review"),
      planner: path.join(real, ".orbit", "agent-memory", "planner"),
      notes: path.join(real, ".orbit", "agent-memory-local", "notes"),
    }
    for (const [agent, folder] of Object.entries(expected)) {
      const response = yield* s.ensure({ type: "agent", agent })
      expect(response.status).toBe(200)
      expect((yield* body(response)).data).toEqual({ path: folder, created: true, type: "folder" })
      expect((yield* Effect.promise(() => fs.stat(folder))).isDirectory()).toBe(true)
      const again = yield* s.ensure({ type: "agent", agent })
      expect((yield* body(again)).data).toMatchObject({ path: folder, created: false })
    }
  }).pipe(Effect.scoped),
)

it.live("refuses both routes in a folder that is not trusted, and makes nothing", () =>
  Effect.gen(function* () {
    const s = yield* server({ untrusted: true })
    const listed = yield* s.list()
    expect(listed.status).toBe(403)
    expect(yield* body(listed)).toMatchObject({ _tag: "UntrustedFolderError" })
    for (const target of [{ type: "scope", scope: "project" }, { type: "agent", agent: "planner" }, { type: "memory" }]) {
      const response = yield* s.ensure(target)
      expect(response.status).toBe(403)
      expect(yield* body(response)).toMatchObject({ _tag: "UntrustedFolderError" })
    }
    expect(yield* exists(path.join(s.project, ".orbit"))).toBe(false)
    expect(yield* exists(path.join(s.project, "AGENTS.md"))).toBe(false)
    expect(yield* exists(path.join(s.data, "memory"))).toBe(false)

    // The control: a trusted folder answers both.
    const trusted = yield* server()
    expect((yield* trusted.list()).status).toBe(200)
    const made = yield* trusted.ensure({ type: "scope", scope: "project" })
    expect(made.status).toBe(200)
    expect(yield* exists(path.join(trusted.project, "AGENTS.md"))).toBe(true)
  }).pipe(Effect.scoped),
)

it.live("answers 400 with kind unknown for a target the listing does not hold", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const marker = path.join(s.root, "marker")
    yield* Effect.promise(() => fs.mkdir(marker))
    for (const target of [
      { type: "file", path: path.join(s.project, "unlisted.md") },
      { type: "file", path: "../marker/x.md" },
      { type: "agent", agent: "../marker" },
      { type: "agent", agent: "missing" },
      { type: "scope", scope: "local" },
    ]) {
      const response = yield* s.ensure(target)
      expect(response.status).toBe(400)
      expect(yield* body(response)).toMatchObject({ _tag: "InvalidRequestError", field: "target", kind: "unknown" })
    }
    // A target that is not one of the shapes is refused by the schema, before any service.
    expect((yield* s.ensure({ type: "path", path: marker })).status).toBe(400)
    expect(yield* Effect.promise(() => fs.readdir(marker))).toEqual([])
    expect(yield* exists(path.join(s.project, "unlisted.md"))).toBe(false)

    // An agent folder that is a link is refused as such.
    const outside = path.join(s.root, "outside")
    yield* Effect.promise(async () => {
      await fs.mkdir(outside)
      await fs.mkdir(path.join(s.project, ".orbit", "agent-memory"), { recursive: true })
      await fs.symlink(outside, path.join(s.project, ".orbit", "agent-memory", "planner"), linkType)
    })
    const linked = yield* s.ensure({ type: "agent", agent: "planner" })
    expect(linked.status).toBe(400)
    expect(yield* body(linked)).toMatchObject({ _tag: "InvalidRequestError", field: "target", kind: "refused" })
    expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([])
    // The control: another agent's folder is made.
    expect((yield* s.ensure({ type: "agent", agent: "notes" })).status).toBe(200)
  }).pipe(Effect.scoped),
)

it.live("answers 503 when the file cannot be created, and creates nothing", () =>
  Effect.gen(function* () {
    const s = yield* server({ configIsFile: true })
    const response = yield* s.ensure({ type: "scope", scope: "user" })
    expect(response.status).toBe(503)
    expect(yield* body(response)).toMatchObject({ _tag: "ServiceUnavailableError", service: "memory" })
    expect(yield* Effect.promise(() => fs.readFile(s.config, "utf8"))).toBe("not a folder")
    // The control: the project's file is made on the same server.
    expect((yield* s.ensure({ type: "scope", scope: "project" })).status).toBe(200)
  }).pipe(Effect.scoped),
)

// Kept for the class 4 row on a platform that can link files: a listed file that is replaced by a link is refused.
it.live("refuses a listed file that became a link to another file", () =>
  Effect.gen(function* () {
    if (!canLinkFile) return
    const s = yield* server()
    const file = path.join(s.project, "AGENTS.md")
    yield* Effect.promise(() => fs.writeFile(file, "root"))
    const listing = (yield* body(yield* s.list())) as unknown as Listing
    const listed = listing.data.files[0]!.path
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(s.project, "other.md"), "other")
      await fs.rm(file)
      await fs.symlink(path.join(s.project, "other.md"), file, "file")
    })
    const response = yield* s.ensure({ type: "file", path: listed })
    expect(response.status).toBe(400)
    expect(yield* body(response)).toMatchObject({ kind: "refused" })
  }).pipe(Effect.scoped),
)
