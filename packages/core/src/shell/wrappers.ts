export * as ShellWrappers from "./wrappers.js"

// Programs that run another program (`nice`, `timeout`, `env`, `xargs`, `find -exec`), as data. Pure: these parse an argv
// that the analysis already holds and say which program is really started, or that the options cannot be placed. A caller
// that cannot place the program treats the command as one it cannot analyse.

export type Unwrapped = {
  /** The argv of the real program. */
  inner: string[]
  /** An option of a wrapper could not be parsed, so the real program is unknown. */
  unanalysable: boolean
  /** The argv at each wrapper level: the whole argv first, the real program's argv last. */
  steps: string[][]
}

// The argv of the real program, for the checks that name it. A wrapper never makes a command read-only.
export function unwrap(argv: string[]): Unwrapped {
  let rest = argv
  const steps = [argv]
  for (;;) {
    const head = rest[0]
    const next = (() => {
      switch (head) {
        case "time":
        case "nohup":
          return rest[1] === "--" ? rest.slice(2) : rest.slice(1)
        case "timeout":
          return timeout(rest)
        case "nice":
          return nice(rest)
        case "stdbuf":
          return stdbuf(rest)
        case "env":
          return env(rest)
        case "sudo":
        case "doas":
        case "exec":
          return rest[1]?.startsWith("-") ? undefined : rest.slice(1)
        default:
          return null
      }
    })()
    if (next === null) return { inner: rest, unanalysable: false, steps }
    if (next === undefined || next.length === 0) return { inner: rest, unanalysable: next === undefined, steps }
    rest = next
    steps.push(rest)
  }
}

function timeout(argv: string[]) {
  let index = 1
  const value = /^[A-Za-z0-9_.+-]+$/
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--") {
      index++
      break
    }
    if (!token.startsWith("-")) break
    if (["--foreground", "--preserve-status", "--verbose", "-v"].includes(token)) continue
    if (/^--(?:kill-after|signal)=/.test(token)) {
      if (!value.test(token.slice(token.indexOf("=") + 1))) return undefined
      continue
    }
    if (token === "--kill-after" || token === "--signal" || token === "-k" || token === "-s") {
      if (!value.test(argv[++index] ?? "")) return undefined
      continue
    }
    if (/^-[ks][A-Za-z0-9_.+-]+$/.test(token)) continue
    return undefined
  }
  if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[index] ?? "")) return undefined
  return index + 1 < argv.length ? argv.slice(index + 1) : undefined
}

function nice(argv: string[]) {
  if (argv.slice(1).some((arg) => /[$(`]/.test(arg))) return undefined
  if (argv[1] === "-n") return /^[+-]?\d+$/.test(argv[2] ?? "") ? argv.slice(3) : undefined
  if (/^-\d+$/.test(argv[1] ?? "")) return argv.slice(2)
  if (argv[1]?.startsWith("-")) return undefined
  return argv.slice(1)
}

function stdbuf(argv: string[]) {
  let index = 1
  let options = 0
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (/^-[ioe]\S+$/.test(token) || /^--(?:input|output|error)=\S+$/.test(token)) {
      options++
      continue
    }
    if (/^-[ioe]$/.test(token)) {
      options++
      index++
      continue
    }
    if (token.startsWith("-")) return undefined
    break
  }
  return options === 0 || index >= argv.length ? undefined : argv.slice(index)
}

function env(argv: string[]) {
  let index = 1
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || ["-i", "-0", "-v"].includes(token)) continue
    if (token === "-u") {
      index++
      continue
    }
    if (token.startsWith("-")) return undefined
    break
  }
  return index >= argv.length ? [] : argv.slice(index)
}

const XARGS_SWITCHES = new Set("0oprtx")
const XARGS_VALUES = new Set("aEILnPsd")
const XARGS_OPTIONAL = new Set("eil")
const XARGS_LONG_SWITCHES = new Set(["null", "open-tty", "interactive", "no-run-if-empty", "verbose", "exit", "show-limits", "help", "version"])
const XARGS_LONG_VALUES = new Set(["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var", "max-lines", "replace", "eof"])
const XARGS_LONG_OPTIONAL = new Set(["max-lines", "replace", "eof"])

/**
 * The program `xargs` starts, per its manual. `argv` is the command's whole argv (`xargs` first). `program` is undefined
 * when an option cannot be placed, and an empty array when no program is named (xargs then runs `echo`).
 */
export function xargs(argv: string[]): { program: string[] | undefined } {
  let index = 1
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--") {
      index++
      break
    }
    if (!token.startsWith("-") || token === "-") break
    if (token.startsWith("--")) {
      const name = token.slice(2).split("=")[0]
      const given = token.includes("=")
      if (XARGS_LONG_SWITCHES.has(name) && !given) continue
      if (!XARGS_LONG_VALUES.has(name)) return { program: undefined }
      if (given || XARGS_LONG_OPTIONAL.has(name)) continue
      index++
      continue
    }
    for (let at = 1; at < token.length; at++) {
      const char = token[at]
      if (XARGS_SWITCHES.has(char)) continue
      if (XARGS_OPTIONAL.has(char)) break
      if (XARGS_VALUES.has(char)) {
        if (at === token.length - 1) index++
        break
      }
      return { program: undefined }
    }
  }
  return { program: argv.slice(index) }
}

export type Find = {
  /** The words that name where the search starts. Empty means the working folder. */
  starts: string[]
  /** The expression words after the start points. */
  expression: string[]
  delete: boolean
  /** The argv of each `-exec`, `-execdir`, `-ok` and `-okdir` action. */
  exec: string[][]
  /** The expression narrows what is matched: it holds a test of names, times, sizes or owners and no `-o`, `,` or negation. */
  filtered: boolean
}

const FIND_TESTS = new Set(
  (
    "name iname path ipath wholename iwholename regex iregex lname ilname newer anewer cnewer samefile mtime mmin atime amin ctime cmin " +
    "size empty perm user group uid gid nouser nogroup inum links used executable readable writable fstype context"
  )
    .split(" ")
    .map((name) => `-${name}`),
)

/** Splits a `find` argv (the whole argv, `find` first) into start points, expression, `-delete` and `-exec` actions. */
export function find(argv: string[]): Find {
  let index = 1
  while (index < argv.length) {
    const token = argv[index]
    if (token === "-H" || token === "-L" || token === "-P") index++
    else if (token === "-D") index += 2
    else if (/^-O\d?$/.test(token)) index++
    else break
  }
  const starts: string[] = []
  while (index < argv.length && !argv[index].startsWith("-") && argv[index] !== "(" && argv[index] !== "!") starts.push(argv[index++])
  const expression = argv.slice(index)
  const exec: string[][] = []
  let removes = false
  let tests = false
  let alternation = false
  for (let at = 0; at < expression.length; at++) {
    const token = expression[at]
    if (token === "-delete") removes = true
    else if (["-exec", "-execdir", "-ok", "-okdir"].includes(token)) {
      const action: string[] = []
      at++
      while (at < expression.length && expression[at] !== ";" && expression[at] !== "+") action.push(expression[at++])
      exec.push(action)
    } else if (FIND_TESTS.has(token) || /^-newer[a-zA-Z]{2}$/.test(token)) tests = true
    else if (["-o", "-or", ",", "!", "-not"].includes(token)) alternation = true
  }
  return { starts, expression, delete: removes, exec, filtered: tests && !alternation }
}
