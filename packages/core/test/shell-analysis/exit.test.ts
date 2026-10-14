import { describe, expect, test } from "bun:test"
import { ShellExit } from "../../src/shell/exit"
import { bash, linux, windows } from "./helper"

// Class 14: a clean PATH and `local: () => false` keep the rows from depending on this machine. The analysis is real
// tree-sitter output; only the context is injected.
const analyse = (command: string, ctx = linux({ local: () => false })) => bash(command, ctx)
const failed = (command: string, exit: number, ctx = linux({ local: () => false })) =>
  ShellExit.failed(analyse(command, ctx), exit)

describe("ShellExit.failed", () => {
  const table = ["grep x f", "rg x", "find . -name x", "diff a b", "test -f x", "[ -f x ]"]

  test.each(table)("%s: 1 is an answer, 2 is a failure, 0 is success", (command) => {
    expect(failed(command, 1)).toBe(false)
    expect(failed(command, 2)).toBe(true)
    expect(failed(command, 0)).toBe(false)
  })

  test.each(["cat f | grep x", "grep x f 2>/dev/null", "cd src && grep x f", "grep x f > out.txt", "false && grep x f"])(
    "%s: the last command of the line decides, so 1 is not a failure",
    (command) => {
      expect(failed(command, 1)).toBe(false)
    },
  )

  test.each([
    "[[ -f x ]]",
    "egrep x f",
    "git grep x",
    "git diff --exit-code",
    "cmp a b",
    "grep x f && echo found",
    "grep x f; echo done",
    "! grep x f",
    "(grep x f)",
    "grep x f &",
    "if true; then grep x f; fi",
    "for f in a; do grep x $f; done",
    "cat f | while read l; do grep x f; done",
    "FOO=1 grep x f",
    '"grep" x f',
    "'grep' x f",
    "\\grep x f",
    "g\\rep x f",
    "sudo grep x f",
    "timeout 5 grep x f",
    "/usr/bin/grep x f",
    "npm test",
    "ls missing",
  ])("%s: 1 is a failure", (command) => {
    expect(failed(command, 1)).toBe(true)
  })

  test.each(["grep x $(ls)", 'grep "$P" f', 'echo "unterminated', "grep x f | grep $(ls)"])(
    "%s: a line the analysis cannot model takes the default rule",
    (command) => {
      expect(failed(command, 1)).toBe(true)
    },
  )

  test.each(["exit 3", "false", "sh -c 'exit 7'"])("%s fails on any non-zero code", (command) => {
    expect(failed(command, 3)).toBe(true)
    expect(failed(command, 0)).toBe(false)
  })

  test("no analysis takes the default rule", () => {
    expect(ShellExit.failed(undefined, 1)).toBe(true)
    expect(ShellExit.failed(undefined, 0)).toBe(false)
  })

  test("the program is read as written, so Git Bash's grep.exe takes the default rule", () => {
    const ctx = windows({ local: () => false })
    expect(failed("grep x f", 1, ctx)).toBe(false)
    expect(failed("grep.exe x f", 1, ctx)).toBe(true)
  })

  test("an analysis of another dialect takes the default rule", () => {
    const analysis = { ...analyse("grep x f"), dialect: "pwsh" as const }
    expect(ShellExit.failed(analysis, 1)).toBe(true)
  })
})

describe("the deciding command of an analysis", () => {
  const name = (command: string) => {
    const analysis = analyse(command)
    return analysis.last === undefined ? undefined : analysis.commands[analysis.last].head
  }
  test.each([
    ["grep x f", "grep"],
    ["a && b || grep x", "grep"],
    ["a; b | grep x", "grep"],
    ["grep x f 2>&1", "grep"],
    ["[ -f x ]", "["],
    ["[[ -f x ]]", "[["],
    ["! grep x f", undefined],
    ["grep x f &", undefined],
    ["(grep x f)", undefined],
    ["{ grep x f; }", undefined],
    ["x=1", undefined],
  ])("%s decides by %p", (command, expected) => {
    expect(name(command)).toBe(expected)
  })
})
