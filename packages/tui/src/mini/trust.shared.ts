import { plain } from "@orbit/flow/plain"
import type { OrbitClient } from "@orbit/client"
import { Trust } from "@orbit/schema/trust"
import { Option, Schema } from "effect"

const decodeStatus = Schema.decodeUnknownOption(Trust.Status)

/**
 * Whether `orb mini` may start in the folder. Nothing in the mini can ask the question, so it is a headless door: in a
 * folder that is not trusted it does not start, whatever the folder holds, because nothing a folder supplies loads and
 * no work starts there until a person trusts it (trust-first, class 12). This is the text that says so and how to trust
 * the folder, or undefined when the mini may start. A server that cannot say (an older one, one that fails, or one that
 * does not answer within two seconds) and an answer that is not a trust status are refusals too (class 7). Every folder
 * name goes through `plain`, because a clone picks its own (class 9).
 */
export async function trustRefusal(input: { sdk: OrbitClient; directory: string }) {
  const answer = await input.sdk.location.trust
    .get({ location: { directory: input.directory } }, { signal: AbortSignal.timeout(2_000) })
    .then(decodeStatus, () => Option.none<Trust.Status>())
  if (Option.isNone(answer))
    return `Orbit could not learn whether ${plain(input.directory)} is trusted, so \`orb mini\` did not start. Make sure the server is running and current (\`orb service restart\` for the background service), or start \`orb\` there and answer the question.`
  const status = answer.value
  if (status.trusted) return undefined
  const folder = plain(status.directory)
  if (!status.persistent)
    return `${folder} is not trusted, so \`orb mini\` did not start. It is a home directory or a filesystem root, which Orbit never trusts for good: start \`orb\` there to trust it until Orbit restarts.`
  return `${folder} is not trusted, so \`orb mini\` did not start: nothing a folder holds is read, and no work starts there, until the folder is trusted. Look it over, then trust it with \`orb trust\`, or start \`orb\` there and answer the question.`
}
