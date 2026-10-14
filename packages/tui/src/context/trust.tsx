import type { TrustStatus } from "@orbit/client"
import { isDeepEqual } from "remeda"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { DialogTrust } from "../component/dialog-trust"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { abbreviateHome } from "../util/path-format"
import { groupWithheld, holdsBack, pluginTrust, trustCommands } from "../util/trust"
import { useClient } from "./client"
import { useData } from "./data"
import { createSimpleContext } from "./helper"
import { useLocation } from "./location"
import { useLog } from "./log"
import { useTuiPaths } from "./runtime"

const DialogTrustKey = Symbol("DialogTrust")

/**
 * The trust status of the folder at `directory`, read again whenever the server reports that trust or config changed.
 * A read that fails keeps the last answer, because a dropped connection says nothing about trust, but `settled` still
 * turns true: a server that cannot answer, such as one older than workspace trust, or that does not answer in time, must
 * not hold anything up.
 */
export function createTrustStatus(input: {
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

  // The answer is the read's own, even when a newer read has started since and this one no longer shows in `status`; it
  // is unset when the read failed or timed out. Whoever acts on the answer right now, such as the plugin loader,
  // decides from this value and not from `status`, which may still hold an older one.
  const refresh = async (): Promise<TrustStatus | undefined> => {
    const attempt = ++generation
    return await input.client.api.location.trust
      // A server that takes the request and never answers would otherwise leave the terminal UI on its loading screen,
      // as nothing starts before the first answer. Two seconds, as `orb mini` allows; timing out is a failed read.
      .get({ location: { directory: directory() } }, { signal: AbortSignal.timeout(2_000) })
      .then(
        (next) => {
          if (attempt === generation)
            batch(() => {
              setStatus(next)
              setSettled(true)
            })
          return next
        },
        (error) => {
          input.log.warn("failed to read workspace trust", { error })
          if (attempt === generation) setSettled(true)
          return undefined
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
  // `directory` is the folder the terminal UI was started in, which is where it looks for its project's plugins.
  init: (props: { directory: string }) => {
    const client = useClient()
    const data = useData()
    const location = useLocation()
    const dialog = useDialog()
    const toast = useToast()
    const paths = useTuiPaths()
    const log = useLog({ component: "trust" })
    const directory = createMemo(() => (location.ref ?? data.location.default()).directory)
    // The plugins the terminal UI imports are the ones it finds from the folder it was started in, whichever session is
    // open, so what they may do follows that folder's trust and not that of the folder in view. That folder is asked
    // about by name: the server's default may be another folder, when the server could not resolve this one.
    const startup = createTrustStatus({ client, log, directory: () => props.directory })
    const current = createTrustStatus({ client, log, directory })
    // "Not now" holds for the rest of this run, by folder, so a refresh or a visit to another session asks no more.
    const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set())
    // The folder to ask about, if any. A string, so that a fresh read of the same answer does not ask again.
    const pending = createMemo(() => {
      const status = current.status()
      if (!status || !holdsBack(status) || dismissed().has(status.directory)) return undefined
      return status.directory
    })

    // A choice is for `target`, the folder the dialog was opened for.
    const grant = async (target: string, persist: boolean) => {
      // Asked before the grant, which clears it: whether this is a folder that was trusted and whose config changed.
      const changed = current.status()?.trusted === true
      await client.api.location.trust
        .update({ location: { directory: target }, trust: true, persist })
        .then(async (status) => {
          // The dialog closes on the answer the server gives now, not on the one it gave before. If another folder came
          // into view while the server was answering, the dialog that is up asks about that one and stays.
          await Promise.all([current.refresh(), startup.refresh()])
          if (directory() === target && dialog.key === DialogTrustKey) dialog.clear()
          const folder = abbreviateHome(status.directory, paths.home)
          // The grant lifts the folder's own config, so what is still held back sits above it, in folders of their own.
          const above = groupWithheld(status.withheld).above
          toast.show({
            variant: "success",
            message: [
              changed
                ? `Trusted the changes in ${folder}`
                : status.persistent
                  ? `Trusted ${folder}`
                  : `Trusted ${folder} until Orbit restarts`,
              ...(above.length === 0
                ? []
                : [`Config above it stays off until its own folder is trusted: ${trustCommands(above, target)}`]),
            ].join(". "),
          })
        }, toast.error)
    }

    const open = () => {
      const status = current.status()
      if (!status) return
      // A dialog asks about one folder, the one in view now, and what is chosen in it is for that folder. When another
      // comes into view the dialog closes (below), so a choice is never made for a folder that was not on the screen.
      const folder = directory()
      dialog.replace(
        () => (
          <DialogTrust
            status={current.status() ?? status}
            location={folder}
            onTrust={(persist) => grant(folder, persist)}
            onNotNow={() => dialog.clear()}
          />
        ),
        // However the dialog closes, unless the folder is trusted by then the answer is not now. The exception is a
        // dialog that closes because another folder came into view: nobody answered it.
        () => {
          if (directory() === folder && holdsBack(current.status()))
            setDismissed((previous) => new Set(previous).add(status.directory))
        },
        { key: DialogTrustKey },
      )
    }
    // Whoever trusts the folder first, here or with `orb trust`, settles the question.
    createEffect(() => {
      const status = current.status()
      if (status !== undefined && !holdsBack(status) && dialog.key === DialogTrustKey) dialog.clear()
    })
    // Another folder coming into view ends the dialog, and `useTrustPrompt` asks about that folder once its status is
    // read.
    createEffect(
      on(directory, () => {
        if (dialog.key === DialogTrustKey) dialog.clear()
      }),
    )

    return {
      /** The status of the folder in view: the current session's, or Home's. */
      status: current.status,
      held: createMemo(() => holdsBack(current.status())),
      pending,
      open,
      /**
       * Whether the folder at `directory()` is trusted, read again as that folder changes. For whatever hands a program a
       * folder other than the one in view or the one the terminal UI started in, such as the status line: the answer for
       * one folder says nothing about another, and it is false until the server has said otherwise.
       */
      folder: (directory: () => string) => {
        const read = createTrustStatus({ client, log, directory })
        return createMemo(() => read.status()?.trusted === true)
      },
      startup: {
        /** Whether the plugins in the project the terminal UI started in may load. */
        trusted: createMemo(() => startup.status()?.trusted === true),
        /**
         * The folders above the project that the server still holds config back for, each until its own decision. The
         * terminal UI finds its project's root without asking, so its plugins can lie in one of them. The same list is
         * the same answer, so that a read that finds nothing new does not rebuild the plugins.
         */
        above: createMemo(
          () => pluginTrust(startup.status()).above,
          [],
          { equals: isDeepEqual },
        ),
        /**
         * The config directories whose plugins changed since their folder was trusted, which the server holds back until
         * the changes are trusted. The terminal UI imports a project's plugins itself, so it leaves these out too.
         */
        changedPlugins: createMemo(
          () => pluginTrust(startup.status()).changed,
          [],
          { equals: isDeepEqual },
        ),
        /** Whether the first answer has come, whatever it was. */
        settled: startup.settled,
        /** Reads the status again now, for whoever is about to import a plugin and must not act on an older answer. */
        refresh: startup.refresh,
      },
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
