export * as Config from "./config.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { Permission } from "./permission.js"
import { AbsolutePath, optional, PositiveInt } from "./schema.js"
import { ConfigAgent } from "./config/agent.js"
import { ConfigMedia } from "./config/media.js"
import { ConfigCompaction } from "./config/compaction.js"
import { ConfigCompatibility } from "./config/compatibility.js"
import { ConfigCommand } from "./config/command.js"
import { ConfigExperimental } from "./config/experimental.js"
import { ConfigFormatter } from "./config/formatter.js"
import { ConfigHooks } from "./config/hooks.js"
import { ConfigLSP } from "./config/lsp.js"
import { ConfigMCP } from "./config/mcp.js"
import { ConfigMemory } from "./config/memory.js"
import { ConfigModel } from "./config/model.js"
import { ConfigPlugin } from "./config/plugin.js"
import { ConfigProvider } from "./config/provider.js"
import { ConfigReference } from "./config/reference.js"
import { ConfigAttribution } from "./config/attribution.js"
import { ConfigSandbox } from "./config/sandbox.js"
import { ConfigWebFetch } from "./config/webfetch.js"
import { ConfigWebSearch } from "./config/websearch.js"
import { ConfigToolExecution } from "./config/tool-execution.js"
import { ConfigShellTool } from "./config/shell-tool.js"
import { ConfigToolOutput } from "./config/tool-output.js"
import { ConfigWatcher } from "./config/watcher.js"
import { ConfigWarming } from "./config/warming.js"
import { ConfigWorktree } from "./config/worktree.js"
import { Trust } from "./trust.js"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  env: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[^=\u0000]+$/)),
    Schema.String.check(Schema.isPattern(/^[^\u0000]*$/)),
  ).pipe(optional).annotate({
    description:
      "Variables added to the environment of the programs Orbit starts for a project: the shell, terminals, hooks, MCP servers, language servers and formatters. A program's own variables and Orbit's win over these. Set in every scope; a project's or local file's env waits until the folder is trusted, and the organization's managed value wins. A number or boolean is kept as its text; a name that is empty or holds an equals sign is ignored",
  }),
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  fallback_model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model used for the rest of a turn after the selected model is repeatedly overloaded",
  }),
  model_aliases: Schema.Struct({
    small: ConfigModel.Selection.pipe(optional),
    large: ConfigModel.Selection.pipe(optional),
  })
    .pipe(optional)
    .annotate({
      identifier: "Config.ModelAliases",
      description:
        "The models that an agent reaches by the names small and large in its model setting. Unset names fall back to the small model and the default model",
    }),
  output_token_cap: PositiveInt.pipe(optional).annotate({
    description:
      "Most tokens a model may write per model request. A reply cut off at the cap is resumed like any other cut-off. Lowers the model's own maximum and never raises it; compaction summaries and titles keep their own limits; unset leaves the maximum in place",
  }),
  git_status: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether a session starts with a snapshot of the git repository: the branch, the main branch, the git user name, a short status and the last five commits. The snapshot is taken once, only in a trusted folder, and is not updated. On by default; false turns it off",
  }),
  default_agent: Schema.String.pipe(optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  output_style: Schema.String.pipe(optional).annotate({
    description:
      'How the agent communicates: "default", a built-in style ("explanatory", "learning"), or the name of a Markdown file in an output-styles directory',
  }),
  language: Schema.String.pipe(optional).annotate({
    description:
      'The language the agent replies to the person in, as any language name or spelling, for example "Japanese" or "español". Code, commands and technical terms are left untranslated. Unset, or empty, means no preference',
  }),
  system_prompt: Schema.String.pipe(optional).annotate({
    description:
      "Text that replaces Orbit's base system prompt for the main thread of a session: sessions without a parent, and forks of them. Orbit's base sections and the model-specific prompt are dropped and its core rules are kept; the git section, an output style and tool descriptions still apply. ${ORBIT_TOOL_GUIDANCE} in the text is replaced by the guidance lines of the tools on offer. Agents with a prompt of their own and subagents keep their own prompt. Read only from your own config, the ORBIT_CONFIG file or content and managed settings, never from a project's or local config. The highest-priority of those that sets this or system_prompt_file decides; an empty string counts as unset",
  }),
  system_prompt_file: Schema.String.pipe(optional).annotate({
    description:
      "Like system_prompt, with the text read from a UTF-8 file at each request. The path is absolute, starts with ~/, or is relative to the folder of the config that names it (to the folder the session runs in when the config has no file). A file that cannot be read, or that is on a network share, is skipped with a warning and the default prompt is kept. Ignored in a config that sets system_prompt. Read only from your own config, the ORBIT_CONFIG file or content and managed settings, never from a project's or local config",
  }),
  append_system_prompt: Schema.String.pipe(optional).annotate({
    description:
      "Text added to the system prompt of the main thread of a session, after the base prompt and the git section and before the output style. It applies on top of an agent's own prompt too, but not to subagents. Read only from your own config, the ORBIT_CONFIG file or content and managed settings, never from a project's or local config. The highest-priority of those that sets it decides; an empty string counts as unset",
  }),
  update: Schema.Literals(["disable", "notify", "auto"]).pipe(optional).annotate({
    description: "Disable updates, notify when one is available, or install updates automatically",
  }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(optional),
  })
    .pipe(optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  hooks: ConfigHooks.Info.pipe(optional).annotate({
    description:
      "Hooks that run at points in a session's life: shell commands, model prompts, verifier agents and HTTP requests",
  }),
  formatter: ConfigFormatter.Info.pipe(optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  media: ConfigMedia.Info.pipe(optional).annotate({
    description: "Media processing configuration",
  }),
  attribution: ConfigAttribution.Info.pipe(optional).annotate({
    description:
      "What the agent adds to the commits and pull requests it writes. Each field is decided by the highest-priority config that sets it. A project's or local value applies once the folder is trusted, and then outranks your own",
  }),
  sandbox: ConfigSandbox.Info.pipe(optional).annotate({
    description: "Run shell commands in an operating system sandbox",
  }),
  shell_tool: ConfigShellTool.Info.pipe(optional).annotate({
    description: "Shell command timeouts",
  }),
  background_tasks: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether shell commands and subagents may run in the background. On by default. false keeps shell commands and the subagents of the Agent and Workflow tools in the foreground: the background options are not offered, a shell command still running at its timeout is stopped, and moving running work to the background leaves them where they are. A command defined to run as a subagent still runs in the background. A project's or local value applies once the folder is trusted",
  }),
  tool_output: ConfigToolOutput.Info.pipe(optional).annotate({
    description:
      "When a tool result is saved to a file, and how much of the start of a shell command's output its result keeps",
  }),
  tool_execution: ConfigToolExecution.Info.pipe(optional).annotate({
    description: "How the tool calls of one step are scheduled",
  }),
  mcp: ConfigMCP.Info.pipe(optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(optional).annotate({
    description: "Conversation compaction behavior",
  }),
  memory: ConfigMemory.Info.pipe(optional).annotate({
    description: "The agent's memory of a project: notes it keeps across sessions in a folder of its own",
  }),
  compatibility: ConfigCompatibility.Info.pipe(optional).annotate({
    description: "Whether to read other agent products' settings, skills, output styles and instruction files",
  }),
  skills: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  instructions_exclude: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "Instruction files that Orbit does not load: glob patterns or absolute paths, matched against the whole absolute path of a file written with forward slashes. A pattern with no folder in it, such as AGENTS.md, matches nothing; start a pattern with **/ to match wherever the project lives, for example **/third_party/**/AGENTS.md. The lists of every config level are combined, and a project's or local file's list applies once its folder is trusted",
  }),
  references: ConfigReference.Info.pipe(optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  websearch: ConfigWebSearch.Selection.pipe(optional).annotate({
    description: "Web search provider selection",
  }),
  webfetch: ConfigWebFetch.Info.pipe(optional).annotate({
    description: "WebFetch behavior",
  }),
  plugins: ConfigPlugin.Plugins.pipe(optional).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  worktree: ConfigWorktree.Info.pipe(optional).annotate({
    description: "Directory defaults for local worktree creation",
  }),
  warming: ConfigWarming.Warming.pipe(optional).annotate({
    description: "Keep recently active sessions warm with transient model requests (default: false)",
  }),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(optional),
  experimental: ConfigExperimental.Info.pipe(optional),
}) {}

export const Patch = Schema.Struct({
  shell: Schema.optionalKey(Schema.NullOr(Schema.String)),
  output_style: Schema.optionalKey(Schema.NullOr(Schema.String)),
  language: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Config.Patch" })
export interface Patch extends Schema.Schema.Type<typeof Patch> {}

export const Effective = Schema.Struct({
  compatibility: Schema.Boolean.annotate({
    description:
      "Whether Orbit reads other agent products' settings, skills, output styles and instruction files. Only your own config, ORBIT_CONFIG or ORBIT_CONFIG_CONTENT, organization-managed settings and ORBIT_DISABLE_COMPAT in the server's environment decide this; a repository's files cannot.",
  }),
  permissions: Schema.optionalKey(
    Schema.Struct({
      bypass: Schema.Boolean.annotate({
        description:
          "Whether the mode that skips permission prompts may be selected. False when organization-managed settings set disable_bypass_permissions.",
      }),
      always: Schema.Boolean.annotate({
        description:
          "Whether an 'always' reply may save a grant. False when organization-managed settings set managed_permissions_only.",
      }),
    }).annotate({
      description:
        "What organization-managed settings leave open about permission prompts. Absent from a server that predates it, which clients read as bypass refused.",
    }),
  ),
  plugins: Schema.optionalKey(
    Schema.Struct({
      allow: Schema.optionalKey(Schema.Array(Schema.String)),
      block: Schema.optionalKey(Schema.Array(Schema.String)),
      organization: Schema.optionalKey(Schema.String),
    }).annotate({
      description:
        "Which plugins organization-managed settings allow or block, as selectors that match a package name, an absolute path or a plugin ID. An empty object means no restriction. Absent from a server that predates it, which clients read as no external plugin may load.",
    }),
  ),
  hooks: Schema.optionalKey(
    Schema.Struct({
      disabled: Schema.Boolean.annotate({
        description:
          "Whether organization-managed settings turn hooks off (disable_hooks, or hooks.disabled in the managed file). A client that runs a command in a hook's place, such as the status line, does not run it.",
      }),
      managed_only: Schema.Boolean.annotate({
        description:
          "Whether organization-managed settings allow only managed hooks (managed_hooks_only, or hooks.managed_only in the managed file). Orbit has no managed status line, so a client does not run its own command either.",
      }),
    }).annotate({
      description:
        "What organization-managed settings say about hooks. Absent from a server that predates it, which clients read as unknown: a client does not run a command in a hook's place until it knows.",
    }),
  ),
  mcp: Schema.optionalKey(
    Schema.Struct({
      managed_only: Schema.Boolean.annotate({
        description:
          "Whether organization-managed settings run only the MCP servers they define. When true, adding a server is refused and servers from every other source are ignored.",
      }),
    }).annotate({
      description:
        "What organization-managed settings say about MCP servers. Absent from a server that predates it, which clients read as unknown.",
    }),
  ),
}).annotate({
  identifier: "Config.Effective",
  description:
    "The settings that took effect for a location, as the server resolved them from every scope and its own environment. Clients read these instead of working them out from the documents, which do not show what the server's environment changed.",
})
export interface Effective extends Schema.Schema.Type<typeof Effective> {}

export type Scope = typeof Scope.Type
export const Scope = Schema.Literals(["remote", "user", "project", "local", "flag", "managed"]).annotate({
  identifier: "Config.Scope",
  description:
    "Where a configuration entry came from, listed from lowest to highest precedence: remote (well-known), user (global config directory and home directory), project (orbit.json files and .orbit directories up the tree), local (orbit.local.json files), flag (ORBIT_CONFIG, ORBIT_CONFIG_CONTENT and the run's --settings, --mcp-config and --agents), managed (organization-managed settings).",
})

const trusted = Schema.Boolean.pipe(optional).annotate({
  description:
    "False when the entry belongs to a project or local scope and the folder that holds it is not trusted: the project's folder, or for config found above the project, the folder that holds that config. Unset means the entry is not subject to trust.",
})

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: AbsolutePath.pipe(optional),
  // Optional so entries produced before scopes existed still decode; a missing scope is treated as user.
  scope: Scope.pipe(optional),
  trusted,
  withheld: Schema.Array(Trust.Kind).pipe(optional).annotate({
    description:
      "The kinds of configuration removed from info because the folder that holds the file is not trusted. Set only on such a folder's entry; a trusted folder's entry applies as it is. Removed in a later release.",
  }),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
  scope: Scope.pipe(optional),
  trusted,
  withheld: Schema.Array(Trust.Kind).pipe(optional).annotate({
    description:
      "No longer set: a trusted folder's directory applies as it is, and an untrusted one's is marked by `trusted`. Kept so that older entries decode, and removed in a later release.",
  }),
}) {}

export const Entry = Schema.Union([Document, Directory]).annotate({
  identifier: "Config.Entry",
})
export type Entry = typeof Entry.Type

const Updated = ephemeral({
  type: "config.updated",
  schema: {},
})

export const Event = { Updated, Definitions: inventory(Updated) }
