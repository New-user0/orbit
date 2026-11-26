import { expect, test } from "bun:test"
import { PASTE_NOT_SAVED } from "../../src/prompt/history"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture, promptReady } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json, type FetchHandler } from "../fixture/tui-client"

const line = (value: Record<string, unknown>) =>
  JSON.stringify({ files: [], agents: [], skills: [], pasted: [], ...value }) + "\n"

async function seed(state: string, lines: string[]) {
  await mkdir(state, { recursive: true })
  await writeFile(path.join(state, "prompt-history.jsonl"), lines.join(""))
}

async function mount(input: { vim?: boolean; extra?: string[]; session?: FetchHandler; sessionID?: string } = {}) {
  // A prompt that an earlier test left unsent is kept for the next one to open.
  takeDraft(undefined)
  const state = await tmpdir()
  const config = await tmpdir()
  await seed(state.path, [
    line({ text: "deploy the staging build", time: 1_000 }),
    line({ text: "ls -la", mode: "shell", time: 2_000 }),
    ...(input.extra ?? []),
    line({
      text: "explain @src/main.ts please",
      files: [{ uri: "file:///src/main.ts", mention: { start: 8, end: 20, text: "@src/main.ts" } }],
      time: 3_000,
    }),
  ])
  const setup = await createAppFixture({
    state: state.path,
    fetch: input.session,
    args: input.sessionID ? { sessionID: input.sessionID } : undefined,
    configPath: path.join(config.path, "cli.json"),
    config: { animations: false, prompt: { vim: input.vim } },
  })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  return {
    setup,
    state: state.path,
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

test("in Vim normal mode ctrl+r opens the search, as in insert mode", async () => {
  await using app = await mount({ vim: true })

  await app.setup.mockInput.typeText("abc")
  await app.setup.waitForFrame((frame) => frame.includes("› abc"))
  app.setup.mockInput.pressEscape()
  await app.setup.renderOnce()
  await Bun.sleep(80)
  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Search prompt history"))
})

test("in Vim normal mode redo stays on its own binding and ctrl+r does not redo", async () => {
  await using app = await mount({ vim: true })

  await app.setup.mockInput.typeText("abc")
  await app.setup.waitForFrame((frame) => frame.includes("› abc"))
  // Escape enters normal mode, u undoes the typing, and the redo binding brings it back.
  app.setup.mockInput.pressEscape()
  await app.setup.renderOnce()
  await Bun.sleep(80)
  app.setup.mockInput.pressKey("u")
  await app.setup.waitForFrame((frame) => frame.includes("› ab ") && !frame.includes("› abc"))
  app.setup.mockInput.pressKey(".", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("› abc"))
  expect(app.setup.captureCharFrame()).not.toContain("Search prompt history")
})

test("in Vim normal mode the up arrow recalls the previous prompt, as in insert mode", async () => {
  await using app = await mount({ vim: true })

  app.setup.mockInput.pressEscape()
  await app.setup.renderOnce()
  await Bun.sleep(80)
  app.setup.mockInput.pressArrow("up")
  await app.setup.waitForFrame((frame) => frame.includes("› explain @src/main.ts please"))
})

// A session that accepts prompts, so that a submit reaches the server and the body can be read.
function sessionServer(prompts: Array<{ text: string; files?: Array<{ uri: string }> }>) {
  const sessionID = "ses_history"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "History fixture",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    if (url.pathname === `/api/session/${sessionID}/prompt`) {
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
    return undefined
  }
  return { sessionID, handler }
}

async function search(app: Awaited<ReturnType<typeof mount>>, query: string, expected: string) {
  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Search prompt history"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText(query)
  await app.setup.waitForFrame((frame) => frame.includes(expected))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => !frame.includes("Search prompt history"))
}

test("selecting an entry with a mention restores the mention, which a submit sends as a file", async () => {
  const prompts: Array<{ text: string; files?: Array<{ uri: string }> }> = []
  const server = sessionServer(prompts)
  await using app = await mount({ session: server.handler, sessionID: server.sessionID })
  await app.setup.waitForFrame((frame) => frame.includes("Demo Model"))

  await search(app, "explain", "explain @src/main.ts please")
  await app.setup.waitForFrame((frame) => frame.includes("› explain @src/main.ts please"))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame(() => prompts.length > 0)
  expect(prompts[0]?.files?.[0]?.uri).toBe("file:///src/main.ts")
})

test("selecting an entry moves a different draft to the stash and says so", async () => {
  await using app = await mount()
  await app.setup.mockInput.typeText("half-written thought")
  await app.setup.waitForFrame((frame) => frame.includes("› half-written thought"))

  await search(app, "stag", "deploy the staging build")
  await app.setup.waitForFrame(
    (frame) => frame.includes("› deploy the staging build") && frame.includes("Your draft was moved to the stash"),
  )
  expect(app.setup.captureCharFrame()).not.toContain("half-written")

  // The stash gives the draft back.
  app.setup.mockInput.pressKey("p", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("Commands"))
  await Bun.sleep(50)
  await app.setup.mockInput.typeText("Stash pop")
  await app.setup.waitForFrame((frame) => frame.includes("Stash pop"))
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => frame.includes("› half-written thought"))
})

test("selecting an entry after an unedited recall does not stash the recalled entry", async () => {
  await using app = await mount()
  app.setup.mockInput.pressArrow("up")
  await app.setup.waitForFrame((frame) => frame.includes("› explain @src/main.ts please"))

  await search(app, "stag", "deploy the staging build")
  await app.setup.waitForFrame((frame) => frame.includes("› deploy the staging build"))
  expect(app.setup.captureCharFrame()).not.toContain("Your draft was moved to the stash")
  expect(await Bun.file(path.join(app.state, "prompt-stash.jsonl")).exists()).toBe(false)
})

test("selecting an entry whose stored agents are malformed skips only that entry", async () => {
  await using app = await mount({ extra: [line({ text: "weird entry", agents: "x" })] })
  app.setup.mockInput.pressKey("r", { ctrl: true })
  await app.setup.waitForFrame((frame) => frame.includes("deploy the staging build"))
  expect(app.setup.captureCharFrame()).not.toContain("weird entry")
})

test("a row title is drawn without control or bidirectional characters", async () => {
  await using app = await mount({
    extra: [line({ text: "visible]0;pwned name‮evil", time: 4_000 })],
  })
  app.setup.mockInput.pressKey("r", { ctrl: true })
  const frame = await app.setup.waitForFrame((frame) => frame.includes("Search prompt history") && frame.includes("visible"))
  expect(frame).not.toContain("")
  expect(frame).not.toContain("‮")
  expect(frame).not.toContain("pwned")
})

test("selecting an entry whose large paste was not kept warns before it is sent", async () => {
  await using app = await mount({
    extra: [
      line({
        text: "summarise [Pasted ~40 lines]",
        pasted: [{ text: PASTE_NOT_SAVED, source: { start: 10, end: 28, text: "[Pasted ~40 lines]" } }],
        time: 5_000,
      }),
    ],
  })
  await search(app, "summarise", "summarise [Pasted ~40 lines]")
  await app.setup.waitForFrame((frame) => frame.includes("A large paste in this prompt was not kept"))
})
