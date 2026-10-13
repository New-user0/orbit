export * as Config from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { Vcs } from "@orbit/schema/vcs"
import { Schema } from "effect"
import { createContext, onCleanup, type JSX, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { watch } from "fs"
import path from "path"
import { TuiKeybind } from "./keybind"
import { KeybindingsFile } from "./keybindings-file"

export interface Interface {
  readonly path?: string
  readonly get: () => Promise<Info>
  readonly update: (update: (draft: any) => void) => Promise<Info>
}

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>
export type AttentionSoundPaths = Partial<Record<AttentionSoundName, string>>

export const MiniWorkSpinner = Schema.Literals([
  "block-soft-slide",
  "block-soft-sweep",
  "block-low-comet",
  "block-low-duet",
  "block-shuttle",
  "block-bridge",
  "block-squeeze",
  "small-toggle",
  "square-toggle",
  "grow-shrink",
  "quadrant-orbit",
  "crosshatch",
  "density-wave",
  "seed",
])
export type MiniWorkSpinner = Schema.Schema.Type<typeof MiniWorkSpinner>

export const Plugin = Schema.Union([
  Schema.String,
  Schema.Struct({
    package: Schema.String.annotate({ description: "Plugin package name or path" }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)).annotate({
      description: "Options passed to the plugin",
    }),
  }),
])

export const DiffSource = Schema.Union([Vcs.Mode, Schema.Literal("turn")])
export type DiffSource = Schema.Schema.Type<typeof DiffSource>

export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

export const Info = Schema.Struct({
  theme: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String).annotate({ description: "Theme name" }),
      mode: Schema.optional(Schema.Literals(["system", "dark", "light"])).annotate({
        description: "Color mode; 'system' follows the terminal",
      }),
    }),
  ).annotate({ description: "Color theme settings" }),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides).annotate({ description: "Custom key bindings" }),
  plugins: Schema.optional(Schema.Array(Plugin)).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  leader: Schema.optional(
    Schema.Struct({
      timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Time in milliseconds to wait for a key after the leader key",
      }),
    }),
  ).annotate({ description: "Leader key behavior" }),
  scroll: Schema.optional(
    Schema.Struct({
      speed: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0.001))).annotate({
        description: "Distance scrolled per input tick",
      }),
      acceleration: Schema.optional(Schema.Boolean).annotate({
        description: "Accelerate scrolling from repeated input",
      }),
    }),
  ).annotate({ description: "Scrolling behavior" }),
  attention: Schema.optional(
    Schema.Struct({
      notifications: Schema.optional(Schema.Boolean).annotate({
        description: "Show a notification when Orbit needs you and the terminal is blurred, through the chosen backend",
      }),
      backend: Schema.optional(Schema.Literals(["terminal", "system"])).annotate({
        description:
          "Where notifications appear: 'terminal' asks the terminal to show them; 'system' uses the operating system's notifications (notify-send on Linux, Notification Center on macOS, a toast on Windows), and falls back to the terminal when that fails",
      }),
      sound: Schema.optional(Schema.Boolean).annotate({ description: "Play attention sounds" }),
      bell: Schema.optional(Schema.Boolean).annotate({
        description:
          "Ring the terminal bell for attention events while the terminal is blurred or its focus is unknown",
      }),
      idle_reminder: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
        description:
          "Seconds (capped at 86400) after a session finishes, with no keypress, before reminding you that Orbit is waiting; 0 turns the reminder off",
      }),
      volume: Schema.optional(
        Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
      ).annotate({ description: "Attention sound volume from 0 to 1" }),
      sound_pack: Schema.optional(Schema.String).annotate({ description: "Active attention sound pack ID" }),
      sounds: Schema.optional(Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))).annotate({
        description: "Sound file overrides by attention event",
      }),
    }),
  ).annotate({ description: "System notification and sound settings" }),
  diffs: Schema.optional(
    Schema.Struct({
      source: Schema.optional(DiffSource).annotate({
        description:
          "Initial diff source; defaults to 'branch' (branch and uncommitted changes). 'turn' shows the session's last turn and falls back to 'branch' outside a session",
      }),
      wrap: Schema.optional(Schema.Literals(["word", "none"])).annotate({
        description: "Line wrapping behavior in diff output",
      }),
      tree: Schema.optional(Schema.Boolean).annotate({ description: "Show the diff file tree" }),
      single: Schema.optional(Schema.Boolean).annotate({ description: "Show only the selected file patch" }),
      view: Schema.optional(Schema.Literals(["auto", "split", "unified"])).annotate({
        description: "Diff layout; 'auto' selects a layout from the available width",
      }),
    }),
  ).annotate({ description: "Diff presentation settings" }),
  terminal: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.Boolean).annotate({ description: "Update the terminal window title" }),
      copy: Schema.optional(Schema.Literals(["manual", "select"])).annotate({
        description: "Copy text manually or immediately after selecting it",
      }),
    }),
  ).annotate({ description: "Terminal integration settings" }),
  prompt: Schema.optional(
    Schema.Struct({
      editor: Schema.optional(Schema.Boolean).annotate({
        description: "Include the active editor file or selection as prompt context",
      }),
      paste: Schema.optional(Schema.Literals(["compact", "full"])).annotate({
        description: "Display large pastes as compact placeholders or full text",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description: "Show image attachment previews above the prompt input",
      }),
      history_limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
        description: "How many sent prompts to keep for the up arrow and history search (default 500)",
      }),
      vim: Schema.optional(Schema.Boolean).annotate({
        description: "Edit the prompt with Vim keys: Escape enters normal mode, i or a returns to insert mode",
      }),
    }),
  ).annotate({ description: "Prompt input behavior" }),
  status_line: Schema.optional(
    Schema.Struct({
      command: Schema.String.annotate({
        description:
          "Shell command whose output is shown under the prompt, one row per non-empty line (up to ten). It receives the session as JSON on stdin. It does not run while managed settings turn hooks off or allow only managed hooks.",
      }),
      interval: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000))).annotate({
        description:
          "Milliseconds between refreshes (default 5000). The line also refreshes, at most every 300 ms, when a step ends, an execution starts or ends, or the agent or model changes.",
      }),
      colors: Schema.optional(Schema.Boolean).annotate({
        description:
          "Render the colors and text styles (bold, dim, italic, underline) of the command output instead of removing them (default false). Other escape sequences are always removed.",
      }),
    }),
  ).annotate({ description: "A custom status line from your own command" }),
  session: Schema.optional(
    Schema.Struct({
      sidebar: Schema.optional(Schema.Literals(["auto", "hide"])).annotate({
        description: "Session sidebar visibility; 'auto' shows it when space permits",
      }),
      scrollbar: Schema.optional(Schema.Boolean).annotate({ description: "Show the session transcript scrollbar" }),
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning by default",
      }),
      grouping: Schema.optional(Schema.Literals(["auto", "none"])).annotate({
        description: "Group related transcript items automatically or render each item separately",
      }),
      verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])).annotate({
        description:
          "Transcript detail level: low summarizes each run of tools and thoughts, high opens exploration and instruction groups",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description: "Show user attachment and tool-result images in the session transcript",
      }),
      tps: Schema.optional(Schema.Boolean).annotate({
        description: "Show average tokens per second",
      }),
      markdown: Schema.optional(Schema.Literals(["source", "rendered"])).annotate({
        description: "Show Markdown syntax markers or conceal them in rendered transcript content",
      }),
      new_location: Schema.optional(Schema.Literals(["launch", "inherit"])).annotate({
        description: "Start new sessions in the TUI launch directory or inherit the active session location",
      }),
      permissions: Schema.optional(Schema.Literals(["prompt", "autoaccept"])).annotate({
        description: "Prompt for permission requests or accept them automatically",
      }),
    }),
  ).annotate({ description: "Session transcript presentation settings" }),
  tabs: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["auto", "on", "off"])).annotate({
        description: "Use session tabs always, never, or when the terminal environment supports them",
      }),
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Legacy tab toggle; use mode instead",
      }),
      scope: Schema.optional(Schema.Literals(["global", "cwd"])).annotate({
        description: "Share tabs globally or keep a separate set for each working directory",
      }),
      layout: Schema.optional(Schema.Literals(["horizontal", "vertical"])).annotate({
        description: "Show tabs in a horizontal strip or vertical sidebar",
      }),
      indicators: Schema.optional(Schema.Literals(["status", "numbers"])).annotate({
        description: "Show status icons or always show tab numbers",
      }),
    }),
  ).annotate({ description: "Tab strip settings" }),
  mini: Schema.optional(
    Schema.Struct({
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning",
      }),
      tools: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide tool calls and the assistant text that precedes them",
      }),
      shell_output: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide raw shell tool output",
      }),
      turn_summary: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the agent, model, and duration summary in scrollback",
      }),
      footer: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide persistent activity, model, usage, and context details in the footer",
      }),
      splash: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the entry and exit splash banners",
      }),
      work_spinner: Schema.optional(MiniWorkSpinner).annotate({
        description: "Work spinner animation in the Mini footer (default: block-soft-slide)",
      }),
      mono: Schema.optional(Schema.Boolean).annotate({
        description: "Use monochrome ASCII output",
      }),
      replay: Schema.optional(Schema.Boolean).annotate({
        description: "Restore session history on resume and terminal resize",
      }),
      replay_limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Maximum number of newest messages restored during replay",
      }),
    }),
  ).annotate({ description: "Mini transcript presentation settings" }),
  debug: Schema.optional(
    Schema.Struct({
      devtools: Schema.optional(Schema.Boolean).annotate({ description: "Show the DevTools debug bar" }),
      timing: Schema.optional(Schema.Boolean).annotate({ description: "Show time-to-first-draw diagnostics" }),
      turn_tokens: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("verbose")])).annotate({
        description: "Show per-turn token usage diagnostics, optionally with tool call inputs",
      }),
    }),
  ).annotate({ description: "Debugging settings" }),
  experimental: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description: "Experimental features that may change or be removed at any time",
  }),
  animations: Schema.optional(Schema.Boolean).annotate({ description: "Enable interface animations" }),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable terminal mouse capture" }),
  cursor: Schema.optional(Cursor),
})
export type Info = Schema.Schema.Type<typeof Info>

export type Resolved = Omit<Info, "attention" | "cursor" | "keybinds" | "leader" | "mouse" | "session" | "tabs"> & {
  attention: {
    notifications: boolean
    backend: "terminal" | "system"
    sound: boolean
    bell: boolean
    idle_reminder: number
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
  }
  keybinds: TuiKeybind.BindingLookupView
  /** What was wrong with the keybindings file, if anything. Its keys are already in `keybinds`. */
  keybindings: { diagnostics: readonly KeybindingsFile.Diagnostic[] }
  leader: { timeout: number }
  mouse: boolean
  cursor?: {
    style: "block" | "underline" | "line" | "default"
    blinking: boolean
  }
  session: Omit<NonNullable<Info["session"]>, "new_location" | "permissions" | "tps"> & {
    new_location: "launch" | "inherit"
    permissions: "prompt" | "autoaccept"
    terminal: boolean
    tps: boolean
  }
  tabs: {
    mode: "auto" | "on" | "off"
    enabled: boolean
    scope: "global" | "cwd"
    layout: "horizontal" | "vertical"
    indicators: "status" | "numbers"
  }
}

export function resolve(
  input: Info,
  options: {
    terminalSuspend: boolean
    environment?: Readonly<Record<string, string | undefined>>
    keybindings?: KeybindingsFile.Result
  },
): Resolved {
  const tabsMode = input.tabs?.mode ?? (input.tabs?.enabled === undefined ? "auto" : input.tabs.enabled ? "on" : "off")
  const file = options.keybindings ?? KeybindingsFile.empty
  // The keybindings file is read after cli.json, so what it sets for a command wins over what cli.json sets.
  const keybinds: TuiKeybind.KeybindOverrides = {
    ...input.keybinds,
    ...(file.leader === undefined ? {} : { leader: file.leader }),
    ...file.bindings,
  }
  if (!options.terminalSuspend) {
    keybinds["terminal.suspend"] = "none"
    if (keybinds["input.undo"] === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input.undo")
      keybinds["input.undo"] = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(",")
    }
  }

  return {
    ...input,
    attention: {
      notifications: input.attention?.notifications ?? false,
      backend: input.attention?.backend ?? "terminal",
      sound: input.attention?.sound ?? false,
      bell: input.attention?.bell ?? false,
      idle_reminder: Math.min(input.attention?.idle_reminder ?? 60, 86400),
      volume: input.attention?.volume ?? 0.4,
      sound_pack: input.attention?.sound_pack ?? "orbit.default",
      sounds: input.attention?.sounds ?? {},
    },
    keybinds: Object.assign(
      createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(keybinds)), {
        bindingDefaults: TuiKeybind.bindingDefaults(),
      }),
      { override: KeybindingsFile.overrides(file) },
    ),
    keybindings: { diagnostics: file.diagnostics },
    leader: { timeout: input.leader?.timeout ?? 2000 },
    mouse: input.mouse ?? true,
    cursor: input.cursor
      ? {
          style: input.cursor.style ?? "block",
          blinking: input.cursor.blinking ?? true,
        }
      : undefined,
    session: {
      ...input.session,
      new_location: input.session?.new_location ?? "launch",
      permissions: input.session?.permissions ?? "prompt",
      // Persistent terminal panes need the orbit-pty daemon, which does not ship Windows binaries.
      terminal: process.platform !== "win32",
      tps: input.session?.tps ?? true,
    },
    tabs: {
      ...input.tabs,
      mode: tabsMode,
      enabled: tabsMode === "on" || (tabsMode === "auto" && (options.environment ?? process.env).HERDR_ENV !== "1"),
      scope: input.tabs?.scope ?? "cwd",
      layout: input.tabs?.layout ?? "horizontal",
      indicators: input.tabs?.indicators ?? "status",
    },
  }
}

/**
 * Reads cli.json through the host, and the keybindings file that sits beside it. The two are read on their own: a
 * keybindings file that is missing or broken says so in `keybindings.diagnostics` and never makes this reject.
 */
export async function read(host: Interface) {
  const [info, keybindings] = await Promise.all([
    host.get(),
    host.path ? KeybindingsFile.load(KeybindingsFile.locate(host.path)) : KeybindingsFile.empty,
  ])
  return { info, keybindings }
}

const ConfigContext = createContext<{
  data: Resolved
  path?: string
  update: Interface["update"]
}>()

export function ConfigProvider(props: {
  config: Resolved
  /** The keybindings file that `config` was resolved with, so that a change to cli.json keeps it. */
  keybindings?: KeybindingsFile.Result
  service?: Interface
  options?: { terminalSuspend: boolean; environment?: Readonly<Record<string, string | undefined>> }
  children: JSX.Element
}) {
  const [config, setConfig] = createStore(props.config)
  const host = props.service
  let keybindings = props.keybindings ?? KeybindingsFile.empty
  const apply = (info: Info) =>
    setConfig(reconcile(resolve(info, { ...(props.options ?? { terminalSuspend: true }), keybindings })))
  const update = async (update: (draft: any) => void) => {
    if (!host) throw new Error("Config updates are not available")
    const info = await host.update(update)
    apply(info)
    return info
  }
  let reload = Promise.resolve()
  // The keybindings file sits in the directory that holds cli.json, so this one watcher covers both.
  const watcher = host?.path
    ? watch(path.dirname(host.path), () => {
        reload = reload
          .then(() => read(host))
          .then((next) => {
            keybindings = next.keybindings
            apply(next.info)
          })
          .catch(() => {})
      })
    : undefined
  onCleanup(() => watcher?.close())
  return (
    <ConfigContext.Provider value={{ data: config, path: host?.path, update }}>{props.children}</ConfigContext.Provider>
  )
}

export function useConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("ConfigProvider is missing")
  return value
}
