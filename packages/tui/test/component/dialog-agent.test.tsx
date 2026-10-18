import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DialogAgent } from "../../src/component/dialog-agent"
import { agent, renderLocal } from "../fixture/local"
import { Toast } from "../../src/ui/toast"
import { json } from "../fixture/tui-client"

// The real dialog, the real client and a recording server: what the dialog says to the server is what is asserted.

async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orbit-agent-dialog-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

const editableAgent = (dir: string) => ({
  ...agent("reviewer"),
  description: "Reviews",
  source: { scope: "project" as const, path: path.join(dir, ".orbit", "agents", "reviewer.md") },
})

function recorder(dir: string) {
  const reported: { search: string; body: unknown }[] = []
  const fetch = async (url: URL, request: Request) => {
    // The fixture server places every session in a folder that is not on this machine.
    if (url.pathname === "/api/location") return json({ directory: dir, project: { id: "proj_test", directory: dir, canonical: dir } })
    if (url.pathname.endsWith("/config/sources/changed")) {
      reported.push({ search: url.search, body: await request.clone().json() })
      return new Response(null, { status: 204 })
    }
  }
  return { reported, fetch }
}

async function until(setup: Awaited<ReturnType<typeof renderLocal>>, text: string) {
  const frame = await setup.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes(text))
  await Bun.sleep(60)
  return frame
}

test("on a server that is not on this machine, Create says it is unavailable and no Edit row appears", async () => {
  await using tmp = await project()
  const { fetch } = recorder(tmp.dir)
  await using setup = await renderLocal({
    directory: tmp.dir,
    url: "http://example.com:4096",
    agents: [editableAgent(tmp.dir)],
    fetch,
  })
  setup.dialog.replace(() => <DialogAgent />)
  const frame = await until(setup, "Select agent")
  expect(frame).toContain("Create agent")
  expect(frame).toContain("Unavailable")
  expect(frame).not.toContain("Edit an agent file")
  // The list opens on the current agent; Create is the row above it. Choosing it does nothing.
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await Bun.sleep(100)
  await setup.renderOnce()
  const after = setup.captureCharFrame()
  expect(after).toContain("Select agent")
  expect(after).not.toContain("where should it live")
})

test("on a server on this machine, both rows appear and Create reports the written file once, without a reload", async () => {
  await using tmp = await project()
  const { reported, fetch } = recorder(tmp.dir)
  await using setup = await renderLocal({
    directory: tmp.dir,
    url: "http://127.0.0.1:4096",
    agents: [editableAgent(tmp.dir)],
    fetch,
  })
  setup.dialog.replace(() => (
    <>
      <DialogAgent />
      <Toast />
    </>
  ))
  const frame = await until(setup, "Select agent")
  expect(frame).toContain("Write a new agent file")
  expect(frame).toContain("Edit an agent file")

  // Create and Edit are the two rows above the current agent.
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await until(setup, "where should it live")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: name")
  await setup.mockInput.typeText("scribe")
  setup.mockInput.pressEnter()
  await until(setup, "system prompt")
  await setup.mockInput.typeText("You write down what was decided, briefly.")
  setup.mockInput.pressEnter()
  await until(setup, "when should it be used")
  await setup.mockInput.typeText("Records decisions")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: tools")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: review")
  setup.mockInput.pressEnter()
  for (let attempt = 0; attempt < 100 && reported.length === 0; attempt++) await Bun.sleep(30)

  const file = path.join(tmp.dir, ".orbit", "agents", "scribe.md")
  expect(await readFile(file, "utf8")).toContain("Records decisions")
  expect(reported).toHaveLength(1)
  expect(reported[0]!.body).toEqual({ paths: [file] })
  expect(new URL(`http://x/${reported[0]!.search}`).searchParams.get("location[directory]")).toBe(tmp.dir)
})
