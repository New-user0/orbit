export * as ShellAnalysis from "./analysis.js"

import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import fs from "node:fs"
import type path from "node:path"
import type { Node } from "web-tree-sitter"
import { which } from "../util/which.js"
import { ShellParse } from "./parse.js"
import { ShellPaths } from "./paths.js"
import { PowerShellParse } from "./powershell-parse.js"
import { ShellReadOnly } from "./readonly.js"

// What a shell command does, as data. The permission layers and the tool runtime read this model and decide; nothing
// here allows or denies. The module is pure: a caller injects the platform, the matching path module, the home folder and
// the environment, and nothing below reads process.platform, so Windows semantics run on Linux too. `inspect` is the one
// impure entry: it parses (tree-sitter for bash, PowerShell's own parser for PowerShell) and then calls `analyze`.
//
// A command that cannot be analysed is a value (`opaque`), never an error. Opaque reasons are fixed codes: they never
// carry text from the command, because a reason can reach a person (class 9).

export type Dialect = "bash" | "powershell-5.1" | "pwsh" | "unanalysed"
type PathModule = typeof path.posix

export type Context = {
  /** The shell that will run the text: a path or a name. */
  shell: string
  platform: NodeJS.Platform
  /** path.posix or path.win32, chosen by the caller. */
  path: PathModule
  home: string
  /** For `cd <cwd>`. */
  cwd: string
  env: Record<string, string | undefined>
  /** True when the shell would start `head` from the working folder. `inspect` supplies it; pure tests may omit it. */
  local?: (head: string) => boolean
}

export type Opaque = { class: "limit" | "syntax" | "unsupported"; reason: string }

export type Word = {
  value: string
  /** The text is known before the command runs: no unknown part, no `~user`, no arithmetic. */
  literal: boolean
  quoted: boolean
  /** An unquoted `*`, `?`, `[` or `]`. */
  glob: boolean
  arithmetic: boolean
  /** A leading `~` or `~/`, which is expanded with the injected home. */
  tilde: boolean
}

export type Redirect = {
  op: string
  fd?: number
  target?: string
  /** The redirect writes a file (a null sink included). A copy of a descriptor writes none. */
  write: boolean
  nullSink: boolean
  read: boolean
  literal: boolean
  glob: boolean
}

export type Command = {
  text: string
  argv: Word[]
  env: { name: string; value: string }[]
  redirects: Redirect[]
  head: string
  /** The argv after wrappers are stripped, for the checks that name the real program. */
  inner: string[]
  wrapper?: "unanalysable"
  dynamicHead: boolean
  /** PowerShell: a program or a module-qualified name, never a cmdlet. */
  application: boolean
  /** PowerShell: the parser's view of the command. */
  source?: PowerShellParse.Command
  origin: "top" | "substitution" | "subshell" | "body" | "condition" | "pipeline"
  /** Set on a command that reads the output of the command at index `from` of `commands`, when both are plain commands. */
  input?: { from: number; operator: "|" | "|&" }
  readOnly: boolean
}

export type Features = {
  assignment: boolean
  envPrefix: boolean
  background: boolean
  subshell: boolean
  substitution: boolean
  heredoc: boolean
  herestring: boolean
  loop: boolean
  conditional: boolean
  arithmetic: boolean
  directoryChange: boolean
  dynamicHead: boolean
  functionDefinition: boolean
  alias: boolean
}

export type Analysis = {
  dialect: Dialect
  opaque?: Opaque
  commands: Command[]
  statements: { commands: number[]; separator?: ";" | "&&" | "||" | "&" | "\n" }[]
  redirects: Redirect[]
  features: Features
  readOnly: boolean
  readPaths: string[]
  /** The files the commands name, what each does to them, and where a relative spelling may land. */
  paths: ShellPaths.Facts
  sleepLed: boolean
  count: number
}

/** A parse the caller already made: a tree-sitter root for bash ("aborted" when a limit stopped it), or PowerShell's. */
export type Parse = Node | "aborted" | PowerShellParse.Result

const MAX_LENGTH = 10_000
const MAX_NODES = 50_000
const DEADLINE_MS = 50

export function dialect(shell: string, ctx: Pick<Context, "platform" | "path">): Dialect {
  const base = (ctx.platform === "win32" ? ctx.path.parse(shell).name : ctx.path.basename(shell)).toLowerCase()
  if (["sh", "bash", "dash", "ksh", "mksh", "ash", "zsh"].includes(base)) return "bash"
  if (base === "powershell") return "powershell-5.1"
  if (base === "pwsh") return "pwsh"
  return "unanalysed"
}

function features(): Features {
  return {
    assignment: false,
    envPrefix: false,
    background: false,
    subshell: false,
    substitution: false,
    heredoc: false,
    herestring: false,
    loop: false,
    conditional: false,
    arithmetic: false,
    directoryChange: false,
    dynamicHead: false,
    functionDefinition: false,
    alias: false,
  }
}

function opaque(kind: Dialect, value: Opaque): Analysis {
  return {
    dialect: kind,
    opaque: value,
    commands: [],
    statements: [],
    redirects: [],
    features: features(),
    readOnly: false,
    readPaths: [],
    paths: ShellPaths.empty(),
    sleepLed: false,
    count: 0,
  }
}

/**
 * Analyses `command` for the shell in `ctx`. `parse` is the tree-sitter root (bash) or PowerShell's result; a command
 * that is too long, or an unanalysed shell, needs none.
 */
export function analyze(command: string, ctx: Context, parse?: Parse): Analysis {
  const kind = dialect(ctx.shell, ctx)
  if (kind === "unanalysed") return opaque(kind, { class: "unsupported", reason: "dialect" })
  if (kind === "bash") return analyzeBash(command, ctx, parse)
  return analyzePowerShell(ctx, kind, parse)
}

// ---------------------------------------------------------------------------------------------------------------------
// Bash

class Complex extends Error {
  constructor(
    readonly reason: string,
    readonly kind: Opaque["class"] = "unsupported",
  ) {
    super(reason)
  }
}

function fail(reason: string, kind?: Opaque["class"]): never {
  throw new Complex(reason, kind)
}

// The marker for a value that is not known before the command runs. The control-character pre-check keeps it out of
// any real command text.
const UNKNOWN = "\u0001"
const BRACE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/
const SHELL_VARIABLES = new Set(
  "HOME PWD OLDPWD USER LOGNAME SHELL PATH HOSTNAME UID EUID PPID RANDOM SECONDS LINENO TMPDIR BASH_VERSION BASHPID SHLVL HISTFILE IFS".split(
    " ",
  ),
)
// A statement-level assignment to one of these changes how a later command finds or starts a program.
const SENSITIVE = /^(?:PATH|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|LD_.*|DYLD_.*|RIPGREP_CONFIG_PATH|BASH_ENV|ENV|CDPATH|SHELL|EDITOR|VISUAL|PROMPT_COMMAND|NODE_OPTIONS|BUN_.*|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|GIT_.*|GH_.*|GITHUB_TOKEN|DOCKER_.*|DOTNET_.*)$/i
const DIRECTORY = new Set(["cd", "chdir", "pushd", "popd"])

type Scope = Map<string, string | null>
type Walked = { last?: Command }

function precheck(text: string) {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return "control"
  if (/[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(text)) return "unicode-space"
  if (/\\[ \t]/.test(text) || /(?<=[^\s\\])\\\n/.test(text)) return "backslash"
  if (text.includes("~[")) return "zsh-tilde"
  if (/(?:^|[\s;&|])=[A-Za-z_]/.test(text)) return "zsh-equals"
  if (/\{[^}]*["']/.test(maskBraces(text))) return "brace-quote"
}

// Every `{` inside quotes becomes `_`, following the shell's quoting rules.
function maskBraces(text: string) {
  let state: "none" | "single" | "double" = "none"
  let out = ""
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === "\\" && state !== "single") {
      const next = text[index + 1] ?? ""
      if (state === "none" || next === '"' || next === "\\") {
        out += char + next
        index++
        continue
      }
    }
    if (state === "none" && char === "'") state = "single"
    else if (state === "single" && char === "'") state = "none"
    else if (state === "none" && char === '"') state = "double"
    else if (state === "double" && char === '"') state = "none"
    out += char === "{" && state !== "none" ? "_" : char
  }
  return out
}

// A command, possibly negated or redirected: the shapes whose last command is the whole pipeline element.
function plainCommand(node: Node): boolean {
  if (node.type === "command") return true
  const named = kids(node).filter((child) => child.isNamed && child.type !== "comment")
  if (node.type === "negated_command") return named.length === 1 && plainCommand(named[0])
  if (node.type !== "redirected_statement") return false
  const body = named.filter((child) => !["file_redirect", "herestring_redirect", "heredoc_redirect"].includes(child.type))
  return body.length === 1 && plainCommand(body[0])
}

function analyzeBash(command: string, ctx: Context, parse?: Parse): Analysis {
  const kind: Dialect = "bash"
  // An empty command has no commands and is not read-only; it is not opaque.
  if (/^[ \t\n]*$/.test(command)) return { ...opaque(kind, { class: "unsupported", reason: "" }), opaque: undefined }
  if (command.length > MAX_LENGTH) return opaque(kind, { class: "limit", reason: "length" })
  const hit = precheck(command)
  if (hit) return opaque(kind, { class: "unsupported", reason: `precheck:${hit}` })
  if (parse === undefined || (typeof parse === "object" && "valid" in parse)) return opaque(kind, { class: "unsupported", reason: "parse:missing" })
  if (parse === "aborted") return opaque(kind, { class: "limit", reason: "parse:aborted" })
  if (parse.descendantCount > MAX_NODES) return opaque(kind, { class: "limit", reason: "nodes" })
  if (parse.hasError) return opaque(kind, { class: "syntax", reason: "parse:error" })
  const walk = new BashWalk(command, ctx)
  try {
    walk.program(parse)
  } catch (error) {
    if (error instanceof Complex) return opaque(kind, { class: error.kind, reason: error.reason })
    throw error
  }
  return walk.finish()
}

class BashWalk {
  commands: Command[] = []
  statements: Analysis["statements"] = []
  feature = features()
  sensitive = false
  // HOME is assigned somewhere in the input, so a `~` after it is not the home folder.
  homeAssigned = false

  constructor(
    readonly source: string,
    readonly ctx: Context,
  ) {}

  program(root: Node) {
    const children = kids(root)
    children.forEach((child, index) => {
      if (!child.isNamed || child.type === "comment") return
      const next = children[index + 1]
      const background = next?.type === "&"
      const start = this.commands.length
      this.node(child, background ? new Map(this.scope) : this.scope, "top")
      if (background) this.feature.background = true
      const separator = next && [";", "&"].includes(next.type) ? (next.type as ";" | "&") : "\n"
      this.statements.push({
        commands: Array.from({ length: this.commands.length - start }, (_, offset) => start + offset),
        separator,
      })
    })
  }

  scope: Scope = new Map()

  finish(): Analysis {
    const ctx = this.ctx
    this.feature.dynamicHead = this.commands.some((command) => command.dynamicHead)
    this.feature.directoryChange = this.commands.some((command) => DIRECTORY.has(command.head))
    this.feature.alias = this.commands.some((command) => command.head === "alias")
    const reads: string[] = []
    const verdicts = this.commands.map((command) =>
      ShellReadOnly.bash(command, ctx, command.input?.operator === "|" ? this.commands[command.input.from] : undefined),
    )
    verdicts.forEach((verdict, index) => {
      this.commands[index].readOnly = verdict.ok
    })
    // A leading `cd` into the working folder is what models add out of habit; it changes nothing.
    const dropped = this.commands.length > 1 && leadingCd(this.commands[0], ctx)
    const rest = dropped ? this.commands.slice(1) : this.commands
    const restVerdicts = dropped ? verdicts.slice(1) : verdicts
    const directories = rest.filter((command) => command.head === "cd").length
    const readOnly =
      this.commands.length > 0 &&
      !this.sensitive &&
      restVerdicts.every((verdict) => verdict.ok) &&
      (directories === 0 || rest.length === 1)
    for (const verdict of restVerdicts) if (verdict.ok) reads.push(...verdict.reads)
    const paths = ShellPaths.bash({
      commands: this.commands,
      ctx,
      homeChanged: this.homeAssigned,
      dropped,
    })
    return {
      dialect: "bash",
      commands: this.commands,
      statements: this.statements,
      redirects: this.commands.flatMap((command) => command.redirects),
      features: this.feature,
      readOnly,
      readPaths: reads,
      paths,
      sleepLed: sleepLed(this.statements, this.commands, (command) => command.argv[0]?.value === "sleep"),
      count: this.commands.length,
    }
  }

  // Walks one node of the tree. Anything that is not on this list is too complex.
  node(node: Node, scope: Scope, origin: Command["origin"]): Walked {
    switch (node.type) {
      case "comment":
        return {}
      case "command":
        return { last: this.simple(node, scope, origin) }
      case "list":
        return this.list(node, scope, origin)
      case "pipeline":
        return this.pipeline(node, scope)
      case "negated_command":
        return this.node(kids(node).filter((item) => item.isNamed).find((child) => child.type !== "comment")!, scope, origin)
      case "redirected_statement":
        return this.redirected(node, scope, origin)
      case "subshell":
        this.feature.subshell = true
        this.sequence(kids(node), new Map(scope), "subshell")
        return {}
      case "for_statement":
        return this.loop(node, scope)
      case "if_statement":
        this.feature.conditional = true
        this.branches(kids(node), scope)
        return {}
      case "while_statement":
        return this.until(node, scope)
      case "declaration_command":
        return { last: this.declaration(node, scope, origin) }
      case "unset_command":
        return { last: this.unset(node, scope, origin) }
      case "test_command":
        return { last: this.test(node, scope, origin) }
      case "variable_assignment":
        this.assign(node, scope, origin, true)
        this.feature.assignment = true
        return {}
      default:
        return fail(`node:${node.type}`)
    }
  }

  sequence(nodes: Node[], scope: Scope, origin: Command["origin"]) {
    nodes.forEach((child, index) => {
      if (!child.isNamed || child.type === "comment") return
      const background = nodes[index + 1]?.type === "&"
      if (background) this.feature.background = true
      this.node(child, background ? new Map(scope) : scope, origin)
    })
  }

  list(node: Node, scope: Scope, origin: Command["origin"]): Walked {
    const parts = kids(node).filter((child) => child.type !== "comment")
    const operator = parts.find((child) => !child.isNamed)?.type
    if (parts.length !== 3 || (operator !== "&&" && operator !== "||")) fail("list:shape")
    this.node(parts[0], scope, origin)
    const afterLeft = new Map(scope)
    const right = this.node(parts[2], scope, origin)
    // The right side of `||` may not run, so what it assigned is no longer known.
    if (operator === "||")
      for (const [name, value] of scope) if (!afterLeft.has(name) || afterLeft.get(name) !== value) scope.set(name, null)
    return right
  }

  pipeline(node: Node, scope: Scope): Walked {
    let last: Command | undefined
    let previous: { command: Command; plain: boolean } | undefined
    let operator: "|" | "|&" | undefined
    for (const child of kids(node)) {
      if (child.type === "|" || child.type === "|&") operator = child.type
      if (!child.isNamed || child.type === "comment") continue
      const walked = this.node(child, new Map(scope), "pipeline")
      last = walked.last ?? last
      const plain = walked.last !== undefined && plainCommand(child)
      // Only a plain command that follows a plain command has an input to speak of; any other shape leaves it unset.
      if (plain && previous?.plain && operator) walked.last!.input = { from: this.commands.indexOf(previous.command), operator }
      previous = walked.last ? { command: walked.last, plain } : undefined
      operator = undefined
    }
    return { last }
  }

  redirected(node: Node, scope: Scope, origin: Command["origin"]): Walked {
    const redirects: Redirect[] = []
    let body: Node | undefined
    for (const child of kids(node)) {
      if (!child.isNamed || child.type === "comment") continue
      if (child.type === "file_redirect") redirects.push(this.redirect(child, scope, origin))
      else if (child.type === "herestring_redirect") redirects.push(this.herestring(child, scope, origin))
      else if (child.type === "heredoc_redirect") redirects.push(...this.heredoc(child, scope, origin))
      else if (body) fail("redirected:shape")
      else body = child
    }
    if (body && !["command", "pipeline", "list", "negated_command", "declaration_command", "unset_command"].includes(body.type))
      fail(`redirected:${body.type}`)
    const walked = body ? this.node(body, scope, origin) : { last: this.record([], [], [], "", origin) }
    if (!walked.last) fail("redirected:none")
    walked.last.redirects.push(...redirects)
    if (this.rebuilt.has(walked.last)) walked.last.text = render(walked.last.env, walked.last.argv.map((word) => word.value), walked.last.redirects)
    return walked
  }

  loop(node: Node, scope: Scope): Walked {
    this.feature.loop = true
    const name = kids(node).find((child) => child.type === "variable_name")
    if (!name) fail("for:shape")
    if (name.text === "PS4" || name.text === "IFS") fail("for:variable")
    // The variable takes the loop's words, so it changes how programs are found exactly as an assignment does.
    if (SENSITIVE.test(name.text)) this.sensitive = true
    if (name.text === "HOME") this.homeAssigned = true
    const marker = kids(node).findIndex((child) => child.type === "in")
    const body = kids(node).find((child) => child.type === "do_group")
    if (!body) fail("for:shape")
    // The words are checked and then dropped: the loop variable is unknown inside the body.
    if (marker >= 0)
      for (const child of kids(node).slice(marker + 1)) {
        if (child.type === "do_group" || !child.isNamed) continue
        if (child.type === "command_substitution") this.substitution(child, scope)
        else this.word(child, scope, "arg", "top")
      }
    // After the loop the variable holds the last word, or its old value when there were none: unknown either way.
    scope.set(name.text, null)
    const inner = new Map(scope)
    this.sequence(kids(body), inner, "body")
    return {}
  }

  until(node: Node, scope: Scope): Walked {
    this.feature.loop = true
    const children = kids(node)
    children.forEach((child, index) => {
      if (!child.isNamed || child.type === "comment") return
      if (child.type === "do_group") return this.sequence(kids(child), new Map(scope), "body")
      this.condition(child, children[index + 1], scope)
    })
    return {}
  }

  // A condition runs in the real scope, unless `&` sends it to the background: that copy's assignments are lost.
  condition(node: Node, next: Node | undefined, scope: Scope) {
    if (next?.type !== "&") return this.node(node, scope, "condition")
    this.feature.background = true
    this.node(node, new Map(scope), "condition")
  }

  // The body of `if`, `elif` and `else`: conditions run in the real scope, bodies in a copy.
  branches(nodes: Node[], scope: Scope) {
    let body = false
    for (const [index, child] of nodes.entries()) {
      if (child.type === "then") body = true
      if (!child.isNamed || child.type === "comment") continue
      if (child.type === "elif_clause") {
        // The elif may not run, so what its condition assigns must not reach the real scope.
        this.branches(kids(child), new Map(scope))
        continue
      }
      if (child.type === "else_clause") {
        this.sequence(kids(child), new Map(scope), "body")
        continue
      }
      if (body) this.node(child, new Map(scope), "body")
      else this.condition(child, nodes[index + 1], scope)
    }
  }

  // ---- commands

  simple(node: Node, scope: Scope, origin: Command["origin"]) {
    const env: Command["env"] = []
    const argv: Word[] = []
    const redirects: Redirect[] = []
    for (const child of kids(node)) {
      if (child.type === "comment") continue
      if (child.type === "variable_assignment") {
        const assigned = this.assign(child, scope, origin, false)
        env.push(assigned)
        this.feature.envPrefix = true
      } else if (child.type === "command_name") {
        const inner = kids(child)[0]
        if (!inner || child.childCount !== 1) fail("command_name:shape")
        // (( 1 + 1 )) parses as a command whose name is an arithmetic expansion.
        if (inner.type === "arithmetic_expansion" && inner.text.startsWith("((")) fail("node:arithmetic_command")
        argv.push(this.word(inner, scope, "arg", origin))
      } else if (child.type === "file_redirect") redirects.push(this.redirect(child, scope, origin))
      else if (child.type === "herestring_redirect") redirects.push(this.herestring(child, scope, origin))
      else argv.push(this.word(child, scope, "arg", origin))
    }
    const head = argv[0]?.value ?? ""
    // bash runs this word as a command, whatever its prefix looks like.
    if (/^[^\s=]+=/.test(head) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) && argv[0].literal) fail("head:assignment")
    if (head === "read") this.read(argv.slice(1), scope, origin)
    return this.record(argv, env, redirects, node.text, origin)
  }

  read(args: Word[], scope: Scope, origin: Command["origin"]) {
    for (const arg of args) {
      if (arg.value.startsWith("-") || !arg.literal) continue
      if (arg.value === "HOME") this.homeAssigned = true
      const known = scope.get(arg.value)
      if (origin === "condition" && typeof known === "string") fail("read:known")
      scope.set(arg.value, null)
    }
  }

  record(argv: Word[], env: Command["env"], redirects: Redirect[], text: string, origin: Command["origin"]) {
    const values = argv.map((word) => word.value)
    const raw = values[0] ?? ""
    // Windows runs `cat.exe` for `cat`. Elsewhere `cat.exe` is its own name and is never read-only.
    const head = this.ctx.platform === "win32" && !/[\\/]/.test(raw) ? raw.replace(/\.exe$/i, "") : raw
    const unwrapped = unwrap(values)
    const rebuilt = /\$[A-Za-z_]|\n/.test(text) || text === ""
    const command: Command = {
      text: rebuilt ? render(env, values, redirects) : text,
      argv,
      env,
      redirects,
      head,
      inner: unwrapped.inner,
      ...(unwrapped.unanalysable ? { wrapper: "unanalysable" as const } : {}),
      dynamicHead: argv.length > 0 && (!argv[0].literal || argv[0].glob),
      application: false,
      origin,
      readOnly: false,
    }
    if (rebuilt) this.rebuilt.add(command)
    this.commands.push(command)
    return command
  }

  // Commands whose text is rebuilt from argv; the redirects of an enclosing redirected_statement arrive later.
  rebuilt = new Set<Command>()

  declaration(node: Node, scope: Scope, origin: Command["origin"]) {
    const builtin = kids(node)[0].text
    const argv: Word[] = [plain(builtin)]
    for (const child of kids(node).slice(1)) {
      if (child.type === "comment") continue
      if (child.type === "variable_assignment") {
        const assigned = this.assign(child, scope, origin, true)
        argv.push(plain(`${assigned.name}=${assigned.value}`))
        this.feature.assignment = true
      } else if (child.type === "variable_name") argv.push(plain(child.text))
      else argv.push(this.word(child, scope, "arg", origin))
    }
    if (["declare", "typeset", "local"].includes(builtin))
      for (const word of argv.slice(1)) {
        if (word.value.startsWith("-") && /[niaA]/.test(word.value)) fail("declare:flag")
        const bracket = word.value.indexOf("[")
        if (!word.value.startsWith("-") && bracket >= 0 && (word.value.indexOf("=") < 0 || bracket < word.value.indexOf("="))) fail("declare:subscript")
      }
    return this.record(argv, [], [], node.text, origin)
  }

  unset(node: Node, scope: Scope, origin: Command["origin"]) {
    const argv: Word[] = [plain("unset")]
    for (const child of kids(node).slice(1)) {
      if (child.type === "comment") continue
      if (child.type === "variable_name") {
        scope.delete(child.text)
        argv.push(plain(child.text))
      } else argv.push(this.word(child, scope, "arg", origin))
    }
    return this.record(argv, [], [], node.text, origin)
  }

  test(node: Node, scope: Scope, origin: Command["origin"]) {
    const argv: Word[] = [plain("[[")]
    const visit = (child: Node) => {
      if (child.type === "comment") return
      if (!child.isNamed) {
        if (child.type !== "[" && child.type !== "]" && child.type !== "[[" && child.type !== "]]" && child.type !== "(" && child.type !== ")")
          argv.push(plain(child.text))
        return
      }
      if (["unary_expression", "binary_expression", "parenthesized_expression", "negated_expression"].includes(child.type)) {
        kids(child).forEach(visit)
        return
      }
      if (child.type === "test_operator" || child.type === "regex" || child.type === "extglob_pattern") {
        argv.push(plain(child.text))
        return
      }
      argv.push(this.word(child, scope, "arg", origin))
    }
    kids(node).forEach(visit)
    return this.record(argv, [], [], node.text, origin)
  }

  // ---- assignments

  assign(node: Node, scope: Scope, origin: Command["origin"], enter: boolean) {
    const nameNode = kids(node)[0]
    if (nameNode?.type !== "variable_name") fail("assign:name")
    const name = nameNode.text
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail("assign:name")
    if (name === "HOME") this.homeAssigned = true
    if (name === "IFS") fail("assign:ifs")
    const operator = kids(node)[1]?.type
    if (operator !== "=" && operator !== "+=") fail("assign:operator")
    const valueNode = kids(node)[2]
    if (valueNode?.text.includes("~")) fail("assign:tilde")
    const value = valueNode ? this.word(valueNode, scope, "assign", origin) : plain("")
    if (name === "PS4") {
      if (operator === "+=" || value.value.includes(UNKNOWN)) fail("assign:ps4")
      if (!/^[A-Za-z0-9 _+:./=[\]-]*$/.test(value.value.replace(/\$\{[^}]*\}/g, ""))) fail("assign:ps4")
    }
    if (enter) {
      const before = scope.get(name)
      const unknown = value.value.includes(UNKNOWN) || (operator === "+=" && before === null)
      scope.set(name, unknown ? null : (operator === "+=" ? (before ?? "") : "") + value.value)
      if (SENSITIVE.test(name)) this.sensitive = true
    }
    return { name, value: value.value }
  }

  // ---- words

  word(node: Node, scope: Scope, mode: "arg" | "assign", origin: Command["origin"]): Word {
    switch (node.type) {
      case "word": {
        if (BRACE.test(node.text)) fail("word:brace")
        const bad = node.text.startsWith("~") && !/^~(?:\/|$)/.test(node.text)
        return {
          value: node.text.replace(/\\(.)/gs, "$1"),
          literal: !bad,
          quoted: false,
          glob: unescapedGlob(node.text),
          arithmetic: false,
          tilde: node.text.startsWith("~") && !bad,
        }
      }
      case "number":
        if (node.childCount > 0) fail("number:substitution")
        return plain(node.text)
      case "raw_string":
        return { ...plain(node.text.slice(1, -1)), quoted: true }
      case "string":
        return this.string(node, scope, origin)
      case "concatenation":
        return this.concatenation(node, scope, mode, origin)
      case "arithmetic_expansion":
        this.arithmetic(node)
        this.feature.arithmetic = true
        return { ...plain(node.text.trim()), literal: false, arithmetic: true }
      case "simple_expansion":
        return plain(this.variable(node, scope, mode === "assign" ? "assign" : "bare"))
      case "command_substitution":
        if (mode !== "assign") return fail("node:command_substitution")
        this.substitution(node, scope)
        return plain(UNKNOWN)
      default:
        return fail(`node:${node.type}`)
    }
  }

  concatenation(node: Node, scope: Scope, mode: "arg" | "assign", origin: Command["origin"]): Word {
    const masked = kids(node).map((child) => (child.type === "string" || child.type === "raw_string" ? "x" : child.text)).join("")
    if (BRACE.test(masked)) fail("word:brace")
    const parts = kids(node).map((child) => this.word(child, scope, mode, origin))
    const first = parts[0]
    // `~` followed by a quote is not a tilde prefix the shell expands, and not a path either.
    const tilde = first?.tilde === true && kids(node)[0].text !== "~"
    return {
      value: parts.map((part) => part.value).join(""),
      literal: parts.every((part) => part.literal) && !(first?.tilde && !tilde),
      quoted: parts.some((part) => part.quoted),
      glob: parts.some((part) => part.glob),
      arithmetic: parts.some((part) => part.arithmetic),
      tilde,
    }
  }

  arithmetic(node: Node) {
    const allowed = new Set(["arithmetic_expansion", "binary_expression", "unary_expression", "parenthesized_expression", "number", "ternary_expression"])
    const visit = (child: Node) => {
      if (child.isNamed && !allowed.has(child.type)) fail("arithmetic:variable")
      if (child.type === "number" && child.childCount > 0) fail("arithmetic:variable")
      kids(child).forEach(visit)
    }
    visit(node)
  }

  string(node: Node, scope: Scope, origin: Command["origin"]): Word {
    const children = kids(node)
    let out = ""
    let arithmetic = false
    let position = children[0].endIndex
    for (const child of children.slice(1, -1)) {
      // The tree drops newlines between children; they come back from the gap in the source.
      out += this.source.slice(position, child.startIndex)
      position = child.endIndex
      if (child.type === "string_content") out += child.text.replace(/\\([$`"\\])/g, "$1")
      else if (child.type === "$") out += "$"
      else if (child.type === "simple_expansion") out += this.variable(child, scope, "quoted")
      else if (child.type === "command_substitution") out += this.stringSubstitution(child, scope)
      else if (child.type === "arithmetic_expansion") {
        this.arithmetic(child)
        this.feature.arithmetic = true
        arithmetic = true
        out += child.text.trim()
      } else fail(`string:${child.type}`)
    }
    out += this.source.slice(position, children[children.length - 1].startIndex)
    // A string that is only unknown parts would stand in for a whole path or flag.
    if (out.length > 0 && [...out].every((char) => char === UNKNOWN)) fail("string:unknown")
    return { value: out, literal: !out.includes(UNKNOWN) && !arithmetic, quoted: true, glob: false, arithmetic, tilde: false }
  }

  // `$(cat <<'X' ... X)` is its body; any other substitution is pulled out as commands of its own.
  stringSubstitution(node: Node, scope: Scope) {
    const body = catHeredoc(node)
    if (body !== undefined) {
      this.feature.heredoc = true
      const trimmed = body.replace(/\n+$/, "")
      if (/\/proc\/.*\/environ/.test(trimmed) || /\bsystem\s*\(/.test(trimmed)) fail("heredoc:content")
      return trimmed.includes("\n") ? "" : trimmed
    }
    this.substitution(node, scope)
    return UNKNOWN
  }

  substitution(node: Node, scope: Scope) {
    this.feature.substitution = true
    this.sequence(kids(node), new Map(scope), "substitution")
  }

  // A `$name` with the shell's own rules for words and splitting. `mode` bare: an unquoted word.
  variable(node: Node, scope: Scope, mode: "bare" | "quoted" | "assign") {
    const name = kids(node)[1]
    if (!name) fail("var:shape")
    if (name.type === "special_variable_name") {
      if (name.text === "@" || name.text === "*") fail("var:splat")
      if (mode === "bare") fail("var:unknown")
      return UNKNOWN
    }
    if (name.type !== "variable_name") fail("var:shape")
    if (scope.has(name.text)) {
      const value = scope.get(name.text)
      if (value === null || value === undefined) {
        if (mode === "bare") fail("var:unknown")
        return UNKNOWN
      }
      // An empty value would remove the word, and a value with a separator or a glob would split or expand.
      if (mode === "bare" && (value === "" || /[ \t\n*?[]/.test(value))) fail("var:split")
      return value
    }
    if (SHELL_VARIABLES.has(name.text) || /^\d+$/.test(name.text)) {
      if (mode === "bare") fail("var:unknown")
      return UNKNOWN
    }
    return fail("var:unknown")
  }

  // ---- redirects

  redirect(node: Node, scope: Scope, origin: Command["origin"]): Redirect {
    const descriptor = kids(node).find((child) => child.type === "file_descriptor")
    const operator = kids(node).find((child) => !child.isNamed)
    const target = kids(node).find((child) => child.isNamed && child.type !== "file_descriptor")
    if (!operator || !target) fail("redirect:shape")
    const op = operator.text
    if (![">", ">>", "<", ">&", "<&", ">|", "&>", "&>>", "<<<", "<>"].includes(op)) fail("redirect:operator")
    const word = this.target(target, scope, origin)
    const fd = descriptor ? Number(descriptor.text) : undefined
    const copy = (op === ">&" || op === "<&") && (/^\d+$/.test(word.value) || word.value === "-") && word.literal
    const read = op === "<" || op === "<>" || (op === "<&" && !copy)
    const write = !copy && (op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>" || op === "<>" || op === ">&")
    const nullSink = write && word.literal && ShellReadOnly.nullSink(word.value)
    return {
      op,
      ...(fd === undefined ? {} : { fd }),
      target: word.value,
      write,
      nullSink,
      read,
      literal: word.literal,
      glob: word.glob,
    }
  }

  target(node: Node, scope: Scope, origin: Command["origin"]): Word {
    if (node.type === "word") {
      if (BRACE.test(node.text)) fail("redirect:brace")
      return this.word(node, scope, "arg", origin)
    }
    if (node.type === "number") {
      if (node.childCount > 0) fail("redirect:target")
      return plain(node.text)
    }
    if (node.type === "raw_string" || node.type === "string" || node.type === "concatenation") return this.word(node, scope, "arg", origin)
    return fail("redirect:target")
  }

  herestring(node: Node, scope: Scope, origin: Command["origin"]): Redirect {
    this.feature.herestring = true
    const content = kids(node).find((child) => child.isNamed)
    if (!content) fail("herestring:shape")
    const word = this.word(content, scope, "arg", origin)
    if (/\n[ \t]*#/.test(word.value)) fail("herestring:comment")
    return { op: "<<<", write: false, nullSink: false, read: false, literal: true, glob: false }
  }

  heredoc(node: Node, scope: Scope, origin: Command["origin"]): Redirect[] {
    this.feature.heredoc = true
    const start = kids(node).find((child) => child.type === "heredoc_start")
    if (!start || !/^['"\\]/.test(start.text)) fail("heredoc:unquoted")
    const redirects: Redirect[] = []
    for (const child of kids(node)) {
      if (child.type === "file_redirect") redirects.push(this.redirect(child, scope, origin))
      else if (child.type === "heredoc_body" && child.childCount > 0) fail("heredoc:expansion")
      else if (!["<<", "<<-", "heredoc_start", "heredoc_body", "heredoc_end"].includes(child.type)) fail("heredoc:trailing")
    }
    return [{ op: "<<", write: false, nullSink: false, read: false, literal: true, glob: false }, ...redirects]
  }
}

// web-tree-sitter types a child as possibly null; a child within childCount never is.
function kids(node: Node) {
  return node.children.filter((child): child is Node => child !== null)
}

function plain(value: string): Word {
  return { value, literal: !value.includes(UNKNOWN), quoted: false, glob: false, arithmetic: false, tilde: false }
}

function unescapedGlob(text: string) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") index++
    else if ("*?[]".includes(text[index])) return true
  }
  return false
}

// The command as a person reads it: values substituted, a part that is not known shown as a placeholder.
function render(env: Command["env"], values: string[], redirects: Redirect[]) {
  return [
    ...env.map((item) => `${item.name}=${quote(item.value)}`),
    ...values.map(quote),
    ...redirects.map((item) => `${item.fd ?? ""}${item.op}${item.target ?? ""}`),
  ]
    .join(" ")
    .replaceAll(UNKNOWN, "<unknown>")
}

function quote(value: string) {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

// `$(cat <<'X'` ... `X)` with a bare cat, a quoted delimiter and a literal body.
function catHeredoc(node: Node) {
  const statements = kids(node).filter((child) => child.isNamed)
  if (statements.length !== 1 || statements[0].type !== "redirected_statement") return undefined
  const parts = kids(statements[0]).filter((child) => child.isNamed)
  if (parts.length !== 2 || parts[0].type !== "command" || parts[1].type !== "heredoc_redirect") return undefined
  const named = kids(parts[0])
  if (named.length !== 1 || named[0].text !== "cat" || named[0].type !== "command_name") return undefined
  const heredoc = kids(parts[1])
  const start = heredoc.find((child) => child.type === "heredoc_start")
  const body = heredoc.find((child) => child.type === "heredoc_body")
  if (!start || !body || !/^['"\\]/.test(start.text) || body.childCount > 0) return undefined
  if (heredoc.some((child) => !["<<", "<<-", "heredoc_start", "heredoc_body", "heredoc_end"].includes(child.type))) return undefined
  return body.text
}

function leadingCd(command: Command, ctx: Context) {
  if (command.head !== "cd" || command.argv.length !== 2 || command.env.length > 0 || command.redirects.length > 0) return false
  const target = command.argv[1]
  if (!target.literal || target.glob || target.tilde || target.value.startsWith("-")) return false
  return samePath(target.value, ctx.cwd, ctx)
}

function samePath(left: string, right: string, ctx: Context) {
  // Git Bash writes C:\proj as /c/proj.
  const msys = (value: string) => {
    const match = ctx.platform === "win32" ? /^\/([A-Za-z])(\/.*)?$/.exec(value) : undefined
    return match ? `${match[1].toUpperCase()}:${match[2] ?? "\\"}` : value
  }
  const fold = (value: string) => {
    const normal = ctx.path.normalize(msys(value)).replace(/[\\/]+$/, "")
    return ctx.platform === "win32" ? normal.toLowerCase() : normal
  }
  return fold(left) === fold(right)
}

// ---------------------------------------------------------------------------------------------------------------------
// Wrappers: the argv of the real program, for the checks that name it. Never read-only.

function unwrap(argv: string[]): { inner: string[]; unanalysable: boolean } {
  let rest = argv
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
    if (next === null) return { inner: rest, unanalysable: false }
    if (next === undefined || next.length === 0) return { inner: rest, unanalysable: next === undefined }
    rest = next
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

function sleepLed(statements: Analysis["statements"], commands: Command[], sleeping: (command: Command) => boolean) {
  return statements.length > 0 && statements.every((statement) => statement.commands.length === 1 && sleeping(commands[statement.commands[0]]))
}

// ---------------------------------------------------------------------------------------------------------------------
// PowerShell, from the summary of its own parser

// Aliases Orbit resolves, restricted to where PowerShell defines them. `sort` is never mapped: the native sort exists on
// every platform, and a wrong guess would turn `sort /O` into a read-only Sort-Object. An alias that is missing here
// stays a native name and fails closed.
function aliases(entries: string) {
  return new Map(
    entries
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [cmdlet, names] = line.split(":")
        return names.trim().split(/\s+/).map((name) => [name, cmdlet.trim()] as const)
      }),
  )
}

const EVERYWHERE = aliases(`
set-location: cd chdir sl
get-location: pwd gl
get-childitem: dir gci
get-content: gc type
get-item: gi
get-itemproperty: gp
get-itempropertyvalue: gpv
write-output: echo
select-object: select
where-object: where ?
foreach-object: foreach %
measure-object: measure
format-table: ft
format-list: fl
format-wide: fw
out-host: oh
group-object: group
get-member: gm
get-unique: gu
select-string: sls
resolve-path: rvpa
convert-path: cvpa
format-hex: fhx
get-alias: gal
get-history: h history ghy
get-module: gmo
get-command: gcm
invoke-expression: iex
invoke-command: icm
invoke-item: ii
invoke-restmethod: irm
invoke-webrequest: iwr
import-module: ipmo
start-job: sajb
new-item: ni
remove-item: ri del erase rd
move-item: mi move
copy-item: copy cpi
set-item: si
rename-item: rni ren
new-alias: nal
set-alias: sal
export-alias: epal
import-alias: ipal
export-csv: epcsv
clear-content: clc
clear-item: cli
set-itemproperty: sp
remove-itemproperty: rp
set-variable: sv set
get-variable: gv
get-process: gps
stop-process: spps
start-process: saps
new-pssession: nsn
enter-pssession: etsn
exit-pssession: exsn
get-pssession: gsn
remove-pssession: rsn
clear-host: cls
push-location: pushd
pop-location: popd
new-psdrive: ndr
`)
const WINDOWS = aliases(`
get-childitem: ls
get-content: cat
copy-item: cp
move-item: mv
new-item: md
remove-item: rm rmdir
get-process: ps
stop-process: kill
start-sleep: sleep
tee-object: tee
write-output: write
get-help: man
start-process: start
clear-host: clear
add-content: ac
compare-object: diff compare
copy-itemproperty: cpp
new-psdrive: mount
get-service: gsv
start-service: sasv
stop-service: spsv
out-gridview: ogv
out-printer: lp
`)
const WINDOWS_POWERSHELL = aliases(`
set-content: sc
invoke-webrequest: curl wget
`)

const EXTENSIONS = /\.(exe|cmd|bat|com)$/i
const PATH_START = /^([A-Za-z]:|\\\\|\.{1,2}\\)/

function powershellHead(written: string, kind: Dialect, platform: NodeJS.Platform) {
  const given = written.replace(/^(["'])(.*)\1$/s, "$2").replace(/`(.)/gs, "$1")
  const lower = given.toLowerCase()
  if (lower === "where.exe") return { head: "where.exe", application: false }
  // A module qualifier makes the name a path: only the part after it is kept, to match rules.
  const qualified = given.includes("\\") && !PATH_START.test(given) && !given.endsWith("\\")
  const program = qualified || /[./\\]|[^\x00-\x7f]/.test(given)
  if (program) {
    const name = qualified ? lower.slice(lower.lastIndexOf("\\") + 1) : lower
    return { head: /[\\/]/.test(name) ? name : name.replace(EXTENSIONS, ""), application: true }
  }
  return { head: aliasTarget(lower, kind, platform) ?? lower, application: false }
}

/** The cmdlet a lower-case name stands for on this edition and platform, or undefined when PowerShell defines no such alias. */
export function aliasTarget(name: string, kind: Dialect, platform: NodeJS.Platform) {
  const windows = platform === "win32"
  return (
    EVERYWHERE.get(name) ??
    (windows ? WINDOWS.get(name) : undefined) ??
    (windows && kind === "powershell-5.1" ? WINDOWS_POWERSHELL.get(name) : undefined)
  )
}

/** Every name in the alias table, for the fixture recorder. */
export function aliasNames() {
  return [...new Set([...EVERYWHERE.keys(), ...WINDOWS.keys(), ...WINDOWS_POWERSHELL.keys()])]
}

const LOCATION = new Set(["set-location", "push-location", "pop-location", "new-psdrive"])
const LOOPS = new Set(["ForStatementAst", "ForEachStatementAst", "WhileStatementAst", "DoWhileStatementAst", "DoUntilStatementAst"])
const CONSTANT = new Set(["StringConstantExpressionAst", "ConstantExpressionAst"])

function analyzePowerShell(ctx: Context, kind: Dialect, parse?: Parse): Analysis {
  if (parse === undefined || typeof parse === "string" || !("valid" in parse)) return opaque(kind, { class: "unsupported", reason: "parse:missing" })
  if (!parse.valid) {
    const reason = parse.reason
    return opaque(kind, { class: reason === "parse-errors" ? "syntax" : reason === "too-long" ? "limit" : "unsupported", reason: `powershell:${reason}` })
  }
  const summary = parse.summary
  const feature = features()
  const commands: Command[] = []
  const index = new Map<PowerShellParse.Command, number>()
  const add = (source: PowerShellParse.Command, origin: Command["origin"]) => {
    const named = powershellHead(source.written, kind, ctx.platform)
    const argv: Word[] = [word(source.written, true), ...source.arguments.map((argument) => argumentWord(argument))]
    index.set(source, commands.length)
    commands.push({
      text: source.text,
      argv,
      env: [],
      redirects: source.redirects.map(redirect),
      head: source.placeholder ? "" : named.head,
      inner: [named.head, ...argv.slice(1).map((item) => item.value)],
      dynamicHead: source.placeholder || source.dynamic,
      application: named.application,
      source,
      origin,
      readOnly: false,
    })
  }
  for (const source of summary.commands) add(source, source.nested ? "body" : "top")
  const top = summary.statements.filter((statement) => statement.top)
  for (const statement of top)
    for (const element of statement.elements) if (element.command.placeholder) add(element.command, "top")
  const statements = top.map((statement) => ({ commands: statement.elements.flatMap((element) => (index.has(element.command) ? [index.get(element.command)!] : [])) }))

  for (const statement of summary.statements) {
    feature.assignment ||= statement.assignment
    feature.subshell ||= statement.subexpression
    feature.substitution ||= statement.subexpression
    feature.loop ||= LOOPS.has(statement.kind)
    feature.conditional ||= statement.kind === "IfStatementAst" || statement.kind === "SwitchStatementAst"
    feature.functionDefinition ||= statement.kind === "FunctionDefinitionAst"
  }
  feature.dynamicHead = commands.some((item) => item.dynamicHead)
  feature.directoryChange = commands.some((item) => LOCATION.has(item.head))
  feature.alias = commands.some((item) => ["set-alias", "new-alias"].includes(item.head))

  // Every condition of the allowlist; one that fails makes the whole command not read-only.
  const verdicts = new Map<Command, ShellReadOnly.Verdict>()
  const check = (item: Command, later: boolean) => {
    const verdict = ShellReadOnly.powershell(item, ctx, later)
    verdicts.set(item, verdict)
    return verdict
  }
  statements.forEach((statement) => statement.commands.forEach((position, offset) => check(commands[position], offset > 0)))
  commands.forEach((item) => {
    if (!verdicts.has(item)) check(item, false)
    item.readOnly = verdicts.get(item)!.ok
  })
  const pipelines = top.length > 0 && top.every((statement) => statement.kind === "PipelineAst" && statement.elements.every((element) => element.kind === "command"))
  const flagged = summary.statements.some((statement) => statement.scriptBlock || statement.subexpression || statement.expandable || statement.memberAccess || statement.assignment)
  const redirected = top.every((statement) => statement.redirects.every((item) => item.kind === "merge" || item.nullSink === true))
  const placed = top.flatMap((statement) => statement.elements.map((element) => commands[index.get(element.command) ?? -1])).filter((item) => item !== undefined)
  const moved = placed.length > 1 && placed.some((item) => LOCATION.has(item.head))
  const readOnly =
    pipelines && !flagged && !summary.stopParsing && !summary.commands.some((item) => item.nested) && redirected && !moved && commands.every((item) => item.readOnly)
  const reads = commands.flatMap((item) => {
    const verdict = verdicts.get(item)
    return verdict?.ok ? verdict.reads : []
  })
  const paths = ShellPaths.powershell({
    commands,
    ctx,
    summary,
    index,
    reads: commands.map((item) => {
      const verdict = verdicts.get(item)
      return verdict?.ok ? verdict.reads : []
    }),
  })
  return {
    dialect: kind,
    commands,
    statements,
    redirects: top.flatMap((statement) => statement.redirects.map(redirect)),
    features: feature,
    readOnly: readOnly && commands.length > 0,
    readPaths: reads,
    paths,
    sleepLed: sleepLed(statements, commands, (item) => item.head === "start-sleep" || item.head === "sleep"),
    count: commands.length,
  }
}

function word(value: string, literal: boolean): Word {
  return { value, literal, quoted: false, glob: false, arithmetic: false, tilde: false }
}

function argumentWord(argument: PowerShellParse.Argument): Word {
  if (argument.kind === "CommandParameterAst") return word(argument.text, argument.bound === undefined || (CONSTANT.has(argument.bound.kind) && argument.bound.value !== undefined))
  return word(argument.value ?? argument.text, CONSTANT.has(argument.kind) && argument.value !== undefined)
}

function redirect(item: PowerShellParse.Redirect): Redirect {
  const merge = item.kind === "merge"
  return {
    op: item.operator,
    ...(item.target === undefined ? {} : { target: item.target }),
    write: !merge,
    nullSink: item.nullSink === true,
    read: false,
    literal: true,
    glob: false,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The impure entry

/**
 * Parses `command` within the limits and analyses it. Bash goes through tree-sitter (10,000 characters, 50 ms and 50,000
 * nodes), PowerShell through its own parser. Nothing falls back to a weaker path; an input that cannot be parsed is opaque.
 */
export const inspect = Effect.fn("ShellAnalysis.inspect")(function* (command: string, ctx: Context) {
  const withLocal: Context = { ...ctx, local: ctx.local ?? ((head) => locate(head, ctx)) }
  const kind = dialect(ctx.shell, ctx)
  if (kind === "unanalysed") return analyze(command, withLocal)
  if (kind !== "bash") {
    const parser = yield* PowerShellParse.Service
    return analyze(command, withLocal, yield* parser.parse(command))
  }
  if (command.length > MAX_LENGTH || /^[ \t\n]*$/.test(command)) return analyze(command, withLocal)
  const parsers = yield* Effect.promise(ShellParse.parsers)
  const deadline = performance.now() + DEADLINE_MS
  const tree = parsers.bash.parse(command, null, { progressCallback: () => performance.now() > deadline })
  if (!tree) return analyze(command, withLocal, "aborted")
  return yield* Effect.acquireUseRelease(
    Effect.succeed(tree),
    (tree) => Effect.sync(() => analyze(command, withLocal, tree.rootNode)),
    (tree) => Effect.sync(() => tree.delete()),
  )
})

// Whether the program that `head` names on the shell's PATH sits inside the working folder. Both are made real first, as
// FSUtil.contains requires, so a link into the folder counts.
function locate(head: string, ctx: Context) {
  const found = which(head, ctx.env as NodeJS.ProcessEnv)
  if (!found) return false
  if (!fs.existsSync(ctx.cwd)) return false
  return FSUtil.contains(fs.realpathSync.native(ctx.cwd), fs.realpathSync.native(found))
}
