export * as LifecycleHooksPlugin from "./lifecycle-hooks.js"

import { define } from "@orbit/plugin/effect/plugin"
import { ConfigHooks } from "@orbit/schema/config/hooks"
import type { SessionEvent } from "@orbit/schema/session-event"
import { Tool } from "@orbit/schema/tool"
import { AppProcess } from "@orbit/util/process"
import { FSUtil } from "@orbit/util/fs-util"
import path from "path"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { ShellSelect } from "../../shell/select.js"
import type { PluginInternal } from "../../plugin/internal.js"

/**
 * Runs the shell commands configured under `hooks` at points in a session's life. Every document's hooks apply, in
 * config order. A command gets the event as JSON on stdin; exit code 2 or `{"decision":"block","reason":...}` on
 * stdout blocks a tool call, and other stdout becomes context for the model. A hook that fails to run is logged and
 * skipped, so a broken script never stops the session.
 */

const DEFAULT_TIMEOUT_SECONDS = 60
const Reply = Schema.Struct({
  decision: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  additionalContext: Schema.optionalKey(Schema.String),
})
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))
// Only the hooks key matters here; Claude Code's other settings are ignored.
const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ hooks: Schema.optionalKey(ConfigHooks.Info) })),
)

interface Outcome {
  readonly block?: string
  readonly context: string
}

const NOTHING: Outcome = { context: "" }

export const Plugin = define({
  id: "orbit.config.lifecycle-hooks",
  effect: Effect.fn("LifecycleHooksPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const processes = yield* AppProcess.Service
    const shells = yield* ShellSelect.Service
    const location = yield* Location.Service

    const fs = yield* FSUtil.Service

    // Claude Code keeps hooks in .claude/settings.json and settings.local.json; read them so existing hooks work here.
    const claudeHooks = Effect.fn("LifecycleHooksPlugin.claudeHooks")(function* () {
      const roots = config.compatibility ? (yield* config.compatibility()).claude : []
      const files = roots.flatMap((root) => [path.join(root, "settings.json"), path.join(root, "settings.local.json")])
      const settings = yield* Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file).pipe(
          Effect.map((text) => (text === undefined ? undefined : Option.getOrUndefined(decodeSettings(text))?.hooks)),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      return settings.filter((hooks) => hooks !== undefined)
    })

    const commands = Effect.fn("LifecycleHooksPlugin.commands")(function* (event: ConfigHooks.Event, target?: string) {
      const configured = (yield* config.entries()).flatMap((entry) =>
        entry.type === "document" && entry.info.hooks ? [entry.info.hooks] : [],
      )
      return [...(yield* claudeHooks()), ...configured]
        .flatMap((hooks) => hooks[event] ?? [])
        .filter((matcher) => matches(matcher.matcher, target))
        .flatMap((matcher) => matcher.hooks)
    })

    const run = Effect.fn("LifecycleHooksPlugin.run")(function* (
      event: ConfigHooks.Event,
      payload: Record<string, unknown>,
      target?: string,
    ) {
      const configured = yield* commands(event, target)
      if (configured.length === 0) return NOTHING
      const shell = yield* shells.resolve({ priority: "compat" })
      const stdin = JSON.stringify({ hook_event_name: event, cwd: location.directory, ...payload })
      const outcomes = yield* Effect.forEach(
        configured,
        (hook): Effect.Effect<Outcome> =>
          processes
            .run(
              ChildProcess.make(shell, ShellSelect.args(shell, hook.command), {
                cwd: location.directory,
                extendEnv: true,
                env: { ORBIT_PROJECT_DIR: location.directory },
              }),
              { stdin, timeout: Duration.seconds(hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) },
            )
            .pipe(
              Effect.map((result) => interpret(result.exitCode, result.stdout.toString(), result.stderr.toString())),
              Effect.catch((error) =>
                Effect.logWarning("hook failed to run", { event, command: hook.command, error: error.message }).pipe(
                  Effect.as(NOTHING),
                ),
              ),
            ),
      )
      return {
        block: outcomes.find((outcome) => outcome.block !== undefined)?.block,
        context: outcomes
          .map((outcome) => outcome.context)
          .filter(Boolean)
          .join("\n"),
      }
    })

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const outcome = yield* run(
          "PreToolUse",
          { session_id: event.sessionID, tool_name: event.tool, tool_input: event.input },
          event.tool,
        )
        if (outcome.block !== undefined)
          return yield* new Tool.Error({ message: `Blocked by a PreToolUse hook: ${outcome.block}` })
      }),
    )

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed") return
        const outcome = yield* run(
          "PostToolUse",
          {
            session_id: event.sessionID,
            tool_name: event.tool,
            tool_input: event.input,
            tool_response: event.result.output,
          },
          event.tool,
        )
        const feedback = [outcome.block, outcome.context].filter(Boolean).join("\n")
        if (!feedback) return
        const content = event.result.content
        event.result = {
          ...event.result,
          content: [
            ...(content === undefined
              ? []
              : typeof content === "string"
                ? [{ type: "text" as const, text: content }]
                : content),
            { type: "text", text: `PostToolUse hook:\n${feedback}` },
          ],
        }
      }),
    )

    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const outcome = yield* run("UserPromptSubmit", { session_id: event.sessionID, prompt: event.prompt.text })
        if (outcome.context) event.prompt.text = `${event.prompt.text}\n\n${outcome.context}`
      }),
    )

    yield* ctx.event.subscribe().pipe(
      Stream.filter(isLifecycle),
      Stream.runForEach((event) => {
        const fire = lifecycle(event)
        if (!fire) return Effect.void
        return run(fire.event, { session_id: fire.sessionID, ...fire.payload }).pipe(Effect.asVoid)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

type Lifecycle =
  | SessionEvent.Created
  | SessionEvent.Execution.Succeeded
  | SessionEvent.Execution.Failed
  | SessionEvent.Execution.Interrupted
  | SessionEvent.Compaction.Started

const LIFECYCLE = new Set([
  "session.created",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.started",
])

function isLifecycle(event: { readonly type: string }): event is Lifecycle {
  return LIFECYCLE.has(event.type)
}

function lifecycle(event: Lifecycle) {
  if (event.type === "session.created") {
    if (event.data.parentID) return undefined
    return { event: "SessionStart" as const, sessionID: event.data.sessionID, payload: { source: "startup" } }
  }
  if (event.type === "session.compaction.started")
    return { event: "PreCompact" as const, sessionID: event.data.sessionID, payload: {} }
  return {
    event: "Stop" as const,
    sessionID: event.data.sessionID,
    payload: { outcome: event.type.split(".").at(-1) },
  }
}

function matches(matcher: string | undefined, target: string | undefined) {
  if (!matcher || matcher === "*" || target === undefined) return true
  return Option.match(Option.liftThrowable(() => new RegExp(`^(?:${matcher})$`))(), {
    onNone: () => matcher === target,
    onSome: (pattern) => pattern.test(target),
  })
}

function interpret(exitCode: number, stdout: string, stderr: string): Outcome {
  if (exitCode === 2) return { block: stderr.trim() || "no reason given", context: "" }
  const reply = Option.getOrUndefined(decodeReply(stdout.trim()))
  if (reply?.decision === "block") return { block: reply.reason ?? "no reason given", context: "" }
  if (reply) return { context: reply.additionalContext ?? "" }
  return { context: exitCode === 0 ? stdout.trim() : "" }
}
