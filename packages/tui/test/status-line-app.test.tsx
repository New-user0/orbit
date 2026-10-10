import { expect, test } from "bun:test"
import path from "node:path"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"

// The whole app, with a real status line command: what the Prompt hands to the line (the selected model, the session's
// location) and what refreshes it (this session's step events) are only visible here.
test("the status line follows the selected model, the session's location and its step events", async () => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  const script = path.join(scripts.path, "line.ts")
  const counter = path.join(scripts.path, "count.txt")
  await Bun.write(
    script,
    `import { appendFileSync, readFileSync } from "node:fs"
const input = JSON.parse(await Bun.stdin.text())
appendFileSync(${JSON.stringify(counter)}, "x")
console.log("m=" + input.model?.id + " n=" + readFileSync(${JSON.stringify(counter)}, "utf8").length + " p=" + input.project_dir + " c=" + input.cwd)
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
    config: {
      animations: false,
      keybinds: { "model.list": "f8" },
      status_line: {
        interval: 60_000,
        command: `${process.execPath.replaceAll("\\", "/")} ${script.replaceAll("\\", "/")}`,
      },
    },
    args: { sessionID: session.id },
    fetch: async (url) => {
      const here = url.searchParams.get("location[directory]") === projectDirectory ? sessionLocation : location
      if (url.pathname === "/api/location") return json(here)
      if (url.pathname === "/api/agent")
        return json({ location: here, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location: here, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: ["first", "second"].map((id) => ({
            id,
            providerID: "demo",
            name: `${id} model`,
            variants: [],
            limit: { context: 1000, output: 100 },
            cost: [],
            time: { released: 0 },
          })),
        })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  const line = async (matches: (frame: string) => boolean) => {
    // Starting the command takes a moment, so wait by the clock and not by render passes.
    const started = Date.now()
    while (!matches(setup.captureCharFrame())) {
      if (Date.now() - started > 8_000)
        throw new Error(
          `The line never matched (ran ${(await Bun.file(counter).exists()) ? await Bun.file(counter).text() : "never"}):\n${setup.captureCharFrame()}`,
        )
      await Bun.sleep(50)
      await setup.renderOnce()
    }
    return (
      setup
        .captureCharFrame()
        .split("\n")
        .find((row) => row.includes(" n=")) ?? ""
    )
  }
  const first = await line((frame) => frame.includes("m=first") && frame.includes("p=/"))
  expect(first).toContain(`p=${projectDirectory} c=${projectDirectory}`)
  const runs = (row: string) => Number(row.match(/ n=(\d+)/)?.[1])

  // The selection changes the line before anything is sent.
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame((frame) => frame.includes("Select model"))
  await setup.mockInput.typeText("second")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  const selected = await line((frame) => frame.includes("m=second"))
  expect(runs(selected)).toBeGreaterThan(runs(first))

  // Let the runs that the selection caused finish, so that the next one can only come from the event.
  await Bun.sleep(1_200)
  const settled = (await Bun.file(counter).text()).length
  await Bun.sleep(500)
  expect((await Bun.file(counter).text()).length).toBe(settled)

  // This session's step end runs the command again; the interval is a minute, so nothing else would.
  setup.events.emit({
    id: "evt_step",
    created: 1,
    type: "session.step.ended",
    data: { sessionID: session.id },
  } as never)
  await line((frame) => frame.includes(`n=${settled + 1}`))
}, 20_000)
