export * as ShellGuard from "./guard.js"

import { FSUtil } from "@orbit/util/fs-util"
import { Effect, Option } from "effect"
import path from "node:path"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { aliasNames, aliasTarget, LOCATION, type Analysis, type Command, type Context } from "./analysis.js"
import { ShellParse } from "./parse.js"
import type { PowerShellParse } from "./powershell-parse.js"
import { ShellPaths } from "./paths.js"
import { ShellSafety } from "./safety.js"
import { ShellWrappers } from "./wrappers.js"

// The effectful half of the shell permission check. The analysis says which files a command names and what it does to
// them; the safety checks describe what no rule may lift. This module puts the disk between them: it resolves every named
// place to where it really is (links followed, a new file under a link judged where the write would land), decides which
// places are outside the project, probes the folders git would discover, and builds the requests the tool makes from
// the analysis. It decides nothing about a person's rules, and it never fails the call: whatever it cannot resolve is an
// `unresolved` place with a finding (class 7). It opens no share and starts no process (class 6).

const WRITES = new Set<ShellPaths.Role>(["remove", "write", "create"])
const CD = new Set(["cd", "chdir", "pushd", "popd", "set-location", "push-location", "pop-location"])

export type Place = {
  /** 0 for the input itself, n for the n-th nested script. */
  level: number
  role: ShellPaths.Role
  status: "internal" | "external" | "unresolved"
  why?: "share" | "device" | "stream" | "dynamic" | "refused"
  /** Where each candidate spelling really leads. */
  real: string[]
}

export type Probe = { action: "Read" | "Edit"; resources: string[] }

export type Facts = {
  places: Place[]
  /** The targets outside the project, as the real place they reach, first seen first. */
  external: FileAccess.Target[]
  /** Deny-only checks of the person's Read and Edit rules against the places the command names. */
  probes: Probe[]
  bare: NonNullable<ShellSafety.GuardFacts["bare"]>
  findings: ShellSafety.Finding[]
}

export type Input = {
  analysis: Analysis
  /** The command as it will run, for the checks that read its text. */
  text: string
  ctx: Context
  cwd: FileAccess.Target
  /** Folders the command changes to that the scanner found, absolute, beyond what the analysis lists. */
  directories: readonly string[]
  /** The folders the command may write when it runs inside the sandbox. Unset when it runs without one. */
  writable?: readonly string[]
}

const isPowerShell = (analysis: Analysis) => analysis.dialect === "powershell-5.1" || analysis.dialect === "pwsh"

type Level = { analysis: Analysis; text: string; depth: number }

function levels(analysis: Analysis, text: string, depth = 0): Level[] {
  return [
    { analysis, text, depth },
    ...(analysis.nested ?? []).flatMap((item) => levels(item.analysis, item.text, depth + 1)),
  ]
}

export const facts = Effect.fn("ShellGuard.facts")(function* (input: Input) {
  const access = yield* FileAccess.Service
  const trust = yield* ProjectTrust.Service
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const ps = isPowerShell(input.analysis)
  const all = levels(input.analysis, input.text)
  const folders = yield* Effect.forEach([location.directory, location.project.directory], fs.resolve)
  const roots = yield* Effect.forEach(input.writable ?? [], fs.resolve)

  type Spec = {
    candidates: readonly string[]
    kind: FileAccess.Kind
    role: ShellPaths.Role
    /** A bash removal takes the link away, not what it points to. */
    removal: boolean
    level: number
  }
  type Resolved = Place & {
    resources: { action: "Read" | "Edit"; resource: string }[]
    external: FileAccess.Target[]
  }

  const resolveCandidate = Effect.fnUntraced(function* (candidate: string, spec: Spec) {
    const lexical = Option.getOrUndefined(yield* access.resolve({ path: candidate, kind: spec.kind }).pipe(Effect.option))
    const leads = spec.removal
      ? path.join(yield* trust.leads(path.dirname(candidate)), path.basename(candidate))
      : yield* trust.leads(candidate)
    const inside = folders.some((folder) => FSUtil.contains(folder, leads))
    const sandboxed = WRITES.has(spec.role) && roots.some((root) => FSUtil.contains(root, leads))
    const internal = sandboxed || (lexical !== undefined && lexical.externalDirectory === undefined && inside)
    const actual =
      leads === candidate || lexical === undefined
        ? lexical
        : Option.getOrUndefined(yield* access.resolve({ path: leads, kind: spec.kind }).pipe(Effect.option))
    const reached = actual?.externalDirectory ? actual : lexical?.externalDirectory ? lexical : undefined
    return {
      real: leads,
      internal,
      external: internal ? undefined : reached,
      unresolved: !internal && reached === undefined,
      targets: [lexical, actual].flatMap((target) => (target ? [target.resource] : [])),
    }
  })

  const resolvePlace = Effect.fnUntraced(function* (spec: Spec, skip?: Place["why"]): Effect.fn.Return<Resolved> {
    if (skip !== undefined || spec.candidates.length === 0)
      return { level: spec.level, role: spec.role, status: "unresolved", why: skip ?? "dynamic", real: [], resources: [], external: [] }
    const found = yield* Effect.forEach(spec.candidates, (candidate) => resolveCandidate(candidate, spec))
    const external = found.flatMap((item) => (item.external ? [item.external] : []))
    const refused = found.some((item) => item.unresolved)
    const actions: ("Read" | "Edit")[] =
      spec.role === "read" ? ["Read"] : spec.role === "source" ? ["Read", "Edit"] : ["Edit"]
    return {
      level: spec.level,
      role: spec.role,
      status: refused ? "unresolved" : external.length > 0 ? "external" : "internal",
      ...(refused ? { why: "refused" as const } : {}),
      real: found.map((item) => item.real),
      resources: actions.flatMap((action) =>
        [...new Set(found.flatMap((item) => item.targets))].map((resource) => ({ action, resource })),
      ),
      external,
    }
  })

  const operands = all.flatMap((level) =>
    level.analysis.paths.files.map((operand, file) => ({ level, operand, file })),
  )
  const resolved = yield* Effect.forEach(operands, ({ level, operand }) => {
    const command = level.analysis.commands[operand.command]
    const skip = operand.flags.includes("share")
      ? ("share" as const)
      : operand.flags.includes("device")
        ? ("device" as const)
        : operand.flags.includes("stream")
          ? ("stream" as const)
          : operand.form === "dynamic"
            ? ("dynamic" as const)
            : undefined
    const kind = operand.form === "glob" || operand.flags.includes("directory") || CD.has(command?.head ?? "") ? "directory" : "file"
    return resolvePlace(
      {
        candidates: operand.candidates,
        kind,
        role: operand.role,
        removal: operand.role === "remove" && !ps && operand.form !== "glob" && !/[\\/]\.?$/.test(operand.spelled),
        level: level.depth,
      },
      skip,
    )
  })
  const extra = yield* Effect.forEach(input.directories, (directory) =>
    resolvePlace({ candidates: [directory], kind: "directory", role: "read", removal: false, level: 0 }),
  )
  const everything = [...resolved, ...extra]

  const git = ShellSafety.runsGit(input.analysis, input.ctx.platform)
  const bare = git ? yield* probeGit(all, input.cwd.absolute) : []

  const found = ShellSafety.check(input.analysis, {
    platform: input.ctx.platform,
    path: input.ctx.path,
    home: input.ctx.home,
    cwd: input.ctx.cwd,
    project: location.project.directory,
    location: location.directory,
    env: input.ctx.env,
    text: input.text,
    facts: {
      bare: bare.flatMap((item) => (item.why === "git-dir" || item.why === "indicators" || item.why === "unverified-gitdir" ? [item] : [])),
      real: resolved.flatMap((item, index) => {
        const { level, operand, file } = operands[index]!
        return level.depth === 0 && operand.role === "remove" && operand.form !== "glob" && item.real.length > 0
          ? [{ file, places: item.real }]
          : []
      }),
    },
  })

  return {
    places: everything.map(({ resources: _resources, external: _external, ...place }) => place),
    external: everything.flatMap((item) => item.external),
    probes: everything.flatMap((item) => {
      const actions = [...new Set(item.resources.map((entry) => entry.action))]
      return actions.map((action) => ({
        action,
        resources: item.resources.filter((entry) => entry.action === action).map((entry) => entry.resource),
      }))
    }),
    bare,
    findings: [...found, ...own(all, operands, resolved, ps)].filter(unique),
  } satisfies Facts
})

function unique(finding: ShellSafety.Finding, index: number, list: ShellSafety.Finding[]) {
  return list.findIndex((item) => item.kind === finding.kind && item.reason === finding.reason && item.command === finding.command && item.place === finding.place) === index
}

// The guard's own findings: what the places say that the text alone did not.
function own(
  all: Level[],
  operands: { level: Level; operand: ShellPaths.Operand; file: number }[],
  resolved: { status: Place["status"]; why?: Place["why"] }[],
  ps: boolean,
) {
  const found: ShellSafety.Finding[] = []
  operands.forEach(({ level, operand }, index) => {
    const at = level.depth === 0 ? operand.command : undefined
    const place = resolved[index]!
    const unplaceable = place.status === "unresolved" && (WRITES.has(operand.role) || (place.why !== undefined && place.why !== "dynamic"))
    if (unplaceable) found.push(ShellSafety.finding("too-complex", "unresolved-path", at))
    if (operand.form === "glob" && (WRITES.has(operand.role) || ps)) found.push(ShellSafety.finding("too-complex", "glob-write", at))
    if (ps && operand.flags.includes("provider")) found.push(ShellSafety.finding("provider", "provider-path", at))
  })
  all.forEach((level) => {
    const files = level.analysis.paths
    files.unvalidatable.forEach((item) => found.push(ShellSafety.finding("too-complex", "unvalidatable", level.depth === 0 ? item.command : undefined)))
    if (ps) {
      if (files.directoryChanges > 0 && files.files.some((operand) => !CD.has(level.analysis.commands[operand.command]?.head ?? "")))
        found.push(ShellSafety.finding("directory", "location-path"))
      return
    }
    if (files.directoryChanges > 1) found.push(ShellSafety.finding("directory", "multiple-cd"))
    if (files.directoryChanges > 0 && files.files.some((operand) => WRITES.has(operand.role)))
      found.push(ShellSafety.finding("directory", "cd-write"))
  })
  return found
}

// ---------------------------------------------------------------------------------------------------------------------
// The bare-repository probe

const GITDIR_LIMIT = 4096
const GIT_DIR = /(?:^|[\s;&|(])(?:export\s+)?GIT_DIR=("[^"]*"|'[^']*'|[^\s;&|)]*)/g

// Walks from each folder git could start in up to the root, as git's discovery does, and reports a folder that looks like
// a repository but is not a normal checkout, a `.git` file that points somewhere unverified, and a git directory named on the
// command line. It only stats and reads small `.git` files. It never runs git and never opens a share (class 1, 5, 6).
const probeGit = Effect.fnUntraced(function* (all: Level[], workdir: string) {
  const trust = yield* ProjectTrust.Service
  const fs = yield* FSUtil.Service
  const found: NonNullable<ShellSafety.GuardFacts["bare"]> = []
  const share = (file: string) => process.platform === "win32" && /^[\\/]{2}/.test(file)
  const type = (file: string) =>
    share(file) ? Effect.succeed(undefined) : fs.stat(file).pipe(Effect.map((info) => info.type), Effect.orElseSucceed(() => undefined))
  const same = (left: string, right: string) =>
    process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right

  const bases: string[] = [workdir]
  const named: { base: string; value: string }[] = []
  all.forEach((level) => {
    level.analysis.paths.scopes.forEach((scope) => bases.push(...scope.bases))
    level.analysis.commands.forEach((command, index) => {
      if (!gitProgram(command)) return
      const scope = level.analysis.paths.scopes[index]?.bases ?? [workdir]
      const words = command.argv.slice(command.argv.length - command.inner.length + 1)
      for (let at = 0; at < words.length; at++) {
        const word = words[at]!
        if (!word.value.startsWith("-")) break
        const next = words[at + 1]
        if (word.value === "-C" && next?.literal) {
          bases.push(...scope.map((base) => path.resolve(base, next.value)))
          at++
        } else if (word.value.startsWith("--git-dir=") && word.literal) {
          scope.forEach((base) => named.push({ base, value: word.value.slice("--git-dir=".length) }))
        } else if (word.value === "--git-dir" && next?.literal) {
          scope.forEach((base) => named.push({ base, value: next.value }))
          at++
        } else if (["-c", "--work-tree", "--namespace", "--exec-path"].includes(word.value)) at++
      }
    })
    for (const match of level.text.matchAll(GIT_DIR)) {
      const value = match[1]!.replace(/^(["'])(.*)\1$/, "$2")
      if (/[$`(]/.test(value)) found.push({ base: workdir, why: "git-dir" })
      else named.push({ base: workdir, value })
    }
  })

  const own = new Map<string, string>()
  // Whether the `.git` of a folder is a normal repository directory.
  const normal = (folder: string) => type(path.join(folder, ".git", "HEAD")).pipe(Effect.map((kind) => kind === "File"))

  // The linked worktrees and submodules that git itself makes: the git directory they name must point back at this folder
  // or sit under an enclosing repository's modules folder. Anything else a repository ships is unverified.
  const verified = Effect.fnUntraced(function* (folder: string) {
    const file = path.join(folder, ".git")
    const size = yield* fs.stat(file).pipe(Effect.map((info) => Number(info.size)), Effect.orElseSucceed(() => Infinity))
    if (size > GITDIR_LIMIT) return false
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const line = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text)
    if (!line || share(line[1]!)) return false
    const target = path.resolve(folder, line[1]!)
    const leads = yield* trust.leads(target)
    if (share(leads)) return false
    if (path.basename(path.dirname(leads)) === "worktrees") {
      const back = yield* fs.readFileString(path.join(leads, "gitdir")).pipe(Effect.orElseSucceed(() => ""))
      const wanted = yield* trust.leads(file)
      if (back.trim() !== "" && same(yield* trust.leads(path.resolve(leads, back.trim())), wanted)) return true
    }
    for (let above = path.dirname(folder); ; above = path.dirname(above)) {
      if ((yield* type(path.join(above, ".git"))) === "Directory") {
        const modules = yield* trust.leads(path.join(above, ".git", "modules"))
        if (FSUtil.contains(modules, leads) && !same(modules, leads)) return true
      }
      if (path.dirname(above) === above) return false
    }
  })

  yield* Effect.forEach(
    [...new Set(bases)],
    Effect.fnUntraced(function* (base) {
      for (let folder = yield* trust.leads(base); ; folder = path.dirname(folder)) {
        const entry = yield* type(path.join(folder, ".git"))
        if (entry === "File") {
          if (!(yield* verified(folder))) found.push({ base: folder, why: "unverified-gitdir" })
          if (base === workdir) own.set(folder, path.join(folder, ".git"))
          return
        }
        if (entry === "Directory" && (yield* normal(folder))) {
          if (base === workdir) own.set(folder, yield* trust.leads(path.join(folder, ".git")))
          return
        }
        // No valid `.git` here: any one of these makes git take the folder itself for a repository.
        const indicators = yield* Effect.forEach(["HEAD", "objects", "refs"], (name) => type(path.join(folder, name)))
        if (indicators[0] === "File" || indicators[1] === "Directory" || indicators[2] === "Directory")
          found.push({ base: folder, why: "indicators" })
        if (path.dirname(folder) === folder) return
      }
    }),
  )

  const repository = [...own.values()][0]
  yield* Effect.forEach(named, ({ base, value }) =>
    Effect.gen(function* () {
      const leads = yield* trust.leads(path.resolve(base, value))
      if (repository === undefined || !same(leads, repository)) found.push({ base, why: "git-dir" })
    }),
  )
  return found.filter((item, index) => found.findIndex((other) => other.base === item.base && other.why === item.why) === index)
})

function gitProgram(command: Command) {
  const name = path.basename(command.inner[0] ?? "").toLowerCase().replace(/\.exe$/, "")
  return name === "git"
}

// ---------------------------------------------------------------------------------------------------------------------
// The shell request

export type Request = {
  resources: string[]
  save: string[]
  aliases?: Record<string, string[]>
}

/**
 * What the shell permission request holds for this input, or undefined when the input is inert: only assignments,
 * declarations without substitutions, directory changes and comments. `scan` is the bash scanner's result (the legacy
 * one when the analysis could not read the input).
 */
export function request(analysis: Analysis, text: string, scan: ShellParse.Result | undefined, findings: ShellSafety.Finding[]): Request | undefined {
  const whole = text.trim()
  if (analysis.opaque) return opaque(analysis, whole, scan)
  if (isPowerShell(analysis)) return powershell(analysis, whole, findings)
  const resources = [...(scan?.commands.map((command) => command.resource) ?? []), ...(scan?.bare ?? [])]
  const save = scan?.commands.map((command) => command.save) ?? []
  // The saves stay one per scanned command, as they always were: a client may pair them with the commands.
  if (resources.length > 0) return { resources, save }
  if (findings.length === 0 && inert(analysis)) return undefined
  return { resources: [whole], save: [] }
}

function distinct<A>(list: readonly A[]) {
  return [...new Set(list)]
}

// Input that Orbit cannot analyse is asked about as a whole and as its fragments, with no saved grant: a fragment can deny
// or ask but never lift the whole.
function opaque(analysis: Analysis, whole: string, scan: ShellParse.Result | undefined): Request {
  const ps = isPowerShell(analysis)
  const pieces = ps ? ShellSafety.fragments(whole).map((piece) => piece.replace(/^(["'])(.*?)\1(?=\s|$)/, "$2")) : bashFragments(whole)
  return {
    resources: distinct([whole, ...(scan?.commands.map((command) => command.resource) ?? []), ...(scan?.bare ?? []), ...pieces]).filter((item) => item !== ""),
    save: [],
  }
}

function bashFragments(text: string) {
  return text
    .split(/[;|&\n(){}]/)
    .flatMap((piece) => {
      const words = piece.trim().split(/\s+/).filter(Boolean)
      // Leading `NAME=value` assignments belong to no program.
      const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      const rest = start === -1 ? [] : words.slice(start)
      return [rest.join(" "), ShellWrappers.unwrap(rest).inner.join(" ")]
    })
    .filter((piece) => piece !== "")
}

const DECLARATIONS = new Set(["export", "declare", "typeset", "local", "readonly", "unset", "cd", "chdir", "pushd", "popd"])

function inert(analysis: Analysis) {
  return (
    analysis.dialect === "bash" &&
    analysis.redirects.length === 0 &&
    !analysis.features.substitution &&
    !analysis.features.heredoc &&
    !analysis.features.herestring &&
    analysis.commands.every(
      (command) => DECLARATIONS.has(command.head) && command.redirects.length === 0 && command.argv.every((word) => word.literal),
    )
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// PowerShell: everything comes from PowerShell's own parse

// Programs and cmdlets that an "always" grant must never name: they start other programs, run files or script blocks, load
// code, reach the network, redefine names, or are interpreters.
const NEVER = new Set(
  [
    "pwsh powershell cmd sh bash zsh wsl bun deno node python python3 ruby perl php npx start-process start saps invoke-expression iex",
    "invoke-command icm start-job invoke-item ii import-module ipmo install-module install-package install-script save-module update-module",
    "new-module add-type invoke-webrequest iwr curl wget invoke-restmethod irm start-bitstransfer set-alias sal new-alias nal",
    "set-variable sv new-variable nv remove-variable rv clear-variable clv get-wmiobject gwmi invoke-wmimethod get-ciminstance gcim",
    "invoke-cimmethod new-cimsession foreach-object foreach %",
  ]
    .join(" ")
    .split(" "),
)

function powershell(analysis: Analysis, whole: string, findings: ShellSafety.Finding[]): Request | undefined {
  const summary = analysis.summary
  if (summary === undefined) return { resources: [whole], save: [] }
  const resources: string[] = []
  const save: string[] = []
  const aliases: Record<string, string[]> = {}

  summary.commands
    .filter((command) => !LOCATION.has(command.name))
    .forEach((command) => {
      const resource = command.text.trim()
      resources.push(resource)
      const grant = saved(command)
      if (grant !== undefined) save.push(grant)
      if (command.class === "cmdlet") aliases[resource] = canonical(command, analysis)
      else if (command.class === "application" && command.name !== "" && command.dynamic === false) {
        // An application is never lifted by a rule written for a cmdlet. Its stripped spelling is judged as a resource of its own,
        // so a deny written for the cmdlet still meets it, and an allow cannot.
        const stripped = [command.name, ...command.arguments.map((argument) => argument.text)].join(" ")
        if (stripped !== resource) resources.push(stripped)
      }
    })

  summary.statements
    .filter((statement) => statement.top)
    .forEach((statement) => {
      const text = statement.text.trim()
      const commands = statement.kind === "PipelineAst" && !statement.assignment && statement.elements.every((element) => element.kind === "command")
      if (!commands) {
        resources.push(text)
        if (!/[*?\r\n]/.test(text)) save.push(text)
        return
      }
      // A redirect to a file is asked about as the statement, which no grant for its commands covers.
      if (statement.redirects.some((redirect) => redirect.kind === "file" && redirect.nullSink !== true)) resources.push(text)
    })

  const distinctresources = distinct(resources).filter((item) => item !== "")
  if (distinctresources.length > 0) return { resources: distinctresources, save: distinct(save), ...(Object.keys(aliases).length > 0 ? { aliases } : {}) }
  if (findings.length === 0 && inertPowerShell(summary)) return undefined
  return { resources: [whole], save: [] }
}

function inertPowerShell(summary: PowerShellParse.Summary) {
  if (summary.usings.length > 0 || summary.requires || summary.stopParsing) return false
  return summary.statements
    .filter((statement) => statement.top)
    .every(
      (statement) =>
        statement.redirects.length === 0 &&
        !statement.memberAccess &&
        !statement.subexpression &&
        !statement.expandable &&
        !statement.scriptBlock &&
        (/^\$(?!env:)[A-Za-z_]\w*\s*=\s*(?:'[^']*'|"[^"$`]*"|\d+(?:\.\d+)?|\$(?:true|false|null))$/i.test(statement.text.trim()) ||
          (statement.kind === "PipelineAst" && statement.elements.every((element) => element.kind === "command" && LOCATION.has(element.command.name)))),
    )
}

function strip(name: string) {
  return name.replace(/^(["'])(.*)\1$/, "$2").replace(/^.*\\/, "")
}

// The spellings a rule may be written in for this cmdlet: the name as written without its module qualifier and quotes, the
// cmdlet's own name and each of its aliases here, each followed by the arguments as written, joined by single spaces.
function canonical(command: PowerShellParse.Command, analysis: Analysis) {
  const arguments_ = command.arguments.map((argument) => argument.text)
  const names = distinct([
    strip(command.written),
    command.name,
    ...aliasNames().filter((alias) => aliasTarget(alias, analysis.dialect, process.platform) === command.name),
  ])
  return names.map((name) => [name, ...arguments_].join(" "))
}

// The pattern an "always" reply would save for this command: none for what could run anything.
function saved(command: PowerShellParse.Command) {
  const written = strip(command.written)
  const lower = [command.name, written.toLowerCase()]
  if (command.dynamic || command.placeholder || lower.some((name) => NEVER.has(name))) return undefined
  if (command.class === "cmdlet") return `${written} *`
  if (command.class !== "application" || /[\\/]/.test(command.written) || /\.[A-Za-z0-9]+$/.test(written) || !/^[\w-]+$/.test(written)) return undefined
  const positional: string[] = []
  const words = [written]
  for (const argument of command.arguments) {
    if (argument.parameter !== undefined) continue
    if (argument.kind !== "StringConstantExpressionAst" || argument.value === undefined || /[\s\\]/.test(argument.value)) break
    positional.push(argument.value)
    words.push(argument.value)
  }
  // The sentinel shows a program whose prefix needs more words than the command has: a bare `git` would allow every subcommand.
  const sentinel = ShellParse.prefix([...words, "\u0000"])
  if (sentinel.includes("\u0000")) return undefined
  return `${ShellParse.prefix(words).join(" ")} *`
}

/**
 * The folders that the location commands of a PowerShell parse change to when the argument holds a variable the shell
 * defines for folders (`$HOME`, `$env:NAME`, `$PWD`): the analysis leaves such an operand dynamic, and the person is still
 * asked about the folder it names.
 */
export function expansions(analysis: Analysis, cwd: string, shell: string) {
  return (analysis.summary?.commands ?? [])
    .filter((command) => LOCATION.has(command.name) && command.name !== "new-psdrive" && command.name !== "pop-location")
    .flatMap((command) =>
      command.arguments.flatMap((argument) => {
        const text = argument.parameter === undefined ? argument.text : /^(?:p|l)/i.test(argument.parameter) ? argument.bound?.text : undefined
        const folder = text === undefined ? undefined : ShellParse.directoryArgument(text, true, cwd, shell)
        return folder === undefined ? [] : [folder]
      }),
    )
}

/**
 * The literal words that the commands of a PowerShell parse take as arguments, and the files they redirect to, with
 * parameters left out: what a command may open as a path, for the check that finds a link in an untrusted project that
 * leads out of it. A word the parser could not fold to a constant is not here.
 */
export function words(analysis: Analysis) {
  return (analysis.summary?.statements ?? []).flatMap((statement) => [
    ...statement.elements.flatMap((element) =>
      element.command.arguments.flatMap((argument) =>
        argument.parameter === undefined && argument.value !== undefined && argument.value !== "" ? [argument.value] : [],
      ),
    ),
    ...statement.redirects.flatMap((redirect) => (redirect.value === undefined ? [] : [redirect.value])),
  ])
}

/**
 * The folders that a PowerShell fragment changes to, for input whose parse failed: a fragment that starts with a location
 * command and names a constant place. Absolute or relative as written.
 */
export function locations(text: string, dialect: Analysis["dialect"], platform: NodeJS.Platform) {
  return ShellSafety.fragments(text).flatMap((fragment) => {
    const words = fragment.split(/\s+/)
    const head = words[0]!.replace(/^(["'])(.*)\1$/, "$2").toLowerCase()
    const target = aliasTarget(head, dialect, platform) ?? head
    if (!LOCATION.has(target) || target === "new-psdrive" || target === "pop-location") return []
    const word = words.slice(1).find((item) => !/^[-–—―]/.test(item))
    if (word === undefined || /[$`(]/.test(word)) return []
    return [word.replace(/^(["'])(.*)\1$/, "$2")]
  })
}
