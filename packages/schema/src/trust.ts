export * as Trust from "./trust.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { AbsolutePath, NonNegativeInt, optional } from "./schema.js"

/** The kinds of project configuration that stay off until the folder holding it is trusted. */
export const Kinds = [
  "hooks",
  "mcp",
  "plugins",
  "commands",
  "permissions",
  "providers",
  "shell",
  "env",
  "formatter",
  "lsp",
  "sandbox",
  "skills",
  "network",
  "settings",
] as const

export const Kind = Schema.Literals(Kinds).annotate({
  identifier: "Trust.Kind",
  description:
    "What a project's configuration asks for that is withheld until its folder is trusted: hooks, MCP servers, plugins, slash commands that run shell snippets, permission rules that allow or ask, the choice of default agent and the removal of an agent, model providers and request overrides, the shell, the attribution text added to commits and pull requests, environment variables for the programs it starts, formatters, language servers, the sandbox, skill folders and the hooks their files carry, anything that reaches the network or is paid for, and other settings that point Orbit at code or files.",
})
export type Kind = typeof Kind.Type

export const Source = Schema.Literals(["saved", "session", "implicit"]).annotate({
  identifier: "Trust.Source",
  description:
    "Why a folder is trusted: a grant stored on disk (saved), a grant that lasts until the serving process restarts (session), or a server that trusts every folder except home and filesystem roots (implicit).",
})
export type Source = typeof Source.Type

export const Withheld = Schema.Struct({
  path: AbsolutePath,
  kinds: Schema.Array(Kind),
  directory: AbsolutePath.annotate({
    description:
      "The folder to trust to lift what this holds back, set only for a file or directory in a folder above the project: trusting the project does not lift it, because each folder is trusted on its own. Unset for the project's own files, which trusting the project lifts.",
  }).pipe(optional),
  persistent: Schema.Boolean.annotate({
    description:
      "Whether a grant for `directory` can be stored on disk. False when it is the home directory or a filesystem root, which can only be trusted until the serving process restarts. Set with `directory`.",
  }).pipe(optional),
}).annotate({ identifier: "Trust.Withheld" })
export interface Withheld extends Schema.Schema.Type<typeof Withheld> {}

export const Changed = Schema.Struct({
  path: AbsolutePath,
  kinds: Schema.Array(Kind),
}).annotate({
  identifier: "Trust.Changed",
  description:
    "A configuration file or directory whose executable parts differ from what was there when the folder was trusted, and the kinds that differ.",
})
export interface Changed extends Schema.Schema.Type<typeof Changed> {}

export const Status = Schema.Struct({
  directory: AbsolutePath.annotate({ description: "The folder trust is decided for: the project's canonical root" }),
  trusted: Schema.Boolean,
  persistent: Schema.Boolean.annotate({
    description:
      "Whether a grant for this folder can be stored on disk. False for the home directory and for filesystem roots, which can only be trusted until the serving process restarts.",
  }),
  source: Source.pipe(optional),
  withheld: Schema.Array(Withheld).annotate({
    description:
      "The configuration files and directories that hold back something now, and what each holds. While the folder is untrusted these are the project's own files and its `.orbit` directories. A file or directory in a folder above the project is listed until the folder that holds it is trusted, which trusting the project does not do, and names that folder as its `directory`.",
  }),
  changed: Schema.Array(Changed).pipe(optional).annotate({
    description:
      "Where a trusted folder's executable configuration (hooks, MCP servers, plugins, providers, the shell, formatters, language servers, environment variables, the sandbox and skills) differs from what was recorded when the folder was trusted, and which kinds differ. The same kinds are held back and appear in `withheld` for that path until the folder is trusted again. Empty while the folder is untrusted, which holds everything back anyway, and when the server trusts every folder. Unset by a server older than this field, which clients read as none.",
  }),
}).annotate({ identifier: "Trust.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const Grant = Schema.Struct({
  directory: AbsolutePath,
  time: NonNegativeInt.annotate({ description: "When the grant was made, in milliseconds since the Unix epoch" }),
  via: Schema.String.annotate({ description: "What made the grant, such as the terminal UI or a command" }),
}).annotate({ identifier: "Trust.Grant" })
export interface Grant extends Schema.Schema.Type<typeof Grant> {}

const Updated = ephemeral({
  type: "trust.updated",
  schema: { directory: AbsolutePath, trusted: Schema.Boolean },
})
export const Event = { Updated, Definitions: inventory(Updated) }
