import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ShellAnalysis } from "@orbit/core/shell/analysis"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { ShellTool } from "@orbit/core/tool/plugin/shell"

let parses = 0
const parser = PowerShellParse.Service.of({
  parse: () => Effect.sync(() => parses++).pipe(Effect.andThen(Effect.die("the PowerShell parser must not start"))),
})

type Ctx = Parameters<typeof ShellTool.concurrent>[1]

const linux = {
  shell: "/bin/bash",
  platform: "linux",
  path: path.posix,
  home: "/home/test",
  cwd: "/work",
  env: { PATH: "/usr/bin:/bin" },
  local: () => false,
} satisfies Ctx

const windows = {
  ...linux,
  shell: "C:\\Program Files\\Git\\bin\\bash.exe",
  platform: "win32",
  path: path.win32,
  home: "C:\\Users\\test",
  cwd: "C:\\work",
  env: { Path: "C:\\Windows\\System32" },
} satisfies Ctx

const answer = (command: string, ctx: Ctx) =>
  Effect.runPromise(ShellTool.concurrent(command, ctx).pipe(Effect.provideService(PowerShellParse.Service, parser)))

describe("ShellTool.concurrent", () => {
  const yes = [
    "ls",
    "ls -la",
    "git status",
    "git log --oneline -5",
    "cat README.md | grep foo",
    "ls && echo done",
    "find . -name '*.ts'",
    "sed -n 1p a.txt",
    "ls > /dev/null",
    "git status 2>&1",
    "cd src",
    "sleep 1",
  ]
  const no = [
    "touch x",
    "rm -rf x",
    "echo hi > out.txt",
    "sed -i s/a/b/ a.txt",
    "find . -delete",
    "ls; rm x",
    "cd src && ls",
    "cd src && git status",
    "ls *.ts",
    "ls $HOME",
    'echo "$(ls)"',
    "git -c core.pager=x log",
    "npm test",
    "printenv",
    "FOO=1 ls",
    "",
    "   ",
    "ls " + "a".repeat(10_001),
  ]

  test.each(yes)("runs %p beside other calls", async (command) => {
    expect(await answer(command, linux)).toBe(true)
  })

  test.each(no)("runs %p alone", async (command) => {
    expect(await answer(command, linux)).toBe(false)
  })

  test.each(["/usr/bin:", "/usr/bin::/bin", ".:/usr/bin", "bin:/usr/bin"])(
    "runs nothing beside others when PATH is %p",
    async (PATH) => {
      expect(await answer("ls", { ...linux, env: { PATH } })).toBe(false)
    },
  )

  test.each(["ls", "git status"])("runs %p beside others under Git Bash on Windows", async (command) => {
    expect(await answer(command, windows)).toBe(true)
  })

  test.each(["ls '\\\\server\\share'", "ls //server/share"])("runs the share path %p alone on Windows", async (command) => {
    expect(await answer(command, windows)).toBe(false)
  })

  // FU-M3-180: Git Bash drops an empty entry, so a Path that ends in a separator does not make a command unsafe to overlap.
  test("runs beside others when the Windows Path ends in a separator", async () => {
    expect(await answer("ls", { ...windows, env: { Path: "C:\\Windows\\System32;" } })).toBe(true)
  })

  test("runs nothing beside others when the Windows Path holds a relative entry", async () => {
    expect(await answer("ls", { ...windows, env: { Path: "C:\\Windows\\System32;.;" } })).toBe(false)
  })

  const others = [
    ["pwsh", linux],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", windows],
    ["C:\\Windows\\System32\\cmd.exe", windows],
  ] as const
  test.each(others)("answers false for %p without starting a parser", async (shell, base) => {
    const before = parses
    for (const command of ["Get-ChildItem", "ls", "Get-Content a.txt", "dir"])
      expect(await answer(command, { ...base, shell })).toBe(false)
    expect(parses).toBe(before)
  })
})

describe("ShellTool.destructive", () => {
  test.each([
    ["rm -rf x", true],
    ['rm -rf "x', true],
    ["ls", false],
    ["git status", false],
    ["git rm -rf x", false],
  ])("bash: %p is %p", (command, expected) => {
    expect(ShellTool.destructive(command, linux)).toBe(expected)
  })

  test("is read from the text, so it does not follow the read-only verdict", () => {
    expect(ShellTool.destructive('echo "DROP TABLE users"', linux)).toBe(true)
  })

  test.each([
    ["Remove-Item -Recurse -Force x", true],
    ["Get-ChildItem", false],
  ])("PowerShell: %p is %p, without starting the parser", (command, expected) => {
    const before = parses
    const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    expect(ShellTool.destructive(command, { ...windows, shell })).toBe(expected)
    expect(ShellTool.destructive(command, { ...linux, shell: "pwsh" })).toBe(expected)
    expect(parses).toBe(before)
  })

  test.each(["dir", "echo hi", "Get-ChildItem"])("cmd and an unrecognised shell: %p is destructive", (command) => {
    expect(ShellTool.destructive(command, { ...windows, shell: "C:\\Windows\\System32\\cmd.exe" })).toBe(true)
    expect(ShellTool.destructive(command, { ...linux, shell: "/usr/bin/fish" })).toBe(true)
  })
})


// The model's workdir is resolved before any permission question, so a share or device spelling must not be opened to
// decide scheduling (class 4 and 6, task permissions-23). The file system call is watched, not the answer's speed.
describe("ShellTool.concurrent with a workdir that names a share or a device", () => {
  const spellings = [
    "\\\\example.invalid\\share\\",
    "//example.invalid/share",
    "\\\\?\\UNC\\example.invalid\\share",
    "\\\\.\\UNC\\example.invalid\\share",
    "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\",
    "\\\\.\\pipe\\probe",
    "\\\\localhost\\C$\\Windows",
    "\\\\127.0.0.1\\C$\\Windows",
    "\\\\example.invalid@8765\\x\\",
  ]

  test.each(spellings)("%p is answered false and no disk call names it", async (cwd) => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-share-"))
    try {
      for (const name of ["ls", "ls.exe"]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 })
      const watched: string[] = []
      const record = (name: "existsSync" | "realpathSync" | "statSync" | "lstatSync") => {
        const original = fs[name] as (...args: unknown[]) => unknown
        const spy = spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
          watched.push(String(args[0]))
          return original(...args)
        }) as never)
        return spy
      }
      const spies = [record("existsSync"), record("statSync"), record("lstatSync"), record("realpathSync")]
      const ctx = { ...windows, cwd, env: { Path: bin }, local: undefined } satisfies Ctx
      try {
        expect(await answer("ls", ctx)).toBe(false)
        const inspected = await Effect.runPromise(
          ShellAnalysis.inspect("ls", ctx).pipe(Effect.provideService(PowerShellParse.Service, parser)),
        )
        expect(inspected.readOnly).toBe(false)
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
      expect(watched.filter((file) => file.startsWith("\\\\") || file.startsWith("//"))).toEqual([])
    } finally {
      fs.rmSync(bin, { recursive: true, force: true })
    }
  })
})

// The same question when the share is not typed but named by a link of the repository: the workdir is the link, or a
// path below it. Only `readlink` may run on the way; a call that opens the link or anything below it would connect to the
// host (class 4 and 6). The links need Developer Mode on Windows and fail visibly without it. Other hosts have no such
// links to read, so the rows are Windows only. Trust does not enter: the check takes no trust, so one run covers both.
describe("ShellTool.concurrent with a workdir that reaches a share through a link", () => {
  const targets = [
    "\\\\example.invalid\\share\\",
    "//example.invalid/share",
    "\\\\?\\UNC\\example.invalid\\share",
    "\\\\.\\UNC\\example.invalid\\share",
    "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\",
    "\\\\.\\pipe\\probe",
    "\\\\localhost\\C$\\Windows",
    "\\\\127.0.0.1\\C$\\Windows",
    "\\\\example.invalid@8765\\x\\",
  ]
  const places: ("the link itself" | "a path below the link")[] = ["the link itself", "a path below the link"]

  const watch = (watched: string[]) => {
    const wrap = (name: "existsSync" | "statSync" | "lstatSync" | "realpathSync") => {
      const original = fs[name] as (...args: unknown[]) => unknown
      return spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        watched.push(String(args[0]))
        return original(...args)
      }) as never)
    }
    // A spy on `realpathSync` hides its `native` member, which the code under test calls, so it is put back.
    const native = fs.realpathSync.native
    const spies = [wrap("existsSync"), wrap("statSync"), wrap("lstatSync"), wrap("realpathSync")]
    Object.assign(fs.realpathSync, {
      native: (...args: [string]) => {
        watched.push(String(args[0]))
        return native(...args)
      },
    })
    return spies
  }

  const run = async (target: string | undefined, place: (typeof places)[number]) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbit-share-link-")))
    try {
      const bin = path.join(root, "bin")
      fs.mkdirSync(bin)
      for (const name of ["ls", "ls.exe"]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 })
      const link = path.join(root, "linked")
      const destination = path.join(root, "real")
      fs.mkdirSync(path.join(destination, "sub"), { recursive: true })
      // No target: the control link, to a folder on this disk.
      fs.symlinkSync(target ?? destination, link, "dir")
      const cwd = place === "the link itself" ? link : path.join(link, "sub")
      const watched: string[] = []
      const spies = watch(watched)
      try {
        const ctx = { ...windows, cwd, env: { Path: bin }, local: undefined } satisfies Ctx
        const scheduled = await answer("ls", ctx)
        const inspected = await Effect.runPromise(
          ShellAnalysis.inspect("ls", ctx).pipe(Effect.provideService(PowerShellParse.Service, parser)),
        )
        return { scheduled, readOnly: inspected.readOnly, opened: watched.filter((file) => file.startsWith(link)) }
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const rows = targets.flatMap((target) => places.map((place) => [target, place] as const))
  ;(process.platform === "win32" ? test.each(rows) : test.skip.each(rows))(
    "a link to %p, workdir %p: false, and nothing opens the link",
    async (target, place) => {
      const result = await run(target, place)
      expect(result.scheduled).toBe(false)
      expect(result.readOnly).toBe(false)
      expect(result.opened).toEqual([])
    },
  )

  ;(process.platform === "win32" ? test.each(places) : test.skip.each(places))(
    "a link to a local folder, workdir %p, still schedules a read-only command",
    async (place) => {
      const result = await run(undefined, place)
      expect(result.scheduled).toBe(true)
      expect(result.opened).not.toEqual([])
    },
  )
})
