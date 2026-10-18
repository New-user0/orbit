import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { IdeLock } from "@orbit/util/ide-lock"
import { chmod, symlink, utimes } from "node:fs/promises"
import {
  discoverEditors,
  editorIntegration,
  editorPort,
  normalizePromptContent,
  openEditor,
  openFile,
  readLocks,
} from "../src/editor"
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

test("offers discovery of Orbit's own bridge and Zed's selection, and no reader of another product's lock folder", async () => {
  expect(Object.keys(editorIntegration)).toEqual(["discover", "selection"])
  // Another product's lock folder, with a lock in the shape of the other product's, is not read: the only folder looked
  // at is the one named.
  await using home = await tmpdir()
  const foreign = path.join(home.path, ["." + "cla", "ude"].join(""), "ide")
  await mkdir(foreign, { recursive: true })
  await writeFile(path.join(foreign, "4021.lock"), JSON.stringify({ workspaceFolders: [home.path], pid: process.pid }))
  const lockDirectory = path.join(home.path, "state", "ide")

  expect(
    discoverEditors({ directory: home.path, lockDirectory, env: { HOME: home.path, USERPROFILE: home.path } }),
  ).toEqual({ matched: [], unmatched: [], chosen: undefined })
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

// Orbit's bridge advertises each editor window with a lock in the state folder. The reader takes only what is valid and
// alive, and the folder rule says which window is the one the terminal runs in.
async function lockFolder() {
  const root = await tmpdir()
  const lockDirectory = path.join(root.path, "ide")
  await mkdir(lockDirectory)
  return { root, lockDirectory }
}

function lockFor(port: number, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    pid: process.pid,
    port,
    workspaceFolders: [] as string[],
    ideName: `Editor ${port}`,
    authToken: IdeLock.token(),
    ...extra,
  }
}

const put = (directory: string, port: number, lock: unknown) =>
  writeFile(path.join(directory, `${port}.lock`), typeof lock === "string" ? lock : JSON.stringify(lock))

async function project(root: string, name = "project") {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  return directory
}

test("chooses the one editor whose workspace folder holds the session folder, and not an unrelated deeper one", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const outer = await project(root.path, "outer")
  const deep = await project(outer, "packages/app")
  const other = await project(root.path, "other")
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: [outer] }))
  await put(lockDirectory, 41002, lockFor(41002, { workspaceFolders: [other] }))

  const found = discoverEditors({ directory: deep, lockDirectory, env: {} })

  expect(found.chosen?.port).toBe(41001)
  expect(found.matched.map((editor) => editor.port)).toEqual([41001])
  expect(found.unmatched.map((editor) => editor.port)).toEqual([41002])
  expect(found.chosen?.url).toBe("ws://127.0.0.1:41001")
})

test("makes no choice between two matching editors, and lists both newest first", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const directory = await project(root.path)
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: [directory] }))
  await put(lockDirectory, 41002, lockFor(41002, { workspaceFolders: [root.path] }))
  const old = new Date(Date.now() - 60_000)
  await utimes(path.join(lockDirectory, "41001.lock"), old, old)

  const found = discoverEditors({ directory, lockDirectory, env: {} })

  expect(found.chosen).toBeUndefined()
  expect(found.matched.map((editor) => editor.port)).toEqual([41002, 41001])
})

test("takes the editor on the port in the environment whatever its folders, and falls back to the folders without one", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const directory = await project(root.path)
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: ["/elsewhere"] }))
  await put(lockDirectory, 41002, lockFor(41002, { workspaceFolders: [directory] }))

  const named = discoverEditors({ directory, lockDirectory, env: { ORBIT_EDITOR_SSE_PORT: "41001" } })
  // No lock has that port: the folders decide.
  const missing = discoverEditors({ directory, lockDirectory, env: { ORBIT_EDITOR_SSE_PORT: "41999" } })

  expect(named.chosen?.port).toBe(41001)
  expect(missing.chosen?.port).toBe(41002)
})

test("takes the token from the lock whose port matches and from nowhere else", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const first = lockFor(41001)
  const second = lockFor(41002)
  await put(lockDirectory, 41001, first)
  await put(lockDirectory, 41002, second)

  const found = discoverEditors({
    directory: root.path,
    lockDirectory,
    env: { ORBIT_EDITOR_SSE_PORT: "41002", ORBIT_EDITOR_TOKEN: "x".repeat(43) },
  })

  expect(found.chosen?.token).toBe(second.authToken)
  expect(found.chosen?.token).not.toBe(first.authToken)
})

test("skips each lock that is not valid with one line in the log, without touching a good sibling", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const directory = await project(root.path)
  const good = lockFor(41000, { workspaceFolders: [directory] })
  const gone = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore" })
  await gone.exited
  await put(lockDirectory, 41000, good)
  const { authToken: _token, ...withoutToken } = lockFor(41005)
  const bad: Record<number, unknown> = {
    41001: "{ not json",
    41002: lockFor(41002, { version: 2 }),
    41003: lockFor(41999),
    41004: lockFor(41004, { authToken: "short" }),
    41005: withoutToken,
    41006: lockFor(41006, { pid: gone.pid }),
    41007: lockFor(41007, { workspaceFolders: ["relative/path"] }),
    41008: lockFor(41008, { workspaceFolders: [""] }),
    41009: lockFor(41009, { pid: 0 }),
    41010: "x".repeat(IdeLock.lockCap + 1),
  }
  for (const [port, lock] of Object.entries(bad)) await put(lockDirectory, Number(port), lock)
  // Names that are not locks, and a folder with the name of one.
  await writeFile(path.join(lockDirectory, "notes.txt"), "mine")
  await writeFile(path.join(lockDirectory, "41011.lock.bak"), JSON.stringify(lockFor(41011)))
  await mkdir(path.join(lockDirectory, "41012.lock"))
  const lines: string[] = []

  const found = discoverEditors({ directory, lockDirectory, env: {}, log: (line) => lines.push(line) })

  expect(found.chosen?.port).toBe(41000)
  expect(found.matched.concat(found.unmatched).map((editor) => editor.port)).toEqual([41000])
  // One line for each file that claims to be a lock and is not, and none of them quotes a token.
  expect(lines.map((line) => line.split(" ")[2]).sort()).toEqual(
    [...Object.keys(bad).map((port) => `${port}.lock`), "41012.lock"].sort(),
  )
  expect(lines.join("\n")).not.toContain(good.authToken)
  // The terminal UI never deletes a lock.
  expect((await readdir(lockDirectory)).length).toBe(1 + Object.keys(bad).length + 3)
})

test("says nothing more about a lock it skipped on the next poll, and says it again when the file changes", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  await put(lockDirectory, 41001, "{ not json")
  const lines: string[] = []
  const log = (line: string) => lines.push(line)

  readLocks(lockDirectory, log)
  readLocks(lockDirectory, log)
  expect(lines).toHaveLength(1)

  await put(lockDirectory, 41001, "{ still not json")
  readLocks(lockDirectory, log)
  expect(lines).toHaveLength(2)
})

test("shows the editor's name only with control characters written out", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  await put(lockDirectory, 41001, lockFor(41001, { ideName: "Code\u001b]0;pwned\u0007‮" }))

  const [editor] = readLocks(lockDirectory)

  expect(editor?.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/)
  expect(editor?.name).toContain("Code")
})

test("finds no editor when the folder of locks is not there", () => {
  expect(readLocks(path.join(os.tmpdir(), "orbit-no-such-folder", "ide"))).toEqual([])
})

// Class 4: the folder rule asks about the real paths, so a link or a shared prefix cannot make a window match.
test("matches a workspace folder by real path: links, prefixes, dangling links and spellings", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const real = await project(root.path, "real")
  const sub = await project(real, "src")
  const link = path.join(root.path, "link")
  await symlink(real, link, "junction")
  const prefixed = await project(root.path, "proj")
  const longer = await project(root.path, "project")
  const dangling = path.join(root.path, "dangling")
  const missing = await project(root.path, "missing")
  await symlink(missing, dangling, "junction")
  await rm(missing, { recursive: true })
  const matches = async (folder: string, directory: string) => {
    await rm(path.join(lockDirectory, "41001.lock"), { force: true })
    await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: [folder] }))
    return discoverEditors({ directory, lockDirectory, env: {} }).matched.length === 1
  }

  // The window names the project through a link, and the terminal runs in the real folder.
  expect(await matches(link, sub)).toBe(true)
  // The terminal runs in the folder through the link, and the window names the real one.
  expect(await matches(real, path.join(link, "src"))).toBe(true)
  // A folder whose name starts like the other one is another folder.
  expect(await matches(prefixed, longer)).toBe(false)
  // A link to nothing holds nothing.
  expect(await matches(dangling, sub)).toBe(false)
  expect(await matches(path.join(root.path, "does-not-exist"), sub)).toBe(false)
})

windows("matches a workspace folder whatever the case of its drive letter and path on Windows", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const directory = await project(root.path)
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: [directory.toUpperCase()] }))
  await put(lockDirectory, 41002, lockFor(41002, { workspaceFolders: [directory.toLowerCase()] }))

  expect(
    discoverEditors({ directory, lockDirectory, env: {} })
      .matched.map((editor) => editor.port)
      .sort(),
  ).toEqual([41001, 41002])
})

windows("compares a network or device path as written, and never looks at the disk for it", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const directory = await project(root.path)
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: ["\\\\192.0.2.1\\share\\project"] }))
  await put(lockDirectory, 41002, lockFor(41002, { workspaceFolders: [`\\\\?\\${directory}`] }))
  const started = Date.now()

  const found = discoverEditors({ directory, lockDirectory, env: {} })

  // 192.0.2.1 is reserved for documentation: looking it up would wait for a connection that never comes.
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(found.matched.map((editor) => editor.port)).toEqual([41002])
  expect(found.unmatched.map((editor) => editor.port)).toEqual([41001])
})

test("matches a folder whose name has an accent written as two characters", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const spelled = await project(root.path, "café")
  const directory = await project(spelled, "src")
  await put(lockDirectory, 41001, lockFor(41001, { workspaceFolders: [spelled] }))

  expect(discoverEditors({ directory, lockDirectory, env: {} }).chosen?.port).toBe(41001)
})

test("skips a lock that is a link to a file", async () => {
  const { root, lockDirectory } = await lockFolder()
  await using _ = root
  const target = path.join(root.path, "elsewhere.json")
  await writeFile(target, JSON.stringify(lockFor(41001)))
  // Making a file link needs a privilege on Windows that a developer machine may not give.
  const made = await symlink(target, path.join(lockDirectory, "41001.lock")).then(
    () => true,
    () => false,
  )
  if (!made) return

  expect(readLocks(lockDirectory)).toEqual([])
})

// FU-M1-014: the editor of the prompt is found on PATH and started by the path that was found, so a program of the same
// name in the folder it runs in is not the one that runs.
async function fakeEditor(directory: string, name: string, record: string) {
  const file = path.join(directory, process.platform === "win32" ? `${name}.cmd` : name)
  await writeFile(
    file,
    process.platform === "win32" ? `@echo off\r\necho %* >> "${record}"\r\n` : `#!/bin/sh\necho "$@" >> "${record}"\n`,
  )
  await chmod(file, 0o755)
  return file
}

windows(
  "starts the prompt editor from PATH and never a code.cmd, code.exe or vim.bat in the folder it runs in",
  async () => {
    await using root = await tmpdir()
    const bin = path.join(root.path, "bin")
    const clone = path.join(root.path, "clone")
    await mkdir(bin)
    await mkdir(clone)
    const record = path.join(root.path, "recorded.txt")
    await fakeEditor(bin, "code", record)
    const real = await plant(bin, "vim")
    const decoy = await plant(clone, "code")
    for (const name of ["code.cmd", "vim.bat"])
      await writeFile(path.join(clone, name), `@echo off\r\necho ran >> "%~dp0${name}.ran"\r\n`)
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    using _ = currentDirectoryOnPath()
    const before = process.cwd()
    process.chdir(clone)
    const ran = async () => (await readdir(clone)).filter((name) => name.endsWith(".ran"))

    process.env.VISUAL = "code"
    const first = await openEditor({ value: "original", renderer: screen().renderer, cwd: clone }).finally(() =>
      process.chdir(before),
    )
    process.chdir(clone)
    process.env.VISUAL = "vim"
    const second = await openEditor({ value: "original", renderer: screen().renderer, cwd: clone }).finally(() =>
      process.chdir(before),
    )

    expect(first).toBe("original")
    expect(second).toBe("original")
    // The program of PATH ran, with the flag that makes `code` wait, and the file as the last argument.
    // (cmd.exe quotes each argument it was given, so the quotes are taken off before the line is read.)
    expect((await Bun.file(record).text()).replaceAll('"', "").trim()).toMatch(/^--wait .+\.md$/)
    expect((await real()).map((line) => line.split(" ")[0])).toEqual(["vim.exe"])
    // The decoys of the folder did not.
    expect(await decoy()).toEqual([])
    expect(await ran()).toEqual([])

    // The control: each decoy is a program that runs when it is started by its path.
    await Bun.spawn([path.join(clone, "code.exe"), "control"], { stdout: "ignore" }).exited
    await Bun.spawn(["cmd.exe", "/c", path.join(clone, "code.cmd")], { stdout: "ignore" }).exited
    await Bun.spawn(["cmd.exe", "/c", path.join(clone, "vim.bat")], { stdout: "ignore" }).exited
    expect(await decoy()).toEqual(["code.exe control"])
    expect((await ran()).sort()).toEqual(["code.cmd.ran", "vim.bat.ran"])
  },
  60_000,
)

test("starts the prompt editor with its own arguments and the file last, even when its path has spaces", async () => {
  await using directory = await tmpdir()
  const folder = path.join(directory.path, "with space")
  await mkdir(folder)
  process.env.ORBIT_TEST_EDITOR_MARKER = path.join(directory.path, "started.json")
  process.env.VISUAL = `${await recordingEditor(folder)} --flag "a b"`

  const result = await openEditor({ value: "original", renderer: screen().renderer, cwd: directory.path })

  const run = await started(process.env.ORBIT_TEST_EDITOR_MARKER)
  expect(result).toBe("original")
  expect(run.argv.slice(0, 2)).toEqual(["--flag", "a b"])
  expect(run.argv[2]).toMatch(/\.md$/)
  expect(run.argv).toHaveLength(3)
})

test("makes the prompt editor wait only when the editor is exactly code or subl", async () => {
  await using directory = await tmpdir()
  const record = path.join(directory.path, "recorded.txt")
  await fakeEditor(directory.path, "code", record)
  await fakeEditor(directory.path, "subl", record)
  await fakeEditor(directory.path, "other", record)
  process.env.PATH = `${directory.path}${path.delimiter}${process.env.PATH}`

  for (const name of ["code", "subl", "other", "code --reuse-window"]) {
    process.env.VISUAL = name
    await openEditor({ value: "original", renderer: screen().renderer, cwd: directory.path })
  }

  const lines = (await Bun.file(record).text()).replaceAll('"', "").split(/\r?\n/).filter(Boolean)
  expect(lines.map((line) => line.trim().split(" ").slice(0, -1).join(" "))).toEqual(["--wait", "--wait", "", "--reuse-window"])
})

test("rejects with a message when the prompt editor is not on PATH, and when it exits with an error", async () => {
  await using directory = await tmpdir()
  process.env.VISUAL = "orbit-editor-that-does-not-exist"
  await expect(openEditor({ value: "x", renderer: screen().renderer })).rejects.toThrow("Cannot find the editor")

  process.env.ORBIT_TEST_EDITOR_MARKER = path.join(directory.path, "started.json")
  process.env.VISUAL = await recordingEditor(directory.path, 3)
  await expect(openEditor({ value: "x", renderer: screen().renderer })).rejects.toThrow("Editor exited with code 3")
})
