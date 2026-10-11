import type { OrbitClient } from "@orbit/client/promise"
import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { errorMessage } from "./error"

/** What a run that names servers with --mcp-config says when managed settings run only the servers they define. */
export const MANAGED_MCP_MESSAGE =
  "Managed settings run only the MCP servers they define, so --mcp-config cannot add servers."

/**
 * The text that stops a run that named MCP servers with --mcp-config, or undefined when it may go ahead. The server
 * drops those servers anyway; this stops the run so the person is told instead of finding the tools missing. Nothing is
 * asked when the run named no server (an empty set passes). A server that cannot say (an error, an older server without
 * the answer) stops the run too: refusing costs a flag, guessing wrong costs the organization's rule.
 */
export const mcpConfigRefusal = Effect.fn("cli.managedMcp")(function* (
  client: OrbitClient,
  directory: string,
  named: boolean,
) {
  if (!named) return undefined
  const effective = yield* Effect.tryPromise({
    try: () => client.config.effective({ location: { directory } }),
    catch: errorMessage,
  }).pipe(Effect.catch((reason) => Effect.succeed(reason)))
  if (typeof effective === "string")
    return `Cannot confirm that managed settings allow --mcp-config servers (${plain(effective)}), so the request is refused.`
  // A server older than this answer has no `mcp`: read that as unknown, not as allowed.
  const managedOnly = effective.mcp?.managed_only
  if (managedOnly === false) return undefined
  return managedOnly === true
    ? MANAGED_MCP_MESSAGE
    : "Cannot confirm that managed settings allow --mcp-config servers (the server does not report it), so the request is refused."
})
