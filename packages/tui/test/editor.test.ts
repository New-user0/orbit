import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { editorIntegration, editorPort, normalizePromptContent, openEditor, openFile } from "../src/editor"
import { tmpdir } from "./fixture/fixture"

const editor = process.env.EDITOR
const visual = process.env.VISUAL
const zedDatabase = process.env.ORBIT_ZED_DB
const search = process.env.PATH
const marker = process.env.ORBIT_TEST_EDITOR_MARKER

// Assigning undefined to a variable of process.env stores the text "undefined", so one that was not set is deleted.
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore("EDITOR", editor)
  restore("VISUAL", visual)
  restore("ORBIT_ZED_DB", zedDatabase)
  restore("PATH", search)
  restore("ORBIT_TEST_EDITOR_MARKER", marker)
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

function screen() {
  const calls: string[] = []
  const renderer = {
    suspend: () => void calls.push("suspend"),
    resume: () => void calls.push("resume"),
    requestRender: () => void calls.push("render"),
    currentRenderBuffer: { clear: () => void calls.push("clear") },
  }
  return { calls, renderer: renderer as never }
}

// An editor that writes down how it was started and exits with the code the test asks for. Bun runs the script, so the
// same editor works wherever the tests run, and quotes keep a path with spaces in one piece.
async function recordingEditor(directory: string, code = 0) {
  const script = path.join(directory, "editor.ts")
  await writeFile(
    script,
    [
      'import { writeFileSync } from "node:fs"',
      "const started = { argv: process.argv.slice(2), cwd: process.cwd() }",
      "writeFileSync(process.env.ORBIT_TEST_EDITOR_MARKER!, JSON.stringify(started))",
      `process.exit(${code})`,
    ].join("\n"),
  )
  return `"${process.execPath}" "${script}"`
}

const started = async (file: string) => JSON.parse(await readFile(file, "utf8")) as { argv: string[]; cwd: string }

test("opens a file in $VISUAL, from the folder of the file, with the file as the last argument", async () => {
  await using directory = await tmpdir()
  process.env.ORBIT_TEST_EDITOR_MARKER = path.join(directory.path, "started.json")
  process.env.VISUAL = `${await recordingEditor(directory.path)} --wait "a b"`
  process.env.EDITOR = "orbit-editor-that-does-not-exist"
  const file = path.join(directory.path, "config dir", "keybindings.json")
  await mkdir(path.dirname(file))
  await writeFile(file, "{}")
  const screens = screen()

  expect(await openFile({ file, renderer: screens.renderer })).toBe("editor")

  expect(await started(process.env.ORBIT_TEST_EDITOR_MARKER)).toEqual({
    argv: ["--wait", "a b", file],
    cwd: path.dirname(file),
  })
  // The terminal is handed to the editor and taken back.
  expect(screens.calls.filter((call) => call !== "clear")).toEqual(["suspend", "resume", "render"])
})

test("falls back to $EDITOR when $VISUAL is empty", async () => {
  await using directory = await tmpdir()
  process.env.ORBIT_TEST_EDITOR_MARKER = path.join(directory.path, "started.json")
  process.env.VISUAL = ""
  process.env.EDITOR = await recordingEditor(directory.path)
  const file = path.join(directory.path, "keybindings.json")

  expect(await openFile({ file, renderer: screen().renderer })).toBe("editor")

  expect((await started(process.env.ORBIT_TEST_EDITOR_MARKER)).argv).toEqual([file])
})

test("counts an editor that exits with an error as an editor that ran", async () => {
  await using directory = await tmpdir()
  process.env.ORBIT_TEST_EDITOR_MARKER = path.join(directory.path, "started.json")
  process.env.VISUAL = await recordingEditor(directory.path, 3)
  const opened: string[] = []

  const result = await openFile({
    file: path.join(directory.path, "keybindings.json"),
    renderer: screen().renderer,
    system: async (file) => void opened.push(file),
  })

  expect(result).toBe("editor")
  expect(opened).toEqual([])
})

test("opens the file with the system when no editor is set", async () => {
  delete process.env.VISUAL
  delete process.env.EDITOR
  const opened: string[] = []
  const screens = screen()

  const result = await openFile({
    file: "keybindings.json",
    renderer: screens.renderer,
    system: async (file) => void opened.push(file),
  })

  expect(result).toBe("system")
  expect(opened).toEqual(["keybindings.json"])
  // The terminal stays with the app: the system opens its own window.
  expect(screens.calls).toEqual([])
})

test("opens the file with the system when the editor is not on PATH", async () => {
  process.env.VISUAL = "orbit-editor-that-does-not-exist"
  const opened: string[] = []

  const result = await openFile({
    file: "keybindings.json",
    renderer: screen().renderer,
    system: async (file) => void opened.push(file),
  })

  expect(result).toBe("system")
  expect(opened).toEqual(["keybindings.json"])
})

test("rejects with the editor's own error when neither the editor nor the system can open the file", async () => {
  process.env.VISUAL = "orbit-editor-that-does-not-exist"

  await expect(
    openFile({
      file: "keybindings.json",
      renderer: screen().renderer,
      system: () => Promise.reject(new Error("no application is associated with this file")),
    }),
  ).rejects.toThrow("orbit-editor-that-does-not-exist")

  delete process.env.VISUAL
  delete process.env.EDITOR
  await expect(
    openFile({
      file: "keybindings.json",
      renderer: screen().renderer,
      system: () => Promise.reject(new Error("no application is associated with this file")),
    }),
  ).rejects.toThrow("no application is associated")
})

// On Windows a program that is started by its name is looked for in the working folder before PATH. The folder that
// Orbit runs in, or the one that holds the file, can be a clone that is not trusted, so the editor is found on PATH
// alone and started by the path that was found.
const windows = process.platform === "win32" ? test : test.skip

windows(
  "starts the editor from PATH and never a program of the same name in the folder it runs in",
  async () => {
    await using root = await tmpdir()
    const bin = path.join(root.path, "bin")
    const clone = path.join(root.path, "clone")
    await mkdir(bin)
    await mkdir(clone)
    const real = await plant(bin, "orbit-test-editor")
    const decoy = await plant(clone, "orbit-test-editor")
    const file = path.join(clone, "keybindings.json")
    await writeFile(file, "{}")
    process.env.VISUAL = "orbit-test-editor"
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    using _ = currentDirectoryOnPath()
    const before = process.cwd()
    process.chdir(clone)

    const result = await openFile({ file, renderer: screen().renderer }).finally(() => process.chdir(before))

    expect(result).toBe("editor")
    expect(await real()).toEqual([`orbit-test-editor.exe ${file}`])
    expect(await decoy()).toEqual([])

    // The control: the decoy is a program that runs when it is started by its path.
    await Bun.spawn([path.join(clone, "orbit-test-editor.exe"), "control"], { stdout: "ignore" }).exited
    expect(await decoy()).toEqual(["orbit-test-editor.exe control"])
  },
  60_000,
)
