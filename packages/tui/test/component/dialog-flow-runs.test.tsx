import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { Store } from "@orbit/flow"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DialogFlowGate, DialogFlowRuns } from "../../src/component/dialog-flow-runs"
import { useToast } from "../../src/ui/toast"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

type Setup = Awaited<ReturnType<typeof renderLocal>>

// The first frame that `accepted` takes, or nothing once `timeout` milliseconds have passed. `waitForFrame` gives up
// when the renderer goes idle, which it does while the runs load, so this draws a frame itself every time.
async function poll(setup: Setup, accepted: (frame: string) => boolean, timeout: number) {
  const deadline = Date.now() + timeout
  do {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (accepted(frame)) return frame
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  return undefined
}

async function frameWhen(setup: Setup, accepted: (frame: string) => boolean) {
  const frame = await poll(setup, accepted, 15_000)
  if (frame === undefined) throw new Error(`Timed out waiting for a frame. The last one:\n${setup.captureCharFrame()}`)
  return frame
}

// A dialog takes its keys a moment after its frame is drawn, so a key that was lost is pressed again, as long as it
// leaves the dialog where it was, until `accepted` takes a frame. Each wait is long enough that a key which only took
// its time is not pressed twice.
async function pressUntil(setup: Setup, press: () => void, accepted: (frame: string) => boolean) {
  for (const attempt of [1, 2, 3]) {
    press()
    const frame = await poll(setup, accepted, attempt * 3_000)
    if (frame !== undefined) return frame
  }
  return frameWhen(setup, accepted)
}

// A dialog takes typed text once its search box has the focus, which is a moment after its frame is drawn.
async function focused(setup: Setup) {
  const deadline = Date.now() + 5_000
  while (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a search box to take the focus")
    await setup.renderOnce()
    await Bun.sleep(10)
  }
}

// The renderer writes what a cell holds to the terminal as it is, so no cell may hold a character that acts on one.
// The line breaks are the ones that `captureCharFrame` puts between the rows.
const expectNoControl = (frame: string) => expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)

const located = (directory: string) => async (url: URL) =>
  url.pathname === "/api/location"
    ? json({ directory, project: { id: "proj_test", directory, canonical: directory } })
    : undefined

test("lists runs, opens a run's nodes, and approves a waiting gate", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tui-flow-"))
  // The store lists only IDs in the shape that the runner makes.
  const run = "run_20260101000007_0a1b2c"
  const store = Store.at(directory)
  store.create({ id: run, workflow: "release", file: "release.ts", directory, input: {} })
  store.append(run, "build", "node.started", { key: "k" })
  store.append(run, "build", "node.succeeded", { key: "k", result: { usage: { input: 900, output: 100 } } })
  store.append(run, "ship", "gate.pending", { message: "Ship it?" })
  store.status(run, "waiting")
  store.close()

  await using setup = await renderLocal({ directory, fetch: located(directory) })
  setup.dialog.replace(() => <DialogFlowRuns />)
  await frameWhen(setup, (frame) => frame.includes("Orbit Flow runs") && frame.includes("? release"))
  const nodes = await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    (frame) => frame.includes(run) && frame.includes("? ship") && frame.includes("✓ build"),
  )
  expect(nodes).toContain("1000 tokens")
  // Filtering to the gate leaves it alone in the list.
  await focused(setup)
  await setup.mockInput.typeText("ship")
  await frameWhen(setup, (frame) => frame.includes("? ship") && !frame.includes("✓ build"))
  await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    (frame) => frame.includes("ship: Ship it?") && frame.includes("Approve with a note"),
  )
  // After the decision the dialog returns to the run, where the gate now shows as decided.
  await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    (frame) => frame.includes("✓ ship") && frame.includes("✓ build"),
  )

  const after = Store.at(directory)
  expect(after.nodes(run).get("ship")).toMatchObject({ status: "succeeded", result: { approved: true } })
  after.close()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// What a clone's run store can hold in any text it says: an operating system command that sets the title of the window
// and ends with a BEL, a C1 control sequence introducer and a right-to-left override. It is as long as a workflow name
// can be before the dialog cuts it, so the rows that hold two pieces of text use a shorter one.
const sequence = "\u001b]0;x\u0007\u009b\u{202e}"
const sequenceShown = "\\x1b]0;x\\x07\\x9b\\u{202e}"
const evil = "\u001b[2K\u009b"
const shown = "\\x1b[2K\\x9b"

async function hostileStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tui-flow-hostile-"))
  // The store lists only IDs in the shape that the runner makes, so a clone's run has one.
  const run = "run_20260101000008_0a1b2c"
  const store = Store.at(directory)
  store.create({ id: run, workflow: `flow${sequence}`, file: "w.yaml", directory, input: {} })
  store.append(run, `work${evil}`, "node.started", { key: "k" })
  store.append(run, `work${evil}`, "node.failed", { error: { class: "invalid", message: `failed${evil}` } })
  // The tokens a node used are read from the store as they are, and a clone can make them text.
  store.append(run, `build${evil}`, "node.started", { key: "k" })
  store.append(run, `build${evil}`, "node.succeeded", { key: "k", result: { usage: { input: evil, output: 1 } } })
  store.append(run, `gate${evil}`, "gate.pending", { message: `ship${evil}?` })
  store.status(run, "waiting")
  store.close()
  return { directory, run }
}

test("writes out the control characters that a run store holds in the runs and the nodes it lists", async () => {
  const { directory, run } = await hostileStore()
  await using setup = await renderLocal({ directory, fetch: located(directory) })

  setup.dialog.replace(() => <DialogFlowRuns />)
  const runs = await frameWhen(setup, (frame) => frame.includes("Orbit Flow runs") && frame.includes("? flow"))
  expect(runs).toContain(`? flow${sequenceShown}`)
  expectNoControl(runs)

  const nodes = await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    (frame) => frame.includes(`? gate${shown}`),
  )
  // The gate and its message, the node that failed and the error it failed with, and the node whose tokens are text.
  expect(nodes).toContain(run)
  expect(nodes).toContain(`ship${shown}?`)
  expect(nodes).toContain(`✗ work${shown}`)
  expect(nodes).toContain(`failed${shown}`)
  expect(nodes).toContain(`✓ build${shown}`)
  expect(nodes).toContain("NaN tokens")
  expectNoControl(nodes)
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test("writes out the control characters of a gate in its dialog, its note prompt and its toasts", async () => {
  const { directory, run } = await hostileStore()
  let toast!: ReturnType<typeof useToast>
  const Gate = () => {
    toast = useToast()
    return <DialogFlowGate run={run} gate={`gate${evil}`} message={`ship${evil}?`} />
  }
  await using setup = await renderLocal({ directory, fetch: located(directory) })

  setup.dialog.replace(() => <Gate />)
  const gate = await frameWhen(setup, (frame) => frame.includes("Approve with a note"))
  expect(gate).toContain(`gate${shown}`)
  expect(gate).toContain(`ship${shown}?`)
  expectNoControl(gate)

  // Filtering to the one option that opens the note prompt, so that no arrow key has to land in between.
  await focused(setup)
  await setup.mockInput.typeText("Approve with")
  await frameWhen(setup, (frame) => frame.includes("Approve with a note") && !frame.includes("Reject"))
  const prompt = await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    (frame) => frame.includes(": note"),
  )
  expect(prompt).toContain(`Approve gate${shown}: note`)
  expectNoControl(prompt)

  // An empty note approves the gate, and the toast says which.
  await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    () => toast.currentToast !== null,
  )
  expect(toast.currentToast).toMatchObject({
    title: `Approved gate${shown}`,
    message: `Continue the run with: orb flow resume ${run}`,
    variant: "success",
  })
  expect(toast.currentToast?.title).not.toMatch(/\p{C}/u)

  // The gate is decided now, so deciding it again fails, and what the store says about it is written out too.
  setup.dialog.replace(() => <Gate />)
  await frameWhen(setup, (frame) => frame.includes("Approve with a note") && frame.includes(`gate${shown}`))
  await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    () => toast.currentToast?.title === "Not decided",
  )
  expect(toast.currentToast).toMatchObject({
    message: `gate${shown} is not waiting for a decision`,
    variant: "error",
  })
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
