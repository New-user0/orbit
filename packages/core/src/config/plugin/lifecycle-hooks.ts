export * as LifecycleHooksPlugin from "./lifecycle-hooks.js"

import { CompatNames } from "@orbit/compat/names"
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
import { HookConfig } from "../../hook/config.js"
import { Location } from "../../location.js"
import { ShellSelect } from "../../shell/select.js"
import type { PluginInternal } from "../../plugin/internal.js"

/**
 * Runs the shell commands configured under `hooks` at points in a session's life. Every document's hooks apply, in
 * config order. A command gets the event as JSON on stdin; exit code 2 or `{"decision":"block","reason":...}` on
 * stdout blocks a tool call, and other stdout becomes context for the model. A hook that fails to run is logged and
 * skipped, so a broken script never stops the session.
 *
 * This is the interim runner, and it honors less than the hooks schema describes. It warns once for each of these:
 * - Hooks of the other types (prompt, agent, http) are skipped.
 * - The `shell`, `async`, `async_rewake`, `once`, `if` and `status_message` settings of a command are ignored.
 * - The `disabled`, `managed_only` and `http` policies are not enforced.
 *
 * No warning covers these differences from the schema's descriptions:
 * - Only PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop and PreCompact fire; hooks under the other
 *   events are accepted and never run.
 * - Every command gets a 60 second timeout unless it sets one, whatever its event.
 * - A matcher is always an anchored regular expression, where the schema describes exact lists and unanchored
 *   expressions. It is compared only with the tool name of a tool event; the other events ignore it, SessionStart's
 *   source included.
 * - UserPromptSubmit can add context to a prompt but cannot reject it.
 * - Stop also fires after a failed or interrupted execution.
 */

const DEFAULT_TIMEOUT_SECONDS = 60
// Settings of a command hook that this runner does not act on.
const IGNORED_COMMAND_SETTINGS = ["shell", "async", "async_rewake", "once", "if", "status_message"] as const
// Policies that would change which hooks run, and are not enforced yet.
const UNENFORCED_POLICIES = ["disabled", "managed_only", "http"] as const
const Reply = Schema.Struct({
  decision: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  additionalContext: Schema.optionalKey(Schema.String),
})
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))
// Only the hooks key matters here; the file's other settings are ignored. It is decoded entry by entry (see
// HookConfig), so a hook this version cannot read costs only itself, never the guards beside it.
const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ hooks: Schema.optionalKey(Schema.Unknown) })),
)
const decodeHooks = Schema.decodeUnknownOption(ConfigHooks.Info)

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

    // Each warning is logged once, not on every event: hooks are matched, and shared settings files read again, every
    // time an event fires.
    const warned = new Set<string>()
    const warnOnce = (key: string, message: string, details: Record<string, unknown>) =>
      Effect.suspend(() => {
        if (warned.has(key)) return Effect.void
        warned.add(key)
        return Effect.logWarning(message, details)
      })

    // The hooks of one shared settings file. A hook that cannot be used costs only itself, and is reported at its path in
    // the file, in the shape the configuration loader uses.
    const fileHooks = Effect.fn("LifecycleHooksPlugin.fileHooks")(function* (file: string, text: string) {
      const raw = Option.getOrUndefined(decodeSettings(text))?.hooks
      if (raw === undefined) return undefined
      const decoded = HookConfig.decode(raw)
      yield* Effect.forEach(
        decoded.diagnostics,
        (diagnostic) => {
          const where = `$.${diagnostic.path.join(".")}`
          return warnOnce(`${file}:${diagnostic.kind}:${where}`, "configuration normalization diagnostic", {
            source: file,
            path: where,
            kind: diagnostic.kind,
            action: diagnostic.message,
          })
        },
        { discard: true },
      )
      return Option.getOrUndefined(decodeHooks(decoded.hooks))
    })

    // The reference vendor keeps hooks in settings files in its own directory; read them so existing hooks work here.
    const vendorHooks = Effect.fn("LifecycleHooksPlugin.vendorHooks")(function* () {
      const roots = (yield* config.compat()).roots.filter((root) => root.kind === "vendor")
      const files = roots.flatMap((root) => CompatNames.vendor.settings.map((name) => path.join(root.path, name)))
      const settings = yield* Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file).pipe(
          Effect.flatMap((text) => (text === undefined ? Effect.undefined : fileHooks(file, text))),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      return settings.filter((hooks) => hooks !== undefined)
    })

    const commands = Effect.fn("LifecycleHooksPlugin.commands")(function* (event: ConfigHooks.Event, target?: string) {
      const configured = (yield* config.entries()).flatMap((entry) =>
        entry.type === "document" && entry.info.hooks ? [entry.info.hooks] : [],
      )
      const documents = [...(yield* vendorHooks()), ...configured]
      yield* Effect.forEach(
        documents.flatMap((hooks) => UNENFORCED_POLICIES.filter((policy) => hooks[policy])),
        (policy) =>
          warnOnce(`policy:${policy}`, "hook policy is not enforced yet and is ignored", {
            setting: `hooks.${policy}`,
          }),
        { discard: true },
      )
      const matched = documents
        .flatMap((hooks) => hooks[event] ?? [])
        .filter((matcher) => matches(matcher.matcher, target))
        .flatMap((matcher) => matcher.hooks)
      yield* Effect.forEach(
        matched.filter((hook) => hook.type !== "command"),
        (hook) =>
          warnOnce(`type:${hook.type}`, "hook type is not supported yet and is skipped", { event, type: hook.type }),
        { discard: true },
      )
      const runnable = matched.filter((hook): hook is ConfigHooks.Command => hook.type === "command")
      yield* Effect.forEach(
        runnable.flatMap((hook) =>
          IGNORED_COMMAND_SETTINGS.filter((setting) => hook[setting] !== undefined && hook[setting] !== false),
        ),
        (setting) =>
          warnOnce(`field:${setting}`, "hook field is not supported yet and is ignored", { event, field: setting }),
        { discard: true },
      )
      return runnable
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
