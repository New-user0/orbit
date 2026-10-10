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
