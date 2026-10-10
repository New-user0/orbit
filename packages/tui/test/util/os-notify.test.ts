import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../../core/test/fixture/decoy"
import {
  MACOS_SCRIPT,
  findProgram,
  notifySystem,
  runSystemCommand,
  systemCommand,
  type SystemCommand,
} from "../../src/util/os-notify"

const hostile = [
  `say "hi"`,
  `it's`,
  "back`tick",
  "$(touch marker)",
  "$(New-Item marker)",
  `"; New-Item marker; "`,
  "& calc",
  "| x",
  "%PATH%",
  `-e do shell script "x"`,
  "-e",
  "--",
  "</text><x>",
  "]]>",
  "&amp;",
  "Tschüß 你好 🚀",
]

const find = (name: string) => `/bin/${name}`
const home = "/home/person"
const benign = { title: "Title", message: "Message" }

function build(platform: NodeJS.Platform, input: { title: string; message: string }) {
  return systemCommand({ platform, ...input, find, home })
}

describe("systemCommand: the title and the message are data", () => {
  test.each(hostile)("linux keeps %p as its own argument after --", (text) => {
    for (const input of [
      { title: text, message: "Message" },
      { title: "Title", message: text },
    ]) {
      const command = build("linux", input)!
      const body = input.message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      expect(command.args).toEqual(["--app-name=Orbit", "--", input.title, body])
      expect(command.args.indexOf("--")).toBeLessThan(command.args.indexOf(input.title, 2))
      expect(command.cwd).toBe(home)
    }
  })

  test.each(hostile)("macos keeps %p out of the script, after the fixed first positional", (text) => {
    const fixed = build("darwin", benign)!.args.slice(0, -2)
    for (const input of [
      { title: text, message: "Message" },
      { title: "Title", message: text },
    ]) {
      const command = build("darwin", input)!
      // The script lines are the same for every input, and the three words after them are the only variable part.
      expect(command.args.slice(0, -2)).toEqual(fixed)
      expect(command.args.slice(-3)).toEqual(["orbit", input.title, input.message])
      expect(command.cwd).toBe(home)
      expect(command.args.filter((item) => item === "-e")).toHaveLength(MACOS_SCRIPT.length + (input.title === "-e" ? 1 : 0) + (input.message === "-e" ? 1 : 0))
      expect(command.args.indexOf("orbit")).toBe(MACOS_SCRIPT.length * 2)
    }
  })

  test.each(hostile)("windows keeps %p in the environment and the encoded script constant", (text) => {
    const fixed = build("win32", benign)!.args
    for (const input of [
      { title: text, message: "Message" },
      { title: "Title", message: text },
    ]) {
      const command = build("win32", input)!
      expect(command.args).toEqual(fixed)
      expect(command.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
      expect(command.env).toEqual({ ORBIT_NOTIFY_TITLE: input.title, ORBIT_NOTIFY_MESSAGE: input.message })
      expect(command.cwd).toBe(home)
      // Short texts such as -e occur in any script, so the constant script above is what pins them.
      if (text.length > 4) expect(Buffer.from(command.args[3], "base64").toString("utf16le")).not.toContain(text)
    }
  })

  test.each(["linux", "darwin", "win32"] as const)("%s never goes through a shell", (platform) => {
    hostile.forEach((text) => {
      const command = build(platform, { title: text, message: text })!
      expect(path.basename(command.file).replace(/\.exe$/, "")).not.toMatch(/^(cmd|sh|bash|pwsh)$/)
      expect(command.args).not.toContain("/c")
      expect(command.args).not.toContain("-c")
      expect(command.args).not.toContain("cmd")
      expect(command.args).not.toContain("sh")
    })
  })

  test("windows asks for Windows PowerShell, never pwsh", () => {
    const asked: string[] = []
    systemCommand({ platform: "win32", ...benign, find: (name) => (asked.push(name), null), home })
    expect(asked).toEqual(["powershell"])
  })

  test("has nothing to run on another platform or when the program is missing", async () => {
    expect(systemCommand({ platform: "freebsd", ...benign, find, home })).toBeUndefined()
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(systemCommand({ platform, ...benign, find: () => null, home })).toBeUndefined()
      let started = false
      const shown = await notifySystem(benign, {
        platform,
        find: () => null,
        run: async () => {
          started = true
          return { exitCode: 0, stdout: "" }
        },
      })
      expect(shown).toBe(false)
      expect(started).toBe(false)
    }
  })

  test("counts only an exit status of 0 as shown", async () => {
    const run = (exitCode: number) => async () => ({ exitCode, stdout: "" })
    expect(await notifySystem(benign, { platform: "linux", find, run: run(0) })).toBe(true)
    expect(await notifySystem(benign, { platform: "linux", find, run: run(1) })).toBe(false)
    expect(
      await notifySystem(benign, {
        platform: "linux",
        find,
        run: async () => {
          throw new Error("no daemon")
        },
      }),
    ).toBe(false)
  })
})

describe("live programs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-notify-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test.skipIf(process.platform !== "win32")("windows builds the toast from text nodes, so the message stays text", async () => {
    const marker = path.join(dir, "marker")
    const marker2 = path.join(dir, "marker2")
    const input = {
      title: `Orbit "quoted" & <title>`,
      message: `$(New-Item ${marker}) "; New-Item ${marker2}; " ]]> </text><x/> Tschüß 🚀`,
    }
    const command = systemCommand({ platform: "win32", ...input, find: (name) => findProgram(name), home: os.homedir() })!
    process.env.ORBIT_NOTIFY_DRY = "1"
    try {
      const result = await runSystemCommand(command, 60_000)
      expect(result.exitCode).toBe(0)
      const texts = [...result.stdout.matchAll(/<text>([\s\S]*?)<\/text>/g)].map((match) =>
        match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&"),
      )
      expect(texts).toEqual([input.title, input.message])
    } finally {
      delete process.env.ORBIT_NOTIFY_DRY
    }
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(marker2).exists()).toBe(false)
  }, 60_000)

  test.skipIf(process.platform === "win32")("linux hands exactly the built arguments to notify-send", async () => {
    const bin = path.join(dir, "bin")
    await fs.mkdir(bin)
    const out = path.join(dir, "argv.json")
    await Bun.write(
      path.join(bin, "notify-send"),
      `#!/usr/bin/env bun\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`,
    )
    await fs.chmod(path.join(bin, "notify-send"), 0o755)
    const before = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${before}`
    try {
      const input = { title: "-e", message: "$(touch " + path.join(dir, "marker") + ") <b>&" }
      expect(await notifySystem(input)).toBe(true)
      expect(JSON.parse(await Bun.file(out).text())).toEqual([
        "--app-name=Orbit",
        "--",
        input.title,
        input.message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      ])
      expect(await Bun.file(path.join(dir, "marker")).exists()).toBe(false)
    } finally {
      process.env.PATH = before
    }
  })

  test("a program that never exits is stopped at the time limit, and the attempt fails", async () => {
    const command: SystemCommand = {
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
    }
    const started = Date.now()
    await expect(runSystemCommand(command, 500)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(
      await notifySystem(benign, {
        platform: "linux",
        find: () => command.file,
        run: (next, timeoutMs) => runSystemCommand({ ...command, cwd: next.cwd }, timeoutMs),
        timeoutMs: 500,
      }),
    ).toBe(false)
  }, 30_000)
})

describe("decoys in the working folder", () => {
  let dir: string
  let bin: string
  let cwd: string
  let path0: string | undefined
  let before: string

  beforeEach(async () => {
    before = process.cwd()
    path0 = process.env.PATH
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-decoy-"))
    bin = path.join(dir, "bin")
    cwd = path.join(dir, "work")
    await fs.mkdir(bin)
    await fs.mkdir(cwd)
  })
  afterEach(async () => {
    process.chdir(before)
    process.env.PATH = path0
    await fs.rm(dir, { recursive: true, force: true })
  })

  const names = process.platform === "win32" ? ["powershell"] : ["notify-send", "osascript"]
  const program = process.platform === "win32" ? "powershell" : "notify-send"

  async function decoys(folder: string) {
    if (process.platform === "win32") {
      const ran = await plant(folder, "powershell")
      await Bun.write(path.join(folder, "powershell.bat"), `@echo off\r\necho bat> "%~dp0ran-bat.txt"\r\n`)
      await Bun.write(path.join(folder, "powershell.cmd"), `@echo off\r\necho cmd> "%~dp0ran-cmd.txt"\r\n`)
      return async () => [
        ...(await ran()),
        ...((await Bun.file(path.join(folder, "ran-bat.txt")).exists()) ? ["bat"] : []),
        ...((await Bun.file(path.join(folder, "ran-cmd.txt")).exists()) ? ["cmd"] : []),
      ]
    }
    await Promise.all(
      names.map(async (name) => {
        await Bun.write(path.join(folder, name), `#!/bin/sh\necho ran > "${folder}/ran.txt"\n`)
        await fs.chmod(path.join(folder, name), 0o755)
      }),
    )
    return async () => ((await Bun.file(path.join(folder, "ran.txt")).exists()) ? ["ran"] : [])
  }

  test("a decoy in the working folder is never found or started", async () => {
    using _ = currentDirectoryOnPath()
    const ran = await decoys(cwd)
    process.chdir(cwd)
    process.env.PATH = bin
    expect(findProgram(program)).toBeNull()
    expect(await notifySystem(benign)).toBe(false)
    expect(await ran()).toEqual([])
  }, 60_000)

  test("a relative PATH entry is not searched", async () => {
    using _ = currentDirectoryOnPath()
    const ran = await decoys(cwd)
    process.chdir(cwd)
    for (const entry of [".", ""]) {
      process.env.PATH = `${entry}${path.delimiter}${bin}`
      expect(findProgram(program)).toBeNull()
      expect(await notifySystem(benign)).toBe(false)
    }
    expect(await ran()).toEqual([])
  }, 60_000)

  test("control: the same decoy in a PATH directory is found and started", async () => {
    using _ = currentDirectoryOnPath()
    const ran = await decoys(bin)
    process.chdir(cwd)
    process.env.PATH = bin
    expect(findProgram(program)).not.toBeNull()
    await notifySystem(benign)
    expect((await ran()).length).toBeGreaterThan(0)
  }, 60_000)
})
