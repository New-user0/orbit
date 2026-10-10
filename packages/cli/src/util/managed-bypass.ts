import type { OrbitClient } from "@orbit/client/promise"
import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { errorMessage } from "./error"

/** What every door that can select the mode that skips permission prompts says when managed settings turn it off. */
export const MANAGED_BYPASS_MESSAGE =
  "Skipping permission prompts is turned off by your organization's managed settings, so --auto, --yolo and --dangerously-skip-permissions are refused."

/**
 * The text that stops a command that asked to skip permission prompts, or undefined when it may go ahead. The managed
 * settings are read by the server, so this asks the server that will run the work. Nothing is asked when the command did
 * not request the mode. A server that cannot say (an error, an older server without the answer) stops the command too:
 * refusing costs a flag, guessing wrong costs the organization's rule.
 */
export const bypassRefusal = Effect.fn("cli.managedBypass")(function* (
  client: OrbitClient,
  directory: string,
  requested: boolean,
) {
  if (!requested) return undefined
  const effective = yield* Effect.tryPromise({
    try: () => client.config.effective({ location: { directory } }),
    catch: errorMessage,
  }).pipe(Effect.catch((reason) => Effect.succeed(reason)))
  if (typeof effective === "string")
    return `Cannot confirm that managed settings allow skipping permission prompts (${plain(effective)}), so the request is refused.`
  // A server older than this answer has no `permissions`: read that as unknown, not as allowed.
  const bypass = effective.permissions?.bypass
  if (bypass === true) return undefined
  return bypass === false
    ? MANAGED_BYPASS_MESSAGE
    : "Cannot confirm that managed settings allow skipping permission prompts (the server does not report it), so the request is refused."
})
