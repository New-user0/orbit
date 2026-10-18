export * as ConfigCommandPlugin from "./command.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Info, type Entry } from "@orbit/schema/config"
import { Model } from "@orbit/schema/model"
import { Provider } from "@orbit/schema/provider"
import { AppProcess } from "@orbit/util/process"
import { tmpdir } from "node:os"
import path from "path"
import { type Context, Effect, PubSub, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigEnv } from "../env.js"
import { Location } from "../../location.js"
import { ManagedNetwork } from "../../managed-network.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { Permission } from "../../permission.js"
import { ProjectTrust } from "../../project-trust.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { FileAccess } from "../../file-access.js"
import { ShellGuard } from "../../shell/guard.js"
import { PowerShellParse } from "../../shell/powershell-parse.js"
import { ShellSandbox } from "../../shell/sandbox.js"
import { ShellSelect } from "../../shell/select.js"
import { FSUtil } from "@orbit/util/fs-util"
import { ConfigTrust } from "../trust.js"
import { CommandFile } from "./command-file.js"

/** A command from a folder that is not trusted runs a shell snippet, which nothing may run until the folder is. */
export class UntrustedError extends Schema.TaggedError<UntrustedError>()("ConfigCommandPlugin.UntrustedError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export const Plugin = define({
  id: "orbit.config.command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const projectTrust = yield* ProjectTrust.Service
    // The commands of an entry, and whether its folder lets them run shell snippets: only a project or local entry that
    // config stamped untrusted does not. Plain templates are only text, so they run either way. The folder is the one
    // that has to be trusted, which a refusal names. A command file that a link leads out of an untrusted folder is not
    // read, so it is not the repository's to put into the prompt.
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      const trust = { trusted: entry.trusted !== false, folder: ConfigTrust.covered(entry) }
      if (entry.type === "document") return [{ commands: entry.info.commands, ...trust }]
      if (entry.type !== "directory") return []
      const files = yield* CommandFile.load(fs, entry.path, (file) => projectTrust.supplies(entry, file))
      const commands = Object.fromEntries(files.map((command) => [command.name, command.info]))
      if (entry.trusted !== false) return [{ commands, ...trust }]
      // Cut down like the commands of the folder's documents: a command does not choose which of the user's agents runs.
      // A command names no paths, so what matters about the place is only the folder it belongs to.
      const sanitized = ConfigTrust.sanitizeCommands(commands, {
        roots: [ConfigTrust.holder(entry.path)],
        directory: entry.path,
      })
      return [{ commands: sanitized.value, ...trust }]
    })
    const location = yield* Location.Service
    const managed = yield* ManagedPolicy.Service
    const processes = yield* AppProcess.Service
    const shell = yield* ShellSelect.Service
    const permission = yield* Permission.Service
    const access = yield* FileAccess.Service
    const guarded = yield* Effect.context<
      FSUtil.Service | ProjectTrust.Service | FileAccess.Service | Location.Service | Permission.Service | PowerShellParse.Service
    >()
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.make
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = {
      documents: [] as { commands: Info["commands"]; trusted: boolean; folder: string | undefined }[],
    }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.command.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isCommandSource(entries, update.path))),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    yield* ctx.command.transform((editor) => {
      for (const document of loaded.documents) {
        for (const [name, command] of Object.entries(document.commands ?? {})) {
          const subagent = command.subagent ?? command.subtask
          editor.add({
            name,
            description: command.description,
            execute: (input) =>
              Effect.gen(function* () {
                const agent = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
                const commandAgent = agent === undefined ? undefined : (yield* ctx.agent.get({ agentID: agent })).data
                const model =
                  command.model === undefined
                    ? commandAgent?.model
                    : {
                        id: Model.ID.make(command.model.model),
                        providerID: Provider.ID.make(command.model.providerID),
                        ...(command.model.variant === undefined
                          ? {}
                          : { variant: Model.VariantID.make(command.model.variant) }),
                      }
                const text = yield* evaluateTemplate(
                  command.template,
                  input.prompt.text,
                  input.sessionID,
                  { access, guarded, config, location, managed, permission, processes, shell },
                  { name, trusted: document.trusted, folder: document.folder },
                )
                if (subagent ?? commandAgent?.mode === "subagent") {
                  const parent = yield* sessions.get(input.sessionID)
                  const selected = yield* agents.select(agent ?? parent.agent)
                  const child = yield* sessions.create({
                    parentID: parent.id,
                    title: command.description ?? name,
                    agent: selected.id,
                    model: model ?? selected.info?.model ?? parent.model,
                  })
                  yield* sessions.prompt({
                    ...input.prompt,
                    sessionID: child.id,
                    text,
                    resume: false,
                  })
                  const recovery = {
                    kind: "subagent" as const,
                    parentSessionID: parent.id,
                    childSessionID: child.id,
                    agent: selected.id,
                    description: command.description ?? name,
                  }
                  yield* subagents.start(recovery)
                  yield* subagents.background(recovery)
                  return
                }
                if (agent !== undefined) {
                  const session = yield* ctx.session.get({ sessionID: input.sessionID })
                  if (session.agent !== agent) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent })
                }
                if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
                yield* ctx.session.prompt({
                  ...input.prompt,
                  sessionID: input.sessionID,
                  text,
                  delivery: input.delivery,
                })
              }).pipe(Effect.asVoid),
          })
        }
      }
    })
  }),
})

// Keep in sync with the scan pattern and the name-strip regex in command-file.ts.
const sourceDirectories = ["command", "commands"] as const

// Matches anything at or under <root>/{command,commands}. No file-suffix check:
// directory-level events such as renames carry no per-file paths.
function isCommandSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

type Services = {
  readonly access: FileAccess.Interface
  /** What the shell guard reads, captured when the plugin is built. */
  readonly guarded: Context.Context<
    FSUtil.Service | ProjectTrust.Service | FileAccess.Service | Location.Service | Permission.Service | PowerShellParse.Service
  >
  readonly config: Config.Interface
  readonly location: Location.Info
  readonly managed: ManagedPolicy.Interface
  readonly permission: Permission.Interface
  readonly processes: AppProcess.Interface
  readonly shell: ShellSelect.Interface
}

function evaluateTemplate(
  template: string,
  input: string,
  sessionID: SessionSchema.ID,
  services: Services,
  source: { readonly name: string; readonly trusted: boolean; readonly folder: string | undefined },
) {
  return Effect.gen(function* () {
    // A folder that is not trusted may define commands but not start anything: its template is only text. Refusing
    // before the spans are read means nothing is scanned, asked about or run for it. Trust is decided for the folder
    // that holds the config, which can be one above the project, so the refusal names it.
    if (!source.trusted && ConfigTrust.hasShellSnippet(template)) {
      const folder = source.folder === undefined ? "" : ` (${source.folder})`
      return yield* new UntrustedError({
        command: source.name,
        message: `The "${source.name}" command runs shell commands, and the folder it comes from${folder} is not trusted. Trust the folder, then run it again.`,
      })
    }
    // Spans are read from the authored template alone and run exactly as written, so a placeholder inside one reaches
    // the shell untouched. Argument text is expanded into the prose around them afterwards and is never scanned, so
    // it cannot start a command, even when a model supplied it.
    const parts = template.split(ConfigTrust.shellSnippet)
    const prose = parts.filter((_, index) => index % 2 === 0)
    const outputs = yield* runSpans(
      parts.filter((_, index) => index % 2 === 1),
      sessionID,
      services,
    )
    const args = parseArguments(input)
    const placeholders = prose.flatMap((text) => text.match(placeholderRegex) ?? [])
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    const append =
      placeholders.length === 0 && !prose.some((text) => text.includes("$ARGUMENTS")) && input.trim() !== ""
    const end = prose.length - 1
    const pieces = prose.map((text, part) => {
      const expanded = text
        .replaceAll(placeholderRegex, (_, index) => {
          const position = Number(index)
          const argIndex = position - 1
          if (argIndex >= args.length) return ""
          if (position === last) return args.slice(argIndex).join(" ")
          return args[argIndex]
        })
        .replaceAll("$ARGUMENTS", () => input)
      const piece = part === end && append ? `${expanded}\n\n${input}` : expanded
      // Trim only the template's own edges: span output goes in exactly as the command printed it.
      const head = part === 0 ? piece.trimStart() : piece
      return part === end ? head.trimEnd() : head
    })
    return pieces.flatMap((piece, part) => [piece, outputs[part] ?? ""]).join("")
  })
}

// Every span is checked and sandbox-wrapped before any of them starts, so a denial leaves nothing half-run.
function runSpans(sources: readonly string[], sessionID: SessionSchema.ID, services: Services) {
  return Effect.gen(function* () {
    if (sources.length === 0) return []
    // Like the shell tool, run in a shell the scanner can read: it parses bash and PowerShell, so under fish or nu the
    // resources it derives would not be the commands that run, and a deny rule could miss them.
    const shell = yield* services.shell.resolve({ priority: "compat" })
    const entries = yield* services.config.entries()
    const sandbox = Config.latest(entries, "sandbox")
    const portable = Config.latest(entries, "experimental")?.portable_shell_scanner === true
    const cwd = services.location.directory
    const settingsEnv = services.location.workspaceID === undefined ? ConfigEnv.resolve(entries) : {}
    const failure = (source: string) => (error: Error) =>
      interpolationError(source, error instanceof Permission.CorrectedError ? error.feedback : error.message)
    const planned = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const args = ShellSelect.args(shell, source)
        const network = services.managed.current().restrictions.network
        const settings = yield* ManagedNetwork.sandboxSettings(sandbox, network)
        const sandboxed = ShellSandbox.launch({
          settings,
          shell,
          args,
          cwd,
          writable: [services.location.project.directory, cwd, tmpdir()],
        })
        // The same gate as the shell tool, so a span is judged by what it does.
        const prepared = yield* ShellGuard.prepare({
          command: source,
          shell,
          cwd: yield* services.access.resolve({ path: cwd, kind: "directory" }),
          env: { ...process.env, ...settingsEnv },
          portable,
          writable:
            sandboxed.type === "wrapped"
              ? [services.location.project.directory, cwd, tmpdir(), ...(settings.write ?? [])]
              : undefined,
          // ACP titles a shell ask from the command it carries, and with no tool call it can only read it from here.
          metadata: { command: source },
          // Deliberately no tool source: a tool grant must never upgrade a span that template text started.
          base: { sessionID },
        }).pipe(Effect.provideContext(services.guarded))
        return { source, args, network, settings, sandboxed, prepared }
      }).pipe(Effect.mapError(failure(source))),
    )
    // A deny on any span blocks the whole template before the first question about any of them.
    yield* Effect.forEach(planned, (item) =>
      ShellGuard.denyPass(item.prepared).pipe(
        Effect.provideContext(services.guarded),
        Effect.mapError(failure(item.source)),
      ),
    )
    const commands = yield* Effect.forEach(planned, ({ source, args, network, sandboxed, prepared }) =>
      Effect.gen(function* () {
        yield* ShellGuard.ask(prepared).pipe(Effect.provideContext(services.guarded))
        // Fail closed: a sandbox the user asked for but cannot get must not quietly become an unsandboxed command.
        if (sandboxed.type === "missing")
          return yield* Effect.fail(new Error(`Shell sandboxing is enabled but ${sandboxed.tool} is not installed`))
        if (sandboxed.type === "unsupported") return yield* Effect.fail(new Error(sandboxed.reason))
        if (sandboxed.type === "unwrapped") yield* ManagedNetwork.unbound(network)
        const launch = sandboxed.type === "wrapped" ? sandboxed : { command: shell, args }
        // A snippet starts like the shell tool does: the settings' `env` over the process environment, host-local only.
        return ChildProcess.make(launch.command, launch.args, {
          cwd,
          stdin: "ignore",
          extendEnv: true,
          env: settingsEnv,
        })
      }).pipe(Effect.mapError(failure(source))),
    )
    return yield* Effect.forEach(
      commands,
      (command, index) =>
        services.processes.run(command, { combineOutput: true }).pipe(
          Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
          Effect.mapError((error) => interpolationError(sources[index], error.message)),
        ),
      { concurrency: 2 },
    )
  })
}

function interpolationError(source: string, reason: string) {
  return new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${reason}`)
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
