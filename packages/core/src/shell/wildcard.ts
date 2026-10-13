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
 */
export type Options = {
  dot: boolean
  globstar: boolean
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

  const cache = new Map<string, Entry[] | undefined>()
  const entries = async (dir: string) => {
    if (cache.has(dir)) return cache.get(dir)
    if (Date.now() > options.budget.until) return undefined
    const found = await list(dir)
    options.budget.entries -= found.length
    const kept = options.budget.entries < 0 ? undefined : found
    cache.set(dir, kept)
    return kept
  }

  let level = [root]
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (segment === "..") {
      level = [...new Set(level.map((dir) => path.dirname(dir)))]
      continue
    }
    if (segment === "**" && options.globstar) {
      // Recursion over real folders only; a link below is not entered.
      const gathered: string[] = []
      const dirs = [...level]
      for (let at = 0; at < dirs.length; at++) {
        const found = await entries(dirs[at]!)
        if (found === undefined) return undefined
        for (const entry of found) {
          if (entry.name.startsWith(".") && !options.dot) continue
          gathered.push(path.join(dirs[at]!, entry.name))
          if (entry.directory) dirs.push(path.join(dirs[at]!, entry.name))
          if (last && gathered.length > options.limit) return gathered
        }
      }
      if (last) return gathered
      level = dirs
      continue
    }
    const test = compile(segment, options.dot)
    const next: string[] = []
    for (const dir of level) {
      const found = await entries(dir)
      if (found === undefined) return undefined
      for (const entry of found) {
        if (!test(entry.name)) continue
        if (!last && entry.link) return undefined
        if (last || entry.directory) next.push(path.join(dir, entry.name))
        if (last && next.length > options.limit) return next
      }
    }
    level = next
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

const NAMED: Record<string, RegExp> = {
  alpha: /\p{L}/u,
  digit: /[0-9]/,
  alnum: /[\p{L}0-9]/u,
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  space: /\s/,
  punct: /[!-/:-@[-`{-~]/,
  xdigit: /[0-9a-fA-F]/,
}

/** A matcher for one path segment. Names match in any case, which is a superset of what the shell matches. */
export function compile(segment: string, dot: boolean): (name: string) => boolean {
  const tokens = tokenize(segment)
  const first = tokens[0]
  const dotted = first?.kind === "char" && first.value === "."
  return (name) => (name.startsWith(".") && !dot && !dotted ? false : matches(tokens, name.toLowerCase()))
}

function tokenize(segment: string): Token[] {
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
      tokens.push({ kind: "char", value: segment[at]!.toLowerCase() })
      at++
      continue
    }
    if (char === "[") {
      const parsed = parseClass(segment, at)
      if (parsed) {
        tokens.push(parsed.token)
        at = parsed.end
        continue
      }
    }
    tokens.push({ kind: "char", value: char.toLowerCase() })
  }
  return tokens
}

// `start` is just after the `[`. Undefined when the class is never closed, which makes the `[` a plain character.
function parseClass(segment: string, start: number): { token: Token; end: number } | undefined {
  let at = start
  const negate = segment[at] === "!" || segment[at] === "^"
  if (negate) at++
  const test: ((char: string) => boolean)[] = []
  let first = true
  while (at < segment.length) {
    const char = segment[at]!
    if (char === "]" && !first) return { token: { kind: "class", negate, test }, end: at + 1 }
    first = false
    if (char === "[" && segment[at + 1] === ":") {
      const close = segment.indexOf(":]", at + 2)
      const named = close < 0 ? undefined : NAMED[segment.slice(at + 2, close)]
      if (named) {
        test.push((value) => named.test(value))
        at = close + 2
        continue
      }
    }
    const low = (char === "\\" && at + 1 < segment.length ? segment[++at]! : char).toLowerCase()
    at++
    if (segment[at] === "-" && at + 1 < segment.length && segment[at + 1] !== "]") {
      const high = segment[at + 1]!.toLowerCase()
      test.push((value) => value >= low && value <= high)
      at += 2
      continue
    }
    test.push((value) => value === low)
  }
  return undefined
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
  if (token.kind === "char") return token.value === char
  if (token.kind === "class") return token.test.some((test) => test(char)) !== token.negate
  return false
}
