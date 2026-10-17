export * as ShellTool from "./shell.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { ShellCreateBefore } from "@orbit/plugin/effect/shell"
import type { Tool } from "@orbit/schema/tool"
import { AppProcess } from "@orbit/util/process"
import { ConfigShellTool } from "@orbit/schema/config/shell-tool"
import { Deferred, Duration, Effect, Fiber, Ref, Schema, Scope } from "effect"
import os from "node:os"
import path from "node:path"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ToolNames } from "../names.js"
import { STYLE_HEADING } from "../../plugin/output-style.js"
import { SessionSystemPrompt } from "../../session/system-prompt.js"
import { ShellAnalysis } from "../../shell/analysis.js"
import { FSUtil } from "@orbit/util/fs-util"
import { ProjectTrust } from "../../project-trust.js"
import { ManagedNetwork } from "../../managed-network.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { ShellDestructive } from "../../shell/destructive.js"
import { ShellGuard } from "../../shell/guard.js"
import { ShellSandbox } from "../../shell/sandbox.js"
import { ShellExit } from "../../shell/exit.js"
import { ShellParse } from "../../shell/parse.js"
import { PowerShellParse } from "../../shell/powershell-parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"
import { ShellStall } from "../../shell/stall.js"

export const name = "Bash"

/** The default and the largest timeout of a call. The largest is never below the default. */
export function limits(configured?: ConfigShellTool.Info) {
  const timeout = configured?.timeout ?? ConfigShellTool.DEFAULT_TIMEOUT
  return { timeout, max: Math.max(configured?.max_timeout ?? ConfigShellTool.DEFAULT_MAX_TIMEOUT, timeout) }
}

/**
 * How long a call waits. A foreground call that gives no timeout, or 0, waits the default. A background call with
 * no timeout, or 0, has no deadline. Anything given is capped at the maximum.
 */
export function budget(
  input: Pick<typeof Input.Type, "timeout" | "run_in_background">,
  limit: ReturnType<typeof limits>,
) {
  if (input.run_in_background === true) return input.timeout ? Math.min(input.timeout, limit.max) : 0
  return Math.min(input.timeout || limit.timeout, limit.max)
}

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const duration = (ms: number) => {
  const minutes = Number((ms / 60_000).toFixed(2))
  return minutes < 1 ? `${ms} ms` : `${ms} ms (${minutes} ${minutes === 1 ? "minute" : "minutes"})`
}
const description = (shell: string | undefined, limit: ReturnType<typeof limits>) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${ShellSelect.platformName(process.platform)} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    `Commands accept an optional timeout in milliseconds, up to ${duration(limit.max)}. By default a foreground command waits ${duration(limit.timeout)}.`,
    "A foreground command still running at its timeout is not stopped: it moves to the background and you are notified when it finishes. A command made only of sleeps is stopped instead.",
    "Background commands have no timeout unless one is given.",
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
    description:
      "Timeout in milliseconds for a foreground command. The tool description gives the default and the maximum. Background commands have no timeout unless one is given.",
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

/**
 * Whether a finished foreground run is a failure by its exit code. A run that timed out or was killed by a signal is a
 * failure elsewhere. Under PowerShell an exit code never is one: a PowerShell call cancels no sibling, and `-Command`
 * reports every native code other than 0 as 1, so the code carries no meaning to judge. Every other shell is judged by
 * `ShellExit` on the analysis of the command that ran.
 */
const exitFailed = (output: Output, analysis: ShellAnalysis.Analysis | undefined, powershell: boolean) =>
  !powershell &&
  output.status === "completed" &&
  output.exit !== undefined &&
  output.timeout !== true &&
  output.signal === undefined &&
  ShellExit.failed(analysis, output.exit)

const toolResult = (output: Output, failed = false) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      // A timeout, a kill by signal and an exit code that reads as a failure (see `exitFailed`) cancel sibling calls.
      ...(output.timeout === true || output.signal !== undefined || failed ? { error: true } : {}),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string, deadline?: number) => ({
  output: `${deadline === undefined ? "" : ShellResult.deadlineNotice(deadline) + "\n"}Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

/**
 * Whether a call may run beside others: exactly when the command is read-only to the synchronous analysis. Only a
 * bash-dialect shell is analysed here; PowerShell, cmd and any unrecognised shell answer false without parsing,
 * because PowerShell is judged read-only only in the permission path, where its parse is available.
 */
export const concurrent = Effect.fn("ShellTool.concurrent")(function* (command: string, ctx: ShellAnalysis.Context) {
  if (ShellAnalysis.dialect(ctx.shell, ctx) !== "bash") return false
  // The working folder is the model's own text and nobody has been asked about it yet: a share is not opened to judge.
  if (ShellAnalysis.opensShare(ctx)) return false
  return (yield* ShellAnalysis.inspect(command, ctx)).readOnly
})

/**
 * Whether the command text is in the destructive catalogue of the shell's dialect. Pure text, no parse. A shell with no
 * catalogue (cmd.exe, any unrecognised shell) answers true.
 */
export function destructive(command: string, ctx: Pick<ShellAnalysis.Context, "shell" | "platform" | "path">) {
  return ShellDestructive.matches(command, ShellAnalysis.dialect(ctx.shell, ctx))
}

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
    const powershellParse = yield* PowerShellParse.Service
    const location = yield* Location.Service
    const managed = yield* ManagedPolicy.Service
    // What the guard reads from the disk, captured here so a call needs none of it from its caller.
    const guarded = yield* Effect.context<
      FSUtil.Service | ProjectTrust.Service | FileAccess.Service | Location.Service | Permission.Service | PowerShellParse.Service
    >()

    const prepare = Effect.fn("ShellTool.prepare")(function* (
      invocation: ShellCreateBefore,
      context: Tool.Context,
      foreground: boolean,
    ) {
      const source = {
        type: "tool" as const,
        messageID: context.messageID,
        id: context.id,
      }
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      // The folder as resolved, before anything is asked, so a client names where the command runs even when no rule asks.
      yield* context.progress({ places: [target.place] })
      const entries = yield* config.entries()
      // The folders the command may write when it runs inside the sandbox; unset when it runs without one.
      const sandbox = yield* ManagedNetwork.sandboxSettings(
        Config.latest(entries, "sandbox"),
        managed.current().restrictions.network,
      )
      const writable =
        ShellSandbox.launch({
          settings: sandbox,
          shell: invocation.shell,
          args: ShellSelect.args(invocation.shell, invocation.command),
          cwd: target.absolute,
          writable: [],
        }).type === "wrapped"
          ? [location.project.directory, target.absolute, os.tmpdir(), ...(sandbox.write ?? [])]
          : undefined
      // The one parse of the call, and every question the command needs, asked after every request is checked for a deny.
      const analysis = yield* ShellGuard.authorize({
        command: invocation.command,
        shell: invocation.shell,
        cwd: target,
        env: invocation.env,
        portable: Config.latest(entries, "experimental")?.portable_shell_scanner === true,
        writable,
        base: { sessionID: context.sessionID, agent: context.agent, source },
      }).pipe(Effect.provideContext(guarded))
      // The deadline as the hooks left it. A foreground command is moved to the background at its deadline, so the Shell
      // service never kills it on a timer; only a command made of sleeps alone is left to be killed. An input that cannot
      // be analysed counts as not sleep-led, so it is moved and never killed.
      const deadline = invocation.timeout
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      // The analysis also reads the exit code of a foreground call.
      if (!foreground) return { budget: deadline, autoBackground: false, analysis: undefined }
      if (deadline <= 0 || analysis.sleepLed) return { budget: deadline, autoBackground: false, analysis }
      invocation.timeout = 0
      return { budget: deadline, autoBackground: true, analysis }
    })

    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        settled: Deferred.Deferred<Output>,
      ) {
        // Watched until the command ends.
        const watcher = yield* ShellStall.watch({
          size: shell.output(Shell.ID.make(shellID), { cursor: Number.MAX_SAFE_INTEGER }).pipe(
            Effect.map((out) => out.size),
          ),
          tail: Effect.gen(function* () {
            const size = (yield* shell.output(Shell.ID.make(shellID), { cursor: Number.MAX_SAFE_INTEGER })).size
            return (yield* shell.output(Shell.ID.make(shellID), {
              cursor: Math.max(0, size - ShellStall.TAIL_BYTES),
              limit: ShellStall.TAIL_BYTES,
            })).output
          }),
          onStall: (tail) =>
            Effect.gen(function* () {
              if ((yield* jobs.get(id))?.status !== "running") return
              // A new message: the completion notice keeps the job's own ID, and the background marker stays until the
              // command really ends.
              yield* sessions.synthetic({
                sessionID,
                description: command,
                ...ShellResult.notification({
                  jobID: id,
                  shellID,
                  command,
                  state: "waiting",
                  text: ShellResult.stallNotice({ shellID, tail }),
                }),
              })
            }).pipe(Effect.ignore),
        }).pipe(Effect.forkChild({ startImmediately: true }))
        const info = (yield* jobs.wait({ id }).pipe(Effect.ensuring(Fiber.interrupt(watcher)))).info
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

    const commandReadOnly = (input: { command: string; workdir?: string }) =>
      Effect.gen(function* () {
        return yield* concurrent(input.command, {
          shell: yield* compatibleShell,
          platform: process.platform,
          path: process.platform === "win32" ? path.win32 : path.posix,
          home: os.homedir(),
          cwd: input.workdir ? FileAccess.resolvePath(location.directory, input.workdir) : location.directory,
          env: process.env,
        }).pipe(Effect.provideService(PowerShellParse.Service, powershellParse))
      })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: {
            cancelSiblingsOnFailure: true,
            // Decided on the input the model sent, before any hook, from the command text alone: not the background
            // flag, the timeout or the paths it reads. The scheduler runs a call that answers false by itself.
            concurrencySafe: (input) => commandReadOnly(input),
            // The same verdict as `concurrencySafe`, and like it a verdict on the command text alone: it ignores the
            // paths the command reads, the background flag and permission rules. Nothing relaxes a permission on it, and
            // a consumer that wants to must first add the read-path conditions that shell-safety owns.
            readOnly: (input) => commandReadOnly(input),
            destructive: (input) =>
              Effect.gen(function* () {
                return destructive(input.command, {
                  shell: yield* compatibleShell,
                  platform: process.platform,
                  path: process.platform === "win32" ? path.win32 : path.posix,
                })
              }),
            // interruptBehavior stays "block": a new user message does not cancel a running shell call.
          },
          description: description(undefined, limits()),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              // Read at call time, so a config change applies to the next call.
              const timeout = budget(input, limits(Config.latest(yield* config.entries(), "shell_tool")))
              let finalTimeout = timeout
              let autoBackground = false
              let analysis: ShellAnalysis.Analysis | undefined
              const selected = yield* compatibleShell
              const powershell = ["powershell", "pwsh"].includes(ShellSelect.name(selected))
              const info = yield* shell.create(
                {
                  command: input.command,
                  cwd: input.workdir,
                  timeout,
                  shell: selected,
                  metadata: { sessionID: context.sessionID },
                },
                (invocation) =>
                  Effect.gen(function* () {
                    invocation.env.AGENT = "1"
                    invocation.env.ORBIT = "1"
                    invocation.env.AI_AGENT ||= "orbit"
                    invocation.env.ORBIT_SESSION_ID = context.sessionID
                    const prepared = yield* prepare(invocation, context, input.run_in_background !== true)
                    finalTimeout = prepared.budget
                    autoBackground = prepared.autoBackground
                    analysis = prepared.analysis
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
                return toolResult(backgroundResult(info.id, info.file))
              }

              // The deadline of a command that is not killed on a timer. Measured from just after the spawn. It moves the
              // job uninterruptibly, so once it is interrupted and joined, `moved` says for certain whether it did.
              const moved = yield* Ref.make<Job.Info | undefined>(undefined)
              const timer = autoBackground
                ? yield* Effect.sleep(Duration.millis(finalTimeout)).pipe(
                    Effect.andThen(
                      Effect.uninterruptible(
                        jobs.background(job.id).pipe(Effect.flatMap((backgrounded) => Ref.set(moved, backgrounded))),
                      ),
                    ),
                    Effect.forkChild({ startImmediately: true }),
                  )
                : undefined
              const stopTimer = Effect.gen(function* () {
                if (timer) yield* Fiber.interrupt(timer)
                return yield* Ref.get(moved)
              })
              const result = yield* jobs.block({ id: job.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    // Stop the timer before cancelling, or it could move a job that was just cancelled and leave a marker
                    // that only a restart would deliver.
                    if (yield* stopTimer)
                      return yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                    yield* jobs.cancel(job.id)
                  }).pipe(Effect.ignore),
                ),
              )
              const timerMoved = yield* stopTimer
              // A command that exits before the call has seen it move is reported as finished, once: its marker is cleared
              // and no notification follows.
              const notificationID = result?.info.notificationID ?? timerMoved?.notificationID
              if (result?.type === "backgrounded" && !(yield* Deferred.isDone(settled))) {
                if (!timerMoved) yield* shell.timeout(info.id, 0)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return toolResult(backgroundResult(info.id, info.file, timerMoved ? finalTimeout : undefined))
              }
              if (notificationID) yield* jobs.completeBackground(notificationID)
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: result.info.error ?? "Command failed",
                  metadata: { error: true },
                })
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              const output = yield* Deferred.await(settled)
              return toolResult(output, exitFailed(output, analysis, powershell))
            }).pipe(
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
        const limit = limits(Config.latest(yield* config.entries(), "shell_tool"))
        tool.description = description(ShellSelect.name(yield* compatibleShell), limit)
        // The inputs are shared shallow copies, so this assigns a new object rather than changing the shared one.
        const properties = tool.input.properties
        tool.input = {
          ...tool.input,
          properties: {
            ...(typeof properties === "object" && properties !== null ? properties : {}),
            timeout: {
              ...(typeof properties === "object" && properties !== null && "timeout" in properties
                ? (properties.timeout as object)
                : {}),
              maximum: limit.max,
              description: `Timeout in milliseconds for a foreground command, at most ${limit.max}. A foreground command that is still running then moves to the background. Background commands have no timeout unless one is given.`,
            },
          },
        }
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
        // The git section and an output style are appended to this text before this runs. The section names no shell tool
        // and carries the person's attribution text, and the style is the person's own words, so both stay as written.
        const gitAt = system.text.indexOf(`\n\n${SessionSystemPrompt.GIT_HEADING}\n`)
        const styleAt = system.text.indexOf(STYLE_HEADING)
        const at = Math.min(...[gitAt, styleAt].filter((index) => index >= 0), system.text.length)
        // The person's own text from the prompt keys keeps the word it used.
        const pieces = SessionSystemPrompt.personal.get(event) ?? []
        event.system[0] = {
          ...system,
          text:
            SessionSystemPrompt.outsidePersonal(system.text.slice(0, at), pieces, (part) =>
              part.replace(/\bBash\b/g, ToolNames.powershell),
            ) + system.text.slice(at),
        }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
