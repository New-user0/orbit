export * as FileChangeReminder from "./file-change-reminder.js"

import { structuredPatch } from "diff"
import { DateTime, Effect, Cause } from "effect"
import type { Agent } from "@orbit/schema/agent"
import type { Session } from "@orbit/schema/session"
import { FSUtil } from "@orbit/util/fs-util"
import type { Environment } from "./environment/index.js"
import { FileAccess } from "./file-access.js"
import { FileLedger } from "./file-ledger.js"
import type { Permission } from "./permission.js"
import type { ProjectTrust } from "./project-trust.js"
import type { SessionMessage } from "./session/message.js"
import { postedInRun } from "./session/reminder-text.js"
import type { Durable, Input } from "./session/reminders.js"
import { ToolNames } from "./tool/names.js"
import { Notebook } from "./tool/notebook.js"
import { ReadToolFileSystem } from "./tool/read-filesystem.js"

/**
 * Tells a session, at each logical step, that a file it wrote was changed by someone else since, with the changed lines,
 * as the reference does. The files watched are the FileLedger's records that hold text: what the session's own Edit,
 * Write, Patch or NotebookEdit left, and what the rebuild below found in history. A read records no text, so a file the
 * model only read is never reported; the edit tools' freshness check catches it instead.
 *
 * Each watched file is resolved again as the read tool resolves it, then checked on that same target before anything is
 * read (`gate`), and its time is compared with the stored one. A newer file is read with the read tool's reader, and a
 * whole text result is recorded as a read, so the change counts as seen, a later edit needs no new read, and the watch
 * ends. A notebook is recorded the same way but not reported. A file that is gone is forgotten. Anything else (a refusal,
 * a folder, an image, a binary file, a file longer than one read) is skipped and kept for the next step.
 *
 * The path and the changed lines come from the disk, so they travel only in `data`; the harness text names neither.
 */

const KIND = "file-change"
/** Unchanged lines shown around each change. */
const CONTEXT_LINES = 8
/** The longest snippet, in characters; a longer one is cut at a line break and says how many lines it left out. */
const MAX_SNIPPET = 8_192
// A comparison is synchronous, so it gets no more than the producer's own deadline.
const DIFF_TIMEOUT_MS = 1_000

const TEXT =
  "A file you worked with earlier in this session has since been changed outside the conversation, by the user or by a tool such as a linter. " +
  "The change is intended, so take it into account from now on and do not undo it unless the user asks you to. " +
  "The user already knows about it, so do not mention it to them. " +
  "The lines of the file that changed follow, numbered as the Read tool numbers them."

export interface Services {
  readonly ledger: FileLedger.Interface
  readonly access: FileAccess.Interface
  readonly reader: ReadToolFileSystem.Interface
  readonly permission: Permission.Interface
  readonly trust: ProjectTrust.Interface
  readonly environment: Environment.Interface
}

export const durable = (services: Services): Durable => ({
  name: KIND,
  run: (input) =>
    Effect.gen(function* () {
      // Claimed before the work, so a rebuild that runs past the producer's deadline costs one step, not every step.
      if (yield* services.ledger.claim(input.session.id)) yield* rebuild(services, input)
      if (postedInRun(input.messages, KIND)) return []
      const watched = yield* services.ledger.watched(input.session.id)
      const entries = yield* Effect.forEach(
        watched,
        (file) =>
          changed(services, input, file).pipe(
            // One file that fails costs only itself.
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("A changed file could not be checked, so it was skipped").pipe(
                  Effect.annotateLogs({ sessionID: input.session.id, cause: Cause.pretty(cause) }),
                  Effect.as([]),
                ),
            ),
          ),
        { concurrency: 8 },
      )
      return entries.flat()
    }),
})

/**
 * The target a path stands for, when a read of it needs nobody's answer and no deny rule stops it, and undefined
 * otherwise. It is resolved once, as the read tool resolves it (a share or device spelling is refused before any disk is
 * read), and the checks are made on that same target: the project's containment at this moment (`reachable`, which
 * follows links), whether a target outside the project still really is where the session's write put it (`place`, the
 * ledger's record of that), the Read deny rules on the file and on where it leads, and the deny rules for the folder
 * outside the project it is in. An ask rule does not stop it: the reference consults deny rules only.
 */
export const gate = Effect.fnUntraced(function* (
  services: Pick<Services, "access" | "permission" | "trust">,
  sessionID: Session.ID,
  agent: Agent.ID,
  file: string,
  place?: string,
) {
  const target = yield* services.access.locate(file, "file").pipe(Effect.orElseSucceed(() => undefined))
  if (target === undefined) return undefined
  if (!(yield* services.trust.reachable(target.absolute))) return undefined
  // Outside the project, the person allowed the place the write went to, not whatever its name leads to now. A link
  // swapped in since, for the file or for any folder above it, moves where the name really leads, and the read tool
  // would ask about that new place, so the file is skipped. Without a recorded place (a file from history, which is
  // seeded only inside the project) nothing outside it is read. Both sides are real paths, compared as the resolver
  // compares them.
  if (target.externalDirectory !== undefined) {
    const now = FileAccess.realPlace(target)
    if (place === undefined || !(FSUtil.contains(place, now) && FSUtil.contains(now, place))) return undefined
  }
  const base = { sessionID, agent }
  const external = services.access.externalRequest([target], base)
  const requests = [readRequest(target, base), ...(external === undefined ? [] : [external])]
  const denied = yield* Effect.forEach(requests, (request) =>
    services.permission.denied(request).pipe(Effect.orElseSucceed(() => true)),
  )
  return denied.some(Boolean) ? undefined : target
})

const readRequest = (
  target: FileAccess.Target,
  base: Pick<Permission.AssertInput, "sessionID" | "agent">,
): Permission.AssertInput => ({
  action: "Read",
  resources: [target.resource],
  save: ["*"],
  metadata: { paths: [target.place] },
  ...FileAccess.leadsOf([target]),
  ...base,
})

const changed = Effect.fnUntraced(function* (services: Services, input: Input, file: FileLedger.Watched) {
  const sessionID = input.session.id
  const target = yield* gate(services, sessionID, input.agent.id, file.path, file.seen.place)
  if (target === undefined) return []
  // A read of no bytes follows links, as the time a read records does. A file that cannot be opened is not newer.
  const time = yield* services.environment.files.read(target.absolute, { offset: 0, length: 0 }).pipe(
    Effect.map((opened) => opened.info.mtimeMs),
    Effect.catchTag("Environment.NotFound", () => Effect.succeed(undefined)),
    Effect.orElseSucceed(() => Number.NEGATIVE_INFINITY),
  )
  if (time === undefined) return yield* services.ledger.forget(sessionID, file.path).pipe(Effect.as([]))
  if (time <= file.seen.mtimeMs) return []
  const read = yield* services.reader.read(target.absolute, target.resource).pipe(Effect.orElseSucceed(() => undefined))
  // Only a whole text file is compared. Anything else, a read that failed included, keeps the entry as it was, so it is
  // tried again at the next step (a file deleted since the time was read is forgotten then).
  if (read?.seen === undefined || read.content.type !== "file" || read.content.encoding !== "utf8") return []
  yield* services.ledger.recordRead(sessionID, file.path, read.seen)
  if (Notebook.isNotebook(target.absolute)) return []
  const content = snippet(file.seen.text, read.content.content)
  if (content === undefined) return []
  return [{ kind: KIND, text: TEXT, data: { label: `Changed lines of ${file.path}`, content } }]
})

/**
 * The changed lines of `after`, compared with `before` in the form the read tool shows text: each hunk's kept and added
 * lines, numbered from where the hunk starts in the old text, as the reference numbers them, and hunks joined by a line
 * that holds only an ellipsis. Undefined when the texts show the same or the comparison ran out of time.
 */
const snippet = (before: string, after: string) => {
  const old = shown(before)
  const now = shown(after)
  if (old === now) return undefined
  const patch = structuredPatch(
    "",
    "",
    old === "" ? "" : `${old}\n`,
    now === "" ? "" : `${now}\n`,
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  if (patch === undefined) return undefined
  const content = patch.hunks
    .map((hunk) =>
      hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line, index) => `${Math.max(1, hunk.oldStart) + index}: ${line.slice(1)}`)
        .join("\n"),
    )
    .join("\n...\n")
  if (content.length <= MAX_SNIPPET) return content
  // A line is cut to the read tool's limit, far below the cap, so a line break always falls within it.
  const head = content.slice(0, content.lastIndexOf("\n", MAX_SNIPPET))
  return `${head}\n[${content.split("\n").length - head.split("\n").length} more lines not shown]`
}

// Text as the read tool shows it: a leading BOM dropped, CR LF read as LF, one final line break dropped, and each line
// cut where the read tool cuts it. Line endings or a final line break alone are then no change.
const shown = (text: string) =>
  text
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map(ReadToolFileSystem.clampLine)
    .join("\n")

/**
 * After a restart the ledger is empty, so the first collection for a session refills it from the history it is given
 * (after the latest checkpoint), as the reference rebuilds its cache from the transcript on resume. Only three tools
 * count, later calls winning: a whole read that was not a repeat or truncated (the text it showed, stamped with its
 * time), a write whatever its outcome (the text it was given, stamped with its time) and an edit that did not fail (the
 * file as it is now). A path in history may come from an imported session, so it is resolved as the read tool resolves
 * it, a share or device spelling is refused before any disk is read, and only a file inside the project that passes
 * `gate` and that the read tool would read without a question is kept. Of those, only the newest `FileLedger.MAX_FILES` files are kept and read, as the ledger would drop
 * the rest. A record that is already there wins over one from history. The session is claimed before the rebuild starts,
 * so one that runs past the producer's deadline is not tried again in this process.
 */
const rebuild = Effect.fnUntraced(function* (services: Services, input: Input) {
  // The newest call for each spelling; then the newest for each file, whatever spelling named it.
  const bySpelling = new Map(fromHistory(input.messages).map((found) => [found.path, found] as const))
  const resolved = yield* Effect.forEach(
    Array.from(bySpelling.values()),
    Effect.fnUntraced(function* (found) {
      const target = yield* gate(services, input.session.id, input.agent.id, found.path)
      if (target === undefined || target.externalDirectory !== undefined) return []
      // The session may never have read this file: the call can have failed, and the store can be imported. So a file
      // that the read tool would ask about first (the built-in `.env` ask, a rule the person wrote, a link onto such a
      // file) is not seeded, and nothing of it is read (class 5).
      const quiet = yield* services.permission
        .allowed(readRequest(target, { sessionID: input.session.id, agent: input.agent.id }))
        .pipe(Effect.orElseSucceed(() => false))
      return quiet ? [{ ...found, target }] : []
    }),
    { concurrency: 8 },
  )
  const byFile = new Map(
    resolved
      .flat()
      .toSorted((left, right) => left.order - right.order)
      .map((found) => [found.target.absolute, found] as const),
  )
  // The ledger keeps only the newest files, so an older one is not read at all.
  const files = yield* Effect.forEach(
    Array.from(byFile.values())
      .toSorted((left, right) => left.order - right.order)
      .slice(-FileLedger.MAX_FILES),
    Effect.fnUntraced(function* (found) {
      if (found.text !== undefined)
        return [{ path: found.target.absolute, seen: { mtimeMs: found.at, text: found.text } }]
      // An edit's result holds no text of the file, so the file is read as it is now.
      const read = yield* services.reader
        .read(found.target.absolute, found.target.resource)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (read?.seen === undefined || read.content.type !== "file" || read.content.encoding !== "utf8") return []
      return [{ path: found.target.absolute, seen: { ...read.seen, text: read.content.content } }]
    }),
    { concurrency: 8 },
  )
  yield* services.ledger.seed(input.session.id, files.flat())
})

interface Found {
  readonly path: string
  readonly order: number
  readonly at: number
  /** Undefined for an edit, whose file is read from disk. */
  readonly text?: string
}

const fromHistory = (messages: ReadonlyArray<SessionMessage.Info>): Found[] =>
  messages
    .flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool" ? [found(part, message.time.created)] : []))
        : [],
    )
    .flatMap((item, order) => (item === undefined ? [] : [{ ...item, order }]))

const found = (
  part: Extract<SessionMessage.Info, { type: "assistant" }>["content"][number] & { type: "tool" },
  created: DateTime.Utc,
): Omit<Found, "order"> | undefined => {
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  const name = ToolNames.canonical(part.name)
  const given = ToolNames.lowerInput(name, part.state.input)
  if (typeof given.file_path !== "string") return undefined
  const at = DateTime.toEpochMillis(part.time.completed ?? created)
  if (name === ToolNames.tools.write)
    return typeof given.content === "string" ? { path: given.file_path, at, text: given.content } : undefined
  if (part.state.status !== "completed") return undefined
  if (name === ToolNames.tools.edit) return { path: given.file_path, at }
  if (name !== ToolNames.tools.read) return undefined
  if (given.offset !== undefined || given.limit !== undefined || given.pages !== undefined) return undefined
  if (part.state.metadata?.unchanged === true || part.state.metadata?.truncated === true) return undefined
  const text = shownText(part.state.content)
  return text === undefined ? undefined : { path: given.file_path, at, text }
}

// The file text a whole read showed: the result without reminder blocks, past its `Read file` header line, with each
// line's number taken off.
const shownText = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) => {
  const result = content
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim()
  if (!result.startsWith("Read file ")) return undefined
  return result
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\d+: /, ""))
    .join("\n")
}
