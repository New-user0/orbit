import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
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

  test("runs nothing beside others when the Windows Path ends in a separator", async () => {
    expect(await answer("ls", { ...windows, env: { Path: "C:\\Windows\\System32;" } })).toBe(false)
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

