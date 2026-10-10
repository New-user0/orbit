type BellRenderer = {
  readonly isDestroyed: boolean
  readonly isRunning?: boolean
  idle(): Promise<void>
  on?(event: "frame", listener: () => void): unknown
  off?(event: "frame", listener: () => void): unknown
}

/**
 * Rings the terminal bell between frames, so the BEL byte is not written while the renderer is composing one.
 * A renderer that is not running resolves `idle()` at once. A running one (a live tab pulse or spinner keeps it
 * running) never goes idle, so the bell goes out right after the next frame instead. Windows and macOS render on a
 * native thread, so a frame's bytes may still be in flight at that moment: the bell is one control byte, but it is
 * not guaranteed to land between two escape sequences there.
 */
export async function ringTerminalBell(
  renderer: BellRenderer,
  write: (text: string) => unknown = (text) => process.stdout.write(text),
) {
  if (renderer.isRunning && renderer.on && renderer.off) {
    let listener!: () => void
    const frame = new Promise<void>((resolve) => {
      listener = resolve
      renderer.on?.("frame", listener)
    })
    await Promise.race([frame, renderer.idle()])
    renderer.off("frame", listener)
  } else await renderer.idle()
  if (renderer.isDestroyed) return false
  write("\x07")
  return true
}
