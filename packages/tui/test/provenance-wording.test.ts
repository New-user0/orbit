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

  // Since m5-quality fix loop 2 the prompt sends the editor's file and selection as its editor field, and the server
  // writes the note (core's request lowering), so the current wording is read there.
  test("the prompt keeps the retired editor notes out and carries the current ones", async () => {
    const prompt = await Bun.file(path.join(source, "component", "prompt", "index.tsx")).text()
    const note = await Bun.file(
      path.join(import.meta.dir, "..", "..", "core", "src", "session", "runner", "to-llm-message.ts"),
    ).text()
    retiredNotes.forEach((pattern) => expect(prompt).not.toMatch(pattern))
    retiredNotes.forEach((pattern) => expect(note).not.toMatch(pattern))
    expect(prompt).toContain("editor: editorField(pendingEditorSelection)")
    expect(note).toContain("Editor state: the file named below is open")
    expect(note).toContain("is highlighted")
    expect(note).toContain("may have nothing to do with the task")
  })
})
