export * as SedScript from "./sed.js"

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
