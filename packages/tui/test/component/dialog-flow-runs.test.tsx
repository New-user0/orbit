import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { Store } from "@orbit/flow"
import fs from "node:fs/promises"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"
import { DialogFlowRuns } from "../../src/component/dialog-flow-runs"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

test("lists runs, opens a run's nodes, and approves a waiting gate", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tui-flow-"))
  const store = Store.at(directory)
  store.create({ id: "run_tui", workflow: "release", file: "release.ts", directory, input: {} })
  store.append("run_tui", "build", "node.started", { key: "k" })
  store.append("run_tui", "build", "node.succeeded", { key: "k", result: { usage: { input: 900, output: 100 } } })
  store.append("run_tui", "ship", "gate.pending", { message: "Ship it?" })
  store.status("run_tui", "waiting")
  store.close()

  await using setup = await renderLocal({
    directory,
    fetch: async (url) =>
      url.pathname === "/api/location"
        ? json({ directory, project: { id: "proj_test", directory, canonical: directory } })
        : undefined,
  })
  const focused = async () => {
    if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
      await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  }
  setup.dialog.replace(() => <DialogFlowRuns />)
  await setup.waitForFrame((frame) => frame.includes("Orbit Flow runs") && frame.includes("? release"))
  await focused()
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("run_tui") && frame.includes("? ship") && frame.includes("✓ build"),
  )
  expect(setup.captureCharFrame()).toContain("1000 tokens")
  await focused()
  await setup.mockInput.typeText("ship")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("ship: Ship it?") && frame.includes("Approve with a note"))
  await focused()
  setup.mockInput.pressEnter()
  // After the decision the dialog returns to the run, where the gate now shows as decided.
  await setup.waitForFrame((frame) => frame.includes("✓ ship") && frame.includes("✓ build"))

  const after = Store.at(directory)
  expect(after.nodes("run_tui").get("ship")).toMatchObject({ status: "succeeded", result: { approved: true } })
  after.close()
  await fs.rm(directory, { recursive: true, force: true })
})
