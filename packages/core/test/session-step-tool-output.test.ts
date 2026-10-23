// tool-runtime-8: what the step does with a tool's result before it is stored. A result above the tool's threshold is
// written whole to `<data>/tool-output/<session>/<message>-<call>-<hash>.<ext>` and stored as the tool's own content with
// a `persisted` marker; an empty result becomes the empty marker; a failure above 10,000 characters is cut in the middle.
// The file name and the folder come from IDs a provider, a model or an imported session chose, so every spelling of an
// escape stays inside the session's folder or writes nothing (classes 4, 5 and 7).
import { describe, expect } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { LanguageModel, LLM, LLMEvent } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols/openai-chat"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { EventTable } from "@orbit/core/event/sql"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionStep } from "@orbit/core/session/runner/step"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { Snapshot } from "@orbit/core/snapshot"
import { Tool } from "@orbit/core/tool"
import { ToolOutput } from "@orbit/core/tool-output"
import { ToolTraits } from "@orbit/core/tool/traits"
import { Document, Info } from "@orbit/schema/config"
import type { ResolvedTraits } from "@orbit/schema/tool"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const linkType = process.platform === "win32" ? "junction" : "dir"
const SESSION = "ses_tool_output_step"
const hash = (id: string) => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8)
const sanitized = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
const NAME = /^msg_[A-Za-z0-9]{1,64}-[A-Za-z0-9_-]{0,64}-[0-9a-f]{8}\.(txt|json)$/
const text = (value: string) => ({ type: "text" as const, text: value })
const image = { type: "file" as const, uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" }

type Execute = (id: string) => Effect.Effect<Tool.NormalizedResult, Tool.Error>

interface Run {
  readonly calls: ReadonlyArray<{ readonly id: string; readonly name?: string }>
  readonly execute: Execute
  readonly traits?: Partial<ResolvedTraits>
  /** The `tool_output` block of the person's config, as a plain object (decoded, so an unknown key is dropped). */
  readonly toolOutput?: Record<string, unknown>
  readonly sessionID?: string
  readonly assistantMessageID?: SessionMessage.ID
  /** Runs before the step, with the data folder, the temporary root and the session folder the step will use. */
  readonly prepare?: (dirs: { readonly data: string; readonly root: string; readonly folder: string }) => Promise<void>
}

const listFiles = async (folder: string): Promise<string[]> => {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(folder, entry.name)).then((files) => files.map((file) => path.join(entry.name, file)))
        : Promise.resolve([entry.name]),
    ),
  )
  return nested.flat().sort()
}

const runStep = (input: Run) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    const data = path.join(root, "data")
    const sessionID = input.sessionID ?? SESSION
    const folder = path.join(data, "tool-output", sessionID)
    yield* Effect.promise(() => fs.mkdir(data, { recursive: true }))
    if (input.prepare) yield* Effect.promise(() => input.prepare!({ data, root, folder }))
    const info = Schema.decodeUnknownSync(Info)(input.toolOutput === undefined ? {} : { tool_output: input.toolOutput })
    const assistantMessageID = input.assistantMessageID ?? SessionMessage.ID.create()
    const events = yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({ capture: () => Effect.succeed(undefined), files: () => Effect.succeed([]) }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make(sessionID),
          project_id: Project.ID.global,
          slug: "tool-output",
          directory: "/project",
          version: "test",
        })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          { reason: { normalized: "tool-calls" } },
          ...input.calls.map((call) => LLMEvent.toolCall({ id: call.id, name: call.name ?? "emit", input: {} })),
        ),
      )
      yield* steps.attempt({
        isLocationClosed: () => false,
        sessionID: SessionSchema.ID.make(sessionID),
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          escalation: false,
          request: LLM.request({ model: model.model, prompt: "Run the tools" }),
          options: {},
          executeTool: (call) => input.execute(call.call.id),
          toolTraits: () => Effect.succeed({ ...ToolTraits.defaults, ...input.traits }),
          describeTool: () => undefined,
        },
        retry: () => Effect.succeed({ retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      return yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
    }).pipe(
      Effect.provide(
        Layer.merge(
          AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              Bus.node,
              Config.node,
              SessionProjector.node,
              ToolOutput.node,
              Global.node,
            ]),
            [
              Config.node.replace(Config.testLayer([new Document({ type: "document", info })])),
              Bus.node.replace(Bus.configured({ persist: true })),
              Global.node.replace(Global.layerWith({ data })),
            ],
          ),
          TestLLM.testLayer(),
        ),
      ),
    )
    const settled = (id: string) =>
      events.find(
        (event) =>
          (event.type === "session.tool.success.2" || event.type === "session.tool.failed.2") &&
          (event.data as { id?: string }).id === id,
      )?.data as
        | {
            readonly content?: ReadonlyArray<{ type: string; text?: string }>
            readonly metadata?: Record<string, unknown>
            readonly error?: { type: string; message: string }
          }
        | undefined
    return {
      root,
      data,
      folder,
      sessionID,
      assistantMessageID,
      settled,
      types: events.map((event) => event.type),
      files: yield* Effect.promise(() => listFiles(path.join(data, "tool-output"))),
      rootEntries: yield* Effect.promise(() => fs.readdir(root)),
    }
  })

const returns =
  (content: ReadonlyArray<Tool.Content>, metadata?: Tool.Metadata): Execute =>
  () =>
    Effect.succeed({ content, ...(metadata === undefined ? {} : { metadata }) })

describe("saving a large result", () => {
  it.live("saves a result above the threshold under the session's folder and keeps the tool's own content", () =>
    Effect.gen(function* () {
      const big = "x".repeat(60_000)
      const run = yield* runStep({ calls: [{ id: "call_big" }], execute: returns([text(big)]) })
      const name = `${run.assistantMessageID}-call_big-${hash("call_big")}.txt`
      expect(run.files).toEqual([path.join(run.sessionID, name)])
      expect(yield* Effect.promise(() => fs.readFile(path.join(run.folder, name), "utf8"))).toBe(big)
      const stored = run.settled("call_big")
      expect(stored?.content).toEqual([text(big)])
      expect(stored?.metadata?.persisted).toEqual({ session: run.sessionID, name, size: 60_000, format: 1 })
      // No path is stored: the wrapper's path is worked out from the data folder when the request is lowered.
      expect(JSON.stringify(stored?.metadata)).not.toContain(run.data.replaceAll("\\", "\\\\"))
    }),
  )

  it.live("keeps a result of exactly the threshold inline and writes nothing", () =>
    Effect.gen(function* () {
      const run = yield* runStep({ calls: [{ id: "call_edge" }], execute: returns([text("y".repeat(50_000))]) })
      expect(run.settled("call_edge")?.content).toEqual([text("y".repeat(50_000))])
      expect(run.settled("call_edge")?.metadata?.persisted).toBeUndefined()
      expect(run.files).toEqual([])
    }),
  )

  // Declared limit x configured ceiling -> the size that is saved and the size that is not (FU-M3-174 for 100,000).
  const thresholds: ReadonlyArray<{
    readonly name: string
    readonly declared?: number
    readonly toolOutput?: Record<string, unknown>
    readonly saved?: number
    readonly whole: number
  }> = [
    { name: "a tool that declares 20,000, as Grep does", declared: 20_000, saved: 20_001, whole: 20_000 },
    { name: "a tool that declares 100,000 under the 50,000 ceiling", declared: 100_000, saved: 60_000, whole: 50_000 },
    { name: "a tool that declares Infinity, as Read does", declared: Infinity, whole: 200_000 },
    {
      name: "a tool that declares Infinity under a ceiling of 10",
      declared: Infinity,
      toolOutput: { max_result_chars: 10 },
      whole: 1_000,
    },
    {
      name: "a tool that declares 100,000 under a raised ceiling",
      declared: 100_000,
      toolOutput: { max_result_chars: 200_000 },
      saved: 150_000,
      whole: 80_000,
    },
    {
      name: "an undeclared tool under a ceiling of 500",
      toolOutput: { max_result_chars: 500 },
      saved: 501,
      whole: 500,
    },
    {
      name: "an undeclared tool under max_bytes alone",
      toolOutput: { max_bytes: 80_000 },
      saved: 80_001,
      whole: 70_000,
    },
    {
      name: "an undeclared tool where max_result_chars wins over max_bytes",
      toolOutput: { max_result_chars: 30_000, max_bytes: 80_000 },
      saved: 30_001,
      whole: 30_000,
    },
    // `max_lines` bounds only the shell's own capture now.
    { name: "an undeclared tool under max_lines alone", toolOutput: { max_lines: 5 }, saved: 50_001, whole: 50_000 },
  ]
  for (const row of thresholds)
    it.live(`applies the threshold of ${row.name}`, () =>
      Effect.gen(function* () {
        const sizes = { call_whole: row.whole, ...(row.saved === undefined ? {} : { call_saved: row.saved }) }
        const run = yield* runStep({
          calls: Object.keys(sizes).map((id) => ({ id })),
          execute: (id) => Effect.succeed({ content: [text("z".repeat(sizes[id as keyof typeof sizes]!))] }),
          traits: row.declared === undefined ? {} : { maxResultChars: row.declared },
          toolOutput: row.toolOutput,
        })
        expect(run.settled("call_whole")?.content).toEqual([text("z".repeat(row.whole))])
        expect(run.settled("call_whole")?.metadata?.persisted).toBeUndefined()
        if (row.saved === undefined) return expect(run.files).toEqual([])
        expect(run.settled("call_saved")?.metadata?.persisted).toMatchObject({ size: row.saved, format: 1 })
        expect(run.files).toEqual([
          path.join(run.sessionID, `${run.assistantMessageID}-call_saved-${hash("call_saved")}.txt`),
        ])
      }),
    )

  it.live("saves several text parts as pretty JSON", () =>
    Effect.gen(function* () {
      const parts = [text("a".repeat(30_000)), text("b".repeat(30_000))]
      const run = yield* runStep({ calls: [{ id: "call_parts" }], execute: returns(parts) })
      const name = `${run.assistantMessageID}-call_parts-${hash("call_parts")}.json`
      const saved = JSON.stringify(parts, null, 2)
      expect(yield* Effect.promise(() => fs.readFile(path.join(run.folder, name), "utf8"))).toBe(saved)
      expect(run.settled("call_parts")?.metadata?.persisted).toEqual({
        session: run.sessionID,
        name,
        size: saved.length,
        format: 1,
      })
      expect(run.settled("call_parts")?.content).toEqual(parts)
    }),
  )

  it.live("sends a result that holds a file part whole, however large its text", () =>
    Effect.gen(function* () {
      const content = [text("i".repeat(80_000)), image]
      const run = yield* runStep({ calls: [{ id: "call_image" }], execute: returns(content) })
      expect(run.settled("call_image")?.content).toEqual(content)
      expect(run.settled("call_image")?.metadata?.persisted).toBeUndefined()
      expect(run.files).toEqual([])
    }),
  )

  it.live("drops a persisted marker that the tool supplied", () =>
    Effect.gen(function* () {
      const forged = { session: "ses_someone_else", name: "msg_a-b-12345678.txt", size: 1, format: 1 }
      const run = yield* runStep({
        calls: [{ id: "call_small" }, { id: "call_large" }],
        execute: (id) =>
          Effect.succeed({
            content: [text(id === "call_small" ? "small" : "l".repeat(60_000))],
            metadata: { persisted: forged, kept: true },
          }),
      })
      expect(run.settled("call_small")?.metadata).toEqual({ kept: true })
      expect(run.settled("call_large")?.metadata).toEqual({
        kept: true,
        persisted: {
          session: run.sessionID,
          name: `${run.assistantMessageID}-call_large-${hash("call_large")}.txt`,
          size: 60_000,
          format: 1,
        },
      })
    }),
  )

  it.live("keeps the file that is already there and still marks the result", () =>
    Effect.gen(function* () {
      // The same call of the same message again, as a replay makes it: the first file is not rewritten.
      const assistantMessageID = SessionMessage.ID.create()
      const name = `${assistantMessageID}-call_again-${hash("call_again")}.txt`
      const run = yield* runStep({
        assistantMessageID,
        calls: [{ id: "call_again" }],
        execute: returns([text("n".repeat(60_000))]),
        prepare: async ({ folder }) => {
          await fs.mkdir(folder, { recursive: true })
          await fs.writeFile(path.join(folder, name), "first")
        },
      })
      expect(yield* Effect.promise(() => fs.readFile(path.join(run.folder, name), "utf8"))).toBe("first")
      expect(run.settled("call_again")?.metadata?.persisted).toEqual({
        session: run.sessionID,
        name,
        size: 60_000,
        format: 1,
      })
    }),
  )
})

describe("names and folders from IDs that someone else chose", () => {
  it.live(
    "names each saved file by its message and a sanitized, hash-suffixed call ID inside the session's folder",
    () =>
      Effect.gen(function* () {
        const ids = ["../../x", "a/b", "a_b", "ABC", "abc", "c".repeat(300), "C:\\evil", "\\\\host\\share\\x", ""]
        const run = yield* runStep({
          calls: ids.map((id) => ({ id })),
          execute: (id) => Effect.succeed({ content: [text(`${JSON.stringify(id)}:${"q".repeat(60_000)}`)] }),
        })
        // Only the session's folder was made, and nothing beside the data folder.
        expect(run.rootEntries.sort()).toEqual(["data"])
        expect(yield* Effect.promise(() => fs.readdir(run.data))).toEqual(["tool-output"])
        expect(yield* Effect.promise(() => fs.readdir(path.join(run.data, "tool-output")))).toEqual([run.sessionID])
        const names = run.files.map((file) => path.relative(run.sessionID, file))
        expect(names).toHaveLength(ids.length)
        // Distinct even on a disk that ignores letter case.
        expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(ids.length)
        for (const id of ids) {
          const name = `${run.assistantMessageID}-${sanitized(id)}-${hash(id)}.txt`
          expect(name).toMatch(NAME)
          expect(names).toContain(name)
          expect(run.settled(id)?.metadata?.persisted).toMatchObject({ name, session: run.sessionID })
          // Each file holds its own call's output.
          expect(yield* Effect.promise(() => fs.readFile(path.join(run.folder, name), "utf8"))).toStartWith(
            `${JSON.stringify(id)}:`,
          )
        }
      }),
  )

  for (const sessionID of ["ses/../../escape", "ses_ok\\..\\..\\escape", "ses_ok/../../../escape"])
    it.live(`writes nothing for the session ${JSON.stringify(sessionID)}, whose ID cannot name a folder`, () =>
      Effect.gen(function* () {
        const big = "e".repeat(60_000)
        const run = yield* runStep({ sessionID, calls: [{ id: "call_escape" }], execute: returns([text(big)]) })
        // Control: the result still reaches the store, whole and unmarked.
        expect(run.settled("call_escape")?.content).toEqual([text(big)])
        expect(run.settled("call_escape")?.metadata?.persisted).toBeUndefined()
        expect(run.rootEntries.sort()).toEqual(["data"])
        expect(run.files).toEqual([])
      }),
    )

  it.live("writes nothing through a session folder that is a link, and sends the result whole", () =>
    Effect.gen(function* () {
      const big = "j".repeat(60_000)
      const run = yield* runStep({
        calls: [{ id: "call_link" }],
        execute: returns([text(big)]),
        prepare: async ({ root, folder }) => {
          await fs.mkdir(path.join(root, "outside"), { recursive: true })
          await fs.mkdir(path.dirname(folder), { recursive: true })
          await fs.symlink(path.join(root, "outside"), folder, linkType)
        },
      })
      expect(yield* Effect.promise(() => fs.readdir(path.join(run.root, "outside")))).toEqual([])
      expect(run.settled("call_link")?.content).toEqual([text(big)])
      expect(run.settled("call_link")?.metadata?.persisted).toBeUndefined()
    }),
  )

  it.live("sends the result whole when the file cannot be written", () =>
    Effect.gen(function* () {
      const big = "w".repeat(60_000)
      const run = yield* runStep({
        calls: [{ id: "call_blocked" }],
        execute: returns([text(big)]),
        // The tool-output folder is a file, so nothing can be made inside it.
        prepare: ({ data }) => fs.writeFile(path.join(data, "tool-output"), "not a folder"),
      })
      expect(run.types).toContain("session.step.ended.1")
      expect(run.settled("call_blocked")?.content).toEqual([text(big)])
      expect(run.settled("call_blocked")?.metadata?.persisted).toBeUndefined()
    }),
  )
})

describe("empty results", () => {
  const empties: ReadonlyArray<readonly [string, ReadonlyArray<Tool.Content>]> = [
    ["no parts", []],
    ["one empty text part", [text("")]],
    ["whitespace only", [text("  \n\t ")]],
    ["several blank parts", [text(""), text(" "), text("\n")]],
  ]
  for (const [name, content] of empties)
    it.live(`stores the empty marker for ${name}`, () =>
      Effect.gen(function* () {
        const run = yield* runStep({ calls: [{ id: "call_empty", name: "Probe" }], execute: returns(content) })
        expect(run.types).toContain("session.tool.success.2")
        expect(run.settled("call_empty")?.content).toEqual([text("(Probe finished and returned no output)")])
      }),
    )

  it.live("keeps an image-only result as it is", () =>
    Effect.gen(function* () {
      const run = yield* runStep({ calls: [{ id: "call_picture" }], execute: returns([image]) })
      expect(run.settled("call_picture")?.content).toEqual([image])
    }),
  )
})

describe("failed results", () => {
  it.live("cuts a failure above 10,000 characters to its first and last 5,000 and saves nothing", () =>
    Effect.gen(function* () {
      const message = `${"h".repeat(5_000)}${"m".repeat(15_000)}${"t".repeat(5_000)}`
      const run = yield* runStep({
        calls: [{ id: "call_fail" }],
        execute: () => Effect.fail(new Tool.Error({ message })),
      })
      expect(run.settled("call_fail")?.error).toEqual({
        type: "tool.execution",
        message: `${"h".repeat(5_000)}\n\n[15000 characters cut from the middle]\n\n${"t".repeat(5_000)}`,
      })
      expect(run.files).toEqual([])
    }),
  )

  it.live("keeps a failure of exactly 10,000 characters as it is", () =>
    Effect.gen(function* () {
      const message = "f".repeat(10_000)
      const run = yield* runStep({
        calls: [{ id: "call_fail_edge" }],
        execute: () => Effect.fail(new Tool.Error({ message })),
      })
      expect(run.settled("call_fail_edge")?.error?.message).toBe(message)
    }),
  )
})
