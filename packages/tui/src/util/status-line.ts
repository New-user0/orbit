import { createMemo, createSignal, onCleanup } from "solid-js"
import path from "node:path"
import { ProgramLookup } from "@orbit/util/program-lookup"
import { ansiSpans, ansiText } from "./ansi-spans"

const TIMEOUT_MS = 2_000
const DEBOUNCE_MS = 300

/**
 * Runs the user's status line command every `interval` milliseconds, and again after `trigger()`, and keeps the first
 * line it prints. The command gets the current session as JSON on stdin; a command that fails or hangs leaves the last
 * good line in place. A triggered run starts at least 300 ms after the previous run started: a trigger that arrives
 * during a run sets a flag and causes exactly one more run, 300 ms after the first one started or when it ends,
 * whichever is later.
 */
export function createStatusLine(input: {
  readonly command: () => string | undefined
  readonly interval: () => number | undefined
  readonly payload: () => Record<string, unknown>
  /** Keep the SGR colors of the output as styled spans (`status_line.colors`). */
  readonly colors?: () => boolean | undefined
  readonly cwd?: string
  /** Replaces the process that runs the command; it resolves to the raw output, or undefined when the run failed. */
  readonly run?: (command: string, stdin: string) => Promise<string | undefined>
}) {
  const [output, setOutput] = createSignal<string>()
  const state = {
    running: false,
    dirty: false,
    disposed: false,
    lastStart: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const run = input.run ?? ((command: string, stdin: string) => spawn(command, stdin, input.cwd))
  const refresh = async () => {
    if (state.disposed) return
    const command = input.command()
    if (!command) return
    if (state.running) return
    state.running = true
    state.lastStart = Date.now()
    const result = await run(command, JSON.stringify(input.payload())).catch(() => undefined)
    state.running = false
    if (state.disposed) return
    if (result !== undefined) setOutput(result)
    if (!state.dirty) return
    state.dirty = false
    schedule(Math.max(0, state.lastStart + DEBOUNCE_MS - Date.now()))
  }
  // One timer holds the next triggered run, so any number of triggers gives one run.
  const schedule = (delay: number) => {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      // A run may have started meanwhile (the interval): fold this trigger into its trailing run.
      if (state.running) state.dirty = true
      else void refresh()
    }, delay)
  }
  const trigger = () => {
    if (state.running) {
      state.dirty = true
      return
    }
    schedule(DEBOUNCE_MS)
  }
  void refresh()
  const timer = setInterval(() => void refresh(), Math.max(1_000, input.interval() ?? 5_000))
  onCleanup(() => {
    state.disposed = true
    clearInterval(timer)
    clearTimeout(state.timer)
  })
  const spans = createMemo(() => {
    const value = output()
    if (value === undefined) return undefined
    const line = firstLine(value, true)
    return line === undefined ? undefined : ansiSpans(line)
  })
  const line = createMemo(() => {
    const value = output()
    return value === undefined ? undefined : firstLine(value, false)
  })
  return {
    /** The first line as plain text. */
    line,
    /** The first line as styled spans when `status_line.colors` is on, otherwise a single unstyled span. */
    spans: createMemo(() => {
      const value = line()
      if (value === undefined) return undefined
      return input.colors?.() === true ? spans() : [{ text: value, attributes: 0 }]
    }),
    trigger,
  }
}

const system32 = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")

async function spawn(command: string, stdin: string, cwd: string | undefined) {
  const windows = process.platform === "win32"
  const child = Bun.spawn(
    // By full path on Windows: a bare "cmd" is looked up in the working folder, which may be an untrusted repository.
    windows ? [path.join(system32(), "cmd.exe"), "/c", command] : ["sh", "-c", command],
    {
      cwd,
      // cmd.exe looks for the head of the command in the working folder first, which may be an untrusted repository.
      env: ProgramLookup.environment(undefined),
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
      // Its own process group, so a hung command and what it started end together.
      detached: !windows,
    },
  )
  const timeout = Symbol("timeout")
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const output = await Promise.race([
    new Response(child.stdout).text().catch(() => ""),
    // A grandchild can hold stdout open after the shell is gone, so the run stops waiting for it.
    new Promise<typeof timeout>((resolve) => {
      timer.id = setTimeout(() => {
        killTree(child.pid)
        resolve(timeout)
      }, TIMEOUT_MS)
    }),
  ])
  clearTimeout(timer.id)
  if (output === timeout) return
  if ((await child.exited) !== 0) return
  return output
}

function killTree(pid: number) {
  if (process.platform !== "win32") {
    // Negative pid: the whole group. Already gone throws, which leaves nothing to kill.
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
    return
  }
  Bun.spawn([path.join(system32(), "taskkill.exe"), "/T", "/F", "/PID", String(pid)], {
    stdout: "ignore",
    stderr: "ignore",
    env: ProgramLookup.environment(undefined),
  })
}

/**
 * The first line of the output. With `colors` the SGR sequences stay in it for `ansiSpans`; without, they go too.
 * Every other escape sequence and control character is dropped or written out either way.
 */
export function firstLine(output: string, colors = false) {
  const first = output.split(/\r?\n/)[0]
  if (first === undefined) return
  return (colors ? first : ansiText(first)).trim() || undefined
}
