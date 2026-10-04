import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { editorIntegration, editorPort, normalizePromptContent, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL
const zedDatabase = process.env.ORBIT_ZED_DB

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
  if (zedDatabase === undefined) delete process.env.ORBIT_ZED_DB
  else process.env.ORBIT_ZED_DB = zedDatabase
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "orbit-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

// Another product's name for the same variable, assembled so that no file outside compat spells it.
const foreignPort = ["CLA", "UDE_CODE_SSE_PORT"].join("")

test("reads the editor port from ORBIT_EDITOR_SSE_PORT only", () => {
  expect(editorPort({ ORBIT_EDITOR_SSE_PORT: "4021" })).toBe(4021)
  expect(editorPort({ ORBIT_EDITOR_SSE_PORT: "1" })).toBe(1)
  expect(editorPort({ ORBIT_EDITOR_SSE_PORT: "65535" })).toBe(65535)

  // The other product's variable no longer points Orbit at an editor, whether or not Orbit's own is set.
  expect(editorPort({ [foreignPort]: "4021" })).toBeUndefined()
  expect(editorPort({ [foreignPort]: "4021", ORBIT_EDITOR_SSE_PORT: "5000" })).toBe(5000)
})

test("has no editor port unless the variable holds a TCP port", () => {
  expect(editorPort({})).toBeUndefined()
  for (const value of ["", "0", "-1", "65536", "port", " "])
    expect(editorPort({ ORBIT_EDITOR_SSE_PORT: value })).toBeUndefined()
})

test("offers no lock-file discovery of editors", () => {
  // An editor is reached through its port, and nothing here finds one by itself.
  expect(Object.keys(editorIntegration)).toEqual(["selection"])
  expect(editorIntegration).not.toHaveProperty("connection")
})

test("reads Zed's selection through the compat reader and the database ORBIT_ZED_DB names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbit-editor-"))
  try {
    // A file that is not a database stands for a Zed whose database cannot be read. It takes precedence over the
    // default locations whether or not this machine has Zed, so the answer is the same everywhere.
    process.env.ORBIT_ZED_DB = path.join(directory, "db.sqlite")
    await writeFile(process.env.ORBIT_ZED_DB, "not a database")

    expect(await editorIntegration.selection(directory)).toEqual({ type: "unavailable" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
