// clients-ux-37 part 2: the next-prompt suggestion in the terminal UI. With prompt.suggestions on in the person's own
// cli.json, a turn of the session in view that ends well asks the server for what the person might type next, and the
// answer is drawn as dimmed text in the empty prompt. Tab or Right takes it into the input, and Enter sends it. The
// suggestion is model text, so what is drawn, taken and sent is its escaped form (class 9), and a key never takes a
// suggestion that is not on screen at that moment (class 8).
import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { OrbitEvent } from "@orbit/client"
import { plain } from "@orbit/util/plain"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const sessionID = "ses_suggest"
const childID = "ses_suggest_child"
const location = { directory, project: { id: "project", directory, canonical: directory } }
const suggestion = "run the tests"

type Answer = (request: Request) => Response | Promise<Response>

async function mount(
  input: {
    /** prompt.suggestions in cli.json; left out when undefined. */
    suggestions?: boolean
    /** What the suggestion route answers; the default is the plain control text. */
    answer?: Answer
    /** Whether the trust route calls a folder trusted, or fails to answer; the default trusts every folder. */
    trusted?: (directory: string | null) => boolean | "fails"
    /** The folder of the session in view; the default is the folder the terminal UI started in. */
    sessionDirectory?: string
    /** Makes the session in view a subagent's session under this parent. */
    parentID?: string
    /** Opens a subagent's session of the root, on this folder, rather than the root itself. */
    child?: { directory: string }
    width?: number
    /** cli.json's plugins. */
    plugins?: string[]
  } = {},
) {
  const state = await tmpdir()
  const requests: Request[] = []
  const prompts: Array<{ text: string; files?: unknown[] }> = []
  const shells: string[] = []
  // The bodies of the session updates the client sends, such as a title to set or regenerate.
  const updates: unknown[] = []
  const trustReads: string[] = []
  // The sessions the server reports running when the client reconnects.
  const running = new Set<string>()
  const sessionDirectory = input.sessionDirectory ?? directory
  const session = {
    id: sessionID,
    projectID: "project",
    title: "Suggest fixture",
    ...(input.parentID ? { parentID: input.parentID } : {}),
    agent: "build",
    model: { providerID: "demo", id: "model" },
    location: { directory: sessionDirectory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const child = input.child
    ? { ...session, id: childID, title: "Suggest child", parentID: sessionID, location: input.child }
    : undefined
  const setup = await createAppFixture({
    state: state.path,
    width: input.width ?? 100,
    config: {
      animations: false,
      keybinds: { "terminal.suspend": "none" },
      ...(input.suggestions === undefined ? {} : { prompt: { suggestions: input.suggestions } }),
      ...(input.plugins ? { plugins: input.plugins } : {}),
    },
    args: { sessionID: child ? childID : sessionID },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location/trust" && request.method === "GET") {
        const folder = url.searchParams.get("location[directory]")
        if (folder) trustReads.push(folder)
        const trusted = input.trusted?.(folder) ?? true
        if (trusted === "fails") return new Response("unavailable", { status: 500 })
        return json({
          directory: folder ?? directory,
          trusted,
          persistent: true,
          ...(trusted ? { source: "saved" } : {}),
          withheld: [],
        })
      }
      if (request.method === "PATCH" && url.pathname === `/api/session/${sessionID}`) {
        updates.push(await request.json())
        return json({ data: session })
      }
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (child && url.pathname === `/api/session/${childID}`) return json({ data: child })
      if (input.parentID && url.pathname === `/api/session/${input.parentID}`)
        return json({ data: { ...session, id: input.parentID, parentID: undefined } })
      if (url.pathname === "/api/session/active")
        return json({ data: Object.fromEntries([...running].map((id) => [id, { type: "busy" }])) })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            { id: "build", mode: "primary", hidden: false, permissions: [] },
            { id: "plan", mode: "primary", hidden: false, permissions: [] },
          ],
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/agent`)
        return new Response(null, { status: 204 })
      if (request.method === "POST" && /^\/api\/session\/[^/]+\/assist\/suggestion$/.test(url.pathname)) {
        requests.push(request)
        return input.answer ? input.answer(request) : json({ data: { suggestion } })
      }
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/prompt`) {
        const body = await request.json()
        prompts.push(body)
        return json({
          data: {
            id: body.id,
            sessionID,
            type: "user",
            time: { created: 10 },
            payload: { text: body.text },
            delivery: "steer",
          },
        })
      }
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/shell`) {
        shells.push((await request.json()).command)
        return json({ data: {} })
      }
      return undefined
    },
  })
  await setup.ready
  // The folders of the session in view and of its root have been asked about, so a turn's end is judged on the answers.
  await until(() => trustReads.includes(sessionDirectory) && (!child || trustReads.includes(child.location.directory)))
  await Bun.sleep(150)
  await setup.renderOnce()
  let seq = 100
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
    requests,
    prompts,
    shells,
    updates,
    textarea,
    frame: () => setup.captureCharFrame(),
    /** Reconnects with the session reported running, which sets its status without a started event. */
    reconnect() {
      running.add(sessionID)
      seq++
      setup.events.emit({
        id: `evt_connected_${seq}`,
        created: Date.now(),
        type: "server.connected",
        data: {},
      } as never)
    },
    execution(
      type:
        | "session.execution.started"
        | "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted",
      id = sessionID,
    ) {
      seq++
      setup.events.emit({
        id: `evt_execution_${seq}`,
        created: Date.now(),
        type,
        durable: { aggregateID: id, seq, version: 1 },
        data:
          type === "session.execution.failed"
            ? { sessionID: id, error: { type: "provider", message: "The provider is unavailable" } }
            : type === "session.execution.interrupted"
              ? { sessionID: id, reason: "user" }
              : { sessionID: id },
        location: { directory: sessionDirectory },
      } as OrbitEvent)
    },
    /** Sends an event of the root session that carries `data`. */
    emit(type: string, data: Record<string, unknown>) {
      seq++
      setup.events.emit({
        id: `evt_session_${seq}`,
        created: Date.now(),
        type,
        durable: { aggregateID: sessionID, seq, version: 1 },
        data: { sessionID, ...data },
      } as never)
    },
    async press(
      key: "TAB" | "ARROW_RIGHT" | "ARROW_LEFT" | "ARROW_UP" | "BACKSPACE" | "ESCAPE" | "F6" | "x",
      modifiers?: { ctrl?: boolean; shift?: boolean },
    ) {
      setup.mockInput.pressKey(key, modifiers)
      await settle()
    },
    async type(text: string) {
      await setup.mockInput.typeText(text)
      await settle()
    },
    async enter() {
      const sent = prompts.length + shells.length
      const before = textarea().plainText
      setup.mockInput.pressEnter()
      // Enter submits after two deferred turns of the event loop, which take longer on a loaded machine: wait for the
      // prompt to reach the server or the input to be filled, and for a second when Enter is meant to do neither.
      await Bun.sleep(80)
      await until(() => {
        const text = textarea().plainText
        return prompts.length + shells.length > sent || (text !== before && text !== "")
      }, 1000)
      await settle()
    },
    async shows(text: string) {
      return until(() => setup.captureCharFrame().includes(text))
    },
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }

  async function settle() {
    await setup.renderOnce()
    await Bun.sleep(30)
    await setup.renderOnce()
  }

  async function until(check: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) {
      await Bun.sleep(10)
      await setup.renderOnce()
    }
    return check()
  }
}

type App = Awaited<ReturnType<typeof mount>>

/** Ends a turn of the session in view well and waits for the ghost text to be drawn. */
async function ghost(app: App, text = plain(suggestion)) {
  app.execution("session.execution.succeeded")
  expect(await app.shows(text)).toBe(true)
}

async function quiet(app: App, ms = 300) {
  await Bun.sleep(ms)
  await app.setup.renderOnce()
}

/**
 * Waits for a turn's end to be judged and returns how many asks reached the server: the quiet time, which a row that
 * expects none relies on, and for a row that expects some, until they arrive, which takes longer on a loaded machine.
 */
async function asked(app: App, count: number, ms = 400) {
  await quiet(app, ms)
  const deadline = Date.now() + 3000
  while (app.requests.length < count && Date.now() < deadline) await quiet(app, 10)
  return app.requests.length
}

// Every spelling a model could be steered into writing, each with what `plain` makes of it, and the plain control.
const spellings = [
  { name: "plain text", text: "run the tests" },
  { name: "CSI", text: "\x1b[2Jrun the tests" },
  { name: "OSC with BEL", text: "\x1b]0;owned\x07run the tests" },
  { name: "U+009B", text: "\u009b2Jrun the tests" },
  { name: "U+202E", text: "run the ‮tests" },
  { name: "U+200B", text: "run​ the tests" },
  { name: "CR", text: "run the tests\rrm -rf ~" },
  { name: "LF", text: "run the tests\nrm -rf ~" },
]
const raw = /[\x00-\x08\x0b-\x1f\x7f-\x9f​‮]/

test.each([
  { value: undefined, count: 0 },
  { value: false, count: 0 },
  { value: true, count: 1 },
])("prompt.suggestions $value asks $count times at a turn's end", async ({ value, count }) => {
  await using app = await mount({ suggestions: value })
  app.execution("session.execution.succeeded")
  expect(await asked(app, count)).toBe(count)
  if (count) expect(new URL(app.requests[0]!.url).pathname).toBe(`/api/session/${sessionID}/assist/suggestion`)
})

test("a session whose folder is not trusted is never asked", async () => {
  const elsewhere = "/tmp/elsewhere"
  const rows = [
    { name: "the folder in view is not trusted", trusted: () => false, sessionDirectory: directory, count: 0 },
    // The session's own folder decides, not the folder the terminal UI started in (class 3).
    {
      name: "the start folder is trusted and the session's own folder is not",
      trusted: (folder: string | null) => folder !== elsewhere,
      sessionDirectory: elsewhere,
      count: 0,
    },
    // A trust read that fails says nothing about the folder, so it is not taken as trusted (class 7).
    {
      name: "the session's own folder could not be read",
      trusted: (folder: string | null) => (folder === elsewhere ? ("fails" as const) : true),
      sessionDirectory: elsewhere,
      count: 0,
    },
    { name: "control: the session's folder is trusted", trusted: () => true, sessionDirectory: elsewhere, count: 1 },
  ]
  for (const row of rows) {
    await using app = await mount({ suggestions: true, trusted: row.trusted, sessionDirectory: row.sessionDirectory })
    app.execution("session.execution.succeeded")
    expect({ name: row.name, count: await asked(app, row.count) }).toEqual({ name: row.name, count: row.count })
  }
})

test("only a succeeded turn of the session in view asks", async () => {
  const rows = [
    { name: "failed", type: "session.execution.failed" as const, id: sessionID, count: 0 },
    { name: "interrupted", type: "session.execution.interrupted" as const, id: sessionID, count: 0 },
    { name: "another session", type: "session.execution.succeeded" as const, id: "ses_other", count: 0 },
    { name: "a subagent's session", type: "session.execution.succeeded" as const, id: childID, count: 0 },
    {
      name: "a subagent's session in view",
      type: "session.execution.succeeded" as const,
      id: sessionID,
      parentID: "ses_suggest_parent",
      count: 0,
    },
    { name: "the session in view", type: "session.execution.succeeded" as const, id: sessionID, count: 1 },
  ]
  for (const row of rows) {
    await using app = await mount({ suggestions: true, parentID: row.parentID })
    app.execution(row.type, row.id)
    expect({ name: row.name, count: await asked(app, row.count) }).toEqual({ name: row.name, count: row.count })
  }
})

test("the root's turn ending while its subagent's session is in view asks, and the root shows the answer", async () => {
  const elsewhere = "/tmp/elsewhere"
  // The root's own folder decides, not the folder of the subagent's session in view (class 3).
  const rows = [
    { name: "the root's folder is not trusted", trusted: (folder: string | null) => folder !== elsewhere, count: 0 },
    { name: "control: the root's folder is trusted", trusted: () => true, count: 1 },
  ]
  for (const row of rows) {
    await using app = await mount({
      suggestions: true,
      trusted: row.trusted,
      sessionDirectory: elsewhere,
      child: { directory },
    })
    expect(app.frame()).toContain("Suggest child")
    app.execution("session.execution.succeeded")
    expect({ name: row.name, count: await asked(app, row.count) }).toEqual({ name: row.name, count: row.count })
    if (!row.count) continue
    expect(app.frame()).not.toContain(suggestion)
    // Esc closes the subagent's panel, and Up goes to the root.
    await app.press("ESCAPE")
    await app.press("ARROW_UP")
    expect(await app.shows(suggestion)).toBe(true)
    expect(app.frame()).not.toContain("Suggest child")
  }
})

test.each(spellings)("a suggestion is drawn escaped: $name", async ({ text }) => {
  await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: text } }) })
  await ghost(app, plain(text))
  expect(app.frame()).not.toMatch(raw)
  expect(app.textarea().plainText).toBe("")
})

test("the suggestion's keys leave the text area under the runtime's listener limit, so no leak warning is printed", async () => {
  await using app = await mount({ suggestions: true })
  await ghost(app)
  // Every key layer on the text area listens for its end; past the limit the runtime prints a warning over the screen.
  expect(app.textarea().listenerCount("destroyed")).toBeLessThanOrEqual(app.textarea().getMaxListeners())
})

const keys = [
  { key: "Tab", press: (app: App) => app.press("TAB") },
  { key: "Right", press: (app: App) => app.press("ARROW_RIGHT") },
  { key: "Enter", press: (app: App) => app.enter() },
]

test.each(keys.flatMap((key) => spellings.map((spelling) => ({ ...key, ...spelling }))))(
  "$key takes the drawn text: $name",
  async ({ key, press, text }) => {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: text } }) })
    await ghost(app, plain(text))
    await press(app)
    if (key === "Enter") {
      expect(app.prompts.map((prompt) => prompt.text)).toEqual([plain(text)])
      expect(app.shells).toEqual([])
      return
    }
    expect(app.textarea().plainText).toBe(plain(text))
    expect(app.prompts).toEqual([])
  },
)

test("a ghost cut to the row is filled by Enter, not sent", async () => {
  const long = "please run every test in the package again and then tell me about each failure you find"
  expect(long.length).toBeGreaterThanOrEqual(85)
  await using app = await mount({ suggestions: true, width: 40, answer: () => json({ data: { suggestion: long } }) })
  await ghost(app, "please run every")
  expect(app.frame()).not.toContain("each failure you find")
  await app.enter()
  expect(app.prompts).toEqual([])
  expect(app.textarea().plainText).toBe(long)
  await app.enter()
  expect(app.prompts.map((prompt) => prompt.text)).toEqual([long])
})

// The prompt's right padding is narrower below 44 columns, so both sides of that line are drawn.
test.each([{ terminal: 40 }, { terminal: 100 }])(
  "Enter sends a suggestion only when the whole of it fits the input row ($terminal columns)",
  async ({ terminal }) => {
    // The row's width as drawn: the longest start of a long suggestion that the frame shows.
    const digits = "0123456789".repeat(20)
    const width = await (async () => {
      await using app = await mount({
        suggestions: true,
        width: terminal,
        answer: () => json({ data: { suggestion: digits } }),
      })
      await ghost(app, "0123456789")
      const frame = app.frame()
      const shown = [...digits]
        .map((_, index) => digits.length - index)
        .find((length) => frame.includes(digits.slice(0, length)))
      // The ghost is cut where the input's own text area ends, not before it.
      expect(shown).toBe(app.textarea().width)
      return shown!
    })()
    expect(width).toBeLessThan(terminal)
    // A suggestion that fills the row is sent; one a cell wider is put in the input to be read first.
    for (const row of [
      { length: width, sent: true },
      { length: width + 1, sent: false },
    ]) {
      const text = digits.slice(0, row.length)
      await using app = await mount({
        suggestions: true,
        width: terminal,
        answer: () => json({ data: { suggestion: text } }),
      })
      await ghost(app, digits.slice(0, width))
      await app.enter()
      expect({ length: row.length, sent: app.prompts.map((prompt) => prompt.text) }).toEqual({
        length: row.length,
        sent: row.sent ? [text] : [],
      })
      if (!row.sent) expect(app.textarea().plainText).toBe(text)
    }
  },
)

test.each([
  { name: "a space in the input, then Enter", case: "space" as const },
  { name: "shell mode after !, then Enter", case: "shell" as const },
  { name: "a running turn, then Tab", case: "tab" as const },
  { name: "a running turn, then Right", case: "right" as const },
  { name: "a running turn, then Enter", case: "enter" as const },
  { name: "a turn found running on reconnect, then Tab", case: "reconnect" as const },
])("nothing hidden is taken: $name", async (row) => {
  await using app = await mount({ suggestions: true })
  await ghost(app)
  if (row.case === "space") await app.type(" ")
  if (row.case === "shell") await app.type("!")
  if (row.case === "tab" || row.case === "right" || row.case === "enter") {
    app.execution("session.execution.started")
    await quiet(app, 100)
  }
  if (row.case === "reconnect") {
    app.reconnect()
    await quiet(app)
  }
  expect(app.frame()).not.toContain(suggestion)
  const before = app.textarea().plainText
  if (row.case === "tab" || row.case === "reconnect") await app.press("TAB")
  else if (row.case === "right") await app.press("ARROW_RIGHT")
  else await app.enter()
  await quiet(app, 150)
  expect(app.prompts.filter((prompt) => prompt.text.includes(suggestion))).toEqual([])
  expect(app.shells).toEqual([])
  expect(app.textarea().plainText).toBe(before)
})

test("Enter on a suggestion that is a slash command runs the command, as typing it would", async () => {
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "/help" } }) })
    await ghost(app, "/help")
    app.setup.mockInput.pressEnter()
    expect(await app.shows("available actions and commands")).toBe(true)
    await quiet(app)
    expect(app.prompts).toEqual([])
    expect(app.textarea().plainText).toBe("")
  }
  // A command that takes no argument, followed by words, is text, as it is when typed.
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "/help me" } }) })
    await ghost(app, "/help me")
    await app.enter()
    expect(app.prompts.map((prompt) => prompt.text)).toEqual(["/help me"])
    expect(app.frame()).not.toContain("available actions and commands")
  }
  // A command named by one of its aliases runs as well: /config opens the settings, as /settings does.
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "/config" } }) })
    await ghost(app, "/config")
    app.setup.mockInput.pressEnter()
    expect(await app.shows("Settings")).toBe(true)
    await quiet(app)
    expect(app.prompts).toEqual([])
    expect(app.textarea().plainText).toBe("")
  }
  // A command that takes an argument, named alone, runs with an empty one, as Enter on it typed with its trailing space
  // does: /rename then generates a title rather than opening the rename dialog.
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "/rename" } }) })
    await ghost(app, "/rename")
    app.setup.mockInput.pressEnter()
    await quiet(app)
    expect(app.updates).toEqual([{ title: "" }])
    expect(app.frame()).not.toContain("Rename session")
    expect(app.prompts).toEqual([])
    expect(app.textarea().plainText).toBe("")
  }
  // Control: a suggestion that is not a command is sent to the model.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.enter()
    expect(app.prompts.map((prompt) => prompt.text)).toEqual([suggestion])
    expect(app.frame()).not.toContain("available actions and commands")
  }
})

test("a prompt that takes no keys draws no suggestion and takes none, and draws it again when it takes keys", async () => {
  // A plugin whose side panel, opened with F6, takes the keys from the session's prompt.
  await using folder = await tmpdir()
  const plugin = `${folder.path.replaceAll("\\", "/")}/panel`
  await Bun.write(
    `${plugin}/tui.ts`,
    [
      "export default {",
      '  id: "test.panel",',
      "  setup(context) {",
      "    context.ui.slot({",
      '      append: "app",',
      "      render() {",
      "        context.keymap.layer(() => ({",
      '          commands: [{ bind: "f6", title: "Open the panel", run: () => void context.ui.panel.open("probe") }],',
      "        }))",
      "        return null",
      "      },",
      "    })",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  await using app = await mount({ suggestions: true, plugins: [plugin] })
  // Control: the prompt has the keys, and the ghost is drawn.
  await ghost(app)
  // The plugin loads after the prompt is drawn, so F6 is pressed until the panel opens beside the session.
  const wide = app.textarea().width
  const deadline = Date.now() + 8000
  while (app.textarea().width >= wide && Date.now() < deadline) {
    await app.press("F6")
    await Bun.sleep(100)
  }
  expect(app.textarea().width).toBeLessThan(wide)
  await quiet(app)
  expect(app.frame()).not.toContain(suggestion)
  await app.press("TAB")
  await app.press("ARROW_RIGHT")
  expect(app.textarea().plainText).toBe("")
  expect(app.prompts).toEqual([])
  // Back in the session's prompt, the held suggestion is drawn again.
  await app.press("x", { ctrl: true })
  await app.press("ARROW_LEFT")
  expect(await app.shows(suggestion)).toBe(true)
})

test("a suggestion starting with ! is taken into shell mode by Tab and sent as text by Enter", async () => {
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "!git status" } }) })
    await ghost(app, "!git status")
    await app.press("TAB")
    expect(app.textarea().plainText).toBe("git status")
    // The prompt's marker is `!` in shell mode, where it is `›` otherwise.
    expect(app.frame()).not.toContain("›")
    expect(app.shells).toEqual([])
  }
  {
    await using app = await mount({ suggestions: true, answer: () => json({ data: { suggestion: "!git status" } }) })
    await ghost(app, "!git status")
    await app.enter()
    expect(app.prompts.map((prompt) => prompt.text)).toEqual(["!git status"])
    expect(app.shells).toEqual([])
  }
})

test("typing, a turn start and a submit end a suggestion as the reference does", async () => {
  // Typing while the request is out cancels it, and its late answer draws nothing.
  {
    const gate = Promise.withResolvers<void>()
    await using app = await mount({
      suggestions: true,
      answer: async () => {
        await gate.promise
        return json({ data: { suggestion } })
      },
    })
    app.execution("session.execution.succeeded")
    expect(await asked(app, 1, 200)).toBe(1)
    await app.type("x")
    expect(app.requests[0]!.signal.aborted).toBe(true)
    gate.resolve()
    await app.press("BACKSPACE")
    await quiet(app)
    expect(app.textarea().plainText).toBe("")
    expect(app.frame()).not.toContain(suggestion)
  }
  // A drawn suggestion hides while the input holds text and shows again once it is erased.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.type("x")
    expect(app.frame()).not.toContain(suggestion)
    await app.press("BACKSPACE")
    expect(await app.shows(suggestion)).toBe(true)
    // A turn starting in the session ends it, so it is not drawn again when that turn fails.
    app.execution("session.execution.started")
    await quiet(app, 100)
    app.execution("session.execution.failed")
    await quiet(app)
    expect(app.frame()).not.toContain(suggestion)
  }
  // A submit ends it.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.type("hello")
    await app.enter()
    expect(app.prompts.map((prompt) => prompt.text)).toEqual(["hello"])
    await quiet(app)
    expect(app.textarea().plainText).toBe("")
    expect(app.frame()).not.toContain(suggestion)
  }
  // A slash command typed and run from the list that opens on it is a submit as well.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.type("/help")
    app.setup.mockInput.pressEnter()
    expect(await app.shows("available actions and commands")).toBe(true)
    await app.press("ESCAPE")
    await quiet(app)
    expect(app.frame()).not.toContain("available actions and commands")
    expect(app.textarea().plainText).toBe("")
    expect(app.prompts).toEqual([])
    expect(app.frame()).not.toContain(suggestion)
  }
  // Rewinding the conversation ends it: it was written for the turns the rewind takes away.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    // The rewind puts the rewound prompt back in the input, which the person then erases.
    await app.type("Rename the helper")
    app.emit("session.revert.staged", { revert: { messageID: "msg_0003", files: [] } })
    await quiet(app, 100)
    for (const _ of "Rename the helper") await app.press("BACKSPACE")
    await quiet(app)
    expect(app.textarea().plainText).toBe("")
    expect(app.frame()).not.toContain(suggestion)
    await app.enter()
    expect(app.prompts).toEqual([])
  }
  // An answer that comes while the input holds text is dropped, as the reference drops one it cannot show.
  {
    await using app = await mount({ suggestions: true })
    await app.type("draft")
    app.execution("session.execution.succeeded")
    expect(await asked(app, 1, 300)).toBe(1)
    // The answer comes after the ask: it is given time to arrive while the input still holds text.
    await quiet(app)
    for (const _ of "draft") await app.press("BACKSPACE")
    await quiet(app)
    expect(app.textarea().plainText).toBe("")
    expect(app.frame()).not.toContain(suggestion)
  }
})

test("the autocomplete, Shift+Tab and an attached image keep their keys", async () => {
  // With the autocomplete open there is no ghost, and Tab completes the item: /rename takes an argument, so completing
  // it puts the command in the input instead of running it.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.type("/")
    expect(app.frame()).not.toContain(suggestion)
    await app.type("rena")
    await app.press("TAB")
    expect(app.textarea().plainText).toBe("/rename ")
  }
  // Shift+Tab cycles the agent while the ghost is drawn, and leaves the input empty.
  {
    await using app = await mount({ suggestions: true })
    await ghost(app)
    expect(app.frame()).toContain("Build")
    await app.press("TAB", { shift: true })
    expect(await app.shows("Plan")).toBe(true)
    expect(app.textarea().plainText).toBe("")
  }
  // An attached image hides the ghost, and Enter sends the image prompt without the suggestion.
  {
    await using files = await tmpdir()
    const png = `${files.path.replaceAll("\\", "/")}/shot.png`
    await Bun.write(png, new Uint8Array([1, 2, 3]))
    await using app = await mount({ suggestions: true })
    await ghost(app)
    await app.setup.mockInput.pasteBracketedText(png)
    await Bun.sleep(150)
    await app.setup.renderOnce()
    expect(app.textarea().plainText).toContain("[Image 1]")
    expect(app.frame()).not.toContain(suggestion)
    await app.enter()
    await quiet(app)
    expect(app.prompts).toHaveLength(1)
    expect(app.prompts[0]!.text).not.toContain(suggestion)
    expect(JSON.stringify(app.prompts[0]!.files)).toContain("data:image/png;base64,AQID")
  }
})

test("each failed answer draws nothing and leaves the prompt usable", async () => {
  const rows: Array<{ name: string; answer: Answer; drawn: boolean }> = [
    {
      name: "403 UntrustedFolderError",
      answer: () =>
        json({ _tag: "UntrustedFolderError", message: "This folder is not trusted", directory }, { status: 403 }),
      drawn: false,
    },
    { name: "a bodiless 404 from an older server", answer: () => new Response(null, { status: 404 }), drawn: false },
    { name: "500", answer: () => new Response("internal failure", { status: 500 }), drawn: false },
    {
      name: "a body that is not JSON",
      answer: () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
      drawn: false,
    },
    { name: "a number for the text", answer: () => json({ data: { suggestion: 42 } }), drawn: false },
    { name: "null with a reason", answer: () => json({ data: { suggestion: null, reason: "busy" } }), drawn: false },
    // Escaped, blank text is nothing to draw, so the prompt keeps its own placeholder.
    { name: "blank text", answer: () => json({ data: { suggestion: " \n\t " } }), drawn: false },
    { name: "control: a suggestion", answer: () => json({ data: { suggestion } }), drawn: true },
  ]
  for (const row of rows) {
    await using app = await mount({ suggestions: true, answer: row.answer })
    app.execution("session.execution.succeeded")
    expect({ name: row.name, asked: await asked(app, 1) }).toEqual({ name: row.name, asked: 1 })
    // The answer comes after the ask: the control's is drawn once it does, and the others get time to draw nothing.
    if (row.drawn) await app.shows(suggestion)
    else await quiet(app)
    const frame = app.frame()
    expect({ name: row.name, drawn: frame.includes(suggestion) }).toEqual({ name: row.name, drawn: row.drawn })
    for (const word of ["42", "busy", "not trusted", "internal failure", "not json"])
      expect({ name: row.name, word, shown: frame.includes(word) }).toEqual({ name: row.name, word, shown: false })
    if (row.drawn) continue
    await app.type("hello")
    await app.enter()
    expect({ name: row.name, sent: app.prompts.map((prompt) => prompt.text) }).toEqual({
      name: row.name,
      sent: ["hello"],
    })
  }
})
