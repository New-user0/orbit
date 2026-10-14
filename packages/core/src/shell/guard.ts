export * as ShellGuard from "./guard.js"

import type { ToolFailure } from "@orbit/ai"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect, Option } from "effect"
import os from "node:os"
import path from "node:path"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { ProjectTrust } from "../project-trust.js"
import { aliasNames, aliasTarget, inspect, LOCATION, type Analysis, type Command, type Context } from "./analysis.js"
import { LinkShare } from "@orbit/util/link-share"
import { ShellParse } from "./parse.js"
import { PowerShellParse } from "./powershell-parse.js"
import { ShellPaths } from "./paths.js"
import { ShellReadOnly } from "./readonly.js"
import { ShellSafety } from "./safety.js"
import { ShellWrappers } from "./wrappers.js"

// The effectful half of the shell permission check. The analysis says which files a command names and what it does to
// them; the safety checks describe what no rule may lift. This module puts the disk between them: it resolves every named
// place to where it really is (links followed, a new file under a link judged where the write would land), decides which
// places are outside the project, probes the folders git would discover, and builds the requests the tool makes from
// the analysis. It decides nothing about a person's rules. Whatever it cannot resolve is an `unresolved` place with a
// finding, never a failure of the call (class 7), with one exception that is older than this module: a folder the command
// changes to that FileAccess refuses to name (a drive that is not a disk) refuses the call, as it always did. It opens no
// share and starts no process (class 6).

const WRITES = new Set<ShellPaths.Role>(["remove", "write", "create"])
const CD = new Set(["cd", "pushd", "popd", "set-location", "push-location", "pop-location"])
// What changes the PowerShell location. New-PSDrive makes a drive, which can be a network share, and is an ordinary command.
const MOVES = new Set(["set-location", "push-location", "pop-location"])

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
  /**
   * Folders that only a reading of the raw text found, absolute: text a comment or a string may hold, so they are asked
   * about but a spelling FileAccess cannot name never fails the call.
   */
  loose?: readonly string[]
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
    /**
     * The command changes folder to this place. FileAccess refuses a folder it cannot name (a drive that is not a disk, a
     * data stream), and the call is refused with it, as it always was: the shell would otherwise start from a place nobody
     * checked.
     */
    change: boolean
    level: number
  }
  type Resolved = Place & {
    resources: { action: "Read" | "Edit"; resource: string }[]
    external: FileAccess.Target[]
  }

  const resolveCandidate = Effect.fnUntraced(function* (candidate: string, spec: Spec) {
    const opened = access.resolve({ path: candidate, kind: spec.kind })
    const lexical = spec.change ? yield* opened : Option.getOrUndefined(yield* opened.pipe(Effect.option))
    // A share is never asked the disk: following a link or reading its trust would connect to the host before anyone
    // has been asked. A spelling FileAccess refused is not looked up either, and is reported as unresolved.
    const share =
      input.ctx.platform === "win32" && (/^[\\/]{2}/.test(candidate) || ShellReadOnly.windowsShare(candidate))
    if (share || lexical === undefined)
      return {
        real: candidate,
        internal: false,
        external: undefined,
        unresolved: true,
        why: share ? ("share" as const) : ("refused" as const),
        targets: lexical ? [lexical.resource] : [],
      }
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
      why: "refused" as const,
      targets: [lexical, actual].flatMap((target) => (target ? [target.resource] : [])),
    }
  })

  const resolvePlace = Effect.fnUntraced(function* (
    spec: Spec,
    skip?: Place["why"],
  ): Effect.fn.Return<Resolved, FSUtil.Error | ToolFailure> {
    if (skip !== undefined || spec.candidates.length === 0)
      return {
        level: spec.level,
        role: spec.role,
        status: "unresolved",
        why: skip ?? "dynamic",
        real: [],
        resources: [],
        external: [],
      }
    const found = yield* Effect.forEach(spec.candidates, (candidate) => resolveCandidate(candidate, spec))
    const external = found.flatMap((item) => (item.external ? [item.external] : []))
    const refused = found.some((item) => item.unresolved)
    const actions: ("Read" | "Edit")[] =
      spec.role === "read" ? ["Read"] : spec.role === "source" ? ["Read", "Edit"] : ["Edit"]
    return {
      level: spec.level,
      role: spec.role,
      status: refused ? "unresolved" : external.length > 0 ? "external" : "internal",
      ...(refused ? { why: found.find((item) => item.unresolved)?.why ?? ("refused" as const) } : {}),
      real: found.map((item) => item.real),
      resources: actions.flatMap((action) =>
        [...new Set(found.flatMap((item) => item.targets))].map((resource) => ({ action, resource })),
      ),
      external,
    }
  })

  const operands = all.flatMap((level) => level.analysis.paths.files.map((operand, file) => ({ level, operand, file })))
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
    const kind =
      operand.form === "glob" || operand.flags.includes("directory") || CD.has(command?.head ?? "")
        ? "directory"
        : "file"
    return resolvePlace(
      {
        candidates: operand.candidates,
        kind,
        role: operand.role,
        removal: operand.role === "remove" && !ps && operand.form !== "glob" && !/[\\/]\.?$/.test(operand.spelled),
        change: level.depth === 0 && CD.has(command?.head ?? ""),
        level: level.depth,
      },
      skip,
    )
  })
  const extra = yield* Effect.forEach(input.directories, (directory) =>
    resolvePlace({ candidates: [directory], kind: "directory", role: "read", removal: false, change: true, level: 0 }),
  )
  const guessed = yield* Effect.forEach(input.loose ?? [], (directory) =>
    resolvePlace({ candidates: [directory], kind: "directory", role: "read", removal: false, change: false, level: 0 }),
  )
  const everything = [...resolved, ...extra, ...guessed]

  const git = ShellSafety.runsGit(input.analysis, input.ctx.platform)
  const probed = git ? yield* probeGit(all, input.cwd.absolute) : { bare: [], dynamic: false }
  const bare = probed.bare

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
      bare,
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
    findings: [
      ...found,
      ...own(all, operands, resolved, ps),
      // A folder that only the raw reading found and FileAccess cannot name never fails the call, but it is said.
      ...guessed
        .filter((item) => item.status === "unresolved")
        .map(() => ShellSafety.finding("too-complex", "unresolved-path")),
      ...(probed.dynamic ? [ShellSafety.finding("too-complex", "dynamic-git-dir")] : []),
    ].filter(unique),
  } satisfies Facts
})

function unique(finding: ShellSafety.Finding, index: number, list: ShellSafety.Finding[]) {
  return (
    list.findIndex(
      (item) =>
        item.kind === finding.kind &&
        item.reason === finding.reason &&
        item.command === finding.command &&
        item.place === finding.place,
    ) === index
  )
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
    const unplaceable =
      place.status === "unresolved" &&
      (WRITES.has(operand.role) || (place.why !== undefined && place.why !== "dynamic"))
    if (unplaceable) found.push(ShellSafety.finding("too-complex", "unresolved-path", at))
    if (operand.form === "glob" && (WRITES.has(operand.role) || ps))
      found.push(ShellSafety.finding("too-complex", "glob-write", at))
    if (ps && operand.flags.includes("provider")) found.push(ShellSafety.finding("provider", "provider-path", at))
  })
  all.forEach((level) => {
    const files = level.analysis.paths
    files.unvalidatable.forEach((item) =>
      found.push(ShellSafety.finding("too-complex", "unvalidatable", level.depth === 0 ? item.command : undefined)),
    )
    if (ps) {
      if (
        files.directoryChanges > 0 &&
        files.files.some((operand) => !CD.has(level.analysis.commands[operand.command]?.head ?? ""))
      )
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
// The one gate every entry point goes through

export type Authorize = {
  command: string
  shell: string
  cwd: FileAccess.Target
  env: Record<string, string | undefined>
  portable: boolean
  /** The folders the command may write when it runs inside the sandbox. Unset when it runs without one. */
  writable?: readonly string[]
  /** Who asks: the session, the agent and the tool call, when there is one. */
  base: Pick<Permission.AssertInput, "sessionID" | "agent" | "source">
  /** More for the shell request's metadata, such as the text a client titles it with. */
  metadata?: Record<string, unknown>
}

/** The requests of one input, made but not yet checked or asked. */
export type Prepared = {
  analysis: Analysis
  external?: Permission.AssertInput
  shell?: Permission.AssertInput
  /** Every request of the input, the deny-only probes included. */
  requests: Permission.AssertInput[]
}

/**
 * Asks for everything a shell command needs before it may run: the folders it reaches outside the project, and the
 * command itself. Every request of the call is checked for a deny before the first question, so a call that a rule blocks
 * shows none. The tool and the `!` spans of a command both come through here, so they cannot disagree about what a
 * command does. Input that cannot be analysed is asked about, never refused. Returns the analysis it made. A caller with
 * several inputs prepares them all, runs `denyPass` over each, and only then asks, so a deny in the last one shows no
 * question about the first.
 */
export const authorize = Effect.fn("ShellGuard.authorize")(function* (input: Authorize) {
  const prepared = yield* prepare(input)
  yield* denyPass(prepared)
  yield* ask(prepared)
  return prepared.analysis
})

/** Fails with the block when a rule of the person's or the managed policy denies any request of the input. Asks nobody. */
export const denyPass = Effect.fn("ShellGuard.denyPass")(function* (prepared: Prepared) {
  const permission = yield* Permission.Service
  yield* Effect.forEach(prepared.requests, (item) =>
    permission.denied(item).pipe(Effect.flatMap((denied) => (denied ? permission.assert(item) : Effect.void))),
  )
})

/** Asks the folder question first, then the command. */
export const ask = Effect.fn("ShellGuard.ask")(function* (prepared: Prepared) {
  const permission = yield* Permission.Service
  if (prepared.external) yield* permission.assert(prepared.external)
  if (prepared.shell) yield* permission.assert(prepared.shell)
})

export const prepare = Effect.fn("ShellGuard.prepare")(function* (input: Authorize) {
  const access = yield* FileAccess.Service
  const parser = yield* PowerShellParse.Service
  const ctx: Context = {
    shell: input.shell,
    platform: process.platform,
    path: process.platform === "win32" ? path.win32 : path.posix,
    home: os.homedir(),
    cwd: input.cwd.absolute,
    env: input.env,
  }
  // The one parse of the call. Input that cannot be analysed is a value here, never an error.
  const analysis = yield* inspect(input.command, ctx, { nested: true }).pipe(
    Effect.provideService(PowerShellParse.Service, parser),
  )
  const ps = isPowerShell(analysis)
  // The scanners stop by themselves after half a second, so an input over the length limit is still read for the folders
  // it changes to and the words it names; only the portable scanner, which is quadratic on some inputs, never sees it.
  const scanned = ps
    ? undefined
    : yield* scanBash(input.command, input.shell, input.cwd.absolute, input.portable && !analysis.opaque)
  // Input that cannot be analysed, or that a scanner gave up on, is also split into fragments: what they name is asked
  // about whatever else the command does, so the list is never empty for it.
  const fragmentary = analysis.opaque !== undefined || (!ps && scanned === undefined)
  const directories = [
    ...(ps ? (analysis.opaque ? [] : expansions(analysis, input.cwd.absolute, input.shell)) : (scanned?.directories ?? [])),
    ...(fragmentary ? locations(input.command, analysis.dialect, process.platform, input.cwd.absolute, input.shell) : []),
  ]
  // The raw text is read as well as the text with its comments and strings taken out: a misreading of the second can
  // only add a folder here, never drop one.
  // pwsh on Linux and macOS takes a backslash as a separator too, so a word of PowerShell is read that way on every host.
  const native = (word: string) => (ps && process.platform !== "win32" ? word.replaceAll("\\", "/") : word)
  const read = (folders: string[]) =>
    folders.map((directory) => FileAccess.resolvePath(input.cwd.absolute, native(directory)))
  const loose = fragmentary
    ? locations(input.command, analysis.dialect, process.platform, input.cwd.absolute, input.shell, true)
    : []
  const gathered = yield* facts({
    analysis,
    text: input.command,
    ctx,
    cwd: input.cwd,
    directories: read(directories),
    loose: read(loose.filter((folder) => !directories.includes(folder))),
    writable: input.writable,
  })
  // A plain word of the command that a link in an untrusted project leads out of it, such as `cfg/orbit.json` in
  // `cat cfg/orbit.json`, is asked about as the folder it really is in. A path the command builds as it runs is not.
  const literal = [
    ...(ps ? words(analysis) : yield* ShellParse.operands(input.command, input.shell)),
    ...(fragmentary ? [...fragmentWords(input.command, ps), ...fragmentWords(input.command, ps, true)] : []),
  ]
  const escaped = yield* access.escaped(literal.map((operand) => FileAccess.resolvePath(input.cwd.absolute, native(operand))))
  const external = access.externalRequest([input.cwd, ...gathered.external, ...escaped], input.base)
  const requested = request(analysis, input.command, scanned, gathered.findings)
  const shell: Permission.AssertInput | undefined = requested && {
    action: "Bash",
    resources: requested.resources,
    ...(requested.save.length > 0 ? { save: requested.save } : {}),
    ...(requested.aliases ? { aliases: requested.aliases } : {}),
    // The folder the command runs in, as resolved here, so a client shows it rather than the input's spelling, and the
    // real folder when a link in an untrusted project leads there. The findings only describe, for now.
    metadata: { workdir: input.cwd.place, findings: gathered.findings, ...input.metadata },
    ...input.base,
  }
  const requests = [
    ...(shell ? [shell] : []),
    ...(external ? [external] : []),
    ...gathered.probes.map(
      (probe): Permission.AssertInput => ({
        action: probe.action,
        resources: probe.resources,
        probe: true,
        ...input.base,
      }),
    ),
  ]
  return { analysis, external, shell, requests } satisfies Prepared
})

// The bash scanner's view of the input. The legacy scan reads what the analysis could not, and always supplies the
// redirected statements without a command and the folders to change to; the portable scanner replaces its commands when it
// is configured and can read the input, and a scanner that cannot never fails the call.
const scanBash = Effect.fnUntraced(function* (command: string, shell: string, cwd: string, portable: boolean) {
  const none = () => Effect.succeed(undefined)
  const legacy = yield* ShellParse.scan(command, shell, cwd).pipe(Effect.catch(none))
  const bare = yield* ShellParse.bare(command)
  const scanned = portable
    ? yield* ShellParse.scan(command, shell, cwd, { portable }).pipe(Effect.catch(none))
    : undefined
  const result = scanned ?? legacy
  return result && bare.length > 0 ? { ...result, bare } : result
})

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
  // What a part is. A part that is a share, or leads to one through a link the repository ships, is "Share": it is never
  // stat-ed, because that connects to a host the repository chose (class 6).
  const type = Effect.fnUntraced(function* (file: string) {
    if (share(file) || (yield* LinkShare.of(fs, file)) !== undefined) return "Share" as const
    return yield* fs.stat(file).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => undefined),
    )
  })
  const same = (left: string, right: string) =>
    process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right

  const bases: string[] = [workdir]
  const named: { base: string; value: string }[] = []
  // A git directory built as the command runs: the folder git will use is unknown, whatever form the assignment takes.
  const dynamic = all.some((level) =>
    [...level.text.matchAll(GIT_DIR)].some((match) => /[$`(]/.test(match[1]!.replace(/^(["'])(.*)\1$/, "$2"))),
  )
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
        } else if (["-c", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--shallow-file"].includes(word.value)) at++
      }
    })
    ;[...level.text.matchAll(GIT_DIR)]
      .map((match) => match[1]!.replace(/^(["'])(.*)\1$/, "$2"))
      .filter((value) => !/[$`(]/.test(value))
      .forEach((value) => named.push({ base: workdir, value }))
  })

  const own = new Map<string, string>()
  // Whether the `.git` of a folder is a normal repository directory.
  const normal = (folder: string) => type(path.join(folder, ".git", "HEAD")).pipe(Effect.map((kind) => kind === "File"))

  // The linked worktrees and submodules that git itself makes: the git directory they name must point back at this folder
  // or sit under an enclosing repository's modules folder. Anything else a repository ships is unverified.
  const verified = Effect.fnUntraced(function* (folder: string) {
    const file = path.join(folder, ".git")
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => Infinity),
    )
    if (size > GITDIR_LIMIT) return false
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const line = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text)
    if (!line || share(line[1]!)) return false
    const target = path.resolve(folder, line[1]!)
    const leads = yield* trust.leads(target)
    if (share(leads)) return false
    if (path.basename(path.dirname(leads)) === "worktrees") {
      const backFile = path.join(leads, "gitdir")
      const back =
        (yield* type(backFile)) === "File"
          ? yield* fs.readFileString(backFile).pipe(Effect.orElseSucceed(() => ""))
          : ""

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
        if (entry === "Share") {
          found.push({ base: folder, why: "unverified-gitdir" })
          return
        }
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
        if (
          indicators.includes("Share") ||
          indicators[0] === "File" ||
          indicators[1] === "Directory" ||
          indicators[2] === "Directory"
        )
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
  return {
    bare: found.filter(
      (item, index) => found.findIndex((other) => other.base === item.base && other.why === item.why) === index,
    ),
    dynamic,
  }
})

function gitProgram(command: Command) {
  const name = path
    .basename(command.inner[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "")
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
export function request(
  analysis: Analysis,
  text: string,
  scan: ShellParse.Result | undefined,
  findings: ShellSafety.Finding[],
): Request | undefined {
  const whole = text.trim()
  if (analysis.opaque) return opaque(analysis, whole, scan)
  if (isPowerShell(analysis)) return powershell(analysis, whole, findings)
  const resources = [...(scan?.commands.map((command) => command.resource) ?? []), ...(scan?.bare ?? [])]
  // The saves stay one per scanned command, as they always were: a client may pair them with the commands.
  if (resources.length > 0) {
    // A declaration that prints the environment is a request of its own beside the scanned commands, so a Bash ask or a rule
    // for it applies and a grant for the other command does not lift it (class 8).
    const printed = analysis.commands
      .filter((command) => PRINTERS.has(command.head) && !assigns(command))
      .map((command) => command.text.trim())
      .filter((resource) => resource !== "" && !resources.includes(resource))
    return { resources: distinct([...resources, ...printed]), save: scan?.commands.map((command) => command.save) ?? [] }
  }
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
  const pieces = ps
    ? ShellSafety.fragments(whole).map((piece) => piece.replace(/^(["'])(.*?)\1(?=\s|$)/, "$2"))
    : bashFragments(whole)
  const spelled = ps ? pieces.map((piece) => spellings(piece, analysis)) : []
  const aliases = Object.fromEntries(
    // A path or module-qualified first word puts its spellings on the stripped resource, never on the piece: a rule written for
    // the cmdlet then meets the stripped spelling (a deny), while the piece, which may be a program of the repository, still
    // needs a rule of its own.
    spelled.filter((item) => item.names.length > 0).map((item) => [item.stripped ?? item.piece, item.names]),
  )
  return {
    resources: distinct([
      whole,
      ...(scan?.commands.map((command) => command.resource) ?? []),
      ...(scan?.bare ?? []),
      ...pieces,
      // A module-qualified or path-like first word is also judged under its stripped name, as a parsed application is, so a
      // deny written for the cmdlet meets it and an allow cannot lift it.
      ...spelled.flatMap((item) => (item.stripped === undefined ? [] : [item.stripped])),
    ]).filter((item) => item !== ""),
    save: [],
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
  }
}

// The spellings a PowerShell rule may be written in for a fragment of unreadable input: its first word without quotes, call
// operator or module qualifier, that word's cmdlet and every alias of it here, each followed by the rest of the fragment
// after one space (so a tab does not hide it).
function spellings(piece: string, analysis: Analysis) {
  const match = /^[&.]?\s*(["']?)([^\s"']+)\1(?=\s|$)/.exec(piece)
  if (!match) return { piece, names: [] as string[], stripped: undefined }
  const bare = strip(match[2]!)
  const target = aliasTarget(bare.toLowerCase(), analysis.dialect, process.platform) ?? bare.toLowerCase()
  const rest = piece.slice(match[0].length).trim()
  const names = [
    ...new Map(
      [bare, target, ...aliasNames().filter((alias) => aliasTarget(alias, analysis.dialect, process.platform) === target)].map(
        (name) => [name.toLowerCase(), name] as const,
      ),
    ).values(),
  ].map((name) => (rest === "" ? name : name + " " + rest))
  return { piece, names, stripped: bare === match[2] ? undefined : names[0] }
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

const DECLARATIONS = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "unset",
  "cd",
  "pushd",
  "popd",
])

function inert(analysis: Analysis) {
  return (
    analysis.dialect === "bash" &&
    analysis.redirects.length === 0 &&
    !analysis.features.substitution &&
    !analysis.features.heredoc &&
    !analysis.features.herestring &&
    analysis.commands.every(
      (command) =>
        DECLARATIONS.has(command.head) &&
        command.redirects.length === 0 &&
        command.argv.every((word) => word.literal) &&
        (!PRINTERS.has(command.head) || assigns(command)),
    )
  )
}

// These builtins list every variable (or function) with its value when they get no name or a print flag, which would carry
// the environment's credentials to the model. They are inert only when they set named variables.
const PRINTERS = new Set(["export", "declare", "typeset", "local", "readonly"])

function assigns(command: Command) {
  const words = command.argv.slice(1).map((word) => word.value)
  const flags = words.filter((word) => word.startsWith("-"))
  const names = words.filter((word) => !word.startsWith("-"))
  return (
    names.length > 0 &&
    names.every((word) => /^[A-Za-z_][A-Za-z0-9_]*(?:=|$)/.test(word)) &&
    !flags.some((flag) => /[pfF]/.test(flag))
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
    // Spawners and code runners that a saved "name *" would lift for every argument.
    "start-threadjob register-scheduledjob register-engineevent register-objectevent register-wmievent new-pssession",
    "enter-pssession save-script new-object python2 tsx lua bunx ssh py new-psdrive",
    // Cmdlets whose script-block and member-access arguments run code: a saved "name *" would lift every such argument. Each
    // is listed with its aliases, since a written alias is checked as spelled.
    "where-object where ? select-object select sort-object sort group-object group measure-object measure",
    "format-table ft format-list fl format-wide fw format-custom fc out-string out-host oh write-output echo write",
    "write-host start-sleep sleep invoke-wmimethod iwmi invoke-cimmethod icim",
    // Programs whose arguments change what they do (`route add`, `hostname NAME`, `ipconfig /release`).
    "ipconfig hostname route",
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
    .filter((command) => !relocation(command))
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
      const commands =
        statement.kind === "PipelineAst" &&
        !statement.assignment &&
        statement.elements.every((element) => element.kind === "command")
      if (!commands) {
        resources.push(text)
        if (!/[*?\r\n]/.test(text)) save.push(text)
        return
      }
      // A redirect to a file is asked about as the statement, which no grant for its commands covers.
      if (statement.redirects.some((redirect) => redirect.kind === "file" && redirect.nullSink !== true))
        resources.push(text)
    })

  const listed = distinct(resources).filter((item) => item !== "")
  if (listed.length > 0)
    return {
      resources: listed,
      save: distinct(save),
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    }
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
        (/^\$(?!env:)[A-Za-z_]\w*\s*=\s*(?:'[^']*'|"[^"$`]*"|\d+(?:\.\d+)?|\$(?:true|false|null))$/i.test(
          statement.text.trim(),
        ) ||
          (statement.kind === "PipelineAst" &&
            statement.elements.every((element) => element.kind === "command" && relocation(element.command)))),
    )
}

const PLAIN_ARGUMENTS = new Set(["StringConstantExpressionAst", "ConstantExpressionAst", "VariableExpressionAst"])

// A location cmdlet whose arguments are constants, variables or parameters. A path spelling such as scripts\Set-Location is
// an application (a script or program of the repository), and a script block, parenthesis or subexpression argument runs
// code, so neither may drop out of the request.
function relocation(command: PowerShellParse.Command) {
  return (
    command.class === "cmdlet" &&
    !command.dynamic &&
    MOVES.has(command.name) &&
    command.arguments.every(
      (argument) =>
        PLAIN_ARGUMENTS.has(argument.kind) ||
        (argument.kind === "CommandParameterAst" &&
          (argument.bound === undefined || PLAIN_ARGUMENTS.has(argument.bound.kind))),
    )
  )
}

function strip(name: string) {
  return name.replace(/^(["'])(.*)\1$/, "$2").replace(/^.*\\/, "")
}

// The spellings a rule may be written in for this cmdlet: the name as written without its module qualifier and quotes, the
// cmdlet's own name and each of its aliases here, each followed by the arguments as written, joined by single spaces.
function canonical(command: PowerShellParse.Command, analysis: Analysis) {
  const given = command.arguments.map((argument) => argument.text)
  const names = distinct([
    strip(command.written),
    command.name,
    ...aliasNames().filter((alias) => aliasTarget(alias, analysis.dialect, process.platform) === command.name),
  ])
  return names.map((name) => [name, ...given].join(" "))
}

// The pattern an "always" reply would save for this command: none for what could run anything.
function saved(command: PowerShellParse.Command) {
  const written = strip(command.written)
  const lower = [command.name, written.toLowerCase()]
  if (command.dynamic || command.placeholder || lower.some((name) => NEVER.has(name))) return undefined
  if (command.class === "cmdlet") return `${written} *`
  // A program, or a function of the script: a plain name, never a path, a file or a module-qualified name.
  if (/[\\/]/.test(command.written) || /\.[A-Za-z0-9]+$/.test(written) || !/^[\w-]+$/.test(written)) return undefined
  const positional: string[] = []
  const words = [written]
  for (const argument of command.arguments) {
    if (argument.parameter !== undefined) continue
    if (
      argument.kind !== "StringConstantExpressionAst" ||
      argument.value === undefined ||
      /[\s\\]/.test(argument.value)
    )
      break
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
    .filter(
      (command) => LOCATION.has(command.name) && command.name !== "new-psdrive" && command.name !== "pop-location",
    )
    .flatMap((command) =>
      // PowerShell 7 goes home for a Set-Location with no target: nothing, only parameters that take no path, or an empty
      // path (which the folder reading below turns into home).
      [
        ...(command.name === "set-location" &&
        !namesTarget(
          command.arguments
            .filter((argument) => argument.text !== "--")
            .map((argument) => ({ parameter: argument.parameter, bound: argument.bound !== undefined })),
        )
          ? [os.homedir()]
          : []),
        ...command.arguments.flatMap((argument) => {
        // A word with a variable is read as written; any other word is the constant the parser folded, with its quotes
        // joined (`../out"side"` is `../outside`), so the folder shown never holds a quote character.
        const word =
          argument.parameter === undefined
            ? { text: argument.text, value: argument.value }
            : pathParameter(argument.parameter)
              ? { text: argument.bound?.text, value: argument.bound?.value }
              : undefined
        if (word?.text === undefined) return []
        const folder = word.text.includes("$")
          ? ShellParse.directoryArgument(word.text, true, cwd, shell)
          : word.value === undefined
            ? undefined
            : ShellParse.directoryArgument(word.value, true, cwd, shell)
        return folder === undefined ? [] : [folder]
      }),
      ],
    )
}

// Whether the arguments of a Set-Location name a place: a positional word or a path parameter. Any other parameter that is
// not bound with a colon is taken to read the word after it (`-ErrorAction Stop`) unless it is a switch. Wrongly taking a
// switch for a parameter that reads a value only adds the home question.
function namesTarget(items: { parameter?: string; bound: boolean }[]) {
  const switches = ["passthru", "verbose", "debug"]
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (item.parameter === undefined) return true
    if (pathParameter(item.parameter)) return true
    const lower = item.parameter.toLowerCase()
    if (item.bound || lower === "vb" || lower === "db" || (lower.length >= 3 && switches.some((name) => name.startsWith(lower)))) continue
    index++
  }
  return false
}

/**
 * The literal words that the commands of a PowerShell parse take as arguments, and the files they redirect to, with
 * parameters left out: what a command may open as a path, for the check that finds a link in an untrusted project that
 * leads out of it. A word the parser could not fold to a constant is not here.
 */
export function words(analysis: Analysis) {
  return (analysis.summary?.statements ?? [])
    .flatMap((statement) => [
      ...statement.elements.flatMap((element) =>
        element.command.arguments.flatMap((argument) => [
          ...(argument.parameter === undefined && argument.value !== undefined ? [argument.value] : []),
          // -Path:value binds its value to the parameter.
          ...(argument.bound?.value === undefined ? [] : [argument.bound.value]),
          // The elements of `a,b`, which the parser keeps apart from the argument's own value.
          ...(argument.elements ?? []).flatMap((item) => (item.value === undefined ? [] : [item.value])),
        ]),
      ),
      ...statement.redirects.flatMap((redirect) => (redirect.value === undefined ? [] : [redirect.value])),
    ])
    .filter((word) => word !== "")
}


/**
 * The folders that the fragments of an input change to, for input that was not analysed: a fragment that starts with a
 * directory-changing command and names a place, in every word that is not a parameter and in the value of a path
 * parameter. Absolute or relative as written; `$HOME`, `$env:NAME`, `${env:NAME}`, `$PWD` and `$PSHOME` are expanded. A
 * target built as the command runs (`../out/$X`) names the nearest folder before the part that is built, and nothing when
 * no folder comes first.
 */
export function locations(
  text: string,
  dialect: Analysis["dialect"],
  platform: NodeJS.Platform,
  cwd = "",
  shell = "",
  raw = false,
) {
  const ps = dialect === "powershell-5.1" || dialect === "pwsh"
  const found = ShellSafety.fragments(readable(text, ps, raw)).flatMap((whole) => variants(whole, ps, raw).flatMap((fragment) => {
    const words = fragmentTokens(fragment, ps)
    if (words.length === 0) return []
    const head = words[0]!.value
    // A module-qualified name (`Microsoft.PowerShell.Management\Set-Location`) is the cmdlet.
    const name = ps ? head.replace(/^.*\\/, "").toLowerCase() : head
    const target = ps ? (aliasTarget(name, dialect, platform) ?? name) : head
    if (!(ps ? MOVES.has(target) && target !== "pop-location" : target === "cd" || target === "pushd")) return []
    // A comment ends the words; bash takes only the first operand of cd and pushd.
    const comment = words.findIndex((word, index) => index > 0 && /^(#|<#)/.test(word.raw))
    const operands = words.slice(1, comment === -1 ? undefined : comment)
    // PowerShell 7 goes home for a bare Set-Location (and its aliases cd, chdir, sl).
    // The end-of-parameters marker names nothing: later words are positional, and a command with none still goes home.
    const home =
      ps &&
      !raw &&
      target === "set-location" &&
      !namesTarget(operands.filter((item) => item.value !== "--").map((item) => parameterOf(item)))
        ? [os.homedir()]
        : []
    const ender = operands.findIndex((item) => item.value === "--")
    return [...home, ...(ps ? operands : bashOperands(operands).slice(0, 1)).flatMap((item, index, rest) => {
      if (ps && index === ender) return []
      const positional = ps && ender !== -1 && index > ender
      const bound = ps && !positional ? colonBound(item, rest[index + 1]) : undefined
      if (bound !== undefined && !pathParameter(bound.name)) return []
      const word = bound?.word ?? item
      if (bound === undefined && !positional && /^[-–—―]/.test(item.raw)) return []
      if (ps && (word.value === "" || word.value.includes("$"))) {
        const folder = ShellParse.directoryArgument(word.value, true, cwd, shell)
        if (folder !== undefined) return [folder]
      }
      const dynamic = word.value.search(/[$`(]/)
      if (dynamic === -1) return [word.value]
      const prefix = word.value.slice(0, dynamic)
      const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"))
      return slash === -1 ? [] : [prefix.slice(0, slash + 1)]
    })]
  }))
  // A value that follows `-Name:` is read both as that value and as a word of its own.
  return distinct(found)
}

/**
 * The literal words of the fragments of an input that was not analysed, without the first word of each fragment, flags,
 * comments and anything built as the command runs: what a command in it may open as a path. A PowerShell word is joined
 * the way its argument mode joins it, and a parameter bound with a colon gives its value.
 */
export function fragmentWords(text: string, ps = false, raw = false) {
  return distinct(
    ShellSafety.fragments(readable(text, ps, raw)).flatMap((whole) => variants(whole, ps, raw).flatMap((fragment) => {
      const words = fragmentTokens(fragment, ps).slice(1)
      const comment = words.findIndex((word) => /^(#|<#)/.test(word.raw))
      return (comment === -1 ? words : words.slice(0, comment)).flatMap((word, index, rest) => {
        if (/[$`]/.test(word.raw)) return []
        const bound = ps ? colonBound(word, rest[index + 1]) : undefined
        if (bound !== undefined) {
          const value = /[$`]/.test(bound.word.raw) ? "" : bound.word.value
          return value === "" ? [] : [value]
        }
        const value = ps
          ? word.value
          : unquoted(word.raw.startsWith("-") && word.raw.includes("=") ? word.raw.slice(word.raw.indexOf("=") + 1) : word.raw)
        if (value === "" || (ps ? /^[-–—―]/ : /^-/).test(value)) return []
        // The elements of a PowerShell array argument `a,b` are words of their own.
        return ps && value.includes(",") ? [value, ...value.split(",").filter((item) => item !== "")] : [value]
      })
    })),
  )
}

// The text that is split into fragments. The raw reading is the text as written: it models no strings or comments, so
// it cannot lose a folder to a misreading of them. The other reading takes comments out.
const readable = (text: string, ps: boolean, raw: boolean) =>
  ps ? (raw ? text : psText(text)) : bashText(text, raw)

// The raw reading of PowerShell reads each fragment two ways and takes the union of what they find: as written (words end
// at the first word that starts with `#` or `<#`), and with the block comments that close in the fragment blanked. A
// `<#` inside a word or quotes is not a comment opener, so the blanked reading alone could lose the folder between it and
// a later `#>`; the as-written reading alone loses what follows a real comment.
const variants = (fragment: string, ps: boolean, raw: boolean) =>
  ps && raw ? [fragment, blankComments(fragment)] : [fragment]

// One linear pass: blanks each `<#` ... `#>` and stops at the first `<#` that has no `#>` after it.
function blankComments(text: string) {
  const parts: string[] = []
  let at = 0
  while (true) {
    const open = text.indexOf("<#", at)
    if (open === -1) break
    const close = text.indexOf("#>", open + 2)
    if (close === -1) break
    parts.push(text.slice(at, open), " ")
    at = close + 2
  }
  return parts.length === 0 ? text : parts.join("") + text.slice(at)
}

// Bash text with each line cut at a `#` that starts a word outside quotes.
function bashText(text: string, raw: boolean) {
  // The `&` of `&>`, `>&` and `<&` is part of a redirect, not a separator that would cut the command in two.
  // The `|` of `>|` (a redirect that overrides noclobber) is part of it too.
  const whole = joined(text).replace(/&(?=>)|(?<=[<>])&|(?<=>)\|/g, "")
  if (raw) return whole
  return whole
    .split(/(?<=\n)/)
    .map((line) => {
      let quote: string | undefined
      for (let at = 0; at < line.length; at++) {
        const char = line[at]!
        if (char === "\\" && quote !== "'") at++
        else if (quote !== undefined) quote = char === quote ? undefined : quote
        else if (char === '"' || char === "'") quote = char
        else if (char === "#" && (at === 0 || /[\s;&|()<>]/.test(line[at - 1]!)))
          return line.slice(0, at) + (line.endsWith("\n") ? "\n" : "")
      }
      return line
    })
    .join("")
}

const REDIRECT = /^\d*(?:>>|>\||&>>|&>|>&|<<<|<<-|<<|<>|<&|<|>)/

// The words of a bash cd or pushd that can be its folder: flags and redirects are not, and neither is the target of a
// redirect whose operator stands alone.
function bashOperands(words: Token[]) {
  return words.flatMap((word, index) => {
    if (word.raw.startsWith("-") || REDIRECT.test(word.raw)) return []
    const before = words[index - 1]
    return before !== undefined && REDIRECT.exec(before.raw)?.[0] === before.raw ? [] : [word]
  })
}

// PowerShell text before it is split into fragments: block comments are blanks, and `${env:NAME}` is `$env:NAME` (the
// split would cut at its braces); a braced name followed by more word characters is a variable the scan cannot know.
// Quoted strings and line comments are copied as written: a `<#` opens nothing inside them, and `${` opens nothing
// inside single quotes.
function psText(text: string) {
  const braced = /\$\{([^}\r\n]*)\}(\w?)/y
  const variable = (at: number) => {
    braced.lastIndex = at
    const match = braced.exec(text)
    if (match === null) return undefined
    return { text: match[2] === "" ? "$" + match[1] : "$x" + match[2], length: match[0].length }
  }
  let out = ""
  let at = 0
  // Where a word that starts with a quote ends: a `#` right after it starts a comment.
  let quoted = -1
  while (at < text.length) {
    const char = text[at]!
    if (char === "`") {
      out += text.slice(at, at + 2)
      at += 2
      continue
    }
    if (char === "#" && (at === 0 || at === quoted || /[\s;|&(){},]/.test(text[at - 1]!))) {
      const end = text.slice(at).search(/[\r\n]/)
      at = end === -1 ? text.length : at + end
      continue
    }
    if (char === "<" && text[at + 1] === "#") {
      const end = text.indexOf("#>", at + 2)
      out += " "
      at = end === -1 ? text.length : end + 2
      continue
    }
    const found = char === "$" && text[at + 1] === "{" ? variable(at) : undefined
    if (found !== undefined) {
      out += found.text
      at += found.length
      continue
    }
    const closing = CLOSING[char]
    if (closing === undefined) {
      out += char
      at++
      continue
    }
    // A quoted string: a doubled closing quote is one quote character; a backtick escapes in double quotes only.
    const single = closing.startsWith("'")
    const wordStart = at === 0 || /[\s;|&(){},]/.test(text[at - 1]!)
    out += char
    at++
    while (at < text.length) {
      const next = text[at]!
      const inner = !single && next === "$" && text[at + 1] === "{" ? variable(at) : undefined
      if (inner !== undefined) {
        out += inner.text
        at += inner.length
        continue
      }
      if (!single && next === "`") {
        out += text.slice(at, at + 2)
        at += 2
        continue
      }
      out += next
      at++
      if (!closing.includes(next)) continue
      if (!closing.includes(text[at] ?? "\0")) break
      out += text[at]!
      at++
    }
    if (wordStart) quoted = at
  }
  return out
}

// A backslash before a line break joins the words around it in bash. Only bash text passes through here: in PowerShell a
// backslash is a path separator, a backtick joins lines, and `fragments` does that.
const joined = (text: string) => text.replace(/\\\r?\n/g, "")

type Token = { raw: string; value: string }

// The closing quote of each opening quote that PowerShell accepts, curly ones included.
const CLOSING: Record<string, string> = {
  '"': '"“”„',
  "'": "'‘’‚‛",
  "“": '"“”„',
  "”": '"“”„',
  "„": '"“”„',
  "‘": "'‘’‚‛",
  "’": "'‘’‚‛",
  "‚": "'‘’‚‛",
  "‛": "'‘’‚‛",
}

// Words split at blanks, with a quoted word kept whole. A PowerShell word is read as its argument mode reads it: quoted
// pieces and plain text next to each other are one word, so `a"b c"` is the word `ab c`, and its value has no quote
// characters (a doubled quote inside quotes is one quote character).
function fragmentTokens(fragment: string, ps: boolean): Token[] {
  if (!ps) return (fragment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((raw) => ({ raw, value: unquoted(raw) }))
  const tokens: Token[] = []
  let raw = ""
  let value = ""
  let quote: string | undefined
  for (let at = 0; at < fragment.length; at++) {
    const char = fragment[at]!
    if (quote === undefined && /\s/.test(char)) {
      if (raw !== "") tokens.push({ raw, value })
      raw = ""
      value = ""
      continue
    }
    raw += char
    if (quote === undefined) {
      if (CLOSING[char] === undefined) value += char
      else quote = char
      continue
    }
    if (!CLOSING[quote]!.includes(char)) {
      value += char
      continue
    }
    if (CLOSING[quote]!.includes(fragment[at + 1] ?? "\u0000")) {
      value += char
      raw += fragment[at + 1]
      at++
      continue
    }
    quote = undefined
    // A word that starts with a quote ends at its closing quote; one that starts unquoted keeps joining (`a'b'c`).
    if (CLOSING[raw[0]!] !== undefined) {
      tokens.push({ raw, value })
      raw = ""
      value = ""
    }
  }
  if (raw !== "") tokens.push({ raw, value })
  return tokens
}

// -Name:value as one word, or `-Name:` followed by its value as the next word.
function parameterOf(token: Token) {
  const match = /^[-–—―](\w+)(:?)/.exec(token.value)
  return match === null ? { parameter: undefined, bound: false } : { parameter: match[1]!, bound: match[2] === ":" }
}

function colonBound(token: Token, next: Token | undefined) {
  const match = /^[-–—―](\w+):(.*)$/s.exec(token.value)
  if (!match) return undefined
  if (match[2] !== "") return { name: match[1]!, word: { raw: token.raw.slice(token.raw.indexOf(":") + 1), value: match[2]! } }
  // A quoted empty value (`-Path:''`) leaves no word after the colon.
  return { name: match[1]!, word: next ?? { raw: "", value: "" } }
}

// -Path, -LiteralPath and -PSPath (-LP in PowerShell 7), with the abbreviations PowerShell accepts (`-p` also fits
// -PassThru, so it needs two letters).
const pathParameter = (name: string) => {
  const lower = name.toLowerCase()
  return (
    (lower.length >= 2 && ("path".startsWith(lower) || "pspath".startsWith(lower))) ||
    "literalpath".startsWith(lower) ||
    lower === "lp"
  )
}

const unquoted = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2")
