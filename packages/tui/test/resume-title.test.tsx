import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const location = {
  directory,
  project: { id: "project", directory, canonical: directory },
}

const ordinary = "Fix the build"
// Built from its code point so no bidi override sits in this source file.
const bidi = String.fromCharCode(0x202e)
const hostile = "Fix\x1b[2Kbuild" + bidi + "evil"

async function open(input: { title: string; width: number; height?: number; session: boolean }) {
  const session = {
    id: "ses_resumed",
    projectID: "project",
    title: input.title,
    location: { directory: location.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  return await createAppFixture({
    args: input.session ? { sessionID: session.id } : {},
    width: input.width,
    height: input.height,
    config: { animations: false },
    fetch: async (url) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      return undefined
    },
  })
}

// Runs a command from the palette. Its search box starts empty, unlike the composer, whose draft other tests in the
// same process can leave behind. The palette focuses its search box on a timer after it is first drawn, and letters
// sent before that reach no input (FU-M4-322: under load the palette stays open with an empty search), so the title is
// typed once the box holds focus.
async function palette(setup: Awaited<ReturnType<typeof open>>, title: string) {
  const search = () => {
    const focused = setup.renderer.currentFocusedRenderable
    return focused instanceof InputRenderable && !focused.isDestroyed
  }
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Commands") && search())
  for (const key of title) setup.mockInput.pressKey(key)
  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEnter()
}

// Every view that draws a session title, on the real component. A hostile title shows written out (`\x1b`, `\u{202e}`)
// and never as an escape sequence or a bidi override; the trusted row shows the title as it is. Each view waits for its
// own title before the frame is captured, so a view that draws late cannot pass by being absent.
const views = [
  // The banner and the tab rail sit under the banner at 100 columns.
  { view: "banner and tab rail", width: 100, session: true, keys: async () => {} },
  // Past the sidebar breakpoint the sidebar draws the title as well.
  { view: "banner, tab rail and sidebar", width: 160, session: true, keys: async () => {} },
  {
    // /clear closes the session tab and goes home, where the session is listed among the recent ones ("◦ title").
    view: "home recent list",
    width: 100,
    session: true,
    keys: async (setup: Awaited<ReturnType<typeof open>>) => {
      await palette(setup, "Clear session")
      await setup.waitForFrame((frame) => frame.includes("◦"))
    },
  },
  {
    // The map row is "○ title" or "● title".
    view: "agent map",
    width: 100,
    session: true,
    keys: async (setup: Awaited<ReturnType<typeof open>>) => {
      await palette(setup, "Agent map")
      await setup.waitForFrame((frame) => frame.includes("○ ") || frame.includes("● "))
    },
  },
  {
    // The rename prompt is prefilled with the current title.
    view: "rename prompt",
    width: 100,
    session: true,
    keys: async (setup: Awaited<ReturnType<typeof open>>) => {
      await palette(setup, "Rename session")
      // The palette is gone and the prompt, titled "Rename session", is up.
      await setup.waitForFrame((frame) => !frame.includes("Commands") && frame.includes("Rename session"))
    },
  },
]

test.each(views.flatMap((view) => [{ ...view, trusted: true }, { ...view, trusted: false }]))(
  "a session title is drawn safely in the $view at $width columns: trusted $trusted",
  async (row) => {
    await using setup = await open({ title: row.trusted ? ordinary : hostile, width: row.width, session: row.session })
    await setup.ready
    // Every view must have drawn the title (or its written-out form) before the frame is captured.
    const shown = row.trusted ? ordinary : "Fix\\x1b[2Kbuild\\u{202e}evil"
    await setup.waitForFrame((frame) => frame.includes(shown.slice(0, 8)))
    await row.keys(setup)
    await setup.waitForFrame((frame) => frame.includes(shown.slice(0, 8)))
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("\x1b")
    expect(frame).not.toContain(bidi)
    expect(frame.includes("\\x1b[2K")).toBe(!row.trusted)
  },
)
