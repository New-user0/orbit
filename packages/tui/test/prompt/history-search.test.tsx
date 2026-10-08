import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture, promptReady } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"

const line = (value: Record<string, unknown>) =>
  JSON.stringify({ files: [], agents: [], skills: [], pasted: [], ...value }) + "\n"

async function seed(state: string, lines: string[]) {
  await mkdir(state, { recursive: true })
  await writeFile(path.join(state, "prompt-history.jsonl"), lines.join(""))
}

async function mount(input: { vim?: boolean } = {}) {
  // A prompt that an earlier test left unsent is kept for the next one to open.
  takeDraft(undefined)
  const state = await tmpdir()
  const config = await tmpdir()
  await seed(state.path, [
    line({ text: "deploy the staging build", time: 1_000 }),
    line({ text: "ls -la", mode: "shell", time: 2_000 }),
    line({
      text: "explain @src/main.ts please",
      files: [{ uri: "file:///src/main.ts", mention: { start: 8, end: 20, text: "@src/main.ts" } }],
      time: 3_000,
    }),
  ])
  const setup = await createAppFixture({
    state: state.path,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false, prompt: { vim: input.vim } },
  })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  return {
    setup,
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await config[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

test("ctrl+r in the focused prompt opens the history search and selecting restores the entry", async () => {
  await using app = await mount()

  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Search prompt history"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText("stag")
  await app.setup.waitForFrame(
    (frame) => frame.includes("deploy the staging build") && !frame.includes("explain @src/main.ts please"),
  )

  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => frame.includes("› deploy the staging build"))
})

test("selecting a shell entry restores shell mode", async () => {
  await using app = await mount()

  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("! ls -la"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText("ls -la")
  await app.setup.waitForFrame((frame) => frame.includes("! ls -la") && !frame.includes("deploy the staging"))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame(
    (frame) => !frame.includes("Search prompt history") && frame.includes("esc exit shell mode"),
  )
  expect(app.setup.captureCharFrame()).toContain("ls -la")
})

test("selecting an entry with a mention restores its text", async () => {
  await using app = await mount()

  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Search prompt history"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText("explain")
  await app.setup.waitForFrame((frame) => frame.includes("explain @src/main.ts please") && !frame.includes("! ls"))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => frame.includes("› explain @src/main.ts please"))
})

test("in Vim normal mode ctrl+r redoes and does not open the search", async () => {
  await using app = await mount({ vim: true })

  await app.setup.mockInput.typeText("abc")
  await app.setup.waitForFrame((frame) => frame.includes("› abc"))
  // Escape enters normal mode, u undoes the typing, and ctrl+r brings it back.
  app.setup.mockInput.pressEscape()
  await app.setup.renderOnce()
  await Bun.sleep(80)
  app.setup.mockInput.pressKey("u")
  await app.setup.waitForFrame((frame) => frame.includes("› ab ") && !frame.includes("› abc"))
  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("› abc"))
  expect(app.setup.captureCharFrame()).not.toContain("Search prompt history")
})
