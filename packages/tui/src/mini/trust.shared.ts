import type { OrbitClient, TrustWithheld } from "@orbit/client"
import { groupWithheld, trustCommands } from "../util/trust"

/**
 * Says in one line, before the terminal is handed over, what the folder holds back and how to turn it on: its own
 * project config until the folder is trusted, and config in a folder above it until that folder is trusted too, which
 * trusting this one does not do. Nothing in the mini can ask the question, but `orb trust` can. A server that cannot
 * answer, or does not within a moment, is no reason to delay the start, so it is not mentioned.
 */
export async function announceTrust(input: { sdk: OrbitClient; directory: string; write: (text: string) => void }) {
  const status = await input.sdk.location.trust
    .get({ location: { directory: input.directory } }, { signal: AbortSignal.timeout(2_000) })
    .catch(() => undefined)
  if (!status) return
  const held = groupWithheld(status.withheld)
  const advice = status.persistent
    ? "Run `orb trust` to trust it."
    : "`orb trust` refuses this folder; start `orb` to trust it until Orbit restarts."
  const lines = [
    ...(held.own.length === 0
      ? []
      : [`${status.directory} is not trusted, so its project config is held back (${kinds(held.own)}). ${advice}`]),
    ...(held.above.length === 0
      ? []
      : [
          `Config in a folder above ${status.directory} stays off until that folder is trusted too ` +
            `(${kinds(held.above)}): ${trustCommands(held.above)}.`,
        ]),
  ]
  if (lines.length > 0) input.write(`${lines.join(" ")}\n`)
}

const kinds = (items: readonly TrustWithheld[]) => [...new Set(items.flatMap((item) => item.kinds))].join(", ")
