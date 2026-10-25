// Lifecycle management for the split-footer renderer.
//
// Creates the OpenTUI CliRenderer in split-footer mode, resolves the theme
// from the terminal palette, writes the entry splash to scrollback, and
// constructs the RunFooter. Returns a Lifecycle handle whose close() writes
// the exit splash and tears everything down in the right order:
// footer.close → footer.destroy → renderer shutdown.
//
// Also wires SIGINT so Ctrl-c clears a live prompt draft first, then falls
// back to the usual two-press exit sequence through RunFooter.requestExit().
import path from "path"
import {
  CliRenderEvents,
  buildKittyKeyboardFlags,
  createCliRenderer,
  type CliRenderer,
  type ScrollbackWriter,
} from "@opentui/core"
import { isFallbackTitle } from "@orbit/util/session-title-fallback"
import { createMiniTitle } from "../util/renderer"
import { createTuiAttention } from "../attention"
import { createAttentionEvents, isAttentionEvent } from "../attention-events"
import { createRecapTrigger } from "../recap"
import { monoSnapshot } from "./mono"
import { entrySplash, exitSplash } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  FormCancel,
  FormReply,
  MiniSettingChange,
  MiniSettings,
  MiniHost,
  PermissionReply,
  QueuedPromptAction,
  RunAgent,
  RunInput,
  RunPrompt,
  RunReference,
  RunTuiConfig,
} from "./types"
import { resolveMiniSettings } from "./runtime.boot"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 4

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

export type LifecycleInput = {
  host: MiniHost
  // A seam for tests, which draw into a test renderer instead of the terminal.
  createRenderer?: typeof createCliRenderer
  getDirectory: () => string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  references: RunReference[]
  sessionID: string
  sessionTitle?: string
  getSessionID?: () => string | undefined
  first: boolean
  history: RunPrompt[]
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  tuiConfig: RunTuiConfig | Promise<RunTuiConfig>
  /** The folder the server decided trust for, which bounds the theme walk (class 3). */
  root?: string
  onMiniSettingChange?: (change: MiniSettingChange) => Promise<MiniSettings>
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onFormReply: (input: FormReply) => void | Promise<void>
  onFormCancel: (input: FormCancel) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onAgentSelect?: (agent: string) => void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onQueuedPromptAction?: (action: QueuedPromptAction, inboxID: string) => Promise<void>
  onSubagentSelect?: (sessionID: string | undefined) => void
  onSubagentInterrupt?: (sessionID: string) => void
  /** Asks the server for the away summary; the signal aborts when the person comes back. */
  recap?: (signal: AbortSignal) => Promise<unknown>
}

export type Lifecycle = {
  footer: FooterApi
  /** Reports a session event that may need the person, so Mini notifies like the TUI does. */
  observe?(event: { type: string; data?: unknown }): void
  /** Whether Mini's own session is running a turn, as read from the server when the session is loaded or reloaded. */
  setRunning?(active: boolean): void
  onResize(fn: () => void): () => void
  refreshTheme(): void
  setTitle(title?: string): void
  resetForReplay(): Promise<void>
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashTitle(title: string | undefined, history: RunPrompt[]) {
  if (title && !isFallbackTitle(title)) return title
  return history.find((item) => item.text.trim().length > 0)?.text ?? title
}

function directoryLabel(directory: string, home: string) {
  const resolved = path.resolve(directory)
  const display =
    resolved === home ? "~" : resolved.startsWith(`${home}${path.sep}`) ? resolved.replace(home, "~") : resolved
  return display.replaceAll("\\", "/")
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// Boots the split-footer renderer and constructs the RunFooter.
//
// The renderer starts in split-footer mode with captured stdout so that
// scrollback commits and footer repaints happen in the same frame. After
// the entry splash, RunFooter takes over the footer region.
export async function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const footerTask = import("./footer")
  const tuiConfig = await input.tuiConfig
  const miniSettings = resolveMiniSettings(tuiConfig)
  const mono = miniSettings.mono
  const renderer = await (input.createRenderer ?? createCliRenderer)({
    stdin: input.host.terminal.stdin,
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: mono
      ? { disambiguate: false, alternateKeys: false, events: false, allKeysAsEscapes: false, reportText: false }
      : { events: input.host.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })
  // Created with the renderer, so the focus it records covers the start-up below: a terminal reports a blur only when
  // focus changes, and the recap trigger, created later, reads what was missed.
  const attention = createTuiAttention({ renderer, config: tuiConfig })
  if (mono) renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, monoSnapshot)
  const title = createMiniTitle(renderer, input.host.platform, input.sessionTitle)
  const theme = await resolveRunTheme(renderer, tuiConfig.theme, mono, input.root)
  renderer.setBackgroundColor(theme.background)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  const startup =
    miniSettings.splash === "show" && !mono && tuiConfig.animations !== false
      ? { version: input.host.version, detail: directoryLabel(input.getDirectory(), input.host.paths.home) }
      : undefined
  queueSplash(
    renderer,
    state,
    "entry",
    miniSettings.splash === "show" && !startup
      ? entrySplash({
          version: input.host.version,
          theme: theme.splash,
          detail: directoryLabel(input.getDirectory(), input.host.paths.home),
          mono,
        })
      : undefined,
  )
  await renderer.idle().catch(() => {})
  if (mono) renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, monoSnapshot)

  const { RunFooter } = await footerTask
  let sessionTitle = input.sessionTitle
  const attentionEvents = createAttentionEvents({
    attention,
    // Mini follows one session tree: the root, and the subagents it started.
    session: (sessionID) =>
      sessionID === (input.getSessionID?.() ?? input.sessionID) ? { title: sessionTitle } : { parentID: "root" },
    // The footer shows the open request, and keeps those of the subagents it follows.
    pending: () => footer.hasPending(),
  })
  renderer.keyInput.on("keypress", attentionEvents.keypress)
  // Whether Mini's own session is running a turn: read from the server when the session loads, so a turn already under
  // way when Mini attaches holds the recap, and then kept from the execution events Mini observes.
  let running = false
  const setRunning = (active: boolean) => {
    running = active
    if (!active) recap?.idle()
  }
  const recap = input.recap
    ? createRecapTrigger({
        renderer,
        focus: attention.focus,
        afterMinutes: () => tuiConfig.session.recap.after_minutes,
        busy: () => running,
        request: input.recap,
      })
    : undefined
  let closed = false
  let sigintRegistered = false
  let detachSigintListener: (() => void) | undefined

  const footer = new RunFooter(renderer, {
    directory: input.getDirectory,
    findFiles: input.findFiles,
    agents: input.agents,
    references: input.references,
    agent: input.agent,
    modelLabel: input.model ? formatModelLabel(input.model, input.variant) : "Default model",
    model: input.model,
    variant: input.variant,
    first: input.first,
    history: input.history,
    theme,
    // The transcript always starts one row below the terminal's prior output,
    // even when the entry splash itself is hidden.
    wrote: true,
    startup,
    tuiConfig,
    root: input.root,
    miniSettings: {
      current: miniSettings,
      update: input.onMiniSettingChange,
    },
    onActivity: (next) => {
      title.setActivity(next)
    },
    onMonoChange: (mono) => {
      if (mono) {
        renderer.disableKittyKeyboard()
        return
      }
      renderer.enableKittyKeyboard(buildKittyKeyboardFlags({ events: input.host.platform === "win32" }))
    },
    onPermissionReply: input.onPermissionReply,
    onFormReply: input.onFormReply,
    onFormCancel: input.onFormCancel,
    onCycleVariant: input.onCycleVariant,
    onAgentSelect: input.onAgentSelect,
    onModelSelect: input.onModelSelect,
    onVariantSelect: input.onVariantSelect,
    onInterrupt: input.onInterrupt,
    onBackground: input.onBackground,
    onQueuedPromptAction: input.onQueuedPromptAction,
    onEditorOpen: async ({ value }) => {
      if (closed || renderer.isDestroyed) {
        return
      }

      await renderer.idle().catch(() => {})
      detachSigint()
      const detachIgnore = input.host.signals.sigint.subscribe(() => {})
      try {
        return await input.host.editor.open({
          value,
          cwd: input.getDirectory(),
          renderer,
          stdin: input.host.terminal.stdin,
        })
      } finally {
        detachIgnore()
        attachSigint()
      }
    },
    subscribeThemeSignal: input.host.signals.sigusr2.subscribe,
    onSubagentSelect: input.onSubagentSelect,
    onSubagentInterrupt: input.onSubagentInterrupt,
  })

  const sigint = () => {
    footer.requestExit()
  }

  const attachSigint = () => {
    if (closed || sigintRegistered) {
      return
    }

    detachSigintListener = input.host.signals.sigint.subscribe(sigint)
    sigintRegistered = true
  }

  const detachSigint = () => {
    if (!sigintRegistered) {
      return
    }

    detachSigintListener?.()
    detachSigintListener = undefined
    sigintRegistered = false
  }

  attachSigint()

  const close = async (next: {
    showExit: boolean
    sessionTitle?: string
    sessionID?: string
    history?: RunPrompt[]
  }) => {
    if (closed) {
      return
    }

    closed = true
    detachSigint()
    renderer.keyInput.off("keypress", attentionEvents.keypress)
    attentionEvents.dispose()
    attention.dispose()
    recap?.dispose()
    let wroteExit = false

    try {
      footer.finishStartup()
      await footer.idle().catch(() => {})

      if (!renderer.isDestroyed && next.showExit && footer.currentMiniSettings().splash === "show") {
        const sessionID = next.sessionID || input.getSessionID?.() || input.sessionID
        wroteExit = queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            title: splashTitle(next.sessionTitle ?? input.sessionTitle, next.history ?? input.history),
            session_id: sessionID,
            theme: footer.currentTheme().splash,
            mono: footer.currentMiniSettings().mono,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    } finally {
      footer.close()
      await footer.idle().catch(() => {})
      footer.destroy()
      if (input.host.platform === "linux") renderer.setTerminalTitle("")
      shutdown(renderer)
      if (!wroteExit) {
        input.host.stdout.write("\n")
      }
    }
  }

  return {
    footer,
    observe: (event) => {
      if (!isAttentionEvent(event)) return
      attentionEvents.handle(event)
      // The recap waits for the end of a turn of Mini's own session; a subagent's turn is not the person's.
      if (
        (event.type === "session.execution.started" ||
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted") &&
        event.data.sessionID === (input.getSessionID?.() ?? input.sessionID)
      )
        setRunning(event.type === "session.execution.started")
    },
    setRunning,
    refreshTheme() {
      footer.refreshTheme()
    },
    setTitle(next) {
      sessionTitle = next
      title.setTitle(next)
    },
    onResize(fn) {
      let width = renderer.terminalWidth
      let height = renderer.terminalHeight
      const resize = () => {
        if (width === renderer.terminalWidth && height === renderer.terminalHeight) {
          return
        }

        width = renderer.terminalWidth
        height = renderer.terminalHeight
        fn()
      }
      renderer.on(CliRenderEvents.RESIZE, resize)
      return () => renderer.off(CliRenderEvents.RESIZE, resize)
    },
    async resetForReplay() {
      if (closed || renderer.isDestroyed || footer.isClosed) {
        throw new Error("runtime closed")
      }

      await footer.idle()
      if (closed || renderer.isDestroyed || footer.isClosed) {
        throw new Error("runtime closed")
      }

      footer.resetForReplay(true)
      renderer.resetSplitFooterForReplay({ clearSavedLines: true })
      renderer.writeToScrollback(
        entrySplash({
          version: input.host.version,
          theme: footer.currentTheme().splash,
          detail: directoryLabel(input.getDirectory(), input.host.paths.home),
          mono: footer.currentMiniSettings().mono,
        }),
      )
      renderer.requestRender()
      await renderer.idle().catch(() => {})
    },
    close,
  }
}
