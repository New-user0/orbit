export * as ShellSafety from "./safety.js"

import type path from "node:path"
import { aliasTarget, LOCATION, samePath, type Analysis, type Command } from "./analysis.js"
import { DASHES, ShellLaunch } from "./launch.js"
import type { ShellPaths } from "./paths.js"
import { base, checks, type Reason as PowerShellReason } from "./safety-powershell.js"
import { ShellWrappers } from "./wrappers.js"

// The hard safety checks: facts about a shell command that no rule can lift. This module only describes. Given an analysis
// it returns every finding, and a caller (the permission guard) turns the findings into an ask or a refusal. It reads no
// disk, starts no process and never reads the real environment: a caller injects the platform, the matching path module, the
// home folder and the environment, so Windows cases run on Linux. A finding never carries text from the command except
// `place`, which comes from ShellPaths (control characters already replaced); `reason` is a fixed code and `message` a fixed
// sentence (class 9).
//
// The lexical comparisons here only ever ADD an ask or a deny. None of them decides that a path is inside the project for an
// allow: that stays with the guard, on real paths (class 4).

export type Kind =
  | "critical-removal"
  | "too-complex"
  | "directory"
  | "cd-git"
  | "bare-repo"
  | "git-internal"
  | "provider"
  | "powershell"

export type Reason =
  | PowerShellReason
  | "critical-place"
  | "no-preserve-root"
  | "opaque"
  | "dialect"
  | "empty-head"
  | "fragment-head"
  | "keyword-head"
  | "subscript"
  | "arith-subscript"
  | "newline-comment"
  | "jq"
  | "zsh-builtin"
  | "eval-like"
  | "proc-environ"
  | "wrapper"
  | "dynamic-head"
  | "nested-shell"
  | "dynamic-removal"
  | "dynamic-redirect"
  | "dynamic-git-dir"
  | "count"
  | "depth"
  | "cd-git"
  | "indicators"
  | "unverified-gitdir"
  | "git-dir"
  | "internal-write"
  | "archive"
  | "unresolved-path"
  | "unvalidatable"
  | "glob-write"
  | "multiple-cd"
  | "cd-write"
  | "location-path"
  | "provider-path"

export type Finding = {
  kind: Kind
  /** A fixed code. Never text from the command. */
  reason: Reason
  /** Orbit's own sentence for the reason. */
  message: string
  /** "deny" only for PowerShell removal of a place the reference also refuses (the root, a drive, the home folder, a direct child of either, a wildcard). */
  decision: "ask" | "deny"
  /** An exact allow rule of the person's for the whole text may still allow it. True only for too-complex. */
  exact: boolean
  /** Index in the outer analysis' commands of the command it concerns (a nested finding names the launching command). */
  command?: number
  /** Critical removal: the place, as ShellPaths displays it. */
  place?: string
}

export type GuardFacts = {
  /** Git bases where git would find a bare-looking folder or a git directory that is not verified. */
  bare?: { base: string; why: "indicators" | "unverified-gitdir" | "git-dir" }[]
  /** Real places of remove-role operands, by index in analysis.paths.files. */
  real?: { file: number; places: string[] }[]
}

export type Options = {
  platform: NodeJS.Platform
  path: typeof path.posix
  home: string
  cwd: string
  project: string
  location: string
  env: Record<string, string | undefined>
  /** The raw command, for the PowerShell fragment scan when the parse failed. */
  text: string
  facts?: GuardFacts
}

const COMPLEX = "Orbit could not work out what this command will do, so it needs approval each time"
const MESSAGES: Record<Reason, string> = {
  "critical-place": "This command would delete or move a place whose loss would be severe: the root, a drive, a system folder, the home folder, or the project or a folder that holds it. No saved rule can approve it.",
  "no-preserve-root": "This command turns off the protection of the root folder when it removes files. No saved rule can approve it.",
  opaque: `${COMPLEX}: its syntax could not be read, or it is too long or too slow to check.`,
  dialect: `${COMPLEX}: it is written for a shell that Orbit does not analyse.`,
  "empty-head": `${COMPLEX}: its program name is empty.`,
  "fragment-head": `${COMPLEX}: its program name looks like a fragment of another command.`,
  "keyword-head": `${COMPLEX}: it begins with a shell keyword, so the shell syntax was not understood.`,
  subscript: `${COMPLEX}: a variable name holds an array subscript, which the shell evaluates as code.`,
  "arith-subscript": `${COMPLEX}: an arithmetic comparison holds an array subscript, which the shell evaluates as code.`,
  "newline-comment": `${COMPLEX}: a value holds a line break followed by a comment marker.`,
  jq: `${COMPLEX}: jq can run system commands or read program files.`,
  "zsh-builtin": `${COMPLEX}: it uses a shell module command that reaches files, sockets or terminals directly.`,
  "eval-like": `${COMPLEX}: it runs text as code or changes how later names resolve.`,
  "proc-environ": `${COMPLEX}: it reads the environment of another process.`,
  wrapper: `${COMPLEX}: it starts a program through a wrapper whose options could not be read.`,
  "dynamic-head": `${COMPLEX}: the program name is decided only when it runs.`,
  "nested-shell": `${COMPLEX}: it starts another shell with a script Orbit cannot read.`,
  "dynamic-removal": `${COMPLEX}: a file it removes is unknown until it runs.`,
  "dynamic-redirect": `${COMPLEX}: a file it writes is unknown until it runs.`,
  "dynamic-git-dir": `${COMPLEX}: the folder git will use is unknown until it runs.`,
  count: `${COMPLEX}: it has more commands than Orbit checks.`,
  depth: `${COMPLEX}: it starts shells inside shells more deeply than Orbit reads.`,
  "cd-git": "This command changes folder and then runs git. Git in a folder Orbit has not checked can run that folder's hooks and configured programs.",
  indicators: "Git would treat a folder that is not a normal checkout as a repository because it holds repository files, and its hooks could run.",
  "unverified-gitdir": "Git would follow a .git file that points to a git directory Orbit could not verify, and that directory's hooks could run.",
  "git-dir": "This command names a git directory on the command line, and that directory's hooks could run.",
  "internal-write": "This command creates git's own files (HEAD, objects, refs or hooks) and then runs git, which could run a planted hook.",
  "unresolved-path": `${COMPLEX}: a file it writes or removes is a network share, a device, a data stream, or a name that could not be resolved.`,
  unvalidatable: `${COMPLEX}: it takes options or input that hide which files it touches.`,
  "glob-write": `${COMPLEX}: it writes or removes through a wildcard, so the files it reaches are not known.`,
  "multiple-cd": "This command changes folder more than once, so its relative paths cannot be placed.",
  "cd-write": "This command changes folder and then writes, so its relative paths cannot be placed.",
  "location-path": "This command changes location and then names a path, so the path cannot be placed.",
  "provider-path": "It names a registry, environment, function or other non-file location, or a drive that may map anywhere.",
  archive: "This command unpacks an archive and then runs git. The archive can plant git's own files, and git could run a planted hook.",
  "invoke-expression": "It runs text as code.",
  "encoded-command": "It runs an encoded script that cannot be read.",
  "nested-powershell": "It starts another PowerShell, and what that runs cannot be checked.",
  "download-run": "It downloads and runs code.",
  "download-tool": "It downloads files with a transfer tool.",
  "add-type": "It compiles and loads .NET code.",
  "com-object": "It creates a COM object, which can run programs.",
  "new-object-type": "It creates a .NET object of a type outside the safe list.",
  "script-file": "It runs a script file.",
  "invoke-item": "It opens a file with its default program.",
  "scheduled-task": "It creates or changes a scheduled task.",
  "member-name": "It calls a method by name on every object.",
  elevation: "It asks for administrator rights.",
  "start-powershell": "It starts another PowerShell, and what that runs cannot be checked.",
  "script-block": "It contains a script block, which runs as code.",
  subexpression: "It contains a subexpression, which runs as code.",
  "expandable-string": "It contains a string that expands variables or expressions.",
  splatting: "It splats a variable into the arguments of a command.",
  "stop-parsing": "It uses the stop-parsing token, so the rest of the line is passed on unread.",
  "member-access": "It reads a property or calls a method.",
  "type-literal": "It uses a .NET type outside the safe list.",
  "env-write": "It changes environment variables.",
  module: "It loads or installs a module.",
  "alias-variable": "It changes aliases or variables.",
  wmi: "It calls WMI or CIM methods.",
  using: "It loads code through a using statement.",
  requires: "It loads code through a #Requires directive.",
}
const REFUSED = "Orbit refuses to let PowerShell remove this place (the root, a drive, the home folder, a direct child of either, or everything in a folder). Choose a narrower target."

const ORDER: Kind[] = ["critical-removal", "too-complex", "directory", "cd-git", "bare-repo", "git-internal", "provider", "powershell"]
const MAX_COMMANDS = 50

type Level = { analysis: Analysis; text: string; outer?: number }

/** A finding of the guard's own (an unplaceable path, a folder change before a write), with the fixed sentence of its reason. */
export function finding(kind: Kind, reason: Reason, command?: number): Finding {
  return { kind, reason, message: MESSAGES[reason], decision: "ask", exact: kind === "too-complex", ...(command === undefined ? {} : { command }) }
}

/** Whether the input runs git at any level of nesting: by name, by path, through `xargs` or `find -exec`. */
export function runsGit(analysis: Analysis, platform: NodeJS.Platform) {
  return collect(analysis, "").some((level) =>
    level.analysis.commands.some((command) => gitName(command, platform) || gitIndirect(command, platform)),
  )
}

/**
 * Every finding for `analysis` and the scripts nested in it, strongest first: refusals, then the other kinds in the order of
 * `Kind`, then by command. Nothing returns early: a caller reduces the whole list (a refusal beats an ask).
 */
export function check(analysis: Analysis, options: Options): Finding[] {
  const world = new World(options)
  const levels = collect(analysis, options.text)
  const found = new Map<string, Finding>()
  const add = (kind: Kind, reason: Reason, command: number | undefined, extra: { decision?: "ask" | "deny"; place?: string; exact?: false } = {}) => {
    const decision = extra.decision ?? "ask"
    const finding: Finding = {
      kind,
      reason,
      message: decision === "deny" ? REFUSED : MESSAGES[reason],
      decision,
      exact: kind === "too-complex" && extra.exact !== false,
      ...(command === undefined ? {} : { command }),
      ...(extra.place === undefined ? {} : { place: extra.place }),
    }
    found.set(`${kind}|${reason}|${command ?? ""}|${extra.place ?? ""}|${decision}`, finding)
  }

  levels.forEach((level) => visit(level, world, options, add))
  if (levels.reduce((total, level) => total + level.analysis.commands.length, 0) > MAX_COMMANDS) add("too-complex", "count", undefined)
  if (levels.some((level) => level.analysis.deep)) add("too-complex", "depth", undefined)
  git(levels, world, options, add)

  const rank = (finding: Finding) => (finding.decision === "deny" ? -1 : ORDER.indexOf(finding.kind))
  return [...found.values()].sort((left, right) => rank(left) - rank(right) || (left.command ?? Infinity) - (right.command ?? Infinity))
}

type Add = (kind: Kind, reason: Reason, command: number | undefined, extra?: { decision?: "ask" | "deny"; place?: string; exact?: false }) => void

function collect(analysis: Analysis, text: string, outer?: number): Level[] {
  return [{ analysis, text, outer }, ...(analysis.nested ?? []).flatMap((item) => collect(item.analysis, item.text, outer ?? item.command))]
}

const powershell = (analysis: Analysis) => analysis.dialect === "powershell-5.1" || analysis.dialect === "pwsh"

function visit(level: Level, world: World, options: Options, add: Add) {
  const analysis = level.analysis
  const at = (index: number) => level.outer ?? index
  const ps = powershell(analysis)

  if (analysis.opaque) {
    add("too-complex", analysis.opaque.reason === "dialect" ? "dialect" : "opaque", level.outer)
    // The parse failed, so the commands are unknown. A removal of a place that is never acceptable is still refused.
    if (ps) fragments(level.text).forEach((fragment) => scan(fragment, analysis, world, options, add, level.outer))
    return
  }

  analysis.commands.forEach((command, index) => {
    const here = at(index)
    if (command.wrapper) add("too-complex", "wrapper", here)
    // PowerShell 5.1 drops an empty argument when it starts a program, so `sudo '' bash` runs bash.
    if (ps && command.inner[0] === "") add("too-complex", "empty-head", here)
    if (analysis.dialect === "bash") semantic(command, (reason) => add("too-complex", reason, here))
    if (command.source ? !command.source.placeholder && command.source.dynamic : command.dynamicHead)
      // In PowerShell this is a security ask, which beats every allow rule, an exact one included.
      add("too-complex", "dynamic-head", here, ps ? { exact: false } : {})
    if (ShellLaunch.launch(command, options.platform)?.kind === "opaque") add("too-complex", "nested-shell", here)
    if (!command.source) command.redirects.forEach((redirect) => redirect.write && !redirect.literal && add("too-complex", "dynamic-redirect", here))
    else command.source.redirects.forEach((redirect) => redirect.kind === "file" && redirect.value === undefined && redirect.nullSink !== true && add("too-complex", "dynamic-redirect", here))
    // `export GIT_DIR="$X"` names the git directory of every later command.
    if ((gitName(command, options.platform) && dynamicGitDir(command)) || command.argv.some((word) => word.value.startsWith("GIT_DIR=") && !word.literal)) add("too-complex", "dynamic-git-dir", here)
    removals(level, index, world, options, add)
  })
  removalOperands(level, world, options, add)
  if (ps) checks(analysis).forEach((reason) => add("powershell", reason, level.outer))
}

// ---------------------------------------------------------------------------------------------------------------------
// The semantic pass over a clean bash parse

const UNKNOWN = "\u0001"
const KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "while", "until", "for", "in", "do", "done", "case", "esac", "function", "select"])
// Builtins that evaluate their arguments as shell code, or change how later names resolve (see `help` in bash).
const EVAL_LIKE = new Set(["eval", "source", ".", "exec", "command", "builtin", "fc", "coproc", "noglob", "nocorrect", "trap", "enable", "mapfile", "readarray", "hash", "bind", "complete", "compgen", "alias", "let"])
// zsh modules that give raw file, socket and terminal access (see zshmodules(1)), plus the commands that load and reshape them.
const ZSH = new Set(["sysopen", "sysread", "syswrite", "sysseek", "syserror", "zsystem", "zf_ln", "zf_mv", "zf_rm", "zf_mkdir", "zf_rmdir", "zf_chmod", "zf_chown", "zf_chgrp", "ztcp", "zsocket", "zpty", "zmodload", "emulate"])
const ARITHMETIC = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"])
// `read` flags whose operand is data, not a name.
const READ_DATA = new Set("pdnNtui")

function semantic(command: Command, hit: (reason: Reason) => void) {
  const argv = command.argv.map((word) => word.value)
  // The checks name every head of the wrapper chain: `nohup eval x` and `timeout 5 eval x` both run eval.
  ShellWrappers.unwrap(argv).steps.forEach((step) => heads(step, hit))
  const texts = [...argv, ...command.env.map((item) => item.value), ...command.redirects.flatMap((item) => (item.target === undefined ? [] : [item.target]))]
  if (texts.some((value) => /\n[ \t]*#/.test(value))) hit("newline-comment")
  if (texts.some((value) => /\/proc\/.*\/environ/.test(value))) hit("proc-environ")
}

function heads(step: string[], hit: (reason: Reason) => void) {
  const name = step[0]
  if (name === undefined) return
  const args = step.slice(1)
  if (name === "") hit("empty-head")
  if (name.includes(UNKNOWN)) hit("dynamic-head")
  if (/^[-|&]/.test(name)) hit("fragment-head")
  if (KEYWORDS.has(name)) hit("keyword-head")
  if (subscript(name, args)) hit("subscript")
  if (name === "[[" && args.some((arg, index) => ARITHMETIC.has(arg) && ((args[index - 1] ?? "").includes("[") || (args[index + 1] ?? "").includes("[")))) hit("arith-subscript")
  if (name.slice(name.lastIndexOf("/") + 1) === "jq" && args.some((arg) => arg.includes("system(") || /^-[A-Za-z]*[fL]$/.test(arg) || /^--(?:from-file|rawfile|slurpfile|library-path)(?:=|$)/.test(arg))) hit("jq")
  if (ZSH.has(name)) hit("zsh-builtin")
  if (EVAL_LIKE.has(name) && !lookup(name, args)) hit("eval-like")
}

// `command -v`, `fc` without `-e` or `-s`, and `compgen` without `-C`, `-F` or `-W` only look things up or list them.
function lookup(name: string, args: string[]) {
  const cluster = (letters: RegExp) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && letters.test(arg))
  if (name === "command") return args.length > 0 && /^-[pvV]+$/.test(args[0]) && /[vV]/.test(args[0])
  if (name === "fc") return !cluster(/[es]/)
  if (name === "compgen") return !cluster(/[CFW]/)
  return false
}

// A NAME operand that holds `[` is an array subscript, which these builtins evaluate arithmetically, and that runs any
// command substitution inside it even when the text was single-quoted.
function subscript(name: string, args: string[]) {
  const bracket = (value: string | undefined) => value?.includes("[") === true
  if (["test", "[", "[["].includes(name)) return args.some((arg, index) => (arg === "-v" || arg === "-R") && args.slice(index + 1).some(bracket))
  if (name === "printf" || name === "wait") {
    // The flag may sit anywhere in a short-option cluster (`wait -np`), or be followed by its value in the same word.
    const flag = name === "printf" ? "v" : "p"
    return args.some((arg, index) => {
      const cluster = /^-[A-Za-z]+/.exec(arg)?.[0]
      return cluster !== undefined && cluster.includes(flag) && (bracket(arg) || (arg === cluster && cluster.endsWith(flag) && bracket(args[index + 1])))
    })
  }
  if (name === "unset") return args.some((arg) => !arg.startsWith("-") && bracket(arg))
  if (name === "read") return readNames(args).some(bracket)
  return false
}

// The positional names of `read`, without the operands of its data flags (also at the end of a cluster such as `-rp`).
function readNames(args: string[]) {
  const names: string[] = []
  let ended = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!ended && arg === "--") ended = true
    else if (!ended && /^-[A-Za-z]+$/.test(arg)) {
      const letters = [...arg.slice(1)]
      const data = letters.findIndex((letter) => READ_DATA.has(letter))
      if (data >= 0 && data === letters.length - 1) index++
    } else names.push(arg)
  }
  return names
}

// ---------------------------------------------------------------------------------------------------------------------
// Places

type Class = "R" | "O"

// Compares places as strings, never as containment (class 4): a hit only adds an ask or a deny.
class World {
  readonly win: boolean
  readonly fold: boolean
  readonly home: string
  readonly special = new Set<string>()
  readonly local = new Set<string>()

  constructor(readonly options: Options) {
    this.win = options.platform === "win32"
    this.fold = this.win || options.platform === "darwin"
    this.home = options.home === "" ? "" : this.normalize(options.home, this.win)
    const homes = [options.home, ...(this.absolute(this.env("HOME")) ? [this.env("HOME")!] : []), ...(this.win && this.absolute(this.env("USERPROFILE")) ? [this.env("USERPROFILE")!] : [])]
    homes.filter((item) => item !== "").forEach((item) => {
      this.special.add(this.normalize(item, this.win))
      this.special.add(this.normalize(options.path.dirname(item), this.win))
    })
    const posix = "/usr/bin /usr/sbin /usr/lib /usr/lib32 /usr/lib64 /usr/libexec /usr/include /usr/share /usr/local /var/lib /var/log /var/cache /var/spool".split(" ")
    const darwin = ["/private/etc", "/private/var", "/private/tmp", "/System/Library"]
    const windows = (() => {
      const root = this.env("SystemRoot") ?? this.env("windir") ?? "C:\\Windows"
      const folders = [root, `${root}\\System32`, `${root}\\SysWOW64`, `${root}\\WinSxS`]
      return [...folders, ...[this.env("ProgramFiles"), this.env("ProgramFiles(x86)"), this.env("ProgramData")].filter((item): item is string => item !== undefined && item !== "")]
    })()
    ;(this.win ? windows : options.platform === "darwin" ? [...posix, ...darwin] : posix).forEach((item) => this.special.add(this.normalize(item, this.win)))
    ;[options.project, options.location].filter((item) => item !== "").forEach((item) => this.local.add(this.normalize(item, this.win)))
    // The project root and every folder above it: removing one removes the project.
    for (let folder = options.project; folder !== ""; ) {
      this.special.add(this.normalize(folder, this.win))
      const parent = options.path.dirname(folder)
      if (parent === folder) break
      folder = parent
    }
  }

  env(name: string) {
    const env = this.options.env
    if (env[name] !== undefined) return env[name]
    if (!this.win) return undefined
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : env[key]
  }

  absolute(value: string | undefined) {
    return value !== undefined && value !== "" && (this.options.path.isAbsolute(value) || (this.win && /^[A-Za-z]:[\\/]/.test(value)))
  }

  /**
   * One spelling for comparing: separators unified (backslash only where it separates), a device prefix removed, repeated
   * separators collapsed, `.` and `..` folded, and on Windows trailing dots and spaces dropped from each part. Case is folded
   * on the platforms whose file systems default to case-insensitive.
   */
  normalize(value: string, backslash: boolean) {
    let text = backslash ? value.replaceAll("\\", "/") : value
    text = text.replace(/^\/\/[?.]\//, "")
    const drive = /^([A-Za-z]:)(?=\/|$)/.exec(text)
    const rest = drive ? text.slice(2) : text
    const absolute = rest.startsWith("/")
    const parts: string[] = []
    for (const raw of rest.split("/")) {
      const part = this.win && !/^\.+$/.test(raw) ? raw.replace(/[. ]+$/, "") : raw
      if (part === "" || part === ".") continue
      if (part === "..") {
        if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop()
        else if (!absolute && !drive) parts.push("..")
        continue
      }
      parts.push(part)
    }
    const body = parts.join("/")
    const result = drive ? `${drive[1]}/${body}` : absolute ? `/${body}` : body === "" ? "." : body
    return this.fold ? result.toLowerCase() : result
  }

  /** The class of a normalised place: R is the reference's set, O is Orbit's additions. */
  classify(normal: string, glob = false): Class | undefined {
    if (normal === "*" || normal.endsWith("/*")) return "R"
    if (normal === "/" || /^[a-z]:\/$/i.test(normal)) return "R"
    if (this.home !== "" && normal === this.home) return "R"
    if (/^\/[^/]+$/.test(normal) || /^[a-z]:\/[^/]+$/i.test(normal)) return "R"
    if (this.special.has(normal)) return "O"
    if (!glob && this.local.has(normal)) return "O"
    return undefined
  }

  /** `~`, `~/` and `~\` read as the home folder, as the shell would. */
  expand(value: string) {
    if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) return this.options.home + value.slice(1)
    return value
  }
}

function strongest(classes: (Class | undefined)[]): Class | undefined {
  return classes.includes("R") ? "R" : classes.includes("O") ? "O" : undefined
}

// The operands that the paths model reports as removed (`rm`, `rmdir`, `unlink`, `shred -u`, `mv` sources, Remove-Item,
// Move-Item and Rename-Item sources), each compared on its raw spelling, on every lexical candidate and on the real places
// the guard supplied.
function removalOperands(level: Level, world: World, options: Options, add: Add) {
  const analysis = level.analysis
  const backslash = world.win || powershell(analysis)
  analysis.paths.files.forEach((operand, file) => {
    if (operand.role !== "remove") return
    const command = analysis.commands[operand.command]
    const where = level.outer ?? operand.command
    const raw = operand.spelled.includes("<unknown>") ? [] : [world.classify(world.normalize(operand.spelled, backslash))]
    // A glob's candidates name the folder before the wildcard, not what is removed: only the wildcard rule judges them.
    const lexical = operand.form === "glob" ? [globClass(operand, world, analysis.paths.scopes[operand.command]?.bases ?? [options.cwd])] : operand.candidates.map((candidate) => world.classify(world.normalize(candidate, world.win)))
    const real = (options.facts?.real ?? []).filter((item) => item.file === file).flatMap((item) => item.places.map((place) => world.classify(world.normalize(place, world.win))))
    const hit = strongest([...raw, ...lexical, ...real])
    if (hit) {
      // Only PowerShell's Remove-Item refuses, and only for the reference's own set; every other removal asks.
      const refuse = hit === "R" && powershell(analysis) && command?.head === "remove-item"
      return add("critical-removal", "critical-place", where, { place: operand.spelled, ...(refuse ? { decision: "deny" as const } : {}) })
    }
    if (operand.form === "dynamic") add("too-complex", "dynamic-removal", where)
  })
}

// A wildcard in the first component below a critical folder (`/u*`, `~/[a-z]*`) reaches whatever that folder holds.
function globClass(operand: ShellPaths.Operand, world: World, bases: string[]) {
  // A relative wildcard reaches what its folder holds: quiet only where every folder it can resolve from is the project.
  if (operand.prefix === ".") return relativeGlob(bases, world)
  if (operand.prefix === undefined || !operand.spelled.startsWith(operand.prefix)) return undefined
  const rest = operand.spelled.slice(operand.prefix.length).replace(/^[\\/]+/, "")
  if (/[\\/]/.test(rest)) return undefined
  return strongest(operand.candidates.map((candidate) => world.classify(world.normalize(candidate, world.win), true)))
}

function relativeGlob(bases: string[], world: World) {
  const normal = bases.map((item) => world.normalize(item, world.win))
  if (normal.every((item) => world.local.has(item))) return undefined
  return strongest(normal.map((item) => world.classify(item, true)))
}

const RM_FAMILY = new Set(["rm", "rmdir", "unlink", "shred"])

// Removals the paths model does not report: `rm --no-preserve-root`, `find` that deletes, `xargs rm` fed by `find` or `ls`,
// and PowerShell on Linux and macOS, where `rm` and its relatives are the native programs.
function removals(level: Level, index: number, world: World, options: Options, add: Add) {
  const analysis = level.analysis
  const command = analysis.commands[index]
  const where = level.outer ?? index
  const name = ShellLaunch.programName(command.inner[0] ?? "", options.platform)
  const words = command.argv.slice(command.argv.length - command.inner.length + 1)
  const ps = powershell(analysis)
  // The folders a relative spelling resolves from at command `at`, which an earlier `cd` or `Set-Location` may have moved.
  const compare = (spelled: string, at: number, glob = false) => {
    const scope = analysis.paths.scopes[at] ?? { bases: [options.cwd], lost: false }
    const backslash = world.win || ps
    const expanded = world.expand(spelled)
    // An earlier directory change led somewhere unknown, so a relative spelling cannot be placed.
    if (scope.lost && !glob && !world.absolute(expanded)) return add("too-complex", "dynamic-removal", where)
    const raw = world.classify(world.normalize(expanded, backslash))
    if (glob && !world.absolute(expanded) && !/[\\/]/.test(expanded) && relativeGlob(scope.bases, world)) return add("critical-removal", "critical-place", where, { place: spelled })
    const candidates = glob ? [] : scope.bases.map((base) => world.classify(world.normalize(options.path.resolve(base, expanded), world.win)))
    if (strongest([raw, ...candidates])) add("critical-removal", "critical-place", where, { place: spelled })
  }

  if (RM_FAMILY.has(name) && command.inner.includes("--no-preserve-root")) add("critical-removal", "no-preserve-root", where)
  if (ps && options.platform !== "win32" && RM_FAMILY.has(name))
    words.filter((word) => !word.value.startsWith("-")).forEach((word) => (word.literal ? compare(word.value, index, word.glob || /[*?[]/.test(word.value)) : add("too-complex", "dynamic-removal", where)))
  if (name === "find") {
    const parsed = ShellWrappers.find(command.inner)
    const removes = parsed.delete || parsed.exec.some((action) => RM_FAMILY.has(ShellLaunch.programName(ShellWrappers.unwrap(action).inner[0] ?? "", options.platform)))
    if (removes && !parsed.filtered) {
      const starts = parsed.starts.length > 0 ? parsed.starts : ["."]
      starts.forEach((start) => (start.includes(UNKNOWN) ? add("too-complex", "dynamic-removal", where) : compare(start, index)))
    }
  }
  if (name === "xargs" && command.input !== undefined) {
    const program = ShellWrappers.xargs(command.inner).program
    const target = program === undefined ? undefined : ShellWrappers.unwrap(program).inner[0]
    if (target === undefined || !RM_FAMILY.has(ShellLaunch.programName(target, options.platform))) return
    const from = command.input.from
    const producer = analysis.commands[from]
    const producerName = ShellLaunch.programName(producer.inner[0] ?? "", options.platform)
    if (producerName === "find") {
      const parsed = ShellWrappers.find(producer.inner)
      if (!parsed.filtered) (parsed.starts.length > 0 ? parsed.starts : ["."]).forEach((start) => (start.includes(UNKNOWN) ? add("too-complex", "dynamic-removal", where) : compare(start, from)))
    }
    // Every entry of the folders that `ls` lists is removed: `D/*`.
    if (producerName === "ls") {
      const folders = producer.inner.slice(1).filter((word) => !word.startsWith("-"))
      ;(folders.length > 0 ? folders : ["."]).forEach((folder) => compare(`${folder.replace(/[\\/]+$/, "")}/*`, from, true))
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// PowerShell parse failure: the fragment scan

/**
 * Splits PowerShell text into the fragments a deny rule or the removal scan looks at: backtick continuations joined and
 * remaining backticks dropped, then split at `;`, `|`, line breaks, braces, parentheses and `&`. In each fragment, leading
 * variable assignments are removed repeatedly, then a leading `& ` or `. `.
 */
export function fragments(text: string) {
  return text
    .replace(/`\r?\n/g, "")
    .replaceAll("`", "")
    .split(/[;|\r\n{}()&]/)
    .map((piece) => {
      let rest = piece.trim()
      for (let before = ""; before !== rest; ) {
        before = rest
        rest = rest.replace(/^\$[\w:]+\s*(?:[+\-*/%]?=)\s*/, "")
      }
      return rest.replace(/^[&.]\s+/, "").trim()
    })
    .filter((piece) => piece !== "")
}

const REMOVE_ALIASES = new Set(["remove-item", "rm", "del", "ri", "rd", "rmdir", "erase"])

// A fragment that begins with Remove-Item (or an alias of it, on every platform: this is a fail-safe) and holds a critical
// raw spelling among its non-parameter words is refused.
function scan(fragment: string, analysis: Analysis, world: World, options: Options, add: Add, outer: number | undefined) {
  const words = fragment.split(/\s+/)
  const first = words[0].replace(/^(["'])(.*)\1$/, "$2").toLowerCase()
  if (!REMOVE_ALIASES.has(aliasTarget(first, analysis.dialect, options.platform) ?? first)) return
  words
    .slice(1)
    .filter((word) => !DASHES.test(word))
    .forEach((word) => {
      const unquoted = word.replace(/^(["'])(.*)\1$/, "$2")
      if (world.classify(world.normalize(world.expand(unquoted), true)) === "R") add("critical-removal", "critical-place", outer, { decision: "deny", place: unquoted })
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// git

// The program of a command is git: by name or by path (a git started by path reads the hooks of its folder too).
function gitName(command: Command, platform: NodeJS.Platform) {
  return command.inner.length > 0 && base(command.inner[0]) === "git"
}

// Git started through xargs or find -exec.
function gitIndirect(command: Command, platform: NodeJS.Platform) {
  const name = ShellLaunch.programName(command.inner[0] ?? "", platform)
  const git = (argv: string[] | undefined) => {
    if (!argv || argv.length === 0) return false
    return base(ShellWrappers.unwrap(argv).inner[0] ?? "") === "git"
  }
  if (name === "xargs") return git(ShellWrappers.xargs(command.inner).program)
  if (name === "find") return ShellWrappers.find(command.inner).exec.some(git)
  return false
}

// A `--git-dir`, `-C` or `GIT_DIR` whose value is not known before the command runs.
function dynamicGitDir(command: Command) {
  const words = command.argv.slice(command.argv.length - command.inner.length + 1)
  if (command.env.some((item) => item.name === "GIT_DIR" && item.value.includes(UNKNOWN))) return true
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word.value.startsWith("--git-dir=")) {
      if (!word.literal) return true
    } else if (word.value === "--git-dir" || word.value === "-C") {
      const next = words[++index]
      if (next !== undefined && !next.literal) return true
    } else if (!word.value.startsWith("-")) break
    else if (["-c", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--shallow-file"].includes(word.value)) index++
  }
  return false
}

const ARCHIVES = new Set(["tar", "bsdtar", "unzip", "7z", "7za", "gzip", "gunzip", "expand-archive"])

function git(levels: Level[], world: World, options: Options, add: Add) {
  const runs: { level: Level; index: number }[] = levels.flatMap((level) =>
    level.analysis.commands.flatMap((command, index) => (gitName(command, options.platform) || gitIndirect(command, options.platform) ? [{ level, index }] : [])),
  )
  if (runs.length === 0) return
  const first = runs[0].level.outer ?? runs[0].index

  const changes = levels.flatMap((level) => {
    const analysis = level.analysis
    return analysis.commands.flatMap((command, index) => {
      if (powershell(analysis)) return analysis.commands.length > 1 && LOCATION.has(command.head) ? [level.outer ?? index] : []
      const name = ShellLaunch.programName(command.inner[0] ?? "", "linux")
      if (!["cd", "chdir", "pushd", "popd"].includes(name)) return []
      const operands = command.argv.slice(command.argv.length - command.inner.length + 1).filter((word) => word.value !== "--" && !/^-[LPe@]+$/.test(word.value))
      const target = operands[0]
      // `cd <working folder>` changes nothing, wherever it appears.
      if (name !== "popd" && operands.length === 1 && target.literal && !target.glob && !target.tilde && !target.value.startsWith("-") && samePath(target.value, options.cwd, options)) return []
      return [level.outer ?? index]
    })
  })
  if (changes.length > 0) add("cd-git", "cd-git", changes[0])

  ;(options.facts?.bare ?? []).forEach((item) => add("bare-repo", item.why, first))

  const writes = levels.some((level) => internalWrite(level, world, options))
  if (writes) add("git-internal", "internal-write", first)
  const archive = levels.some((level) =>
    level.analysis.commands.some((command) => {
      const name = powershell(level.analysis) ? base(command.head) : ShellLaunch.programName(command.inner[0] ?? "", options.platform)
      return ARCHIVES.has(name.toLowerCase().replace(/\.exe$/, ""))
    }),
  )
  if (archive) add("git-internal", "archive", first)
}

// A write-side operand that lands on git's own files, relative to the working folder or to a folder the input changed to.
function internalWrite(level: Level, world: World, options: Options) {
  const backslash = world.win || powershell(level.analysis)
  return level.analysis.paths.files.some((operand) => {
    if (operand.role !== "write" && operand.role !== "create") return false
    const relative = operand.candidates.flatMap((candidate) => operand.bases.map((place) => options.path.relative(place, candidate)))
    if (!options.path.isAbsolute(operand.spelled) && !operand.spelled.startsWith("~")) relative.push(operand.spelled)
    return relative.some((item) => !item.startsWith("..") && internalPath(world.normalize(item, backslash), world.fold))
  })
}

// `HEAD` alone, or a first component of `objects`, `refs`, `hooks` or `.git` (also its 8.3 short name `git~1`). The caller
// has folded the case on platforms where it does not matter.
function internalPath(normal: string, fold: boolean) {
  const parts = normal.split("/")
  const first = parts[0]
  return (first === (fold ? "head" : "HEAD") && parts.length === 1) || ["objects", "refs", "hooks", ".git"].includes(first) || /^git~\d+$/i.test(first)
}
