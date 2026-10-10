/**
 * Whether Orbit should speak up in the editor. A notice shows only when the person turned notices on and cannot see the
 * chat: its panel is hidden, or the window is in the background. The texts are fixed. They carry no session title and no
 * tool input, because those come from the model and from files.
 */
export function notice(input: {
  event: "permission" | "done"
  enabled: boolean
  panelVisible: boolean
  windowFocused: boolean
}): { level: "warning" | "info"; text: string } | undefined {
  if (!input.enabled) return
  if (input.panelVisible && input.windowFocused) return
  return input.event === "permission"
    ? { level: "warning", text: "Orbit needs your review" }
    : { level: "info", text: "Orbit finished" }
}

/**
 * Decides which events earn a notice, so each fires once. A pending permission notices the first time its id is seen,
 * however often the item is updated. The end of a busy period notices; the first idle report after connecting does
 * not, because it is not the end of anything.
 */
export function createNoticeTracker() {
  const noticed = new Set<string>()
  let busy = false
  return {
    permission(item: { id: string }): "permission" | undefined {
      if (noticed.has(item.id)) return
      noticed.add(item.id)
      return "permission"
    },
    busy(next: boolean): "done" | undefined {
      const ended = busy && !next
      busy = next
      return ended ? "done" : undefined
    },
  }
}
