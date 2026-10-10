import { createEffect, createSignal, onCleanup } from "solid-js"
import { useConfig } from "../config"
import { useToast } from "../ui/toast"
import { useArgs } from "./args"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"

export type PermissionMode = "prompt" | "autoaccept"

/**
 * The permission mode in force. Auto-accept is what was asked for (the --auto flag or the setting) only while the
 * server says that managed settings leave it open. It starts as prompt, stays at the last answer when a later read
 * fails, and a server that does not report it counts as refusing, so a guess never skips a prompt. When auto-accept was
 * asked for and is refused, a toast says so once.
 */
export function createPermissionMode(input: {
  client: Pick<ReturnType<typeof useClient>, "api" | "event">
  directory: string
  requested: () => PermissionMode
  toast: Pick<ReturnType<typeof useToast>, "show">
}) {
  const log = useLog({ component: "permission" })
  const [answer, setAnswer] = createSignal<"unknown" | "open" | "closed">("unknown")
  const refresh = () =>
    input.client.api.config
      .effective({ location: { directory: input.directory } })
      .then((effective) => setAnswer(effective.permissions?.bypass === true ? "open" : "closed"))
      .catch((error) => log.warn("failed to read the effective configuration", { error }))

  void refresh()
  onCleanup(input.client.event.on("server.connected", refresh))
  onCleanup(input.client.event.on("config.updated", refresh))

  let told = false
  createEffect(() => {
    if (told || input.requested() !== "autoaccept" || answer() !== "closed") return
    told = true
    input.toast.show({
      message: "Auto-accept is turned off by your organization's managed settings, so permission prompts stay on.",
      variant: "warning",
    })
  })

  return () => (input.requested() === "autoaccept" && answer() === "open" ? "autoaccept" : "prompt")
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: (props: { directory: string }) => {
    const args = useArgs()
    const config = useConfig()
    const mode = createPermissionMode({
      client: useClient(),
      directory: props.directory,
      requested: () => (args.auto ? "autoaccept" : config.data.session.permissions),
      toast: useToast(),
    })
    return {
      get mode(): PermissionMode {
        return mode()
      },
    }
  },
})
