export * as ShellTool from "./shell.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { ShellCreateBefore } from "@orbit/plugin/effect/shell"
import type { Tool } from "@orbit/schema/tool"
import { AppProcess } from "@orbit/util/process"
import { Deferred, Effect, Schema, Scope } from "effect"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ToolNames } from "../names.js"
import { STYLE_HEADING } from "../../plugin/output-style.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"

export const name = "Bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
const description = (shell?: string) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
  ].join(" ")

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  description: Schema.optionalKey(Schema.String).annotate({
    description:
      "A short sentence saying what the command does, used as the title of the job when the command runs in the background.",
  }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
  }),
  run_in_background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion. To wait for a server to become ready, use TaskWatch; to stop the command, use TaskStop.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "running"])),
})

type Output = typeof Output.Type

const resultMessages = (output: Output) => {
  const notice = output.status === "running" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output)
  return [...(output.output ? [output.output] : []), ...(notice ? [notice] : [])]
}

const toolResult = (output: Output) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      // A timeout or a kill by signal counts as a failure that cancels sibling calls. Exit codes do not yet.
      ...(output.timeout === true || output.signal !== undefined ? { error: true } : {}),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string) => ({
  output: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

export const Plugin = {
  id: "orbit.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const scope = yield* Scope.Scope
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service
    const config = yield* Config.Service

    const prepare = Effect.fn("ShellTool.prepare")(function* (invocation: ShellCreateBefore, context: Tool.Context) {
      const source = {
        type: "tool" as const,
        messageID: context.messageID,
        id: context.id,
      }
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      // The folder as resolved, before anything is asked, so a client names where the command runs even when no rule asks.
      yield* context.progress({ places: [target.place] })
      const timeout = invocation.timeout
      const portable = Config.latest(yield* config.entries(), "experimental")?.portable_shell_scanner === true
      const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute, { portable })
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({
          path: FileAccess.resolvePath(target.absolute, directory),
          kind: "directory",
        }),
      )
      // A plain word of the command that a link in an untrusted project leads out of it, such as `cfg/orbit.json` in
      // `cat cfg/orbit.json`, is asked about as the folder it really is in. A path the command builds as it runs is not.
      const operands = yield* access.escaped(
        (yield* ShellParse.operands(invocation.command, invocation.shell)).map((operand) =>
          FileAccess.resolvePath(target.absolute, operand),
        ),
      )
      yield* access.authorizeExternal([target, ...directories, ...operands], context)
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: name,
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          // The folder the command runs in, as resolved here, so a client shows it rather than the input's spelling, and
          // the real folder when a link in an untrusted project leads there.
          metadata: { workdir: target.place },
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        settled: Deferred.Deferred<Output>,
      ) {
        const info = (yield* jobs.wait({ id })).info
        if (!info || info.status === "running") return
        const output = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const text = output
          ? resultMessages(output).join("\n\n")
          : info.status === "error"
            ? (info.error ?? "Command failed")
            : "Cancelled"
        yield* sessions.synthetic({
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,
          ...ShellResult.notification({
            jobID: id,
            shellID,
            command,
            state: info.status,
            text,
            output,
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      },
      Effect.forkIn(scope, { startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: { cancelSiblingsOnFailure: true },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const timeout =
                input.run_in_background === true ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS)
              let finalTimeout = timeout
              const info = yield* shell.create(
                {
                  command: input.command,
                  cwd: input.workdir,
                  timeout,
                  shell: yield* compatibleShell,
                  metadata: { sessionID: context.sessionID },
                },
                (invocation) =>
                  Effect.gen(function* () {
                    invocation.env.AGENT = "1"
                    invocation.env.ORBIT = "1"
                    invocation.env.AI_AGENT ||= "orbit"
                    invocation.env.ORBIT_SESSION_ID = context.sessionID
                    finalTimeout = yield* prepare(invocation, context)
                  }),
              )
              yield* context.progress({ shellID: info.id })

              const settled = yield* Deferred.make<Output>()
              const run = Effect.gen(function* () {
                const result = yield* shell.result(info)
                if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
                const output = ShellResult.output(result)
                return {
                  ...output,
                  output: output.timeout
                    ? `${output.output}\n\nCommand exceeded timeout of ${finalTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                    : output.output,
                  status: "completed" as const,
                }
              }).pipe(
                Effect.tap((output) => Deferred.succeed(settled, output)),
                Effect.map((output) => resultMessages(output).join("\n\n")),
                Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
              )
              const job = yield* jobs.start({
                // CodeMode children share a tool-call ID, but each shell must own its job.
                id: info.id,
                type: "shell",
                title: input.description ?? info.command,
                metadata: { sessionID: context.sessionID, shellID: info.id },
                recovery: {
                  kind: "shell",
                  sessionID: context.sessionID,
                  shellID: info.id,
                  command: info.command,
                },
                run,
              })

              if (input.run_in_background === true) {
                yield* jobs.background(job.id)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file)
              }

              const result = yield* jobs
                .block({ id: job.id, sessionID: context.sessionID })
                .pipe(Effect.onInterrupt(() => jobs.cancel(job.id).pipe(Effect.ignore)))
              if (result?.type === "backgrounded") {
                yield* shell.timeout(info.id, 0)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file)
              }
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: result.info.error ?? "Command failed",
                  metadata: { error: true },
                })
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              return yield* Deferred.await(settled)
            }).pipe(
              Effect.map(toolResult),
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: `Unable to execute command: ${input.command}`,
                    error,
                    // Only the execution-stage failure above carries `error: true`; prepare failures never do.
                    // A spawn or sandbox refusal (AppProcessError) means the command never ran: also a failure.
                    ...(error instanceof ToolFailure
                      ? { metadata: error.metadata }
                      : error instanceof AppProcess.AppProcessError
                        ? { metadata: { error: true } }
                        : {}),
                  }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        tool.description = description(ShellSelect.name(yield* compatibleShell))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

/**
 * Offers the shell tool to the model as PowerShell when that is the session shell. It is registered last among the
 * internal plugins, so it runs after every other plugin's context, compaction and generate hook: a hook written for
 * `shell` or `Bash` sees one name whatever the session shell is, and hides or replaces the tool however it is offered.
 * The registry still runs and authorizes it as `Bash`, and the base prompt is told the name the model sees.
 */
export const AdvertisePlugin = {
  id: "orbit.tool.shell.advertise",
  effect: Effect.fn("ShellTool.AdvertisePlugin")(function* (ctx: Context) {
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const shellName = ShellSelect.name(yield* compatibleShell)
        if (shellName !== "powershell" && shellName !== "pwsh") return
        const tool = event.tools[name]
        if (!tool) return
        event.tools[ToolNames.powershell] = tool
        delete event.tools[name]
        // The guidance and the model prompts call the tool `Bash`. An agent's own system prompt is its author's text.
        const system = event.system[0]
        if (!system) return
        const custom = yield* ctx.agent.get({ agentID: event.agent }).pipe(
          Effect.map((agent) => agent.data.system !== undefined),
          Effect.catch(() => Effect.succeed(true)),
        )
        if (custom) return
        // An output style is appended to this text before this runs and is the person's own words, so it stays as written.
        const at = system.text.indexOf(STYLE_HEADING)
        const base = at < 0 ? system.text : system.text.slice(0, at)
        const style = at < 0 ? "" : system.text.slice(at)
        event.system[0] = { ...system, text: base.replace(/\bBash\b/g, ToolNames.powershell) + style }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
