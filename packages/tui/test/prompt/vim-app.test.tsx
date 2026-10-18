import { expect, test } from "bun:test"
import { type Renderable, TextareaRenderable } from "@opentui/core"
import { clearDrafts, takeDraft } from "../../src/component/prompt/draft-stash"
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
    fetch?: FetchHandler
    /** Watch a cli.json beside the state folder so that a test can switch prompt.vim off by a reload. */
    reload?: boolean
    /** Lines of the prompt history file to start with. */
    history?: string[]
  } = {},
) {
  clearDrafts()
  const state = await tmpdir()
  if (input.history) await Bun.write(`${state.path}/prompt-history.jsonl`, input.history.join(""))
  const config = {
    animations: false,
    cursor: { style: input.style ?? "line", blinking: false },
    prompt: { vim: input.vim ?? true },
    // On Linux ctrl+z would otherwise suspend the test process itself; here it must mean undo on every platform.
    keybinds: { "terminal.suspend": "none" },
  }
  const setup = await createAppFixture({
    state: state.path,
    configPath: input.reload ? `${state.path}/cli.json` : undefined,
    clipboard: input.clipboard,
    width: input.width ?? 120,
    fetch: input.fetch ?? server,
    args: input.session === false ? undefined : { sessionID },
    config,
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
    config,
    state: state.path,
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
  // Each app is disposed before the next mounts: two live apps on one session would hand each other their drafts.
  {
    const yanked = fakeClipboard()
    await using copy = await mount({ clipboard: yanked.service })
    await copy.type("ab")
    await copy.normal()
    await copy.type('"+yy')
    expect(yanked.written).toEqual(["ab\n"])
  }

  {
    const pasted = fakeClipboard("XY")
    await using paste = await mount({ clipboard: pasted.service })
    await paste.type("ab")
    await paste.normal()
    await paste.press("0")
    await paste.type('"+p')
    await Bun.sleep(50)
    await paste.setup.renderOnce()
    expect(paste.textarea().plainText).toBe("aXYb")
  }

  {
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
  }
}, 20_000)

test("the register survives a submit in the same prompt and is never written to the state folder", async () => {
  const prompts: string[] = []
  await using app = await mount({
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompts.push(((await request.json()) as { text?: string }).text ?? "")
        return json({ data: { id: "msg_x" } })
      }
      return server(url, request)
    },
  })
  await app.type("zebrafish tail")
  await app.normal()
  await app.press("0")
  await app.type("yw")
  app.setup.mockInput.pressEnter()
  await Bun.sleep(300)
  await app.setup.renderOnce()
  expect(prompts.length).toBe(1)
  expect(app.textarea().plainText).toBe("")
  await app.press("p")
  expect(app.textarea().plainText).toBe("zebrafish ")
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: app.state, onlyFiles: true, dot: true }))
  const holders = await Promise.all(
    files.map(async (file) =>
      (await Bun.file(`${app.state}/${file}`).text()).includes("zebrafish ") ? file : undefined,
    ),
  )
  // The submitted prompt may be kept as history; the yanked text with its trailing space is the register alone.
  expect(holders.filter((file) => file !== undefined && !file.includes("history"))).toEqual([])
})

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

// --- visual mode, dot-repeat and finds ---

const visual = "-- VISUAL --"
const visualLine = "-- VISUAL LINE --"

async function arrow(app: Awaited<ReturnType<typeof mount>>, direction: "left" | "right" | "up" | "down", shift = false) {
  app.setup.mockInput.pressArrow(direction, shift ? { shift: true } : undefined)
  await app.setup.renderOnce()
  await Bun.sleep(30)
  await app.setup.renderOnce()
}

test.each([40, 120])(
  "v and V show their labels at %d columns, Escape removes them, and the cursor is a block",
  async (width) => {
    await using app = await mount({ width })
    await app.type("abc")
    await app.normal()
    await app.press("v")
    let frame = app.setup.captureCharFrame()
    expect(frame).toContain(visual)
    expect(frame).not.toContain(visualLine)
    expect(app.textarea().cursorStyle.style).toBe("block")
    const row = frame.split("\n").find((line) => line.includes(visual)) ?? ""
    expect(row.trimEnd().length).toBeLessThanOrEqual(width)

    await app.press("V", { shift: true })
    frame = app.setup.captureCharFrame()
    expect(frame).toContain(visualLine)
    expect(app.textarea().cursorStyle.style).toBe("block")
    const lineRow = frame.split("\n").find((line) => line.includes(visualLine)) ?? ""
    expect(lineRow.trimEnd().length).toBeLessThanOrEqual(width)
    if (width === 40) expect(lineRow).toContain("…")

    await app.normal()
    frame = app.setup.captureCharFrame()
    expect(frame).not.toContain("-- VISUAL")
    expect(frame).not.toContain(label)
    await app.press("i")
    expect(app.setup.captureCharFrame()).toContain(label)
  },
)

test("the drawn selection is the textarea's own, follows o, covers whole wide characters and ends with Escape", async () => {
  await using app = await mount()
  await app.type("日本a👍b")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  const text = app.textarea()
  expect(text.getSelectedText()).toBe("日本")
  const before = text.getSelection()
  const head = text.cursorOffset
  await app.press("o")
  expect(text.getSelection()).toEqual(before)
  expect(text.getSelectedText()).toBe("日本")
  // The head is now the other end of the selection, and the drawn cursor is there.
  expect(text.cursorOffset).toBe(0)
  expect(text.cursorOffset).not.toBe(head)
  await app.press("o")
  await app.press("l")
  await app.press("l")
  expect(text.getSelectedText()).toBe("日本a👍")
  await app.normal()
  expect(text.hasSelection()).toBe(false)
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("Shift+Left moves the head in visual mode only; elsewhere it selects through the textarea as before", async () => {
  {
    await using app = await mount()
    await app.type("abcd")
    await app.normal()
    await app.press("v")
    await arrow(app, "left", true)
    expect(app.textarea().plainText).toBe("abcd")
    expect(app.textarea().getSelectedText()).toBe("cd")
    await arrow(app, "left", true)
    expect(app.textarea().getSelectedText()).toBe("bcd")
    expect(app.setup.captureCharFrame()).toContain(visual)
  }
  {
    await using app = await mount({ vim: false })
    await app.type("abcd")
    await arrow(app, "left", true)
    expect(app.textarea().getSelectedText()).toBe("d")
  }
  {
    await using app = await mount()
    await app.type("abcd")
    await arrow(app, "left", true)
    expect(app.textarea().getSelectedText()).toBe("d")
  }
  {
    await using app = await mount()
    await app.type("abcd")
    await app.normal()
    await arrow(app, "left", true)
    expect(app.textarea().getSelectedText()).toBe("cd")
    expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
  }
})

test("Escape in visual mode does not interrupt a running session; the next Escape does", async () => {
  await using app = await mount({ width: 220 })
  app.setup.events.emit({
    id: "evt_running_visual",
    created: 1,
    type: "session.execution.started",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID },
  } as never)
  await app.setup.waitForFrame((frame) => frame.includes("interrupt"))
  await app.type("abc")
  await app.normal()
  await app.press("v")
  await app.normal()
  expect(app.setup.captureCharFrame()).not.toContain("again to interrupt")
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
  expect(app.textarea().hasSelection()).toBe(false)
  await app.normal()
  await app.setup.waitForFrame((frame) => frame.includes("again to interrupt"))
})

test("Enter in visual mode submits and leaves no selection", async () => {
  const prompts: string[] = []
  await using app = await mount({
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompts.push(((await request.json()) as { text?: string }).text ?? "")
        return json({ data: { id: "msg_x" } })
      }
      return server(url, request)
    },
  })
  await app.type("send me")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  app.setup.mockInput.pressEnter()
  await Bun.sleep(300)
  await app.setup.renderOnce()
  expect(prompts).toEqual(["send me"])
  expect(app.textarea().hasSelection()).toBe(false)
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("a bracketed paste in visual mode ends the selection and pastes as in normal mode", async () => {
  await using app = await mount()
  await app.type("abcd")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  expect(app.textarea().getSelectedText()).toBe("ab")
  await app.setup.mockInput.pasteBracketedText("XY")
  await Bun.sleep(100)
  await app.setup.renderOnce()
  // Nothing is deleted: the selected "ab" survives, and the paste lands at the cursor.
  expect(app.textarea().plainText).toBe("aXYbcd")
  expect(app.textarea().hasSelection()).toBe(false)
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("Vjd is one undo step", async () => {
  await using app = await mount()
  for (const [index, text] of ["one", "two", "three"].entries()) {
    if (index > 0) await app.press("j", { ctrl: true })
    await app.type(text)
  }
  await app.normal()
  await app.press("g")
  await app.press("g")
  await app.press("V", { shift: true })
  await app.press("j")
  await app.press("d")
  expect(app.textarea().plainText).toBe("three")
  await app.press("u")
  expect(app.textarea().plainText).toBe("one\ntwo\nthree")
})

test("2dd then . deletes two more lines and one u brings them back", async () => {
  await using app = await mount()
  for (const [index, text] of ["a", "b", "c", "d", "e"].entries()) {
    if (index > 0) await app.press("j", { ctrl: true })
    await app.type(text)
  }
  await app.normal()
  await app.press("g")
  await app.press("g")
  await app.type("2dd")
  expect(app.textarea().plainText).toBe("c\nd\ne")
  await app.press(".")
  expect(app.textarea().plainText).toBe("e")
  await app.press("u")
  expect(app.textarea().plainText).toBe("c\nd\ne")
})

test("% jumps to the partner and f with ; repeats, typed with Shift as a terminal reports them", async () => {
  await using app = await mount()
  await app.type("(a-b-c)")
  await app.normal()
  await app.press("0")
  await app.press("%", { shift: true })
  expect(app.textarea().cursorOffset).toBe(6)
  await app.press("0")
  await app.press("f")
  await app.press("-")
  expect(app.textarea().cursorOffset).toBe(2)
  await app.press(";")
  expect(app.textarea().cursorOffset).toBe(4)
})

test("what was typed is repeated by . and a submit restarts the record; the last change is never written to disk", async () => {
  const prompts: string[] = []
  await using app = await mount({
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompts.push(((await request.json()) as { text?: string }).text ?? "")
        return json({ data: { id: "msg_x" } })
      }
      return server(url, request)
    },
  })
  await app.type("quokkasent")
  app.setup.mockInput.pressEnter()
  await Bun.sleep(300)
  await app.setup.renderOnce()
  expect(prompts).toEqual(["quokkasent"])
  await app.type("zebrafish")
  await app.normal()
  expect(app.textarea().plainText).toBe("zebrafish")
  await app.press(".")
  expect(app.textarea().plainText).toBe("zebrafiszebrafishh")
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: app.state, onlyFiles: true, dot: true }))
  const holders = await Promise.all(
    files.map(async (file) => ((await Bun.file(`${app.state}/${file}`).text()).includes("zebrafish") ? file : undefined)),
  )
  // The last change is in memory only, and the sent prompt is in the history file at most.
  expect(holders).toEqual([])
}, 20_000)

// --- visual routing: the keys the managed text-area layer would take ---

async function key(app: Awaited<ReturnType<typeof mount>>, send: () => void) {
  send()
  await app.setup.renderOnce()
  await Bun.sleep(30)
  await app.setup.renderOnce()
}

test("in visual mode Right moves the head through the engine and d deletes exactly the drawn selection", async () => {
  await using app = await mount()
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  await app.press("l")
  expect(app.textarea().getSelectedText()).toBe("abc")
  await arrow(app, "right")
  expect(app.textarea().getSelectedText()).toBe("abcd")
  expect(app.setup.captureCharFrame()).toContain(visual)
  await app.press("d")
  expect(app.textarea().plainText).toBe("ef")
})

test("in visual mode Shift+Left under V keeps the whole line selected", async () => {
  await using app = await mount()
  await app.type("two")
  await app.normal()
  await app.press("V", { shift: true })
  await arrow(app, "left", true)
  expect(app.textarea().getSelectedText()).toBe("two")
  expect(app.setup.captureCharFrame()).toContain(visualLine)
  await app.press("d")
  expect(app.textarea().plainText).toBe("")
})

test("in visual mode Backspace moves the head left and deletes nothing, and Delete is swallowed", async () => {
  await using app = await mount()
  await app.type("abcdef")
  await app.normal()
  await app.press("v")
  await app.press("h")
  await app.press("h")
  expect(app.textarea().getSelectedText()).toBe("def")
  await key(app, () => app.setup.mockInput.pressBackspace())
  expect(app.textarea().plainText).toBe("abcdef")
  expect(app.textarea().getSelectedText()).toBe("cdef")
  expect(app.setup.captureCharFrame()).toContain(visual)
  await key(app, () => app.setup.mockInput.pressKey("DELETE"))
  expect(app.textarea().plainText).toBe("abcdef")
  expect(app.textarea().getSelectedText()).toBe("cdef")
  expect(app.setup.captureCharFrame()).toContain(visual)
  await app.press("u")
  expect(app.textarea().plainText).toBe("abcdef")
})

// --- ends of visual mode and the typed record that the first round left unpinned ---

test("a mouse press in the prompt ends visual mode and the drawn selection", async () => {
  await using app = await mount()
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  expect(app.textarea().hasSelection()).toBe(true)
  const lines = app.setup.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes("abcdef"))
  await app.setup.mockMouse.click(lines[row].indexOf("abcdef") + 4, row)
  await app.setup.renderOnce()
  expect(app.textarea().hasSelection()).toBe(false)
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("switching prompt.vim off by a config reload ends visual mode", async () => {
  await using app = await mount({ reload: true })
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  expect(app.textarea().hasSelection()).toBe(true)
  app.config.prompt = { vim: false }
  await Bun.write(`${app.state}/cli.json`, "{}")
  const deadline = Date.now() + 5000
  while (app.textarea().hasSelection() && Date.now() < deadline) {
    await Bun.sleep(50)
    await app.setup.renderOnce()
  }
  expect(app.textarea().hasSelection()).toBe(false)
  await app.setup.renderOnce()
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("a Ctrl chord in visual mode ends the selection", async () => {
  await using app = await mount()
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  expect(app.textarea().hasSelection()).toBe(true)
  await app.press("q", { ctrl: true })
  expect(app.textarea().hasSelection()).toBe(false)
  expect(app.setup.captureCharFrame()).not.toContain("-- VISUAL")
})

test("recalling a history entry restarts the typed record, so . does not re-type what came before it", async () => {
  await using app = await mount({
    history: [JSON.stringify({ text: "deploy it", files: [], agents: [], skills: [], pasted: [], time: 1000 }) + "\n"],
  })
  await app.type("qq")
  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Search prompt history"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText("deploy")
  await app.setup.waitForFrame((frame) => frame.includes("deploy it"))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => frame.includes("› deploy it"))
  await app.normal()
  await app.press(".")
  expect(app.textarea().plainText).toBe("deploy it")
}, 20_000)

// --- visual routing, round two: Up and Down, and every key the text area binds ---

test("in visual mode Up and Down move the head through the engine on two lines", async () => {
  await using app = await mount()
  await app.type("one")
  await app.press("j", { ctrl: true })
  await app.type("two")
  await app.normal()
  await app.press("v")
  await arrow(app, "up")
  expect(app.textarea().getSelectedText()).toBe("e\ntwo")
  expect(app.setup.captureCharFrame()).toContain(visual)
  await arrow(app, "down")
  expect(app.textarea().getSelectedText()).toBe("o")
  expect(app.setup.captureCharFrame()).toContain(visual)
})

test("on one line Up and Down leave the label and the drawn selection in step, and d deletes what is drawn", async () => {
  for (const direction of ["up", "down"] as const) {
    await using app = await mount()
    await app.type("abcdef")
    await app.normal()
    await app.press("0")
    await app.press("v")
    await app.press("l")
    await arrow(app, direction)
    const drawn = app.textarea().getSelectedText()
    expect(drawn).not.toBe("")
    expect(app.setup.captureCharFrame()).toContain(visual)
    await app.press("d")
    expect(app.textarea().plainText).toBe("abcdef".replace(drawn, ""))
  }
})

type Modifiers = { ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean }

// Every key the text area binds by default, as pressKey spells it. In visual mode each one moves the head through the
// engine, is swallowed, or ends visual mode before the text area acts. Whichever it is, the label matches the drawn
// selection, and d deletes exactly what is drawn.
const inputKeys: Array<[string, string, Modifiers?]> = [
  ["left", "ARROW_LEFT"],
  ["right", "ARROW_RIGHT"],
  ["up", "ARROW_UP"],
  ["down", "ARROW_DOWN"],
  ["shift+left", "ARROW_LEFT", { shift: true }],
  ["shift+right", "ARROW_RIGHT", { shift: true }],
  ["shift+up", "ARROW_UP", { shift: true }],
  ["shift+down", "ARROW_DOWN", { shift: true }],
  ["home", "HOME"],
  ["end", "END"],
  ["shift+home", "HOME", { shift: true }],
  ["shift+end", "END", { shift: true }],
  ["backspace", "BACKSPACE"],
  ["shift+backspace", "BACKSPACE", { shift: true }],
  ["delete", "DELETE"],
  ["shift+delete", "DELETE", { shift: true }],
  ["ctrl+f", "f", { ctrl: true }],
  ["ctrl+a", "a", { ctrl: true }],
  ["ctrl+e", "e", { ctrl: true }],
  ["ctrl+d", "d", { ctrl: true }],
  ["ctrl+k", "k", { ctrl: true }],
  ["ctrl+u", "u", { ctrl: true }],
  ["ctrl+w", "w", { ctrl: true }],
  ["ctrl+z", "z", { ctrl: true }],
  ["ctrl+right", "ARROW_RIGHT", { ctrl: true }],
  ["ctrl+left", "ARROW_LEFT", { ctrl: true }],
  ["ctrl+backspace", "BACKSPACE", { ctrl: true }],
  ["ctrl+delete", "DELETE", { ctrl: true }],
  ["alt+f", "f", { meta: true }],
  ["alt+b", "b", { meta: true }],
  ["alt+d", "d", { meta: true }],
  ["alt+a", "a", { meta: true }],
  ["alt+e", "e", { meta: true }],
  ["alt+right", "ARROW_RIGHT", { meta: true }],
  ["alt+left", "ARROW_LEFT", { meta: true }],
  ["alt+backspace", "BACKSPACE", { meta: true }],
  ["alt+delete", "DELETE", { meta: true }],
  ["super+a", "a", { super: true }],
  ["super+z", "z", { super: true }],
]

// What each key does in visual mode: the engine moves the head (`move`), swallows the key (`swallow`), or ends visual
// mode and leaves the key to run as it would from a plain cursor (`pass`).
const swallowed = new Set([
  "home",
  "end",
  "shift+home",
  "shift+end",
  "delete",
  "shift+delete",
])
const outcome = (name: string, modifiers?: Modifiers) =>
  modifiers?.ctrl || modifiers?.meta || modifiers?.super ? "pass" : swallowed.has(name) ? "swallow" : "move"

test.each(inputKeys)(
  "in visual mode %s does what its row says, and d acts on exactly what is drawn",
  // Rest parameters: a third named parameter would be taken for a done callback in the rows that have two entries.
  async (...row) => {
    const [name, keyName, modifiers] = row
    const expected = outcome(name, modifiers)
    if (expected === "pass") {
      // The same key from the same plain cursor in normal mode: visual mode must end and then match it.
      const want = await (async () => {
        await using plain = await mount()
        await plain.type("abcdef")
        await plain.normal()
        await plain.press("0")
        await plain.press("l")
        await key(plain, () => plain.setup.mockInput.pressKey(keyName, modifiers))
        return { text: plain.textarea().plainText, cursor: plain.textarea().cursorOffset, selected: plain.textarea().getSelectedText() }
      })()
      await using app = await mount()
      await app.type("abcdef")
      await app.normal()
      await app.press("0")
      await app.press("v")
      await app.press("l")
      expect(app.textarea().getSelectedText()).toBe("ab")
      await key(app, () => app.setup.mockInput.pressKey(keyName, modifiers))
      expect(app.setup.captureCharFrame()).not.toContain(visual)
      expect(app.textarea().getSelectedText()).toBe(want.selected)
      expect(app.textarea().plainText).toBe(want.text)
      expect(app.textarea().cursorOffset).toBe(want.cursor)
      return
    }
    await using app = await mount()
    await app.type("abcdef")
    await app.normal()
    await app.press("0")
    await app.press("v")
    await app.press("l")
    expect(app.textarea().getSelectedText()).toBe("ab")
    await key(app, () => app.setup.mockInput.pressKey(keyName, modifiers))
    const text = app.textarea()
    expect(app.setup.captureCharFrame()).toContain(visual)
    expect(text.plainText).toBe("abcdef")
    if (expected === "swallow") expect(text.getSelectedText()).toBe("ab")
    const drawn = text.getSelectedText()
    expect(drawn).not.toBe("")
    await app.press("d")
    expect(text.plainText).toBe("abcdef".replace(drawn, ""))
  },
)

test("in visual mode Ctrl+V ends the selection and pastes at the head", async () => {
  const board = fakeClipboard("XY")
  await using app = await mount({ clipboard: board.service })
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  await key(app, () => app.setup.mockInput.pressKey("v", { ctrl: true }))
  await Bun.sleep(80)
  await app.setup.renderOnce()
  expect(app.setup.captureCharFrame()).not.toContain(visual)
  expect(app.textarea().hasSelection()).toBe(false)
  expect(app.textarea().plainText).toContain("XY")
})

test("in visual mode a key meant for something else that holds focus does not reach vim", async () => {
  await using app = await mount()
  await app.type("abcdef")
  await app.normal()
  await app.press("0")
  await app.press("v")
  await app.press("l")
  expect(app.textarea().getSelectedText()).toBe("ab")
  // A dialog (such as the working directory menu) blurs the text area; its keys belong to the dialog.
  app.textarea().blur()
  await app.setup.renderOnce()
  await key(app, () => app.setup.mockInput.pressEscape())
  await Bun.sleep(80)
  await app.setup.renderOnce()
  expect(app.setup.captureCharFrame()).toContain(visual)
  expect(app.textarea().getSelectedText()).toBe("ab")
})
