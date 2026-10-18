import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "path"

// FU-M3-092: the idle reminder is Orbit's own sentence. The retired sentence is data here, and the scan reads every
// source file of the package, so restoring it anywhere fails the test.
const retired = "waiting for your input"
const current = "The session has stopped and the next step is yours"
const source = path.join(import.meta.dir, "..", "src")

describe("idle reminder wording", () => {
  test("no source file of the terminal UI carries the retired sentence", async () => {
    const files = Array.from(new Glob("**/*.{ts,tsx}").scanSync({ cwd: source }))
    expect(files.length).toBeGreaterThan(100)
    const hits = (
      await Promise.all(files.map(async (file) => ((await Bun.file(path.join(source, file)).text()).includes(retired) ? file : "")))
    ).filter((file) => file !== "")
    expect(hits).toEqual([])
  })

  test("the idle notification says the current sentence", async () => {
    expect(await Bun.file(path.join(source, "attention-events.ts")).text()).toContain(`message: "${current}"`)
  })
})

describe("editor notes of the prompt", () => {
  // The notes for an opened file and for selected lines are Orbit's own wording (M5 of prompts-context-19). The retired
  // phrases are data, so putting one back fails the test.
  const retiredNotes = [/may or may not be relevant/, /Note: The user opened the file/, /Note: The user selected/]

  test("the prompt keeps the retired editor notes out and carries the current ones", async () => {
    const text = await Bun.file(path.join(source, "component", "prompt", "index.tsx")).text()
    retiredNotes.forEach((pattern) => expect(text).not.toMatch(pattern))
    expect(text).toContain("Editor state, given as background and not as a request")
    expect(text).toContain("is highlighted")
    expect(text).toContain("it may have nothing to do with the task")
  })
})
