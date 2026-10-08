import { PrintBooleanFlags, RootValueFlags, Subcommands } from "../commands/commands"

export type Classified = {
  readonly mode: "print" | "root"
  readonly args: ReadonlyArray<string>
}

const valueLong = new Set<string>(RootValueFlags.long)
const valueShort = new Set<string>(RootValueFlags.short)
const booleanShort = new Map(Object.entries(PrintBooleanFlags).flatMap(([name, short]) => (short ? [[short, name]] : [])))
const literals = new Set(["true", "1", "y", "yes", "on", "false", "0", "n", "no", "off"])
const subcommands = new Set<string>(Subcommands)

/**
 * Decides whether a command line is `orb -p <message>`, whose words are the message, or an ordinary `orb` command line.
 *
 * Only the tokens before the first literal `--` are looked at, and a word after a flag that takes a value is that
 * flag's value. A line is a print line when `-p` or `--print` (alone or in a cluster of short flags) is there and either
 * the first word is not a subcommand or the flag comes before it, so `orb -p run the tests` sends "run the tests" and
 * `orb run -p` stays a `run` command line. For a print line every boolean flag is rewritten to its inline form
 * (`--print=true`), so a following word such as `yes` stays in the message instead of becoming the flag's value. When
 * finding the first word, though, a yes/no/true/false literal right after a bare boolean flag is that flag's value, as
 * the parser reads it on an ordinary line, so `orb --standalone yes serve -p` is still a `serve` line. The tokens from
 * `--` on are never touched.
 */
export function classify(argv: ReadonlyArray<string>): Classified {
  const separator = argv.indexOf("--")
  const flags = separator === -1 ? argv : argv.slice(0, separator)
  const operands = separator === -1 ? [] : argv.slice(separator)

  const tokens = scan(flags)
  const printAt = tokens.findIndex((token) => token.kind === "flag" && token.print)
  if (printAt === -1) return { mode: "root", args: argv }
  const wordAt = tokens.findIndex((token) => token.kind === "word")
  const first = tokens[wordAt]
  const prints = first?.kind !== "word" || !subcommands.has(first.text) || printAt < wordAt
  if (!prints) return { mode: "root", args: argv }
  return { mode: "print", args: [...tokens.flatMap((token) => token.rewritten), ...operands] }
}

type Token =
  | { readonly kind: "word"; readonly text: string; readonly rewritten: ReadonlyArray<string> }
  | { readonly kind: "flag"; readonly print: boolean; readonly rewritten: ReadonlyArray<string> }
  // The value of a flag that takes one, which is never a word of the message and is never rewritten.
  | { readonly kind: "value"; readonly rewritten: ReadonlyArray<string> }

function scan(flags: ReadonlyArray<string>): ReadonlyArray<Token> {
  const result: Token[] = []
  let expectsValue = false
  // The parser takes a literal right after a boolean flag written without a value as that flag's value. It is only
  // classified that way here, so it is never the first word; a print line still sends it as part of the message.
  let afterBoolean = false
  for (const text of flags) {
    const bare = afterBoolean
    afterBoolean = false
    if (bare && literals.has(text)) {
      result.push({ kind: "value", rewritten: [text] })
      continue
    }
    if (expectsValue) {
      expectsValue = false
      result.push({ kind: "value", rewritten: [text] })
      continue
    }
    if (text.startsWith("--") && text.length > 2) {
      const equals = text.indexOf("=")
      const name = equals === -1 ? text.slice(2) : text.slice(2, equals)
      if (equals === -1 && valueLong.has(name)) expectsValue = true
      const boolean = equals === -1 && Object.hasOwn(PrintBooleanFlags, name)
      afterBoolean = boolean
      // The parser reads --no-<name> as <name> turned off.
      const negated = equals === -1 && name.startsWith("no-") && Object.hasOwn(PrintBooleanFlags, name.slice(3))
      result.push({
        kind: "flag",
        print: name === "print" && text !== "--print=false",
        rewritten: [negated ? `--${name.slice(3)}=false` : boolean ? `${text}=true` : text],
      })
      continue
    }
    // A short flag with an inline value takes no word after it.
    if (/^-[A-Za-z]+=/.test(text)) {
      result.push({ kind: "flag", print: false, rewritten: [text] })
      continue
    }
    if (/^-[A-Za-z]+$/.test(text)) {
      const cluster = expand(text.slice(1))
      expectsValue = cluster.value
      afterBoolean = !cluster.value && booleanShort.has(text.at(-1) ?? "")
      result.push({ kind: "flag", print: cluster.names.includes("print"), rewritten: cluster.rewritten })
      continue
    }
    result.push({ kind: "word", text, rewritten: [text] })
  }
  return result
}

// A cluster of short flags: each letter that is a boolean flag becomes its inline long form, and the rest of the cluster
// stays a short flag, which is where a letter that takes a value ends it.
function expand(letters: string) {
  const names: string[] = []
  const rewritten: string[] = []
  for (const [index, letter] of [...letters].entries()) {
    const name = booleanShort.get(letter)
    if (name) {
      names.push(name)
      rewritten.push(`--${name}=true`)
      continue
    }
    const rest = letters.slice(index)
    rewritten.push(`-${rest}`)
    return { names, rewritten, value: valueShort.has(letters.at(-1) ?? "") }
  }
  return { names, rewritten, value: false }
}

export * as Argv from "./argv"
