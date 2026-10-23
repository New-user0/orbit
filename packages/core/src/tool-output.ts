export * as ToolOutput from "./tool-output.js"

import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import type { Tool } from "./tool.js"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import type { ConfigToolOutput } from "@orbit/schema/config/tool-output"
import { NonNegativeInt } from "@orbit/schema/schema"
import { makeGlobalNode, makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { plain } from "@orbit/util/plain"
import { FileRetention } from "./file-retention.js"
import { SessionFolder } from "./session/folder.js"

/** The shell's own capture limits (`Shell.result`). A saved result is decided by characters, not by these. */
export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
/** The ceiling on every finite result limit when the person sets neither `max_result_chars` nor `max_bytes`. */
export const MAX_RESULT_CHARS = 50_000
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"
/** The version of the wrapper a `persisted` marker asks for. */
export const FORMAT = 1
const PREVIEW_CHARS = 2_000
const ERROR_CHARS = 10_000

const MESSAGE = /^msg_[A-Za-z0-9]{1,64}$/
const NAME = /^msg_[A-Za-z0-9]{1,64}-[A-Za-z0-9_-]{0,64}-[0-9a-f]{8}\.(txt|json)$/

/**
 * What the step records on a saved result: the session whose folder holds the file, the file's one-segment name, the
 * length of the saved text and the wrapper's version. No path is stored: lowering works it out from the tool-output
 * folder, so a marker that an imported or forked history carries names a file only once it decodes (class 5).
 */
export const Persisted = Schema.Struct({
  session: Schema.String.check(Schema.isPattern(SessionFolder.KEY)),
  name: Schema.String.check(Schema.isPattern(NAME)),
  size: NonNegativeInt,
  format: Schema.Literal(FORMAT),
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
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ToolOutput") {}

// The flat `tool_*` files of earlier versions; the session folders have no sweep of their own.
const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    const global = yield* Global.Service
    const root = path.join(global.data, DIRECTORY)

    // The session and call IDs come from a client, an import or the model, so each is checked or reduced to one plain
    // segment before it is joined (class 5). Nothing is followed: a link at `tool-output` or at the session's folder is
    // refused, and the file is created only when no file is there, so a replay keeps the first one (class 4).
    const save = Effect.fnUntraced(function* (input: {
      readonly sessionID: string
      readonly messageID: string
      readonly callID: string
      readonly saved: { readonly text: string; readonly extension: string }
    }) {
      if (!SessionFolder.KEY.test(input.sessionID) || !MESSAGE.test(input.messageID))
        return yield* Effect.logWarning("tool result not saved: its session or message ID cannot name a file", {
          sessionID: plain(input.sessionID).slice(0, 100),
          messageID: plain(input.messageID).slice(0, 100),
        }).pipe(Effect.as(undefined))
      const folder = path.join(root, input.sessionID)
      const name = `${input.messageID}-${input.callID.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${createHash("sha256").update(input.callID, "utf8").digest("hex").slice(0, 8)}.${input.saved.extension}`
      return yield* Effect.tryPromise(async () => {
        await fs.mkdir(root, { recursive: true })
        if (!(await fs.lstat(root)).isDirectory()) throw new Error("the tool-output folder is a link")
        await fs.mkdir(folder, { recursive: true, mode: 0o700 })
        if (!(await fs.lstat(folder)).isDirectory()) throw new Error("the session's folder is a link")
        await fs.writeFile(path.join(folder, name), input.saved.text, { flag: "wx" }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        })
        return { session: input.sessionID, name, size: input.saved.text.length, format: FORMAT } satisfies Persisted
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("tool result not saved; it is sent whole", { folder, error }).pipe(Effect.as(undefined)),
        ),
      )
    })

    const settle: Interface["settle"] = Effect.fnUntraced(function* (input) {
      const { persisted: _, ...metadata } = input.result.metadata ?? {}
      const result = { ...input.result, ...(input.result.metadata === undefined ? {} : { metadata }) }
      if (result.content.every((part) => part.type === "text" && part.text.trim() === ""))
        return { ...result, content: [{ type: "text" as const, text: `(${input.tool} finished and returned no output)` }] }
      const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      // An image, a PDF or any other file part goes whole, however large the text beside it.
      if (texts.length !== result.content.length) return result
      if (texts.reduce((sum, text) => sum + text.length, 0) <= input.limit) return result
      const persisted = yield* save({ ...input, saved: savedText(texts) })
      if (persisted === undefined) return result
      return { ...result, metadata: { ...metadata, persisted } }
    })

    return Service.of({ root, settle, cleanup: () => cleanup(files, root) })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
