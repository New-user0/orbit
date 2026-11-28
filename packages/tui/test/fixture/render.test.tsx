/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "path"
import { createSignal, onMount } from "solid-js"
import { testRenderTimed } from "./render"

/** A screen that shows "late" only after `gap` ms in which nothing at all was scheduled to draw. */
async function lateScreen(gap: number) {
  return await testRenderTimed(() => {
    const [text, setText] = createSignal("early")
    onMount(() => {
      setTimeout(() => setText("late"), gap)
    })
    return <text>{text()}</text>
  })
}

test("waitForFrame waits through an idle gap until the predicate holds", async () => {
  const setup = await lateScreen(400)
  try {
    expect(await setup.waitForFrame((frame) => frame.includes("late"))).toContain("late")
  } finally {
    setup.renderer.destroy()
  }
})

test("waitFor waits through an idle gap until the predicate holds", async () => {
  const setup = await lateScreen(400)
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("late"))
  } finally {
    setup.renderer.destroy()
  }
})

// The forced case of the rows that timed out at the old 10 s default: a frame that comes after 11 s is still waited for.
test("a wait that names no limit keeps looking for as long as its row may run", async () => {
  const setup = await lateScreen(11_000)
  try {
    expect(await setup.waitForFrame((frame) => frame.includes("late"))).toContain("late")
  } finally {
    setup.renderer.destroy()
  }
})

test("a wait ends at its time limit, with the error of the last look, when the predicate never holds", async () => {
  const setup = await lateScreen(60_000)
  try {
    const started = Date.now()
    await expect(setup.waitForFrame((frame) => frame.includes("never"), { timeout: 300 })).rejects.toThrow(
      "Timed out waiting for frame predicate",
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    setup.renderer.destroy()
  }
})

test("a predicate that throws fails the wait with its error at the time limit", async () => {
  const setup = await lateScreen(60_000)
  try {
    await expect(
      setup.waitForFrame(
        () => {
          throw new Error("predicate broke")
        },
        { timeout: 200 },
      ),
    ).rejects.toThrow("predicate broke")
  } finally {
    setup.renderer.destroy()
  }
})

test("no test takes its renderer straight from OpenTUI, whose waits end when the renderer is idle", async () => {
  const test = path.join(import.meta.dir, "..")
  const direct = await Array.fromAsync(new Glob("**/*.{ts,tsx}").scan(test)).then((files) =>
    Promise.all(
      files
        .filter((file) => file.replaceAll("\\", "/") !== "fixture/render.ts")
        .map(async (file) => ({ file, text: await Bun.file(path.join(test, file)).text() })),
    ).then((entries) =>
      entries
        .filter(
          (entry) =>
            /import \{[^}]*\btestRender\b[^}]*\} from "@opentui\/solid"/.test(entry.text) ||
            /import \{[^}]*\bcreateTestRenderer\b[^}]*\} from "@opentui\/core\/testing"/.test(entry.text),
        )
        .map((entry) => entry.file),
    ),
  )
  expect(direct).toEqual([])
})
