export * as FileChangeReminder from "./file-change-reminder.js"

import { structuredPatch } from "diff"
import { DateTime, Duration, Effect, Cause, Option, Result } from "effect"
import type { Agent } from "@orbit/schema/agent"
import type { Session } from "@orbit/schema/session"
import { FSUtil } from "@orbit/util/fs-util"
import { Patch } from "@orbit/util/patch"
import type { Environment } from "./environment/index.js"
import { FileAccess } from "./file-access.js"
import { FileLedger } from "./file-ledger.js"
import type { Permission } from "./permission.js"
import type { ProjectTrust } from "./project-trust.js"
import type { SessionMessage } from "./session/message.js"
import { postedInRun } from "./session/reminder-text.js"
import type { Durable, Entry, Input } from "./session/reminders.js"
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
 * Those records and the forgetting are each entry's `commit`, which runs only after the collection posted its rows, and
 * only while the file's record is still the one this collection checked (`FileLedger.settle`). A collection that runs
 * past its deadline, is interrupted or fails leaves the ledger as it was, so no change counts as seen unless its row was
 * posted, and the edit tools still refuse a changed file as stale.
 *
 * A slow file costs only its own share. The files are checked eight at a time, a new one starting only while the
 * step's `FILE_BUDGET_MS` lasts, and each check, once started, has half of that budget to finish, even past the end of
 * the budget; a file whose check runs out of its share is kept as it is. So every check that starts either finishes or
 * uses its whole share, and none is cut short because the step's budget ran out. The ledger keeps a scan per session
 * (`FileLedger.toCheck`): a file whose check started counts as checked in it, and the files not yet checked come first,
 * the most recently used first. So each step goes on where the last one stopped, the newest file is checked at the
 * first step, and a file whose check was still running when the budget ran out was still checked. The comparisons run
 * after that, smallest first, within the reference's `DIFF_TIMEOUT_MS` all together. The producer's own deadline is
 * longer than all of it, so it is not what ends a collection whose files keep to their shares.
 *
 * The path and the changed lines come from the disk, so they travel only in `data`; the harness text names neither.
 */

const KIND = "file-change"
/** Unchanged lines shown around each change. */
const CONTEXT_LINES = 8
/** The longest snippet, in characters; a longer one is cut at a line break and says how many lines it left out. */
const MAX_SNIPPET = 8_192
/** How long new checks and reads of the files may start, and those of the rebuild; a file not started by then waits. */
const FILE_BUDGET_MS = 750
/** How many files are checked at once. */
const CONCURRENCY = 8
/** How long the comparisons of one step may take together: the reference's limit for one comparison. */
const DIFF_TIMEOUT_MS = 5_000

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
  /**
   * The budget, in milliseconds, within which the files' checks and reads start, and the rebuild's (`FILE_BUDGET_MS`
   * when not given); one file's share is half of it, and the producer's deadline follows it. Production gives none. A test that
   * counts which of many files are read gives more, so a loaded machine does not leave some out, and one that starves
   * the files gives less.
   */
  readonly budget?: number
}

export const durable = (services: Services): Durable => ({
  name: KIND,
  // The rebuild and the checks, each its budget and one last share past it, then the comparisons' time, with room to
  // spare.
  timeout: Duration.millis(3 * (services.budget ?? FILE_BUDGET_MS) + DIFF_TIMEOUT_MS + 500),
  run: (input) =>
    Effect.gen(function* () {
      // Claimed before the work, so a rebuild that runs past the producer's deadline costs one step, not every step. A
      // subagent is never rebuilt: as in the reference, a resumed or continued one starts with nothing watched.
      if (input.session.parentID === undefined && (yield* services.ledger.claim(input.session.id)))
        yield* rebuild(services, input)
      if (postedInRun(input.messages, KIND)) return []
      const budget = services.budget ?? FILE_BUDGET_MS
      // The rows keep the ledger's order, the least recently used first, whatever order the files are checked in.
      const rank = new Map((yield* services.ledger.watched(input.session.id)).map((file, index) => [file.path, index]))
      const deadline = Date.now() + budget
      const checked = yield* Effect.forEach(
        yield* services.ledger.toCheck(input.session.id),
        (file) =>
          inTime(
            input,
            deadline,
            budget / 2,
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
          ).pipe(
            Effect.map((found) => ({
              path: file.path,
              found: found?.map((item) => ({ ...item, index: rank.get(file.path) ?? 0 })),
            })),
          ),
        { concurrency: CONCURRENCY },
      )
      // Each file whose check started had its turn in this scan, whatever it found: the check finished or used its whole
      // share. That marks nothing as seen: a change counts as seen only through its entry's commit.
      yield* services.ledger.checked(
        input.session.id,
        checked.flatMap((result) => (result.found === undefined ? [] : [result.path])),
      )
      // The smallest comparisons first, so one large rewrite cannot use up the others' time.
      const end = Date.now() + DIFF_TIMEOUT_MS
      return checked
        .flatMap((result) => result.found ?? [])
        .toSorted((left, right) => left.size - right.size)
        .map((item) => ({ index: item.index, entries: item.report(end) }))
        .toSorted((left, right) => left.index - right.index)
        .flatMap((item) => item.entries)
    }),
})

/**
 * What `effect` found for one file within its own `share` of the time, or nothing when it ran out of its share, so a
 * slow file costs only its share and the others go on. Undefined when `deadline` had passed before it started. A check
 * that started before `deadline` keeps its whole share past it, so no file counts as checked whose check the step's
 * budget cut short.
 */
const inTime = <A>(
  input: Input,
  deadline: number,
  share: number,
  effect: Effect.Effect<ReadonlyArray<A>>,
): Effect.Effect<ReadonlyArray<A> | undefined> =>
  Effect.suspend(() => {
    if (deadline <= Date.now()) return Effect.succeed(undefined)
    return effect.pipe(
      Effect.timeoutOption(share),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.logWarning("A watched file took too long to check, so it was skipped this time").pipe(
              Effect.annotateLogs({ sessionID: input.session.id }),
              Effect.as([]),
            ),
      ),
    )
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
  /** The place the session's write recorded, or how to find it for the target once `file` is resolved. */
  place?: string | ((target: FileAccess.Target) => string | undefined),
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
    const recorded = typeof place === "function" ? place(target) : place
    if (recorded === undefined || !(FSUtil.contains(recorded, now) && FSUtil.contains(now, recorded))) return undefined
  }
  const base = { sessionID, agent }
  const external = services.access.externalRequest([target], base)
  const requests = [readRequest(target, base), ...(external === undefined ? [] : [external])]
  const denied = yield* Effect.forEach(requests, (request) =>
    services.permission.denied(request).pipe(Effect.orElseSucceed(() => true)),
  )
  return denied.some(Boolean) ? undefined : target
})

/** The request a whole read of `target` makes, so a check without a read asks exactly what the read tool would. */
export const readRequest = (
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

/** A file whose check is done: `report` gives its entries, comparing within the time left until `end`. */
interface Checked {
  /** How much text the comparison holds; none for a file that needs no comparison. */
  readonly size: number
  readonly report: (end: number) => ReadonlyArray<Entry>
}

const changed = Effect.fnUntraced(function* (
  services: Services,
  input: Input,
  file: FileLedger.Watched,
): Effect.fn.Return<ReadonlyArray<Checked>> {
  const sessionID = input.session.id
  const target = yield* gate(services, sessionID, input.agent.id, file.path, file.seen.place)
  if (target === undefined) return []
  // A read of no bytes follows links, as the time a read records does. A file that cannot be opened is not newer.
  const time = yield* services.environment.files.read(target.absolute, { offset: 0, length: 0 }).pipe(
    Effect.map((opened) => opened.info.mtimeMs),
    Effect.catchTag("Environment.NotFound", () => Effect.succeed(undefined)),
    Effect.orElseSucceed(() => Number.NEGATIVE_INFINITY),
  )
  // Nothing here changes the ledger: each change goes in the entry's commit, which runs only once the rows are posted
  // (class 7). A collection cut short by its deadline or an interruption leaves every watch and every stale refusal.
  if (time === undefined)
    return [settled({ kind: KIND, text: "", commit: services.ledger.settle(sessionID, file.path, file.seen) })]
  if (time <= file.seen.mtimeMs) return []
  const read = yield* services.reader.read(target.absolute, target.resource).pipe(Effect.orElseSucceed(() => undefined))
  // Only a whole text file is compared. Anything else, a read that failed included, keeps the entry as it was, so it is
  // tried again at the next step (a file deleted since the time was read is forgotten then).
  if (read?.seen === undefined || read.content.type !== "file" || read.content.encoding !== "utf8") return []
  const commit = services.ledger.settle(sessionID, file.path, file.seen, read.seen)
  const old = shown(file.seen.text)
  const now = shown(read.content.content)
  // A notebook, or a file that shows the same, is not reported but counts as seen, as in the reference.
  if (Notebook.isNotebook(target.absolute) || old === now) return [settled({ kind: KIND, text: "", commit })]
  return [
    {
      size: old.length + now.length,
      report: (end) => {
        const content = snippet(old, now, end)
        // A comparison that ran out of time reports nothing and settles nothing, so the file is tried again at the next
        // step.
        return content === undefined
          ? []
          : [{ kind: KIND, text: TEXT, data: { label: `Changed lines of ${file.path}`, content }, commit }]
      },
    },
  ]
})

const settled = (entry: Entry): Checked => ({ size: 0, report: () => [entry] })

/**
 * The changed lines of `now`, compared with `old`, both in the form the read tool shows text (`shown`): each hunk's
 * kept and added lines, numbered from where the hunk starts in the old text, as the reference numbers them, and hunks
 * joined by a line that holds only an ellipsis. Undefined when the comparison ran out of time or `end` has passed.
 */
const snippet = (old: string, now: string, end: number) => {
  const left = end - Date.now()
  if (left <= 0) return undefined
  const patch = structuredPatch(
    "",
    "",
    old === "" ? "" : `${old}\n`,
    now === "" ? "" : `${now}\n`,
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: left,
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
 * (after the latest checkpoint), as the reference rebuilds its cache from the transcript on resume. Only the main
 * conversation is rebuilt, as in the reference. These calls count, later ones winning: a whole read that was not a
 * repeat or truncated (the text it showed, stamped with its time), a write whatever its outcome (the text it was given,
 * stamped with its time), and an edit that did not fail (the file as it is now). A completed patch counts as an edit of
 * each file it adds, updates or moves a file to, since it stands in for Edit and Write for some models, and it ends
 * what history held for a file it deletes or moves away. A completed notebook edit ends what history held for its
 * file, which is not seeded. A path in history may come from an imported session, so it is resolved as the read tool resolves
 * it, a share or device spelling is refused before any disk is read, and only a file inside the project that passes
 * `gate` and that the read tool would read without a question is kept. Of those, only the newest
 * `FileLedger.MAX_FILES` files are kept and read, as the ledger would drop the rest. A record that is already there
 * wins over one from history.
 *
 * The names start resolving within the first half of `FILE_BUDGET_MS` and the files start being read within the rest,
 * each file within half of it, the newest first in both, so a slow file costs only its share and a rebuild that runs out
 * of time leaves out the oldest files, as the ledger would drop them first. The session is claimed before the rebuild starts, so one
 * that runs past the producer's deadline is not tried again in this process.
 */
const rebuild = Effect.fnUntraced(function* (services: Services, input: Input) {
  const budget = services.budget ?? FILE_BUDGET_MS
  const start = Date.now()
  // The newest call for each spelling; then the newest for each file, whatever spelling named it.
  const bySpelling = new Map(fromHistory(input.messages).map((found) => [found.path, found] as const))
  const resolved = yield* Effect.forEach(
    Array.from(bySpelling.values()).toSorted((left, right) => right.order - left.order),
    (found) => inTime(input, start + budget / 2, budget / 2, located(services, input, found)),
    { concurrency: CONCURRENCY },
  )
  const byFile = new Map(
    resolved
      .flatMap((found) => found ?? [])
      .toSorted((left, right) => left.order - right.order)
      .map((found) => [found.target.absolute, found] as const),
  )
  // The ledger keeps only the newest files, so an older one is not read at all.
  const files = yield* Effect.forEach(
    Array.from(byFile.values())
      .filter((found) => !found.ended)
      .toSorted((left, right) => right.order - left.order)
      .slice(0, FileLedger.MAX_FILES),
    (found) => inTime(input, start + budget, budget / 2, seeded(services, found)),
    { concurrency: CONCURRENCY },
  )
  // Seeded oldest first, so the newest file is the ledger's most recently used.
  yield* services.ledger.seed(
    input.session.id,
    files.flatMap((found) => found ?? []).toSorted((left, right) => left.order - right.order),
  )
})

// The target a call in history names, when it may be seeded.
const located = Effect.fnUntraced(function* (services: Services, input: Input, found: Found) {
  // Given no recorded place, `gate` refuses every target outside the project, so only project files remain.
  const target = yield* gate(services, input.session.id, input.agent.id, found.path)
  if (target === undefined) return []
  // The session may never have read this file: the call can have failed, and the store can be imported. So a file
  // that the read tool would ask about first (the built-in `.env` ask, a rule the person wrote, a link onto such a
  // file) is not seeded, and nothing of it is read (class 5).
  const quiet = yield* services.permission
    .allowed(readRequest(target, { sessionID: input.session.id, agent: input.agent.id }))
    .pipe(Effect.orElseSucceed(() => false))
  return quiet ? [{ ...found, target }] : []
})

// What the ledger is seeded with for a located call.
const seeded = Effect.fnUntraced(function* (services: Services, found: Found & { readonly target: FileAccess.Target }) {
  if (found.text !== undefined)
    return [{ path: found.target.absolute, order: found.order, seen: { mtimeMs: found.at, text: found.text } }]
  // An edit's result holds no text of the file, so the file is read as it is now.
  const read = yield* services.reader
    .read(found.target.absolute, found.target.resource)
    .pipe(Effect.orElseSucceed(() => undefined))
  if (read?.seen === undefined || read.content.type !== "file" || read.content.encoding !== "utf8") return []
  return [{ path: found.target.absolute, order: found.order, seen: { ...read.seen, text: read.content.content } }]
})

interface Found {
  readonly path: string
  readonly order: number
  readonly at: number
  /** Undefined for an edit, whose file is read from disk. */
  readonly text?: string
  /** True for a call that ends what history held for the file: nothing of it is seeded. */
  readonly ended?: boolean
}

const fromHistory = (messages: ReadonlyArray<SessionMessage.Info>): Found[] =>
  messages
    .flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool" ? found(part, message.time.created) : []))
        : [],
    )
    .map((item, order) => ({ ...item, order }))

const found = (
  part: Extract<SessionMessage.Info, { type: "assistant" }>["content"][number] & { type: "tool" },
  created: DateTime.Utc,
): ReadonlyArray<Omit<Found, "order">> => {
  if (part.state.status !== "completed" && part.state.status !== "error") return []
  const name = ToolNames.canonical(part.name)
  const given = ToolNames.lowerInput(name, part.state.input)
  const at = DateTime.toEpochMillis(part.time.completed ?? created)
  if (name === ToolNames.tools.write)
    return typeof given.file_path === "string" && typeof given.content === "string"
      ? [{ path: given.file_path, at, text: given.content }]
      : []
  if (part.state.status !== "completed") return []
  if (name === ToolNames.tools.patch) return typeof given.patchText === "string" ? patched(given.patchText, at) : []
  if (name === ToolNames.tools.notebook_edit)
    return typeof given.notebook_path === "string" ? [{ path: given.notebook_path, at, ended: true }] : []
  if (typeof given.file_path !== "string") return []
  if (name === ToolNames.tools.edit) return [{ path: given.file_path, at }]
  if (name !== ToolNames.tools.read) return []
  if (given.offset !== undefined || given.limit !== undefined || given.pages !== undefined) return []
  if (part.state.metadata?.unchanged === true || part.state.metadata?.truncated === true) return []
  const text = shownText(part.state.content)
  return text === undefined ? [] : [{ path: given.file_path, at, text }]
}

// The files a completed patch names, read with the Patch tool's own parser: each file it leaves is read from disk, as
// an edit's is, and a file it deletes or moves away ends what history held for it.
const patched = (patchText: string, at: number): ReadonlyArray<Omit<Found, "order">> => {
  const parsed = Patch.parse(patchText)
  if (Result.isFailure(parsed)) return []
  return parsed.success.flatMap((hunk) => {
    if (hunk.type === "delete") return [{ path: hunk.path, at, ended: true }]
    if (hunk.type === "update" && hunk.movePath !== undefined)
      return [
        { path: hunk.path, at, ended: true },
        { path: hunk.movePath, at },
      ]
    return [{ path: hunk.path, at }]
  })
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
