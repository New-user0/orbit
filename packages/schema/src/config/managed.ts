export * as ConfigManaged from "./managed.js"

import { Schema } from "effect"
import { Info as ConfigInfo } from "../config.js"
import { optional } from "../schema.js"

const Selectors = Schema.Array(Schema.String)

/**
 * What an organization restricts. These live only in managed settings files: `managed` is not a field of
 * `Config.Info`, so it never enters the public orbit.json schema, and any other scope that writes it gets a diagnostic.
 */
export const Restrictions = Schema.Struct({
  organization: Schema.String.pipe(optional).annotate({
    description: "Organization name that denial messages show.",
  }),
  disable_bypass_permissions: Schema.Boolean.pipe(optional).annotate({
    description: "Refuse the mode that skips permission prompts.",
  }),
  managed_permissions_only: Schema.Boolean.pipe(optional).annotate({
    description: "Apply only the permission rules that managed settings define.",
  }),
  managed_hooks_only: Schema.Boolean.pipe(optional).annotate({
    description: "Run only the hooks that managed settings define.",
  }),
  disable_hooks: Schema.Boolean.pipe(optional).annotate({
    description: "Turn off every declarative hook.",
  }),
  mcp: Schema.Struct({
    allow: Selectors.pipe(optional),
    deny: Selectors.pipe(optional),
    managed_only: Schema.Boolean.pipe(optional).annotate({
      description:
        "Run only the MCP servers that managed settings define. Every other source of servers is ignored and adding one is refused.",
    }),
  })
    .pipe(optional)
    .annotate({
      description:
        "Which MCP servers may run, and whether only the ones managed settings define may. A selector is a name glob, `command:<glob>` to match the command of a local server, or `url:<glob>` to match the URL of a remote one.",
    }),
  plugins: Schema.Struct({
    allow: Selectors.pipe(optional),
    block: Selectors.pipe(optional),
    marketplaces: Selectors.pipe(optional),
  })
    .pipe(optional)
    .annotate({ description: "Which plugins and plugin marketplaces may be used." }),
  network: Schema.Struct({
    allowed_domains: Selectors.pipe(optional),
    denied_domains: Selectors.pipe(optional),
    allow_managed_domains_only: Schema.Boolean.pipe(optional).annotate({
      description: "Let shell commands reach only the domains that managed settings allow.",
    }),
  })
    .pipe(optional)
    .annotate({
      description:
        "Which domains tools may reach. `denied_domains` binds every tool that fetches a URL. `allowed_domains` and `allow_managed_domains_only` bind shell commands in the sandbox.",
    }),
})
export type Restrictions = typeof Restrictions.Type

/** A managed settings file: every config field, plus the restrictions. */
export const File = Schema.Struct({
  ...ConfigInfo.fields,
  managed: Restrictions.pipe(optional),
})
export type File = typeof File.Type
