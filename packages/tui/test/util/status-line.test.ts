import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRoot } from "solid-js"
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
  await wait(50)
  expect(test.calls.length).toBe(2)
  test.gate.release.shift()?.()
  await wait(400)
  expect(test.calls.length).toBe(2)
  test.dispose()
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

test("a real command that hangs is killed and leaves no line", async () => {
  const status = createRoot(() =>
    createStatusLine({
      command: () => (process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30"),
      interval: () => 60_000,
      payload: () => ({}),
    }),
  )
  await wait(2_800)
  expect(status.line()).toBeUndefined()
}, 10_000)

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
  delete process.env.NoDefaultCurrentDirectoryInExePath
  const dir = await mkdtemp(path.join(os.tmpdir(), "status-line-decoy-"))
  const marker = path.join(dir, "ran.txt")
  await Bun.write(path.join(dir, "statusdecoy.bat"), `@echo off\r\necho ran> "${marker}"\r\n`)
  createRoot((dispose) => {
    createStatusLine({ command: () => "statusdecoy", interval: () => 60_000, payload: () => ({}), cwd: dir })
    setTimeout(dispose, 1_500)
  })
  await wait(1_800)
  expect(await Bun.file(marker).exists()).toBe(false)
  await rm(dir, { recursive: true, force: true })
})

test("the payload carries the new fields", () => {
  const payload = statusLinePayload({
    version: "1.2.3",
    session: {
      id: "ses_1",
      title: "Fix bug",
      cost: 0.42,
      created: 1_000,
      model: { providerID: "acme", id: "m1", variant: "high" },
      agent: "build",
    },
    cwd: "/work/app/src",
    projectDir: "/work/app",
    modelName: "Model One",
    agent: "build",
    outputStyle: "concise",
    context: { tokens: 5_000, percent: 5 },
    contextLimit: 100_000,
    lines: { added: 3, removed: 1 },
    permissionsPending: 0,
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

test("the payload status is waiting while a permission is pending and nulls fill unknown values", () => {
  const payload = statusLinePayload({ version: "1", permissionsPending: 2, running: true, now: 0 })
  expect(payload.status).toBe("waiting")
  expect(payload.session).toBeNull()
  expect(payload.model).toBeNull()
  expect(payload.context).toBeNull()
  expect(payload.vim_mode).toBeNull()
  expect(statusLinePayload({ version: "1", permissionsPending: 0, running: false, now: 0 }).status).toBe("idle")
})
