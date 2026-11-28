import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { editFile, openFile, runProgram } from "../src/editor"
import { tmpdir } from "./fixture/fixture"

// `/ide open` starts the editor's command-line program, and `/agents` opens a file and waits for the editor to close it.
// Both look the program up on PATH alone and start it by the path that was found (class 10).

const search = process.env.PATH
const visual = process.env.VISUAL
const editor = process.env.EDITOR

afterEach(() => {
  process.env.PATH = search
  for (const [name, value] of [
    ["VISUAL", visual],
    ["EDITOR", editor],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const windows = process.platform === "win32" ? test : test.skip

// A program that writes down its arguments and exits with the code it is given.
async function fake(directory: string, name: string, record: string, code = 0) {
  const file = path.join(directory, process.platform === "win32" ? `${name}.cmd` : name)
  await writeFile(
    file,
    process.platform === "win32"
      ? `@echo off\r\necho %* >> "${record}"\r\nexit /b ${code}\r\n`
      : `#!/bin/sh\necho "$@" >> "${record}"\nexit ${code}\n`,
  )
  await chmod(file, 0o755)
}

function screen() {
  return {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  } as never
}

test("runProgram starts the program from PATH with its arguments, in the folder, and says how it ended", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  await mkdir(bin)
  const record = path.join(root.path, "recorded.txt")
  await fake(bin, "orbit-test-code", record)
  process.env.PATH = `${bin}${path.delimiter}${search}`

  expect(await runProgram("orbit-test-code", [root.path], root.path)).toEqual({ type: "exit", code: 0 })
  expect((await Bun.file(record).text()).replaceAll('"', "").trim()).toBe(root.path)
})

test("runProgram reports a non-zero exit, and a program that is not on PATH is never started", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  await mkdir(bin)
  const record = path.join(root.path, "recorded.txt")
  await fake(bin, "orbit-test-fails", record, 3)
  process.env.PATH = `${bin}${path.delimiter}${search}`

  expect(await runProgram("orbit-test-fails", [], root.path)).toEqual({ type: "exit", code: 3 })
  expect(await runProgram("orbit-test-missing-program", [], root.path)).toEqual({ type: "missing" })
})

windows("runProgram never starts a code.cmd or code.exe from the folder it runs in", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  const clone = path.join(root.path, "clone")
  await mkdir(bin)
  await mkdir(clone)
  const record = path.join(root.path, "recorded.txt")
  await fake(bin, "code", record)
  const decoy = await plant(clone, "code")
  const shell = await plant(clone, "cmd")
  await writeFile(path.join(clone, "code.cmd"), '@echo off\r\necho ran >> "%~dp0code.cmd.ran"\r\n')
  process.env.PATH = `${bin}${path.delimiter}${search}`
  using _ = currentDirectoryOnPath()

  expect(await runProgram("code", [clone], clone)).toEqual({ type: "exit", code: 0 })

  expect((await Bun.file(record).text()).replaceAll('"', "").trim()).toBe(clone)
  expect(await decoy()).toEqual([])
  expect(await shell()).toEqual([])
  expect((await readdir(clone)).filter((name) => name.endsWith(".ran"))).toEqual([])
  // The control: the decoy is a program that runs when it is started by its path.
  await Bun.spawn([path.join(clone, "code.exe"), "control"], { stdout: "ignore" }).exited
  expect(await decoy()).toEqual(["code.exe control"])
})

test("openFile with wait adds the flag that makes code stay, and a failing editor is an error", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  await mkdir(bin)
  const record = path.join(root.path, "recorded.txt")
  const file = path.join(root.path, "agent.md")
  await writeFile(file, "x")
  await fake(bin, "code", record)
  process.env.PATH = `${bin}${path.delimiter}${search}`
  process.env.VISUAL = "code"

  expect(await openFile({ file, renderer: screen(), wait: true })).toBe("editor")
  expect((await Bun.file(record).text()).replaceAll('"', "").trim()).toBe(`--wait ${file}`)

  await fake(bin, "code", record, 2)
  const system: string[] = []
  await expect(
    openFile({ file, renderer: screen(), wait: true, system: async (opened) => void system.push(opened) }),
  ).resolves.toBe("system")
  // The editor failed, so the system opener was tried; and without `wait` a failing exit is not looked at.
  expect(system).toEqual([file])
})

// `/memory` opens an instruction file in the person's editor: VISUAL, then EDITOR, then the reference's default (notepad on
// Windows; code, vi or nano elsewhere). Each is looked up on PATH alone and started by the path found, with the file as
// one argument, and a file is never handed to the system opener, which on Windows runs a .bat or .cmd file (class 10).

// A real program that writes down its arguments exactly, as JSON, next to itself.
async function recorder(directory: string, name: string) {
  const file = path.join(directory, process.platform === "win32" ? `${name}.exe` : name)
  const result = await Bun.build({
    entrypoints: ["/recorder.ts"],
    files: {
      "/recorder.ts": `
import { appendFileSync } from "node:fs"
import path from "node:path"
appendFileSync(path.join(path.dirname(process.execPath), ${JSON.stringify(`${name}.args`)}), JSON.stringify(process.argv.slice(2)) + "\\n")
`,
    },
    compile: { outfile: file, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not build the recording program")
  const record = path.join(directory, `${name}.args`)
  return async () =>
    (await Bun.file(record).exists())
      ? (await Bun.file(record).text())
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : []
}

// Batch files (shell scripts elsewhere) of the given names in the folder, each leaving a mark when it runs.
async function batches(directory: string, ...names: string[]) {
  const mark = path.join(directory, "batch-ran.txt")
  await Promise.all(
    names.map((name) =>
      process.platform === "win32"
        ? writeFile(path.join(directory, `${name}.cmd`), `@echo off\r\necho ${name}>> "${mark}"\r\n`)
        : writeFile(path.join(directory, name), `#!/bin/sh\necho ${name} >> "${mark}"\n`, { mode: 0o755 }),
    ),
  )
  return async () => ((await Bun.file(mark).exists()) ? (await Bun.file(mark).text()).trim().split(/\s+/) : [])
}

test("editFile finds VISUAL, EDITOR or the default editor on PATH alone and starts it by the found path", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  const clone = path.join(root.path, "clone")
  await mkdir(bin)
  await mkdir(clone)
  const file = path.join(clone, "AGENTS.md")
  await writeFile(file, "x")
  const fallback = process.platform === "win32" ? "notepad" : "vi"
  const visualRan = await recorder(bin, "orbit-visual")
  const editorRan = await recorder(bin, "orbit-editor")
  const defaultRan = await recorder(bin, fallback)
  // Decoys of every name the chain asks for, in the folder the editor runs in.
  const decoys =
    process.platform === "win32" ? await plant(clone, "notepad", "code", "vi", "orbit-visual", "orbit-editor") : async () => []
  const marked = await batches(clone, "notepad", "code", "vi", "orbit-visual", "orbit-editor")
  using _ = currentDirectoryOnPath()

  process.env.PATH = `${bin}${path.delimiter}${search}`
  process.env.VISUAL = " orbit-visual "
  process.env.EDITOR = "orbit-editor"
  expect(await editFile({ file, renderer: screen() })).toEqual({ source: "VISUAL", editor: "orbit-visual" })
  expect(await visualRan()).toEqual([[file]])

  process.env.VISUAL = "  "
  expect(await editFile({ file, renderer: screen() })).toEqual({ source: "EDITOR", editor: "orbit-editor" })
  expect(await editorRan()).toEqual([[file]])

  delete process.env.VISUAL
  delete process.env.EDITOR
  // Elsewhere the chain is code, vi, nano: with only the folder of fakes on PATH, code is not there and vi is next.
  if (process.platform !== "win32") process.env.PATH = bin
  expect(await editFile({ file, renderer: screen() })).toEqual({ source: "default", editor: fallback })
  expect(await defaultRan()).toEqual([[file]])

  expect(await decoys()).toEqual([])
  expect(await marked()).toEqual([])
  // The control: the decoys are programs that run when they are started by their path.
  if (process.platform === "win32") {
    await Bun.spawn([path.join(clone, "code.exe"), "control"], { stdout: "ignore" }).exited
    expect(await decoys()).toEqual(["code.exe control"])
  }
})

test("editFile never hands a file to the system opener", async () => {
  await using root = await tmpdir()
  const empty = path.join(root.path, "empty")
  const clone = path.join(root.path, "clone")
  await mkdir(empty)
  await mkdir(clone)
  const mark = path.join(clone, "ran.txt")
  const file = path.join(clone, "run.bat")
  await writeFile(file, `@echo off\r\necho ran> "${mark}"\r\n`)
  delete process.env.VISUAL
  delete process.env.EDITOR
  process.env.PATH = empty
  await expect(editFile({ file, renderer: screen() })).rejects.toThrow(/VISUAL|EDITOR/)
  // A system opener starts the file a moment later, so the check waits for it.
  await Bun.sleep(1500)
  expect(await Bun.file(mark).exists()).toBe(false)

  // The control: with an editor on PATH, the same file is opened in it and not run.
  const bin = path.join(root.path, "bin")
  await mkdir(bin)
  const ran = await recorder(bin, "orbit-visual")
  process.env.PATH = bin
  process.env.VISUAL = "orbit-visual"
  expect((await editFile({ file, renderer: screen() })).source).toBe("VISUAL")
  expect(await ran()).toEqual([[file]])
  expect(await Bun.file(mark).exists()).toBe(false)
})

// `code` returns at once unless it is told to wait, and the dialog says the file was opened only once the editor closed.
// An editor that exits with an error is still an editor that opened the file, as the person may simply have quit it.
test("editFile asks code to wait until the file is closed, and an editor that exits with an error still opened it", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  await mkdir(bin)
  const file = path.join(root.path, "AGENTS.md")
  await writeFile(file, "x")
  const ran = await recorder(bin, "code")
  process.env.PATH = `${bin}${path.delimiter}${search}`
  process.env.VISUAL = "code"
  expect(await editFile({ file, renderer: screen() })).toEqual({ source: "VISUAL", editor: "code" })
  expect(await ran()).toEqual([["--wait", file]])

  const record = path.join(root.path, "recorded.txt")
  await fake(bin, "orbit-fails", record, 2)
  process.env.VISUAL = "orbit-fails"
  expect(await editFile({ file, renderer: screen() })).toEqual({ source: "VISUAL", editor: "orbit-fails" })
  expect((await Bun.file(record).text()).replaceAll('"', "").trim()).toBe(file)
})

test("editFile passes the file as one argument whatever its name", async () => {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  const clone = path.join(root.path, "clone")
  await mkdir(bin)
  await mkdir(clone)
  const ran = await recorder(bin, "orbit-visual")
  // A double quote cannot be in a Windows file name; every other character that a shell would act on can.
  const name = process.platform === "win32" ? `a b&c %PATH% $(x) ^!.md` : `a b&"c" %PATH% $(x) ^!.md`
  const file = path.join(clone, name)
  await writeFile(file, "x")
  process.env.PATH = `${bin}${path.delimiter}${search}`
  process.env.VISUAL = "orbit-visual"
  await editFile({ file, renderer: screen() })
  expect(await ran()).toEqual([[file]])
})
