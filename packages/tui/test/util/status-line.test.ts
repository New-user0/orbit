import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRoot } from "solid-js"
import { currentDirectoryOnPath, plant } from "../../../core/test/fixture/decoy"
import { createStatusLine, firstLine } from "../../src/util/status-line"
import { statusLinePayload } from "../../src/util/status-line-payload"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(options: { interval?: number; delay?: number } = {}) {
  const calls: string[] = []
  const gate: { release: Array<() => void> } = { release: [] }
  const dispose = { current: () => {} }
  const status = createRoot((stop) => {
    dispose.current = stop
    return createStatusLine({
      command: () => "line",
      interval: () => options.interval ?? 60_000,
      payload: () => ({}),
      run: async () => {
        calls.push("run")
        if (options.delay === -1) await new Promise<void>((resolve) => gate.release.push(resolve))
        else if (options.delay) await wait(options.delay)
        return `line ${calls.length}\n`
      },
    })
  })
  return { status, calls, gate, dispose: dispose.current }
}

test("the status line keeps the first line of output without colors", () => {
  expect(firstLine("\u001b[32mmain\u001b[0m ✓\nsecond line\n")).toBe("main ✓")
  expect(firstLine("\n")).toBeUndefined()
})

test("the status line drops other escape sequences and writes control characters out", () => {
  // OSC title, OSC 52 clipboard write, cursor movement and a stray bell must not reach the renderer.
  expect(firstLine("\u001b]0;title\u0007a\u001b]52;c;aGk=\u001b\\b\u001b[2Jc\u0007d")).toBe("abc\u2407d")
})

test("a burst of events gives one refresh per 300 ms", async () => {
  const test = harness()
  await wait(20)
  expect(test.calls.length).toBe(1)
  for (let index = 0; index < 20; index++) test.status.trigger()
  await wait(100)
  expect(test.calls.length).toBe(1)
  await wait(300)
  expect(test.calls.length).toBe(2)
  test.status.trigger()
  test.status.trigger()
  await wait(400)
  expect(test.calls.length).toBe(3)
  test.dispose()
})

test("a trigger during an in-flight run gives exactly one trailing refresh", async () => {
  const test = harness({ delay: -1 })
  await wait(20)
  expect(test.calls.length).toBe(1)
  test.status.trigger()
  test.status.trigger()
  test.status.trigger()
  test.gate.release.shift()?.()
  // The trailing run starts 300 ms after the first one started.
  await wait(400)
  expect(test.calls.length).toBe(2)
  test.gate.release.shift()?.()
  await wait(400)
  expect(test.calls.length).toBe(2)
  test.dispose()
})

test("steady triggers against a slow run still give at most about three runs per second", async () => {
  const test = harness({ delay: 50 })
  const ticker = setInterval(() => test.status.trigger(), 10)
  await wait(2_000)
  clearInterval(ticker)
  test.dispose()
  // Without the throttle on the trailing run this was 40 runs; one per 300 ms is 7.
  expect(test.calls.length).toBeLessThanOrEqual(9)
  expect(test.calls.length).toBeGreaterThanOrEqual(4)
}, 10_000)

test("a trigger during a run does not start another run after the status line is disposed", async () => {
  const test = harness({ delay: -1 })
  await wait(20)
  test.status.trigger()
  test.dispose()
  test.gate.release.shift()?.()
  await wait(400)
  expect(test.calls.length).toBe(1)
})

test("the interval still fires", async () => {
  const test = harness({ interval: 1_000 })
  await wait(1_200)
  expect(test.calls.length).toBeGreaterThanOrEqual(2)
  test.dispose()
})

test("a failed or hung run keeps the last good line", async () => {
  const outputs = [undefined, "good\n", undefined]
  const state = { index: 0 }
  const status = createRoot(() =>
    createStatusLine({
      command: () => "line",
      interval: () => 60_000,
      payload: () => ({}),
      run: async () => outputs[state.index++],
    }),
  )
  await wait(20)
  expect(status.line()).toBeUndefined()
  status.trigger()
  await wait(400)
  expect(status.line()).toBe("good")
  status.trigger()
  await wait(400)
  expect(state.index).toBe(3)
  expect(status.line()).toBe("good")
})

test("colors are kept as spans only when status_line.colors is on", () => {
  const make = (colors: boolean) =>
    createRoot(() => {
      const status = createStatusLine({
        command: () => "line",
        interval: () => 60_000,
        payload: () => ({}),
        colors: () => colors,
        run: async () => "\u001b[31mred\u001b[0m plain\n",
      })
      return status
    })
  const on = make(true)
  const off = make(false)
  return wait(20).then(() => {
    expect(on.spans()?.map((span) => [span.text, span.fg])).toEqual([
      ["red", "#cd0000"],
      [" plain", undefined],
    ])
    expect(off.spans()).toEqual([{ text: "red plain", attributes: 0 }])
  })
})

test("a real command that hangs keeps the last good line and the next trigger starts a new run", async () => {
  const hang = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30"
  const commands = ["echo good", hang, "echo after"]
  const state = { index: 0 }
  const status = createRoot(() =>
    createStatusLine({
      command: () => commands[state.index++],
      interval: () => 60_000,
      payload: () => ({}),
    }),
  )
  await wait(700)
  expect(status.line()).toBe("good")
  status.trigger()
  // The hang starts at about 300 ms and is given up at 2 s; a run that kept waiting for its output would still be open.
  await wait(2_800)
  expect(state.index).toBe(2)
  expect(status.line()).toBe("good")
  status.trigger()
  await wait(900)
  expect(state.index).toBe(3)
  expect(status.line()).toBe("after")
}, 15_000)

test("a command that outlives the timeout is stopped together with what it started", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "status-line-kill-"))
  try {
    const marker = path.join(dir, "late.txt")
    // The marker is written after the point where the run gives up (2 s), by the shell itself: only a stopped tree
    // never gets there.
    const command = (pings: number, file: string) =>
      process.platform === "win32"
        ? `ping -n ${pings} 127.0.0.1 >nul & echo late> ${file}`
        : `sleep ${pings - 1}; echo late > '${file}'`
    // The control is the same command with a delay that ends before the timeout, so it is known to write its marker.
    const control = path.join(dir, "control.txt")
    createRoot((dispose) => {
      createStatusLine({ command: () => command(4, marker), interval: () => 60_000, payload: () => ({}) })
      createStatusLine({ command: () => command(1, control), interval: () => 60_000, payload: () => ({}) })
      setTimeout(dispose, 4_800)
    })
    await wait(5_000)
    expect(await Bun.file(control).exists()).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

test.skipIf(process.platform === "win32")("the status line command reads the session from stdin", async () => {
  const line = await new Promise<string | undefined>((resolve) =>
    createRoot((dispose) => {
      const value = createStatusLine({
        command: () => `cat | sed -E 's/.*"session_id":"([^"]+)".*/session \\1/'`,
        interval: () => 60_000,
        payload: () => ({ session_id: "ses_42" }),
      })
      const poll = setInterval(() => {
        if (!value.line()) return
        clearInterval(poll)
        resolve(value.line())
        dispose()
      }, 20)
    }),
  )
  expect(line).toBe("session ses_42")
})

test.skipIf(process.platform !== "win32")("the command head is not looked up in the working folder", async () => {
  // The agent shell may set the variable, which would make the test pass without testing anything.
  const saved = process.env.NoDefaultCurrentDirectoryInExePath
  delete process.env.NoDefaultCurrentDirectoryInExePath
  const dir = await mkdtemp(path.join(os.tmpdir(), "status-line-decoy-"))
  try {
    const marker = (name: string) => path.join(dir, name + ".txt")
    for (const name of ["statusdecoy", "controldecoy"])
      await Bun.write(path.join(dir, name + ".bat"), `@echo off\r\necho ran> "${marker(name)}"\r\n`)
    createRoot((dispose) => {
      // The control names the file explicitly, so the decoy is known to run when it is asked for.
      createStatusLine({ command: () => ".\\controldecoy", interval: () => 60_000, payload: () => ({}), cwd: dir })
      createStatusLine({ command: () => "statusdecoy", interval: () => 60_000, payload: () => ({}), cwd: dir })
      setTimeout(dispose, 1_500)
    })
    await wait(1_800)
    expect(await Bun.file(marker("controldecoy")).exists()).toBe(true)
    expect(await Bun.file(marker("statusdecoy")).exists()).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
    else process.env.NoDefaultCurrentDirectoryInExePath = saved
    await rm(dir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "win32")(
  "a cmd.exe and an .exe of the working folder are not run for the head",
  async () => {
    using _path = currentDirectoryOnPath()
    const dir = await mkdtemp(path.join(os.tmpdir(), "status-line-exe-"))
    try {
      // cmd.exe is the decoy for a bare "cmd", statusdecoy.exe for the head of the command.
      const ran = await plant(dir, "cmd", "statusdecoy")
      await new Promise<void>((resolve) =>
        createRoot((dispose) => {
          createStatusLine({ command: () => "statusdecoy", interval: () => 60_000, payload: () => ({}), cwd: dir })
          setTimeout(() => {
            dispose()
            resolve()
          }, 1_500)
        }),
      )
      expect(await ran()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test("the payload carries the new fields", () => {
  const payload = statusLinePayload({
    version: "1.2.3",
    session: {
      id: "ses_1",
      title: "Fix bug",
      cost: 0.42,
      created: 1_000,
      agent: "build",
    },
    model: { providerID: "acme", id: "m1", variant: "high" },
    cwd: "/work/app/src",
    projectDir: "/work/app",
    modelName: "Model One",
    agent: "build",
    outputStyle: "concise",
    context: { tokens: 5_000, percent: 5 },
    contextLimit: 100_000,
    lines: { added: 3, removed: 1 },
    running: true,
    vimMode: "normal",
    now: 4_000,
  })
  expect(payload).toEqual({
    version: "1.2.3",
    session: { id: "ses_1", title: "Fix bug" },
    cwd: "/work/app/src",
    project_dir: "/work/app",
    model: { provider: "acme", id: "m1", name: "Model One", variant: "high" },
    agent: "build",
    output_style: "concise",
    context: { used: 5_000, limit: 100_000, percent: 5 },
    cost: { usd: 0.42, duration_ms: 3_000, lines_added: 3, lines_removed: 1 },
    status: "running",
    vim_mode: "normal",
    session_id: "ses_1",
  })
})

test("the payload nulls unknown values, including the line counts", () => {
  const payload = statusLinePayload({ version: "1", running: true, now: 0 })
  expect(payload.status).toBe("running")
  expect(payload.session).toBeNull()
  expect(payload.model).toBeNull()
  expect(payload.context).toBeNull()
  expect(payload.vim_mode).toBeNull()
  expect(payload.cost.lines_added).toBeNull()
  expect(payload.cost.lines_removed).toBeNull()
  expect(statusLinePayload({ version: "1", running: false, now: 0 }).status).toBe("idle")
})
