export * as ShellPaths from "./paths.js"

import { FSUtil } from "@orbit/util/fs-util"
import type { Command, Context, Word } from "./analysis.js"
import type { PowerShellParse } from "./powershell-parse.js"
import { CMDLETS, type Entry } from "./paths-table.js"
import { ShellReadOnly } from "./readonly.js"

// The files a shell command names, as data: which words are paths, what the command does to each, and in which places a
// relative spelling may land. Nothing here allows or denies, and nothing here touches the disk or reads process.platform:
// the caller injects the platform, the home folder and the working folder, so Windows semantics run on Linux too. Whether
// a place is inside the project is decided later, on real paths at check time, by the guard (never by comparing the
// strings built here; links, dangling links and spellings that only exist on disk are the guard's to resolve).
//
// An operand that cannot be judged from its text is `dynamic` and has no candidate places. A command whose operands
// cannot be told apart from its options is recorded in `unvalidatable`, with a fixed reason code that never carries
// command text (class 9).

export type Role = "remove" | "write" | "create" | "source" | "read"
export type Form = "literal" | "glob" | "dynamic"
export type Flag =
  | "share"
  | "device"
  | "stream"
  | "short-name"
  | "trailing"
  | "dots"
  | "drive-relative"
  | "provider"
  | "escape"
  | "expansion"
  | "directory"

export type Operand = {
  /** Index into the analysis' commands. */
  command: number
  role: Role
  via: "argument" | "redirect"
  form: Form
  /** What the program receives, with unknown parts shown as a placeholder and control characters replaced. For display. */
  spelled: string
  /** A glob: the literal folder part, or the whole path when `..` follows a wildcard. */
  prefix?: string
  /** The folders a relative spelling may resolve from, the working folder first. */
  bases: string[]
  /** Absolute places the spelling may name, joined lexically with each base. Empty for a dynamic, share or device operand. */
  candidates: string[]
  flags: Flag[]
}

export type Reason =
  | "option"
  | "stdin"
  | "wrapper"
  | "operand"
  | "parameter"
  | "array"
  | "dynamic"
  | "positional"
  | "leaf"
  | "pipeline"
  | "no-path"
  | "native"

export type Facts = {
  /** Every write-class operand, every source, every write redirect, and the read paths of the read-class commands. */
  files: Operand[]
  /** Commands whose paths cannot be told from their text. A fixed code, never text from the command. */
  unvalidatable: { command: number; reason: Reason }[]
  /** Counted directory changes; in PowerShell only when the input has more than one command. */
  directoryChanges: number
  /** A command that creates a link, which changes where later relative paths lead. */
  links: boolean
  /** Whether accept-edits may allow the input once the guard has judged every operand. */
  fileEdit: boolean
  /** By command index: the folders a relative spelling may resolve from when that command starts, and whether an earlier directory change led somewhere unknown. */
  scopes: { bases: string[]; lost: boolean }[]
}

export function empty(): Facts {
  return { files: [], unvalidatable: [], directoryChanges: 0, links: false, fileEdit: false, scopes: [] }
}

/** The cmdlets in the table, for the tests that compare it with recorded hosts. */
export function cmdletNames() {
  return Object.keys(CMDLETS)
}

// The marker the bash walker uses for a part that is not known before the command runs.
const UNKNOWN = "\u0001"

type State = {
  ctx: Context
  powershell: boolean
  /** The home folder that the shell expands `~` to. */
  home: string
  /** `HOME` is assigned in the input, so a `~` is not the home folder. */
  homeChanged: boolean
  bases: string[]
  /** An earlier directory change leads somewhere unknown. */
  lost: boolean
  /** An earlier command maps a drive letter (New-PSDrive), so a drive path may lead anywhere. */
  drives: boolean
  facts: Facts
}

type Input = {
  command: number
  role: Role
  via?: "argument" | "redirect"
  text: string
  literal: boolean
  glob?: boolean
  tilde?: boolean
  flags?: Flag[]
}

function start(ctx: Context, powershell: boolean, homeChanged: boolean): State {
  const set = ctx.env.HOME
  // Git Bash may set HOME; PowerShell's `~` is its own $HOME, the profile folder, whatever HOME says.
  const home = !powershell && set !== undefined && set !== "" && ctx.path.isAbsolute(set) ? set : ctx.home
  return { ctx, powershell, home, homeChanged, bases: [ctx.cwd], lost: false, drives: false, facts: empty() }
}

// ---------------------------------------------------------------------------------------------------------------------
// One spelling to one operand

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const SHARE_WORDS = /DavWWWRoot|@SSL@/i

function show(text: string) {
  return text.replaceAll(UNKNOWN, "<unknown>").replace(CONTROL, "\ufffd")
}

function operand(state: State, input: Input): Operand {
  const ctx = state.ctx
  const win = ctx.platform === "win32"
  // PowerShell opens a path as Windows does: it knows nothing of Git Bash, Cygwin or WSL drive spellings (`/c/x` is `\c\x`
  // on the current drive), so those are not translated for it.
  const plain = state.powershell && win
  const flags = new Set<Flag>(input.flags)
  let text = input.text
  let dynamic = !input.literal
  // PowerShell on Linux takes both separators; the POSIX path functions only one.
  if (state.powershell && !win) text = text.replaceAll("\\", "/")

  // A quoted `~` (or one after `--option=`) is not expanded by bash: it is a folder of that name in the working folder.
  if (!dynamic && text.startsWith("~") && (state.powershell || input.tilde !== false)) {
    if (state.homeChanged && !state.powershell) dynamic = true
    else if (text === "~" || text.startsWith("~/") || ((win || state.powershell) && text.startsWith("~\\"))) text = state.home + text.slice(1)
    else dynamic = true
    if (dynamic) flags.add("expansion")
  }
  if (!dynamic && (/[$%]/.test(text) || text.startsWith("="))) {
    dynamic = true
    flags.add("expansion")
  }
  if (!dynamic && state.powershell) {
    // A backtick escape is already resolved in the text by the caller; the flag is what remains of it.
    if (text.includes("`") || flags.has("escape")) {
      dynamic = true
      flags.add("escape")
    }
    // A provider-qualified path (`FileSystem::C:\x`) or a provider drive (`env:`, `HKLM:`). On Windows one letter is a drive.
    if (text.includes("::") || (win ? /^[A-Za-z0-9]{2,}:/ : /^[A-Za-z0-9]+:/).test(text)) {
      dynamic = true
      flags.add("provider")
    }
  }

  // A share or a device is judged by its spelling alone: the guard must not touch the disk for either.
  const device = (win || state.powershell) && /^[\\/]{2}[?.][\\/]/.test(text)
  const share = win ? ShellReadOnly.windowsShare(text) : state.powershell && (/^\/\/[^/]/.test(text) || SHARE_WORDS.test(text))
  if (device) flags.add("device")
  if (share) flags.add("share")
  if (win && input.literal) {
    const rest = text.replace(/^[\\/]{2}[?.][\\/](?:UNC[\\/])?/i, "").replace(/^[A-Za-z]:/, "")
    // A `:` inside a bracket expression (`[[:alpha:]]`) is part of the wildcard, not a stream name.
    if (!flags.has("provider") && rest.replace(/\[(?:[^\][]|\[:[a-z]+:\])*\]/g, "").includes(":")) flags.add("stream")
    if (/~\d/.test(text)) flags.add("short-name")
    const parts = text.split(/[\\/]/).filter(Boolean)
    if (parts.some((part) => /^\.{3,}$/.test(part))) flags.add("dots")
    if (parts.some((part) => !/^\.+$/.test(part) && /[. ]$/.test(part))) flags.add("trailing")
    if (/^[A-Za-z]:(?![\\/])/.test(text)) {
      flags.add("drive-relative")
      dynamic = true
    }
  }

  // New-PSDrive can map any drive letter to any place.
  if (!dynamic && state.drives && /^[A-Za-z]:/.test(text)) {
    dynamic = true
    flags.add("provider")
  }
  // After a directory change that leads somewhere unknown, a relative spelling cannot be placed.
  if (!dynamic && state.lost && !ctx.path.isAbsolute(plain ? text : FSUtil.windowsPath(text, ctx.platform))) {
    dynamic = true
    flags.add("directory")
  }

  const wildcards = win && !state.powershell ? /[*?[\]{}]/ : /[*?[\]]/
  // A device path is judged by its spelling alone: the question mark of its prefix is not a wildcard.
  // Bash expands only an unquoted wildcard, but a Windows program may expand any, and PowerShell's own cmdlets do.
  const glob = !dynamic && !device && wildcards.test(text) && (input.glob === true || win || state.powershell)
  const closed = dynamic || device || share
  const prefix = glob ? globPrefix(text, wildcards, win || state.powershell) : undefined
  // `resolveFrom` would expand a leading `~` itself; one the shell left alone is a folder of that name here.
  const place = (prefix ?? text).startsWith("~") && !state.powershell && input.tilde === false ? `./${prefix ?? text}` : (prefix ?? text)
  const candidates = closed
    ? []
    : [...new Set(state.bases.map((base) => (plain ? FSUtil.windowsTrim(ctx.path.resolve(base, place), ctx.platform) : FSUtil.resolveFrom(base, place, state.home, ctx.platform))))]
  return {
    command: input.command,
    role: input.role,
    via: input.via ?? "argument",
    form: dynamic ? "dynamic" : glob ? "glob" : "literal",
    spelled: show(text),
    ...(prefix === undefined ? {} : { prefix: show(prefix) }),
    bases: [...state.bases],
    candidates,
    flags: [...flags],
  }
}

// The folder before the first wildcard, "." when none, or the whole path when `..` follows a wildcard (the wildcard may
// then stand for a folder that the climb leaves, so the folder part alone would hide where the path ends up).
function globPrefix(text: string, wildcards: RegExp, backslash: boolean) {
  const at = text.search(wildcards)
  const tail = text.slice(at)
  if (tail.split(/[\\/]/).includes("..")) return text
  const head = text.slice(0, at)
  const cut = Math.max(head.lastIndexOf("/"), backslash ? head.lastIndexOf("\\") : -1)
  if (cut < 0) return "."
  return cut === 0 ? head.slice(0, 1) : head.slice(0, cut)
}

function add(state: State, input: Input) {
  const made = operand(state, input)
  state.facts.files.push(made)
  return made
}

function refuse(state: State, command: number, reason: Reason) {
  if (!state.facts.unvalidatable.some((item) => item.command === command && item.reason === reason)) state.facts.unvalidatable.push({ command, reason })
}

function word(state: State, command: number, role: Role, item: Word, via: "argument" | "redirect" = "argument") {
  return add(state, { command, role, via, text: item.value, literal: item.literal, glob: item.glob, tilde: item.tilde })
}

// The read paths the read-only check reported, already expanded by it.
function reads(state: State, command: number, paths: string[]) {
  for (const text of paths) add(state, { command, role: "read", text, literal: !text.includes(UNKNOWN), glob: true })
}

// ---------------------------------------------------------------------------------------------------------------------
// Bash

const DIRECTORY = new Set(["cd", "chdir", "pushd", "popd"])

type Spec = {
  switches: string
  longs: string
  valueShorts?: string
  valueLongs?: string
  /** Options that take a file or folder: the value's role by option name. */
  paths?: Record<string, Role>
  /** A word shaped like this is an operand, whatever it starts with (a `chmod` mode such as `-w`). */
  operandLike?: RegExp
  /** An unknown option is skipped instead of refusing the parse (`mv` and `cp`, which refuse any option anyway). */
  loose?: true
}

type Parsed = {
  operands: Word[]
  options: { name: string; word?: Word }[]
  bad: boolean
  /** Any option at all, `--` included. */
  any: boolean
  seen: Set<string>
}

const OPTIONAL_VALUE = new Set(["interactive", "preserve-root", "remove", "output-error", "backup", "color", "context"])

const SPECS: Record<string, Spec> = {
  rm: { switches: "frRiIvd", longs: "force recursive interactive verbose dir one-file-system no-preserve-root preserve-root" },
  rmdir: { switches: "pv", longs: "parents verbose ignore-fail-on-non-empty" },
  unlink: { switches: "", longs: "" },
  shred: { switches: "fuvxz", longs: "force remove verbose exact zero", valueShorts: "ns", valueLongs: "iterations size random-source" },
  mv: { switches: "", longs: "", valueShorts: "tS", valueLongs: "target-directory suffix", paths: { t: "write", "target-directory": "write" }, loose: true },
  cp: { switches: "", longs: "", valueShorts: "tS", valueLongs: "target-directory suffix", paths: { t: "write", "target-directory": "write" }, loose: true },
  install: {
    switches: "cCdDpsv",
    longs: "compare directory preserve-timestamps strip verbose",
    valueShorts: "mogSt",
    valueLongs: "mode owner group suffix target-directory strip-program",
    paths: { t: "write", "target-directory": "write" },
  },
  ln: {
    switches: "sfnviTrbLPdF",
    longs: "symbolic force no-dereference verbose interactive relative no-target-directory logical physical backup directory",
    valueShorts: "tS",
    valueLongs: "target-directory suffix",
    paths: { t: "create", "target-directory": "create" },
  },
  mkdir: { switches: "pvZ", longs: "parents verbose context", valueShorts: "m", valueLongs: "mode" },
  touch: {
    switches: "acfhm",
    longs: "no-create no-dereference",
    valueShorts: "dtr",
    valueLongs: "date time reference",
    paths: { r: "source", reference: "source" },
  },
  tee: { switches: "aip", longs: "append ignore-interrupts output-error" },
  truncate: {
    switches: "co",
    longs: "no-create io-blocks",
    valueShorts: "sr",
    valueLongs: "size reference",
    paths: { r: "source", reference: "source" },
  },
  chmod: {
    switches: "Rhfvc",
    longs: "recursive no-dereference silent quiet verbose changes preserve-root no-preserve-root",
    valueLongs: "reference",
    paths: { reference: "source" },
    operandLike: /^-[rwxXstugoa+=,-]*$/,
  },
  chown: {
    switches: "RhfvcHLP",
    longs: "recursive no-dereference silent quiet verbose changes preserve-root no-preserve-root dereference",
    valueLongs: "reference from",
    paths: { reference: "source" },
  },
  chgrp: {
    switches: "RhfvcHLP",
    longs: "recursive no-dereference silent quiet verbose changes preserve-root no-preserve-root dereference",
    valueLongs: "reference",
    paths: { reference: "source" },
  },
  dd: { switches: "", longs: "" },
}
const PATH_COMMANDS = new Set([...Object.keys(SPECS), "sed"])

// `bsd`: the tools stop reading options at the first operand (macOS), so everything after it is an operand. GNU tools read
// options anywhere.
function parse(words: Word[], spec: Spec, bsd: boolean): Parsed {
  const parsed: Parsed = { operands: [], options: [], bad: false, any: false, seen: new Set() }
  let ended = false
  for (let index = 0; index < words.length; index++) {
    const item = words[index]
    const text = item.value
    if (ended || text === "-" || !text.startsWith("-") || spec.operandLike?.test(text)) {
      parsed.operands.push(item)
      if (bsd) ended = true
      continue
    }
    parsed.any = true
    if (text === "--") {
      ended = true
      continue
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=")
      const name = equals < 0 ? text.slice(2) : text.slice(2, equals)
      parsed.seen.add(name)
      if (spec.valueLongs?.split(" ").includes(name)) {
        const value = equals >= 0 ? { ...item, value: text.slice(equals + 1), glob: false, tilde: false } : words[++index]
        parsed.options.push({ name, ...(value === undefined ? {} : { word: value }) })
        continue
      }
      const known = spec.longs.split(" ").includes(name)
      if (!known && !spec.loose) parsed.bad = true
      if (known && equals >= 0 && !OPTIONAL_VALUE.has(name)) parsed.bad = true
      continue
    }
    for (let at = 1; at < text.length; at++) {
      const char = text[at]
      parsed.seen.add(char)
      if (spec.valueShorts?.includes(char)) {
        const rest = text.slice(at + 1)
        const value = rest === "" ? words[++index] : { ...item, value: rest, glob: false, tilde: false }
        parsed.options.push({ name: char, ...(value === undefined ? {} : { word: value }) })
        break
      }
      if (!spec.switches.includes(char) && !spec.loose) parsed.bad = true
    }
  }
  return parsed
}

type Sink = (role: Role, item: Word) => void

// What each command does to its operands. Returns false when the operands cannot be told from the text.
function emit(name: string, words: Word[], sink: Sink, state: State) {
  if (name === "sed") return sed(words, sink)
  if (name === "dd") return dd(words, sink)
  const found = SPECS[name]
  const parsed = parse(words, found, state.ctx.platform === "darwin")
  const mapped = found.paths ?? {}
  for (const option of parsed.options) {
    const role = mapped[option.name]
    if (role && option.word) sink(role, option.word)
  }
  const target = parsed.options.find((option) => mapped[option.name] === "write" || (name === "ln" && mapped[option.name] === "create"))
  const operands = parsed.operands
  const last = operands.at(-1)
  const rest = operands.slice(0, -1)
  switch (name) {
    case "rm":
    case "rmdir":
    case "unlink":
      operands.forEach((item) => sink("remove", item))
      break
    case "shred":
      operands.forEach((item) => sink(parsed.seen.has("u") || parsed.seen.has("remove") ? "remove" : "write", item))
      break
    case "mv":
    case "cp":
      if (target) operands.forEach((item) => sink(name === "mv" ? "remove" : "source", item))
      else {
        rest.forEach((item) => sink(name === "mv" ? "remove" : "source", item))
        if (last) sink("write", last)
      }
      // Any option can name a destination that the extractor cannot see (`--target-directory`, `-t`), so the command asks.
      if (parsed.any) return false
      return true
    case "install":
      if (parsed.seen.has("d") || parsed.seen.has("directory")) operands.forEach((item) => sink("create", item))
      else if (target) operands.forEach((item) => sink("source", item))
      else {
        rest.forEach((item) => sink("source", item))
        if (last) sink("write", last)
      }
      break
    case "ln":
      state.facts.links = true
      if (target) operands.forEach((item) => sink("source", item))
      else if (operands.length === 1) {
        sink("source", operands[0])
        // The link is made in the working folder, named after the target.
        sink("create", { value: ".", literal: true, quoted: false, glob: false, arithmetic: false, tilde: false })
      } else {
        rest.forEach((item) => sink("source", item))
        if (last) sink("create", last)
      }
      break
    case "mkdir":
    case "touch":
      operands.forEach((item) => sink("create", item))
      break
    case "tee":
    case "truncate":
      operands.forEach((item) => sink("write", item))
      break
    case "chmod":
    case "chown":
    case "chgrp":
      // The first operand is the mode or the owner, unless --reference supplies it.
      ;(parsed.seen.has("reference") ? operands : operands.slice(1)).forEach((item) => sink("write", item))
      break
  }
  return !parsed.bad
}

function dd(words: Word[], sink: Sink) {
  let ok = true
  for (const item of words) {
    const at = item.value.indexOf("=")
    if (item.value.startsWith("-") || at < 0) {
      ok = false
      continue
    }
    const key = item.value.slice(0, at)
    // Bash also expands a tilde after the equals sign of a word shaped like an assignment.
    const value = { ...item, value: item.value.slice(at + 1), glob: false, tilde: !item.quoted || item.equalsTilde === true }
    if (key === "if") sink("source", value)
    else if (key === "of") sink("write", value)
  }
  return ok
}

function sed(words: Word[], sink: Sink) {
  let ok = true
  let inPlace = false
  let scripted = false
  let ended = false
  const files: Word[] = []
  const sources: Word[] = []
  const scripts: Word[] = []
  for (let index = 0; index < words.length; index++) {
    const item = words[index]
    const text = item.value
    if (ended || text === "-" || !text.startsWith("-")) {
      if (!scripted) {
        scripted = true
        scripts.push(item)
      } else files.push(item)
      continue
    }
    if (text === "--") {
      ended = true
      continue
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=")
      const name = equals < 0 ? text.slice(2) : text.slice(2, equals)
      const inline = equals < 0 ? undefined : { ...item, value: text.slice(equals + 1), glob: false, tilde: false }
      if (name === "in-place") inPlace = true
      else if (name === "expression") {
        scripted = true
        const value = inline ?? words[++index]
        if (value) scripts.push(value)
      } else if (name === "file") {
        scripted = true
        const value = inline ?? words[++index]
        if (value) sources.push(value)
      } else if (name === "line-length") {
        if (!inline) index++
      } else if (!"quiet silent regexp-extended separate unbuffered null-data posix debug sandbox follow-symlinks binary help version".split(" ").includes(name)) ok = false
      continue
    }
    for (let at = 1; at < text.length; at++) {
      const char = text[at]
      const rest = text.slice(at + 1)
      if (char === "i") {
        inPlace = true
        break
      }
      if (char === "e" || char === "f" || char === "l") {
        if (char !== "l") scripted = true
        const value = rest === "" ? words[++index] : { ...item, value: rest, glob: false, tilde: false }
        if (char === "f" && value) sources.push(value)
        if (char === "e" && value) scripts.push(value)
        break
      }
      if (!"nErsuzb".includes(char)) ok = false
    }
  }
  sources.forEach((item) => sink("source", item))
  // The files a script of the command line names itself (`w out`, `s/a/b/w out`, `r in`). A script read from a file is not seen.
  scripts.forEach((script) => sedFiles(script.value).forEach((found) => sink(found.role, { ...script, value: found.file, glob: false, tilde: false })))
  if (inPlace) files.forEach((item) => sink("write", item))
  return ok
}

// The files named by the commands of a sed script, found by walking its commands so that a `w` inside a regex, a
// replacement or the text of `a`, `i` and `c` is not one. A file name runs to the end of the line.
function sedFiles(script: string) {
  const found: { role: "write" | "source"; file: string }[] = []
  let at = 0
  const name = (role: "write" | "source") => {
    const end = script.indexOf("\n", at)
    const stop = end < 0 ? script.length : end
    const file = script.slice(at, stop).replace(/^[ \t]+/, "")
    at = stop
    // GNU sed writes these two to the streams, not to files.
    if (file !== "" && file !== "/dev/stdout" && file !== "/dev/stderr") found.push({ role, file })
  }
  // GNU sed reads a bracket expression of a regex as one unit, so a delimiter inside `[/]` does not end the regex.
  const skip = (delimiter: string, regex = false) => {
    while (at < script.length) {
      const char = script[at++]
      if (char === "\\") at++
      else if (char === delimiter) return true
      else if (char === "[" && regex) bracket()
    }
    return false
  }
  const bracket = () => {
    if (script[at] === "^") at++
    if (script[at] === "]") at++
    while (at < script.length && script[at] !== "]") {
      // `[:alpha:]`, `[.x.]` and `[=x=]` hold their own `]`.
      const close = script[at] === "[" && ":.=".includes(script[at + 1] ?? "") ? script.indexOf(`${script[at + 1]}]`, at + 2) : -1
      at = close < 0 ? at + 1 : close + 2
    }
    at++
  }
  const rest = () => {
    const end = script.indexOf("\n", at)
    at = end < 0 ? script.length : end
  }
  while (at < script.length) {
    const char = script[at]
    // Separators, and the characters of an address.
    if (/[\s;{}!0-9$+~,]/.test(char)) {
      at++
      continue
    }
    if (char === "/" || char === "\\") {
      const delimiter = char === "/" ? "/" : script[at + 1]
      at += char === "/" ? 1 : 2
      if (delimiter === undefined || !skip(delimiter, true)) break
      continue
    }
    at++
    if (char === "s" || char === "y") {
      const delimiter = script[at++]
      if (delimiter === undefined || !skip(delimiter, char === "s") || !skip(delimiter)) break
      if (char === "y") continue
      // The flags end at `;`, `}` or the end of the line, except `w`, whose file name takes the rest of the line.
      while (at < script.length && !/[;}\n]/.test(script[at])) {
        if (script[at++] !== "w") continue
        name("write")
        break
      }
    } else if (char === "w" || char === "W") name("write")
    else if (char === "r" || char === "R") name("source")
    else if ("aice#".includes(char)) rest()
    else if (":btT".includes(char)) while (at < script.length && !/[;\n]/.test(script[at])) at++
  }
  return found
}

export type BashInput = {
  commands: Command[]
  ctx: Context
  /** `HOME` is assigned somewhere in the input. */
  homeChanged: boolean
  /** The first command is a `cd` into the working folder that the analysis drops. */
  dropped: boolean
  /** The input assigns a variable that changes which program or library runs (`PATH`, `LD_PRELOAD`). */
  sensitive: boolean
}

export function bash(input: BashInput): Facts {
  const state = start(input.ctx, false, input.homeChanged)
  const ctx = input.ctx
  // A command's reads are judged with its write redirects set aside: the redirect is its own (write) operand, and the files
  // the command reads are still read, so `cat /etc/shadow > notes` reports both.
  const verdicts = input.commands.map((command) => bareVerdict(input.commands, command, ctx))
  input.commands.forEach((command, index) => {
    state.facts.scopes[index] = { bases: [...state.bases], lost: state.lost }
    const verdict = verdicts[index]
    if (verdict.ok) reads(state, index, verdict.reads)
    else operands(state, index, command, ctx)
    if (command.wrapper) refuse(state, index, "wrapper")
    const name = headName(command.inner[0] ?? "", ctx)
    const words = command.argv.slice(command.argv.length - command.inner.length + 1)
    if (DIRECTORY.has(name)) {
      if (!(input.dropped && index === 0)) state.facts.directoryChanges++
      change(state, index, name, words)
    } else if (name === "xargs" && words.some((item) => PATH_COMMANDS.has(item.value))) refuse(state, index, "stdin")
    else if (PATH_COMMANDS.has(name)) {
      const sink: Sink = (role, item) => void word(state, index, role, item)
      if (!emit(name, words, sink, state)) refuse(state, index, name === "dd" ? "operand" : "option")
    }
    for (const redirect of command.redirects) {
      if (!redirect.write || redirect.nullSink || redirect.target === undefined) continue
      add(state, { command: index, role: "write", via: "redirect", text: redirect.target, literal: redirect.literal, glob: redirect.glob, tilde: redirect.tilde !== false })
    }
  })
  state.facts.fileEdit = !input.sensitive && bashFileEdit(input, state.facts, verdicts)
  return state.facts
}

const READ_CLASS = new Set(
  "ls find tree cat head tail sort uniq wc cut paste column tr file stat diff awk strings hexdump od base64 nl grep rg jq sha256sum sha1sum md5sum".split(" "),
)

// A read-class command that the read-only check does not pass still reads what it names, so a read rule or an allow rule
// for the command must not hide it: every word that is not an option (and every word after `--`) is a read operand. `git`
// names paths only in `diff --no-index`. The files that an output option names (`sort -o`, `find -fprint`) are writes,
// and `rg --pre` names a program, so the command cannot be judged from its words.
function operands(state: State, index: number, command: Command, ctx: Context) {
  const name = headName(command.inner[0] ?? "", ctx)
  const words = command.argv.slice(command.argv.length - command.inner.length + 1)
  const found = outputs(name, words)
  if (found.unvalidatable) refuse(state, index, "option")
  found.writes.forEach((item) => word(state, index, "write", item))
  const named = name === "git" ? (words.some((item) => item.value === "diff") && words.some((item) => item.value === "--no-index") ? words.slice(words.findIndex((item) => item.value === "diff") + 1) : []) : READ_CLASS.has(name) ? words : []
  let ended = false
  for (const item of named) {
    if (!ended && item.value === "--") {
      ended = true
      continue
    }
    if (found.skip.has(item)) continue
    if (ended || !item.value.startsWith("-")) word(state, index, "read", item)
  }
}

// Where `git` takes a file or a folder to write, by subcommand.
const GIT_OUTPUTS: Record<string, string[]> = {
  diff: ["--output"],
  log: ["--output"],
  show: ["--output"],
  whatchanged: ["--output"],
  "range-diff": ["--output"],
  "format-patch": ["--output", "--output-directory", "-o"],
  archive: ["--output", "-o"],
}

type Outputs = {
  /** Words that a write option names, in the command's own words or cut out of one (`-ofile`). */
  writes: Word[]
  /** Words of the command that are option values, not operands. */
  skip: Set<Word>
  unvalidatable: boolean
}

function outputs(name: string, words: Word[]): Outputs {
  const found: Outputs = { writes: [], skip: new Set(), unvalidatable: false }
  const cut = (item: Word, value: string): Word => ({ ...item, value, glob: false, tilde: false })
  const write = (value: Word | undefined) => {
    if (!value) return
    found.writes.push(value)
    found.skip.add(value)
  }
  // The value of the option written at `at`: what is fused to it, else the next word.
  const take = (at: number, fused: string) => (fused !== "" ? cut(words[at], fused) : words[at + 1])
  if (name === "sort" || name === "tree") {
    // `-o` and its long spelling write; the other letters take a value that must not be read as an operand. GNU `sort`
    // takes any prefix of `--output`.
    const valued = name === "sort" ? "ktST" : "LPIHT"
    for (let at = 0; at < words.length; at++) {
      const text = words[at].value
      if (text === "--") break
      if (text.startsWith("--")) {
        const equals = text.indexOf("=")
        const long = text.slice(2, equals < 0 ? undefined : equals)
        if (!(name === "sort" ? long !== "" && "output".startsWith(long) : long === "output")) continue
        write(take(at, equals < 0 ? "" : text.slice(equals + 1)))
        if (equals < 0) at++
        continue
      }
      if (!text.startsWith("-") || text === "-") continue
      for (let char = 1; char < text.length; char++) {
        const letter = text[char]
        if (letter !== "o" && !valued.includes(letter)) continue
        const fused = text.slice(char + 1)
        if (letter === "o") write(take(at, fused))
        else if (fused === "" && words[at + 1]) found.skip.add(words[at + 1])
        if (fused === "") at++
        break
      }
    }
  } else if (name === "uniq") {
    // `uniq IN OUT`: the second operand is written.
    const operands: Word[] = []
    for (let at = 0; at < words.length; at++) {
      const text = words[at].value
      if (text === "--") {
        operands.push(...words.slice(at + 1))
        break
      }
      if (!text.startsWith("-") || text === "-") {
        operands.push(words[at])
        continue
      }
      if (text.startsWith("--")) {
        if (!text.includes("=") && ["skip-fields", "skip-chars", "check-chars"].includes(text.slice(2))) found.skip.add(words[++at] ?? words[at - 1])
        continue
      }
      const valued = [...text.slice(1)].findIndex((letter) => "fsw".includes(letter))
      if (valued >= 0 && text.length === valued + 2 && words[at + 1]) found.skip.add(words[++at])
    }
    if (operands[1] && operands[1].value !== "-") write(operands[1])
  } else if (name === "find") {
    for (let at = 0; at < words.length; at++) {
      const text = words[at].value
      if (text === "-fprint" || text === "-fprint0" || text === "-fls") write(words[++at])
      else if (text === "-fprintf") {
        write(words[++at])
        // The format string that follows is not a file.
        if (words[at + 1]) found.skip.add(words[++at])
      }
    }
  } else if (name === "git") {
    // Global options come first. `-C` moves the folder that a relative output is written in (each one relative to the one
    // before), and these take their value as the next word, which is not the verb.
    let folder: Word | undefined
    let verb = -1
    for (let at = 0; at < words.length && verb < 0; at++) {
      const text = words[at].value
      if (text === "-C" && words[at + 1]) {
        const next = words[++at]
        folder =
          folder === undefined || /^(?:[\/~]|[A-Za-z]:)/.test(next.value) || next.tilde
            ? next
            : { ...next, value: `${folder.value}/${next.value}`, literal: folder.literal && next.literal, glob: folder.glob || next.glob }
      } else if (["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path", "--config-env"].includes(text)) at++
      else if (!text.startsWith("-")) verb = at
    }
    // A relative output lies in the folder of the last `-C`; one the shell expands from `~` or that is absolute does not.
    const placed = (item: Word): Word =>
      folder === undefined || item.tilde || /^(?:[\/~]|[A-Za-z]:)/.test(item.value)
        ? item
        : { ...item, value: `${folder.value}/${item.value}`, literal: item.literal && folder.literal, glob: item.glob || folder.glob, tilde: folder.tilde }
    const output = (item: Word | undefined) => {
      if (!item) return
      found.writes.push(placed(item))
      found.skip.add(item)
    }
    const options = GIT_OUTPUTS[words[verb]?.value ?? ""]
    if (verb >= 0 && options)
      for (let at = verb + 1; at < words.length; at++) {
        const text = words[at].value
        if (text === "--") break
        const equals = text.indexOf("=")
        const option = equals < 0 ? text : text.slice(0, equals)
        if (options.includes(option)) output(equals < 0 ? words[++at] : cut(words[at], text.slice(equals + 1)))
        else if (options.includes("-o") && /^-[^-]/.test(text)) {
          // `-o` may sit anywhere in a cluster of short options (`-ko out`); a letter that takes its value from the rest of
          // the cluster (`-U3`, `-Sfoo`) ends the search.
          for (let char = 1; char < text.length; char++) {
            if (text[char] === "o") {
              output(text.length > char + 1 ? cut(words[at], text.slice(char + 1)) : words[++at])
              break
            }
            if ("UvMCBlSGO".includes(text[char])) break
          }
        }
      }
  } else if (name === "rg") {
    // `--pre` and `--hostname-bin` run the program they name, which is no file to read.
    words.forEach((item, at) => {
      const option = item.value.split("=", 1)[0]
      if (option !== "--pre" && option !== "--hostname-bin") return
      found.unvalidatable = true
      if (!item.value.includes("=") && words[at + 1]) found.skip.add(words[at + 1])
    })
  }
  return found
}

function bareVerdict(commands: Command[], command: Command, ctx: Context) {
  const bare = { ...command, redirects: command.redirects.filter((item) => !(item.write && !item.nullSink)) }
  const producer = command.input?.operator === "|" ? commands[command.input.from] : undefined
  return ShellReadOnly.bash(bare, ctx, producer)
}

function headName(raw: string, ctx: Context) {
  if (ctx.platform !== "win32") return raw
  return raw.toLowerCase().replace(/\.exe$/, "")
}

// `cd`, `pushd` and `popd`. A literal target adds a base; anything the text cannot place leaves later relative paths unknown.
function change(state: State, index: number, name: string, words: Word[]) {
  const ctx = state.ctx
  if (name === "popd") return void (state.lost = true)
  const targets = words.filter((item, at) => !(at < 2 && (item.value === "--" || /^-[LPe@]+$/.test(item.value))))
  const target = targets[0]
  if (!target) {
    // `cd` goes home; `pushd` with nothing swaps the top two folders.
    if (name === "pushd") return void (state.lost = true)
    return place(state, index, { value: "~", literal: true, quoted: false, glob: false, arithmetic: false, tilde: true })
  }
  const text = target.value
  const search = (ctx.env.CDPATH ?? "") !== "" && !/^(?:\.\.?\/|\/)/.test(text) && !text.startsWith("~")
  if (targets.length > 1 || text === "-" || /^[+-]\d+$/.test(text) || !target.literal || target.glob || search) return void (state.lost = true)
  place(state, index, target)
}

function place(state: State, index: number, target: Word) {
  const probe = operand(state, { command: index, role: "read", text: target.value, literal: target.literal, glob: target.glob, tilde: target.tilde })
  if (probe.form !== "literal" || probe.candidates.length === 0) return void (state.lost = true)
  state.bases = [...new Set([...state.bases, ...probe.candidates])]
}

// Mirrors the reference: a command that edits files may be allowed in accept-edits mode when it is one of a few plain
// programs, run directly (no wrapper, no environment prefix), and every other command is read-only.
function bashFileEdit(input: BashInput, facts: Facts, verdicts: ShellReadOnly.Verdict[]) {
  if (input.commands.length === 0 || facts.unvalidatable.length > 0 || facts.directoryChanges > 0) return false
  if (facts.files.some((item) => item.role !== "read" && (item.form !== "literal" || item.flags.length > 0))) return false
  return input.commands.every((command, index) => {
    const direct = command.inner.length === command.argv.length && command.env.length === 0 && !command.wrapper
    // A program in the working folder (a relative PATH entry, or a local file of that name) is not the system's `rm`.
    if (
      direct &&
      ["mkdir", "touch", "rm", "rmdir", "mv", "cp"].includes(headName(command.argv[0]?.value ?? "", input.ctx)) &&
      !ShellReadOnly.projectLocal(command.argv[0].value, input.ctx)
    )
      return true
    return verdicts[index].ok
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// PowerShell, from the summary of its own parser

type Param = {
  name: string
  names: string[]
  kind: "path" | "leaf" | "sibling" | "switch" | "value"
  role?: Role | "chdir"
}
type Compiled = { entry: Entry; params: Param[]; positional: string[] }

const COMMON_SWITCHES = "Verbose|vb Debug|db WhatIf|wi Confirm|cf UseTransaction|usetx"
const COMMON_VALUES =
  "ErrorAction|ea WarningAction|wa InformationAction|infa ErrorVariable|ev WarningVariable|wv InformationVariable|iv OutVariable|ov OutBuffer|ob PipelineVariable|pv ProgressAction|proga"

function names(text: string) {
  return text.split(" ").filter(Boolean)
}

function group(spelling: string, kind: Param["kind"], role?: Param["role"]): Param {
  const all = spelling.split("|")
  return { name: all[0].toLowerCase(), names: all.map((item) => item.toLowerCase()), kind, ...(role ? { role } : {}) }
}

const compiled = new Map<string, Compiled>()

function compile(cmdlet: string): Compiled | undefined {
  const known = compiled.get(cmdlet)
  if (known) return known
  const entry = CMDLETS[cmdlet]
  if (!entry) return undefined
  const params = [
    ...entry.paths.map((item) => {
      const at = item.lastIndexOf(" ")
      return group(item.slice(0, at), "path", item.slice(at + 1) as Role | "chdir")
    }),
    ...(entry.leaf ?? []).map((item) => group(item, "leaf")),
    ...(entry.sibling ?? []).map((item) => group(item, "sibling")),
    ...names(`${entry.switches} ${COMMON_SWITCHES}`).map((item) => group(item, "switch")),
    ...names(`${entry.values} ${COMMON_VALUES}`).map((item) => group(item, "value")),
  ]
  const result = { entry, params, positional: entry.positional.map((item) => item.toLowerCase()) }
  compiled.set(cmdlet, result)
  return result
}

// A parameter name matches an exact name or alias first, then a prefix that fits exactly one parameter. A prefix that
// fits two is ambiguous: PowerShell would refuse the command, and so does this.
function lookup(table: Compiled, written: string): Param | "unknown" | "ambiguous" {
  const lower = written.toLowerCase()
  const exact = table.params.find((item) => item.names.includes(lower))
  if (exact) return exact
  const prefixed = table.params.filter((item) => item.names.some((candidate) => candidate.startsWith(lower)))
  if (prefixed.length === 1) return prefixed[0]
  return prefixed.length === 0 ? "unknown" : "ambiguous"
}

const LOCATION = new Set(["set-location", "push-location", "pop-location", "new-psdrive"])
const NATIVE = new Set([...Object.keys(SPECS), "sed", "md"])
const LINK_FREE = new Set(["file", "directory"])
const CONSTANT = new Set(["StringConstantExpressionAst", "ConstantExpressionAst"])
const EDITS = new Set(["set-content", "add-content", "remove-item", "clear-content"])

export type PowerShellInput = {
  commands: Command[]
  ctx: Context
  summary: PowerShellParse.Summary
  /** The analysis index of each parser command. */
  index: Map<PowerShellParse.Command, number>
  reads: string[][]
}

type Value = { text: string; literal: boolean; escape?: boolean }

export function powershell(input: PowerShellInput): Facts {
  const state = start(input.ctx, true, false)
  const ctx = input.ctx
  const fed = fedByExpression(input.summary)
  input.commands.forEach((command, index) => {
    state.facts.scopes[index] = { bases: [...state.bases], lost: state.lost }
    reads(state, index, input.reads[index] ?? [])
    const source = command.source
    if (!source || source.placeholder) return
    const head = ctx.platform === "win32" && command.head === "mkdir" ? "new-item" : command.head
    const table = compile(head)
    if (LOCATION.has(head)) state.facts.directoryChanges++
    if (!table) {
      if (NATIVE.has(head) && !(ctx.platform === "win32" && head === "md")) refuse(state, index, "native")
      return
    }
    bind(state, table, head, command, source, index, fed.has(source))
  })
  if (input.commands.length <= 1) state.facts.directoryChanges = 0
  redirects(state, input)
  state.facts.fileEdit = powershellFileEdit(input, state.facts)
  return state.facts
}

// A command that follows a pipeline element that is not a command: the piped value binds to a path parameter.
function fedByExpression(summary: PowerShellParse.Summary) {
  const fed = new Set<PowerShellParse.Command>()
  for (const statement of summary.statements) {
    let expression = false
    for (const element of statement.elements) {
      if (element.kind === "command") {
        if (expression) fed.add(element.command)
      } else expression = true
    }
  }
  return fed
}

function constant(argument: PowerShellParse.Argument): Value | undefined {
  return CONSTANT.has(argument.kind) && argument.value !== undefined ? { text: argument.value, literal: true, escape: argument.text.includes("`") } : undefined
}

function bind(state: State, table: Compiled, head: string, command: Command, source: PowerShellParse.Command, index: number, piped: boolean) {
  const given = new Set<string>()
  const bare: PowerShellParse.Argument[] = []
  const found: { role: Role | "chdir"; value: Value }[] = []
  const leaves: Value[] = []
  const siblings: Value[] = []
  let link = false
  let stream = false
  const bad = (reason: Reason) => refuse(state, index, reason)
  const take = (param: Param, argument: PowerShellParse.Argument, value: PowerShellParse.Argument | undefined) => {
    // The value of `-Name:value` is the parameter's bound expression; otherwise it is the argument after it.
    const known = argument.bound ? (CONSTANT.has(argument.bound.kind) && argument.bound.value !== undefined ? { text: argument.bound.value, literal: true, escape: argument.bound.text.includes("`") } : undefined) : value && constant(value)
    const raw = argument.bound ? argument.bound.text : value?.text ?? ""
    if (param.name === "stream") stream = true
    if (param.kind === "path" || param.kind === "leaf" || param.kind === "sibling") {
      // An array makes the paths unvalidatable; its constant elements are still reported for deny rules.
      if (!argument.bound && value?.kind === "ArrayLiteralAst") {
        bad("array")
        for (const element of value.elements ?? [])
          if (param.kind === "path" && element.value !== undefined) found.push({ role: param.role!, value: { text: element.value, literal: true } })
        return
      }
      if (!known) {
        bad("dynamic")
        if (param.kind === "path") found.push({ role: param.role!, value: { text: raw, literal: false } })
        return
      }
      if (param.kind === "path") found.push({ role: param.role!, value: known })
      else if (/[\\/]/.test(known.text) || known.text === "." || known.text === "..") bad("leaf")
      else (param.kind === "leaf" ? leaves : siblings).push(known)
      return
    }
    // A value parameter: consumed, and not a path. A value that is not a constant leaves the command unvalidatable.
    if (!known) return bad("dynamic")
    if (param.name === "itemtype" && !LINK_FREE.has(known.text.toLowerCase())) link = true
  }

  for (let at = 0; at < source.arguments.length; at++) {
    const argument = source.arguments[at]
    if (argument.kind !== "CommandParameterAst") {
      bare.push(argument)
      continue
    }
    const param = lookup(table, argument.parameter ?? "")
    if (param === "unknown" || param === "ambiguous") {
      bad("parameter")
      // A colon-bound value of an unknown parameter is still reported, so a deny rule can match it.
      if (argument.bound?.value !== undefined && CONSTANT.has(argument.bound.kind)) found.push({ role: "write", value: { text: argument.bound.value, literal: true } })
      continue
    }
    given.add(param.name)
    if (param.kind === "switch") continue
    if (argument.bound) {
      take(param, argument, undefined)
      continue
    }
    const next = source.arguments[at + 1]
    if (!next || next.kind === "CommandParameterAst") {
      bad("parameter")
      continue
    }
    at++
    take(param, argument, next)
  }

  // Bare arguments bind to the cmdlet's positional parameters in order, skipping any that were given by name.
  // A named -LiteralPath fills the place that the first bare argument would take, so that argument binds to the next one.
  const filled = [...given].some((name) => table.params.find((item) => item.name === name)?.names.some((alias) => alias === "literalpath" || alias === "pspath"))
  const slots = table.positional.filter((item) => !given.has(item) && !(filled && (item === "path" || item === "filepath")))
  bare.forEach((argument, at) => {
    const slot = slots[at]
    const param = slot === undefined ? undefined : table.params.find((item) => item.name === slot)
    if (!param) return bad("positional")
    take(param, { kind: "CommandParameterAst", text: "", parameter: param.name }, argument)
  })

  const paths = found.filter((item) => item.role !== "chdir")
  for (const item of paths) {
    const made = add(state, { command: index, role: item.role as Role, text: item.value.text, literal: item.value.literal, flags: item.value.escape ? ["escape"] : [] })
    if (stream) made.flags.push("stream")
  }
  // A new name is reported as given and joined with each path that it is created in.
  const parents = paths.filter((item) => item.value.literal && item.role === "create").map((item) => item.value.text)
  for (const leaf of leaves) {
    add(state, { command: index, role: "create", text: leaf.text, literal: true })
    for (const parent of parents) add(state, { command: index, role: "create", text: join(parent, leaf.text), literal: true })
  }
  // Rename-Item keeps the item in its folder: the new name sits next to the old path.
  for (const name of siblings)
    for (const old of paths.filter((item) => item.value.literal)) add(state, { command: index, role: "write", text: sibling(old.value.text, name.text), literal: true })
  if (link) state.facts.links = true

  if (piped) bad("pipeline")
  const writes = table.entry.paths.some((item) => !item.endsWith(" chdir"))
  const wrote = state.facts.files.some((item) => item.command === index && item.via === "argument" && item.role !== "read")
  if (writes && !wrote && !table.entry.onlyWithPath && !piped) bad("no-path")
  if (head === "new-psdrive") state.drives = true
  if (LOCATION.has(head)) target(state, index, head, found.filter((item) => item.role === "chdir").map((item) => item.value), given.has("stackname"))
}

function join(parent: string, name: string) {
  return /[\\/]$/.test(parent) ? parent + name : `${parent}/${name}`
}

function sibling(old: string, name: string) {
  const cut = Math.max(old.lastIndexOf("/"), old.lastIndexOf("\\"))
  return cut < 0 ? name : old.slice(0, cut + 1) + name
}

// Set-Location and Push-Location with a constant target add a base; everything else leaves later paths unknown.
function target(state: State, index: number, head: string, values: Value[], stack: boolean) {
  const only = values.length === 1 ? values[0] : undefined
  if (head === "pop-location" || head === "new-psdrive" || stack || !only || !only.literal || only.text === "-" || only.text === "+")
    return void (state.lost = true)
  const probe = operand(state, { command: index, role: "read", text: only.text, literal: true })
  if (probe.form !== "literal" || probe.candidates.length === 0) return void (state.lost = true)
  state.bases = [...new Set([...state.bases, ...probe.candidates])]
}

function redirects(state: State, input: PowerShellInput) {
  const seen = new Set<string>()
  const each = (item: PowerShellParse.Redirect, command: number) => {
    if (item.kind !== "file" || item.nullSink) return
    const key = `${item.operator}\u0000${item.target ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    if (item.value !== undefined && state.ctx.platform !== "win32" && ShellReadOnly.nullSink(item.value)) return
    add(state, { command, role: "write", via: "redirect", text: item.value ?? item.target ?? "", literal: item.value !== undefined && !item.target?.includes("`"), flags: item.target?.includes("`") ? ["escape"] : [] })
  }
  input.commands.forEach((command, index) => command.source?.redirects.forEach((item) => each(item, index)))
  for (const statement of input.summary.statements) {
    const first = statement.elements[0] ? (input.index.get(statement.elements[0].command) ?? 0) : 0
    statement.redirects.forEach((item) => each(item, first))
  }
}

// Mirrors the reference: only a plain pipeline of commands, each a content edit or a harmless output step, with no
// redirect to a file and nothing that moves the working folder or creates a link.
function powershellFileEdit(input: PowerShellInput, facts: Facts) {
  const commands = input.commands
  const summary = input.summary
  if (commands.length === 0 || facts.unvalidatable.length > 0 || facts.directoryChanges > 0) return false
  if (facts.links && commands.length > 1) return false
  if (facts.files.some((item) => item.role !== "read" && (item.form !== "literal" || item.flags.length > 0))) return false
  if (summary.stopParsing) return false
  const top = summary.statements.filter((statement) => statement.top)
  if (top.length === 0 || !top.every((statement) => statement.kind === "PipelineAst" && statement.elements.every((element) => element.kind === "command"))) return false
  if (summary.statements.some((statement) => statement.scriptBlock || statement.subexpression || statement.expandable || statement.memberAccess || statement.assignment)) return false
  if (summary.statements.some((statement) => statement.redirects.some((item) => item.kind === "file" && !item.nullSink))) return false
  if (summary.commands.some((item) => item.nested)) return false
  return commands.every((command) => {
    if (command.application || command.dynamicHead || command.source?.placeholder) return false
    if (command.source?.redirects.some((item) => item.kind === "file" && !item.nullSink)) return false
    if (!EDITS.has(command.head)) return command.readOnly
    return command.source!.arguments.every((argument) =>
      argument.kind === "CommandParameterAst"
        ? argument.bound === undefined || (CONSTANT.has(argument.bound.kind) && argument.bound.value !== undefined && !/[$(@{[]/.test(argument.bound.text))
        : CONSTANT.has(argument.kind) && argument.value !== undefined,
    )
  })
}
