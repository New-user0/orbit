import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { openFile, runProgram } from "../src/editor"
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
