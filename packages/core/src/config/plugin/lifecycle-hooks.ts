export * as LifecycleHooksPlugin from "./lifecycle-hooks.js"

import { CompatAliases } from "@orbit/compat/aliases"
import { CompatSettings } from "@orbit/compat/settings"
import { define } from "@orbit/plugin/effect/plugin"
import { ConfigHooks } from "@orbit/schema/config/hooks"
import type { SessionEvent } from "@orbit/schema/session-event"
import { Tool } from "@orbit/schema/tool"
import { AppProcess } from "@orbit/util/process"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { Mcp } from "../../mcp/index.js"
import { ShellSelect } from "../../shell/select.js"
import type { PluginInternal } from "../../plugin/internal.js"

/**
 * Runs the shell commands configured under `hooks` at points in a session's life. Every document's hooks apply, in
 * config order, and hooks come from nowhere else: another product's settings files reach this runner as documents
 * too, ranked below the native documents of their scope. A command gets the event as JSON on stdin; exit code 2 or
 * `{"decision":"block","reason":...}` on stdout blocks a tool call, and other stdout becomes context for the model.
 * When several hooks block, the reason of the one in the highest-ranked document is reported. A hook that fails to
 * run is logged and skipped, so a broken script never stops the session.
 *
 * While compatibility is on, a matcher also accepts the names other products give a tool, so a hook written for
 * `Bash` fires for `shell`, and a hook that comes from another product's settings file is told that product's name
 * for the tool, as `tool_name`. Every hook can also read the project directory from that product's variable.
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
 * - A hook from another product's settings file is told that product's tool name but not its tool input, which keeps
 *   Orbit's shape.
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

interface Outcome {
  readonly block?: string
  readonly context: string
}

const NOTHING: Outcome = { context: "" }

export const Plugin = define({
  id: "orbit.config.lifecycle-hooks",
  effect: Effect.fn("LifecycleHooksPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const mcp = yield* Mcp.Service
    const processes = yield* AppProcess.Service
    const shells = yield* ShellSelect.Service
    const location = yield* Location.Service

    // Each warning is logged once, not on every event: hooks are matched every time an event fires.
    const warned = new Set<string>()
    const warnOnce = (key: string, message: string, details: Record<string, unknown>) =>
      Effect.suspend(() => {
        if (warned.has(key)) return Effect.void
        warned.add(key)
        return Effect.logWarning(message, details)
      })

    // The names other products give the tool of a tool event, which is none unless compatibility is on. An MCP tool's
    // name only splits into server and tool once the servers are known.
    const foreignNames = Effect.fn("LifecycleHooksPlugin.foreignNames")(function* (target: string | undefined) {
      if (target === undefined || !(yield* config.compatEnabled())) return []
      const servers = yield* mcp.servers()
      return CompatAliases.toForeign(
        target,
        servers.map((server) => server.name),
      )
    })

    const commands = Effect.fn("LifecycleHooksPlugin.commands")(function* (
      event: ConfigHooks.Event,
      target: string | undefined,
      aliases: readonly string[],
    ) {
      // A later document outranks an earlier one, and the position is its rank.
      const documents = (yield* config.entries()).flatMap((entry) =>
        entry.type === "document" && entry.info.hooks
          ? [{ hooks: entry.info.hooks, foreign: CompatSettings.isForeign(entry.path) }]
          : [],
      )
      yield* Effect.forEach(
        documents.flatMap((document) => UNENFORCED_POLICIES.filter((policy) => document.hooks[policy])),
        (policy) =>
          warnOnce(`policy:${policy}`, "hook policy is not enforced yet and is ignored", {
            setting: `hooks.${policy}`,
          }),
        { discard: true },
      )
      const matched = documents.flatMap((document, rank) =>
        (document.hooks[event] ?? [])
          .filter((group) => matches(group.matcher, target, aliases))
          .flatMap((group) => group.hooks.map((hook) => ({ hook, foreign: document.foreign, rank }))),
      )
      yield* Effect.forEach(
        matched.filter((item) => item.hook.type !== "command"),
        (item) =>
          warnOnce(`type:${item.hook.type}`, "hook type is not supported yet and is skipped", {
            event,
            type: item.hook.type,
          }),
        { discard: true },
      )
      const runnable = matched.flatMap(({ hook, foreign, rank }) =>
        hook.type === "command" ? [{ hook, foreign, rank }] : [],
      )
      yield* Effect.forEach(
        runnable.flatMap((item) =>
          IGNORED_COMMAND_SETTINGS.filter(
            (setting) => item.hook[setting] !== undefined && item.hook[setting] !== false,
          ),
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
      const aliases = yield* foreignNames(target)
      const configured = yield* commands(event, target, aliases)
      if (configured.length === 0) return NOTHING
      const shell = yield* shells.resolve({ priority: "compat" })
      const compat = yield* config.compatEnabled()
      const stdin = (foreign: boolean) =>
        JSON.stringify({
          hook_event_name: event,
          cwd: location.directory,
          ...payload,
          // The tool is named the way the hook's own product names it.
          ...(foreign && aliases.length > 0 ? { tool_name: aliases[0] } : {}),
        })
      const outcomes = yield* Effect.forEach(
        configured,
        (item): Effect.Effect<Outcome> =>
          processes
            .run(
              ChildProcess.make(shell, ShellSelect.args(shell, item.hook.command), {
                cwd: location.directory,
                extendEnv: true,
                env: {
                  ORBIT_PROJECT_DIR: location.directory,
                  ...(compat ? CompatAliases.hookEnv(location.directory) : {}),
                },
              }),
              { stdin: stdin(item.foreign), timeout: Duration.seconds(item.hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) },
            )
            .pipe(
              Effect.map((result) => interpret(result.exitCode, result.stdout.toString(), result.stderr.toString())),
              Effect.catch((error) =>
                Effect.logWarning("hook failed to run", {
                  event,
                  command: item.hook.command,
                  error: error.message,
                }).pipe(Effect.as(NOTHING)),
              ),
            ),
      )
      // The highest-ranked document that blocks gives the reason, and within it the first hook that blocks does.
      const blocks = outcomes.flatMap((outcome, index) =>
        outcome.block === undefined ? [] : [{ reason: outcome.block, rank: configured[index].rank }],
      )
      return {
        block: blocks.toSorted((left, right) => right.rank - left.rank).at(0)?.reason,
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

// A tool also answers to the names that `aliases` lists, which are empty unless compatibility is on.
function matches(matcher: string | undefined, target: string | undefined, aliases: readonly string[]) {
  if (!matcher || matcher === "*" || target === undefined) return true
  const names = [target, ...aliases]
  return Option.match(Option.liftThrowable(() => new RegExp(`^(?:${matcher})$`))(), {
    onNone: () => names.includes(matcher),
    onSome: (pattern) => names.some((name) => pattern.test(name)),
  })
}

function interpret(exitCode: number, stdout: string, stderr: string): Outcome {
  if (exitCode === 2) return { block: stderr.trim() || "no reason given", context: "" }
  const reply = Option.getOrUndefined(decodeReply(stdout.trim()))
  if (reply?.decision === "block") return { block: reply.reason ?? "no reason given", context: "" }
  if (reply) return { context: reply.additionalContext ?? "" }
  return { context: exitCode === 0 ? stdout.trim() : "" }
}
