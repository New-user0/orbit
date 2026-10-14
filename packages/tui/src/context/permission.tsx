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

export type HookPolicy = "open" | "disabled" | "managed_only" | "unknown"

/**
 * Whether managed settings let a command that stands in for a hook (the status line) run. "unknown" until the server
 * has answered, after a failed read (the last answer stays) and for a server that does not report it: a client does not
 * run the command on a guess, which is the refusal class 7 asks for. Disabled wins over managed-only, as for hooks.
 */
export function createHookPolicy(input: {
  client: Pick<ReturnType<typeof useClient>, "api" | "event">
  directory: string
}) {
  const log = useLog({ component: "permission" })
  const [policy, setPolicy] = createSignal<HookPolicy>("unknown")
  const refresh = () =>
    input.client.api.config
      .effective({ location: { directory: input.directory } })
      .then((effective) =>
        setPolicy(
          effective.hooks === undefined
            ? "unknown"
            : effective.hooks.disabled
              ? "disabled"
              : effective.hooks.managed_only
                ? "managed_only"
                : "open",
        ),
      )
      .catch((error) => log.warn("failed to read the effective configuration", { error }))

  void refresh()
  onCleanup(input.client.event.on("server.connected", refresh))
  onCleanup(input.client.event.on("config.updated", refresh))
  return policy
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: (props: { directory: string }) => {
    const args = useArgs()
    const config = useConfig()
    const client = useClient()
    const mode = createPermissionMode({
      client,
      directory: props.directory,
      requested: () => (args.auto ? "autoaccept" : config.data.session.permissions),
      toast: useToast(),
    })
    const hooks = createHookPolicy({ client, directory: props.directory })
    return {
      get mode(): PermissionMode {
        return mode()
      },
      get hooks(): HookPolicy {
        return hooks()
      },
    }
  },
})
