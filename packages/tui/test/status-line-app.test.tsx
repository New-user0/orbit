import { expect, test } from "bun:test"
import path from "node:path"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"

// The whole app, with a real status line command: what the Prompt hands to the line (the agent, the selected model and
// variant, the session's location, the context of the selected model) and what refreshes it (the selections, the
// location arriving, this session's step events) are only visible here.
test("the status line follows the selection, the session's location and its step events", async () => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  const script = path.join(scripts.path, "line.ts")
  const counter = path.join(scripts.path, "count.txt")
  await Bun.write(
    script,
    `import { appendFileSync, readFileSync } from "node:fs"
const input = JSON.parse(await Bun.stdin.text())
appendFileSync(${JSON.stringify(counter)}, "x")
const n = readFileSync(${JSON.stringify(counter)}, "utf8").length
console.log("n=" + n + " " + JSON.stringify({
  style: input.output_style,
  status: input.status,
  vim: input.vim_mode,
  agent: input.agent,
  variant: input.model?.variant,
  model: input.model?.id,
  name: input.model?.name,
  used: input.context?.used,
  limit: input.context?.limit,
  percent: input.context?.percent,
  title: input.session?.title,
  usd: input.cost?.usd,
  p: input.project_dir?.endsWith("/session-project") ? "session-project" : input.project_dir,
  c: input.cwd === input.project_dir,
}))
`,
  )
  const projectDirectory = `${directory}/session-project`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const sessionLocation = {
    directory: projectDirectory,
    project: { id: "other", directory: projectDirectory, canonical: projectDirectory },
  }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "other",
    title: "Status line fixture",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory: projectDirectory },
    cost: 0.25,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    state: state.path,
    width: 300,
    config: {
      animations: false,
      prompt: { vim: true },
      keybinds: { "model.list": "f8", "agent.cycle": "f7", "variant.cycle": "f9" },
      status_line: {
        interval: 60_000,
        command: `${process.execPath.replaceAll("\\", "/")} ${script.replaceAll("\\", "/")}`,
      },
    },
    args: { sessionID: session.id },
    fetch: async (url) => {
      const forSession = url.searchParams.get("location[directory]") === projectDirectory
      const here = forSession ? sessionLocation : location
      // The output style is the last config document that sets one.
      if (url.pathname === "/api/config") return json([{ type: "document", info: { output_style: "concise" } }])
      // The session's location arrives late: only the watch on it can bring the project directory into the line.
      if (url.pathname === "/api/location") {
        if (forSession) await Bun.sleep(1_500)
        return json(here)
      }
      if (url.pathname === "/api/agent")
        return json({
          location: here,
          data: ["build", "plan"].map((id) => ({ id, mode: "primary", hidden: false, permissions: [] })),
        })
      if (url.pathname === "/api/provider") return json({ location: here, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            { id: "first", limit: 1000, variants: [{ id: "high" }] },
            { id: "second", limit: 2000, variants: [] },
          ].map((model) => ({
            id: model.id,
            providerID: "demo",
            name: `${model.id} model`,
            variants: model.variants,
            limit: { context: model.limit, output: 100 },
            cost: [],
            time: { released: 0 },
          })),
        })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      // One answer from `first`: 400 tokens against its limit of 1000.
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_answer",
              type: "assistant",
              agent: "build",
              model: { providerID: "demo", id: "first" },
              time: { created: 1 },
              content: [],
              tokens: { input: 400, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
          cursor: {},
        })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  const count = async () => ((await Bun.file(counter).exists()) ? (await Bun.file(counter).text()).length : 0)
  const line = async (matches: (row: string) => boolean) => {
    // Starting the command takes a moment, so wait by the clock and not by render passes.
    const started = Date.now()
    const row = () =>
      setup
        .captureCharFrame()
        .split("\n")
        .find((item) => item.includes(" n=")) ?? ""
    while (!matches(row())) {
      if (Date.now() - started > 8_000)
        throw new Error(`The line never matched (ran ${await count()} times):\n${setup.captureCharFrame()}`)
      await Bun.sleep(50)
      await setup.renderOnce()
    }
    return row()
  }
  const runs = (row: string) => Number(row.match(/ n=(\d+)/)?.[1])
  // Let the runs that a change caused finish, so that the next one can only come from the next change.
  const settle = async () => {
    // A run that a busy machine starts late still counts: wait for a quiet second, a few times at most.
    const quiet = async (before: number, attempts: number): Promise<number> => {
      await Bun.sleep(1_000)
      const now = await count()
      if (now === before || attempts === 0) return now
      return quiet(now, attempts - 1)
    }
    const settled = await quiet(await count(), 4)
    expect(await count()).toBe(settled)
    return settled
  }

  // Before the location has arrived the line has no project directory, and every other field is already in place.
  const early = await line((row) => row.includes('"model":"first"'))
  expect(early).toContain('"p":null')
  expect(early).toContain('"agent":"build"')
  expect(early).toContain('"variant":null')
  expect(early).toContain('"title":"Status line fixture"')
  expect(early).toContain('"usd":0.25')

  // The interval is a minute and nothing else happens, so only the watch on the location can put it in the line.
  const located = await line((row) => row.includes(`"p":"session-project"`))
  expect(located).toContain(`"c":true`)
  expect(runs(located)).toBeGreaterThan(runs(early))
  // The model list belongs to the same location, so the name and the context numbers come with it.
  const ready = await line((row) => row.includes('"name":"first model"'))
  expect(ready).toContain('"used":400,"limit":1000,"percent":40')
  await settle()

  // The agent changes the line before anything is sent.
  const beforeAgent = await count()
  setup.mockInput.pressKey("F7")
  const agent = await line((row) => row.includes('"agent":"plan"'))
  expect(runs(agent)).toBeGreaterThan(beforeAgent)
  await settle()

  // So does the variant.
  const beforeVariant = await count()
  setup.mockInput.pressKey("F9")
  const variant = await line((row) => row.includes('"variant":"high"'))
  expect(runs(variant)).toBeGreaterThan(beforeVariant)
  await settle()

  // So does the model; its context numbers are all of the selected model, whose limit differs from the answer's model.
  const beforeModel = await count()
  // A dialog that opens while the machine is busy can miss the typed filter, so a pick that changed nothing is repeated.
  const pick = async () => {
    setup.mockInput.pressKey("F8")
    await setup.waitForFrame((frame) => frame.includes("Select model"))
    await setup.mockInput.typeText("second")
    // The filter has been applied once the list shows the model, so Enter picks it.
    await setup.waitForFrame((frame) => frame.includes("second model"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => !frame.includes("Select model"))
  }
  await pick()
  if (!setup.captureCharFrame().includes('"model":"second"')) await pick()
  const selected = await line((row) => row.includes('"model":"second"'))
  expect(runs(selected)).toBeGreaterThan(beforeModel)
  expect(selected).toContain('"used":400,"limit":2000,"percent":20')
  const settled = await settle()

  // This session's step end runs the command again; nothing else would.
  setup.events.emit({
    id: "evt_step",
    created: 1,
    type: "session.step.ended",
    data: { sessionID: session.id },
  } as never)
  await line((row) => row.includes(`n=${settled + 1} `))

  // The configured output style, the prompt's vim mode (a new prompt starts in insert) and the session's status each
  // differ from the payload's default, so a Prompt that leaves one out fails here.
  const full = await line((row) => row.includes('"style":"concise"'))
  expect(full).toContain('"vim":"insert"')
  expect(full).toContain('"status":"idle"')
  // The execution start sets the session running and triggers the line.
  setup.events.emit({
    id: "evt_running",
    created: 2,
    type: "session.execution.started",
    data: { sessionID: session.id },
  } as never)
  await line((row) => row.includes('"status":"running"'))
}, 40_000)

// With no model list the location is the only thing the line waits for, so only the watch on it can bring the project
// directory in: the interval is a minute and no event arrives.
test("the status line reruns when the session's location arrives", async () => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  const script = path.join(scripts.path, "line.ts")
  await Bun.write(
    script,
    `const input = JSON.parse(await Bun.stdin.text())
console.log("p=" + input.project_dir)
`,
  )
  const projectDirectory = `${directory}/session-project`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const sessionLocation = {
    directory: projectDirectory,
    project: { id: "other", directory: projectDirectory, canonical: projectDirectory },
  }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "other",
    title: "Status line fixture",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory: projectDirectory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    state: state.path,
    width: 300,
    config: {
      animations: false,
      status_line: {
        interval: 60_000,
        command: `${process.execPath.replaceAll("\\", "/")} ${script.replaceAll("\\", "/")}`,
      },
    },
    args: { sessionID: session.id },
    fetch: async (url) => {
      const forSession = url.searchParams.get("location[directory]") === projectDirectory
      const here = forSession ? sessionLocation : location
      if (url.pathname === "/api/location") {
        if (forSession) await Bun.sleep(1_500)
        return json(here)
      }
      if (url.pathname === "/api/agent")
        return json({ location: here, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location: here, data: [] })
      if (url.pathname === "/api/model") return json({ location, data: [] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  const started = Date.now()
  const seen = (text: string) => setup.captureCharFrame().includes(text)
  const until = async (text: string) => {
    while (!seen(text)) {
      if (Date.now() - started > 8_000) throw new Error(`Never saw ${text}:\n${setup.captureCharFrame()}`)
      await Bun.sleep(50)
      await setup.renderOnce()
    }
  }
  await until("p=null")
  await until(`p=${projectDirectory}`)
}, 20_000)
