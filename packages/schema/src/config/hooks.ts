export * as ConfigHooks from "./hooks.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"
import { ConfigModel } from "./model.js"

/**
 * Lifecycle hooks: commands, model prompts, verifier agents and HTTP requests that run at points in a session's life.
 * Each event holds matcher groups. A group's `matcher` is compared with the event's target (see `MatcherTargets`) and
 * its hooks run when it matches. A hook receives the event as JSON, and its reply can allow, block or add context,
 * depending on the event.
 */

/** Every event a hook can attach to, in the order a session meets them. */
export const Events = [
  "SessionStart",
  "SessionEnd",
  "Setup",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "Notification",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
] as const
export type Event = (typeof Events)[number]

/** The only events whose outcome a model prompt or a verifier agent may judge: those that can gate something. */
export const DecisionEvents = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
] as const satisfies readonly Event[]
export type DecisionEvent = (typeof DecisionEvents)[number]

/** How a session began, as compared by `SessionStart` matchers. */
export const SessionStartSources = ["startup", "resume", "clear", "compact"] as const
/** What started a compaction, as compared by `PreCompact` and `PostCompact` matchers. */
export const CompactionTriggers = ["manual", "auto"] as const
/** What a notification is about, as compared by `Notification` matchers. */
export const NotificationKinds = ["permission", "idle", "elicitation", "question"] as const
/** Why a session ended, as compared by `SessionEnd` matchers. */
export const SessionEndReasons = ["clear", "exit", "deleted", "other"] as const
/** What asked for setup, as compared by `Setup` matchers. */
export const SetupTriggers = ["init", "maintenance"] as const

/**
 * What a group's `matcher` is compared with, per event. `session_source`, `compaction_trigger`, `notification_kind`,
 * `session_end_reason` and `setup_trigger` take the closed values listed above; `error_type` is the session error
 * type, `settings_scope` the scope of the changed settings, `instruction_source` the kind of instruction source and
 * `file_name` a file's base name. Events mapped to `none` have no target and ignore the matcher.
 */
export const MatcherTargets = {
  SessionStart: "session_source",
  SessionEnd: "session_end_reason",
  Setup: "setup_trigger",
  UserPromptSubmit: "none",
  PreToolUse: "tool",
  PostToolUse: "tool",
  PostToolUseFailure: "tool",
  PermissionRequest: "tool",
  PermissionDenied: "tool",
  Stop: "none",
  StopFailure: "error_type",
  SubagentStart: "agent",
  SubagentStop: "agent",
  TaskCreated: "none",
  TaskCompleted: "none",
  TeammateIdle: "none",
  Notification: "notification_kind",
  PreCompact: "compaction_trigger",
  PostCompact: "compaction_trigger",
  Elicitation: "mcp_server",
  ElicitationResult: "mcp_server",
  ConfigChange: "settings_scope",
  InstructionsLoaded: "instruction_source",
  CwdChanged: "none",
  FileChanged: "file_name",
  WorktreeCreate: "none",
  WorktreeRemove: "none",
} as const satisfies Record<Event, string>
export type MatcherTarget = (typeof MatcherTargets)[Event]

const common = {
  timeout: PositiveInt.pipe(optional).annotate({
    description:
      "Seconds before the hook is stopped. Defaults: 600 for command and HTTP hooks, 30 for prompt hooks and 60 for agent hooks. SessionStart and SubagentStart hooks default to 60, because they hold up the first prompt.",
  }),
  status_message: Schema.String.pipe(optional).annotate({
    description: "Text shown to the user while the hook runs",
  }),
  once: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run the hook at most once per session, or once per location for events that have no session (default false)",
  }),
  if: Schema.String.pipe(optional).annotate({
    description:
      "Permission rule in action(pattern) form. The hook runs only for tool calls the rule matches. Events that are not tool events ignore it.",
  }),
}

export const Command = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String.annotate({ description: "Shell command line. The event arrives as JSON on standard input." }),
  shell: Schema.Literals(["bash", "powershell"]).pipe(optional).annotate({
    description:
      'Shell that runs the command, "bash" or "powershell". Defaults to the configured shell. On Windows, "bash" needs Git Bash.',
  }),
  async: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run the command in the background without waiting for it, so its reply cannot block or steer the session (default false). Not allowed for WorktreeCreate.",
  }),
  async_rewake: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run the command in the background like async, and wake the session with its error output when it exits with code 2 (default false). Not allowed for WorktreeCreate.",
  }),
  ...common,
}).annotate({ identifier: "Config.Hooks.Command" })
export interface Command extends Schema.Schema.Type<typeof Command> {}

export const Prompt = Schema.Struct({
  type: Schema.Literal("prompt"),
  prompt: Schema.String.annotate({
    description:
      "Instruction for a model that judges the event. The event JSON is supplied with it, and the model's verdict allows or blocks. Decision events only.",
  }),
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model that judges the event. Defaults to the provider's small model, then the session's model.",
  }),
  ...common,
}).annotate({ identifier: "Config.Hooks.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Agent = Schema.Struct({
  type: Schema.Literal("agent"),
  prompt: Schema.String.annotate({
    description:
      "Instruction for a read-only verifier agent that may inspect the project, up to 50 steps, before it gives a verdict that allows or blocks. Decision events only.",
  }),
  model: ConfigModel.Selection.pipe(optional).annotate({ description: "Model that runs the verifier agent" }),
  ...common,
}).annotate({ identifier: "Config.Hooks.Agent" })
export interface Agent extends Schema.Schema.Type<typeof Agent> {}

export const Http = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String.annotate({
    description: "URL that receives the event as a JSON POST body. Redirects are not followed.",
  }),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description:
      "Extra request headers. A value may reference environment variables as $NAME or ${NAME}; only names allowed by allowed_env_vars (and by hooks.http.allowed_env_vars, when set) are substituted.",
  }),
  allowed_env_vars: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Names of the environment variables this hook may reference in its headers",
  }),
  ...common,
}).annotate({ identifier: "Config.Hooks.Http" })
export interface Http extends Schema.Schema.Type<typeof Http> {}

export const Hook = Schema.Union([Command, Prompt, Agent, Http]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Config.Hooks.Hook" }),
)
export type Hook = typeof Hook.Type

export const Matcher = Schema.Struct({
  matcher: Schema.String.pipe(optional).annotate({
    description:
      'What the group applies to, compared with the target that the event names (see the event). Empty or "*" matches everything. A value made only of letters, digits, _, ., | and - is an exact list split on |. Anything else is a regular expression that may match anywhere in the target. Events without a target ignore it.',
  }),
  hooks: Schema.Array(Hook).annotate({ description: "Hooks that run together when the group matches" }),
}).annotate({ identifier: "Config.Hooks.Matcher" })
export interface Matcher extends Schema.Schema.Type<typeof Matcher> {}

const groups = (description: string) => Schema.Array(Matcher).pipe(optional).annotate({ description })

/** The event fields alone. Agent and skill definitions reuse them; settings add policy keys on top (see `Info`). */
export class Definitions extends Schema.Class<Definitions>("Config.Hooks.Definitions")({
  SessionStart: groups(
    'When a top-level session starts, resumes, is cleared or is compacted, before its next prompt runs. The matcher is compared with the source: "startup", "resume", "clear" or "compact". Standard output and added context become model context. Default timeout: 60 seconds.',
  ),
  SessionEnd: groups(
    'When a top-level session is closed or deleted. The matcher is compared with the reason: "clear", "exit", "deleted" or "other". Observes only.',
  ),
  Setup: groups(
    'When setup is requested for a project directory. The matcher is compared with the trigger: "init" or "maintenance". Standard output becomes model context, and a hook that blocks or fails makes the setup request fail.',
  ),
  UserPromptSubmit: groups(
    'When a prompt is submitted, before the session sees it. Has no matcher target. Exit code 2, or a JSON reply with decision "block", rejects the prompt; added context reaches the model next to it.',
  ),
  PreToolUse: groups(
    'Before a tool call runs. The matcher is compared with the tool name. Exit code 2, or a JSON reply with decision "block", blocks the call and sends the reason to the model. A hook can also allow, ask about or deny the permission, or replace the tool input.',
  ),
  PostToolUse: groups(
    "After a tool call succeeds. The matcher is compared with the tool name. A hook can add context for the model or report a problem with the result; it cannot undo the call.",
  ),
  PostToolUseFailure: groups(
    "After a tool call fails. The matcher is compared with the tool name. A hook can add context for the model.",
  ),
  PermissionRequest: groups(
    "When a permission request is about to be put to the user. The matcher is compared with the tool name. A hook can allow or deny the request on the user's behalf, or interrupt the session.",
  ),
  PermissionDenied: groups(
    "After permission rules or policy deny a tool call. The matcher is compared with the tool name. Observes only.",
  ),
  Stop: groups(
    'When the agent finishes its work and the session would go idle. Has no matcher target. Exit code 2, or a JSON reply with decision "block" and a reason, keeps the agent working. It does not run after a failure or an interruption.',
  ),
  StopFailure: groups(
    "When a session's work ends in an error. The matcher is compared with the session error type. Observes only.",
  ),
  SubagentStart: groups(
    "When a subagent session receives its first prompt. The matcher is compared with the agent id. A hook can add context for the subagent. Default timeout: 60 seconds.",
  ),
  SubagentStop: groups(
    'When a subagent finishes its work. The matcher is compared with the agent id. Exit code 2, or a JSON reply with decision "block" and a reason, keeps the subagent working.',
  ),
  TaskCreated: groups("When a task is created. Has no matcher target. A hook can block the creation."),
  TaskCompleted: groups("When a task is about to be marked completed. Has no matcher target. A hook can block it."),
  TeammateIdle: groups(
    "When a teammate agent is about to go idle. Has no matcher target. A hook can block, which keeps the teammate working.",
  ),
  Notification: groups(
    'When Orbit notifies the user. The matcher is compared with the notification kind: "permission", "idle", "elicitation" or "question". Observes only.',
  ),
  PreCompact: groups(
    'Before the history of a session is compacted. The matcher is compared with the trigger: "manual" or "auto". Runs ahead of the compaction and cannot block it.',
  ),
  PostCompact: groups(
    'After the history of a session has been compacted. The matcher is compared with the trigger: "manual" or "auto".',
  ),
  Elicitation: groups(
    "When an MCP server asks for user input. The matcher is compared with the server name. A hook can answer or decline the request instead of showing it.",
  ),
  ElicitationResult: groups(
    "After the user answers an MCP server's request for input, before the answer is sent to the server. The matcher is compared with the server name. A hook can replace or decline the answer.",
  ),
  ConfigChange: groups(
    "When a settings file changes while the server runs. The matcher is compared with the settings scope, such as project, local, user or managed. Observes only; it cannot veto the change.",
  ),
  InstructionsLoaded: groups(
    "When an instruction source is loaded into a session. The matcher is compared with the instruction source kind. Observes only.",
  ),
  CwdChanged: groups(
    "When a session moves to a different working directory. Has no matcher target. A hook can name files to watch for FileChanged.",
  ),
  FileChanged: groups(
    "When a watched file changes. The matcher is compared with the file's base name, such as .envrc. A hook can name more files to watch.",
  ),
  WorktreeCreate: groups(
    "When a worktree needs to be created. Has no matcher target. The hook creates the worktree and reports its directory. It must finish before creation continues, so async is not allowed.",
  ),
  WorktreeRemove: groups(
    "When a worktree is removed. Has no matcher target. The hook removes the directory; without one the directory is left in place.",
  ),
}) {}

export const HttpPolicy = Schema.Struct({
  allowed_urls: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "URL patterns HTTP hooks may call, where * matches any run of characters. Unset allows any URL that passes the address check; an empty list blocks every HTTP hook. A managed list is authoritative.",
  }),
  allowed_env_vars: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "Environment variable names HTTP hook headers may reference. When set, a hook may use only the names that both this list and its own allowed_env_vars contain.",
  }),
}).annotate({ identifier: "Config.Hooks.HttpPolicy" })
export interface HttpPolicy extends Schema.Schema.Type<typeof HttpPolicy> {}

export class Info extends Schema.Class<Info>("Config.Hooks")({
  ...Definitions.fields,
  disabled: Schema.Boolean.pipe(optional).annotate({
    description:
      "Turn off the hooks defined in this settings scope and in lower-priority scopes (default false). A managed value turns off every declarative hook.",
  }),
  managed_only: Schema.Boolean.pipe(optional).annotate({
    description:
      "In managed settings, run only hooks that managed settings define (default false). Other scopes ignore it.",
  }),
  http: HttpPolicy.pipe(optional).annotate({ description: "Limits on what HTTP hooks may reach" }),
}) {}
