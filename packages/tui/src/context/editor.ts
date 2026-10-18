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
import { editorIntegration, editorPort, type Editor } from "../editor"

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
})

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
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(BridgeFrameSchema))

export type EditorSelection = Schema.Schema.Type<typeof EditorSelectionSchema>
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
export type EditorTiming = { poll: number; window: number; delays: readonly number[] }

const defaultTiming: EditorTiming = { poll: 1_000, window: 30_000, delays: [1_000, 2_000, 4_000, 8_000, 16_000] }

export const { use: useEditorContext, provider: EditorContextProvider } = createSimpleContext({
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
      /** The display name of the editor, once it has said hello. */
      server: { name?: string } | undefined
    }>({
      status: "disabled",
      selection: undefined,
      selectionSent: false,
      server: undefined,
    })

    let socket: WebSocket | undefined
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Starting again makes every search and connection of an earlier start stale.
    let generation = 0
    let zedSelection: Promise<void> | undefined
    let lastZedSelectionKey: string | undefined
    let directory = paths.cwd
    let preserveSelectionOnReconnect = false

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

    const dial = (found: Editor, current: number, failures: number) => {
      setStore("status", "connecting")
      // The token goes in this header and nowhere else: not the address, not a log line, not the environment.
      const link = new WebSocketImpl(found.url, { headers: { [IdeLock.header]: found.token } } as never)
      socket = link
      let ready = false
      let stopped = false

      link.addEventListener("open", () => {
        if (socket !== link) return link.close()
        link.send(JSON.stringify({ type: "hello", version: IdeLock.version, pid: process.pid }))
      })

      link.addEventListener("message", (event) => {
        if (socket !== link) return
        const frame = parse(event.data, () => log.warn("dropped a frame from the editor that is too large"))
        if (!frame) return
        if (frame.type === "hello") {
          if (frame.version !== IdeLock.version) {
            stopped = true
            log.warn("the editor speaks another version of the bridge", { version: frame.version })
            return link.close()
          }
          ready = true
          // The editor chose its name, so it is escaped before it reaches a person.
          setStore("server", { name: frame.editor === undefined ? found.name : plain(frame.editor) })
          setStore("status", "connected")
          return
        }
        // Nothing before the bridge's hello counts.
        if (!ready) return
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
        if (socket !== link) return
        socket = undefined
        setStore("server", undefined)
        clearLinkSelection()
        if (closed || current !== generation) return
        if (stopped || (event as { code?: number }).code === IdeLock.closeVersion) return idle(current)
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
      reconnect(directory?: string) {
        reconnectWithDirectory(directory)
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

function parse(value: unknown, dropped: () => void) {
  if (typeof value !== "string") return
  if (Buffer.byteLength(value) > IdeLock.frameCap) return void dropped()
  // A frame that does not fit, such as a type from a later version, is ignored.
  return Option.getOrUndefined(decodeFrame(value))
}
