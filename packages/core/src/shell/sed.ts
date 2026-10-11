export * as SedScript from "./sed.js"

import { Duration, Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import os from "node:os"
import type { ShellAnalysis } from "./analysis.js"

// A tokenizer for the sed scripts that Orbit can reason about. It never throws and it never runs a regular expression
// over the script, so its time is linear. Every refusal is a fixed reason code and never script text: the script comes
// from a model or a repository and reaches a person only through a verdict (class 9).

export type Address = { kind: "line"; line: number } | { kind: "last" } | { kind: "regex"; source: string }
export type Command =
  | { name: "p" | "d" | "q" | "=" | "l" | "n"; addresses: Address[] }
  | { name: "s"; addresses: Address[]; delimiter: string; pattern: string; replacement: string; flags: string }
  | { name: "y"; addresses: Address[]; delimiter: string; source: string; target: string }
export type Result = { ok: true; commands: Command[] } | { ok: false; reason: string }

const SIMPLE = new Set(["p", "d", "q", "=", "l", "n"])
// Commands that write a file, run a program, read a file, or that this grammar does not model.
const OTHER = new Set(["w", "W", "e", "r", "R", "a", "i", "c", "b", "t", "T", ":", "h", "H", "g", "G", "x", "D", "N", "P", "F", "z", "v", "Q", "L"])

/** Parses `script` into commands, or says why it cannot. */
export function parse(script: string): Result {
  if (script.includes("\n")) return fail("sed:newline")
  for (const char of script) if (char !== "\t" && (char < " " || char > "~")) return fail("sed:non-ascii")
  const commands: Command[] = []
  let index = 0
  const blanks = () => {
    while (script[index] === " " || script[index] === "\t") index++
  }
  // Reads up to the next unescaped `delimiter` and returns the text between, or undefined when there is none.
  const until = (delimiter: string) => {
    const start = index
    while (index < script.length) {
      const char = script[index]
      if (char === "\\") index += 2
      else if (char === delimiter) return script.slice(start, index++)
      else index++
    }
    return undefined
  }
  while (true) {
    blanks()
    if (index >= script.length) return fail("sed:syntax")
    const addresses: Address[] = []
    const first = address()
    if (first === "bad") return fail("sed:address")
    if (first === "open") return fail("sed:syntax")
    if (first) {
      addresses.push(first)
      blanks()
      if (script[index] === ",") {
        index++
        blanks()
        const second = address()
        if (second === "bad") return fail("sed:address")
        if (second === undefined || second === "open") return fail("sed:syntax")
        addresses.push(second)
      }
      blanks()
    }
    if (script[index] === "!") return fail("sed:negation")
    const name = script[index++]
    if (name === undefined) return fail("sed:syntax")
    if (name === "{" || name === "}") return fail("sed:block")
    if (name === "#") return fail("sed:comment")
    if (SIMPLE.has(name)) {
      if (name === "q" && addresses.length > 1) return fail("sed:address")
      commands.push({ name: name as "p", addresses })
    } else if (name === "s") {
      const delimiter = script[index++]
      if (delimiter === undefined || delimiter === "\\") return fail("sed:syntax")
      const pattern = until(delimiter)
      const replacement = pattern === undefined ? undefined : until(delimiter)
      if (pattern === undefined || replacement === undefined) return fail("sed:syntax")
      const flags = readFlags()
      if (typeof flags !== "string") return flags
      commands.push({ name: "s", addresses, delimiter, pattern, replacement, flags })
    } else if (name === "y") {
      const delimiter = script[index++]
      if (delimiter === undefined || delimiter === "\\") return fail("sed:syntax")
      const source = until(delimiter)
      const target = source === undefined ? undefined : until(delimiter)
      if (source === undefined || target === undefined) return fail("sed:syntax")
      commands.push({ name: "y", addresses, delimiter, source, target })
    } else return fail(OTHER.has(name) ? "sed:command" : "sed:syntax")
    // After a command: blanks, then `;` or the end. Anything else is text this grammar has no place for.
    blanks()
    if (index >= script.length) return { ok: true, commands }
    const next = script[index++]
    if (next === "}") return fail("sed:block")
    if (next === "#") return fail("sed:comment")
    if (next !== ";") return fail("sed:syntax")
  }

  function address(): Address | "bad" | "open" | undefined {
    const char = script[index]
    if (char === "$") {
      index++
      return { kind: "last" }
    }
    if (char >= "0" && char <= "9") {
      const start = index
      while (script[index] >= "0" && script[index] <= "9") index++
      const line = Number(script.slice(start, index))
      // `0` and `first~step` are GNU extensions this grammar leaves out.
      if (line === 0 || script[index] === "~") return "bad"
      return { kind: "line", line }
    }
    if (char === "/") {
      index++
      const source = until("/")
      if (source === undefined) return "open"
      // `/re/I` and `/re/M` are regex flags.
      if (script[index] === "I" || script[index] === "M") return "bad"
      return { kind: "regex", source }
    }
    // `\cREc` names its own delimiter; `addr,+N` and `addr,~N` are offsets.
    if (char === "\\" || char === "+" || char === "~") return "bad"
    return undefined
  }

  function readFlags(): string | Result {
    const start = index
    let numbered = false
    const seen = new Set<string>()
    while (index < script.length) {
      const char = script[index]
      if (char >= "0" && char <= "9") {
        if (numbered || char === "0") return fail("sed:flag")
        numbered = true
        while (script[index] >= "0" && script[index] <= "9") index++
        continue
      }
      if (char === " " || char === "\t" || char === ";" || char === "}" || char === "#") break
      const key = char.toLowerCase()
      // w and e write a file or run a program. Any other letter, or a repeat, is not a flag this grammar knows.
      if (!"gipm".includes(key) || seen.has(key)) return fail("sed:flag")
      seen.add(key)
      index++
    }
    return script.slice(start, index)
  }
}

function fail(reason: string): Result {
  return { ok: false, reason }
}

// ---------------------------------------------------------------------------------------------------------------------
// The in-place emulator. `plan` decides whether a command is an edit Orbit can compute itself, `apply` computes one file's
// new text, and `flavor` says which sed the shell would have started. A refusal is a value, never an error: the command
// then goes through the ordinary shell permission path and real sed runs if it is allowed. Reasons are fixed codes and
// never carry script or file text (class 9).
// ---------------------------------------------------------------------------------------------------------------------

export type Flavor = "gnu" | "bsd" | "unknown"

/** A compiled pattern. Plain data, so an Edit can be sent to a Worker. The RegExp is built from it in `apply`. */
export type Matcher = {
  source: string
  ignoreCase: boolean
  groups: number
  /** Uses a construct whose meaning depends on the locale, so `apply` accepts ASCII text only. */
  ascii: boolean
  /** Quantifiers with no upper bound: the cost of a match grows with them. */
  unbounded: number
}
export type Located =
  | { kind: "line"; line: number }
  | { kind: "last" }
  | { kind: "regex"; matcher: Matcher }
  | { kind: "range"; from: number; to: number | "last" }
// A replacement is literal text, or the whole match (0) or a group (1 to 9).
export type Part = string | number
export type Step =
  | { name: "d"; address?: Located }
  | { name: "s"; address?: Located; matcher: Matcher; parts: Part[]; from: number; only: boolean }
export type Edit = { files: string[]; extended: boolean; commands: Step[] }
export type Planned = { ok: true; edit: Edit } | { ok: false; reason: string }
export type Applied = { ok: true; text: string } | { ok: false; reason: string }

/** The most text `apply` takes in one file. */
export const MAX_TEXT = 1_048_576
/** A line longer than this is refused when a pattern has an unbounded quantifier: the match is quadratic in the line. */
const MAX_LINE = 10_000
/** A line longer than this is refused when a pattern has two: the match is cubic in the line. */
const MAX_LINE_STACKED = 1000
const DUP_MAX = 32_767
// Delimiters that mean nothing in a regular expression or a replacement, so `\<delimiter>` is that character.
const PLAIN_DELIMITERS = '/#,:@!%_;=~"-'
const SYNTAX = "\\^$.*+?()[]{}|/"
const WORD = "A-Za-z0-9_"
const SPACE = " \\t\\n\\v\\f\\r"
const CLASSES: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: SPACE,
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
}

/** Decides whether `analysis` is one in-place sed command that `apply` can compute. */
export function plan(analysis: ShellAnalysis.Analysis, flavor: Flavor): Planned {
  if (flavor === "unknown") return refuse("flavor")
  const command = analysis.commands[0]
  if (
    analysis.dialect !== "bash" ||
    analysis.opaque ||
    analysis.commands.length !== 1 ||
    analysis.statements.length !== 1 ||
    analysis.statements[0].commands.length !== 1 ||
    analysis.redirects.length > 0 ||
    Object.values(analysis.features).some(Boolean) ||
    command.origin !== "top" ||
    command.negated ||
    command.input ||
    command.piped ||
    command.wrapper ||
    command.dynamicHead ||
    command.env.length > 0 ||
    command.redirects.length > 0 ||
    // The probe describes the `sed` on the shell's PATH: a wrapper or a path names some other program.
    command.inner.length !== command.argv.length ||
    command.argv[0].value !== "sed"
  )
    return refuse("shape")
  if (command.argv.some((word) => !word.literal || word.glob || word.tilde || word.escaped || word.arithmetic || word.equalsTilde)) return refuse("operand")
  const options = readOptions(
    command.argv.slice(1).map((word) => word.value),
    flavor,
  )
  if (typeof options === "string") return refuse(options)
  const scripts = options.scripts.length > 0 ? options.scripts : options.operands.slice(0, 1)
  const files = options.scripts.length > 0 ? options.operands : options.operands.slice(1)
  if (scripts.length === 0 || files.length === 0) return refuse("operand")
  if (files.some((file) => file === "" || file === "-") || new Set(files).size !== files.length) return refuse("operand")
  const commands: Step[] = []
  for (const script of scripts) {
    const parsed = parse(script)
    if (!parsed.ok) return refuse(parsed.reason.slice("sed:".length))
    for (const item of parsed.commands) {
      const step = compileStep(item, options.extended, flavor)
      if (typeof step === "string") return refuse(step)
      commands.push(step)
    }
  }
  return { ok: true, edit: { files, extended: options.extended, commands } }
}

/** The new text of one file, or the reason `plan`'s edit cannot be computed for it. Lines and ranges start fresh here. */
export function apply(text: string, edit: Edit): Applied {
  if (text.length > MAX_TEXT) return refuse("limit")
  const matchers = edit.commands
    .flatMap((step) => [step.address?.kind === "regex" ? step.address.matcher : undefined, step.name === "s" ? step.matcher : undefined])
    .filter((item) => item !== undefined)
  // A leading byte order mark is part of line 1 (it is never stripped), but it does not make the text non-ASCII.
  if (matchers.some((matcher) => matcher.ascii) && /[^\x00-\x7f]/.test(text.startsWith("\uFEFF") ? text.slice(1) : text)) return refuse("content")
  const lines = split(text)
  const longest = lines.reduce((size, line) => Math.max(size, line.text.length), 0)
  if (matchers.some((matcher) => (matcher.unbounded >= 1 && longest > MAX_LINE) || (matcher.unbounded >= 2 && longest > MAX_LINE_STACKED))) return refuse("limit")
  const compiled = edit.commands.map((step) => ({
    step,
    address: step.address?.kind === "regex" ? compile(step.address.matcher, "") : undefined,
    regex: step.name === "s" ? compile(step.matcher, "g") : undefined,
  }))
  const out: string[] = []
  let size = 0
  for (const [index, line] of lines.entries()) {
    const number = index + 1
    let space = line.text
    let deleted = false
    for (const item of compiled) {
      if (!selected(item.step.address, item.address, number, number === lines.length, space)) continue
      if (item.step.name === "d") {
        deleted = true
        break
      }
      const next = substitute(space, item.step, item.regex!)
      if (next === undefined) return refuse("content")
      space = next
      if (space.length > MAX_TEXT * 4) return refuse("limit")
    }
    if (deleted) continue
    // A newline a replacement inserted into a CRLF line is written as CRLF too.
    out.push(line.crlf ? space.replaceAll("\n", "\r\n") : space, line.end)
    size += space.length
    if (size > MAX_TEXT * 4) return refuse("limit")
  }
  return { ok: true, text: out.join("") }
}

/** Reads `sed --version`: GNU when it says so, BSD on macOS otherwise, and unknown anywhere else (no emulation). */
export function classify(output: { stdout: string; code: number | null }, platform: NodeJS.Platform): Flavor {
  // The MSYS runtime prints the path the program was started by (`/usr/bin/sed (GNU sed) 4.9`), so a folder prefix counts.
  if (output.code === 0 && /^(?:\S*[\\/])?sed \(GNU sed\)/.test(output.stdout.split("\n", 1)[0])) return "gnu"
  return platform === "darwin" ? "bsd" : "unknown"
}

const flavors = new Map<string, Flavor>()
const PROBE_TIMEOUT = Duration.seconds(3)

/**
 * Which sed `shell` starts for a bare `sed`. The probe runs the shell with a fixed script in the system temp folder, never
 * the project, so a relative PATH entry cannot reach a planted program (class 10). It runs once per shell and PATH, the
 * first time a command asks. A timeout or a failure to start is `classify` of no output and is not remembered.
 */
export const flavor = Effect.fn("SedScript.flavor")(function* (shell: string, env: Record<string, string | undefined>) {
  const key = `${shell}\0${Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? ""}`
  const known = flavors.get(key)
  if (known) return known
  const spawner = yield* ChildProcessSpawner
  const output = yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(shell, ["-c", "sed --version"], {
        cwd: os.tmpdir(),
        stdin: "ignore",
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        extendEnv: false,
      }),
    )
    const [stdout, , code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.take(8), Stream.decodeText(), Stream.mkString), handle.stderr.pipe(Stream.runDrain), handle.exitCode],
      { concurrency: "unbounded" },
    )
    return { stdout: stdout.slice(0, 1024), code: Number(code) as number | null }
  }).pipe(
    Effect.scoped,
    Effect.timeout(PROBE_TIMEOUT),
    // A timeout or a failure to start (a defect while starting included) is no output.
    Effect.catchCause(() => Effect.succeed({ stdout: "", code: null as number | null })),
  )
  const result = classify(output, process.platform)
  if (output.code !== null) flavors.set(key, result)
  return result
})

function refuse(reason: string) {
  return { ok: false as const, reason: `sed-edit:${reason}` }
}

function readOptions(words: string[], flavor: Flavor) {
  let extended = false
  let inPlace = false
  let ended = false
  const scripts: string[] = []
  const operands: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (ended || word === "-" || !word.startsWith("-")) {
      operands.push(word)
      continue
    }
    // GNU permutes its arguments and BSD does not, so an option after an operand is refused for both.
    if (operands.length > 0) return "option"
    if (word === "--") ended = true
    else if (word === "-e" || (flavor === "gnu" && word === "--expression")) {
      const script = words[++index]
      if (script === undefined) return "option"
      scripts.push(script)
    } else if (flavor === "gnu" && word.startsWith("--expression=")) scripts.push(word.slice("--expression=".length))
    else if (flavor === "gnu" && word === "--in-place") inPlace = true
    else if (flavor === "gnu" && (word === "--regexp-extended" || word === "--separate")) extended ||= word === "--regexp-extended"
    // GNU reads every character after `i` as the backup suffix, so `-ie` is the suffix `e`.
    else if (flavor === "gnu" && (/^-[Ers]*i.+$/.test(word) || word.startsWith("--in-place="))) return "backup"
    else if (flavor === "gnu" && /^-[Ers]*i$/.test(word)) {
      inPlace = true
      extended ||= /[Er]/.test(word)
    } else if (flavor === "gnu" && /^-[Ers]+$/.test(word)) extended ||= /[Er]/.test(word)
    else if (flavor === "bsd" && /^-[Er]*i$/.test(word)) {
      // BSD's -i takes the next word as the backup suffix. Only an empty one means no backup.
      if (words[++index] !== "") return "backup"
      inPlace = true
      extended ||= /[Er]/.test(word)
    } else if (flavor === "bsd" && /^-[Er]+$/.test(word)) extended = true
    else return "option"
  }
  if (!inPlace) return "option"
  return { extended, scripts, operands }
}

function compileStep(item: Command, extended: boolean, flavor: Flavor): Step | string {
  if (item.name !== "s" && item.name !== "d") return "command"
  const address = locate(item.addresses, extended, flavor)
  if (typeof address === "string") return address
  const located = address ? { address } : {}
  if (item.name === "d") return { name: "d", ...located }
  if (item.name !== "s") return "command"
  // The tokenizer already refused `w` and `e`; `p` would write into the file and `m` changes what `^` and `$` mean.
  const digits = item.flags.replace(/\D/g, "")
  if (/[pmM]/.test(item.flags) || digits.length > 9) return "flag"
  const matcher = translate(item.pattern, item.delimiter, extended, flavor, /[Ii]/.test(item.flags))
  if (typeof matcher === "string") return matcher
  const parts = replacement(item.replacement, item.delimiter, matcher.groups, flavor)
  if (typeof parts === "string") return parts
  return { name: "s", ...located, matcher, parts, from: digits === "" ? 1 : Number(digits), only: !item.flags.includes("g") }
}

function locate(addresses: Address[], extended: boolean, flavor: Flavor): Located | undefined | string {
  const [first, second] = addresses
  if (first === undefined) return undefined
  if (second === undefined) {
    if (first.kind === "line") return { kind: "line", line: first.line }
    if (first.kind === "last") return { kind: "last" }
    const matcher = translate(first.source, "/", extended, flavor, false)
    return typeof matcher === "string" ? matcher : { kind: "regex", matcher }
  }
  if (first.kind !== "line" || second.kind === "regex") return "address"
  if (second.kind === "last") return { kind: "range", from: first.line, to: "last" }
  // A range that ends at or before its start covers only its first line.
  return second.line > first.line ? { kind: "range", from: first.line, to: second.line } : { kind: "line", line: first.line }
}

type Atom = "start" | "open" | "atom" | "group" | "anchor" | "quantifier" | "boundary"

// Translates a POSIX pattern (basic, or extended with -E) into the source of a JavaScript RegExp that finds the same
// matches as GNU sed. What the translation cannot promise to match, it refuses: the accepted patterns have only
// single-character atoms under a quantifier, so JavaScript's first match is the leftmost-longest one.
function translate(pattern: string, delimiter: string, extended: boolean, flavor: Flavor, ignoreCase: boolean): Matcher | string {
  if (pattern === "") return "regex"
  const gnu = flavor === "gnu"
  const plainDelimiter = PLAIN_DELIMITERS.includes(delimiter) || (!extended && delimiter === "|")
  let source = ""
  let groups = 0
  let depth = 0
  let unbounded = 0
  let ascii = ignoreCase
  let prev = "start" as Atom
  let index = 0
  const literal = (char: string) => {
    source += SYNTAX.includes(char) ? `\\${char}` : char
    prev = "atom"
  }
  // Only a single-character atom takes a quantifier.
  const quantify = (text: string, open: boolean) => {
    if (prev !== "atom") return false
    source += text
    unbounded += open ? 1 : 0
    prev = "quantifier"
    return true
  }
  const group = () => {
    source += "("
    groups++
    depth++
    prev = "open"
  }
  const ungroup = () => {
    if (depth === 0) return false
    source += ")"
    depth--
    prev = "group"
    return true
  }
  while (index < pattern.length) {
    const char = pattern[index++]
    if (char === "\\") {
      const next = pattern[index++]
      if (next === undefined) return "regex"
      if (next === delimiter) {
        if (!plainDelimiter) return "delimiter"
        literal(next)
      } else if (!extended && next === "(") group()
      else if (!extended && next === ")") {
        if (!ungroup()) return "regex"
      } else if (!extended && next === "{") {
        const interval = readInterval(pattern, index, "\\}")
        if (!interval || !quantify(interval.text, interval.open)) return "regex"
        index = interval.next
      } else if (!extended && (next === "+" || next === "?")) {
        if (!gnu || !quantify(next, next === "+")) return "regex"
      } else if (extended && "+?(){}".includes(next)) literal(next)
      else if (next === "w" || next === "W" || next === "s" || next === "S") {
        if (!gnu) return "regex"
        source += `[${next === "w" || next === "s" ? "" : "^"}${next === "w" || next === "W" ? WORD : SPACE}]`
        ascii = true
        prev = "atom"
      } else if (next === "b" || next === "B") {
        if (!gnu) return "regex"
        source += `\\${next}`
        ascii = true
        prev = "boundary"
      } else if (next === "<" || next === ">") {
        if (!gnu) return "regex"
        source += next === "<" ? `(?<![${WORD}])(?=[${WORD}])` : `(?<=[${WORD}])(?![${WORD}])`
        ascii = true
        prev = "boundary"
      } else if (next === "`" || next === "'") {
        if (!gnu) return "regex"
        source += next === "`" ? "^" : "$"
        prev = "anchor"
      } else if ("\\^$.*[]/".includes(next)) literal(next)
      else return "regex"
      continue
    }
    if (char === "[") {
      const set = bracket(pattern, index)
      if (typeof set === "string") return set
      source += set.source
      ascii ||= set.ascii
      index = set.next
      prev = "atom"
      continue
    }
    if (char === ".") {
      source += "."
      prev = "atom"
      continue
    }
    if (char === "*") {
      if (!quantify("*", true)) return "regex"
      continue
    }
    if (char === "^") {
      if (extended || prev === "start" || prev === "open") {
        source += "^"
        prev = "anchor"
      } else literal(char)
      continue
    }
    if (char === "$") {
      if (extended || index === pattern.length || pattern.startsWith("\\)", index)) {
        source += "$"
        prev = "anchor"
      } else literal(char)
      continue
    }
    if (!extended) {
      literal(char)
      continue
    }
    if (char === "(") group()
    else if (char === ")") {
      if (!ungroup()) return "regex"
    } else if (char === "+" || char === "?") {
      if (!quantify(char, char === "+")) return "regex"
    } else if (char === "{") {
      const interval = readInterval(pattern, index, "}")
      if (!interval || !quantify(interval.text, interval.open)) return "regex"
      index = interval.next
    } else if (char === "|" || char === "}") return "regex"
    else literal(char)
  }
  if (depth !== 0) return "regex"
  const matcher = { source, ignoreCase, groups, ascii, unbounded }
  return compiles(matcher) ? matcher : "regex"
}

// `{m}`, `{m,}` or `{m,n}` with the closing text of the syntax, starting right after the opening brace.
function readInterval(pattern: string, start: number, closing: string) {
  const found = /^(\d+)(?:(,)(\d*))?/.exec(pattern.slice(start, start + 24))
  if (!found || !pattern.startsWith(closing, start + found[0].length)) return undefined
  const min = Number(found[1])
  const max = found[2] === undefined ? min : found[3] === "" ? undefined : Number(found[3])
  if (min > DUP_MAX || (max !== undefined && (max > DUP_MAX || max < min))) return undefined
  return {
    text: found[2] === undefined ? `{${min}}` : max === undefined ? `{${min},}` : `{${min},${max}}`,
    open: max === undefined,
    next: start + found[0].length + closing.length,
  }
}

// A bracket expression whose `[` was just read. Only ASCII sets, ranges and the POSIX classes; every escape is refused.
function bracket(pattern: string, start: number): { source: string; next: number; ascii: boolean } | string {
  let index = start
  const negated = pattern[index] === "^"
  if (negated) index++
  const first = index
  const items: string[] = []
  let ascii = false
  let last: "none" | "char" | "range" | "class" = "none"
  let low = ""
  const escape = (char: string) => (char === "\\" || char === "^" || char === "-" || char === "]" || char === "[" ? `\\${char}` : char)
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === "]" && index > first) return { source: `[${negated ? "^" : ""}${items.join("")}]`, next: index + 1, ascii }
    if (char === "\\") return "regex"
    if (char === "[" && ":=.".includes(pattern[index + 1] ?? "x")) {
      const close = pattern.indexOf(`${pattern[index + 1]}]`, index + 2)
      const set = pattern[index + 1] === ":" && close > 0 ? CLASSES[pattern.slice(index + 2, close)] : undefined
      if (!set) return "regex"
      items.push(set)
      ascii = true
      last = "class"
      index = close + 2
      continue
    }
    if (char === "-" && index > first && pattern[index + 1] !== "]") {
      // A range needs a single character on both sides.
      const high = pattern[index + 1]
      if (last !== "char" || high === undefined || high === "\\" || high === "-" || (high === "[" && ":=.".includes(pattern[index + 2] ?? "x")) || high < low) return "regex"
      items[items.length - 1] = `${escape(low)}-${escape(high)}`
      last = "range"
      index += 2
      continue
    }
    items.push(escape(char))
    last = "char"
    low = char
    index++
  }
  return "regex"
}

// The replacement as parts. `$` is never special: parts are joined by `substitute`, not handed to JavaScript.
function replacement(text: string, delimiter: string, groups: number, flavor: Flavor): Part[] | string {
  const plainDelimiter = PLAIN_DELIMITERS.includes(delimiter) || delimiter === "|"
  const parts: Part[] = []
  const add = (part: Part) => {
    const previous = parts[parts.length - 1]
    if (typeof part === "string" && typeof previous === "string") parts[parts.length - 1] = previous + part
    else parts.push(part)
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === "&") add(0)
    else if (char !== "\\") add(char)
    else {
      const next = text[++index]
      if (next === undefined) return "replacement"
      if (next === delimiter) {
        if (!plainDelimiter) return "delimiter"
        add(next)
      } else if (next >= "1" && next <= "9") {
        if (Number(next) > groups) return "replacement"
        add(Number(next))
      } else if (next === "&" || next === "\\") add(next)
      else if ((next === "n" || next === "t") && flavor === "gnu") add(next === "n" ? "\n" : "\t")
      else return "replacement"
    }
  }
  return parts
}

function compiles(matcher: Matcher) {
  try {
    compile(matcher, "")
    return true
  } catch {
    return false
  }
}

function compile(matcher: Matcher, flags: string) {
  return new RegExp(matcher.source, `${flags}su${matcher.ignoreCase ? "i" : ""}`)
}

// Lines on LF. A CR right before the LF is set aside and written back, so `$` and `.` see the line as a person reads it.
function split(text: string) {
  const lines: { text: string; end: string; crlf: boolean }[] = []
  let start = 0
  while (start < text.length) {
    const stop = text.indexOf("\n", start)
    if (stop < 0) {
      lines.push({ text: text.slice(start), end: "", crlf: false })
      break
    }
    const crlf = stop > start && text[stop - 1] === "\r"
    lines.push({ text: text.slice(start, crlf ? stop - 1 : stop), end: crlf ? "\r\n" : "\n", crlf })
    start = stop + 1
  }
  return lines
}

function selected(address: Located | undefined, regex: RegExp | undefined, line: number, last: boolean, space: string) {
  if (address === undefined) return true
  if (address.kind === "line") return line === address.line
  if (address.kind === "last") return last
  if (address.kind === "range") return line >= address.from && (address.to === "last" || line <= address.to)
  return regex!.test(space)
}

// GNU never accepts an empty match that begins where the previous match ended, and it copies one character after an
// empty one. Searching the whole string (never a slice) keeps `^`, `\b` and lookbehind honest. GNU sed 4.9 copies one
// byte there, so stepping over a non-ASCII character would write half of it: that is undefined (the caller refuses).
function substitute(space: string, step: Extract<Step, { name: "s" }>, regex: RegExp) {
  let out = ""
  let copied = 0
  let count = 0
  let previous = -1
  let position = 0
  let replaced = false
  while (position <= space.length) {
    regex.lastIndex = position
    const found = regex.exec(space)
    if (!found) break
    const start = found.index
    const end = start + found[0].length
    if (end === start && start === previous) {
      if (start >= space.length) break
      if (space.charCodeAt(start) > 0x7f) return undefined
      position = start + 1
      continue
    }
    count++
    if (count >= step.from) {
      out += space.slice(copied, start) + step.parts.map((part) => (typeof part === "string" ? part : (found[part] ?? ""))).join("")
      copied = end
      replaced = true
      if (step.only) break
    }
    previous = end
    if (end === start && end >= space.length) break
    if (end === start && space.charCodeAt(end) > 0x7f) return undefined
    position = end === start ? end + 1 : end
  }
  return replaced ? out + space.slice(copied) : space
}

