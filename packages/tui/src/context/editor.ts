import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import path from "node:path"
import { Option, Schema, SchemaGetter } from "effect"
import { IdeLock } from "@orbit/util/ide-lock"
import { plain } from "@orbit/util/plain"
import { isRecord } from "../util/record"
import { useTuiPaths } from "./runtime"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useLog } from "./log"
import { createCompat } from "./compat"
import { useData } from "./data"
import { discoverEditors, editorIntegration, editorPort, readLocks, type Editor } from "../editor"

const PositionSchema = Schema.Struct({
  line: Schema.Number,
  character: Schema.Number,
})

const EditorSelectionRangeSchema = Schema.Struct({
  text: Schema.String,
  selection: Schema.Struct({
    start: PositionSchema,
    end: PositionSchema,
  }),
})

const EditorSelectionRangesSchema = Schema.Struct({
  filePath: Schema.String,
  source: Schema.optional(Schema.Literals(["websocket", "zed"])),
  ranges: Schema.mutable(Schema.Array(EditorSelectionRangeSchema).check(Schema.isMinLength(1))),
})

const EditorSelectionSchema = Schema.Union([
  EditorSelectionRangesSchema,
  Schema.Struct({
    text: Schema.String,
    filePath: Schema.String,
    source: Schema.optional(Schema.Literals(["websocket", "zed"])),
    selection: Schema.Struct({
      start: PositionSchema,
      end: PositionSchema,
    }),
  }),
]).pipe(
  Schema.decodeTo(EditorSelectionRangesSchema, {
    decode: SchemaGetter.transform((value) =>
      "ranges" in value
        ? value
        : {
            filePath: value.filePath,
            source: value.source,
            ranges: [
              {
                text: value.text,
                selection: value.selection,
              },
            ],
          },
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

// The messages of Orbit's IDE bridge, version 1. Every frame is decoded on its own and what does not fit is dropped.
const BridgeHelloSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  version: Schema.Number,
  editor: Schema.optional(Schema.String),
  // What the bridge can do beyond version 1's messages. Read loosely: a list this terminal UI does not understand only
  // means fewer features, never a lost link.
  features: Schema.optional(Schema.Unknown),
})

// How the person answered a review in the editor, or why none opened. A save carries the text as saved.
const BridgeDiffAnswerSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("diff.answer"),
    id: Schema.String,
    answer: Schema.Literal("saved"),
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("diff.answer"),
    id: Schema.String,
    answer: Schema.Literals(["closed", "rejected", "dismissed", "unavailable"]),
    reason: Schema.optional(Schema.String),
  }),
])

const BridgeSelectionSchema = Schema.Struct({
  type: Schema.Literal("selection"),
  filePath: Schema.NullOr(Schema.String),
  text: Schema.optional(Schema.String),
  selection: Schema.optional(Schema.Struct({ start: PositionSchema, end: PositionSchema })),
})

const BridgeMentionSchema = Schema.Struct({
  type: Schema.Literal("mention"),
  filePath: Schema.String.check(Schema.isNonEmpty()),
  lineStart: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  lineEnd: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

const BridgeFrameSchema = Schema.Union([BridgeHelloSchema, BridgeSelectionSchema, BridgeMentionSchema])

const decodeEditorSelection = Schema.decodeUnknownOption(EditorSelectionSchema)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeFrame = Schema.decodeUnknownOption(BridgeFrameSchema)
const decodeDiffAnswer = Schema.decodeUnknownOption(BridgeDiffAnswerSchema)

export type EditorSelection = Schema.Schema.Type<typeof EditorSelectionSchema>
/** A review of an approval to open in the editor: every value is the permission request's own. */
export type EditorDiff = {
  id: string
  place: string
  patch: string
  status: "added" | "modified"
  /** The folders the session's file tools work in, as its server named them. */
  roots: string[]
}
/** How a review in the editor ended for the terminal UI: the editor's answer, or `lost` when the link went away. */
export type EditorDiffEvent = Schema.Schema.Type<typeof BridgeDiffAnswerSchema> | { answer: "lost" }
/** A file the person mentioned in the editor, with 1-based inclusive lines when a selection came with it. */
export type EditorMention = { filePath: string; lineStart?: number; lineEnd?: number }
export type EditorLabelState = "pending" | "sent" | "none"

export type EditorIntegration = Readonly<{
  /** The editor window to connect to, if there is exactly one that fits. */
  discover?(input: {
    directory: string
    lockDirectory: string
    env: Readonly<Record<string, string | undefined>>
    log: (line: string) => void
  }): Editor | undefined
  selection?(directory: string): Promise<unknown>
}>

/** When to look for a window, how long, and how long to wait between the attempts to get back after a drop. */
export type EditorTiming = {
  poll: number
  window: number
  delays: readonly number[]
  /** How long `connect` waits for the editor to say hello before it gives up. */
  connect: number
}

// The connect limit is just above the 30 s that a search for the window lasts.
const defaultTiming: EditorTiming = {
  poll: 1_000,
  window: 30_000,
  delays: [1_000, 2_000, 4_000, 8_000, 16_000],
  connect: 35_000,
}

export const {
  use: useEditorContext,
  provider: EditorContextProvider,
  context: EditorContext,
} = createSimpleContext({
  name: "EditorContext",
  init: (props: {
    integration?: EditorIntegration
    WebSocketImpl?: typeof WebSocket
    /** Whether other agent products' files may be read. Defaults to what the server reports. */
    compat?: () => boolean
    /** Connect to an editor window without the port variable or an editor terminal. The person's setting, or `/ide`. */
    autoConnect?: boolean
    timing?: Partial<EditorTiming>
  }) => {
    const paths = useTuiPaths()
    const log = useLog({ component: "editor" })
    const editor: EditorIntegration = props.integration ?? editorIntegration
    // The server may be on another machine, where this process's own directory does not exist: ask about the location
    // the app resolved there.
    const compat =
      props.compat ?? createCompat({ client: useClient(), directory: useData().location.default().directory })
    const timing = { ...defaultTiming, ...props.timing }
    const lockDirectory = path.join(paths.state, "ide")
    const zedTerminal = process.env.ZED_TERM === "true" || process.env.TERM_PROGRAM?.toLowerCase() === "zed"
    const mentionListeners = new Set<(mention: EditorMention) => void>()
    const WebSocketImpl = props.WebSocketImpl ?? WebSocket
    const [store, setStore] = createStore<{
      status: "disabled" | "connecting" | "connected"
      selection: EditorSelection | undefined
      selectionSent: boolean
      /** The display name of the editor, once it has said hello, and whether it reviews diffs. */
      server: { name?: string; port?: number; diff?: boolean } | undefined
    }>({
      status: "disabled",
      selection: undefined,
      selectionSent: false,
      server: undefined,
    })

    let socket: WebSocket | undefined
    // The reviews open in the editor, by request, each with the link it was opened over. The context holds the handler,
    // so an answer that arrives while a prompt is drawn again is not lost.
    const reviews = new Map<string, { link: WebSocket; handler: (event: EditorDiffEvent) => void }>()
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Starting again makes every search and connection of an earlier start stale.
    let generation = 0
    let zedSelection: Promise<void> | undefined
    let lastZedSelectionKey: string | undefined
    let directory = paths.cwd
    let preserveSelectionOnReconnect = false
    // `/ide` chose no editor: nothing looks for one again until it picks one, or Orbit restarts.
    let released = false

    // The window can be found by itself in an editor's terminal, which has the port or says what it is, and otherwise
    // only when something asked for it.
    const gated = () => editorPort(process.env) !== undefined || process.env.TERM_PROGRAM === "vscode" || props.autoConnect === true

    const setSelection = (selection: EditorSelection | undefined) => {
      const changed = editorSelectionKey(selection) !== editorSelectionKey(store.selection)
      setStore("selection", selection)
      if (changed) setStore("selectionSent", false)
    }

    const clearSelectionForReconnect = (options?: { resetZedSelectionKey?: boolean }) => {
      if (preserveSelectionOnReconnect) {
        preserveSelectionOnReconnect = false
        return
      }
      if (options?.resetZedSelectionKey) lastZedSelectionKey = undefined
      setSelection(undefined)
    }

    // The newest answer replaces the last one, and a link that ends takes its selection with it: a stale one must never
    // go with the next prompt.
    const clearLinkSelection = () => {
      if (store.selection?.source === "websocket") setSelection(undefined)
    }

    const find = () =>
      editor.discover?.({ directory, lockDirectory, env: process.env, log: (line) => log.info(line) })

    const wait = (ms: number, run: () => void) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, ms)
    }

    // Looks for the window once a poll for the length of the window, and connects to the first pass that finds exactly one.
    const search = (current: number, elapsed = 0) => {
      if (closed || current !== generation) return
      const found = find()
      if (found) return dial(found, current, 0)
      if (elapsed >= timing.window) return idle(current)
      wait(timing.poll, () => search(current, elapsed + timing.poll))
    }

    // Nothing was found: Zed's database is the other place a selection can come from.
    const idle = (current: number) => {
      setStore("status", "disabled")
      if (zedTerminal && editor.selection) pollZed(current)
    }

    // An answer from the editor reaches the review it names. One that does not decode, or names no review open over this
    // link, is dropped with one line (class 7).
    const answered = (value: Record<string, unknown>, link: WebSocket) => {
      const answer = Option.getOrUndefined(decodeDiffAnswer(value))
      if (!answer) return log.warn("dropped a diff answer from the editor that does not have its shape")
      const review = reviews.get(answer.id)
      if (!review || review.link !== link) return log.warn("dropped a diff answer for a review that is not open")
      // Each review is answered once; a later answer for it names nothing open.
      reviews.delete(answer.id)
      review.handler(answer)
    }

    const lose = (link: WebSocket) => {
      const lost = [...reviews].filter(([, review]) => review.link === link)
      lost.forEach(([id]) => reviews.delete(id))
      lost.forEach(([, review]) => review.handler({ answer: "lost" }))
    }

    // Sends a frame over the link once the editor said hello. A frame larger than the cap is not sent.
    const sendFrame = (frame: Record<string, unknown>) => {
      const link = socket
      if (!link || store.status !== "connected") return undefined
      const text = JSON.stringify(frame)
      if (Buffer.byteLength(text) > IdeLock.frameCap) return undefined
      link.send(text)
      return link
    }

    const dial = (
      found: Editor,
      current: number,
      failures: number,
      /** Asked for by `connect`, which wants to hear how the first attempt ended. */
      settle?: (result: "connected" | "failed") => void,
    ) => {
      setStore("status", "connecting")
      // The token goes in this header and nowhere else: not the address, not a log line, not the environment.
      const link = new WebSocketImpl(found.url, { headers: { [IdeLock.header]: found.token } } as never)
      socket = link
      let ready = false
      let stopped = false

      link.addEventListener("open", () => {
        if (socket !== link) return link.close()
        link.send(
          JSON.stringify({ type: "hello", version: IdeLock.version, pid: process.pid, features: [...IdeLock.features] }),
        )
      })

      link.addEventListener("message", (event) => {
        if (socket !== link) return
        const value = parse(event.data, () => log.warn("dropped a frame from the editor that is too large"))
        if (isRecord(value) && value.type === "diff.answer") return void (ready && answered(value, link))
        const frame = Option.getOrUndefined(decodeFrame(value))
        if (!frame) return
        if (frame.type === "hello") {
          if (frame.version !== IdeLock.version) {
            stopped = true
            log.warn("the editor speaks another version of the bridge", { version: frame.version })
            return link.close()
          }
          ready = true
          // The editor chose its name, so it is escaped before it reaches a person.
          setStore("server", {
            name: frame.editor === undefined ? found.name : plain(frame.editor),
            port: found.port,
            // A bridge from before diffs names none, and would close the link on a frame as large as a diff.
            diff: Array.isArray(frame.features) && frame.features.includes("diff"),
          })
          setStore("status", "connected")
          settle?.("connected")
          return
        }
        // Nothing before the bridge's hello counts.
        if (!ready) return
        if ((frame.type === "selection" || frame.type === "mention") && frame.filePath && hostile(frame.filePath)) {
          // A clone can name its files as it likes, and the name reaches the footer and the prompt.
          log.warn("dropped a frame whose file name holds control characters")
          // A refused selection still replaces the stored one, so the previous file's selection never goes with the next prompt.
          if (frame.type === "selection") setSelection(undefined)
          return
        }
        if (frame.type === "selection") {
          if (frame.filePath === null) return setSelection(undefined)
          // A frame without a range says nothing about what is selected.
          if (!frame.selection) return
          const selection = decodeEditorSelection({
            filePath: frame.filePath,
            text: frame.text ?? "",
            selection: frame.selection,
          })
          if (Option.isSome(selection)) setSelection({ ...selection.value, source: "websocket" })
          return
        }
        if (frame.type === "mention") {
          if ((frame.lineStart === undefined) !== (frame.lineEnd === undefined)) return
          if (frame.lineStart !== undefined && frame.lineEnd !== undefined && frame.lineEnd < frame.lineStart) return
          const mention: EditorMention = { filePath: frame.filePath }
          if (frame.lineStart !== undefined) mention.lineStart = frame.lineStart
          if (frame.lineEnd !== undefined) mention.lineEnd = frame.lineEnd
          mentionListeners.forEach((listener) => listener(mention))
        }
      })

      link.addEventListener("close", (event) => {
        // The reviews opened over this link are gone with it, whether it dropped or another link replaced it.
        lose(link)
        if (socket !== link) return
        socket = undefined
        setStore("server", undefined)
        clearLinkSelection()
        if (closed || current !== generation) return
        if (stopped || (event as { code?: number }).code === IdeLock.closeVersion) {
          settle?.("failed")
          return idle(current)
        }
        // A window the person picked is not retried when it never said hello: they are told it failed.
        if (settle && !ready) {
          settle("failed")
          return idle(current)
        }
        retry(current, ready ? 0 : failures)
      })
    }

    // A window that was reloaded has a new port and a new token while the terminal keeps the old port in its environment,
    // so every attempt reads the lock again. An attempt that finds nothing, or is refused, counts as failed.
    const retry = (current: number, failures: number) => {
      if (failures >= timing.delays.length) {
        log.warn("gave up reconnecting to the editor")
        return idle(current)
      }
      setStore("status", "connecting")
      wait(timing.delays[failures] ?? timing.poll, () => {
        if (closed || current !== generation) return
        const found = find()
        if (found) return dial(found, current, failures + 1)
        retry(current, failures + 1)
      })
    }

    const pollZed = (current: number) => {
      if (closed || current !== generation) return
      // Zed's database is another tool's file, so it is read only while compatibility is on. The poll keeps running
      // either way, which is how a change to the switch takes effect.
      if (!compat()) {
        lastZedSelectionKey = undefined
        if (store.selection?.source === "zed") setSelection(undefined)
        setStore("status", "disabled")
        return wait(timing.poll, () => pollZed(current))
      }
      zedSelection ??= editor
        .selection!(directory)
        .then((result) => {
          if (closed || socket || !compat()) return
          if (!isRecord(result) || result.type === "unavailable") return
          const decoded = result.type === "selection" ? decodeEditorSelection(result.selection) : Option.none()
          const selection = Option.getOrUndefined(decoded)
          const key = editorSelectionKey(selection)
          if (key !== lastZedSelectionKey) {
            lastZedSelectionKey = key
            setSelection(selection)
            setStore("status", selection ? "connected" : "disabled")
          }
        })
        .catch(() => {
          // Keep the last known Zed selection for transient polling failures.
        })
        .finally(() => {
          zedSelection = undefined
        })
      wait(timing.poll, () => pollZed(current))
    }

    const start = () => {
      generation += 1
      const current = generation
      if (timer) clearTimeout(timer)
      timer = undefined
      const old = socket
      socket = undefined
      old?.close()
      if (closed) return
      if (released) return setStore("status", "disabled")
      if (editor.discover && gated()) {
        setStore("status", "connecting")
        return search(current)
      }
      if (zedTerminal && editor.selection) return pollZed(current)
      setStore("status", "disabled")
    }

    const reconnectWithDirectory = (nextDirectory?: string) => {
      const resolved = nextDirectory || paths.cwd
      const sameDirectory = directory === resolved
      clearSelectionForReconnect({ resetZedSelectionKey: !sameDirectory })
      if (sameDirectory) return

      directory = resolved
      setStore("status", "disabled")
      setStore("server", undefined)
      start()
    }

    onMount(() => {
      start()

      onCleanup(() => {
        closed = true
        if (timer) clearTimeout(timer)
        socket?.close()
      })
    })

    return {
      enabled() {
        return store.status !== "disabled" || Boolean(zedTerminal && compat() && editor.selection)
      },
      connected() {
        return store.status === "connected"
      },
      selection() {
        return store.selection
      },
      clearSelection() {
        lastZedSelectionKey = undefined
        zedSelection = undefined
        setSelection(undefined)
      },
      preserveSelectionFromNewSession() {
        preserveSelectionOnReconnect = true
      },
      markSelectionSent() {
        if (!store.selection) return
        setStore("selectionSent", true)
      },
      labelState(): EditorLabelState {
        if (!store.selection) return "none"
        return store.selectionSent ? "sent" : "pending"
      },
      onMention(listener: (mention: EditorMention) => void) {
        mentionListeners.add(listener)
        return () => mentionListeners.delete(listener)
      },
      server() {
        return store.server
      },
      /**
       * Reviews of approvals in the editor's diff, for a bridge whose hello named the `diff` feature. Nothing here reads
       * or writes a file: the editor reads it behind its own checks, and the answer becomes a reply to the server.
       */
      diff: {
        available() {
          return store.status === "connected" && store.server?.diff === true
        },
        /**
         * Asks the editor to open `review`, and calls `handler` once with how it ended. False when nothing was sent: no
         * bridge that reviews diffs, or a frame larger than the cap.
         */
        open(review: EditorDiff, handler: (event: EditorDiffEvent) => void) {
          if (store.server?.diff !== true) return false
          const link = sendFrame({ type: "diff.open", ...review })
          if (!link) return false
          reviews.set(review.id, { link, handler })
          return true
        },
        /** Closes the review's tab, which answers nothing; its handler hears nothing more either. */
        close(id: string) {
          reviews.delete(id)
          if (store.server?.diff === true) sendFrame({ type: "diff.close", id })
        },
        /** Closes every Orbit diff tab in the editor; a review of this terminal UI's that was open hears `dismissed`. */
        closeAll() {
          if (store.server?.diff === true) sendFrame({ type: "diff.closeAll" })
        },
      },
      reconnect(directory?: string) {
        reconnectWithDirectory(directory)
      },
      /**
       * The editor windows `/ide` can offer: those that hold the session's folder first, then the others, each newest first,
       * and the port of the window this process is linked to, if any.
       */
      list() {
        const found = discoverEditors({ directory, lockDirectory, env: process.env, log: (line) => log.info(line) })
        return { matched: found.matched, unmatched: found.unmatched, current: store.server?.port }
      },
      /**
       * Links to the window on `port`, replacing any link and any search that is under way. The lock is read again, because
       * a window that was reloaded has a new token. It says how the attempt ended: the editor said hello, it refused or closed
       * before it did, or it stayed silent for longer than `timing.connect`.
       */
      connect(port: number) {
        generation += 1
        const current = generation
        released = false
        if (timer) clearTimeout(timer)
        timer = undefined
        const old = socket
        socket = undefined
        old?.close()
        setStore("server", undefined)
        clearLinkSelection()
        const found = readLocks(lockDirectory, (line) => log.info(line)).find((lock) => lock.port === port)
        if (!found) {
          setStore("status", "disabled")
          return Promise.resolve<"connected" | "failed" | "timeout">("failed")
        }
        return new Promise<"connected" | "failed" | "timeout">((resolve) => {
          const limit = setTimeout(() => {
            // Whatever is still trying stops with it: the person was told it timed out.
            if (current !== generation) return resolve("timeout")
            generation += 1
            const stale = socket
            socket = undefined
            stale?.close()
            setStore("status", "disabled")
            resolve("timeout")
          }, timing.connect)
          dial(found, current, 0, (result) => {
            clearTimeout(limit)
            resolve(result)
          })
        })
      },
      /** Closes the link and leaves the editor alone until `connect`, or until Orbit restarts: nothing searches or retries. */
      disconnect() {
        generation += 1
        released = true
        if (timer) clearTimeout(timer)
        timer = undefined
        const old = socket
        socket = undefined
        old?.close()
        setStore("server", undefined)
        clearLinkSelection()
        setStore("status", "disabled")
      },
    }
  },
})

export function editorSelectionKey(selection: EditorSelection | undefined) {
  if (!selection) return ""
  return [
    selection.filePath,
    ...selection.ranges.flatMap((range) => [
      range.selection.start.line,
      range.selection.start.character,
      range.selection.end.line,
      range.selection.end.character,
      range.text,
    ]),
  ].join("\0")
}

/** Control and format characters (escape sequences, bidi overrides, zero-width spaces) in a file name. */
function hostile(filePath: string) {
  // Controls, line separators, bidi controls and zero-width space act on a terminal or reorder text. ZWNJ, ZWJ and the
  // soft hyphen are ordinary in some scripts' file names, so they pass.
  return /[\p{Cc}\u200B\u200E\u200F\u061C\u2028-\u202E\u2066-\u2069\uFEFF]/u.test(filePath)
}

// The frame as JSON. Whether it fits a message is decided by its type; a type from a later version is ignored.
function parse(value: unknown, dropped: () => void) {
  if (typeof value !== "string") return
  if (Buffer.byteLength(value) > IdeLock.frameCap) return void dropped()
  return Option.getOrUndefined(decodeJson(value))
}
