import type { OrbitClient } from "@orbit/client"

/**
 * Says in one line, before the terminal is handed over, that the folder holds its project config back until it is
 * trusted. Nothing in the mini can ask the question, but `orb trust` can. A server that cannot answer, or does not
 * within a moment, is no reason to delay the start, so it is not mentioned.
 */
export async function announceTrust(input: { sdk: OrbitClient; directory: string; write: (text: string) => void }) {
  const status = await input.sdk.location.trust
    .get({ location: { directory: input.directory } }, { signal: AbortSignal.timeout(2_000) })
    .catch(() => undefined)
  if (!status || status.trusted || status.withheld.length === 0) return
  const kinds = [...new Set(status.withheld.flatMap((item) => item.kinds))].join(", ")
  const advice = status.persistent
    ? "Run `orb trust` to trust it."
    : "`orb trust` refuses this folder; start `orb` to trust it until Orbit restarts."
  input.write(`${status.directory} is not trusted, so its project config is held back (${kinds}). ${advice}\n`)
}
