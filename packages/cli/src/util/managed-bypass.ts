import type { OrbitClient } from "@orbit/client/promise"
import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { errorMessage } from "./error"

/** What every door that can select the mode that skips permission prompts says when managed settings turn it off. */
export const MANAGED_BYPASS_NOTICE =
  "Skipping permission prompts is turned off by your organization's managed settings, so --auto, --yolo and --dangerously-skip-permissions are ignored and this run keeps asking. Where nothing can answer, a question is declined."

/**
 * Whether a command that may have asked to skip permission prompts keeps the mode, and the one-line notice to print
 * when it does not. The managed settings are read by the server, so this asks the server that will run the work. Nothing
 * is asked when the command did not request the mode. When managed settings turn it off, or the server cannot say (an
 * error, an older server without the answer), the mode is dropped and the command goes on with its prompts: that is
 * never wider than the request, since managed rules still apply and a question nobody can answer is declined.
 */
export const bypassDecision = Effect.fn("cli.managedBypass")(function* (
  client: OrbitClient,
  directory: string,
  requested: boolean,
) {
  if (!requested) return { auto: false, notice: undefined }
  const effective = yield* Effect.tryPromise({
    try: () => client.config.effective({ location: { directory } }),
    catch: errorMessage,
  }).pipe(Effect.catch((reason) => Effect.succeed(reason)))
  if (typeof effective === "string")
    return {
      auto: false,
      notice: `Cannot confirm that managed settings allow skipping permission prompts (${plain(effective)}), so the request is ignored and this run keeps asking.`,
    }
  // A server older than this answer has no `permissions`: read that as unknown, not as allowed.
  const bypass = effective.permissions?.bypass
  if (bypass === true) return { auto: true, notice: undefined }
  return {
    auto: false,
    notice:
      bypass === false
        ? MANAGED_BYPASS_NOTICE
        : "Cannot confirm that managed settings allow skipping permission prompts (the server does not report it), so the request is ignored and this run keeps asking.",
  }
})

/**
 * Prints the notice once. A run that prints event lines (`--format json` or `stream-json`) gets a `warning` line on
 * stdout, in the same stream as its other lines. Every other door writes to stderr, and so does a run with the result
 * envelope, so the lines that a script reads from stdout keep their fixed shapes.
 */
export function printBypassNotice(notice: string | undefined, format?: string, envelope = false) {
  if (notice === undefined) return
  if ((format === "json" || format === "stream-json") && !envelope) {
    process.stdout.write(JSON.stringify({ type: "warning", timestamp: Date.now(), message: notice }) + "\n")
    return
  }
  process.stderr.write(`${notice}\n`)
}
