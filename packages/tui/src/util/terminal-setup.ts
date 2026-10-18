import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { CompatEditors } from "@orbit/compat/editors"

type Env = Readonly<Record<string, string | undefined>>

/**
 * The terminals that this command tells apart. Everything else is `other`. `editor` is the integrated terminal of a code
 * editor that reads VS Code's keybindings file; `detect` says which one.
 */
export type Terminal =
  | "editor"
  | "ghostty"
  | "kitty"
  | "iterm"
  | "wezterm"
  | "warp"
  | "apple-terminal"
  | "alacritty"
  | "zed"
  | "windows-terminal"
  | "tmux"
  | "screen"
  | "other"

/** The terminals that deliver Shift+Enter as its own key without being asked. */
const native: readonly Terminal[] = ["ghostty", "kitty", "iterm", "wezterm", "warp"]

/** The sequence a terminal sends for Alt+Enter: Escape, then carriage return. The prompt reads it as a newline key. */
export const newlineSequence = "\u001b\r"

/** The binding that makes the editor's terminal send {@link newlineSequence} for Shift+Enter. */
export const binding = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: newlineSequence },
  when: "terminalFocus",
} as const

/**
 * What the terminal is, from the environment alone. `distinct` is whether Shift+Enter already arrives as its own key:
 * the renderer's answer wins when it gave one, and the list of terminals that do is the fallback when it did not.
 * `remote` is whether the editor's server runs on another machine, where its keybindings file is not. `editor` is
 * which editor, when the terminal is an editor's.
 */
export function detect(env: Env, capabilities: { kitty_keyboard?: boolean } | null | undefined) {
  const editor = CompatEditors.terminal(env)
  const terminal = editor ? "editor" : terminalOf(env)
  const distinct = capabilities ? capabilities.kitty_keyboard === true : native.includes(terminal)
  return { terminal, editor, distinct, remote: CompatEditors.remote(env) }
}

function terminalOf(env: Env): Terminal {
  const program = env.TERM_PROGRAM?.toLowerCase() ?? ""
  const term = env.TERM?.toLowerCase() ?? ""
  if (term.includes("ghostty") || program === "ghostty") return "ghostty"
  if (term.includes("kitty")) return "kitty"
  if (program === "iterm.app") return "iterm"
  if (program === "wezterm") return "wezterm"
  if (program === "warpterminal") return "warp"
  if (program === "apple_terminal") return "apple-terminal"
  if (program === "zed" || env.ZED_TERM === "true") return "zed"
  if (program === "alacritty" || term === "alacritty" || env.ALACRITTY_LOG || env.ALACRITTY_SOCKET) return "alacritty"
  if (env.TMUX || program === "tmux") return "tmux"
  if (env.STY || term.startsWith("screen")) return "screen"
  if (env.WT_SESSION) return "windows-terminal"
  return "other"
}

export function terminalName(terminal: Terminal, editor?: CompatEditors.Id) {
  if (terminal === "editor") return editor ? CompatEditors.name(editor) : "the editor"
  return {
    ghostty: "Ghostty",
    kitty: "Kitty",
    iterm: "iTerm2",
    wezterm: "WezTerm",
    warp: "Warp",
    "apple-terminal": "Terminal",
    alacritty: "Alacritty",
    zed: "Zed",
    "windows-terminal": "Windows Terminal",
    tmux: "tmux",
    screen: "screen",
    other: "this terminal",
  }[terminal]
}

/**
 * Where the editor keeps its keybindings. Windows prefers %APPDATA% and falls back to the roaming folder under the home
 * folder; macOS uses Application Support; elsewhere the editor follows XDG_CONFIG_HOME before ~/.config.
 */
export function keybindingsFile(input: {
  editor: CompatEditors.Id
  platform: NodeJS.Platform
  home: string
  env: Env
}) {
  const folder = CompatEditors.userFolder(input.editor)
  if (input.platform === "win32")
    return path.win32.join(
      input.env.APPDATA || path.win32.join(input.home, "AppData", "Roaming"),
      folder,
      "User",
      "keybindings.json",
    )
  if (input.platform === "darwin")
    return path.posix.join(input.home, "Library", "Application Support", folder, "User", "keybindings.json")
  return path.posix.join(input.env.XDG_CONFIG_HOME || path.posix.join(input.home, ".config"), folder, "User", "keybindings.json")
}

export type Result =
  | { type: "installed"; file: string; backup?: string }
  | { type: "present"; file: string }
  | { type: "conflict"; file: string }
  | { type: "unparsable"; file: string }
  | { type: "failed"; file: string; reason: string }

/**
 * Adds {@link binding} to the keybindings file at `file`. The decision comes before any write, so a file that cannot be
 * read as a keybindings list, one that holds the binding already, and one that binds the key to something else are left
 * exactly as they were and leave no backup behind. A file that is edited is copied first, and nothing is written when the
 * copy fails. The edit is an insertion that keeps the comments and layout of the rest.
 */
export async function install(input: { file: string; suffix?: () => string }): Promise<Result> {
  const file = input.file
  const read = await readFile(file, "utf8").then(
    (text) => ({ text: text.replace(/^﻿/, "") }),
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? { text: undefined } : { error }),
  )
  if ("error" in read && read.error) return { type: "failed", file, reason: read.error.message }
  if (read.text === undefined || read.text.trim() === "")
    return write(file, `${JSON.stringify([binding], null, 4)}\n`).then(
      () => ({ type: "installed", file }) as const,
      (error: Error) => ({ type: "failed", file, reason: error.message }) as const,
    )

  const errors: ParseError[] = []
  const parsed: unknown = parse(read.text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !Array.isArray(parsed)) return { type: "unparsable", file }

  const taken = parsed.filter(isShiftEnterInTerminal)
  if (taken.some(same)) return { type: "present", file }
  if (taken.length > 0) return { type: "conflict", file }

  const backup = await copyAside(file, input.suffix ?? (() => randomBytes(4).toString("hex")))
  if (typeof backup !== "string") return { type: "failed", file, reason: `the backup failed: ${backup.reason}` }
  const edited = applyEdits(
    read.text,
    modify(read.text, [-1], binding, {
      isArrayInsertion: true,
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    }),
  )
  return writeFile(file, edited).then(
    () => ({ type: "installed", file, backup }) as const,
    (error: Error) => ({ type: "failed", file, reason: error.message }) as const,
  )
}

function isShiftEnterInTerminal(item: unknown) {
  if (typeof item !== "object" || item === null) return false
  const entry = item as Record<string, unknown>
  return (
    typeof entry.key === "string" &&
    entry.key.replace(/\s/g, "").toLowerCase() === "shift+enter" &&
    typeof entry.when === "string" &&
    entry.when.includes("terminalFocus")
  )
}

function same(item: unknown) {
  const entry = item as { command?: unknown; args?: { text?: unknown }; when?: unknown }
  return entry.command === binding.command && entry.args?.text === newlineSequence && entry.when === binding.when
}

async function write(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** A sibling copy named with a random suffix. An earlier backup is never overwritten: a name that is taken is skipped. */
async function copyAside(file: string, suffix: () => string): Promise<string | { reason: string }> {
  const attempt = async (left: number): Promise<string | { reason: string }> => {
    const target = `${file}.${suffix()}.bak`
    const failure = await copyFile(file, target, 1 /* COPYFILE_EXCL */).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    if (!failure) return target
    if (failure.code === "EEXIST" && left > 1) return attempt(left - 1)
    return { reason: failure.message }
  }
  return attempt(5)
}

/** The text to show, and to copy, for a terminal that this command does not change. */
export function snippet(terminal: Terminal) {
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  switch (terminal) {
    case "editor":
      return {
        where: "the keybindings file of the editor on this machine (Preferences: Open Keyboard Shortcuts (JSON))",
        text: json([binding]),
      }
    case "windows-terminal":
      return {
        where: "the actions list in the Windows Terminal settings file",
        text: json({ command: { action: "sendInput", input: newlineSequence }, keys: "shift+enter" }),
      }
    case "alacritty":
      return {
        where: "alacritty.toml",
        text: ['[[keyboard.bindings]]', 'key = "Return"', 'mods = "Shift"', 'chars = "\\u001b\\r"'].join("\n"),
      }
    case "zed":
      return {
        where: "keymap.json in the Zed configuration folder",
        text: json([{ context: "Terminal", bindings: { "shift-enter": ["terminal::SendText", newlineSequence] } }]),
      }
    case "apple-terminal":
      return {
        where: "Terminal > Settings > Profiles > Keyboard",
        text: 'Tick "Use Option as Meta key". Option+Enter then inserts a newline.',
      }
    case "tmux":
      return {
        where: "tmux.conf",
        text: ["set -g extended-keys on", 'set -as terminal-features "xterm*:extkeys"'].join("\n"),
      }
    default:
      return undefined
  }
}
