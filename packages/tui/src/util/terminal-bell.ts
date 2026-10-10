/**
 * Rings the terminal bell once the renderer has no frame in flight, so the BEL byte never lands inside a frame or
 * an escape sequence the renderer is writing. Windows console hosts honor BEL too, so there is no platform branch.
 */
export async function ringTerminalBell(
  renderer: { readonly isDestroyed: boolean; idle(): Promise<void> },
  write: (text: string) => unknown = (text) => process.stdout.write(text),
) {
  await renderer.idle()
  if (renderer.isDestroyed) return false
  write("\x07")
  return true
}
