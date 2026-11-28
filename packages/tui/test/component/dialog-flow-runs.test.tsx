import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { InputRenderable } from "@opentui/core"
import { Store } from "@orbit/flow"
import { DialogFlowGate, DialogFlowRuns } from "../../src/component/dialog-flow-runs"
import { useToast } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
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
  // Declared before the renderer, so the folder goes after the renderer and the stores are closed.
  await using dir = await tmpdir()
  const directory = dir.path
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
})

// What a clone's run store can hold in any text it says: an operating system command that sets the title of the window
// and ends with a BEL, a C1 control sequence introducer and a right-to-left override. It is as long as a workflow name
// can be before the dialog cuts it, so the rows that hold two pieces of text use a shorter one.
const sequence = "\u001b]0;x\u0007\u009b\u{202e}"
const sequenceShown = "\\x1b]0;x\\x07\\x9b\\u{202e}"
const evil = "\u001b[2K\u009b"
const shown = "\\x1b[2K\\x9b"

function hostileStore(directory: string) {
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
  return run
}

test("writes out the control characters that a run store holds in the runs and the nodes it lists", async () => {
  await using dir = await tmpdir()
  const directory = dir.path
  const run = hostileStore(directory)
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
})

test("writes out the control characters of a gate in its dialog, its note prompt and its toasts", async () => {
  await using dir = await tmpdir()
  const directory = dir.path
  const run = hostileStore(directory)
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
})

// Class 3 and 12: the dialog reads and writes the run store of the folder in view only once that folder is trusted, and
// finds it no higher than the project's folder the server resolved. A store in a repository above that folder, and one
// in a folder that is not trusted, are not listed and not decided; the control is the same store reached as the
// project's own, in a trusted folder.
test("reads no run store of an untrusted folder or above the project's folder, and does once both hold", async () => {
  await using dir = await tmpdir()
  const above = dir.path
  const directory = path.join(above, "inner")
  await fs.mkdir(directory, { recursive: true })
  // A repository above the folder in view, which holds a run waiting at a gate.
  await fs.mkdir(path.join(above, ".git", "objects"), { recursive: true })
  await Bun.write(path.join(above, ".git", "HEAD"), "ref: refs/heads/main\n")
  const run = "run_20260101000009_0a1b2c"
  const seeded = Store.at(above)
  seeded.create({ id: run, workflow: "CLONE-ABOVE", file: "w.ts", directory: above, input: {} })
  seeded.append(run, "ship", "gate.pending", { message: "Ship it?" })
  seeded.status(run, "waiting")
  seeded.close()
  const answering = (project: string, trusted: boolean) => async (url: URL) => {
    if (url.pathname === "/api/location")
      return json({ directory, project: { id: "proj_test", directory: project, canonical: project } })
    if (url.pathname === "/api/location/trust")
      return json({ directory: project, trusted, persistent: true, withheld: [], changed: [] })
    return undefined
  }
  const listed = async (project: string, trusted: boolean) => {
    await using setup = await renderLocal({ directory, fetch: answering(project, trusted) })
    setup.dialog.replace(() => <DialogFlowRuns />)
    return (await poll(setup, (frame) => frame.includes("CLONE-ABOVE"), 3_000)) !== undefined
  }
  // Untrusted, with the repository above as the project: nothing is read.
  expect(await listed(above, false)).toBe(false)
  // Trusted, but the project is the folder in view: the store above it is not taken.
  expect(await listed(directory, true)).toBe(false)
  // The control: trusted, with the repository above as the project.
  expect(await listed(above, true)).toBe(true)

  // A gate is not decided in an untrusted folder.
  let toast!: ReturnType<typeof useToast>
  const Gate = () => {
    toast = useToast()
    return <DialogFlowGate run={run} gate="ship" message="Ship it?" />
  }
  await using setup = await renderLocal({ directory, fetch: answering(above, false) })
  setup.dialog.replace(() => <Gate />)
  await frameWhen(setup, (frame) => frame.includes("Approve with a note"))
  await pressUntil(
    setup,
    () => setup.mockInput.pressEnter(),
    () => toast.currentToast !== null,
  )
  expect(toast.currentToast).toMatchObject({ title: "Not decided", message: "This folder is not trusted." })
  const after = Store.at(above)
  expect(after.nodes(run).get("ship")?.status).toBe("waiting")
  after.close()
}, 60_000)
