type BellRenderer = {
  readonly isDestroyed: boolean
  idle(): Promise<void>
  on?(event: "frame", listener: () => void): unknown
  off?(event: "frame", listener: () => void): unknown
}

/**
 * Rings the terminal bell between frames, so the BEL byte is not written while the renderer is composing one.
 * It waits for whichever comes first: the renderer going idle, or the next frame. A renderer that is not running
 * resolves `idle()` at once; a running one (a live tab pulse or spinner) never goes idle, so the next frame ends the
 * wait. Racing both also covers a frame that is pending when a live animation starts. Windows and macOS render on a
 * native thread, so a frame's bytes may still be in flight at that moment: the bell is one control byte, but it is
 * not guaranteed to land between two escape sequences there.
 */
export async function ringTerminalBell(
  renderer: BellRenderer,
  write: (text: string) => unknown = (text) => process.stdout.write(text),
) {
  const frame = Promise.withResolvers<void>()
  renderer.on?.("frame", frame.resolve)
  await Promise.race([frame.promise, renderer.idle()])
  renderer.off?.("frame", frame.resolve)
  if (renderer.isDestroyed) return false
  write("\x07")
  return true
}
