// m5-link-warning: an approval in the whole terminal UI, where the banner, the plan and the queue take rows of the
// screen that a component drawn alone has for itself. Each option, the selection, the line that says a link is on the way
// and a body that scrolls by the keyboard are on screen in each stage, and a person reads the end of what is approved
// with the keys alone (classes 8 and 14). The mouse is off.
import { expect, test } from "bun:test"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

const patch = "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-old\n+new\n"
const location = { directory: "/work", project: { id: "proj", directory: "/work" } }
const base = {
  projectID: "proj",
  location: { directory: "/work" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const root = { ...base, id: "ses_root", title: "Demo session" }
// A subagent's question is the one that has a reject stage, and it is drawn in its parent's session.
const child = { ...base, id: "ses_child", title: "Subagent session", parentID: root.id }

const linked = (name: string) => ({
  file: `linked/${name}`,
  place: `/elsewhere/real/${name}`,
  patch,
  link: { place: `/elsewhere/real/${name}`, outside: true },
})
// Words that are each one of a kind, so that no row reads as another.
const long = (id: string, length: number) =>
  Array.from({ length }, (_, index) => `${id}${index}`)
    .join("/")
    .slice(0, length)
const edit = (files: ReturnType<typeof linked>[]) => ({
  action: "Edit",
  resources: files.map((file) => file.file),
  save: ["*"],
  metadata: { paths: files.map((file) => file.place), files },
})
const patterns = Array.from({ length: 14 }, (_, index) => `/o/folder${index}${index === 13 ? "QEND" : ""}/*`)
const CASES = {
  short: { asked: edit([linked("a.txt")]), warning: "Link", end: "a.txt", always: "a.txt" },
  long: { asked: edit([linked(`${long("d", 200)}/QEND`)]), warning: "Link", end: "QEND", always: "QEND" },
  longest: { asked: edit([linked(`${long("e", 500)}/QEND`)]), warning: "Link", end: "QEND", always: "QEND" },
  several: {
    asked: edit(Array.from({ length: 12 }, (_, index) => linked(index === 11 ? "QEND" : `file${index}`))),
    warning: "12link",
    end: "QEND",
    always: "QEND",
  },
  patterns: {
    asked: {
      action: "external_directory",
      resources: patterns,
      save: patterns,
      metadata: { parentDir: "/o" },
    },
    warning: undefined,
    end: "folder13QEND",
    always: "folder13QEND",
  },
}

type Asked = { action: string; resources: string[]; save: string[]; metadata: object }
type Options = { plan?: number; queued?: boolean; messages?: object[]; sessionID?: string }

async function open(width: number, height: number, asked: Asked | undefined, options: Options = {}) {
  const state = await tmpdir()
  const pending: object[] = []
  const replies: string[] = []
  const todos = Array.from({ length: options.plan ?? 0 }, (_, index) => ({
    content: `step ${index}`,
    status: index ? "pending" : "in_progress",
  }))
  const plan = {
    id: "msg_plan",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 1, completed: 2 },
    content: [
      {
        type: "tool",
        id: "call_plan",
        name: "todo",
        time: { created: 1, completed: 2 },
        state: { status: "completed", content: [], input: { todos }, metadata: {} },
      },
    ],
  }
  const inbox = options.queued
    ? [{ id: "queued-0", type: "user", delivery: "queue", payload: { text: "then this" }, time: { created: 5 } }]
    : []
  const setup = await createAppFixture({
    state: state.path,
    width,
    height,
    config: { animations: false, mouse: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
    args: { sessionID: options.sessionID ?? root.id },
    fetch: (url) => {
      if (url.pathname.endsWith("/reply")) {
        replies.push(url.pathname)
        return json({})
      }
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [root, child], cursor: {} })
      if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${root.id}/message`)
        return json({ data: [...(options.plan ? [plan] : []), ...(options.messages ?? [])], cursor: {} })
      if (url.pathname === `/api/session/${root.id}/inbox`) return json({ data: inbox, cursor: {} })
      if (/^\/api\/session\/[^/]+\/(message|inbox)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${child.id}/permission`) return json({ data: pending })
      if (url.pathname === `/api/session/${root.id}/permission`) return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      return undefined
    },
  })
  const until = async (found: (frame: string) => boolean) => {
    const started = Date.now()
    while (true) {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      if (found(frame)) return frame
      if (Date.now() - started > 10_000) throw new Error(`timed out:\n${frame}`)
      await Bun.sleep(10)
    }
  }
  const settled = async () => {
    const seen: string[] = []
    while (seen.length < 4 || seen.at(-1) !== seen.at(-2) || seen.at(-2) !== seen.at(-3)) {
      if (seen.length > 200) throw new Error(`the frame does not settle:\n${seen.at(-1)}`)
      await setup.renderOnce()
      await Bun.sleep(1)
      seen.push(setup.captureCharFrame())
    }
    return seen.at(-1)!
  }
  await setup.ready
  // What the docks hold is on screen before the question comes.
  await until((frame) => frame.includes("Orbit"))
  if (options.queued) await until((frame) => frame.includes("1 queued"))
  if (options.plan) await until((frame) => frame.includes("plan"))
  // The same screen with no question, which every dock row drawn beside one is a row of.
  const before = await settled()
  if (asked) {
    const question = { id: "per_route", sessionID: child.id, ...asked }
    pending.push(question)
    setup.events.emit({ id: "evt_asked", created: 3, type: "permission.asked", data: question })
    await until((frame) => frame.includes("1 Allow once"))
  }
  return {
    setup,
    replies,
    until,
    settled,
    before,
    first: await settled(),
    async press(key: string, modifiers?: { ctrl?: boolean }) {
      setup.mockInput.pressKey(key, modifiers)
      await Bun.sleep(0)
      return settled()
    },
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

const PAGE_DOWN = "\x1b[6~"
const PAGE_UP = "\x1b[5~"
const squash = (value: string) => value.replace(/[\s│┃█▀▄─╭╮╰╯]/g, "")

// Each row that paging down to the end shows above the options, once and in order.
async function readByKeys(app: Awaited<ReturnType<typeof open>>, first: string) {
  const shots = [first]
  while (true) {
    const next = await app.press(PAGE_DOWN)
    if (next === shots.at(-1)) break
    if (shots.length > 400) throw new Error("the scroll has no end")
    shots.push(next)
  }
  const rows = shots.flatMap((shot) => {
    const all = shot.split("\n").map(squash)
    return all.slice(
      0,
      all.findIndex((row) => row.endsWith("1Allowonce")),
    )
  })
  return [...new Set(rows)].join("").replaceAll("\\", "/")
}

// The three options on screen, one under the other, and the one that Enter would take.
function options(frame: string) {
  const rows = frame.split("\n").map(squash)
  const once = rows.findIndex((row) => row.endsWith("1Allowonce"))
  return rows.slice(once, once + 3)
}

const SCREENS: Array<{ name: string; width: number; height: number } & Options> = [
  ...[6, 7, 8, 9, 10, 11, 12, 14, 16].map((height) => ({ name: `80x${height}`, width: 80, height })),
  { name: "30x12", width: 30, height: 12 },
  { name: "40x8", width: 40, height: 8 },
  { name: "80x24", width: 80, height: 24 },
  { name: "80x12 with a plan", width: 80, height: 12, plan: 5 },
  { name: "80x24 with a plan", width: 80, height: 24, plan: 5 },
  { name: "80x24 with a plan and a queue", width: 80, height: 24, plan: 5, queued: true },
]

for (const screen of SCREENS)
  for (const [kind, held] of Object.entries(CASES))
    test(`the session route at ${screen.name} keeps every stage of an approval on screen, and its end in reach of the keys: ${kind}`, async () => {
      await using app = await open(screen.width, screen.height, held.asked, screen)
      for (const stage of ["permission", "always"] as const) {
        const cell = [screen.name, kind, stage]
        if (stage === "always") await app.press("\x1b[B")
        const first = stage === "always" ? await app.settled() : app.first
        const shown = squash(first)
        expect([...cell, options(first)]).toEqual([
          ...cell,
          stage === "always" ? ["1Allowonce", "›2Alwaysallow", "3Reject"] : ["›1Allowonce", "2Alwaysallow", "3Reject"],
        ])
        if (held.warning) expect([...cell, shown.includes(held.warning)]).toEqual([...cell, true])
        // The end of it, on the first screen or by the keys alone.
        const read = await readByKeys(app, first)
        expect([...cell, read.includes(stage === "always" ? held.always : held.end)]).toEqual([...cell, true])
        // The options stay, with the selection, however far the body is scrolled.
        expect([...cell, options(await app.settled())]).toEqual([...cell, options(first)])
        // The keys are named where more is out of sight and a border is left to name them on.
        if (screen.height > 6) {
          const more = (await app.press("\x1b[H")) !== (await app.press("\x1b[F"))
          if (more) expect([...cell, shown.includes("pgup/pgdnscroll")]).toEqual([...cell, true])
        }
      }
      await app.press("3")
      const rejecting = await app.until((frame) => frame.includes("Reject permission"))
      const asked = squash(await app.settled())
      const cell = [screen.name, kind, "reject"]
      expect([...cell, rejecting.includes("Reject permission")]).toEqual([...cell, true])
      if (held.warning) expect([...cell, asked.includes(held.warning)]).toEqual([...cell, true])
      for (const part of ["enterconfirm", "esccancel", "TellOrbit"])
        expect([...cell, part, asked.includes(part)]).toEqual([...cell, part, true])
      // The field is on screen too, and a long answer pushes neither it nor the hints off.
      await app.setup.mockInput.typeText(`${"because it leads away ".repeat(12)}AND-NO`)
      const typed = squash(await app.settled())
      for (const part of ["AND-NO", "enterconfirm", "esccancel"])
        expect([...cell, part, typed.includes(part)]).toEqual([...cell, part, true])
      expect(app.replies).toEqual([])
    }, 90_000)

for (const height of [6, 7, 8, 12, 24])
  test(`fullscreen at 80x${height} keeps the options and the end in reach of the keys`, async () => {
    await using app = await open(80, height, CASES.longest.asked)
    for (const stage of ["permission", "always"] as const) {
      if (stage === "always") await app.press("\x1b[B")
      const first = stage === "always" ? await app.settled() : await app.press("f", { ctrl: true })
      expect([stage, options(first).map((row) => row.replace("›", ""))]).toEqual([
        stage,
        ["1Allowonce", "2Alwaysallow", "3Reject"],
      ])
      expect([stage, (await readByKeys(app, first)).includes("QEND")]).toEqual([stage, true])
    }
  }, 60_000)

test("the docks give an approval the rows it needs, from the bottom up, and paint over nothing", async () => {
  const bash = { action: "Bash", resources: ["echo x"], save: ["echo *"], metadata: {} }
  await using app = await open(80, 24, bash, { plan: 25 })
  const rows = app.first.split("\n").map((row) => row.trimEnd())
  // A short question leaves the plan's first rows above it.
  expect(app.first).toContain("plan")
  expect(app.first).toContain("step 0")
  expect(app.first).not.toContain("step 24")
  // The route's blank row is under the dialog, with nothing of a dock in it.
  expect(rows.slice(-3)[0]).toMatch(/^ +╰─+╯$/)
  expect(rows.slice(-2).join("")).toBe("")
})

// A dock that gives way loses whole rows: each row above the dialog is one the same screen drew before the question.
for (const [width, height] of [
  [80, 24],
  [100, 24],
  [80, 25],
] as const)
  for (const docks of [{ plan: 2 }, { plan: 5 }, { plan: 5, queued: true }])
    test(`at ${width}x${height} the docks above an edit give way in whole rows: ${JSON.stringify(docks)}`, async () => {
      await using app = await open(width, height, CASES.short.asked, docks)
      const drawn = new Set(app.before.split("\n"))
      const rows = app.first.split("\n")
      const top = rows.findLastIndex(
        (row, index) => /^ *╭/.test(row) && rows.slice(index).some((rest) => rest.includes("1 Allow once")),
      )
      expect(top).toBeGreaterThan(0)
      expect(rows.slice(0, top).filter((row) => !drawn.has(row))).toEqual([])
      expect(options(app.first)).toEqual(["›1Allowonce", "2Alwaysallow", "3Reject"])
    })

test("an edit leaves the plan only its header row on an 80x24 screen", async () => {
  await using app = await open(80, 24, CASES.short.asked, { plan: 5 })
  expect(app.first).toContain("◎ plan 0/5 ▾")
  expect(app.first).not.toContain("step 0")
  expect(options(app.first)).toEqual(["›1Allowonce", "2Alwaysallow", "3Reject"])
})

test("the route's two blank rows go to a question that has not its own fifteen with them", async () => {
  const last = async (height: number) => {
    await using app = await open(80, height, CASES.short.asked)
    return app.first.split("\n")[height - 1]!.trim()
  }
  // The banner is one row under 24 high: the route has 16 rows at 80x17, and 17 at 80x18.
  expect(await last(17)).toMatch(/^╰─+╯$/)
  expect(await last(18)).toBe("")
})

test("the keys are the session's while the whole question is in sight, and the question's while it is not", async () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${index}`,
    type: "user",
    text: `message number ${index}`,
    time: { created: index + 1 },
  }))
  for (const [kind, jumps] of [
    ["short", true],
    ["patterns", false],
  ] as const) {
    await using app = await open(100, 50, CASES[kind].asked, { messages })
    expect([kind, app.first.includes("Jump to latest")]).toEqual([kind, false])
    expect([kind, (await app.press(PAGE_UP)).includes("Jump to latest")]).toEqual([kind, jumps])
  }
})

test("an approval follows the screen as it is resized", async () => {
  await using app = await open(80, 24, CASES.long.asked, { plan: 5 })
  for (const [width, height] of [
    [80, 8],
    [100, 40],
    [40, 10],
  ] as const) {
    app.setup.resize(width, height)
    await Bun.sleep(50)
    const frame = await app.settled()
    expect([height, options(frame)]).toEqual([height, ["›1Allowonce", "2Alwaysallow", "3Reject"]])
    // With rows to spare the docks have theirs again.
    expect([height, frame.includes("step 4")]).toEqual([height, height === 40])
  }
})

test("the docks, the prompt and the route's blank rows come back once the question is answered", async () => {
  await using app = await open(80, 16, CASES.long.asked, { plan: 3 })
  expect(app.first).not.toContain("step 2")
  app.setup.events.emit({
    id: "evt_replied",
    created: 4,
    type: "permission.replied",
    data: { sessionID: child.id, requestID: "per_route", reply: "once" },
  })
  const frame = await app.until(
    (shot) => !shot.includes("1 Allow once") && shot.includes("step 2") && promptReady(shot),
  )
  expect(frame).toContain("plan")
  expect(
    (await app.settled())
      .split("\n")
      .filter((row) => row !== "")
      .at(-1)!
      .trim(),
  ).toBe("")
})

// The composer is in the docks that give way to an approval; with none asked it opens and closes as before.
test("the composer opens and closes in the session route, and a subagent's closes to its parent", async () => {
  {
    await using app = await open(80, 24, undefined)
    expect(app.first).not.toContain("Subagents")
    expect(await app.press("\x1b[B")).toContain("Subagents")
    app.setup.mockInput.pressEscape()
    const closed = await app.until((frame) => !frame.includes("Subagents"))
    expect([closed.includes("Demo session"), promptReady(await app.settled())]).toEqual([true, true])
  }
  {
    await using app = await open(80, 24, undefined, { sessionID: child.id })
    expect(await app.until((frame) => frame.includes("Subagents"))).toContain("Subagent session")
    app.setup.mockInput.pressEscape()
    // Closed to the parent session, where the composer is closed.
    const parent = await app.until((frame) => frame.includes("Demo session"))
    expect([parent.includes("Subagent session"), (await app.settled()).includes("Subagents")]).toEqual([false, false])
  }
})
