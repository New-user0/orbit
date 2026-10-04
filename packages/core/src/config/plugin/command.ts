export * as ConfigCommandPlugin from "./command.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Info, type Entry } from "@orbit/schema/config"
import { ConfigCommand } from "@orbit/schema/config/command"
import { Model } from "@orbit/schema/model"
import { Provider } from "@orbit/schema/provider"
import { AppProcess } from "@orbit/util/process"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSandbox } from "../../shell/sandbox.js"
import { ShellSelect } from "../../shell/select.js"
import { which } from "../../util/which.js"
import { FSUtil } from "@orbit/util/fs-util"
import { ConfigMarkdown } from "../markdown.js"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

export const Plugin = define({
  id: "orbit.config.command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [{ commands: entry.info.commands }]
      if (entry.type !== "directory") return []
      const commands = yield* loadDirectory(fs, entry.path)
      return [{ commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) }]
    })
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    const shell = yield* ShellSelect.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.make
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as { commands: Info["commands"] }[] }
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
                const text = yield* evaluateTemplate(command.template, input.prompt.text, input.sessionID, {
                  config,
                  location,
                  permission,
                  processes,
                  shell,
                })
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
                    text: ["You are a subagent spawned by another session.", text].join("\n"),
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

// Keep in sync with the loadDirectory scan pattern and the name-strip regex in decode.
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

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.orElseSucceed(() => [] as string[]))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}

type Services = {
  readonly config: Config.Interface
  readonly location: Location.Info
  readonly permission: Permission.Interface
  readonly processes: AppProcess.Interface
  readonly shell: ShellSelect.Interface
}

function evaluateTemplate(template: string, input: string, sessionID: SessionSchema.ID, services: Services) {
  return Effect.gen(function* () {
    // Spans are read from the authored template alone and run exactly as written, so a placeholder inside one reaches
    // the shell untouched. Argument text is expanded into the prose around them afterwards and is never scanned, so
    // it cannot start a command, even when a model supplied it.
    const parts = template.split(shellRegex)
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
    const shell = yield* services.shell.resolve({ priority: "config" })
    const entries = yield* services.config.entries()
    const sandbox = Config.latest(entries, "sandbox")
    const sandboxTool = ShellSandbox.TOOL[process.platform]
    const portable = Config.latest(entries, "experimental")?.portable_shell_scanner === true
    const cwd = services.location.directory
    const commands = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const parsed = yield* ShellParse.scan(source, shell, cwd, { portable })
        yield* services.permission.assert({
          action: "shell",
          // A span the scanner finds no command in, such as a bare redirect, is still asked about as written.
          resources: parsed.commands.length > 0 ? parsed.commands.map((command) => command.resource) : [source],
          save: parsed.commands.map((command) => command.save),
          sessionID,
          // Deliberately no tool source: a tool grant must never upgrade a span that template text started.
        })
        const args = ShellSelect.args(shell, source)
        const sandboxed = ShellSandbox.wrap({
          platform: process.platform,
          settings: sandbox ?? {},
          shell,
          args,
          cwd,
          writable: [services.location.project.directory, cwd, tmpdir()],
          tool: sandbox?.enabled && sandboxTool ? (which(sandboxTool) ?? undefined) : undefined,
        })
        // Fail closed: a sandbox the user asked for but cannot get must not quietly become an unsandboxed command.
        if (sandboxed.type === "missing")
          return yield* Effect.fail(new Error(`Shell sandboxing is enabled but ${sandboxed.tool} is not installed`))
        const launch = sandboxed.type === "wrapped" ? sandboxed : { command: shell, args }
        return ChildProcess.make(launch.command, launch.args, { cwd, stdin: "ignore" })
      }).pipe(
        Effect.mapError((error) =>
          interpolationError(source, error instanceof Permission.CorrectedError ? error.feedback : error.message),
        ),
      ),
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
const shellRegex = /!`([^`]+)`/g
