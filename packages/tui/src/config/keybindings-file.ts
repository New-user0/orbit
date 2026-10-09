export * as KeybindingsFile from "./keybindings-file"

import type { KeyEvent } from "@opentui/core"
import { Keymap, stringifyKeySequence, type KeyLike, type KeymapHost, type LayerBindingAnalysis } from "@opentui/keymap"
import { registerDefaultKeys, registerMetadataFields } from "@opentui/keymap/addons"
import { createBindingLookup } from "@opentui/keymap/extras"
import { plain } from "@orbit/flow/plain"
import { Option, Schema } from "effect"
import { parse, printParseErrorCode, stripComments, type ParseError } from "jsonc-parser"
import { lstat, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { TuiKeybind } from "./keybind"

// The keybindings file is the person's own. It sits beside cli.json in the global config folder, and nothing is ever
// read in its place, so a project folder cannot supply one. Its entries only give keys to commands that already exist,
// so nothing in it starts a program or reaches the network. What it holds does reach the screen in the notes below, so
// every name or key taken from it goes through `plain` first.

export const Name = "keybindings.json"

/** Where the file lives, given the path of cli.json. */
export function locate(configFile: string) {
  return path.join(path.dirname(configFile), Name)
}

export type Diagnostic = {
  /** An error means an entry was left out. A warning means every entry applies but two of them compete for keys. */
  readonly severity: "error" | "warning"
  readonly message: string
}

type Entries = Readonly<Record<string, TuiKeybind.BindingValueSchema>>

export type Result = {
  readonly leader?: TuiKeybind.BindingValueSchema
  /** The keys the file gives each command wherever it is bound. A command it unbinds reads "none". */
  readonly bindings: Entries
  readonly contexts: Readonly<Partial<Record<TuiKeybind.Context, Entries>>>
  readonly diagnostics: readonly Diagnostic[]
}

export const empty: Result = { bindings: {}, contexts: {}, diagnostics: [] }

/**
 * Reads the file. A missing file says nothing, and one that cannot be read costs only itself. This never rejects, so a
 * broken keybindings file cannot get in the way of the settings that are read from cli.json beside it.
 */
export async function load(file: string): Promise<Result> {
  const read = await Bun.file(file)
    .text()
    .then(
      (text) => ({ text }),
      (error: NodeJS.ErrnoException) => ({ error }),
    )
  if ("text" in read) {
    // Whatever goes wrong while checking the text is a note about the file, never an error that stops the app starting.
    return Promise.resolve(read.text)
      .then(decode)
      .catch((error: unknown) =>
        refused(`could not be checked (${plain(error instanceof Error ? error.message : String(error))}).`),
      )
  }
  if (read.error.code === "ENOENT") return empty
  return refused(`could not be read (${plain(read.error.code ?? "unknown error")}).`)
}

/**
 * Checks `text` entry by entry. An entry that names no command, no context or no key that the keymap can read is left
 * out with a note, and the rest still apply. Two entries of one scope that use the same keys, or where one starts the
 * other, get a warning. Orbit's own default keys are never compared: where each is bound already settles which wins.
 */
export function decode(text: string): Result {
  // A file that holds nothing, or only comments, sets nothing.
  if (!stripComments(text).trim()) return empty
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors.at(0)
  if (first)
    return refused(`is not valid JSON (${printParseErrorCode(first.error)} at ${position(text, first.offset)}).`)
  if (!isRecord(root)) return refused("has to hold one JSON object.")

  const check = checker()
  const leader = readLeader(root.leader, check)
  const bindings = readEntries("bindings", root.bindings, check)
  const contexts = readContexts(root.contexts, check)
  const unknown = Object.keys(root)
    .filter((key) => !["$schema", "leader", "bindings", "contexts"].includes(key))
    .map((key) => problem("error", `${quote(key)} is not a setting; the file takes leader, bindings and contexts.`))

  return {
    ...(leader.value === undefined ? {} : { leader: leader.value }),
    bindings: bindings.entries,
    contexts: contexts.entries,
    diagnostics: [...unknown, ...leader.diagnostics, ...bindings.diagnostics, ...contexts.diagnostics],
  }
}

/**
 * What the file sets for a command, as `TuiKeybind.BindingLookupView.override` answers it: first for the layers of one
 * context, then for any layer. An empty list is a command that the file unbinds.
 */
export function overrides(file: Result): TuiKeybind.BindingLookupView["override"] {
  const lookup = (entries: Entries) => {
    const found = createBindingLookup(TuiKeybind.toBindingConfig(entries), {
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    return new Map(Object.keys(entries).map((command) => [command, found.get(command)]))
  }
  const everywhere = lookup(file.bindings)
  const scoped = new Map(Object.entries(file.contexts).map(([context, entries]) => [context, lookup(entries)]))
  return (context, command) =>
    (context === undefined ? undefined : scoped.get(context)?.get(command)) ?? everywhere.get(command)
}

/** Writes the commented template unless something is at the path already, and returns whether it wrote it. */
export async function create(file: string) {
  await mkdir(path.dirname(file), { recursive: true })
  // "wx" never replaces a file, but on Windows it follows a link that points at nothing and creates the file the link
  // names. So anything at the path, a link included, stops it first; a path that cannot be checked counts as taken.
  if (
    await lstat(file).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    )
  )
    return false
  return writeFile(file, template(), { flag: "wx", mode: 0o600 }).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    },
  )
}

const places = {
  global: "The whole app: the palette, switching sessions, models and agents, themes and settings.",
  prompt: "The prompt you type in, and its autocomplete.",
  session: "A session: its transcript, its sidebar and its panes.",
  permission: "A permission request that is waiting for an answer.",
  composer: "The tabs above the prompt for subagents, shell commands and terminals.",
  dialog: "Dialogs that list choices, such as the model and agent pickers.",
  "session-list":
    "The session list. It is a dialog of its own, so it takes its list keys from here and not from dialog.",
  diff: "The diff viewer.",
  "which-key": "Reserved for the which-key panel, which has no commands yet.",
  mini: "The inline view that orb mini opens.",
} satisfies Record<TuiKeybind.Context, string>

const numbered = (name: string, count: number) => Array.from({ length: count }, (_, index) => `${name}.${index + 1}`)

// The commands that the layers of each context bind, so that the template can say what a context is able to change.
// keybindings-file.test.ts checks that each name is a command and that the template lists it.
const listing = {
  global: [
    "command.palette.show",
    "app.exit",
    "app.debug",
    "app.console",
    "app.toggle.animations",
    "app.toggle.file_context",
    "app.toggle.diffwrap",
    "app.toggle.paste_summary",
    "help.show",
    "docs.open",
    "orbit.settings",
    "keybindings.open",
    "orbit.status",
    "orbit.debug",
    "server.pair",
    "service.restart",
    "location.reload",
    "diff.open",
    "plugins.list",
    "session.aside",
    "theme.switch",
    "theme.switch_mode",
    "theme.mode.lock",
    "terminal.suspend",
    "terminal.title.toggle",
    "session.list",
    "session.new",
    "open.menu",
    "session.tab.next",
    "session.tab.previous",
    "session.tab.next_unread",
    "session.tab.previous_unread",
    "session.tab.close",
    "session.tab.reopen",
    ...numbered("session.tab.select", 10),
    ...numbered("session.quick_switch", 9),
    "model.list",
    "model.cycle_recent",
    "model.cycle_recent_reverse",
    "model.cycle_favorite",
    "model.cycle_favorite_reverse",
    "agent.list",
    "agent.map",
    "agent.cycle",
    "agent.cycle.reverse",
    "variant.cycle",
    "variant.list",
    "mcp.list",
    "flow.runs",
    "provider.connect",
  ],
  prompt: [
    "prompt.submit",
    "prompt.queue",
    "prompt.editor",
    "prompt.editor_context.clear",
    "prompt.images.view",
    "prompt.skills",
    "prompt.stash",
    "prompt.stash.pop",
    "prompt.stash.list",
    "prompt.paste",
    "prompt.clear",
    "prompt.history.previous",
    "prompt.history.next",
    "prompt.history.search",
    "prompt.autocomplete.prev",
    "prompt.autocomplete.next",
    "prompt.autocomplete.hide",
    "prompt.autocomplete.select",
    "prompt.autocomplete.complete",
    "session.interrupt",
    "session.background",
    "session.move",
    "session.cd",
  ],
  session: [
    "session.export",
    "session.copy",
    "session.copy.id",
    "session.timeline",
    "session.fork",
    "session.rename",
    "session.share",
    "session.unshare",
    "session.compact",
    "session.queued_prompts",
    "session.background",
    "session.child.first",
    "session.parent",
    "session.undo",
    "session.redo",
    "messages.copy",
    "session.toggle.scrollbar",
    "session.toggle.thinking",
    "session.toggle.exploration_grouping",
    "session.verbosity.cycle",
    "session.page.up",
    "session.page.down",
    "session.line.up",
    "session.line.down",
    "session.half.page.up",
    "session.half.page.down",
    "session.first",
    "session.last",
    "session.message.next",
    "session.message.previous",
    "session.message.user.next",
    "session.message.user.previous",
    "session.messages_last_user",
    "session.sidebar.toggle",
    "pane.focus.left",
    "pane.focus.right",
    "terminal.toggle",
    "terminal.select",
    "terminal.close",
  ],
  permission: ["app.exit", "permission.prompt.fullscreen"],
  composer: [
    "composer.subagent.up",
    "composer.subagent.down",
    "composer.subagent.select",
    "composer.subagent.interrupt",
    "composer.shell.up",
    "composer.shell.down",
    "composer.shell.select",
    "composer.shell.kill",
    "composer.terminal.up",
    "composer.terminal.down",
    "composer.terminal.select",
  ],
  dialog: [
    "dialog.select.prev",
    "dialog.select.next",
    "dialog.select.page_up",
    "dialog.select.page_down",
    "dialog.select.home",
    "dialog.select.end",
    "dialog.select.submit",
    "dialog.prompt.submit",
    "dialog.integration.rename",
    "dialog.integration.delete",
    "dialog.worktree.generate",
    "dialog.move_session.new",
    "dialog.move_session.move",
    "dialog.move_session.delete",
    "dialog.move_session.refresh",
    "dialog.mcp.toggle",
    "dialog.plugins.error",
    "dialog.plugins.update",
    "dialog.plugins.check",
    "plugins.toggle",
    "model.dialog.provider",
    "model.dialog.favorite",
    "stash.delete",
    "queued_prompt.undo",
    "queued_prompt.delete",
  ],
  "session-list": [
    "dialog.select.prev",
    "dialog.select.next",
    "dialog.select.page_up",
    "dialog.select.page_down",
    "dialog.select.home",
    "dialog.select.end",
    "dialog.select.submit",
    "session.pin.toggle",
    "session.delete",
    "dialog.session.rename",
  ],
  diff: [
    "app.exit",
    "diff.close",
    "diff.down",
    "diff.up",
    "diff.page.down",
    "diff.page.up",
    "diff.half_page.down",
    "diff.half_page.up",
    "diff.first",
    "diff.last",
    "diff.next_hunk",
    "diff.previous_hunk",
    "diff.next_file",
    "diff.previous_file",
    "diff.toggle_file_tree",
    "diff.single_patch",
    "diff.switch_source",
    "diff.toggle_view",
    "diff.mark_reviewed",
    "diff.help",
  ],
  "which-key": [],
  mini: [
    "app.clear",
    "command.palette.show",
    "variant.cycle",
    "session.background",
    "session.child.first",
    "session.queued_prompts",
    "composer.subagent.interrupt",
    "prompt.queue",
    "prompt.editor",
    "prompt.paste",
    "prompt.clear",
    "prompt.history.previous",
    "prompt.history.next",
    "prompt.autocomplete.prev",
    "prompt.autocomplete.next",
    "prompt.autocomplete.hide",
    "prompt.autocomplete.select",
    "prompt.autocomplete.complete",
    "session.interrupt",
    "queued_prompt.undo",
    "queued_prompt.delete",
  ],
} satisfies Record<TuiKeybind.Context, readonly string[]>

/** What `create` writes: how the file works, then each context with the commands it covers, all as comments. */
export function template() {
  const sections = TuiKeybind.Contexts.map((context) =>
    [
      `    // ${places[context]}`,
      `    "${context}": {`,
      ...(listing[context].length
        ? listing[context].map((command) => `      ${example(command)}`)
        : ["      // (none yet)"]),
      "    }",
    ].join("\n"),
  )
  return (
    [
      "// Orbit keybindings. Orbit applies this file as soon as you save it.",
      "//",
      '// "bindings" gives a command other keys wherever it is bound. A key is a name such as "ctrl+k" or "f2",',
      '// alternatives separated by commas such as "ctrl+p,ctrl+k", a run of keys such as "gg", or a chord, which is',
      '// strokes separated by a space such as "ctrl+k ctrl+s". "<leader>n" is the leader key, then n. Escape cancels a',
      "// chord that is waiting for its next stroke. A chord takes its first key from every other command that uses it,",
      "// so start a chord with a key you do not need on its own. null takes every key away from a command.",
      "//",
      '// "contexts" gives a command other keys in one place only, and wins over "bindings" there. Each place is',
      "// listed below with the commands it covers. A command that no place lists, such as the input.* editing keys,",
      '// can still be set in "bindings".',
      "//",
      "// An entry that Orbit cannot use is left out and reported, and the rest apply. Every example below starts as a",
      "// comment: remove the leading // and change the keys to use it.",
      "{",
      '  // "leader": "ctrl+x",',
      '  "bindings": {',
      '    // "session.new": "ctrl+n",',
      '    // "app.exit": null',
      "  },",
      '  "contexts": {',
      sections.join(",\n"),
      "  }",
      "}",
    ].join("\n") + "\n"
  )
}

function example(command: string) {
  const definition = TuiKeybind.Definitions[command as TuiKeybind.CommandName]
  const keys = definition.default === "none" ? '""' : JSON.stringify(definition.default)
  const note = definition.default === "none" ? `${definition.description} (no key by default)` : definition.description
  return `// ${JSON.stringify(command)}: ${keys}, // ${note}`
}

function refused(reason: string): Result {
  return { ...empty, diagnostics: [problem("error", `The file ${reason} Orbit is ignoring all of it.`)] }
}

function problem(severity: Diagnostic["severity"], message: string): Diagnostic {
  return { severity, message }
}

function position(text: string, offset: number) {
  const before = text.slice(0, offset)
  return `line ${before.split("\n").length}, column ${offset - before.lastIndexOf("\n")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A name or key from the file, between quotes and with whatever acts on a terminal written out. */
function quote(text: string) {
  return `"${plain(text)}"`
}

const decodeBinding = Schema.decodeUnknownOption(TuiKeybind.BindingValueSchema)
const decodeLeader = Schema.decodeUnknownOption(Schema.Union([Schema.String, TuiKeybind.KeyStroke]))

function readLeader(value: unknown, check: Check) {
  if (value === undefined) {
    check.leader(TuiKeybind.LeaderDefault)
    return { value: undefined, diagnostics: [] as Diagnostic[] }
  }
  // null turns the leader off, as "none" does in cli.json. A <leader> sequence then has nothing to start from.
  if (value === null) return { value: "none" as const, diagnostics: [] as Diagnostic[] }
  const key = Option.getOrUndefined(decodeLeader(value))
  const note = key === undefined ? "it has to be one key, or null" : check.leader(key)
  if (key !== undefined && note === undefined) return { value: key, diagnostics: [] as Diagnostic[] }
  check.leader(TuiKeybind.LeaderDefault)
  const text = quote(typeof value === "string" ? value : JSON.stringify(value))
  return {
    value: undefined,
    diagnostics: [
      problem("error", `"leader" cannot be ${text} (${plain(note ?? "")}); it stays ${TuiKeybind.LeaderDefault}.`),
    ],
  }
}

type Sequence = { readonly match: readonly string[]; readonly text: string }
type Checked = { readonly sequences: readonly Sequence[] } | { readonly reason: string }
type Check = ReturnType<typeof checker>

/**
 * A keymap with no screen behind it, set up like the live one. Registering a binding on it shows whether the keymap
 * can read a key, and what the key reads as.
 */
function checker() {
  const keymap = new Keymap<object, KeyEvent>(host)
  registerDefaultKeys(keymap)
  registerMetadataFields(keymap)
  TuiKeybind.registerSyntax(keymap)
  const notes: string[] = []
  // A keymap that has no listener prints what it finds to the console.
  keymap.on("error", (event) => void notes.push(event.message))
  keymap.on("warning", () => {})
  let compiled: readonly LayerBindingAnalysis<object, KeyEvent>[] = []
  keymap.appendLayerAnalyzer((context) => {
    compiled = context.bindings
  })

  return {
    /** Makes `key` the leader and returns what the keymap said if it cannot be one. */
    leader(key: KeyLike) {
      notes.length = 0
      keymap.registerToken({ name: "leader", key })
      return notes.at(0)
    },
    key(key: KeyLike): Checked {
      notes.length = 0
      compiled = []
      keymap.registerLayer({ bindings: [{ key, cmd: "check" }] })()
      const text = quote(typeof key === "string" ? key : JSON.stringify(key))
      const note = notes.at(0)
      if (note !== undefined) return { reason: `${text} cannot be read (${plain(note)})` }
      if (compiled.length === 0) return { reason: `${text} uses ${undefinedNames(key)}` }
      return {
        sequences: compiled.map((binding) => ({
          match: binding.sequence.map((part) => part.match),
          text: stringifyKeySequence(binding.sequence, { preferDisplay: true, separator: " " }),
        })),
      }
    },
  }
}

/** Why a key that compiled to nothing and raised no error is dead: a <name> in it stands for nothing. */
function undefinedNames(key: KeyLike) {
  const names = typeof key === "string" ? [...key.matchAll(/<([^<>]*)>/g)].map((match) => match[1] ?? "") : []
  if (names.length > 0 && names.every((name) => name.toLowerCase() === "leader"))
    return "<leader> while the leader key is turned off"
  return `${names.length ? names.map((name) => plain(`<${name}>`)).join(" and ") : "a name"} that does not exist`
}

type Accepted = {
  readonly command: string
  readonly value: TuiKeybind.BindingValueSchema
  readonly sequences: readonly Sequence[]
}

function readEntries(scope: string, value: unknown, check: Check) {
  const none: Entries = {}
  if (value === undefined) return { entries: none, diagnostics: [] as Diagnostic[] }
  if (!isRecord(value)) {
    return { entries: none, diagnostics: [problem("error", `${scope} has to be an object of commands.`)] }
  }
  const read = Object.entries(value).map(([command, binding]) => readEntry(scope, command, binding, check))
  const accepted = read.filter((item): item is Accepted => "value" in item)
  return {
    entries: Object.fromEntries(accepted.map((item) => [item.command, item.value])) as Entries,
    diagnostics: [
      ...read.flatMap((item) => ("reason" in item ? [problem("error", item.reason)] : [])),
      ...conflicts(scope, accepted),
    ],
  }
}

function readEntry(scope: string, command: string, binding: unknown, check: Check): Accepted | { reason: string } {
  if (command === "leader") return { reason: `${scope}: "leader" is not a command; set it at the top of the file.` }
  if (!TuiKeybind.isCommand(command)) return { reason: `${scope}: ${quote(command)} is not a command.` }
  const value = binding === null ? "none" : Option.getOrUndefined(decodeBinding(binding))
  if (value === undefined) return { reason: `${scope}: ${quote(command)} needs a key, a list of keys or null.` }
  const checked = keysOf(value).map((key) => check.key(key))
  const failed = checked.find((item): item is { reason: string } => "reason" in item)
  if (failed) return { reason: `${scope}: ${quote(command)}: ${failed.reason}.` }
  return { command, value, sequences: checked.flatMap((item) => ("sequences" in item ? item.sequences : [])) }
}

function keysOf(value: TuiKeybind.BindingValueSchema): KeyLike[] {
  if (value === false || value === "none") return []
  return (Array.isArray(value) ? value : [value]).map((item) =>
    typeof item === "object" && "key" in item ? item.key : item,
  )
}

function readContexts(value: unknown, check: Check) {
  const none: Readonly<Partial<Record<TuiKeybind.Context, Entries>>> = {}
  if (value === undefined) return { entries: none, diagnostics: [] as Diagnostic[] }
  if (!isRecord(value))
    return { entries: none, diagnostics: [problem("error", "contexts has to be an object of places.")] }
  const read = Object.entries(value).map(([name, entries]) => {
    if (!TuiKeybind.isContext(name)) {
      const known = TuiKeybind.Contexts.join(", ")
      return {
        entries: none,
        diagnostics: [problem("error", `contexts: ${quote(name)} is not a place; they are ${known}.`)],
      }
    }
    const found = readEntries(`contexts.${name}`, entries, check)
    return {
      entries: Object.keys(found.entries).length ? { [name]: found.entries } : none,
      diagnostics: found.diagnostics,
    }
  })
  return {
    entries: Object.assign({}, ...read.map((item) => item.entries)) as Readonly<
      Partial<Record<TuiKeybind.Context, Entries>>
    >,
    diagnostics: read.flatMap((item) => item.diagnostics),
  }
}

/** Entries of one scope that compete: the same keys for two commands, or keys that one of them starts the other with. */
function conflicts(scope: string, accepted: readonly Accepted[]) {
  return accepted.flatMap((first, index) =>
    accepted.slice(index + 1).flatMap((second) => {
      const clash = first.sequences
        .flatMap((a) => second.sequences.map((b) => [a, b] as const))
        .find(([a, b]) => starts(a, b) || starts(b, a))
      if (!clash) return []
      const [a, b] = clash
      const names = `${quote(first.command)} and ${quote(second.command)}`
      return [
        problem(
          "warning",
          a.match.length === b.match.length
            ? `${scope}: ${names} both use ${plain(a.text)}.`
            : `${scope}: ${names} clash, because ${plain(a.text)} and ${plain(b.text)} start the same way.`,
        ),
      ]
    }),
  )
}

function starts(short: Sequence, long: Sequence) {
  return short.match.length <= long.match.length && short.match.every((match, index) => match === long.match[index])
}

const host: KeymapHost<object, KeyEvent> = {
  metadata: {
    platform: "unknown",
    primaryModifier: "unknown",
    modifiers: { ctrl: "unknown", shift: "unknown", meta: "unknown", super: "unknown", hyper: "unknown" },
  },
  rootTarget: {},
  isDestroyed: false,
  getFocusedTarget: () => null,
  getParentTarget: () => null,
  isTargetDestroyed: () => false,
  onKeyPress: () => () => {},
  onKeyRelease: () => () => {},
  onFocusChange: () => () => {},
  onTargetDestroy: () => () => {},
  createCommandEvent: () => {
    throw new Error("Checking the keybindings file never runs a command")
  },
}
