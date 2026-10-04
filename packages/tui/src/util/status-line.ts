import { createSignal, onCleanup } from "solid-js"

const TIMEOUT_MS = 2_000

/**
 * Runs the user's status line command every `interval` milliseconds and keeps the first line it prints. The command
 * gets the current session as JSON on stdin; a command that fails or hangs leaves the last good line in place.
 */
export function createStatusLine(input: {
  readonly command: () => string | undefined
  readonly interval: () => number | undefined
  readonly payload: () => Record<string, unknown>
}) {
  const [line, setLine] = createSignal<string>()
  const running = { current: false }
  const refresh = async () => {
    const command = input.command()
    if (!command || running.current) return
    running.current = true
    const child = Bun.spawn(process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command], {
      stdin: new TextEncoder().encode(JSON.stringify(input.payload())),
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    const output = await new Response(child.stdout).text().catch(() => "")
    clearTimeout(timer)
    running.current = false
    if ((await child.exited) !== 0) return
    setLine(firstLine(output))
  }
  void refresh()
  const timer = setInterval(() => void refresh(), Math.max(1_000, input.interval() ?? 5_000))
  onCleanup(() => clearInterval(timer))
  return line
}

export function firstLine(output: string) {
  // Keep colors out: the TUI styles the line itself, and escape codes would break its width.
  return (
    output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)[0]
      ?.trim() || undefined
  )
}
