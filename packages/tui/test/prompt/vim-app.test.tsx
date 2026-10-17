import { expect, test } from "bun:test"
import { type Renderable, TextareaRenderable } from "@opentui/core"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture, promptReady } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json, type FetchHandler } from "../fixture/tui-client"

// The prompt with prompt.vim on, drawn in the whole app.
const sessionID = "ses_vim"
const location = { directory, project: { id: "project", directory, canonical: directory } }
const modelName = "an-extremely-long-model-name-for-the-vim-label-test"

const server: FetchHandler = async (url) => {
  if (url.pathname === `/api/session/${sessionID}`)
    return json({
      data: {
        id: sessionID,
        projectID: "project",
        title: "Vim fixture",
        agent: "build",
        model: { providerID: "demo", id: "model" },
        location: { directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
      },
    })
  if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
  if (url.pathname === "/api/agent")
    return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
  if (url.pathname === "/api/model")
    return json({ location, data: [{ id: "model", providerID: "demo", name: modelName, variants: [] }] })
}

// A clipboard the test controls: `read` waits for whatever the test releases, `written` holds what the app wrote.
function fakeClipboard(text?: string) {
  const written: string[] = []
  const gate = Promise.withResolvers<void>()
  const state = { held: false, reads: 0 }
  return {
    written,
    state,
    release: () => gate.resolve(),
    service: {
      async read() {
        state.reads++
        if (state.held) await gate.promise
        return text === undefined ? undefined : { data: text, mime: "text/plain" }
      },
      async write(value: string) {
        written.push(value)
      },
      async dispose() {},
    },
  }
}

async function mount(
  input: {
    vim?: boolean
    width?: number
    session?: boolean
    style?: "line" | "block"
    clipboard?: ReturnType<typeof fakeClipboard>["service"]
  } = {},
) {
  takeDraft(undefined)
  const state = await tmpdir()
  const setup = await createAppFixture({
    state: state.path,
    clipboard: input.clipboard,
    width: input.width ?? 120,
    fetch: server,
    args: input.session === false ? undefined : { sessionID },
    config: {
      animations: false,
      cursor: { style: input.style ?? "line", blinking: false },
      prompt: { vim: input.vim ?? true },
    },
  })
  await setup.ready
  // A narrow terminal drops the commands hint that promptReady looks for.
  await setup.waitForFrame((frame) => (input.width && input.width < 60 ? frame.includes("›") : promptReady(frame)))
  const textarea = () => {
    const find = (node: Renderable): TextareaRenderable | undefined =>
      node instanceof TextareaRenderable
        ? node
        : node
            .getChildren()
            .map((child) => find(child))
            .find((found) => found !== undefined)
    const found = find(setup.renderer.root)
    if (!found) throw new Error("no textarea")
    return found
  }
  return {
    setup,
    textarea,
    async press(key: string, modifiers?: { ctrl?: boolean; shift?: boolean }) {
      setup.mockInput.pressKey(key, modifiers)
      await setup.renderOnce()
      await Bun.sleep(30)
      await setup.renderOnce()
    },
    async type(text: string) {
      for (const char of text) await this.press(char, char !== char.toLowerCase() ? { shift: true } : undefined)
    },
    async normal() {
      setup.mockInput.pressEscape()
      await setup.renderOnce()
      await Bun.sleep(80)
      await setup.renderOnce()
    },
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

const label = "-- INSERT --"

test("the insert label shows in insert mode, the cursor is a block in normal mode, and the label comes back on i", async () => {
  await using app = await mount()
  expect(app.setup.captureCharFrame()).toContain(label)
  expect(app.textarea().cursorStyle.style).toBe("line")

  await app.normal()
  expect(app.setup.captureCharFrame()).not.toContain(label)
  expect(app.textarea().cursorStyle.style).toBe("block")

  await app.press("i")
  expect(app.setup.captureCharFrame()).toContain(label)
  expect(app.textarea().cursorStyle.style).toBe("line")
})

test("the label never shows with prompt.vim off", async () => {
  await using app = await mount({ vim: false })
  await app.type("hi")
  expect(app.setup.captureCharFrame()).not.toContain(label)
  expect(app.setup.captureCharFrame()).toContain("› hi")
})

test("the label is hidden in shell mode", async () => {
  await using app = await mount()
  await app.press("!")
  await app.setup.waitForFrame((frame) => frame.includes("exit shell mode"))
  expect(app.setup.captureCharFrame()).not.toContain(label)
})

test.each([40, 120])("the label stays whole at %d columns and the model name truncates instead", async (width) => {
  await using app = await mount({ width })
  await app.setup.waitForFrame((frame) => frame.includes(label) && frame.includes("an-extremely"))
  const frame = app.setup.captureCharFrame()
  const row = frame.split("\n").find((line) => line.includes(label)) ?? ""
  // The row stays inside the terminal and the model is cut with an ellipsis, not the label.
  expect(row.trimEnd().length).toBeLessThanOrEqual(width)
  expect(row).toContain(label)
  if (width === 40) expect(row).toContain("…")
  else expect(frame).toContain(modelName)
})

test("a wide character moves and deletes by whole characters, and the drawn cursor follows", async () => {
  await using app = await mount()
  await app.type("日本語 abc")
  await app.normal()
  await app.press("0")
  const start = app.setup.renderer.getCursorState().x
  await app.press("w")
  // Three wide characters take six cells, and the space one more.
  expect(app.setup.renderer.getCursorState().x).toBe(start + 7)
  await app.press("0")
  await app.press("x")
  expect(app.setup.captureCharFrame()).toContain("本語 abc")
  expect(app.setup.captureCharFrame()).not.toContain("日")
  expect(app.textarea().plainText).toBe("本語 abc")
})

test("3dd then u brings back all three lines with one u", async () => {
  await using app = await mount()
  for (const [index, text] of ["one", "two", "three", "four"].entries()) {
    if (index > 0) await app.press("j", { ctrl: true })
    await app.type(text)
  }
  expect(app.textarea().plainText).toBe("one\ntwo\nthree\nfour")
  await app.normal()
  await app.press("g")
  await app.press("g")
  await app.type("3dd")
  expect(app.textarea().plainText).toBe("four")
  await app.press("u")
  expect(app.textarea().plainText).toBe("one\ntwo\nthree\nfour")
})

test("a change command is one undo step even though it deletes and inserts", async () => {
  await using app = await mount()
  await app.type("foo bar")
  await app.normal()
  await app.press("0")
  await app.type("cwxyz")
  await app.normal()
  expect(app.textarea().plainText).toBe("xyz bar")
  // r replaces a character: a delete followed by an insert natively.
  await app.press("0")
  await app.type("rq")
  expect(app.textarea().plainText).toBe("qyz bar")
  await app.press("u")
  expect(app.textarea().plainText).toBe("xyz bar")
})

test('"+yy writes the line to the clipboard, "+p pastes what it reads, and a read that outlives an edit pastes nothing', async () => {
  const yanked = fakeClipboard()
  await using copy = await mount({ clipboard: yanked.service })
  await copy.type("ab")
  await copy.normal()
  await copy.type('"+yy')
  expect(yanked.written).toEqual(["ab\n"])

  const pasted = fakeClipboard("XY")
  await using paste = await mount({ clipboard: pasted.service })
  await paste.type("ab")
  await paste.normal()
  await paste.press("0")
  await paste.type('"+p')
  await Bun.sleep(50)
  await paste.setup.renderOnce()
  expect(paste.textarea().plainText).toBe("aXYb")

  const late = fakeClipboard("XY")
  late.state.held = true
  await using stale = await mount({ clipboard: late.service })
  await stale.type("ab")
  await stale.normal()
  await stale.press("0")
  await stale.type('"+p')
  await stale.press("x")
  late.release()
  await Bun.sleep(50)
  await stale.setup.renderOnce()
  expect(late.state.reads).toBe(1)
  expect(stale.textarea().plainText).toBe("b")
}, 20_000)

test("Escape at the start of a line stays there", async () => {
  await using app = await mount()
  await app.type("ab")
  await app.press("j", { ctrl: true })
  await app.normal()
  expect(app.textarea().plainText).toBe("ab\n")
  expect(app.textarea().cursorOffset).toBe(3)
})

test("the paste of a register lands as one command", async () => {
  await using app = await mount()
  await app.type("hello")
  await app.normal()
  await app.press("0")
  await app.type("yw")
  await app.press("$")
  await app.press("p")
  expect(app.textarea().plainText).toBe("hellohello")
})

test("Escape in normal mode reaches the interrupt of a running session; in insert mode it only leaves insert mode", async () => {
  // Wide enough that the long model name leaves room for the interrupt hint.
  await using app = await mount({ width: 220 })
  app.setup.events.emit({
    id: "evt_running",
    created: 1,
    type: "session.execution.started",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID },
  } as never)
  await app.setup.waitForFrame((frame) => frame.includes("interrupt"))
  // Insert mode: Escape switches to normal mode and does not arm the interrupt.
  await app.normal()
  expect(app.setup.captureCharFrame()).not.toContain("again to interrupt")
  expect(app.setup.captureCharFrame()).not.toContain(label)
  // Normal mode: the same key arms it.
  await app.normal()
  await app.setup.waitForFrame((frame) => frame.includes("again to interrupt"))
})

test("a half-typed count is cleared by Escape", async () => {
  await using app = await mount()
  await app.type("abc def")
  await app.normal()
  await app.press("0")
  await app.type("2d")
  await app.normal()
  await app.press("w")
  expect(app.textarea().plainText).toBe("abc def")
  expect(app.textarea().cursorOffset).toBe(4)
})

test("Enter submits from normal mode and normal mode stays for the next prompt", async () => {
  await using state = await tmpdir()
  const prompts: string[] = []
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompts.push(((await request.json()) as { text?: string }).text ?? "")
        return json({ data: { id: "msg_x" } })
      }
      return server(url, request)
    },
    args: { sessionID },
    width: 120,
    config: { animations: false, prompt: { vim: true } },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("›"))
  takeDraft(undefined)
  await setup.mockInput.typeText("ship it")
  setup.mockInput.pressEscape()
  await Bun.sleep(80)
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(prompts).toEqual(["ship it"])
  expect(setup.captureCharFrame()).not.toContain(label)
})
