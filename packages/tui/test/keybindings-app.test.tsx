import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { editKeybindings } from "../src/component/keybindings-toast"
import { KeybindingsFile } from "../src/config/keybindings-file"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

// The whole path from a keybindings file in the config folder to a key press in the running app.

test("a key from the keybindings file opens the command in its context", async () => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  await writeFile(
    path.join(config.path, "keybindings.json"),
    '{ "contexts": { "global": { "help.show": "ctrl+alt+h" } } }',
  )
  await using setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false },
  })

  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  setup.mockInput.pressKey("h", { ctrl: true, meta: true })
  await setup.waitForFrame((frame) => frame.includes("esc/enter"))
})

test("the same key does nothing without the file", async () => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false },
  })

  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  setup.mockInput.pressKey("h", { ctrl: true, meta: true })
  await setup.renderOnce()
  await Bun.sleep(100)
  expect(setup.captureCharFrame()).not.toContain("esc/enter")
})

test("says once what it left out of the file, and uses the rest", async () => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  await writeFile(
    path.join(config.path, "keybindings.json"),
    '{ "bindings": { "no.such.command": "ctrl+z", "help.show": "ctrl+alt+h" } }',
  )
  await using setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false },
  })

  await setup.ready
  const frame = await setup.waitForFrame((frame) => frame.includes("Keybindings file: 1 note"))
  expect(frame).toContain('"no.such.command" is not a command')
  expect(frame).toContain("Edit keybindings")
  setup.mockInput.pressKey("h", { ctrl: true, meta: true })
  await setup.waitForFrame((frame) => frame.includes("esc/enter"))
})

test.each([
  [true, "keeps the line"],
  [false, "deletes to the end of the line"],
])("with a chord on ctrl+k in the file: %s, ctrl+k in the prompt %s", async (chord) => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  if (chord)
    await writeFile(path.join(config.path, "keybindings.json"), '{ "bindings": { "help.show": "ctrl+k ctrl+s" } }')
  await using setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false },
  })

  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  await setup.mockInput.typeText("hello")
  await setup.waitForFrame((frame) => frame.includes("› hello"))
  setup.mockInput.pressKey("a", { ctrl: true })
  setup.mockInput.pressKey("k", { ctrl: true })
  await setup.renderOnce()
  await Bun.sleep(50)

  // A chord takes the first key of every other binding of that key, so ctrl+k waits for a second stroke instead of
  // deleting what follows the cursor.
  expect(setup.captureCharFrame().includes("› hello")).toBe(chord)
})

test("a change to the file while the app runs reaches the keys of the text area too", async () => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false },
  })

  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  await setup.mockInput.typeText("hello")
  await setup.waitForFrame((frame) => frame.includes("› hello"))
  setup.mockInput.pressKey("a", { ctrl: true })
  setup.mockInput.pressKey("g", { ctrl: true })
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("› hello")

  // ctrl+k deletes to the end of the line, and the file gives that to ctrl+g.
  await writeFile(
    path.join(config.path, "keybindings.json"),
    '{ "bindings": { "input.delete.to.line.end": "ctrl+g" } }',
  )
  const deadline = Date.now() + 5000
  while (setup.captureCharFrame().includes("› hello")) {
    if (Date.now() > deadline) throw new Error("The text area never took the key from the file")
    setup.mockInput.pressKey("a", { ctrl: true })
    setup.mockInput.pressKey("g", { ctrl: true })
    await setup.renderOnce()
    await Bun.sleep(50)
  }

  // The text area's keys rank below the app's own, as they did before the reload: ctrl+d still exits from an empty
  // prompt and is not taken by the text area's ctrl+d, which deletes a character.
  setup.mockInput.pressKey("d", { ctrl: true })
  await setup.waitFor(() => setup.renderer.isDestroyed)
})

function recordedToasts() {
  const shown: { variant: string; title?: string; message: string }[] = []
  return { shown, toast: { show: (options: (typeof shown)[number]) => void shown.push(options) } as never }
}

test("editing the keybindings writes the template for a missing file and opens it without a note", async () => {
  await using config = await tmpdir()
  const file = path.join(config.path, "keybindings.json")
  const opened: string[] = []
  const toasts = recordedToasts()

  await editKeybindings({
    file,
    renderer: {} as never,
    toast: toasts.toast,
    open: async (input) => void opened.push(input.file) as never,
  })

  expect(await readFile(file, "utf8")).toBe(KeybindingsFile.template())
  expect(opened).toEqual([file])
  expect(toasts.shown).toEqual([])
})

test("editing the keybindings opens a file that does not parse as it is", async () => {
  await using config = await tmpdir()
  const file = path.join(config.path, "keybindings.json")
  await writeFile(file, "{ broken")
  const opened: string[] = []

  await editKeybindings({
    file,
    renderer: {} as never,
    toast: recordedToasts().toast,
    open: async (input) => void opened.push(input.file) as never,
  })

  expect(await readFile(file, "utf8")).toBe("{ broken")
  expect(opened).toEqual([file])
})

test("editing the keybindings says where the file is when nothing can open it", async () => {
  await using config = await tmpdir()
  const file = path.join(config.path, "keybindings.json")
  const toasts = recordedToasts()

  await editKeybindings({
    file,
    renderer: {} as never,
    toast: toasts.toast,
    open: () => Promise.reject(new Error("no editor\u001b]0;pwned\u0007")),
  })

  expect(toasts.shown).toHaveLength(1)
  expect(toasts.shown[0]?.variant).toBe("warning")
  expect(toasts.shown[0]?.message).toContain(file)
  expect(toasts.shown[0]?.message).toContain("no editor\\x1b]0;pwned\\x07")
  // One line for the path and one for the reason, and nothing in either that acts on a terminal.
  for (const line of toasts.shown[0]?.message.split("\n") ?? []) expect(line).not.toMatch(/\p{C}/u)
  // The template was written all the same, for the person to open by hand.
  expect(await Bun.file(file).exists()).toBe(true)
})

test("editing the keybindings says so when the template cannot be written", async () => {
  await using config = await tmpdir()
  // A file where the folder should be.
  await writeFile(path.join(config.path, "blocked"), "")
  const opened: string[] = []
  const toasts = recordedToasts()

  await editKeybindings({
    file: path.join(config.path, "blocked", "keybindings.json"),
    renderer: {} as never,
    toast: toasts.toast,
    open: async (input) => void opened.push(input.file) as never,
  })

  expect(opened).toEqual([])
  expect(toasts.shown).toHaveLength(1)
  expect(toasts.shown[0]?.message).toContain("blocked")
})

test("the keybindings command writes the template where none exists and opens the file in the editor", async () => {
  await using state = await tmpdir()
  await using config = await tmpdir()
  await using editor = await tmpdir()
  const script = path.join(editor.path, "editor.ts")
  const marker = path.join(editor.path, "started.json")
  await writeFile(
    script,
    [
      'import { writeFileSync } from "node:fs"',
      "writeFileSync(process.env.ORBIT_TEST_EDITOR_MARKER!, JSON.stringify(process.argv.slice(2)))",
    ].join("\n"),
  )
  const before = { visual: process.env.VISUAL, marker: process.env.ORBIT_TEST_EDITOR_MARKER }
  process.env.VISUAL = `"${process.execPath}" "${script}"`
  process.env.ORBIT_TEST_EDITOR_MARKER = marker
  const file = path.join(config.path, "keybindings.json")
  try {
    await using setup = await createAppFixture({
      state: state.path,
      configPath: path.join(config.path, "cli.json"),
      config: { animations: false },
    })

    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    expect(await Bun.file(file).exists()).toBe(false)
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("Edit keybindings")
    await setup.waitForFrame((frame) => /Edit keybindings\s+System/.test(frame))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => Bun.file(marker).exists())

    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([file])
    expect(await readFile(file, "utf8")).toBe(KeybindingsFile.template())
    // The terminal is the app's again.
    await setup.waitForFrame((frame) => promptReady(frame))
  } finally {
    if (before.visual === undefined) delete process.env.VISUAL
    else process.env.VISUAL = before.visual
    if (before.marker === undefined) delete process.env.ORBIT_TEST_EDITOR_MARKER
    else process.env.ORBIT_TEST_EDITOR_MARKER = before.marker
  }
})
