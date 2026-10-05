import type { TrustStatus } from "@orbit/client"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { DialogTrust } from "../component/dialog-trust"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { abbreviateHome } from "../util/path-format"
import { groupWithheld, trustCommands } from "../util/trust"
import { useClient } from "./client"
import { useData } from "./data"
import { createSimpleContext } from "./helper"
import { useLocation } from "./location"
import { useLog } from "./log"
import { useTuiPaths } from "./runtime"

const DialogTrustKey = Symbol("DialogTrust")

/**
 * Whether the folder is untrusted and so holds something of its own back, which is what the prompt and the indicator
 * are for. Config in a folder above it follows that folder's own decision, so a folder whose only held-back config
 * sits above it has nothing that trusting it would turn on.
 */
export function holdsBack(status: TrustStatus | undefined) {
  return status !== undefined && !status.trusted && groupWithheld(status.withheld).own.length > 0
}

/**
 * The trust status of the folder at `directory`, read again whenever the server reports that trust or config changed.
 * A read that fails keeps the last answer, because a dropped connection says nothing about trust, but `settled` still
 * turns true: a server that cannot answer, such as one older than workspace trust, must not hold anything up.
 */
function createTrustStatus(input: {
  client: ReturnType<typeof useClient>
  log: ReturnType<typeof useLog>
  directory: () => string
}) {
  // Only a different folder starts over: the same one named again is not a change.
  const directory = createMemo(input.directory)
  const [status, setStatus] = createSignal<TrustStatus>()
  const [settled, setSettled] = createSignal(false)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    const attempt = ++generation
    await input.client.api.location.trust.get({ location: { directory: directory() } }).then(
      (next) => {
        if (attempt !== generation) return
        batch(() => {
          setStatus(next)
          setSettled(true)
        })
      },
      (error) => {
        input.log.warn("failed to read workspace trust", { error })
        if (attempt === generation) setSettled(true)
      },
    )
  }
  // A reload touches several files and sends several events, which should come to one read.
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 150)
  }

  createEffect(
    on(directory, () => {
      // What was read for another folder says nothing about this one.
      setStatus(undefined)
      void refresh()
    }),
  )
  onCleanup(input.client.event.on("trust.updated", schedule))
  onCleanup(input.client.event.on("config.updated", schedule))
  onCleanup(input.client.event.on("server.connected", schedule))
  onCleanup(() => clearTimeout(timer))
  return { status, settled, refresh }
}

export const { use: useTrust, provider: TrustProvider } = createSimpleContext({
  name: "Trust",
  init: () => {
    const client = useClient()
    const data = useData()
    const location = useLocation()
    const dialog = useDialog()
    const toast = useToast()
    const paths = useTuiPaths()
    const log = useLog({ component: "trust" })
    const directory = createMemo(() => (location.ref ?? data.location.default()).directory)
    // The folder the terminal UI started in is where it finds its project's plugins, whichever session is open, so
    // what those may do follows its trust and not that of the folder in view.
    const started = data.location.default().directory
    const startup = createTrustStatus({ client, log, directory: () => started })
    const current = createTrustStatus({ client, log, directory })
    // "Not now" holds for the rest of this run, by folder, so a refresh or a visit to another session asks no more.
    const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set())
    // The folder to ask about, if any. A string, so that a fresh read of the same answer does not ask again.
    const pending = createMemo(() => {
      const status = current.status()
      if (!status || !holdsBack(status) || dismissed().has(status.directory)) return undefined
      return status.directory
    })

    const grant = async (persist: boolean) => {
      await client.api.location.trust
        .update({ location: { directory: directory() }, trust: true, persist })
        .then(async (status) => {
          // The dialog closes on the answer the server gives now, not on the one it gave before.
          await Promise.all([current.refresh(), startup.refresh()])
          if (dialog.key === DialogTrustKey) dialog.clear()
          const folder = abbreviateHome(status.directory, paths.home)
          // The grant lifts the folder's own config, so what is still held back sits above it, in folders of their own.
          const above = groupWithheld(status.withheld).above
          toast.show({
            variant: "success",
            message: [
              status.persistent ? `Trusted ${folder}` : `Trusted ${folder} until Orbit restarts`,
              ...(above.length === 0
                ? []
                : [`Config above it stays off until its own folder is trusted: ${trustCommands(above)}`]),
            ].join(". "),
          })
        }, toast.error)
    }

    const open = () => {
      const status = current.status()
      if (!status) return
      dialog.replace(
        () => <DialogTrust status={current.status() ?? status} onTrust={grant} onNotNow={() => dialog.clear()} />,
        // However the dialog closes, unless the folder is trusted by then the answer is not now.
        () => {
          if (!current.status()?.trusted) setDismissed((previous) => new Set(previous).add(status.directory))
        },
        { key: DialogTrustKey },
      )
    }
    // Whoever trusts the folder first, here or with `orb trust`, settles the question.
    createEffect(() => {
      if (current.status()?.trusted && dialog.key === DialogTrustKey) dialog.clear()
    })

    return {
      /** The status of the folder in view: the current session's, or Home's. */
      status: current.status,
      held: createMemo(() => holdsBack(current.status())),
      pending,
      open,
      /** Whether the plugins in the project the terminal UI started in may load, and whether that is known yet. */
      startup: { trusted: createMemo(() => startup.status()?.trusted === true), settled: startup.settled },
    }
  },
})

/**
 * Asks whether to trust the folder in view when it holds something back and nobody has said not now. For the routes
 * that show a folder's work, which are Home and a session.
 */
export function useTrustPrompt() {
  const trust = useTrust()
  const dialog = useDialog()
  createEffect(() => {
    // A person in another dialog is busy, so the question waits for it to close.
    if (trust.pending() !== undefined && dialog.stack.length === 0) untrack(trust.open)
  })
}
