export * as Config from "./config.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { Permission } from "./permission.js"
import { AbsolutePath, optional } from "./schema.js"
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
import { ConfigModel } from "./config/model.js"
import { ConfigPlugin } from "./config/plugin.js"
import { ConfigProvider } from "./config/provider.js"
import { ConfigReference } from "./config/reference.js"
import { ConfigSandbox } from "./config/sandbox.js"
import { ConfigWebSearch } from "./config/websearch.js"
import { ConfigToolExecution } from "./config/tool-execution.js"
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
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  output_style: Schema.String.pipe(optional).annotate({
    description:
      'How the agent communicates: "default", a built-in style ("explanatory", "learning"), or the name of a Markdown file in an output-styles directory',
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
  sandbox: ConfigSandbox.Info.pipe(optional).annotate({
    description: "Run shell commands in an operating system sandbox",
  }),
  tool_output: ConfigToolOutput.Info.pipe(optional).annotate({
    description: "Tool output truncation thresholds",
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
  references: ConfigReference.Info.pipe(optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  websearch: ConfigWebSearch.Selection.pipe(optional).annotate({
    description: "Web search provider selection",
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
}).annotate({ identifier: "Config.Patch" })
export interface Patch extends Schema.Schema.Type<typeof Patch> {}

export const Effective = Schema.Struct({
  compatibility: Schema.Boolean.annotate({
    description:
      "Whether Orbit reads other agent products' settings, skills, output styles and instruction files. Only your own config, ORBIT_CONFIG or ORBIT_CONFIG_CONTENT, organization-managed settings and ORBIT_DISABLE_COMPAT in the server's environment decide this; a repository's files cannot.",
  }),
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
    "Where a configuration entry came from, listed from lowest to highest precedence: remote (well-known), user (global config directory and home directory), project (orbit.json files and .orbit directories up the tree), local (orbit.local.json files), flag (ORBIT_CONFIG and ORBIT_CONFIG_CONTENT), managed (organization-managed settings).",
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
      "The kinds of configuration removed from info because the folder is not trusted. Present only when trusted is false.",
  }),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
  scope: Scope.pipe(optional),
  trusted,
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
