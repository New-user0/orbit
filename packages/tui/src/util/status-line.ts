import { createMemo, createSignal, onCleanup } from "solid-js"
import path from "node:path"
import { ProgramLookup } from "@orbit/util/program-lookup"
import { ansiSpans, ansiText, type AnsiSpan } from "./ansi-spans"

const DEBOUNCE_MS = 300
// The default time limit of a hook command, which the status line command stands in for.
const RUN_LIMIT_MS = 10 * 60 * 1_000

/**
 * Runs the user's status line command every `interval` milliseconds, and again after `trigger()`, and keeps the
 * non-empty lines it prints (up to ten). The command gets the current session as JSON on stdin; a command that fails
 * leaves the last good line in place. Triggers are gathered for 300 ms, so a burst gives one run. A triggered run first
 * stops the command still running from an earlier change, with what it started, also when no command is left to run
 * (the folder is no longer trusted, hooks are off), and only the newest run's output is drawn. The interval leaves a
 * running command alone while it is still the configured one. Like a hook, a run is stopped after ten minutes; until
 * then a slow command keeps the last good line.
 */
export function createStatusLine(input: {
  readonly command: () => string | undefined
  readonly interval: () => number | undefined
  readonly payload: () => Record<string, unknown>
  /** Keep the SGR colors of the output as styled spans (`status_line.colors`). */
  readonly colors?: () => boolean | undefined
  readonly cwd?: string
  /**
   * Replaces the process that runs the command; it resolves to the raw output, or undefined when the run failed. The
   * signal aborts when a newer run replaces this one or the status line goes away.
   */
  readonly run?: (command: string, stdin: string, signal: AbortSignal) => Promise<string | undefined>
  /** How long a run may last before it is stopped: ten minutes unless a test asks for less. */
  readonly limit?: number
}) {
  const [output, setOutput] = createSignal<string>()
  const state = {
    disposed: false,
    current: undefined as AbortController | undefined,
    /** The command the run in flight started. */
    command: undefined as string | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const run =
    input.run ?? ((command: string, stdin: string, signal: AbortSignal) => spawn(command, stdin, input.cwd, signal))
  // Stops the run in flight, if any, with what it started.
  const stop = () => {
    state.current?.abort()
    state.current = undefined
  }
  const refresh = async (replace: boolean) => {
    if (state.disposed) return
    const command = input.command()
    if (state.current && !replace && command === state.command) return
    stop()
    if (!command) return
    const controller = new AbortController()
    state.current = controller
    state.command = command
    // The limit's timer is cleared once this run ends or is stopped, so it never stops a later run.
    const limit = setTimeout(stop, input.limit ?? RUN_LIMIT_MS)
    controller.signal.addEventListener("abort", () => clearTimeout(limit), { once: true })
    const result = await run(command, JSON.stringify(input.payload()), controller.signal).catch(() => undefined)
    if (controller.signal.aborted) return
    clearTimeout(limit)
    state.current = undefined
    if (result !== undefined) setOutput(result)
  }
  // One timer holds the next triggered run, so any number of triggers within 300 ms gives one run.
  const trigger = () => {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void refresh(true)
    }, DEBOUNCE_MS)
  }
  void refresh(false)
  const timer = setInterval(() => void refresh(false), Math.max(1_000, input.interval() ?? 5_000))
  // A command still running when the terminal UI goes away is stopped with what it started: its group is detached, so
  // nothing else would end it (class 10). The exit hook covers a quit that ends the process before cleanup runs.
  process.on("exit", stop)
  onCleanup(() => {
    state.disposed = true
    clearInterval(timer)
    clearTimeout(state.timer)
    process.off("exit", stop)
    stop()
  })
  const lines = createMemo(() => {
    const value = output()
    return value === undefined ? undefined : outputLines(value, false)
  })
  const colored = createMemo(() => {
    const value = output()
    return value === undefined ? undefined : outputLines(value, true).map((line) => ansiSpans(line))
  })
  const spanLines = createMemo(() => {
    const plain = lines()
    if (plain === undefined || plain.length === 0) return undefined
    return input.colors?.() === true ? colored() : plain.map((text): AnsiSpan[] => [{ text, attributes: 0 }])
  })
  return {
    /** The first line as plain text. */
    line: createMemo(() => lines()?.[0]),
    /** The first line as styled spans when `status_line.colors` is on, otherwise a single unstyled span. */
    spans: createMemo(() => spanLines()?.[0]),
    /** Every non-empty line as plain text. */
    lines,
    /** Every non-empty line as styled spans when `status_line.colors` is on, otherwise one unstyled span each. */
    spanLines,
    trigger,
  }
}

type Child = { readonly pid: number; readonly exitCode: number | null }

const system32 = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")

async function spawn(command: string, stdin: string, cwd: string | undefined, signal: AbortSignal) {
  const windows = process.platform === "win32"
  const child = Bun.spawn(
    // By full path on Windows: a bare "cmd" is looked up in the working folder, which may be an untrusted repository.
    // The command goes to cmd.exe as one quoted string, passed verbatim: the usual argument escaping writes a double
    // quote as \" and cmd.exe does not read that, so a quoted path or argument would fail.
    windows ? [path.join(system32(), "cmd.exe"), "/d", "/s", "/c", `"${command}"`] : ["sh", "-c", command],
    {
      cwd,
      windowsVerbatimArguments: windows,
      // cmd.exe looks for the head of the command in the working folder first, which may be an untrusted repository.
      env: ProgramLookup.environment(undefined),
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
      // Its own process group, so a replaced command and what it started end together.
      detached: !windows,
    },
  )
  // A newer run, or the terminal UI going away, stops the command together with what it started.
  signal.addEventListener("abort", () => killTree(child), { once: true })
  // The run ends once the output is closed and the shell has exited. A command can close its stdout and keep running,
  // and a grandchild can hold stdout open after the shell is gone: such a run lasts until something replaces it.
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return code === 0 ? output : undefined
}

function killTree(child: Child) {
  if (process.platform !== "win32") {
    // Negative pid: the whole group. Already gone throws, which leaves nothing to kill.
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
    return
  }
  // taskkill finds the tree through the parent that is still running. Once cmd.exe has exited there is nothing to find,
  // and its PID may belong to another process by now, so an exited shell leaves what it started alone. taskkill ends
  // the tree from its leaves up, so on a busy machine cmd.exe can start the next step of its line in between.
  if (child.exitCode !== null) return
  Bun.spawn([path.join(system32(), "taskkill.exe"), "/T", "/F", "/PID", String(child.pid)], {
    stdout: "ignore",
    stderr: "ignore",
    env: ProgramLookup.environment(undefined),
  })
}

const MAX_LINES = 10

/**
 * The non-empty lines of the output, trimmed, at most ten. With `colors` the SGR sequences stay in them for
 * `ansiSpans`; without, they go too. Every other escape sequence and control character is dropped or written out; with
 * `colors` the SGR sequences are left to `ansiSpans`, which drops the rest. A blank line is skipped wherever it is, so
 * a script that starts with an empty line still shows its output.
 */
export function outputLines(output: string, colors = false) {
  return output
    .split(/\r?\n/)
    .map((line) => (colors ? line : ansiText(line)).trim())
    .filter((line) => line !== "")
    .slice(0, MAX_LINES)
}

/** The first non-empty line of the output. */
export function firstLine(output: string, colors = false) {
  return outputLines(output, colors)[0]
}
