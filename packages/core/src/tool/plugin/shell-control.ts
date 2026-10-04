export * as ShellControlTools from "./shell-control.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Duration, Effect, Schema } from "effect"
import { NonNegativeInt } from "../../schema.js"
import { Shell } from "../../shell.js"

/**
 * Tools for the background commands a session started with the shell tool: read their new output, wait for a line
 * to appear, and stop them. Each tool only reaches commands its own session created.
 */

const MAX_OUTPUT_BYTES = 30_000
const POLL = Duration.millis(250)
const ShellID = Schema.String.annotate({ description: "Shell ID reported when the command moved to the background" })

export const OutputInput = Schema.Struct({
  shellID: ShellID,
  filter: Schema.optionalKey(Schema.String).annotate({
    description: "Regular expression; only new output lines that match it are returned.",
  }),
})
export const StopInput = Schema.Struct({ shellID: ShellID })
export const WatchInput = Schema.Struct({
  shellID: ShellID,
  pattern: Schema.String.annotate({ description: "Regular expression to wait for in the command's new output." }),
  timeout: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(600_000))).annotate({
    description: "Milliseconds to wait before giving up (default 60000, at most 600000).",
  }),
})

export const Plugin = {
  id: "orbit.tool.shell-control",
  effect: Effect.fn("ShellControlTools.Plugin")(function* (ctx: Context) {
    const shell = yield* Shell.Service
    // Where each session last stopped reading each command, so every call returns only what is new.
    const cursors = new Map<string, number>()

    const owned = Effect.fnUntraced(function* (shellID: string, sessionID: string) {
      const info = yield* shell
        .get(Shell.ID.make(shellID))
        .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.fail(missing(shellID))))
      if (info.metadata.sessionID !== sessionID) return yield* missing(shellID)
      return info
    })

    const unread = Effect.fnUntraced(function* (info: Shell.Info, sessionID: string) {
      const key = `${sessionID}:${info.id}`
      const latest = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
      const previous = cursors.get(key) ?? 0
      const start = Math.max(previous, latest.size - MAX_OUTPUT_BYTES)
      const page = yield* shell.output(info.id, { cursor: start, limit: MAX_OUTPUT_BYTES })
      cursors.set(key, page.cursor)
      const skipped = start - previous
      return {
        text:
          skipped > 0 ? `[${skipped} earlier bytes skipped; full output in ${info.file}]\n${page.output}` : page.output,
      }
    })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "shell_output",
        options: { codemode: false },
        description:
          "Read the output a background shell command produced since the last time you read it, with its status. Use it to check on dev servers, watchers, and long builds.",
        input: OutputInput,
        output: Schema.Struct({ status: Shell.Status, output: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const info = yield* owned(input.shellID, context.sessionID)
            const page = yield* unread(info, context.sessionID)
            const pattern = input.filter === undefined ? undefined : yield* regex(input.filter)
            const output = pattern
              ? page.text
                  .split("\n")
                  .filter((line) => pattern.test(line))
                  .join("\n")
              : page.text
            return {
              output: { status: info.status, output },
              content: `${describe(info)}\n${output || "(no new output)"}`,
            }
          }).pipe(Effect.mapError(failure("read output from", input.shellID))),
      })
      editor.add({
        name: "shell_watch",
        options: { codemode: false },
        description:
          "Wait until a background shell command prints a line matching a regular expression, or exits, then return its new output. Use it to wait for a server to report it is ready instead of sleeping.",
        input: WatchInput,
        output: Schema.Struct({ status: Shell.Status, matched: Schema.Boolean, output: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const pattern = yield* regex(input.pattern)
            yield* owned(input.shellID, context.sessionID)
            const seen: string[] = []
            const poll: Effect.Effect<{ info: Shell.Info; matched: boolean }, ToolFailure | Shell.NotFoundError> =
              Effect.gen(function* () {
                const info = yield* owned(input.shellID, context.sessionID)
                const page = yield* unread(info, context.sessionID)
                seen.push(page.text)
                if (pattern.test(seen.join(""))) return { info, matched: true }
                if (info.status !== "running") return { info, matched: false }
                yield* Effect.sleep(POLL)
                return yield* poll
              })
            const result = yield* poll.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(input.timeout ?? 60_000),
                orElse: () =>
                  owned(input.shellID, context.sessionID).pipe(Effect.map((info) => ({ info, matched: false }))),
              }),
            )
            const output = seen.join("").slice(-MAX_OUTPUT_BYTES)
            const outcome = result.matched
              ? "Matched."
              : result.info.status === "running"
                ? "Timed out waiting for a match."
                : "The command finished without a match."
            return {
              output: { status: result.info.status, matched: result.matched, output },
              content: `${outcome} ${describe(result.info)}\n${output || "(no new output)"}`,
            }
          }).pipe(Effect.mapError(failure("watch", input.shellID))),
      })
      editor.add({
        name: "shell_stop",
        options: { codemode: false },
        description: "Stop a background shell command this session started. Its output stays readable.",
        input: StopInput,
        output: Schema.Struct({ status: Shell.Status }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const info = yield* owned(input.shellID, context.sessionID)
            const stopped = yield* shell.kill(info.id)
            return {
              output: { status: stopped.status },
              content:
                info.status === "running"
                  ? `Stopped ${info.id}.`
                  : `${info.id} had already finished. ${describe(stopped)}`,
            }
          }).pipe(Effect.mapError(failure("stop", input.shellID))),
      })
    })
  }),
}

const missing = (shellID: string) =>
  new ToolFailure({ message: `No background command ${shellID} belongs to this session.` })

const regex = (source: string) =>
  Effect.try({
    try: () => new RegExp(source, "m"),
    catch: () => new ToolFailure({ message: `Invalid regular expression: ${source}` }),
  })

const describe = (info: Shell.Info) =>
  info.status === "running"
    ? `[${info.id} is running: ${info.command}]`
    : `[${info.id} ${info.status}${info.exit === undefined ? "" : ` with exit code ${info.exit}`}: ${info.command}]`

const failure = (verb: string, shellID: string) => (error: unknown) =>
  error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to ${verb} ${shellID}`, error })
