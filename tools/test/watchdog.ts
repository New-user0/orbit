import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Runs `bun test` with the given arguments and stops the run when one test file has run past its deadline.
//
// A test worker that blocks in a synchronous call never lets bun's per-test timeout fire (it is a timer on the same
// thread), and a file that waits at its top level has no test for a timeout to apply to. The other worker then runs
// every file that is left and the run never ends, so a CI job held its runner until the job's time limit and named
// nothing. Each worker writes when it starts and ends a file (tools/test/heartbeat.ts); a file that started longer
// ago than its deadline in a worker that is still alive is stuck. The run is then stopped, the file is named, and the
// exit code is 1. A run whose files all end in time exits with bun's own code.
//
// The deadline of a file is ORBIT_TEST_FILE_DEADLINE_MS (ten minutes by default) or three times its entry in the
// timings file the run balances by, whichever is longer.
export async function runTests(args: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-heartbeat-"))
  const child = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd,
    // A runner started by a test must not write into its parent run's folder.
    env: { ...env, ORBIT_TEST_HEARTBEAT: folder },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // Its own process group on Linux and macOS, so one signal reaches the workers too.
    detached: process.platform !== "win32",
  })
  const signal = (name: NodeJS.Signals) => () => {
    if (process.platform === "win32") return child.kill(name)
    process.kill(-child.pid, name)
  }
  const interrupt = signal("SIGINT")
  const terminate = signal("SIGTERM")
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  const base = Number(env.ORBIT_TEST_FILE_DEADLINE_MS) || 600_000
  const measured = timings(args)
  // Files are named as the timings name them: relative to the package, with forward slashes.
  const relative = (file: string) => path.relative(cwd, file).split(path.sep).join("/")
  const deadline = (file: string) => Math.max(base, 3 * (measured[relative(file)] ?? 0))
  const stuck: { stopping?: Promise<unknown> } = {}
  // The folder is read synchronously, so one look ends before the next can start and a file is reported once.
  const watch = setInterval(() => {
    const found = fs
      .readdirSync(folder)
      .map((pid) => lastStart(folder, pid))
      .find((entry) => entry !== undefined && Date.now() - entry.at > deadline(entry.file) && alive(entry.pid))
    if (!found) return
    clearInterval(watch)
    report(found, relative(found.file), deadline(found.file))
    stuck.stopping = stop(child)
  }, Math.min(5_000, base / 4))
  const code = await child.exited
  clearInterval(watch)
  // A stopped run ends with the signal's code; it fails with 1 once every worker is gone.
  await stuck.stopping
  process.off("SIGINT", interrupt)
  process.off("SIGTERM", terminate)
  fs.rmSync(folder, { recursive: true, force: true })
  return stuck.stopping ? 1 : code
}

function timings(args: string[]): Record<string, number> {
  const file = args.find((arg) => arg.startsWith("--timings="))?.slice("--timings=".length)
  if (!file || !fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, "utf8")).files ?? {}
}

// The file a worker is in: its last line, when that line starts a file.
function lastStart(folder: string, pid: string) {
  const line = fs.readFileSync(path.join(folder, pid), "utf8").trimEnd().split("\n").at(-1) ?? ""
  const match = /^(\d+) start (.+)$/.exec(line)
  if (!match) return undefined
  return { pid: Number(pid), at: Number(match[1]), file: match[2] }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function report(entry: { pid: number; at: number }, file: string, deadline: number) {
  const seconds = Math.round((Date.now() - entry.at) / 1000)
  console.error(
    `Test file stuck: ${file} has run for ${seconds} s, past its deadline of ${deadline / 1000} s (worker ${entry.pid}). Stopping the run.`,
  )
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=Test file stuck::${file}`)
  if (process.platform === "linux") console.error(linuxState(entry.pid))
}

// What the stuck worker is doing, from /proc: its state and kernel wait channel, each thread's state, and its child
// processes, so the next hang in CI carries its own evidence. A worker that exits while it is read gives `?` and no
// threads instead of an error, so the kill that follows the report always runs.
export function linuxState(pid: number) {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8").trim()
    } catch {
      return "?"
    }
  }
  const list = (folder: string) => {
    try {
      return fs.readdirSync(folder)
    } catch {
      return []
    }
  }
  // The state is the field after the command name, which is in parentheses and may hold spaces.
  const state = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
  const tasks = list(`/proc/${pid}/task`)
  const children = tasks.flatMap((task) => read(`/proc/${pid}/task/${task}/children`).split(" ").filter(Boolean))
  return [
    `worker ${pid}: ${read(`/proc/${pid}/status`).split("\n").find((line) => line.startsWith("State:")) ?? "State: ?"}, wchan ${read(`/proc/${pid}/wchan`)}`,
    `threads: ${tasks.map((task) => `${task} ${state(read(`/proc/${pid}/task/${task}/stat`))}`).join(", ")}`,
    `children: ${children.map((child) => `${child} ${read(`/proc/${child}/comm`)} ${state(read(`/proc/${child}/stat`))}`).join(", ") || "none"}`,
  ].join("\n")
}

// Stops `bun test` and every worker under it. On Windows taskkill is started by its full path, never by its name, which
// Windows would look up in the package's folder first (class 10). Elsewhere the whole process group is killed, and the
// run waits (a few seconds at most) until the killed workers have been reaped, so none is left when it ends.
async function stop(child: Bun.Subprocess) {
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
    await Bun.spawn([taskkill, "/T", "/F", "/PID", String(child.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      .exited
    return
  }
  process.kill(-child.pid, "SIGKILL")
  const until = Date.now() + 5_000
  while (Date.now() < until && alive(-child.pid)) await Bun.sleep(50)
}
