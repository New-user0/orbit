import { createMemo, createSignal, onCleanup } from "solid-js"
import path from "node:path"
import { ProgramLookup } from "@orbit/util/program-lookup"
import { ansiSpans, ansiText, type AnsiSpan } from "./ansi-spans"

const TIMEOUT_MS = 2_000
const DEBOUNCE_MS = 300

/**
 * Runs the user's status line command every `interval` milliseconds, and again after `trigger()`, and keeps the
 * non-empty lines it prints (up to ten). The command gets the current session as JSON on stdin; a command that fails or hangs leaves the last
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
    child: undefined as Child | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const run =
    input.run ??
    ((command: string, stdin: string) =>
      spawn(command, stdin, input.cwd, (child) => {
        state.child = child
      }))
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
  // A command still running when the terminal UI goes away is stopped with what it started: its group is detached, so
  // nothing else would end it (class 10). The exit hook covers a quit that ends the process before cleanup runs.
  const stop = () => {
    if (state.child) killTree(state.child)
  }
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

async function spawn(command: string, stdin: string, cwd: string | undefined, track: (child?: Child) => void) {
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
      // Its own process group, so a hung command and what it started end together.
      detached: !windows,
    },
  )
  track(child)
  const timeout = Symbol("timeout")
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  // Output and exit are both inside the limit: a command can close its stdout and keep running, and a grandchild can
  // hold stdout open after the shell is gone. Either way the run gives up and the whole group is stopped.
  const result = await Promise.race([
    Promise.all([new Response(child.stdout).text().catch(() => ""), child.exited]),
    new Promise<typeof timeout>((resolve) => {
      timer.id = setTimeout(() => {
        killTree(child)
        resolve(timeout)
      }, TIMEOUT_MS)
    }),
  ])
  clearTimeout(timer.id)
  track(undefined)
  if (result === timeout) return
  return result[1] === 0 ? result[0] : undefined
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
  // and its PID may belong to another process by now, so an exited shell leaves what it started alone.
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
