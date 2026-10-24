// clients-ux-15 part 1: a person may answer an Edit or Write approval with their own version of the file, as the
// reference lets them edit the proposal in the editor's diff and save it. The reply carries only the revised content:
// the server holds the file the request named and the content it read, turns the revised content into what the tool
// writes, and records the diff it approved on the reply, so what a client shows is what runs (class 8). Everything here
// runs through the real Permission service and the real file tools.
import { describe, expect } from "bun:test"
import { applyPatch } from "diff"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
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
import { SessionMessage } from "@orbit/core/session/message"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"

const sessionID = Session.ID.make("ses_revise")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_revise") }
const it = testEffect(Layer.empty)

const plugins = makeLocationNode({
  name: "test/permission-revise-plugins",
  layer: Layer.effectDiscard(
    Effect.all([
      registerToolPlugin(EditTool.Plugin),
      registerToolPlugin(WriteTool.Plugin),
      registerToolPlugin(PatchTool.Plugin),
      registerToolPlugin(NotebookEditTool.Plugin),
    ]),
  ),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

// The reply a person gives. `content` is the revised file; the type is widened here so the test reads the same before
// and after the field exists.
type Answer = { readonly reply: Permission.Reply; readonly content?: string; readonly message?: string }
// What a client hears about a reply. `files` is the approved revision, which the event carries once the field exists.
type Replied = { readonly requestID: string; readonly reply: string; readonly files?: unknown }
type Settled = {
  readonly asked: ReadonlyArray<Permission.Request>
  readonly replied: ReadonlyArray<Replied>
  // Each reply attempt, whether the server took it, and the error it refused it with.
  readonly attempts: ReadonlyArray<{ readonly answer: Answer; readonly accepted: boolean; readonly error?: unknown }>
  readonly exit: Exit.Exit<unknown, unknown>
}

const revisable = (request: Permission.Request) => (request as Permission.Request & { revisable?: boolean }).revisable

// Runs one call in a project at `directory` whose agent asks about everything, and answers each question in turn with
// `answer(request, attempt)`, where `attempt` counts the replies given to that request so far.
const settle = (
  directory: string,
  name: string,
  input: Record<string, unknown>,
  answer: (request: Permission.Request, attempt: number) => Answer | Effect.Effect<Answer>,
) =>
  Effect.gen(function* () {
    yield* seed(directory)
    const tools = yield* Tool.Service
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const replied: Replied[] = []
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Replied.type
        ? Effect.sync(() => void replied.push(event.data as Replied))
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* (yield* tools.snapshot())
      .execute({ sessionID, ...identity, call: { type: "tool-call", id: `call-${name}`, name, input } })
      .pipe(Effect.forkScoped)
    const asked: Permission.Request[] = []
    const attempts: { answer: Answer; accepted: boolean; error?: unknown }[] = []
    const counts = new Map<string, number>()
    const drive = (): Effect.Effect<Exit.Exit<unknown, unknown>> =>
      Effect.gen(function* () {
        const done = fiber.pollUnsafe()
        if (done) return done
        const [request] = yield* permission.list()
        if (!request) {
          yield* Effect.sleep("2 millis")
          return yield* drive()
        }
        const attempt = counts.get(request.id) ?? 0
        counts.set(request.id, attempt + 1)
        if (attempt === 0) asked.push(request)
        const given = answer(request, attempt)
        const chosen = Effect.isEffect(given) ? yield* given : given
        const exit = yield* permission
          .reply({ requestID: request.id, ...chosen } as Permission.ReplyInput)
          .pipe(Effect.exit)
        attempts.push({
          answer: chosen,
          accepted: Exit.isSuccess(exit),
          error: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
        })
        return yield* drive()
      })
    const exit = yield* drive()
    return { asked, replied, attempts, exit } satisfies Settled
  }).pipe(
    Effect.scoped,
    Effect.provide(
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
          FileAccess.node,
          FileMutation.node,
          FileLedger.node,
          plugins,
        ]),
        [
          FileLedger.node.replace(FileLedger.permissiveLayer),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Image.node.replace(imagePassthrough),
        ],
      ),
    ),
  )

// The session the call belongs to, in the project at `directory`, and an agent that asks about every action.
const seed = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "revise",
        directory,
        title: "revise",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(identity.agent, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
  })

const editRequest = (settled: Settled) => settled.asked.find((request) => request.action === "Edit")
const files = (value: unknown) =>
  (value as { files?: ReadonlyArray<{ file: string; patch: string; status: string; place?: string }> } | undefined)
    ?.files ?? []
const text = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? JSON.stringify((exit.value as { content?: unknown }).content ?? "") : ""
const declined = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError)

const withProject = <A, E>(body: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (project) => body(project.path),
    (project) => Effect.promise(() => project[Symbol.asyncDispose]()),
  )

describe("an approval answered with the person's revised content", () => {
  it.live("an Edit writes the revised file and tells the model the person changed the proposal", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "a.txt")
        yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
        const settled = yield* settle(
          directory,
          "Edit",
          { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
          () => ({
            reply: "once",
            content: "alpha\nREVISED\n",
          }),
        )
        expect(Exit.isSuccess(settled.exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("alpha\nREVISED\n")
        const request = editRequest(settled)
        expect(request && revisable(request)).toBe(true)
        // The reply records the diff that was approved, from the file as the request read it to the revised content, at
        // the place the request named (class 8).
        const reply = settled.replied.find((item) => item.requestID === request?.id)
        expect(reply?.reply).toBe("once")
        const [approved] = files(reply)
        expect(approved?.place).toBe(files(request?.metadata)[0]?.place)
        expect(approved?.file).toBe(files(request?.metadata)[0]?.file)
        expect(approved && applyPatch("alpha\nbeta\n", approved.patch)).toBe("alpha\nREVISED\n")
        // What ran is what was approved: the tool's own record of the change ends at the same text.
        const [ran] = files(
          Exit.isSuccess(settled.exit) ? (settled.exit.value as { metadata?: unknown }).metadata : undefined,
        )
        expect(ran && applyPatch("alpha\nbeta\n", ran.patch)).toBe("alpha\nREVISED\n")
        // The reference tells the model that the person modified its proposal before accepting it.
        expect(text(settled.exit)).toMatch(/modif/i)
      }),
    ),
  )

  // The reference counts an editor save as the person's change only when it differs from what the model proposed.
  it.live("an Edit answered with the proposal itself writes it and tells the model nothing more", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "a.txt")
        yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
        const settled = yield* settle(
          directory,
          "Edit",
          { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
          () => ({ reply: "once", content: "alpha\nBETA\n" }),
        )
        expect(Exit.isSuccess(settled.exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("alpha\nBETA\n")
        expect(text(settled.exit)).toContain("Edited a.txt (1 replacement)")
        expect(text(settled.exit)).not.toMatch(/modif/i)
      }),
    ),
  )

  it.live("a Write writes the revised content, over an existing file and as a new one", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "old.txt"), "before\n"))
        for (const name of ["old.txt", "new.txt"]) {
          const settled = yield* settle(directory, "Write", { file_path: name, content: "proposed\n" }, () => ({
            reply: "once",
            content: "revised\n",
          }))
          expect(Exit.isSuccess(settled.exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, name), "utf8"))).toBe("revised\n")
          const request = editRequest(settled)
          expect(request && revisable(request)).toBe(true)
          const [approved] = files(settled.replied.find((item) => item.requestID === request?.id))
          expect(approved && applyPatch(name === "old.txt" ? "before\n" : "", approved.patch)).toBe("revised\n")
          // The approved diff names the file the request showed and says whether the write creates it.
          expect(approved?.file).toBe(files(request?.metadata)[0]?.file)
          expect(approved?.status).toBe(name === "old.txt" ? "modified" : "added")
        }
      }),
    ),
  )

  it.live(
    "a revised content that equals the file as it is counts as a reject, as the reference's reverted diff does",
    () =>
      withProject((directory) =>
        Effect.gen(function* () {
          const file = path.join(directory, "a.txt")
          yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
          const settled = yield* settle(
            directory,
            "Edit",
            { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
            () => ({
              reply: "once",
              content: "alpha\nbeta\n",
            }),
          )
          expect(declined(settled.exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("alpha\nbeta\n")
          const request = editRequest(settled)
          expect(settled.replied.find((item) => item.requestID === request?.id)?.reply).toBe("reject")
        }),
      ),
  )

  it.live(
    "revised content comes only with a once reply: with always or reject it is refused and the question stays",
    () =>
      withProject((directory) =>
        Effect.gen(function* () {
          const file = path.join(directory, "a.txt")
          yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
          const answers: Answer[] = [
            { reply: "always", content: "alpha\nREVISED\n" },
            { reply: "reject", content: "alpha\nREVISED\n" },
            { reply: "once" },
          ]
          const settled = yield* settle(
            directory,
            "Edit",
            { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
            (request, attempt) => (request.action === "Edit" ? answers[attempt]! : { reply: "once" }),
          )
          const refused = settled.attempts.filter((item) => item.answer.content !== undefined)
          expect(refused.map((item) => item.accepted)).toEqual([false, false])
          // Each refusal is the typed error a client is told, and its message says why (class 13).
          expect(refused.map((item) => item.error instanceof Permission.RevisionError)).toEqual([true, true])
          expect(refused.map((item) => (item.error as Error).message)).toEqual([
            "Revised content can only be given with a once reply",
            "Revised content can only be given with a once reply",
          ])
          // The refused replies changed nothing: the question was still there for the plain reply, which ran the proposal.
          expect(Exit.isSuccess(settled.exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("alpha\nBETA\n")
          const request = editRequest(settled)
          expect(settled.replied.filter((item) => item.requestID === request?.id).map((item) => item.reply)).toEqual([
            "once",
          ])
        }),
      ),
  )

  it.live("only Edit and Write take revised content: a Patch or NotebookEdit question refuses it and stays", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const notebook = JSON.stringify({
          cells: [
            { cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["print(1)"] },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        })
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(directory, "p.txt"), "alpha\n"),
            fs.writeFile(path.join(directory, "n.ipynb"), notebook),
          ]),
        )
        const calls = [
          [
            "Patch",
            { patchText: "*** Begin Patch\n*** Update File: p.txt\n@@\n-alpha\n+beta\n*** End Patch" },
            "p.txt",
          ],
          [
            "NotebookEdit",
            { notebook_path: "n.ipynb", mode: "replace", cellId: "calc", source: "print(2)" },
            "n.ipynb",
          ],
        ] as const
        for (const [name, input, target] of calls) {
          const settled = yield* settle(directory, name, input, (request, attempt) =>
            request.action === "Edit" && attempt === 0 ? { reply: "once", content: "REVISED" } : { reply: "once" },
          )
          const request = editRequest(settled)
          expect(request && revisable(request)).toBeFalsy()
          const refused = settled.attempts.find((item) => item.answer.content !== undefined)
          expect(refused?.accepted).toBe(false)
          expect(refused?.error).toBeInstanceOf(Permission.RevisionError)
          expect((refused?.error as Error | undefined)?.message).toMatch(/only an Edit or Write approval/)
          expect(Exit.isSuccess(settled.exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, target), "utf8"))).not.toContain(
            "REVISED",
          )
        }
      }),
    ),
  )

  it.live("the revised content keeps the file's byte order mark", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "bom.txt")
        yield* Effect.promise(() => fs.writeFile(file, "﻿alpha\nbeta\n"))
        const settled = yield* settle(
          directory,
          "Edit",
          { file_path: "bom.txt", old_string: "beta", new_string: "BETA" },
          () => ({
            reply: "once",
            content: "alpha\nREVISED\n",
          }),
        )
        expect(Exit.isSuccess(settled.exit)).toBe(true)
        const bytes = yield* Effect.promise(() => fs.readFile(file))
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
        expect(bytes.subarray(3).toString("utf8")).toBe("alpha\nREVISED\n")
      }),
    ),
  )

  // An editor may save the person's version with the file's byte order mark. The mark is not part of the text: the
  // approved diff and the reject test compare the text alone, and the file keeps one mark.
  it.live("a revised content given with a byte order mark is the same text", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "bom.txt")
        const input = { file_path: "bom.txt", old_string: "beta", new_string: "BETA" }
        yield* Effect.promise(() => fs.writeFile(file, "﻿alpha\nbeta\n"))
        const revised = yield* settle(directory, "Edit", input, () => ({
          reply: "once",
          content: "﻿alpha\nREVISED\n",
        }))
        expect(Exit.isSuccess(revised.exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("﻿alpha\nREVISED\n")
        const request = editRequest(revised)
        const [approved] = files(revised.replied.find((item) => item.requestID === request?.id))
        expect(approved && applyPatch("alpha\nbeta\n", approved.patch)).toBe("alpha\nREVISED\n")

        yield* Effect.promise(() => fs.writeFile(file, "﻿alpha\nbeta\n"))
        const unchanged = yield* settle(directory, "Edit", input, () => ({
          reply: "once",
          content: "﻿alpha\nbeta\n",
        }))
        expect(declined(unchanged.exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("﻿alpha\nbeta\n")
      }),
    ),
  )

  // A guard, and it passes on the base: a revision must not skip the check that the file is still the one the request
  // read. A build that writes the revised content before that check fails here.
  it.live("a file that changed after the question was asked is not overwritten with the revised content", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "a.txt")
        yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
        const settled = yield* settle(
          directory,
          "Edit",
          { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
          () =>
            Effect.promise(() => fs.writeFile(file, "someone else\n")).pipe(
              Effect.as({ reply: "once" as const, content: "alpha\nREVISED\n" }),
            ),
        )
        expect(Exit.isFailure(settled.exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("someone else\n")
      }),
    ),
  )
})

// FU-M2-118: the Patch tool put a patch with the shared indentation trimmed on its request and its result, so a client
// that applies the request's patch to the file (VS Code's Open diff) found it did not apply and said the file had changed.
describe("a Patch request's diff applies to the file it names", () => {
  // Every line of the hunk, context included, is indented, which is what made the old patch lose its indentation.
  it.live("when the changed lines share their indentation", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        // Every line of the hunk, its context included, is indented: that is what the trimmed patch lost.
        const before = "    one()\n    two()\n"
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.ts"), before))
        const settled = yield* settle(
          directory,
          "Patch",
          {
            patchText:
              "*** Begin Patch\n*** Update File: a.ts\n@@\n     one()\n-    two()\n+    three()\n*** End Patch",
          },
          () => ({ reply: "once" }),
        )
        expect(Exit.isSuccess(settled.exit)).toBe(true)
        const after = yield* Effect.promise(() => fs.readFile(path.join(directory, "a.ts"), "utf8"))
        expect(after).toBe("    one()\n    three()\n")
        const [asked] = files(editRequest(settled)?.metadata)
        expect(asked && applyPatch(before, asked.patch)).toBe(after)
        const [ran] = files(
          Exit.isSuccess(settled.exit) ? (settled.exit.value as { metadata?: unknown }).metadata : undefined,
        )
        expect(ran && applyPatch(before, ran.patch)).toBe(after)
      }),
    ),
  )

  // A move onto an existing file shows that file's text as replaced; that entry's patch must apply to it too.
  it.live("when a move replaces a file whose lines share their indentation", () =>
    withProject((directory) =>
      Effect.gen(function* () {
        const replaced = "    old()\n    gone()\n"
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(directory, "from.ts"), "    one()\n    two()\n"),
            fs.writeFile(path.join(directory, "to.ts"), replaced),
          ]),
        )
        const settled = yield* settle(
          directory,
          "Patch",
          {
            patchText:
              "*** Begin Patch\n*** Update File: from.ts\n*** Move to: to.ts\n@@\n     one()\n-    two()\n+    three()\n*** End Patch",
          },
          () => ({ reply: "once" }),
        )
        expect(Exit.isSuccess(settled.exit)).toBe(true)
        const after = yield* Effect.promise(() => fs.readFile(path.join(directory, "to.ts"), "utf8"))
        expect(after).toBe("    one()\n    three()\n")
        const entry = (value: unknown) =>
          files(value).find((item) => !("from" in item) && applyPatch(replaced, item.patch) === after)
        expect(entry(editRequest(settled)?.metadata)).toBeDefined()
        expect(
          entry(Exit.isSuccess(settled.exit) ? (settled.exit.value as { metadata?: unknown }).metadata : undefined),
        ).toBeDefined()
      }),
    ),
  )
})
