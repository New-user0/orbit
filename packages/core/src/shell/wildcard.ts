import { readdir } from "node:fs/promises"
import path from "node:path"

export * as Wildcard from "./wildcard.js"

/**
 * Expands a shell wildcard word the way bash and PowerShell read it, for the one question the guard asks: which paths could
 * this word reach. It is not a library glob, for three reasons (class 4, class 6, class 7):
 * - a segment is matched by a linear scan with one restart point, so a word with many stars costs the product of the name
 *   and pattern lengths and never grows with the number of stars;
 * - folders are listed with `readdir` only and a link is never entered: a link that matches a segment with more segments
 *   after it leaves the word undecided, and a link that matches the last segment is a candidate path whose target the
 *   caller asks about through the share helper, so nothing here opens a path that goes through a link;
 * - the work is capped, in entries visited and in time, and the caller treats a cap as undecided.
 * `**` is two stars unless `globstar` is set; a leading dot is matched by a wildcard only when `dot` is set.
 * Names match in any case and a class bound keeps its written case (a superset of the shell, which `compile` explains).
 */
export type Options = {
  dot: boolean
  globstar: boolean
  // zsh: three stars before a separator recurse like two and also follow links, so a link met there leaves the word undecided.
  follow?: boolean
  /** PowerShell wildcards: a class has no negation and no named classes. */
  powershell?: boolean
  /** Returns early once more than this many paths match. */
  limit: number
  /** What one command may still spend, shared by all its words: entries visited (counted down here) and a deadline. */
  budget: { entries: number; until: number }
}

const SEGMENT_MAX = 256

/** The paths the word reaches from `folder`, or undefined when that cannot be told (a link on the way, over budget, a spelling not handled). */
export async function expand(folder: string, pattern: string, options: Options): Promise<string[] | undefined> {
  // A share spelling, or a drive-relative one, is not walked.
  if (/^[\\/]{2}/.test(pattern) || /^[a-zA-Z]:(?![\\/])/.test(pattern)) return undefined
  const drive = /^[a-zA-Z]:\//.exec(pattern)?.[0]
  const rooted = drive !== undefined || pattern.startsWith("/")
  const root = drive ?? (rooted ? path.parse(folder).root : folder)
  const segments = (drive ? pattern.slice(drive.length) : pattern)
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  if (segments.some((part) => part.length > SEGMENT_MAX)) return undefined

  // `***` recurses only before a `/`; as the last segment it is one star.
  const recursive = (segment: string, last: boolean) =>
    (segment === "**" && options.globstar) || (options.follow === true && !last && /^\*{3,}$/.test(segment))
  // `**/**` reaches what `**` does: a run of recursive segments is one, and a `***` in the run keeps links out of the walk.
  for (let at = segments.length - 1; at > 0; at--) {
    if (!recursive(segments[at]!, at === segments.length - 1) || !recursive(segments[at - 1]!, false)) continue
    if (segments[at - 1] === "**") segments[at - 1] = segments[at]!
    segments.splice(at, 1)
  }

  const cache = new Map<string, Entry[]>()
  let work = 0
  // Every visit of a folder's listing is charged, cached or not, so a pattern that reaches the same folders again and
  // again spends the budget and not the server's time (class 7).
  const entries = async (dir: string) => {
    if (Date.now() > options.budget.until) return undefined
    const found = cache.get(dir) ?? (await list(dir))
    cache.set(dir, found)
    options.budget.entries -= found.length
    return options.budget.entries < 0 ? undefined : found
  }
  // The deadline is also read inside the entry loops: one listing can be large and each name costs a match.
  const expired = () => (++work & 255) === 0 && Date.now() > options.budget.until

  let level = [root]
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (segment === "..") {
      level = [...new Set(level.map((dir) => path.dirname(dir)))]
      continue
    }
    if (recursive(segment, last)) {
      // Recursion over real folders only. Each folder is visited once however many segments lead to it.
      const follows = segment !== "**"
      const gathered = new Set<string>()
      const seen = new Set(level)
      const dirs = [...seen]
      for (let at = 0; at < dirs.length; at++) {
        const found = await entries(dirs[at]!)
        if (found === undefined) return undefined
        for (const entry of found) {
          if (expired()) return undefined
          if (entry.name.startsWith(".") && !options.dot) continue
          if (follows && entry.link) return undefined
          const child = path.join(dirs[at]!, entry.name)
          gathered.add(child)
          if (entry.directory && !seen.has(child)) {
            seen.add(child)
            dirs.push(child)
          }
          if (last && gathered.size > options.limit) return [...gathered]
        }
      }
      if (last) return [...gathered]
      level = dirs
      continue
    }
    const test = compile(segment, options.dot, options.powershell)
    const next = new Set<string>()
    for (const dir of new Set(level)) {
      const found = await entries(dir)
      if (found === undefined) return undefined
      for (const entry of found) {
        if (expired()) return undefined
        if (!test(entry.name)) continue
        if (!last && entry.link) return undefined
        if (last || entry.directory) next.add(path.join(dir, entry.name))
        if (last && next.size > options.limit) return [...next]
      }
    }
    level = [...next]
  }
  return segments.length === 0 ? [] : level
}

type Entry = { name: string; directory: boolean; link: boolean }

function list(dir: string): Promise<Entry[]> {
  return readdir(dir, { withFileTypes: true }).then(
    (items) => items.map((item) => ({ name: item.name, directory: item.isDirectory(), link: item.isSymbolicLink() })),
    () => [],
  )
}

type Token =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "char"; value: string }
  | { kind: "class"; negate: boolean; test: ((char: string) => boolean)[] }

// Every class name bash accepts. A name that is not here matches any character, which keeps the match a superset.
const NAMED = new Map<string, (char: string) => boolean>([
  ["alpha", (char) => /\p{L}/u.test(char)],
  ["digit", (char) => /[0-9]/.test(char)],
  ["alnum", (char) => /[\p{L}0-9]/u.test(char)],
  ["upper", (char) => /\p{Lu}/u.test(char)],
  ["lower", (char) => /\p{Ll}/u.test(char)],
  ["space", (char) => /\s/.test(char)],
  ["blank", (char) => char === " " || char === "	"],
  ["punct", (char) => /[!-/:-@[-`{-~]/.test(char)],
  ["xdigit", (char) => /[0-9a-fA-F]/.test(char)],
  ["ascii", (char) => char.charCodeAt(0) < 128],
  ["cntrl", (char) => /\p{Cc}/u.test(char)],
  ["graph", (char) => /[^\s\p{Cc}]/u.test(char)],
  ["print", (char) => /[^\p{Cc}]/u.test(char)],
  ["word", (char) => /[\p{L}0-9_]/u.test(char)],
])

/**
 * A matcher for one path segment. It is a superset of what the shell matches: a name character is tried as written and in
 * both case-folded forms, so a case-insensitive disk is covered, and a negated class matches when any of those forms is
 * outside the set. PowerShell has no negation and no named classes: `[!x]` is `!` or `x`.
 */
export function compile(segment: string, dot: boolean, powershell = false): (name: string) => boolean {
  const tokens = tokenize(segment, powershell)
  const first = tokens[0]
  const dotted = first?.kind === "char" && first.value === "."
  return (name) => (name.startsWith(".") && !dot && !dotted ? false : matches(tokens, name))
}

function tokenize(segment: string, powershell: boolean): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < segment.length) {
    const char = segment[at]!
    at++
    if (char === "*") {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" })
      continue
    }
    if (char === "?") {
      tokens.push({ kind: "any" })
      continue
    }
    if (char === "\\" && at < segment.length) {
      tokens.push({ kind: "char", value: segment[at]! })
      at++
      continue
    }
    if (char === "[") {
      const parsed = parseClass(segment, at, powershell)
      if (parsed) {
        tokens.push(parsed.token)
        at = parsed.end
        continue
      }
    }
    tokens.push({ kind: "char", value: char })
  }
  return tokens
}

// `start` is just after the `[`. Undefined when the class is never closed, which makes the `[` a plain character.
function parseClass(segment: string, start: number, powershell: boolean): { token: Token; end: number } | undefined {
  let at = start
  const negate = !powershell && (segment[at] === "!" || segment[at] === "^")
  if (negate) at++
  const test: ((char: string) => boolean)[] = []
  let first = true
  while (at < segment.length) {
    const char = segment[at]!
    if (char === "]" && !first) return { token: { kind: "class", negate, test }, end: at + 1 }
    first = false
    const mark = segment[at + 1]
    if (!powershell && char === "[" && (mark === ":" || mark === "=" || mark === ".")) {
      const close = segment.indexOf(`${mark}]`, at + 2)
      if (close >= 0) {
        const name = segment.slice(at + 2, close)
        // An equivalence class or collating element names one character here; anything else matches any character.
        test.push(mark === ":" ? (NAMED.get(name) ?? (() => true)) : [...name].length === 1 ? (value) => value === name : () => true)
        at = close + 2
        continue
      }
    }
    const low = char === "\\" && !powershell && at + 1 < segment.length ? segment[++at]! : char
    at++
    if (segment[at] === "-" && at + 1 < segment.length && segment[at + 1] !== "]") {
      const high = segment[at + 1]!
      test.push((value) => value >= low && value <= high)
      at += 2
      continue
    }
    test.push((value) => value === low)
  }
  return undefined
}

function forms(char: string) {
  return [...new Set([char, char.toLowerCase(), char.toUpperCase()])]
}

// One restart point (the last star) is enough for stars that match anything, so the work is at most the name length times
// the token count, however many stars there are.
function matches(tokens: Token[], name: string) {
  let n = 0
  let t = 0
  let star = -1
  let resume = 0
  while (n < name.length) {
    const token = tokens[t]
    if (token?.kind === "star") {
      star = t++
      resume = n
      continue
    }
    if (token && one(token, name[n]!)) {
      t++
      n++
      continue
    }
    if (star < 0) return false
    t = star + 1
    n = ++resume
  }
  while (tokens[t]?.kind === "star") t++
  return t === tokens.length
}

function one(token: Token, char: string) {
  if (token.kind === "any") return true
  if (token.kind === "char") return forms(char).includes(token.value) || token.value.toLowerCase() === char.toLowerCase()
  if (token.kind === "class") return forms(char).some((form) => token.test.some((test) => test(form)) !== token.negate)
  return false
}
