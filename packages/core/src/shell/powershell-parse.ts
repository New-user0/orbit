export * as PowerShellParse from "./powershell-parse.js"

import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Context, Deferred, Duration, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import fs from "node:fs"
import os from "node:os"
import { which } from "../util/which.js"

// Orbit never tokenizes PowerShell itself to learn what a command does. It asks PowerShell's own parser, reads back a
// summary of the syntax tree and decides everything in TypeScript from that summary. The parser resolves comments,
// backtick continuations, member access split across lines and expressions inside arguments and redirects, so none of
// them reaches hand-written code. When no clean parse can be had, the answer is `{ valid: false, reason }`, and a caller
// treats that as "ask". This module only describes; it never decides that a command is allowed.

// transient reasons are not cached, because a later attempt can succeed. The others describe the text itself.
export type Reason = "no-host" | "spawn" | "timeout" | "exit" | "empty" | "json" | "too-long" | "parse-errors"
const TRANSIENT: ReadonlySet<Reason> = new Set(["no-host", "spawn", "timeout", "exit", "empty", "json"])

export type Redirect = {
  kind: "file" | "merge"
  // ">" ">>" "2>" "*>>" and so on for a file; "<from>&<to>" stream names for a merge such as 2>&1.
  operator: string
  // Source text of the target. A merge has none.
  target?: string
  // File redirect only: the target is the variable $null (or ${null}), which discards the output.
  nullSink?: boolean
  text: string
}
export type Argument = {
  // AST kind, for example StringConstantExpressionAst, VariableExpressionAst or CommandParameterAst.
  kind: string
  text: string
  // Set when the parser folded the argument to a constant: quotes removed and backtick escapes resolved.
  value?: string
  // CommandParameterAst only: the parameter name without its dash, and the value bound with -Name:value.
  parameter?: string
  bound?: { kind: string; text: string; value?: string }
}
export type CommandClass = "cmdlet" | "application" | "unknown"
export type Command = {
  // Lower case, with aliases resolved, a module qualifier removed and an executable extension removed (bare names only).
  name: string
  // The name as written in the source.
  written: string
  class: CommandClass
  // Not a command at all: a statement or pipeline element that is an expression. Its name is its whole text, so it can
  // never match an allowlist entry.
  placeholder: boolean
  text: string
  // `&` or `.` when the command is invoked through the call or dot-source operator.
  operator?: "&" | "."
  // True for a command inside a script block, a subexpression, a parenthesis, an if or for body, a trap or a function.
  nested: boolean
  arguments: Argument[]
  redirects: Redirect[]
}
export type Element = { kind: "command" | "expression" | "parenthesized"; text: string; command: Command }
export type Statement = {
  // AST kind of the statement, for example PipelineAst, AssignmentStatementAst or IfStatementAst.
  kind: string
  text: string
  // Belongs to the script itself rather than to a nested script block.
  top: boolean
  // Pipeline elements; a statement that is not a pipeline has one placeholder command.
  elements: Element[]
  // Every file or merging redirect anywhere under the statement, nested expressions included.
  redirects: Redirect[]
  memberAccess: boolean
  subexpression: boolean
  expandable: boolean
  scriptBlock: boolean
  assignment: boolean
}
export type Variable = { name: string; scope: string; splatted: boolean }
export type Using = { kind: string; name?: string }
export type Summary = {
  statements: Statement[]
  // Every command node at any depth, nested ones included. Placeholders (a statement or pipeline element that is not a
  // command, such as [IO.File]::Delete('x')) are not here: they live only in statements[].elements[].command, so an
  // allowlist check must walk the statements' elements, not only this list.
  commands: Command[]
  variables: Variable[]
  types: string[]
  // --% in any dash spelling.
  stopParsing: boolean
  usings: Using[]
  requires: boolean
}
export type Result = { valid: true; summary: Summary } | { valid: false; reason: Reason }

export interface Interface {
  readonly parse: (text: string) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/PowerShellParse") {}

// The tree walk. __TEXT__ is replaced by the command text as UTF-8 base64, whose alphabet cannot close a quote. The
// script parses and reads; it never runs, imports or evaluates anything from the text. PowerShell 5.1 collapses a
// one-element array to a plain object and an empty one to nothing, which `normalize` below undoes.
const PLACEHOLDER = "__TEXT__"
export const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__TEXT__'))
$tokens = $null
$errors = $null
$root = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
function K($n) { $n.GetType().Name }
function Under($n) { @($n.FindAll({ param($x) $true }, $true)) }
function Is($n, $names) { $names -contains $n.GetType().Name }
function Value($n) { if ($n -is [System.Management.Automation.Language.ConstantExpressionAst]) { return [string]$n.Value }; return $null }
function Redirect($n) {
  if ($n -is [System.Management.Automation.Language.FileRedirectionAst]) {
    $s = @{ Output = ''; All = '*'; Error = '2'; Warning = '3'; Verbose = '4'; Debug = '5'; Information = '6' }[[string]$n.FromStream]
    $null_ = ($n.Location -is [System.Management.Automation.Language.VariableExpressionAst]) -and ($n.Location.VariablePath.UserPath -eq 'null')
    [ordered]@{ kind = 'file'; operator = $(if ($n.Append) { $s + '>>' } else { $s + '>' }); target = $n.Location.Extent.Text; nullSink = [bool]$null_; text = $n.Extent.Text }
  } else {
    [ordered]@{ kind = 'merge'; operator = [string]$n.FromStream + '>&' + [string]$n.ToStream; text = $n.Extent.Text }
  }
}
$all = Under $root
$cmds = @($all | Where-Object { $_ -is [System.Management.Automation.Language.CommandAst] })
$statements = @()
$direct = @()
foreach ($b in @($all | Where-Object { $_ -is [System.Management.Automation.Language.ScriptBlockAst] })) {
  $top = [object]::ReferenceEquals($b, $root)
  $list = @()
  foreach ($nb in @($b.BeginBlock, $b.ProcessBlock, $b.EndBlock, $b.CleanBlock, $b.DynamicParamBlock)) {
    if ($nb) { $list += @($nb.Statements); $list += @($nb.Traps) }
  }
  if ($b.ParamBlock) { $list += $b.ParamBlock }
  foreach ($s in $list) { if ($s) { $statements += [pscustomobject]@{ n = $s; top = $top } } }
}
$out = @()
foreach ($e in $statements) {
  $s = $e.n
  $d = Under $s
  $els = @()
  if ($s -is [System.Management.Automation.Language.PipelineAst]) {
    foreach ($p in @($s.PipelineElements)) {
      $i = -1
      if ($p -is [System.Management.Automation.Language.CommandAst]) { $i = [array]::IndexOf($cmds, $p); if ($e.top) { $direct += $i } }
      $paren = ($p -is [System.Management.Automation.Language.CommandExpressionAst]) -and ($p.Expression -is [System.Management.Automation.Language.ParenExpressionAst])
      $els += [ordered]@{ kind = $(if ($paren) { 'parenthesized' } elseif ($i -ge 0) { 'command' } else { 'expression' }); text = $p.Extent.Text; command = $i }
    }
  }
  $out += [ordered]@{
    kind = K $s; text = $s.Extent.Text; top = $e.top; elements = $els
    redirects = @($d | Where-Object { $_ -is [System.Management.Automation.Language.RedirectionAst] } | ForEach-Object { Redirect $_ })
    memberAccess = [bool]@($d | Where-Object { $_ -is [System.Management.Automation.Language.MemberExpressionAst] }).Count
    subexpression = [bool]@($d | Where-Object { Is $_ @('SubExpressionAst', 'ArrayExpressionAst', 'ParenExpressionAst') }).Count
    expandable = [bool]@($d | Where-Object { $_ -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }).Count
    scriptBlock = [bool]@($d | Where-Object { $_ -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }).Count
    assignment = [bool]@($d | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] }).Count
  }
}
$commands = @()
for ($c = 0; $c -lt $cmds.Count; $c++) {
  $n = $cmds[$c]
  $args1 = @()
  for ($i = 1; $i -lt $n.CommandElements.Count; $i++) {
    $a = $n.CommandElements[$i]
    if ($a -is [System.Management.Automation.Language.CommandParameterAst]) {
      $v = $a.Argument
      $bound = $null
      if ($v) { $bound = [ordered]@{ kind = K $v; text = $v.Extent.Text; value = Value $v } }
      $args1 += [ordered]@{ kind = 'CommandParameterAst'; text = $a.Extent.Text; parameter = $a.ParameterName; bound = $bound }
    } else {
      $args1 += [ordered]@{ kind = K $a; text = $a.Extent.Text; value = Value $a }
    }
  }
  $commands += [ordered]@{
    name = $n.GetCommandName(); written = $n.CommandElements[0].Extent.Text; text = $n.Extent.Text
    operator = [string]$n.InvocationOperator; nested = -not ($direct -contains $c)
    arguments = $args1; redirects = @($n.Redirections | ForEach-Object { Redirect $_ })
  }
}
$stop = [bool]@($tokens | Where-Object { $_.Text -match '^[-\u2013\u2014\u2015]{2}%' }).Count
$summary = [ordered]@{
  errors = @($errors | ForEach-Object { [string]$_.Message })
  statements = $out
  commands = $commands
  variables = @($all | Where-Object { $_ -is [System.Management.Automation.Language.VariableExpressionAst] } | ForEach-Object {
    $p = $_.VariablePath
    [ordered]@{ name = $p.UserPath; scope = $(if ($p.IsDriveQualified) { [string]$p.DriveName } elseif ($p.IsGlobal) { 'global' } elseif ($p.IsScript) { 'script' } elseif ($p.IsPrivate) { 'private' } elseif ($p.IsLocal) { 'local' } else { '' }); splatted = [bool]$_.Splatted }
  })
  types = @($all | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.TypeExpressionAst] -or $_ -is [System.Management.Automation.Language.TypeConstraintAst]) { $_.TypeName.FullName }
    elseif ($_ -is [System.Management.Automation.Language.ConvertExpressionAst]) { $_.Type.TypeName.FullName }
    elseif ($_ -is [System.Management.Automation.Language.AttributeAst]) { $_.TypeName.FullName }
  })
  stopParsing = $stop
  usings = @($all | Where-Object { $_ -is [System.Management.Automation.Language.UsingStatementAst] } | ForEach-Object { [ordered]@{ kind = [string]$_.UsingStatementKind; name = $_.Name.Extent.Text } })
  requires = [bool]$root.ScriptRequirements
}
$json = ConvertTo-Json -InputObject $summary -Compress -Depth 10
[Console]::Out.Write([regex]::Replace($json, '[^\u0020-\u007E]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
`
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n")

// On Windows the host takes the whole script on its command line, which the system caps at 32,767 characters. The text
// goes through two base64 layers (UTF-8 inside the script, then UTF-16LE for -EncodedCommand), so ask whether the
// encoded command still fits instead of guessing a text length. Elsewhere a fixed byte cap is plenty.
const WINDOWS_COMMAND_LINE = 32_767
// Room for the host path (up to 260 characters), the flags and their quoting.
const WINDOWS_RESERVE = 400
const OTHER_CAP_BYTES = 4_500

export function encodedLength(bytes: number) {
  const script = SCRIPT.length - PLACEHOLDER.length + Math.ceil(bytes / 3) * 4
  return Math.ceil((script * 2) / 3) * 4
}

export function fits(text: string, platform: NodeJS.Platform = process.platform) {
  const bytes = Buffer.byteLength(text)
  if (platform !== "win32") return bytes <= OTHER_CAP_BYTES
  return encodedLength(bytes) <= WINDOWS_COMMAND_LINE - WINDOWS_RESERVE
}

const DEFAULT_TIMEOUT_MS = 5_000
const CACHE_SIZE = 256

function timeoutFromEnv() {
  const value = Number(process.env.ORBIT_PWSH_PARSE_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

// A launcher such as the snap shim starts a confined copy through a daemon and can hang without a terminal, so it is
// not a usable host. The real binary is looked for in the places the packages install it.
const REAL_LINUX_HOSTS = ["/opt/microsoft/powershell/7/pwsh", "/usr/local/microsoft/powershell/7/pwsh"]

export function isLauncher(file: string, platform: NodeJS.Platform = process.platform) {
  return platform === "linux" && file.startsWith("/snap/")
}

function realPath(file: string) {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

// A link such as /usr/bin/pwsh that points at the snap shim is the shim, so the test is made on the real path.
export function usableHost(
  first: string | null,
  options: { platform?: NodeJS.Platform; real?: (file: string) => string; exists?: (file: string) => boolean } = {},
) {
  const platform = options.platform ?? process.platform
  const real = options.real ?? realPath
  if (first && !isLauncher(real(first), platform)) return first
  if (platform !== "linux") return first
  const exists = options.exists ?? fs.existsSync
  return REAL_LINUX_HOSTS.find((candidate) => exists(candidate) && !isLauncher(real(candidate), platform)) ?? null
}

let found: string | null | undefined
// PATH only, never the working folder: which() skips it (class 10). Cached for the life of the process.
export function findHost() {
  if (found !== undefined) return found ?? undefined
  found = hostFrom(which)
  return found ?? undefined
}

// The choice itself, with the lookup and platform injectable so a test can pin the fallback.
export function hostFrom(lookup: (name: string) => string | null, options: Parameters<typeof usableHost>[1] = {}) {
  const platform = options.platform ?? process.platform
  const first = lookup("pwsh") ?? (platform === "win32" ? lookup("powershell") : null)
  return usableHost(first, options)
}

// For tests: look the host up again, as a new process would.
export function forgetHost() {
  found = undefined
}

export type Options = {
  // The host program; absent means none. Defaults to a PATH lookup of pwsh, then powershell on Windows.
  host?: () => string | undefined
  timeout?: Duration.Duration
  platform?: NodeJS.Platform
}

export function layerWith(options: Options = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const host = options.host ?? findHost
      const platform = options.platform ?? process.platform
      const timeout = options.timeout ?? Duration.millis(timeoutFromEnv())
      // Pending and finished results by exact text, oldest first, so concurrent callers share one process.
      const cache = new Map<string, Deferred.Deferred<Result>>()

      const attempt = (program: string, text: string) =>
        Effect.gen(function* () {
          const script = SCRIPT.replace(PLACEHOLDER, Buffer.from(text, "utf8").toString("base64"))
          const encoded = Buffer.from(script, "utf16le").toString("base64")
          const handle = yield* spawner.spawn(
            ChildProcess.make(program, ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded], {
              // A neutral folder: the project is never the working folder of the parser.
              cwd: os.tmpdir(),
              stdin: "ignore",
            }),
          )
          const [output, , code] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.runDrain),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return { output, code: Number(code) }
        }).pipe(
          Effect.scoped,
          Effect.timeout(timeout),
          Effect.map((done): Result => interpret(done.code, done.output)),
          Effect.catchTag("TimeoutError", () => Effect.succeed<Result>({ valid: false, reason: "timeout" })),
          // Any failure, a defect such as a synchronous throw while starting the process included, is a failed run.
          Effect.catchCause(() => Effect.succeed<Result>({ valid: false, reason: "spawn" })),
        )

      const run = (text: string): Effect.Effect<Result> =>
        Effect.gen(function* () {
          if (!fits(text, platform)) return { valid: false, reason: "too-long" } satisfies Result
          const program = host()
          if (!program) return { valid: false, reason: "no-host" } satisfies Result
          const first = yield* attempt(program, text)
          // Only a timeout is retried; a host that answered with a failure would answer the same way again.
          if (first.valid || first.reason !== "timeout") return first
          return yield* attempt(program, text)
        })

      const parse = (text: string) =>
        Effect.gen(function* () {
          const hit = cache.get(text)
          if (hit) {
            cache.delete(text)
            cache.set(text, hit)
            return yield* Deferred.await(hit)
          }
          const pending = Deferred.makeUnsafe<Result>()
          cache.set(text, pending)
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
          // Detached, so a caller that stops waiting does not strand the others that share this process.
          yield* run(text).pipe(
            Effect.catchCause(() => Effect.succeed<Result>({ valid: false, reason: "spawn" })),
            Effect.tap((result) =>
              Effect.sync(() => {
                if (!result.valid && TRANSIENT.has(result.reason) && cache.get(text) === pending) cache.delete(text)
              }),
            ),
            Effect.flatMap((result) => Deferred.succeed(pending, result)),
            Effect.forkDetach,
          )
          return yield* Deferred.await(pending)
        })

      return Service.of({ parse })
    }),
  )
}

export const node = makeGlobalNode({ service: Service, layer: layerWith(), deps: [CrossSpawnSpawner.node] })

// What a finished host run means. Exported for tests that feed it a recorded run.
export function interpret(code: number, output: string): Result {
  if (code !== 0) return { valid: false, reason: "exit" }
  if (!output.trim()) return { valid: false, reason: "empty" }
  const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(output)
  if (json._tag === "None") return { valid: false, reason: "json" }
  const raw = Schema.decodeUnknownOption(Raw)(json.value)
  if (raw._tag === "None") return { valid: false, reason: "json" }
  if (many(raw.value.errors).length > 0) return { valid: false, reason: "parse-errors" }
  return { valid: true, summary: normalize(raw.value) }
}

// The shape the script writes. A field that PowerShell 5.1 collapses may arrive as one value, a list, or nothing.
const optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))
const list = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(Schema.Union([Schema.Array(schema), schema])))

const RawRedirect = Schema.Struct({
  kind: Schema.Literals(["file", "merge"]),
  operator: Schema.String,
  target: optional(Schema.String),
  nullSink: optional(Schema.Boolean),
  text: Schema.String,
})
const RawValue = Schema.Struct({ kind: Schema.String, text: Schema.String, value: optional(Schema.String) })
const RawArgument = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  value: optional(Schema.String),
  parameter: optional(Schema.String),
  bound: optional(RawValue),
})
const RawCommand = Schema.Struct({
  name: optional(Schema.String),
  written: Schema.String,
  text: Schema.String,
  operator: optional(Schema.String),
  nested: Schema.Boolean,
  arguments: list(RawArgument),
  redirects: list(RawRedirect),
})
const RawElement = Schema.Struct({
  kind: Schema.Literals(["command", "expression", "parenthesized"]),
  text: Schema.String,
  command: Schema.Number,
})
const RawStatement = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  top: Schema.Boolean,
  elements: list(RawElement),
  redirects: list(RawRedirect),
  memberAccess: Schema.Boolean,
  subexpression: Schema.Boolean,
  expandable: Schema.Boolean,
  scriptBlock: Schema.Boolean,
  assignment: Schema.Boolean,
})
const Raw = Schema.Struct({
  errors: list(Schema.String),
  statements: list(RawStatement),
  commands: list(RawCommand),
  variables: list(Schema.Struct({ name: Schema.String, scope: Schema.String, splatted: Schema.Boolean })),
  types: list(Schema.String),
  stopParsing: Schema.Boolean,
  usings: list(Schema.Struct({ kind: Schema.String, name: optional(Schema.String) })),
  requires: Schema.Boolean,
})
type RawSummary = Schema.Schema.Type<typeof Raw>
type RawCommandType = Schema.Schema.Type<typeof RawCommand>
type RawRedirectType = Schema.Schema.Type<typeof RawRedirect>

// Windows PowerShell 5.1 turns a one-element array into the element itself and an empty one into nothing.
function many<A>(value: A | ReadonlyArray<A> | null | undefined): A[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? [...value] : [value as A]
}

function normalize(raw: RawSummary): Summary {
  const commands = many(raw.commands).map(command)
  return {
    statements: many(raw.statements).map((statement) => ({
      kind: statement.kind,
      text: statement.text,
      top: statement.top,
      elements: elements(statement, commands),
      redirects: many(statement.redirects).map(redirect),
      memberAccess: statement.memberAccess,
      subexpression: statement.subexpression,
      expandable: statement.expandable,
      scriptBlock: statement.scriptBlock,
      assignment: statement.assignment,
    })),
    commands,
    variables: many(raw.variables),
    types: [...new Set(many(raw.types))],
    stopParsing: raw.stopParsing,
    usings: many(raw.usings).map((using) => ({ kind: using.kind, ...(using.name ? { name: using.name } : {}) })),
    requires: raw.requires,
  }
}

function elements(statement: Schema.Schema.Type<typeof RawStatement>, commands: Command[]): Element[] {
  const list = many(statement.elements)
  // A statement that is not a pipeline (an assignment, if, for, ...) is one placeholder command: its whole text.
  if (list.length === 0) return [{ kind: "expression", text: statement.text, command: placeholder(statement.text) }]
  return list.map((element) => ({
    kind: element.kind,
    text: element.text,
    command: commands[element.command] ?? placeholder(element.text),
  }))
}

function placeholder(text: string): Command {
  return { name: text, written: text, class: "unknown", placeholder: true, text, nested: false, arguments: [], redirects: [] }
}

function redirect(raw: RawRedirectType): Redirect {
  return {
    kind: raw.kind,
    operator: raw.operator,
    ...(raw.target ? { target: raw.target } : {}),
    ...(raw.nullSink ? { nullSink: true } : {}),
    text: raw.text,
  }
}

function command(raw: RawCommandType): Command {
  return {
    ...classify(raw.name ?? undefined, raw.written),
    placeholder: false,
    text: raw.text,
    // The parser names the operator: Ampersand, Dot, or Unknown when the command has none.
    ...(raw.operator === "Ampersand" ? { operator: "&" as const } : raw.operator === "Dot" ? { operator: "." as const } : {}),
    nested: raw.nested,
    arguments: many(raw.arguments).map((argument) => ({
      kind: argument.kind,
      text: argument.text,
      ...(argument.value !== null && argument.value !== undefined ? { value: argument.value } : {}),
      // The parser keeps a backtick escape in a parameter name (-Rec`urse is -Recurse), so resolve it here.
      ...(argument.parameter ? { parameter: argument.parameter.replace(/`(.)/gs, "$1") } : {}),
      ...(argument.bound
        ? {
            bound: {
              kind: argument.bound.kind,
              text: argument.bound.text,
              ...(argument.bound.value !== null && argument.bound.value !== undefined
                ? { value: argument.bound.value }
                : {}),
            },
          }
        : {}),
    })),
    redirects: many(raw.redirects).map(redirect),
  }
}

// The aliases Orbit resolves, written here rather than asked of a host, so the answer does not depend on the PowerShell
// edition or on a profile. Left out on purpose: sc, sort, curl, wget, compare and diff, which are native programs on PowerShell 7
// for Linux and macOS.
// An alias that is not here stays unknown and so never matches an allowlist.
const ALIASES = new Map(
  Object.entries({
    "Get-ChildItem": "ls dir gci",
    "Get-Content": "cat gc type",
    "Set-Location": "cd sl chdir",
    "Get-Location": "pwd gl",
    "Write-Output": "echo write",
    "Remove-Item": "rm del erase rd ri rmdir",
    "Copy-Item": "cp copy cpi",
    "Move-Item": "mv move mi",
    "New-Item": "ni md mkdir",
    "Clear-Host": "cls clear",
    "Get-Member": "gm",
    "Select-Object": "select",
    "Where-Object": "where ?",
    "ForEach-Object": "foreach %",
    "Group-Object": "group",
    "Measure-Object": "measure",
    "Format-Table": "ft",
    "Format-List": "fl",
    "Format-Wide": "fw",
    "Out-Host": "oh",
    "Get-Command": "gcm",
    "Get-Process": "gps ps",
    "Stop-Process": "kill spps",
    "Get-Service": "gsv",
    "Start-Service": "sasv",
    "Start-Process": "saps start",
    "Start-Sleep": "sleep",
    "Invoke-Expression": "iex",
    "Invoke-Command": "icm",
    "Invoke-Item": "ii",
    "Invoke-RestMethod": "irm",
    "Invoke-WebRequest": "iwr",
    "Set-Variable": "set sv",
    "Get-Variable": "gv",
    "Set-Item": "si",
    "Get-Item": "gi",
    "Get-ItemProperty": "gp",
    "Set-ItemProperty": "sp",
    "Clear-Content": "clc",
    "Add-Content": "ac",
    "Get-History": "h history ghy",
    "Get-Help": "man help",
    "Get-Alias": "gal",
    "Set-Alias": "sal",
    "New-Alias": "nal",
    "Export-Alias": "epal",
    "Import-Alias": "ipal",
    "Get-Unique": "gu",
    "Tee-Object": "tee",
    "Push-Location": "pushd",
    "Pop-Location": "popd",
    "Rename-Item": "rni ren",
    "Resolve-Path": "rvpa",
    "Select-String": "sls",
    "Get-ItemPropertyValue": "gpv",
    "Import-Module": "ipmo",
    "Start-Job": "sajb",
    "New-PSSession": "nsn",
    "Enter-PSSession": "etsn",
    "Exit-PSSession": "exsn",
    "Get-PSSession": "gsn",
    "Remove-PSSession": "rsn",
    "Out-GridView": "ogv",
    "Export-Csv": "epcsv",
    "Remove-ItemProperty": "rp",
    "Clear-Item": "cli",
  }).flatMap(([cmdlet, names]) => names.split(" ").map((alias) => [alias, cmdlet.toLowerCase()] as const)),
)

const EXTENSIONS = /\.(exe|cmd|bat|com)$/i
// A module qualifier (Module\Name) makes the command a path, so the class is decided on the name as written: Windows
// PowerShell 5.1 runs a script file of that path in the working folder before it looks for the cmdlet. For the name
// only, any module qualifier is dropped, so a deny rule on remove-item also meets Foo\Remove-Item. A drive, a UNC path
// and .\ or ..\ are paths, not modules, so a qualifier must start with a letter, digit or underscore.
const QUALIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.]*\\(?=[A-Za-z]+-[A-Za-z0-9]+$)/
const CMDLET = /^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/

function classify(name: string | undefined, written: string): Pick<Command, "name" | "written" | "class"> {
  // GetCommandName is null for a computed name such as & $x; the source text is then the best description.
  const given = (name ?? written).replace(/^(["'])(.*)\1$/s, "$2")
  // A dot, a path separator or a character outside ASCII (a look-alike letter) means a program, never a cmdlet.
  const program = /[./\\]|[^\x00-\x7f]/.test(given)
  // An extension comes off a bare name only: C:\tools\git.exe stays as written.
  const lower = (/[\\/]/.test(given) ? given.replace(QUALIFIER, "") : given.replace(EXTENSIONS, "")).toLowerCase()
  if (program) return { name: lower, written, class: "application" }
  if (name === undefined) return { name: lower, written, class: "unknown" }
  return {
    name: ALIASES.get(lower) ?? lower,
    written,
    class: ALIASES.has(lower) || CMDLET.test(lower) ? "cmdlet" : "unknown",
  }
}
