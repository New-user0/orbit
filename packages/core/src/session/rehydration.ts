export * as SessionRehydration from "./rehydration.js"

import path from "path"
import { createHash } from "crypto"
import { Context, Effect, Layer, Result, Schema, Option } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LinkShare } from "@orbit/util/link-share"
import { Patch } from "@orbit/util/patch"
import { block, envelope } from "@orbit/util/reminder-text"
import { Bus } from "../bus.js"
import { FileAccess } from "../file-access.js"
import { FileChangeReminder } from "../file-change-reminder.js"
import { FileLedger } from "../file-ledger.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { InstructionTriggers } from "../instruction-triggers.js"
import { Job } from "../job.js"
import { Permission } from "../permission.js"
import { PlanMode } from "../plan-mode.js"
import { ProjectTrust } from "../project-trust.js"
import { ToolNames } from "../tool/names.js"
import { Notebook } from "../tool/notebook.js"
import { ReadTool } from "../tool/plugin/read.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { TodoReminders } from "../tool/todo-reminders.js"
import { Token } from "../util/token.js"
import type { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { SessionMessage } from "./message.js"
import { ReminderText } from "./reminder-text.js"
import { withoutReplaced } from "./runner/to-llm-message.js"
import type { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

/**
 * What a completed compaction gives back, as the reference attaches it right after its summary: the newest files the
 * session worked with, read again now; its background subagents; its plan file; and the skills it used. They go in one
 * hidden `session.synthetic` row after the checkpoint, which also carries the todo and task lists across it (in its
 * metadata only, as the reference keeps them in its app state and never shows them here).
 *
 * The row is built once, when the compaction completes, and stored. Nothing builds it again: a restart, a fork or an
 * import finds it in history. It is not a reminder row, so a later compaction summarizes it like any message.
 *
 * Files and skills are budgeted from the room left below the automatic threshold after the checkpoint; the agent notes
 * and the plan come first and are not budgeted. While only this row follows the checkpoint, `SessionCompaction.due` does
 * not compact again. Each file is re-read through the read tool's own reader after the checks a read of it would pass,
 * made on its real path at this moment (classes 1, 4, 5 and 8), and a file the model is shown counts as read for the
 * edit tools.
 */

/** How many of the newest files are read again. */
export const FILES = 5
/** The most one file may take; a larger one is named in a note instead. */
export const FILE_TOKENS = 5_000
/** The most all files together may take. */
export const FILES_TOKENS = 50_000
/** The most one skill may take; a longer one keeps its head. */
export const SKILL_TOKENS = 5_000
/** The most all skills together may take. */
export const SKILLS_TOKENS = 25_000

const FILE_TEXT =
  "Before the conversation was summarized, the Read tool was called on the file named below. What follows is what Read returns for it now."
const SKILLS_TEXT =
  "The skills below were used earlier in this session and still apply. Keep following their instructions."

export interface Fixed {
  /** The agent notes, then the plan, each a rendered section. */
  readonly sections: ReadonlyArray<string>
  readonly tokens: number
}

export interface Interface {
  /** The sections that are not budgeted (the background subagents and the plan file), and their size. */
  readonly fixed: (session: SessionSchema.Info) => Effect.Effect<Fixed>
  /**
   * Builds and stores the row for a compaction that just ended, then counts what it showed as read. `before` is the
   * context the compaction was given, `held` the ledger's records from before it ended, `view` the history after it, and
   * `room` the tokens left below the automatic threshold (unset for an unknown window). `only: "plan"` restores the plan
   * file alone.
   */
  readonly after: (input: {
    readonly before: SessionContext.Loaded
    readonly held: ReadonlyMap<string, FileLedger.Seen>
    readonly view: ReadonlyArray<SessionMessage.Info>
    readonly room?: number
    readonly only?: "plan"
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionRehydration") {}

/** True for the row a compaction's rehydration stored. */
export const isRow = (message: SessionMessage.Info) =>
  message.type === "synthetic" && typeof message.metadata?.rehydration === "object" && message.metadata.rehydration !== null

const Files = Schema.Array(Schema.String)

// The shape of a session ID that may name a file: no separator, dot, colon or anything else a path reads.
const PLAIN_ID = /^ses_\w+$/

// Two real paths for one place, compared as the resolver compares them.
const same = (left: string, right: string) => FSUtil.contains(left, right) && FSUtil.contains(right, left)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const ledger = yield* FileLedger.Service
    const access = yield* FileAccess.Service
    const reader = yield* ReadToolFileSystem.Service
    const permission = yield* Permission.Service
    const trust = yield* ProjectTrust.Service
    const triggers = yield* InstructionTriggers.Service
    const discovery = yield* InstructionDiscovery.Service
    const job = yield* Job.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const planPath = (sessionID: SessionSchema.ID) => path.join(PlanMode.directory(global.home), `${sessionID}.md`)

    /**
     * The plan file, read from its real place only. An imported session ID is data, so one that is not a plain ID names
     * no file (class 5). A share spelling is refused before anything touches the disk, then the real plan folder and the
     * real file are taken once, and the file is read from that real path only while it sits directly in that folder: a
     * link out of it or below it, or one that leads nowhere, gives no plan (class 4).
     */
    const plan = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (!PLAIN_ID.test(sessionID)) return []
      const file = planPath(sessionID)
      if (LinkShare.isShare(file) || (yield* LinkShare.of(fs, file)) !== undefined) return []
      const folder = yield* fs.realPath(PlanMode.directory(global.home)).pipe(Effect.orElseSucceed(() => undefined))
      const real = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => undefined))
      if (folder === undefined || real === undefined || !same(path.dirname(real), folder)) return []
      const text = yield* fs.readFileString(real).pipe(Effect.orElseSucceed(() => ""))
      if (text === "") return []
      return [
        ReminderText.render({
          text: `Plan mode left a plan at ${ReminderText.oneLine(file)}; its text follows. Continue it only where it still fits the task and has steps left.`,
          data: { label: "Plan file", content: text },
        }),
      ]
    })

    // The session's background subagents whose result has not been delivered yet, in the order they were started.
    const agents = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const pending = (yield* job.pendingBackground).flatMap((entry) =>
        entry.recovery.kind === "subagent" &&
        entry.recovery.parentSessionID === sessionID &&
        entry.recovery.childSessionID !== sessionID
          ? [{ ...entry, recovery: entry.recovery }]
          : [],
      )
      return yield* Effect.forEach(
        pending.toSorted((left, right) => left.notificationID.localeCompare(right.notificationID)),
        Effect.fnUntraced(function* (entry) {
          // The stored status is written when the job is sent to the background and when it settles, so the live one wins.
          const live = yield* job.get(entry.id)
          return note(entry.recovery, live?.status ?? entry.status, live?.error ?? entry.error)
        }),
      )
    })

    const fixed = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      const sections = [...(yield* agents(session.id)), ...(yield* plan(session.id))]
      return { sections, tokens: sections.reduce((sum, section) => sum + Token.estimate(section), 0) }
    })

    /**
     * The newest files the session touched before the compaction, read again. Each candidate is resolved once, as the
     * read tool resolves it (a share or device spelling is refused before any disk is read), and one file is one entry
     * whatever spellings named it. A folder a Read listed takes no place. The five newest are taken before any is read,
     * so a file that fails leaves fewer.
     */
    const files = Effect.fnUntraced(function* (
      input: Parameters<Interface["after"]>[0],
      budget: number,
    ) {
      // An untrusted folder supplies nothing that is read unattended (class 1).
      if (!(yield* trust.trusted())) return { used: 0, sections: [], restored: [] }
      const sessionID = input.before.session.id
      const plan = planPath(sessionID)
      const listed = yield* discovery.list()
      const instructions = Array.isArray(listed) ? listed.filter((file) => file.kind !== "rule").map((file) => file.path) : []
      const locate = (file: string) => access.locate(file, "file").pipe(Effect.orElseSucceed(() => undefined))
      const key = (target: FileAccess.Target) => {
        const real = FileAccess.realPlace(target)
        return process.platform === "win32" ? real.toLowerCase() : real
      }
      // What the kept span already shows: its reads of any range, but not a read answered with the unchanged stub.
      const checkpoint = input.view.findLastIndex(
        (message) => message.type === "compaction" && message.status === "completed",
      )
      const visible = new Set(
        (yield* Effect.forEach(shownReads(input.view.slice(0, Math.max(0, checkpoint))), locate)).flatMap((target) =>
          target === undefined ? [] : [key(target)],
        ),
      )
      const seen = new Set<string>()
      const chosen: FileAccess.Target[] = []
      for (const spelling of touched(input.before.messages)) {
        if (chosen.length >= FILES) break
        const target = yield* locate(spelling)
        if (target === undefined || seen.has(key(target))) continue
        seen.add(key(target))
        if (visible.has(key(target)) || same(target.absolute, plan)) continue
        if (instructions.some((file) => same(file, target.absolute))) continue
        if (path.basename(target.absolute) === "MEMORY.md" && (yield* access.inMemory(target.absolute))) continue
        // Read lists a folder too, but only files are restored, so a listing must not take one of the five places.
        if (yield* fs.isDir(target.absolute)) continue
        chosen.push(target)
      }
      const read = yield* Effect.forEach(chosen, (target) => restore(input, target), { concurrency: "unbounded" })
      // Newest first while they fit; one that does not fit is skipped and a smaller later one may still fit.
      return read.reduce(
        (found, item) => {
          if (item === undefined) return found
          const size = Token.estimate(item.section)
          if (found.used + size > budget) return found
          return {
            used: found.used + size,
            sections: [...found.sections, item.section],
            restored: item.file === undefined ? found.restored : [...found.restored, item.file],
          }
        },
        { used: 0, sections: [] as string[], restored: [] as Restored[] },
      )
    })

    // One candidate read again, after the checks a read of it would pass now, on the target those checks resolved.
    const restore = Effect.fnUntraced(function* (
      input: Parameters<Interface["after"]>[0],
      located: FileAccess.Target,
    ): Effect.fn.Return<{ readonly section: string; readonly file?: Restored } | undefined> {
      const sessionID = input.before.session.id
      const agent = input.before.agent.id
      const target = yield* FileChangeReminder.gate(
        { access, permission, trust },
        sessionID,
        agent,
        located.absolute,
        (gated) => input.held.get(gated.absolute)?.place,
      )
      if (target === undefined) return undefined
      // A file only history names (a restart, a fork, an import) may never have been read with the person's answer, so it
      // is read only when the read tool would read it without asking (classes 5 and 8). A file this process read keeps
      // the reference's rule, so an ask rule does not stop it, but only while its name leads to itself: once it leads
      // somewhere else, the read tool would ask about that place, which the person never answered for (class 8).
      if (
        (!input.held.has(target.absolute) || target.leads !== undefined) &&
        !(yield* permission
          .allowed(FileChangeReminder.readRequest(target, { sessionID, agent }))
          .pipe(Effect.orElseSucceed(() => false)))
      )
        return undefined
      const read = yield* reader.read(target.absolute, target.resource).pipe(Effect.orElseSucceed(() => undefined))
      // A folder's listing comes without `seen`, so it is never restored.
      if (read === undefined || read.seen === undefined) return undefined
      const pointer = { section: pointerNote(target.absolute) }
      // The reader encodes only an image or a PDF, and refuses any other binary file.
      if (read.content.type === "file" && read.content.encoding === "base64") return pointer
      const page =
        read.content.type === "file" && Notebook.isNotebook(target.absolute)
          ? ((yield* ReadTool.notebookPage(read.content.content, undefined, undefined).pipe(
              Effect.orElseSucceed(() => undefined),
            )) ?? read.content)
          : read.content
      if (page.type === "text-page" && page.truncated) return pointer
      const content = ReadTool.toModelContent(target.absolute, undefined, page)
      if (typeof content !== "string" || Token.estimate(content) > FILE_TOKENS) return pointer
      const note = yield* ReadTool.memoryNote(access, fs, target.absolute)
      return {
        section: ReminderText.render({ text: FILE_TEXT, data: { label: target.absolute, content: `${note}${content}` } }),
        file: {
          absolute: target.absolute,
          seen: read.seen,
          digest: createHash("sha256").update(content).digest("hex"),
        },
      }
    })

    // The session's skills, from its whole stored history: the newest use of each, cut to its head.
    const skills = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, budget: number) {
      const used = new Map<string, { readonly name: string; readonly text: string }>()
      withoutReplaced(yield* store.messages({ sessionID, order: "asc" }).pipe(Effect.orDie))
        .flatMap(skillsOf)
        .forEach((skill) => {
          used.delete(skill.id)
          used.set(skill.id, skill)
        })
      const blocks = Array.from(used)
        .toReversed()
        .map(([id, skill]) => block(`Skill ${skill.name} (ID ${id})`, head(id, skill.text)))
      const admitted = blocks.reduce(
        (found, item) => {
          const size = Token.estimate(item)
          return found.used + size > budget ? found : { used: found.used + size, blocks: [...found.blocks, item] }
        },
        { used: 0, blocks: [] as string[] },
      )
      return admitted.blocks.length === 0 ? [] : [[envelope(SKILLS_TEXT), ...admitted.blocks].join("\n\n")]
    })

    const after: Interface["after"] = Effect.fnUntraced(function* (input) {
      const session = input.before.session
      if (input.only === "plan") return yield* post(session.id, yield* plan(session.id), [], {})
      const fixedPart = yield* fixed(session)
      const room = input.room === undefined ? undefined : Math.max(0, input.room - fixedPart.tokens)
      const restored = yield* files(input, Math.min(FILES_TOKENS, room ?? FILES_TOKENS))
      const left = room === undefined ? SKILLS_TOKENS : Math.min(SKILLS_TOKENS, room - restored.used)
      const lists = TodoReminders.current(withoutReplaced(input.before.messages))
      return yield* post(
        session.id,
        [...restored.sections, ...fixedPart.sections, ...(yield* skills(session.id, left))],
        restored.restored,
        {
          ...(lists.todos.length > 0 ? { todos: lists.todos } : {}),
          ...(lists.tasks.length > 0 ? { tasks: lists.tasks } : {}),
          ...(lists.family === undefined ? {} : { family: lists.family }),
        },
      )
    })

    // The row, and then what it showed counting as read, as one step: an interruption lands before both or after both.
    const post = (
      sessionID: SessionSchema.ID,
      sections: ReadonlyArray<string>,
      restored: ReadonlyArray<Restored>,
      lists: Record<string, unknown>,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (sections.length === 0 && Object.keys(lists).length === 0) return
          yield* bus.publish(SessionEvent.Synthetic, {
            sessionID,
            text: sections.join("\n\n"),
            metadata: { rehydration: { files: restored.map((file) => file.absolute), ...lists } },
          })
          yield* Effect.forEach(
            restored,
            (file) =>
              ledger
                .recordRead(sessionID, file.absolute, file.seen)
                .pipe(Effect.andThen(ledger.markRead(sessionID, file.absolute, "1:default", file.digest))),
            { discard: true },
          )
          // The nested instruction files of the restored files are due, as after a read. The triggers bring nothing for a
          // file outside the folder the session started in, and a PDF is never restored here.
          if (restored.length > 0)
            yield* triggers.touched({ sessionID, targets: restored.map((file) => ({ path: file.absolute })) })
        }),
      )

    return Service.of({ fixed, after })
  }),
)

/** Restores nothing, for tests and embedders that compact without files, jobs or a plan. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({ fixed: () => Effect.succeed({ sections: [], tokens: 0 }), after: () => Effect.void }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    SessionStore.node,
    FileLedger.node,
    FileAccess.node,
    ReadToolFileSystem.node,
    Permission.node,
    ProjectTrust.node,
    InstructionTriggers.node,
    InstructionDiscovery.node,
    Job.node,
    Global.node,
    FSUtil.node,
  ],
})

interface Restored {
  readonly absolute: string
  readonly seen: FileLedger.Seen
  readonly digest: string
}

const pointerNote = (file: string) =>
  ReminderText.render({
    text: `${ReminderText.oneLine(file)} is left out of this message because it is long or not plain text. It was in the context before the summary; Read it again when you need it.`,
  })

// One note per background subagent, by its state. The description and the error come from the model and the child, so
// they are put on one line, and an error of several lines goes in a data block.
const note = (recovery: Extract<Job.Recovery, { kind: "subagent" }>, status: Job.Status, error?: string) => {
  const named = `session ${ReminderText.oneLine(recovery.childSessionID)} (agent ${ReminderText.oneLine(recovery.agent)}, task "${ReminderText.oneLine(recovery.description)}")`
  if (status === "running")
    return ReminderText.render({
      text: `The background subagent in ${named} is still running. Do NOT start another subagent for the same task. A message will report when it ends, and the Agent tool with sessionID ${ReminderText.oneLine(recovery.childSessionID)} reaches it in the meantime.`,
    })
  if (status === "cancelled") return ReminderText.render({ text: `The background subagent in ${named} was stopped.` })
  const outcome = status === "error" ? "failed" : "finished"
  if (status === "error" && error !== undefined && ReminderText.oneLine(error) !== error.trim())
    return ReminderText.render({
      text: `The background subagent in ${named} ${outcome}, with the error below. Its result arrives as a message.`,
      data: { label: "Error", content: error },
    })
  const detail = status === "error" && error !== undefined ? `: ${ReminderText.oneLine(error)}` : ""
  return ReminderText.render({
    text: `The background subagent in ${named} ${outcome}${detail}. Its result arrives as a message.`,
  })
}

// A skill's text cut to its head, with a note that says how to load the rest.
const head = (id: string, text: string) => {
  if (Token.estimate(text) <= SKILL_TOKENS) return text
  const marker = `\n\n[The rest of this skill is left out. Load it whole again with the Skill tool and ID ${id}.]`
  return text.slice(0, SKILL_TOKENS * 4 - marker.length) + marker
}

/**
 * The paths the session's calls touched, newest first: whole and ranged reads (not one answered with the unchanged
 * stub), edits, writes, notebook edits, each file a patch leaves, and the files a previous rehydration restored. They are
 * names from history, which an import can supply (class 5): each is only resolved and checked, never joined into a path.
 */
const touched = (messages: ReadonlyArray<SessionMessage.Info>) =>
  Array.from(
    new Set(
      withoutReplaced(messages)
        .flatMap((message) => {
          if (message.type === "synthetic" && isRow(message))
            return Option.getOrElse(
              Schema.decodeUnknownOption(Files)((message.metadata?.rehydration as { files?: unknown }).files),
              () => [],
            ).toReversed()
          if (message.type !== "assistant") return []
          return message.content.flatMap((part) => (part.type === "tool" ? named(part) : []))
        })
        .toReversed(),
    ),
  )

const named = (part: Extract<SessionMessage.AssistantContent, { type: "tool" }>): ReadonlyArray<string> => {
  if (part.state.status !== "completed") return []
  const name = ToolNames.canonical(part.name)
  const given = ToolNames.lowerInput(name, part.state.input)
  if (name === ToolNames.tools.patch) {
    if (typeof given.patchText !== "string") return []
    const parsed = Patch.parse(given.patchText)
    if (Result.isFailure(parsed)) return []
    return parsed.success.flatMap((hunk) => {
      if (hunk.type === "delete") return []
      if (hunk.type === "update" && hunk.movePath !== undefined) return [hunk.movePath]
      return [hunk.path]
    })
  }
  if (name === ToolNames.tools.notebook_edit) return typeof given.notebook_path === "string" ? [given.notebook_path] : []
  if (name !== ToolNames.tools.read && name !== ToolNames.tools.edit && name !== ToolNames.tools.write) return []
  if (typeof given.file_path !== "string") return []
  if (name === ToolNames.tools.read && part.state.metadata?.unchanged === true) return []
  return [given.file_path]
}

// The paths of reads (any range) that showed text: a read answered with the unchanged stub shows nothing new.
const shownReads = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "completed") return []
          if (ToolNames.canonical(part.name) !== ToolNames.tools.read || part.state.metadata?.unchanged === true) return []
          const given = ToolNames.lowerInput(ToolNames.tools.read, part.state.input)
          return typeof given.file_path === "string" ? [given.file_path] : []
        })
      : [],
  )

// The skills a message shows the model: a call of the Skill tool, a skill the person activated, or one a prompt carried.
const skillsOf = (message: SessionMessage.Info): ReadonlyArray<{ id: string; name: string; text: string }> => {
  if (message.type === "skill") return [{ id: message.skill, name: message.name, text: message.text }]
  if (message.type === "user")
    return (message.skills ?? []).flatMap((skill) =>
      skill.text === undefined ? [] : [{ id: skill.id, name: skill.name, text: skill.text }],
    )
  if (message.type !== "assistant") return []
  return message.content.flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    if (ToolNames.canonical(part.name) !== ToolNames.tools.skill) return []
    const id = part.state.input.id
    if (typeof id !== "string") return []
    const name = typeof part.state.metadata?.name === "string" ? part.state.metadata.name : id
    const text = part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
    return [{ id, name, text }]
  })
}
