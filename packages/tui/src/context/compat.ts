import { CompatSwitch } from "@orbit/compat/switch"
import { createSignal, onCleanup } from "solid-js"
import type { useClient } from "./client"
import { useLog } from "./log"

/**
 * Whether Orbit may read other agent products' files, as the server answers for `directory`. The server decides, from
 * scopes and an environment this process cannot see, so it is asked once, again after every reconnect, and again
 * whenever the configuration changes.
 *
 * It is off until the first answer, and stays at the last answer when a later read fails. ORBIT_DISABLE_COMPAT in this
 * process turns it off without asking.
 */
export function createCompat(input: {
  client: Pick<ReturnType<typeof useClient>, "api" | "event">
  directory: string
  env?: Readonly<Record<string, string | undefined>>
}) {
  if (!CompatSwitch.enabled([], input.env ?? process.env)) return () => false

  const log = useLog({ component: "compat" })
  const [enabled, setEnabled] = createSignal(false)
  const refresh = () =>
    input.client.api.config
      .effective({ location: { directory: input.directory } })
      .then((effective) => setEnabled(effective.compatibility))
      .catch((error) => log.warn("failed to read the effective configuration", { error }))

  void refresh()
  onCleanup(input.client.event.on("server.connected", refresh))
  onCleanup(input.client.event.on("config.updated", refresh))
  return enabled
}
