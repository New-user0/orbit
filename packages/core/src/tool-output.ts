export * as ToolOutput from "./tool-output.js"

import { createHash } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import type { Tool } from "./tool.js"
import { Context, Effect, Layer, Schema } from "effect"
import type { ConfigToolOutput } from "@orbit/schema/config/tool-output"
import { NonNegativeInt, PositiveInt } from "@orbit/schema/schema"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Global } from "@orbit/util/global"
import { plain } from "@orbit/util/plain"
import { SessionFolder } from "./session/folder.js"
import { SessionMessage } from "./session/message.js"

/** The ceiling on every finite result limit when the person sets neither `max_result_chars` nor `max_bytes`. */
export const MAX_RESULT_CHARS = 50_000
/** The most characters of tool results one step sends together when `max_message_chars` is not set. */
export const MAX_MESSAGE_CHARS = 200_000
export const DIRECTORY = "tool-output"
/** The version of the wrapper a `persisted` marker asks for. */
export const FORMAT = 1
const PREVIEW_CHARS = 2_000
const ERROR_CHARS = 10_000
/** The most of an adopted file that its saved copy keeps. */
export const ADOPTED_BYTES = 64 * 1024 * 1024
const OFFERS = 256

const MESSAGE = /^msg_[A-Za-z0-9]{1,64}$/

/**
 * What the message budget records on a result it saved: the same session, name and format a `persisted` marker holds,
 * without the size, which lowering takes from the stored content.
 */
export const Override = SessionMessage.ToolOverride
export type Override = typeof Override.Type

/**
 * What the step records on a saved result: the session whose folder holds the file, the file's one-segment name, the
 * size of what was saved (the length of the saved text, or the bytes of an adopted file before any cut) and the
 * wrapper's version. `parts`, when set, says the file stands for the first `parts` text parts only, and the rest follow
 * the wrapper. No path is stored: lowering works it out from the tool-output folder, so a marker that an imported or
 * forked history carries names a file only once it decodes (class 5).
 */
export const Persisted = Schema.Struct({
  session: Override.fields.session,
  name: Override.fields.name,
  size: NonNegativeInt,
  format: Override.fields.format,
  parts: Schema.optionalKey(PositiveInt),
})
export type Persisted = typeof Persisted.Type

type Result = Tool.NormalizedResult

/**
 * The size above which a result is saved: never for a tool that declares `Infinity` (no setting turns that back on),
 * else the smaller of the tool's declared limit and the ceiling. The ceiling is `max_result_chars`, then `max_bytes`,
 * then 50,000 characters.
 */
export const threshold = (declared: number | undefined, configured: ConfigToolOutput.Info | undefined) =>
  declared === Infinity
    ? Infinity
    : Math.min(declared ?? Infinity, configured?.max_result_chars ?? configured?.max_bytes ?? MAX_RESULT_CHARS)

/** The text a file holds for these text parts: one part as it is, several as their pretty JSON. */
export const savedText = (texts: ReadonlyArray<string>) =>
  texts.length === 1
    ? { text: texts[0]!, extension: "txt" }
    : { text: JSON.stringify(texts.map((text) => ({ type: "text", text })), null, 2), extension: "json" }

/** A failure longer than 10,000 characters keeps its first and last 5,000, with the count of what was cut between. */
export const cutError = (message: string) =>
  message.length <= ERROR_CHARS
    ? message
    : `${message.slice(0, ERROR_CHARS / 2)}\n\n[${message.length - ERROR_CHARS} characters cut from the middle]\n\n${message.slice(-ERROR_CHARS / 2)}`

/**
 * The model's view of a saved result. `preview` is the saved text's head as `preview` cut it, already escaped by the
 * caller like any tool text.
 */
export const wrapper = (input: { file: string; size: number; preview: string; more: boolean }) =>
  [
    "<saved-output>",
    `Output too large to include (${formatSize(input.size)}). The full output is saved at: ${input.file}`,
    "",
    "Preview of the first 2,000 characters:",
    input.preview,
    ...(input.more ? ["..."] : []),
    "</saved-output>",
  ].join("\n")

/**
 * The `<` of a look-alike of the wrapper's tag, opening or closing, in any letter case and with whitespace inside the
 * brackets. Lowering escapes it in tool text, so only a stored marker can open a wrapper (class 9).
 */
export const TAG = /<(?=\s*\/?\s*saved\s*-\s*output)/gi

/** The first 2,000 characters, cut back to the last line break in them when that break lies past the first 1,000. */
export const preview = (text: string) => {
  if (text.length <= PREVIEW_CHARS) return { text, more: false }
  const head = text.slice(0, PREVIEW_CHARS)
  const newline = head.lastIndexOf("\n")
  return { text: newline > PREVIEW_CHARS / 2 ? head.slice(0, newline) : head, more: true }
}

/**
 * `preview(savedText(texts).text)` without building the whole saved text. Its first 2,001 characters come from at most
 * the first 2,001 characters of the first 2,001 parts, because every part adds at least one character of its own; a
 * surrogate pair split at a part's 2,001st character is escaped only past that head, so the head does not change.
 */
export const savedPreview = (texts: ReadonlyArray<string>) =>
  preview(
    savedText(texts.slice(0, PREVIEW_CHARS + 1).map((text) => text.slice(0, PREVIEW_CHARS + 1))).text.slice(
      0,
      PREVIEW_CHARS + 1,
    ),
  )

const formatSize = (size: number) => {
  if (size < 1024) return `${size} bytes`
  const kb = size / 1024
  const shown = kb < 1024 ? { value: kb, unit: "KB" } : { value: kb / 1024, unit: "MB" }
  return `${shown.value.toFixed(1).replace(/\.0$/, "")}${shown.unit}`
}

export interface Interface {
  /** `<data>/tool-output`, the folder that holds a folder of saved results for each session. */
  readonly root: string
  /**
   * The result as it is stored: a `persisted` marker that the tool or a hook supplied is dropped, an empty result
   * becomes the empty marker, and a text-only result above `limit` characters is saved to the session's folder and
   * marked. Its content stays the tool's own. It never fails: a result that cannot be saved is sent whole.
   */
  readonly settle: (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly callID: string
    /** The name the model called, for the empty marker. */
    readonly tool: string
    readonly limit: number
    readonly result: Result
  }) => Effect.Effect<Result>
  /**
   * Saves these text parts to the session's folder for the message budget, as `settle` saves a result above its limit,
   * and answers where, or `undefined` when the file cannot be saved (the result is then sent whole).
   */
  readonly persist: (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly callID: string
    readonly texts: ReadonlyArray<string>
  }) => Effect.Effect<Override | undefined>
  /**
   * Offers `file`, which holds the whole output behind the first text part of this call's result, as the saved copy of
   * that result. Settling the same call links the file into the session's folder, or copies it, cut to 64 MB, and marks
   * the result with `parts: 1` and the file's size before the cut. An offer that cannot be saved leaves the result whole.
   */
  readonly adopt: (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly callID: string
    readonly file: string
  }) => Effect.Effect<void>
}

/**
 * Opens a file without following a link (class 4). Where the platform has no `O_NOFOLLOW` (Windows), anything but a
 * regular file at the path is refused before it is opened.
 */
export const openFile = async (file: string, flags: number) => {
  if (constants.O_NOFOLLOW === undefined && !(await fs.lstat(file)).isFile())
    throw Object.assign(new Error(`${file} is not a regular file`), { code: "ELOOP" })
  return fs.open(file, flags | (constants.O_NOFOLLOW ?? 0))
}

// The saved copy of an adopted file: a hard link to it, or a copy where a link cannot be made (another volume), made only
// where nothing is: a link onto an existing name fails, and so does the copy that follows it, which keeps the first file.
// The file is cut to 64 MB first, through the handle that was opened without following a link, and the size it had is
// returned.
const copyAdopted = async (file: string, target: string) => {
  const handle = await openFile(file, constants.O_RDWR)
  const size = await handle
    .stat()
    .then(async (stat) => {
      if (stat.size > ADOPTED_BYTES) await handle.truncate(ADOPTED_BYTES)
      return stat.size
    })
    .finally(() => handle.close())
  await fs.link(file, target).catch(() =>
    fs.copyFile(file, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    }),
  )
  return size
}

// The saved file for these text parts, created only where nothing is, so a replay keeps the first one; the size recorded
// is the length of the saved text.
const writeSaved = (texts: ReadonlyArray<string>) => {
  const saved = savedText(texts)
  return {
    extension: saved.extension,
    write: (target: string) =>
      fs
        .writeFile(target, saved.text, { flag: "wx" })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        })
        .then(() => saved.text.length),
  }
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ToolOutput") {}

/**
 * Removes the flat `tool_*` files of earlier versions in `directory` whose last change is before `cutoff`; session
 * retention calls it with its period. Nothing is followed: a `directory` that is a link is left alone, and only plain
 * files go (class 4). A file that cannot be removed stays for the next pass.
 */
export const cleanup = (directory: string, cutoff: number) =>
  Effect.tryPromise(async () => {
    const info = await fs.lstat(directory).catch(() => undefined)
    if (!info?.isDirectory()) return
    await Promise.all(
      (await fs.readdir(directory))
        .filter((name) => /^tool_[0-9a-f]{12}/.test(name))
        .map(async (name) => {
          const file = path.join(directory, name)
          const found = await fs.lstat(file)
          if (found.isFile() && found.mtimeMs < cutoff) await fs.unlink(file)
        })
        .map((removal) => removal.catch(() => undefined)),
    )
  }).pipe(Effect.catch((error) => Effect.logWarning("flat tool results not cleaned", { directory, error })))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const root = path.join(global.data, DIRECTORY)

    // The session and call IDs come from a client, an import or the model, so each is checked or reduced to one plain
    // segment before it is joined (class 5). Nothing is followed: a link at `tool-output` or at the session's folder is
    // refused, and `write` creates the file only when no file is there, so a replay keeps the first one (class 4).
    const save = Effect.fnUntraced(function* (input: {
      readonly sessionID: string
      readonly messageID: string
      readonly callID: string
      readonly extension: string
      /** Creates the file at `target` unless one is there, and returns the size to record. */
      readonly write: (target: string) => Promise<number>
    }) {
      if (!SessionFolder.KEY.test(input.sessionID) || !MESSAGE.test(input.messageID))
        return yield* Effect.logWarning("tool result not saved: its session or message ID cannot name a file", {
          sessionID: plain(input.sessionID).slice(0, 100),
          messageID: plain(input.messageID).slice(0, 100),
        }).pipe(Effect.as(undefined))
      const folder = path.join(root, input.sessionID)
      const name = `${input.messageID}-${input.callID.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${createHash("sha256").update(input.callID, "utf8").digest("hex").slice(0, 8)}.${input.extension}`
      return yield* Effect.tryPromise(async () => {
        await fs.mkdir(root, { recursive: true })
        if (!(await fs.lstat(root)).isDirectory()) throw new Error("the tool-output folder is a link")
        await fs.mkdir(folder, { recursive: true, mode: 0o700 })
        if (!(await fs.lstat(folder)).isDirectory()) throw new Error("the session's folder is a link")
        const size = await input.write(path.join(folder, name))
        return { session: input.sessionID, name, size, format: FORMAT } satisfies Persisted
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("tool result not saved; it is sent whole", { folder, error }).pipe(Effect.as(undefined)),
        ),
      )
    })

    // Files offered by `adopt`, by call, until the step settles that call. Bounded, so an offer that is never settled
    // costs at most its place here.
    const offers = new Map<string, string>()
    const key = (input: { readonly sessionID: string; readonly messageID: string; readonly callID: string }) =>
      JSON.stringify([input.sessionID, input.messageID, input.callID])

    const adopt: Interface["adopt"] = (input) =>
      Effect.sync(() => {
        offers.set(key(input), input.file)
        if (offers.size > OFFERS) offers.delete(offers.keys().next().value!)
      })

    const settle: Interface["settle"] = Effect.fnUntraced(function* (input) {
      const offered = offers.get(key(input))
      offers.delete(key(input))
      const { persisted: _, ...metadata } = input.result.metadata ?? {}
      const result = { ...input.result, ...(input.result.metadata === undefined ? {} : { metadata }) }
      const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      // The offered file holds the whole output behind the first part; the parts after it follow the wrapper. It is
      // saved before the empty check, so output whose head is blank still reaches the model as the wrapper and its path.
      const adopted =
        offered === undefined || texts.length !== result.content.length
          ? undefined
          : yield* save({ ...input, extension: "txt", write: (target) => copyAdopted(offered, target) })
      if (adopted !== undefined) return { ...result, metadata: { ...metadata, persisted: { ...adopted, parts: 1 } } }
      if (result.content.every((part) => part.type === "text" && part.text.trim() === ""))
        return { ...result, content: [{ type: "text" as const, text: `(${input.tool} finished and returned no output)` }] }
      // An image, a PDF or any other file part goes whole, however large the text beside it.
      if (texts.length !== result.content.length) return result
      if (texts.reduce((sum, text) => sum + text.length, 0) <= input.limit) return result
      const persisted = yield* save({ ...input, ...writeSaved(texts) })
      if (persisted === undefined) return result
      return { ...result, metadata: { ...metadata, persisted } }
    })

    const persist: Interface["persist"] = (input) =>
      save({ ...input, ...writeSaved(input.texts) }).pipe(
        Effect.map((saved) => saved && { session: saved.session, name: saved.name, format: saved.format }),
      )

    return Service.of({ root, settle, persist, adopt })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node],
})
