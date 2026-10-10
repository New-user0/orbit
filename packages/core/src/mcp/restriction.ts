export * as McpRestriction from "./restriction.js"

import type { ConfigManaged } from "@orbit/schema/config/managed"
import type { Mcp } from "@orbit/schema/mcp"

export type Result = { readonly allowed: true } | { readonly allowed: false; readonly reason: "denied" | "not_allowed" }

/**
 * Whether the organization's MCP lists let a server exist. The one place that decides; every door that adds a server
 * (config of every scope, plugin transforms, `Mcp.add`) reaches it through Mcp's reconcile.
 *
 * A selector is `url:<pattern>` (remote servers only), `command:<pattern>` (local servers only, matched against the
 * command joined with single spaces) or a server name. In a pattern `*` matches any run of characters and everything
 * else is literal, case counts and nothing depends on the operating system. Joining a command with spaces cannot tell
 * `["node", "a b"]` from `["node", "a", "b"]`; write commands without spaces inside an argument when that matters.
 *
 * Deny wins. No allow list allows everything and an empty one allows nothing. With an allow list, a local server must
 * match a `command:` selector when the list has any and a name selector otherwise; a remote server likewise with `url:`.
 */
export function check(restrictions: ConfigManaged.Restrictions["mcp"], name: string, config: Mcp.ServerConfig): Result {
  if (restrictions === undefined) return { allowed: true }
  const subject = describe(name, config)
  if ((restrictions.deny ?? []).some((selector) => selects(selector, subject))) return { allowed: false, reason: "denied" }
  const allow = restrictions.allow
  if (allow === undefined) return { allowed: true }
  const kind = subject.type === "local" ? "command:" : "url:"
  const typed = allow.filter((selector) => selector.startsWith(kind))
  const candidates = typed.length > 0 ? typed : allow.filter((selector) => !isTyped(selector))
  return candidates.some((selector) => selects(selector, subject)) ? { allowed: true } : { allowed: false, reason: "not_allowed" }
}

type Subject = {
  readonly name: string
  readonly type: "local" | "remote"
  /** The command joined with spaces, or the URL text and its serialized form. */
  readonly texts: readonly string[]
}

function describe(name: string, config: Mcp.ServerConfig): Subject {
  if (config.type === "local") return { name, type: "local", texts: [config.command.join(" ")] }
  return {
    name,
    type: "remote",
    // A URL is also tried as the parser writes it, so `HTTPS://EVIL.example/mcp` and an explicit default port are caught
    // by a pattern written for `https://evil.example/*`. Both strings name the same target.
    texts: [config.url, ...(URL.canParse(config.url) ? [new URL(config.url).href] : [])],
  }
}

function isTyped(selector: string) {
  return selector.startsWith("command:") || selector.startsWith("url:")
}

function selects(selector: string, subject: Subject) {
  if (selector.startsWith("command:")) return subject.type === "local" && subject.texts.some((text) => glob(selector.slice(8), text))
  if (selector.startsWith("url:")) return subject.type === "remote" && subject.texts.some((text) => glob(selector.slice(4), text))
  return glob(selector, subject.name)
}

/** `*` matches any run of characters, including none; every other character is literal. Anchored and case-sensitive. */
export function glob(pattern: string, text: string) {
  const [first, ...rest] = pattern.split("*")
  if (rest.length === 0) return pattern === text
  if (!text.startsWith(first)) return false
  const last = rest.pop()!
  let position = first.length
  for (const part of rest) {
    const found = text.indexOf(part, position)
    if (found < 0) return false
    position = found + part.length
  }
  return text.length - last.length >= position && text.endsWith(last)
}
