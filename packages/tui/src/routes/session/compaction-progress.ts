import { createEffect, createSignal, onCleanup } from "solid-js"
import { useData } from "../../context/data"
import { useRouteData } from "../../context/route"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

/**
 * What a running compaction row adds to its header. The reply is never drawn. After 30 seconds the row shows how long
 * it has run and an estimate of the reply's tokens (characters / 4), the way a status line would. The header, its
 * spinner and gaps, and one cell of rule on each side must fit in `width`; the token figure goes first.
 */
export function compactionProgress(input: { elapsed: number; characters: number; width: number }) {
  if (input.elapsed < 30_000) return
  const time = Locale.duration(Math.floor(input.elapsed / 1000) * 1000)
  const estimate = Math.round(input.characters / 4)
  const fits = (header: string) => stringWidth(header) + 2 + 2 + 2 <= input.width
  const full = estimate > 0 ? `· ${time} · ↓ ${Locale.number(estimate)} tokens` : undefined
  if (full && fits(`Compaction ${full}`)) return full
  return fits(`Compaction · ${time}`) ? `· ${time}` : undefined
}

/** The progress text of a compaction row for the open session; a clock ticks once a second while the row runs. */
export function createCompactionProgress(input: { running: () => boolean; created: () => number; width: () => number }) {
  const route = useRouteData("session")
  const data = useData()
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!input.running()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return () =>
    input.running()
      ? compactionProgress({
          elapsed: now() - input.created(),
          characters: data.session.compactionCharacters(route.sessionID),
          width: input.width(),
        })
      : undefined
}
