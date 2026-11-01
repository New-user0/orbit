// The review of an Edit or Write approval in the editor, the changes of one prompt, and the restore question. It has no
// `vscode` import, so it runs the same in tests: `Host` is what the extension does in the editor, and `Disk` is every
// access to the disk, so a test can record it over the real one.
//
// A file is read only when its real path is inside one of the folders the server names for the session and inside one
// of the window's folders (classes 3 and 4). A share or device spelling is refused before the disk is touched, and a link
// that leads to a share is found by reading links part by part, which opens nothing (class 6). The real path that was
// checked is the one read, and the editor is shown that text and never the file's own URI, so nothing reads the path
// again under another spelling. Nothing here writes a file: every answer goes to the server (class 12).
import type { SessionRewindFiles } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { parsePatch } from "diff"
import fs from "node:fs/promises"
import path from "node:path"
import { proposed } from "./patch.js"
import type { FileChange, Item } from "./protocol.js"

export type Disk = {
  realpath(file: string): Promise<string>
  lstat(file: string): Promise<unknown>
  readFile(file: string): Promise<Uint8Array>
}

export const disk: Disk = {
  realpath: (file) => fs.realpath(file),
  lstat: (file) => fs.lstat(file),
  readFile: (file) => fs.readFile(file),
}

/** The folders the session's file tools work in, as the server names them, or why there are none. */
export type Folders = { readonly folders: ReadonlyArray<string> } | { readonly refused: "untrusted" | "unavailable" }

/** How a reply ended: taken, lost to another answer, or refused with the server's sentence. */
export type Outcome = "sent" | "gone" | { readonly refused: string }

export type Side = { readonly scheme: "orbit-proposed" | "orbit-review"; readonly path: string }

export type Tab = {
  readonly title: string
  /** `review` answers the question when saved, closed or rejected; `preview` answers nothing. */
  readonly mode: "review" | "preview"
  readonly left: Side
  readonly right: Side
}

export type Changes = {
  readonly title: string
  readonly entries: ReadonlyArray<{ readonly label: Side; readonly left: Side; readonly right: Side }>
}

/** What the review does in the editor and the chat. */
export interface Host {
  reply(id: string, decision: "once" | "reject", content?: string): Promise<Outcome>
  folders(sessionID: string): Promise<Folders>
  /** The window's folders on disk (`file:` only). */
  workspace(): ReadonlyArray<string>
  show(tab: Tab): PromiseLike<unknown>
  changes(view: Changes): PromiseLike<unknown>
  /** Closes the tabs with these titles. The review forgets them first, so their close events answer nothing. */
  close(titles: ReadonlyArray<string>): PromiseLike<unknown>
  note(text: string, tone: "muted" | "error"): void
  warn(text: string): void
}

type Permission = Extract<Item, { type: "permission" }>

/**
 * Said when a patch no longer applies to the file as it is now. It names no file: VS Code draws Markdown links in a
 * notification, and a file name is the repository's to choose (class 9).
 */
export const changedNotice =
  "Orbit: the file changed since the agent read it, so its diff cannot be shown in the editor. The approval card shows the proposed change."

type Entry = {
  readonly title: string
  readonly mode: "review" | "preview" | "changes"
  readonly request?: string
  readonly paths: ReadonlyArray<string>
  /** The right side of a review, which the person may edit and save. */
  readonly editable?: string
  /** The text VS Code last saved on its own, which Accept sends; a close still sends the proposal unchanged. */
  draft?: string
  answering: boolean
  /**
   * The extension is closing the tab: it answers nothing more, and its sides stay readable until VS Code reports it
   * closed. VS Code reads a side again after a save returns and before it closes a tab with unsaved edits, and a side
   * gone by then fails that save, so VS Code would ask the person whether to save.
   */
  closing?: boolean
}

export class Review {
  // Open tabs by title, and the text of every side they show by path.
  private readonly entries = new Map<string, Entry>()
  private readonly texts = new Map<string, string>()
  // Review sides whose next write is an auto save that VS Code announced.
  private readonly automatic = new Set<string>()
  private disposed = false

  constructor(
    private readonly host: Host,
    private readonly reader: Disk = disk,
  ) {}

  /** The writable side of a review (`orbit-review:`). Saving only hands the text to the review; no file is written. */
  readonly provider = {
    readFile: (file: string) => {
      const text = this.texts.get(file)
      return text === undefined ? undefined : new TextEncoder().encode(text)
    },
    writeFile: async (file: string, content: Uint8Array) => {
      const automatic = this.automatic.delete(file)
      const entry = this.editable(file)
      // A tab the review no longer knows was answered or closed by the extension: its save answers nothing.
      if (!entry) return
      // The text is what the person saw and saved; the server drops a byte order mark itself.
      const text = new TextDecoder().decode(content)
      // An auto save is not the person's answer: the tab keeps the text as its draft, and nothing is sent (class 8).
      if (automatic) {
        entry.draft = text
        this.texts.set(file, text)
        return
      }
      const outcome = await this.answer(entry, "once", text)
      if (typeof outcome === "object") throw new Error(outcome.refused)
    },
    /** Whether `file` is a folder above a side, so that VS Code never tries to make one before a save. */
    folder: (file: string) => file === "/" || [...this.texts.keys()].some((known) => known.startsWith(`${file}/`)),
  }

  /**
   * VS Code is about to save a review side: by the person (`manual`), or on its own after a delay or a change of focus.
   * Only a save by the person answers. A write VS Code did not announce answers too: a save that skips the save
   * participants, such as Save without Formatting, is the person's.
   */
  willSave(file: string, manual: boolean) {
    if (manual) this.automatic.delete(file)
    else this.automatic.add(file)
  }

  /** The text of a read-only side (`orbit-proposed:`). */
  text(file: string) {
    return this.texts.get(file)
  }

  /**
   * Opens the diff of a question's files. On its own (`click` false) only a review opens, and nothing is said when it
   * cannot; from the card's "Open diff" a preview opens too, and a file that is not opened gets a note. Returns whether a
   * review opened.
   */
  async open(item: Permission, click: boolean) {
    if (this.disposed || item.files.length === 0) return false
    const mode = modeOf(item)
    if (!click && mode !== "review") return false
    const folders = await this.host.folders(item.sessionID)
    if ("refused" in folders) {
      if (click)
        this.host.note(
          folders.refused === "untrusted"
            ? "The diff is shown on the card only: the folder is not trusted, so nothing in it is read."
            : "The diff is shown on the card only: the Orbit service did not name the session's folder.",
          "muted",
        )
      return false
    }
    const opened = await Promise.all(item.files.map((file) => this.file(item, file, mode, folders.folders, click)))
    return opened.some((shown) => shown === "review")
  }

  /** The person closed a tab. A review that is still open answers with the proposal as it stands. */
  async closed(title: string) {
    const entry = this.entries.get(title)
    if (!entry) return
    this.forget(entry)
    // A tab the extension closed answers nothing; its sides were kept until now.
    if (entry.closing || entry.mode !== "review" || entry.answering) return
    await this.answer(entry, "once")
  }

  /** The Accept title action on a tab with no unsaved edits: the text it holds, which is the proposal unless auto saved. */
  async accept(file: string) {
    const entry = this.editable(file)
    if (entry) await this.answer(entry, "once", entry.draft)
  }

  /** The Reject title action. */
  async reject(file: string) {
    const entry = this.editable(file)
    if (entry) await this.answer(entry, "reject")
  }

  /** The question was answered elsewhere (the card, the terminal, another client): its tabs close and answer nothing. */
  settled(requestID: string) {
    this.close([...this.entries.values()].filter((entry) => entry.request === requestID && !entry.closing))
  }

  /** A new prompt: every Orbit tab closes, and none of those closes answers. */
  closeAll() {
    this.close([...this.entries.values()].filter((entry) => !entry.closing))
  }

  /** The window closes or the extension stops: no close or save from now on answers. */
  dispose() {
    this.disposed = true
    this.closeAll()
  }

  /** Opens one multi-file diff of a prompt's changes, rebuilt from the server's patches alone: no file is read. */
  async changes(files: ReadonlyArray<unknown>) {
    const key = nonce()
    // The key makes the title unique, so closing one view never forgets another's texts.
    const title = `Orbit: changes in this prompt (${files.length} ${files.length === 1 ? "file" : "files"}) (${key})`
    const entries = changesView(files).map((entry, index) => {
      const at = `/${key}/${index}`
      const name = sideName(entry.label)
      this.texts.set(`${at}/before/${name}`, "before" in entry ? entry.before : "")
      this.texts.set(`${at}/after/${name}`, "before" in entry ? entry.after : entry.text)
      return {
        label: side("orbit-proposed", `${at}/${entry.label}`),
        left: side("orbit-proposed", `${at}/before/${name}`),
        right: side("orbit-proposed", `${at}/after/${name}`),
      }
    })
    this.entries.set(title, {
      title,
      mode: "changes",
      paths: entries.flatMap((entry) => [entry.left.path, entry.right.path]),
      answering: false,
    })
    await this.host.changes({ title, entries })
  }

  private async file(item: Permission, change: FileChange, mode: "review" | "preview", folders: ReadonlyArray<string>, click: boolean) {
    const where = { session: folders, window: this.host.workspace() }
    const place = await contained(change.place, where, this.reader)
    // A move is read from where it came from, which is checked the same way.
    const from = change.from === undefined ? place : await contained(change.from, where, this.reader)
    if (place === undefined || from === undefined) {
      if (click)
        this.host.note(
          `The diff of ${plain(change.place ?? change.file)} is shown on the card only: the file is not inside the session's folder in this window.`,
          "muted",
        )
      return undefined
    }
    const before =
      change.status === "added"
        ? ""
        : await this.reader.readFile(from).then(
            (bytes) => new TextDecoder().decode(bytes),
            () => undefined,
          )
    const after = before === undefined ? undefined : proposed(before, change.patch)
    if (before === undefined || after === undefined) {
      this.host.warn(changedNotice)
      this.host.note(changedNotice, "muted")
      return undefined
    }
    const title = tabTitle(change.place ?? change.file)
    const key = `/${item.id}/${title.slice(-7, -1)}`
    const name = sideName(place)
    const left = side("orbit-proposed", `${key}/before/${name}`)
    const right = side(mode === "review" ? "orbit-review" : "orbit-proposed", `${key}/${mode === "review" ? "" : "after/"}${name}`)
    this.texts.set(left.path, before)
    this.texts.set(right.path, after)
    this.entries.set(title, {
      title,
      mode,
      request: item.id,
      paths: [left.path, right.path],
      editable: mode === "review" ? right.path : undefined,
      answering: false,
    })
    await this.host.show({ title, mode, left, right })
    return mode
  }

  private editable(file: string) {
    return [...this.entries.values()].find((entry) => entry.editable === file && !entry.answering && !entry.closing)
  }

  // One answer per question: while it is on its way no other tab of the review answers, and once the server took it, or
  // another answer had, the question's tabs close. A refusal leaves the tab open and the question pending.
  private async answer(entry: Entry, decision: "once" | "reject", content?: string) {
    entry.answering = true
    const outcome = await this.host.reply(entry.request ?? "", decision, content)
    entry.answering = false
    if (typeof outcome === "object") return outcome
    this.settled(entry.request ?? "")
    return outcome
  }

  private close(entries: ReadonlyArray<Entry>) {
    if (entries.length === 0) return
    entries.forEach((entry) => {
      entry.closing = true
    })
    void this.host.close(entries.map((entry) => entry.title)).then(undefined, () => undefined)
  }

  private forget(entry: Entry) {
    this.entries.delete(entry.title)
    entry.paths.forEach((file) => this.texts.delete(file))
  }
}

// Only a pending Edit or Write of one file that the server marked revisable is reviewed; a notebook is not (its diff is
// JSON), and every other question with files is a preview. A server that does not send `revisable` gets previews only.
function modeOf(item: Permission) {
  const only = item.files.length === 1 ? item.files[0] : undefined
  if (!item.revisable || !only) return "preview"
  return /\.ipynb$/i.test(only.place ?? only.file) ? "preview" : "review"
}

/**
 * The real path of `file` when it is really inside one of the session's folders and one of the window's folders, and
 * `undefined` otherwise. The spelling is checked before the disk is touched; then links to a share; then the real path,
 * which for a file not there yet is the real path of its nearest folder plus the names below it.
 */
export async function contained(
  file: string | undefined,
  folders: { readonly session: ReadonlyArray<string>; readonly window: ReadonlyArray<string> },
  disk: Disk,
) {
  if (file === undefined || !spelled(file)) return undefined
  const real = await resolve(file, disk)
  if (real === undefined) return undefined
  const [session, window] = await Promise.all([roots(folders.session, disk), roots(folders.window, disk)])
  // Both real, so containment by path is containment on disk (class 4). The stricter answer wins (class 3).
  if (!session.some((root) => FSUtil.contains(root, real))) return undefined
  if (!window.some((root) => FSUtil.contains(root, real))) return undefined
  return real
}

// An absolute local path. On Windows it must be a drive path: a root-relative `\x` or a Git Bash `/c/x` is read from the
// current drive, and a share or device spelling would connect to a host before anything was checked.
function spelled(file: string) {
  if (LinkShare.isShare(file)) return false
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(file)
  return path.isAbsolute(file)
}

// Each folder is checked as a file is; one that fails is dropped alone.
async function roots(folders: ReadonlyArray<string>, disk: Disk) {
  const found = await Promise.all(folders.filter(spelled).map((folder) => resolve(folder, disk)))
  return found.filter((folder): folder is string => folder !== undefined)
}

async function resolve(file: string, disk: Disk) {
  // Reads the links on the way part by part and opens none of them.
  if (LinkShare.ofSync(file) !== undefined) return undefined
  return real(file, disk)
}

async function real(file: string, disk: Disk): Promise<string | undefined> {
  const found = await disk.realpath(file).then(
    (value) => ({ value }),
    (error: NodeJS.ErrnoException) => ({ code: error.code }),
  )
  if ("value" in found) return found.value
  if (found.code !== "ENOENT") return undefined
  // Something is there but leads nowhere: a dangling link. It is refused, never taken for a file still to be added.
  if (await disk.lstat(file).then(() => true, () => false)) return undefined
  const parent = path.dirname(file)
  if (parent === file) return undefined
  const above = await real(parent, disk)
  return above === undefined ? undefined : path.join(above, path.basename(file))
}

/**
 * Both texts of a file from a whole-file patch (the server's diff with no `context`), or `undefined` when the patch is
 * not one: a binary or empty one, more than one hunk, or a hunk that does not start at the top of the file.
 */
export function sides(patch: string) {
  const found = hunks(patch)
  const hunk = found?.length === 1 ? found[0] : undefined
  // jsdiff counts an empty side as starting at line 1 too.
  if (!hunk || hunk.oldStart !== 1 || hunk.newStart !== 1) return undefined
  const before: string[] = []
  const after: string[] = []
  const ends = { before: true, after: true }
  hunk.lines.forEach((line, index) => {
    const mark = line[0]
    if (mark === "\\") {
      // "No newline at end of file" belongs to the line above it, on the side or sides that line is on.
      const above = hunk.lines[index - 1]?.[0]
      if (above !== "+") ends.before = false
      if (above !== "-") ends.after = false
      return
    }
    if (mark !== "+") before.push(line.slice(1))
    if (mark !== "-") after.push(line.slice(1))
  })
  const join = (lines: string[], end: boolean) => (lines.length === 0 ? "" : lines.join("\n") + (end ? "\n" : ""))
  return { before: join(before, ends.before), after: join(after, ends.after) }
}

/**
 * The entries of a prompt's changes. Each label is the server's name for the file, written out (class 5). An entry whose
 * patch cannot be rebuilt into both sides shows its patch text, and one that is malformed says so: each costs only itself.
 */
export function changesView(files: ReadonlyArray<unknown>) {
  return files.map((file, index) => {
    const entry = typeof file === "object" && file !== null ? (file as Record<string, unknown>) : {}
    if (typeof entry.file !== "string" || typeof entry.patch !== "string")
      return { label: `file ${index + 1}`, text: "this entry could not be read" }
    const label = plain(entry.file)
    const both = sides(entry.patch)
    if (both) return { label, ...both }
    if (hunks(entry.patch)?.length === 0) return { label, text: "binary file, not shown" }
    return { label, text: entry.patch }
  })
}

// The hunks of a patch, read from its first hunk on: the header names the file, and a name the repository chose may hold
// a line break. `undefined` when a hunk cannot be read, because jsdiff throws on a line it does not know.
function hunks(patch: string) {
  const start = patch.search(/^@@ /m)
  try {
    return parsePatch(start === -1 ? patch : patch.slice(start)).flatMap((part) => part.hunks)
  } catch {
    return undefined
  }
}

/** The title of a review or preview tab: Orbit's label, the file's base name written out, and six random characters. */
export function tabTitle(file: string) {
  return `Orbit: ${plain(file.split(/[\\/]/).at(-1) ?? file)} (${nonce()})`
}

/**
 * The question before a restore, from the server's dry run: how many files, the line totals, and the files themselves,
 * each relative to the chat's folder when it is under it (display only), always written out.
 */
export function restoreQuestion(dry: SessionRewindFiles, directory: string) {
  const files = dry.filesChanged ?? []
  const count = `${files.length} ${files.length === 1 ? "file" : "files"}`
  return {
    message: `Restore ${count} to how they were before this prompt? +${dry.insertions ?? 0} / −${dry.deletions ?? 0} lines. This cannot be undone.`,
    detail: files
      .map((file) => {
        const relative = path.relative(directory, file)
        return plain(relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? file : relative)
      })
      .join("\n"),
  }
}

function side(scheme: Side["scheme"], file: string): Side {
  return { scheme, path: file }
}

// The last segment of a side's path. VS Code names a side by it when a save fails, in a notification that draws links,
// so it never holds the file's own name: only a fixed word and the file's extension when that is a plain one, which
// keeps the editor's language for the file (class 9).
function sideName(file: string) {
  const extension = path.extname(file)
  return /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? `proposal${extension}` : "proposal"
}

function nonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => alphabet[byte % alphabet.length]).join("")
}
