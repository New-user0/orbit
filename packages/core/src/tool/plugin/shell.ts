export * as ShellTool from "./shell.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { ShellCreateBefore } from "@orbit/plugin/effect/shell"
import type { Tool } from "@orbit/schema/tool"
import { AppProcess } from "@orbit/util/process"
import { ConfigShellTool } from "@orbit/schema/config/shell-tool"
import { Deferred, Duration, Effect, Fiber, Ref, Schema, SchemaGetter, Scope } from "effect"
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
import { ToolOutput } from "../../tool-output.js"

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
  "The command keeps running on its own, and its output comes back to you in a message when it ends. Waiting on it by sleeping, re-reading or searching its output file is polling; poll only when the user requests it, even if the next step needs the result. One look at the output so far is fine when it lets you do something useful now. Meanwhile do the work that does not depend on the result; if there is none, close the turn, and the session picks up again when the command ends."
const duration = (ms: number) => {
  const minutes = Number((ms / 60_000).toFixed(2))
  return minutes < 1 ? `${ms} ms` : `${ms} ms (${minutes} ${minutes === 1 ? "minute" : "minutes"})`
}
const description = (shell: string | undefined, limit: ReturnType<typeof limits>, head: number, background: boolean) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${ShellSelect.platformName(process.platform)} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    `Output longer than ${head.toLocaleString("en-US")} bytes does not come back in full: all of it is saved to a file, and the result gives that file's path and a preview of its start.`,
    "Rely on automatic truncation unless filtering the output is more useful.",
    ...(background
      ? [
          `Commands accept an optional timeout in milliseconds, up to ${duration(limit.max)}. By default a foreground command waits ${duration(limit.timeout)}.`,
          "A foreground command still running at its timeout is not stopped: it moves to the background and a message reports back when it ends. A command made only of sleeps is stopped instead.",
          "Background commands have no timeout unless one is given.",
          "Background commands return at once and report back in a message when they end.",
        ]
      : [
          `Commands accept an optional timeout in milliseconds, up to ${duration(limit.max)}. By default a command waits ${duration(limit.timeout)}.`,
          "A command still running at its timeout is stopped.",
        ]),
  ].join(" ")

const TIMEOUT_DESCRIPTION =
  "Timeout in milliseconds for a foreground command. The tool description gives the default and the maximum. Background commands have no timeout unless one is given."

// A timeout written as a decimal string ("5000") is read as its number, which must then be a whole number of
// milliseconds; any other string is refused. The schema the model is shown still says integer.
const DECIMAL = /^-?\d+(\.\d+)?$/
const Timeout = Schema.declare(
  (input: unknown): input is number | string =>
    typeof input === "number" || (typeof input === "string" && DECIMAL.test(input)),
  {
    expected: "a whole number of milliseconds",
    toCodecJson: () =>
      Schema.link<number | string>()(NonNegativeInt.annotate({ description: TIMEOUT_DESCRIPTION }), {
        decode: SchemaGetter.transform((value: number) => value),
        encode: SchemaGetter.transform((value: number | string) => Number(value)),
      }),
  },
).pipe(
  Schema.decodeTo(NonNegativeInt, {
    decode: SchemaGetter.transform((value: number | string) => Number(value)),
    encode: SchemaGetter.transform((value: number) => value),
  }),
)

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
  timeout: Schema.optionalKey(Timeout).annotate({ description: TIMEOUT_DESCRIPTION }),
  run_in_background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command detached and return at once, which suits dev servers and long builds. No trailing ampersand is needed. A notification reports completion, so do not poll. TaskWatch waits for a server to become ready, and TaskStop ends the command.",
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

/**
 * What the call learns when its command ends: the output, the notes that follow it (each a text part of its own, so a
 * saved head stands for the output alone) and whether anyone should hear of it.
 */
type Settled = {
  readonly output: Output
  readonly notes: ReadonlyArray<string>
  // The run that started it ended, so its completion reaches no one.
  readonly abandoned: boolean
}

// `exitNotice` says whether a non-zero exit code is written into the text. A timeout and a kill by a signal always are.
const resultMessages = (output: Output, exitNotice = true, notes: ReadonlyArray<string> = []) => {
  const notice =
    output.status === "running"
      ? BACKGROUND_INSTRUCTION
      : ShellResult.notice(exitNotice ? output : { ...output, exit: undefined })
  return [...(output.output ? [output.output] : []), ...notes, ...(notice ? [notice] : [])]
}

// The head that stands for output that did not fit starts at its first line that is not blank and has no trailing space.
const trimHead = (text: string) => text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd()

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

// What the scheduler reads to cancel the calls beside a failed one. Only a bash-dialect shell cancels them, because its
// steps depend on each other; a PowerShell call cancels nothing, whatever way it fails (a timeout, a signal, a start
// that fails or a removed command included).
const failedMetadata = (powershell: boolean) => (powershell ? {} : { error: true })

const toolResult = (output: Output, failed = false, powershell = false, notes: ReadonlyArray<string> = []) => {
  // A foreground run says "Exited with code N" only when that code is a failure of its command (a grep with no match,
  // a diff that found differences and a false test are answers, and say nothing). PowerShell keeps its notice: its
  // codes are not judged.
  const messages = resultMessages(output, failed || powershell, notes)
  return {
    output,
    // A command that printed nothing and has no notice gives one blank part, so the step stores its empty marker
    // instead of the structured output as text.
    content: (messages.length === 0 ? [""] : messages).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      // A timeout, a kill by signal and an exit code that reads as a failure (see `exitFailed`) cancel sibling calls.
      ...(output.timeout === true || output.signal !== undefined || failed ? failedMetadata(powershell) : {}),
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
      background: boolean,
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
        portable: Config.experimental(entries, "portable_shell_scanner") === true,
        writable,
        base: { sessionID: context.sessionID, agent: context.agent, source },
      }).pipe(Effect.provideContext(guarded))
      // The deadline as the hooks left it. A foreground command is moved to the background at its deadline, so the Shell
      // service never kills it on a timer; only a command made of sleeps alone is left to be killed. An input that cannot
      // be analysed counts as not sleep-led, so it is moved and never killed. With background tasks off nothing moves, so
      // every command is killed at its deadline.
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
      if (deadline <= 0 || analysis.sleepLed || !background)
        return { budget: deadline, autoBackground: false, analysis }
      invocation.timeout = 0
      return { budget: deadline, autoBackground: true, analysis }
    })

    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        file: string,
        settled: Deferred.Deferred<Settled>,
      ) {
        // Every command that leaves the foreground goes through here, and from now on its output size is watched.
        yield* shell.background(Shell.ID.make(shellID)).pipe(Effect.ignore)
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
        const done = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const output = done?.output
        // The run that started the command has ended, and so has the session's interest in it: only its marker goes.
        if (done?.abandoned) {
          if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
          return
        }
        const text = done
          ? [
              ...resultMessages(done.output, true, done.notes),
              ...(done.output.truncated ? [ShellResult.savedNotice(file)] : []),
            ].join("\n\n")
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
            // The result is at most the head of the output (`Shell.result`); output that did not fit is offered to the step
            // as the saved copy. A head raised past this by `tool_output.max_bytes` is saved by the step like any result.
            maxResultChars: 30_000,
          },
          description: description(undefined, limits(), Shell.HEAD_BYTES, true),
          input: Input,
          output: Output,
          execute: (input, context) => {
            let powershell = false
            return Effect.gen(function* () {
              // Read at call time, so a config change applies to the next call.
              const entries = yield* config.entries()
              // With background tasks off a background request runs in the foreground, and nothing moves later.
              const background = Config.latest(entries, "background_tasks") !== false
              const detached = background && input.run_in_background === true
              const timeout = budget(
                { ...input, run_in_background: detached },
                limits(Config.latest(entries, "shell_tool")),
              )
              let finalTimeout = timeout
              let autoBackground = false
              let analysis: ShellAnalysis.Analysis | undefined
              const selected = yield* compatibleShell
              powershell = ["powershell", "pwsh"].includes(ShellSelect.name(selected))
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
                    const prepared = yield* prepare(invocation, context, !detached, background)
                    finalTimeout = prepared.budget
                    autoBackground = prepared.autoBackground
                    analysis = prepared.analysis
                  }),
              )
              const settled = yield* Deferred.make<Settled>()
              const startedJob = yield* Ref.make<string | undefined>(undefined)
              // An interrupt after create returns and before block takes over would leave the command running until its
              // timeout, and for ever without one: take the shell back, and the job once it has started.
              const job = yield* Effect.gen(function* () {
                yield* context.progress({ shellID: info.id })
                const run = Effect.gen(function* () {
                  const result = yield* shell.result(info)
                  if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
                  const output = ShellResult.output(result)
                  return {
                    output: { ...output, status: "completed" as const },
                    notes: output.timeout
                      ? [
                          `Command exceeded timeout of ${finalTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                        ]
                      : [],
                    abandoned: result.abandoned === true,
                  }
                }).pipe(
                  Effect.tap((done) => Deferred.succeed(settled, done)),
                  Effect.map((done) => resultMessages(done.output, true, done.notes).join("\n\n")),
                  Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
                )
                const started = yield* jobs.start({
                  // CodeMode children share a tool-call ID, but each shell must own its job.
                  id: info.id,
                  type: "shell",
                  title: input.description ?? info.command,
                  metadata: { sessionID: context.sessionID, shellID: info.id },
                  // Only a command that can leave the foreground needs its notice delivered after a restart.
                  ...(background
                    ? {
                        recovery: {
                          kind: "shell" as const,
                          sessionID: context.sessionID,
                          shellID: info.id,
                          command: info.command,
                        },
                      }
                    : {}),
                  run,
                })
                yield* Ref.set(startedJob, started.id)
                return started
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    const id = yield* Ref.get(startedJob)
                    if (id) yield* jobs.cancel(id)
                    yield* shell.remove(info.id)
                  }).pipe(Effect.ignore),
                ),
              )

              if (detached) {
                yield* jobs.background(job.id)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, info.file, settled)
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
              // With background tasks off the call waits without blocking on the job, so the session's move-to-background
              // signal, which moves only what blocks, leaves the command where it is.
              const result = yield* (
                background
                  ? jobs.block({ id: job.id, sessionID: context.sessionID })
                  : jobs
                      .wait({ id: job.id })
                      .pipe(Effect.map((waited) => waited.info && { type: "finished" as const, info: waited.info }))
              ).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    // Stop the timer before cancelling, or it could move a job that was just cancelled and leave a marker
                    // that only a restart would deliver.
                    if (yield* stopTimer)
                      return yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, info.file, settled)
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
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, info.file, settled)
                return toolResult(backgroundResult(info.id, info.file, timerMoved ? finalTimeout : undefined))
              }
              if (notificationID) yield* jobs.completeBackground(notificationID)
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: result.info.error ?? "Command failed",
                  metadata: failedMetadata(powershell),
                })
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              const done = yield* Deferred.await(settled)
              // A failure is never saved: its text is cut to its first and last 5,000 characters.
              if (exitFailed(done.output, analysis, powershell))
                return toolResult(
                  { ...done.output, output: ToolOutput.cutError(done.output.output) },
                  true,
                  powershell,
                  done.notes,
                )
              if (!done.output.truncated) return toolResult(done.output, false, powershell, done.notes)
              // Output that did not fit: the step saves the whole file behind its head, which the result keeps.
              yield* shell
                .offer({ id: info.id, sessionID: context.sessionID, messageID: context.messageID, callID: context.id })
                .pipe(Effect.ignore)
              return toolResult({ ...done.output, output: trimHead(done.output.output) }, false, powershell, done.notes)
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
                        ? { metadata: failedMetadata(powershell) }
                        : {}),
                  }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const entries = yield* config.entries()
        const limit = limits(Config.latest(entries, "shell_tool"))
        const background = Config.latest(entries, "background_tasks") !== false
        tool.description = description(
          ShellSelect.name(yield* compatibleShell),
          limit,
          Shell.headLimit(Config.latest(entries, "tool_output")),
          background,
        )
        // The inputs are shared shallow copies, so this assigns a new object rather than changing the shared one.
        const properties =
          typeof tool.input.properties === "object" && tool.input.properties !== null ? tool.input.properties : {}
        const { run_in_background: _, ...foreground } = properties as Record<string, unknown>
        tool.input = {
          ...tool.input,
          properties: {
            // With background tasks off the model is not offered a background run.
            ...(background ? properties : foreground),
            timeout: {
              ...("timeout" in properties ? (properties.timeout as object) : {}),
              maximum: limit.max,
              description: background
                ? `Timeout in milliseconds for a foreground command, at most ${limit.max}. A foreground command that is still running then moves to the background. Background commands have no timeout unless one is given.`
                : `Timeout in milliseconds, at most ${limit.max}. A command still running then is stopped.`,
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
        // The guidance and the model prompts call the tool `Bash`. The author's own words in an agent's system prompt are
        // registered as personal text, which the rename leaves alone.
        const system = event.system[0]
        if (!system) return
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
