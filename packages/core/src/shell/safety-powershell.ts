import type { Analysis, Command } from "./analysis.js"
import { ClmTypes } from "./clm-types.js"
import type { PowerShellParse } from "./powershell-parse.js"

// The PowerShell security checks (decision 5 of the shell chain): constructs that run code Orbit cannot read in advance, or
// that reach beyond the files of the project. Every hit is an ask; nothing here denies. The checks read PowerShell's own
// parse (the summary and each command), never the text, so quoting tricks are already resolved by the parser.

export type Reason =
  | "invoke-expression"
  | "encoded-command"
  | "nested-powershell"
  | "download-run"
  | "download-tool"
  | "add-type"
  | "com-object"
  | "new-object-type"
  | "script-file"
  | "invoke-item"
  | "scheduled-task"
  | "member-name"
  | "elevation"
  | "start-powershell"
  | "script-block"
  | "subexpression"
  | "expandable-string"
  | "splatting"
  | "stop-parsing"
  | "member-access"
  | "type-literal"
  | "env-write"
  | "module"
  | "alias-variable"
  | "wmi"
  | "using"
  | "requires"

const DASH = /^[-/–—―]+/

type Arg = {
  kind: string
  /** Source text. */
  text: string
  /** The folded constant, when the parser folded one. */
  value?: string
  /** A real parameter (`-Name`), lower-case without its dash. */
  param?: string
  /** The value bound with `-Name:value`. */
  bound?: string
}

/** The base name of a program or command name: no folders, no executable extension, lower-case. */
export function base(name: string) {
  return name
    .slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "")
}

function names(command: Command) {
  const written = (command.source?.written ?? "").replace(/^(["'])(.*)\1$/s, "$2").replace(/`(.)/gs, "$1").toLowerCase()
  // A module qualifier (`Microsoft.PowerShell.Utility\Invoke-Expression`) is not part of the name.
  const qualified = written.includes("\\") && !/^(?:[a-z]:|\\\\|\.{1,2}\\)/.test(written) ? written.slice(written.lastIndexOf("\\") + 1) : written
  return [command.head, qualified, base(command.head), base(qualified)]
}

function is(command: Command, set: ReadonlySet<string>) {
  return names(command).some((name) => set.has(name))
}

function args(command: Command): Arg[] {
  return (command.source?.arguments ?? []).map((item) => ({
    kind: item.kind,
    text: item.text,
    ...(item.value === undefined ? {} : { value: item.value }),
    ...(item.parameter === undefined ? {} : { param: item.parameter.toLowerCase() }),
    ...(item.bound === undefined ? {} : { bound: item.bound.value ?? item.bound.text }),
  }))
}

// A parameter is written by any prefix that is unambiguous for the command; `min` is the shortest one that is. A string
// argument of the form `/name` counts too: Windows PowerShell 5.1's program takes `/` as a parameter prefix, and asking more
// is safe.
function named(item: Arg, full: string, min: number) {
  const written = item.param ?? (item.kind === "StringConstantExpressionAst" && /^\/[A-Za-z]+$/.test(item.value ?? "") ? (item.value ?? "").slice(1).toLowerCase() : undefined)
  return written !== undefined && written.length >= min && full.startsWith(written)
}

const positional = (item: Arg) => item.param === undefined
const text = (item: Arg) => item.value ?? item.text

// The text of an argument of a native program, whatever dash or slash it starts with, lower-case.
function flag(item: Arg) {
  return text(item).replace(DASH, "").toLowerCase()
}

const set = (...items: string[]) => new Set(items)

const INVOKE_EXPRESSION = set("invoke-expression", "iex")
const DOWNLOADERS = set("invoke-webrequest", "invoke-restmethod", "iwr", "irm", "new-object", "start-bitstransfer")
const SCRIPT_FILE = set("invoke-command", "icm", "start-job", "start-threadjob", "register-scheduledjob")
const SCHEDULED = set("register-scheduledtask", "new-scheduledtask", "new-scheduledtaskaction", "set-scheduledtask")
const FOR_EACH = set("foreach-object", "foreach", "%")
const START_PROCESS = set("start-process", "saps", "start")
const SCRIPT_BLOCK_RUNNERS = set(
  "invoke-command",
  "invoke-expression",
  "start-job",
  "start-threadjob",
  "register-scheduledjob",
  "register-engineevent",
  "register-objectevent",
  "register-wmievent",
  "new-pssession",
  "enter-pssession",
)
const FILTERS = set("where-object", "sort-object", "select-object", "group-object", "format-table", "format-list", "format-wide", "format-custom")
// `sc` is left out of the aliases: PowerShell 7 resolves it to `sc.exe`. The analysis resolves it per edition already.
const ENV_WRITERS = set("set-item", "new-item", "remove-item", "clear-item", "set-content", "add-content")
const MODULES = set("import-module", "ipmo", "install-module", "save-module", "update-module", "install-script", "save-script")
const MUTATORS = set("set-alias", "sal", "new-alias", "nal", "set-variable", "sv", "new-variable", "nv")
const WMI = set("invoke-wmimethod", "iwmi", "invoke-cimmethod")

const NORMALIZED = (value: string) => value.replace(/[`'"\s]/g, "").toLowerCase()

/** The reasons for which `analysis` (one PowerShell parse) asks. The caller reports a computed command name itself. */
export function checks(analysis: Analysis): Reason[] {
  const summary = analysis.summary
  if (!summary) return []
  const commands = analysis.commands.filter((command) => command.source !== undefined && !command.source.placeholder)
  const found = new Set<Reason>()
  const hit = (reason: Reason) => void found.add(reason)

  const programs = commands.filter((command) => ["pwsh", "powershell"].includes(base(command.head)))
  const expression = commands.some((command) => is(command, INVOKE_EXPRESSION))
  if (expression) hit("invoke-expression")
  if (programs.length > 0) hit("nested-powershell")
  // `-e` and `-ec` are the documented short forms; every longer prefix of the name reaches the same parameter.
  if (programs.some((command) => args(command).some((item) => flag(item) === "ec" || (flag(item).length >= 1 && "encodedcommand".startsWith(flag(item)))))) hit("encoded-command")
  if (expression && commands.some((command) => is(command, DOWNLOADERS))) hit("download-run")
  if (
    commands.some(
      (command) =>
        is(command, set("start-bitstransfer")) ||
        (is(command, set("certutil")) && args(command).some((item) => flag(item).startsWith("urlcache"))) ||
        (is(command, set("bitsadmin")) && args(command).some((item) => flag(item) === "transfer")),
    )
  )
    hit("download-tool")
  if (commands.some((command) => is(command, set("add-type")))) hit("add-type")
  commands.filter((command) => is(command, set("new-object"))).forEach((command) => newObject(command, hit))
  if (
    commands.some(
      (command) => is(command, SCRIPT_FILE) && args(command).some((item) => named(item, "filepath", 1) || named(item, "literalpath", 1) || (positional(item) && item.kind !== "ScriptBlockExpressionAst" && !item.kind.startsWith("Variable"))),
    )
  )
    hit("script-file")
  if (commands.some((command) => is(command, set("invoke-item", "ii")))) hit("invoke-item")
  if (commands.some((command) => is(command, SCHEDULED) || (is(command, set("schtasks")) && args(command).some((item) => ["create", "change"].includes(flag(item)))))) hit("scheduled-task")
  if (commands.some((command) => is(command, FOR_EACH) && args(command).some((item) => named(item, "membername", 1) || (positional(item) && item.kind === "StringConstantExpressionAst")))) hit("member-name")
  commands.filter((command) => is(command, START_PROCESS)).forEach((command) => startProcess(command, hit))

  if (summary.statements.some((statement) => statement.scriptBlock)) {
    if (commands.some((command) => is(command, SCRIPT_BLOCK_RUNNERS)) || !commands.every((command) => is(command, FILTERS))) hit("script-block")
  }
  if (summary.statements.some((statement) => statement.subexpression)) hit("subexpression")
  if (summary.statements.some((statement) => statement.expandable)) hit("expandable-string")
  if (summary.variables.some((variable) => variable.splatted)) hit("splatting")
  if (summary.stopParsing) hit("stop-parsing")
  if (summary.statements.some((statement) => statement.memberAccess)) hit("member-access")
  if (summary.types.some((type) => !ClmTypes.allowed(type))) hit("type-literal")
  if (environment(summary, commands)) hit("env-write")
  if (commands.some((command) => is(command, MODULES))) hit("module")
  if (commands.some((command) => is(command, MUTATORS))) hit("alias-variable")
  if (commands.some((command) => is(command, WMI))) hit("wmi")
  if (summary.usings.length > 0) hit("using")
  if (summary.requires) hit("requires")
  return [...found]
}

// A write to `env:`: an environment variable next to a cmdlet that writes, or next to an assignment; or a writing cmdlet
// whose constant path starts with `env:` (the provider spelling).
function environment(summary: PowerShellParse.Summary, commands: Command[]) {
  const writers = commands.filter((command) => is(command, ENV_WRITERS))
  if (summary.variables.some((variable) => variable.scope === "env") && (writers.length > 0 || summary.statements.some((statement) => statement.assignment))) return true
  return writers.some((command) => args(command).some((item) => (item.bound ?? text(item)).replace(/^["']/, "").toLowerCase().startsWith("env:")))
}

// `New-Object` builds any .NET type or COM object. COM is always asked; a .NET type is allowed only on Constrained Language
// Mode's list. The type is `-TypeName`, or the first positional argument once the parameters that take a value are skipped.
function newObject(command: Command, hit: (reason: Reason) => void) {
  const given = args(command)
  if (given.some((item) => named(item, "comobject", 3))) return hit("com-object")
  let type: string | undefined
  for (let index = 0; index < given.length; index++) {
    const item = given[index]
    if (named(item, "typename", 1)) {
      type = item.bound ?? (given[index + 1] && positional(given[index + 1]) ? text(given[index + 1]) : undefined)
      break
    }
    if (item.param !== undefined) {
      if (item.bound === undefined && (named(item, "argumentlist", 1) || named(item, "property", 1))) index++
      continue
    }
    type = text(item)
    break
  }
  if (type === undefined || !ClmTypes.allowed(type.replace(/^\[|\]$/g, ""))) hit("new-object-type")
}

// `Start-Process -Verb RunAs` asks Windows for administrator rights, in any spelling; a PowerShell program among the
// arguments starts a PowerShell whose script Orbit cannot read.
function startProcess(command: Command, hit: (reason: Reason) => void) {
  const given = args(command)
  const verbs = given.flatMap((item, index) => (named(item, "verb", 1) ? [item.bound ?? text(given[index + 1] ?? item)] : []))
  if (verbs.some((verb) => NORMALIZED(verb).includes("runas")) || (verbs.length > 0 && given.some((item) => NORMALIZED(text(item)) === "runas"))) hit("elevation")
  if (given.some((item) => ["pwsh", "powershell"].includes(base(NORMALIZED(item.bound ?? text(item)))))) hit("start-powershell")
}
