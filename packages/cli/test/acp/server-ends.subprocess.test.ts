import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runProgram } from "../../../core/test/fixture/run-program"
import { createAcpFixture, initialize, type AcpProcess } from "./subprocess"

// `orb acp` ends with process.exit and does not wait for the private server it started (src/commands/handlers/acp.ts): the
// server ends because the pipe it reads as its lease closes with the process. The server then closes orbit.db and exits on
// its own time, and a test that removed the folder or started another `orb` on it in that time met a held database (CI run
// 45555726730). These rows pin what the handler's comment promises: after `orb acp` is gone, by whichever way, the server
// it started is gone too, shortly, and with it the process that holds orbit.db.
const SERVER_ENDS_WITHIN = 30_000

describe("orb acp and its private server", () => {
  test("stdin EOF: the server ends after the exit with code 0", async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const server = await serverOf(acp)
    expect(await acp.close()).toBe(0)
    await expectEnded(server)
  }, 120_000)

  test("the server killed under it: exit 1 naming the server, and no server is left", async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const server = await serverOf(acp)
    process.kill(server, "SIGKILL")
    expect(await acp.exited).toBe(1)
    expect(acp.stderr()).toContain("orb acp: server exited unexpectedly")
    await expectEnded(server)
  }, 120_000)

  // A signal the process cannot catch (Windows has no other way to stop a child that has no console) and one it can.
  test.each(process.platform === "win32" ? (["SIGKILL"] as const) : (["SIGKILL", "SIGINT", "SIGTERM"] as const))(
    "%s to the process: the server ends",
    async (signal) => {
      await using fixture = await createAcpFixture()
      const acp = fixture.spawn()
      await initialize(acp)
      const server = await serverOf(acp)
      process.kill(acp.pid, signal)
      await acp.exited
      await expectEnded(server)
    },
    120_000,
  )
})

// The `serve --stdio` process that `orb acp` started: its child, found by command line. Windows keeps the parent id of a
// process after the parent has exited, so the lookup also works for a server whose `orb acp` is already gone.
async function serverOf(acp: AcpProcess) {
  const listing = await children(acp.pid)
  const server = listing.find((entry) => entry.command.includes("serve") && entry.command.includes("--stdio"))
  if (!server) throw new Error(`orb acp ${acp.pid} has no private server among its children:\n${JSON.stringify(listing)}`)
  // The control of every row: the server runs while orb acp does, so "ended" below is a change and not a wrong pid.
  if (!alive(server.pid)) throw new Error(`the private server ${server.pid} of orb acp ${acp.pid} is not running`)
  return server.pid
}

async function children(parent: number) {
  if (process.platform === "win32") {
    // By its full path, so no powershell.exe in the working folder is started instead (class 10).
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    const result = await runProgram([
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
    ])
    return lines(result.stdout.toString())
  }
  const result = await runProgram(["ps", "-o", "pid=,args=", "--ppid", String(parent)])
  return lines(result.stdout.toString())
}

function lines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .flatMap((match) => (match ? [{ pid: Number(match[1]), command: match[2] }] : []))
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function expectEnded(pid: number) {
  const started = Date.now()
  while (alive(pid)) {
    if (Date.now() - started > SERVER_ENDS_WITHIN)
      throw new Error(`the private server ${pid} was still running ${SERVER_ENDS_WITHIN / 1000} s after orb acp ended`)
    await Bun.sleep(50)
  }
  console.log(`server ${pid} ended ${Date.now() - started} ms after orb acp ended`)
}
