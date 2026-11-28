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
    "A kind of project configuration: hooks, MCP servers, plugins, slash commands that run shell snippets, permission rules that allow or ask, the choice of default agent and the removal of an agent, model providers and request overrides, the shell, the attribution text added to commits and pull requests, environment variables for the programs it starts, formatters, language servers, the sandbox, skill folders and the hooks their files carry, anything that reaches the network or is paid for, and other settings that point Orbit at code or files. Nothing of a folder's configuration is read until the folder is trusted.",
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
}).annotate({ identifier: "Trust.Withheld" })
export interface Withheld extends Schema.Schema.Type<typeof Withheld> {}

export const Status = Schema.Struct({
  directory: AbsolutePath.annotate({ description: "The folder trust is decided for: the project's canonical root" }),
  trusted: Schema.Boolean,
  persistent: Schema.Boolean.annotate({
    description:
      "Whether a grant for this folder can be stored on disk. False for the home directory and for filesystem roots, which can only be trusted until the serving process restarts.",
  }),
  source: Source.pipe(optional),
  granted: AbsolutePath.annotate({
    description:
      "The folder above this one whose grant makes it trusted, set only when the grant is that folder's and not this one's own. A grant for a folder covers every folder below it, except a grant for the home directory or a filesystem root, which covers that folder alone. Revoking this folder leaves it trusted while that grant stands. Unset by a server older than this field.",
  }).pipe(optional),
  withheld: Schema.Array(Withheld).annotate({
    description:
      "Always empty now: nothing of an untrusted folder is read, a trusted folder's configuration applies as it is, and nothing above the project is read. Kept for clients that read it, and removed in a later release.",
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
