import type { TrustStatus } from "@orbit/client"
import { Trust } from "@orbit/schema/trust"
import { Option, Schema } from "effect"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { DialogTrust } from "../component/dialog-trust"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { abbreviateHome } from "../util/path-format"
import { asksTrust } from "../util/trust"
import { useClient } from "./client"
import { useData } from "./data"
import { TrustDeclined, useExit } from "./exit"
import { createSimpleContext } from "./helper"
import { useLocation } from "./location"
import { useLog } from "./log"
import { useTuiPaths } from "./runtime"

const DialogTrustKey = Symbol("DialogTrust")
const decodeStatus = Schema.decodeUnknownOption(Trust.Status)

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
      // An answer that is not a trust status is a failed read as well (class 7), not one to draw from.
      .then((answer) => {
        if (Option.isNone(decodeStatus(answer))) throw new Error("the answer is not a trust status")
        return answer
      })
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
      // What was read for another folder says nothing about this one, and nor does whether that read came back.
      batch(() => {
        setStatus(undefined)
        setSettled(false)
      })
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
    const exit = useExit()
    const directory = createMemo(() => (location.ref ?? data.location.default()).directory)
    // The plugins the terminal UI imports are the ones it finds from the folder it was started in, whichever session is
    // open, so what they may do follows that folder's trust and not that of the folder in view. That folder is asked
    // about by name: the server's default may be another folder, when the server could not resolve this one.
    const startup = createTrustStatus({ client, log, directory: () => props.directory })
    const current = createTrustStatus({ client, log, directory })
    // "Not now" holds for the rest of this run, by folder, so a refresh or a visit to another session asks no more.
    const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set())
    // What is known of the folder in view. A read that failed or timed out, with no answer before it, is taken as a
    // folder that is not trusted, so the question opens anyway and names the folder it asked about (class 7). The
    // server refuses work there whatever the terminal UI shows.
    const asked = createMemo((): TrustStatus | undefined => {
      const status = current.status()
      if (status !== undefined || !current.settled()) return status
      return { directory: directory(), trusted: false, persistent: true, withheld: [] }
    })
    // Whether a question about this folder is the one about the folder the terminal UI started in, which offers Exit in
    // place of Not now: nothing can be done there until it is trusted, as the reference does.
    // Home shows that folder, the server's default location, and a session shows its own unless the server names the
    // same folder for both.
    const starting = (status: TrustStatus) =>
      directory() === data.location.default().directory || status.directory === startup.status()?.directory
    // Whether the prompts take typing. Not until the folder in view has been read and, when it is the folder the terminal
    // UI started in and is not trusted, the person has trusted it: the reference asks before it draws anything that takes
    // input, so nothing typed ahead reaches a prompt or answers the question. A read that fails, times out or does not
    // decode stands for a folder that is not trusted (`asked`), so it keeps the prompts closed too. Once open they stay
    // open for the run.
    const typing = createMemo((open: boolean) => {
      if (open) return true
      const status = asked()
      return status !== undefined && (status.trusted || !starting(status))
    }, false)
    // The folder to ask about, if any. A string, so that a fresh read of the same answer does not ask again.
    const pending = createMemo(() => {
      const status = asked()
      if (!status || !asksTrust(status) || dismissed().has(status.directory)) return undefined
      return status.directory
    })

    // A choice is for `target`, the folder the dialog was opened for.
    const grant = async (target: string, persist: boolean) => {
      await client.api.location.trust
        .update({ location: { directory: target }, trust: true, persist })
        .then(async (status) => {
          // The dialog closes on the answer the server gives now, not on the one it gave before. If another folder came
          // into view while the server was answering, the dialog that is up asks about that one and stays.
          await Promise.all([current.refresh(), startup.refresh()])
          if (directory() === target && dialog.key === DialogTrustKey) dialog.clear()
          const folder = abbreviateHome(status.directory, paths.home)
          toast.show({
            variant: "success",
            message: status.persistent ? `Trusted ${folder}` : `Trusted ${folder} until Orbit restarts`,
          })
        }, toast.error)
    }

    const open = () => {
      const status = asked()
      if (!status) return
      // A dialog asks about one folder, the one in view now, and what is chosen in it is for that folder. When another
      // comes into view the dialog closes (below), so a choice is never made for a folder that was not on the screen.
      const folder = directory()
      // The folder the terminal UI started in, while it is not trusted, is answered with Trust or Exit.
      const leaving = !status.trusted && starting(status)
      // Only a question that opens while the prompts are closed can start on Trust, because no keystroke meant for a
      // prompt can reach it. One that opens later, such as after `orb trust --revoke`, starts on Exit or Not now.
      const guarded = !typing()
      dialog.replace(
        () => (
          <DialogTrust
            status={asked() ?? status}
            leave={leaving ? "exit" : "later"}
            guarded={guarded}
            onTrust={(persist) => grant(folder, persist)}
            onNotNow={() => dialog.clear()}
            onDecline={() => exit(new TrustDeclined(0))}
          />
        ),
        // However the dialog closes, unless the folder is trusted by then the answer is no: Exit for the folder the
        // terminal UI started in, which ends it with status 1, and not now for any other. The exception is a dialog
        // that closes because another folder came into view: nobody answered it.
        () => {
          if (directory() !== folder || !asksTrust(asked())) return
          if (leaving && asked()?.trusted !== true) return exit(new TrustDeclined(1))
          setDismissed((previous) => new Set(previous).add(status.directory))
        },
        { key: DialogTrustKey },
      )
    }
    // Whoever trusts the folder first, here or with `orb trust`, settles the question.
    createEffect(() => {
      const status = current.status()
      if (status !== undefined && !asksTrust(status) && dialog.key === DialogTrustKey) dialog.clear()
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
      held: createMemo(() => asksTrust(asked())),
      /** Whether the prompts take typing: the folder in view was read, and is trusted unless it is another folder. */
      typing,
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
         * The folder the server decided the startup folder's trust for. The terminal UI finds its project's root without
         * asking, so this bounds its walk where the server's root is the narrower one (class 3).
         */
        root: createMemo(() => startup.status()?.directory),
        /** Whether the first answer has come, whatever it was. */
        settled: startup.settled,
        /** Reads the status again now, for whoever is about to import a plugin and must not act on an older answer. */
        refresh: startup.refresh,
      },
    }
  },
})

/**
 * Asks whether to trust the folder in view when it is not trusted and nobody has said not now. For the routes that show a folder's work, which are Home and a session.
 */
export function useTrustPrompt() {
  const trust = useTrust()
  const dialog = useDialog()
  createEffect(() => {
    // A person in another dialog is busy, so the question waits for it to close.
    if (trust.pending() !== undefined && dialog.stack.length === 0) untrack(trust.open)
  })
}
