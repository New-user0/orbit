import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { App } from "@orbit/core/app"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Instance } from "@orbit/core/instance"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { ModelsDev } from "@orbit/core/models-dev"
import { Session } from "@orbit/core/session"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Agent } from "@orbit/schema/agent"
import { Location } from "@orbit/schema/location"
import { AbsolutePath } from "@orbit/schema/schema"
import { FSUtil } from "@orbit/util/fs-util"
import { ManagedSettings } from "@orbit/core/managed-settings"
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

const LIMIT = 40_000

// What the endpoint returns, as far as these tests look at it.
type Preview = {
  readonly status: {
    readonly available: boolean
    readonly files: ReadonlyArray<{
      readonly path: string
      readonly kind: string
      readonly chars: number
      readonly importedBy?: string
    }>
    readonly warnings: ReadonlyArray<{
      readonly path: string
      readonly type: string
      readonly message: string
      readonly chars?: number
      readonly limit?: number
      readonly target?: string
    }>
  }
  readonly initial?: string
  readonly update?: string
  readonly blocked?: ReadonlyArray<string>
}

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "preview-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

/**
 * A real server over an in-memory database with a temporary home, global config folder and project. `trusted: false`
 * leaves the project untrusted. `instructions` switches instruction loading off, as `orb run --bare` does.
 */
const server = (options: { readonly trusted?: boolean; readonly instructions?: boolean; readonly provider?: boolean; readonly managed?: string } = {}) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-instructions-")).path
    const home = path.join(root, "home")
    const config = path.join(root, "config")
    const project = path.join(root, "project")
    yield* Effect.promise(() => Promise.all([home, config, project].map((dir) => fs.mkdir(dir, { recursive: true }))))
    yield* Effect.promise(() => Bun.$`git init -q`.cwd(project).quiet())
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("side", "side_text") })))
    const unreadable = { current: false }
    const replacements: LayerNode.Replacements = [
      Global.node.replace(Global.layerWith({ home, config, data: path.join(root, "data"), cache: path.join(root, "cache"), state: path.join(root, "state"), tmp: path.join(root, "tmp") })),
      Database.node.replace(Database.configured({ path: ":memory:" })),
      Bus.node.replace(Bus.node),
      App.node.replace(App.node),
      ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
      Watcher.node.replace(Watcher.configured({ enabled: true })),
      // An instruction file that cannot be read while `unreadable.current` is set, as one that is locked or just gone.
      FSUtil.node.replace(
        Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                readFileStringSafe: (file) =>
                  unreadable.current && path.basename(file) === "ORBIT.md" ? Effect.undefined : fs.readFileStringSafe(file),
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
      ...(options.managed
        ? [ManagedSettings.node.replace(ManagedSettings.configured({ directory: options.managed }))]
        : []),
      ...(options.instructions === false
        ? [InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false }))]
        : []),
    ]
    const context = yield* Layer.build(createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const sessions = Context.get(context, Session.Service)
    const instances = Context.get(context, Instance.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const previewOf = (id: string) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(new Request(`http://orbit.local/api/experimental/session/${id}/instructions`)),
        )
        expect(response.status).toBe(200)
        const body: { data: Preview } = yield* Effect.promise(() => response.json())
        return body.data
      })
    const write = (file: string, text: string) =>
      Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text)
      })
    return {
      root,
      home,
      config,
      project,
      llm,
      unreadable,
      sessions,
      /** Previews until `done` accepts the answer, which lets a watcher rescan land. */
      until: (id: string, done: (preview: Preview) => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 100; attempt++) {
            const preview = yield* previewOf(id)
            if (done(preview)) return preview
            yield* Effect.sleep("100 millis")
          }
          return yield* Effect.die(new Error("the rescan did not land"))
        }),
      /** Runs one step on the session and returns the system prompt of the request it made. */
      step: (id: Session.ID, text: string) =>
        Effect.gen(function* () {
          yield* llm.push(TestLLM.text("done", `text_${text}`))
          yield* sessions.prompt({ sessionID: id, text, resume: false })
          yield* sessions.resume(id)
          // The step itself is the request that offers tools; a side request such as the title has none.
          return (yield* llm.requests()).findLast((request) => (request.tools?.length ?? 0) > 0)
        }),
      instances,
      write,
      /** A session started in `directory`, which is the project by default. */
      session: (directory = project, agent = "build") =>
        sessions.create({
          id: Session.ID.create(),
          agent: Agent.ID.make(agent),
          model: model.ref,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        }),
      get: (id: string) =>
        Effect.promise(() => handler(new Request(`http://orbit.local/api/experimental/session/${id}/instructions`))),
      preview: previewOf,
    }
  })

// An import token spells a path with forward slashes on every platform.
const token = (file: string) => file.replaceAll("\\", "/")

const headers = (text: string) =>
  Array.from(text.matchAll(/^Instructions from: (.+?)(?: \(.*\))?$/gm), (match) => match[1])

it.live("lists files in render order with kinds, and the import right after its importer", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const sub = path.join(s.project, "sub")
    yield* s.write(path.join(s.config, "ORBIT.md"), "global rules")
    yield* s.write(path.join(s.project, "ORBIT.md"), "root rules\n@./extra.md")
    yield* s.write(path.join(s.project, "extra.md"), "imported rules")
    yield* s.write(path.join(sub, "ORBIT.md"), "sub rules")
    const session = yield* s.session(sub)
    const preview = yield* s.preview(session.id)
    const files = preview.status.files

    expect(files.map((file) => file.path)).toEqual(headers(preview.initial ?? ""))
    expect(files.map((file) => [path.basename(path.dirname(file.path)), path.basename(file.path), file.kind])).toEqual([
      ["config", "ORBIT.md", "user"],
      ["project", "ORBIT.md", "project"],
      ["project", "extra.md", "project"],
      ["sub", "ORBIT.md", "project"],
    ])
    const root = files.find((file) => file.path === path.join(s.project, "ORBIT.md"))
    expect(files[files.indexOf(root!) + 1]).toMatchObject({ importedBy: root!.path })
    expect(files.filter((file) => file.importedBy !== undefined)).toHaveLength(1)
  }).pipe(Effect.scoped),
)

it.live("reports managed and local kinds, and an import takes its importer's kind", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("orbit-managed-")).path
    const managed = path.join(root, "managed")
    const s = yield* server({ managed })
    yield* s.write(path.join(managed, "ORBIT.md"), "policy\n@./policy-more.md")
    yield* s.write(path.join(managed, "policy-more.md"), "more policy")
    yield* s.write(path.join(s.config, "ORBIT.md"), "global rules")
    yield* s.write(path.join(s.project, "ORBIT.md"), "project rules")
    yield* s.write(path.join(s.project, "ORBIT.local.md"), "local rules\n@./local-more.md")
    yield* s.write(path.join(s.project, "local-more.md"), "more local")
    const preview = yield* s.preview((yield* s.session()).id)
    const files = preview.status.files

    expect(files.map((file) => [path.basename(file.path), file.kind, file.importedBy && path.basename(file.importedBy)])).toEqual([
      ["ORBIT.md", "managed", undefined],
      ["policy-more.md", "managed", "ORBIT.md"],
      ["ORBIT.md", "user", undefined],
      ["ORBIT.md", "project", undefined],
      ["ORBIT.local.md", "local", undefined],
      ["local-more.md", "local", "ORBIT.local.md"],
    ])
    expect(files.map((file) => file.path)).toEqual(headers(preview.initial ?? ""))
  }).pipe(Effect.scoped),
)

it.live("is read only: a preview records nothing and a repeat gives the same update", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const file = path.join(s.project, "ORBIT.md")
    yield* s.write(file, "first rules")
    const session = yield* s.session()
    yield* s.step(session.id, "go")
    yield* s.write(file, "second rules")
    const first = yield* s.until(session.id, (preview) => (preview.update ?? "") !== "")
    const second = yield* s.preview(session.id)

    expect(first.update).not.toBe("")
    expect(second.update).toBe(first.update)
    const messages = yield* s.sessions.messages({ sessionID: session.id })
    expect(JSON.stringify(messages)).not.toContain("second rules")
  }).pipe(Effect.scoped),
)

it.live("lists no files for an agent that leaves instruction files out of its context", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), "project rules")
    const build = yield* s.preview((yield* s.session()).id)
    const explore = yield* s.preview((yield* s.session(s.project, "explore")).id)

    expect(build.status.files).toHaveLength(1)
    expect(explore.initial ?? "").not.toContain("project rules")
    expect(explore.status.files).toEqual([])
    expect(explore.status.warnings).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("counts the text the model reads: front matter and comment blocks are not in chars", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const body = "keep these rules"
    yield* s.write(path.join(s.project, "ORBIT.md"), `---\ndescription: x\n---\n\n<!-- a note for editors -->\n${body}\n`)
    const preview = yield* s.preview((yield* s.session()).id)
    const file = preview.status.files.find((item) => item.path === path.join(s.project, "ORBIT.md"))

    expect(file?.chars).toBe(`${body}\n`.length)
    expect(preview.initial).toContain(body)
    expect(preview.initial).not.toContain("a note for editors")
  }).pipe(Effect.scoped),
)

it.live("flags a file only above 40,000 characters, counts code units, and sends it whole", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const fill = (length: number, tail: string) => "a".repeat(length - tail.length) + tail
    const cases = [
      { dir: "exact", text: fill(LIMIT, "END-EXACT"), warned: false },
      { dir: "over", text: fill(LIMIT + 1, "END-OVER"), warned: true },
      // Each of these is two UTF-16 code units: 20,001 of them are 40,002 characters as the string counts them.
      { dir: "astral", text: "\u{1F600}".repeat(20_001), warned: true },
    ]
    for (const item of cases) yield* s.write(path.join(s.project, item.dir, "ORBIT.md"), item.text)

    for (const item of cases) {
      const preview = yield* s.preview((yield* s.session(path.join(s.project, item.dir))).id)
      const warnings = preview.status.warnings
      expect(warnings.map((warning) => warning.type)).toEqual(item.warned ? ["size"] : [])
      if (item.warned) {
        expect(warnings[0]).toMatchObject({
          path: path.join(s.project, item.dir, "ORBIT.md"),
          chars: item.text.length,
          limit: LIMIT,
        })
        expect(warnings[0].message).toContain(item.text.length.toLocaleString("en-US"))
        // A warning is for the person: nothing of it reaches the model.
        expect(preview.initial).not.toContain(warnings[0].message)
        expect(preview.update).toBe("")
      }
      // Sent whole, the end of the file included.
      expect(preview.initial).toContain(item.text.slice(-8))
    }
  }).pipe(Effect.scoped),
)

it.live("previews the baseline the next request sends, and the update a change starts", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const file = path.join(s.project, "ORBIT.md")
    yield* s.write(file, "first rules")
    const session = yield* s.session()
    const before = yield* s.preview(session.id)
    expect(before.update).toBe("")

    const first = yield* s.step(session.id, "go")
    expect(first?.system.map((part) => part.text)).toContain(before.initial)

    yield* s.write(file, "second rules, a little longer")
    const after = yield* s.until(session.id, (preview) => preview.update !== "")
    expect(after.initial).toBe(before.initial)
    expect(after.status.files.find((item) => item.path === file)?.chars).toBe("second rules, a little longer".length)

    const second = yield* s.step(session.id, "again")
    const recorded = (yield* s.sessions.messages({ sessionID: session.id })).flatMap((message) =>
      message.type === "system" ? [message.text] : [],
    )
    expect(recorded).toEqual([after.update!])
    // The baseline is the epoch's: a change goes in as a System message, not into the system prompt.
    expect(second?.system.map((part) => part.text)).toContain(before.initial)
    // Once recorded, nothing is pending.
    expect((yield* s.preview(session.id)).update).toBe("")
  }).pipe(Effect.scoped),
)

it.live("answers an unknown session with SessionNotFoundError", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const id = Session.ID.create()
    const response = yield* s.get(id)

    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "SessionNotFoundError", sessionID: id })
  }).pipe(Effect.scoped),
)

it.live("works with no provider configured and makes no request to one", () =>
  Effect.gen(function* () {
    const s = yield* server({ provider: false })
    yield* s.write(path.join(s.project, "ORBIT.md"), "rules")
    const preview = yield* s.preview((yield* s.session()).id)

    expect(preview.initial).toContain("rules")
    expect(yield* s.llm.requests()).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("lists nothing when instruction loading is off", () =>
  Effect.gen(function* () {
    const s = yield* server({ instructions: false })
    yield* s.write(path.join(s.project, "ORBIT.md"), "PROJECT-MARKER")
    yield* s.write(path.join(s.config, "ORBIT.md"), "GLOBAL-MARKER")
    const preview = yield* s.preview((yield* s.session()).id)

    expect(preview.status).toMatchObject({ files: [], warnings: [] })
    expect(preview.initial ?? "").not.toContain("-MARKER")
  }).pipe(Effect.scoped),
)

it.live("leaves out the imports that are silent in the reference: a binary name, and a sixth file in a chain", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const chain = ["a", "b", "c", "d", "e", "f"]
    yield* s.write(path.join(s.project, "pic.png"), "not text")
    yield* s.write(path.join(s.project, "ORBIT.md"), "root\n@./pic.png\n@./a.md")
    for (const [index, name] of chain.entries())
      yield* s.write(path.join(s.project, `${name}.md`), `file ${name}${chain[index + 1] ? `\n@./${chain[index + 1]}.md` : ""}`)
    const preview = yield* s.preview((yield* s.session()).id)
    const names = preview.status.files.map((file) => path.basename(file.path))

    // The file itself and four files below it; the png and the sixth are never read.
    expect(names).toEqual(["ORBIT.md", "a.md", "b.md", "c.md", "d.md"])
    expect(preview.status.warnings).toEqual([])
    expect(preview.initial).not.toContain("not text")
  }).pipe(Effect.scoped),
)

it.live("lists a file imported twice once, at its first place", () =>
  Effect.gen(function* () {
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), "root\n@./shared.md\n@./other.md\n@./shared.md")
    yield* s.write(path.join(s.project, "other.md"), "other\n@./shared.md")
    yield* s.write(path.join(s.project, "shared.md"), "shared")
    const preview = yield* s.preview((yield* s.session()).id)

    expect(preview.status.files.map((file) => path.basename(file.path))).toEqual(["ORBIT.md", "shared.md", "other.md"])
    expect(preview.status.files.find((file) => file.path.endsWith("shared.md"))?.importedBy).toBe(
      path.join(s.project, "ORBIT.md"),
    )
  }).pipe(Effect.scoped),
)

it.live("warns once for an import outside the project, names the real target, and does not read it", () =>
  Effect.gen(function* () {
    const s = yield* server({ trusted: false })
    const outside = path.join(s.root, "outside.md")
    yield* s.write(outside, "OUTSIDE-MARKER")
    // Four spellings of one target: absolute, `..` once, `..` through a subfolder, and a lower-case drive on Windows.
    const lower = token(outside).replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    yield* s.write(
      path.join(s.project, "ORBIT.md"),
      `root\n@${token(outside)}\n@../outside.md\n@./sub/../../outside.md\n@${lower}`,
    )
    const preview = yield* s.preview((yield* s.session()).id)

    expect(preview.status.warnings).toMatchObject([
      { path: path.join(s.project, "ORBIT.md"), type: "import-untrusted", target: outside, directory: s.project },
    ])
    expect(preview.status.warnings).toHaveLength(1)
    expect(preview.initial).not.toContain("OUTSIDE-MARKER")
    expect(preview.status.files.map((file) => file.path)).toEqual([path.join(s.project, "ORBIT.md")])
  }).pipe(Effect.scoped),
)

it.live("separates an import left out from one inside the project, trusted or not", () =>
  Effect.gen(function* () {
    const { canLinkFile } = yield* Effect.promise(() => import("../../core/test/fixture/symlink"))
    for (const trusted of [false, true]) {
      const s = yield* server({ trusted })
      const outside = path.join(s.root, "outside.md")
      yield* s.write(outside, "OUTSIDE-MARKER")
      yield* s.write(path.join(s.project, "real", "notes.md"), "LINKED-MARKER")
      if (canLinkFile)
        yield* Effect.promise(() =>
          fs.symlink(path.join(s.project, "real", "notes.md"), path.join(s.project, "notes.md")),
        )
      yield* s.write(path.join(s.project, "ORBIT.md"), `root\n@${token(outside)}\n@./${canLinkFile ? "notes" : "real/notes"}.md`)
      const preview = yield* s.preview((yield* s.session()).id)

      // A link that stays inside the project is read, with or without a grant, and the file outside it is not.
      expect(preview.initial).toContain("LINKED-MARKER")
      // A trusted folder may reach outside: the file is loaded and nothing is warned about.
      if (trusted) {
        expect(preview.initial).toContain("OUTSIDE-MARKER")
        expect(preview.status.warnings).toEqual([])
        continue
      }
      expect(preview.initial).not.toContain("OUTSIDE-MARKER")
      expect(preview.status.warnings).toMatchObject([{ type: "import-untrusted", target: outside, directory: s.project }])
    }
  }).pipe(Effect.scoped),
)

it.live("reports an unavailable source, and no baseline while the session has none", () =>
  Effect.gen(function* () {
    const s = yield* server()
    const file = path.join(s.project, "ORBIT.md")
    yield* s.write(file, "stored rules")
    const initialized = yield* s.session()
    const baseline = (yield* s.preview(initialized.id)).initial
    yield* s.step(initialized.id, "go")
    const fresh = yield* s.session()

    s.unreadable.current = true
    yield* s.write(file, "changed rules")
    const blocked = yield* s.until(fresh.id, (preview) => !preview.status.available)

    expect(blocked.status.available).toBe(false)
    expect(blocked.initial).toBeUndefined()
    expect(blocked.blocked).toEqual(["core/instructions"])
    // A session that already has its baseline keeps it.
    const kept = yield* s.preview(initialized.id)
    expect(kept.status.available).toBe(false)
    expect(kept.initial).toBe(baseline)
  }).pipe(Effect.scoped),
)

it.live("lists upper-case drive paths whatever way the location spells its drive, and importers match entries", () =>
  Effect.gen(function* () {
    if (process.platform !== "win32") return
    const s = yield* server()
    yield* s.write(path.join(s.project, "ORBIT.md"), "root\n@./extra.md")
    yield* s.write(path.join(s.project, "extra.md"), "extra")
    const lower = s.project.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    const preview = yield* s.preview((yield* s.session(lower)).id)
    const paths = preview.status.files.map((file) => file.path)

    expect(paths.length).toBe(2)
    for (const file of paths) expect(file).toMatch(/^[A-Z]:/)
    for (const file of preview.status.files) if (file.importedBy) expect(paths).toContain(file.importedBy)
    expect(paths).toEqual(headers(preview.initial ?? ""))
  }).pipe(Effect.scoped),
)
