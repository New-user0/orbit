import { describe, expect, test } from "bun:test"
import { ShellAnalysis } from "../../src/shell/analysis"
import { bash, linux, powershell, pwsh, windows } from "./helper"
import { arrayAndNetwork, arrayAndNetworkOk, chain } from "./powershell-cases"

// Class 10 matrix: every way a statement can make later heads or helper programs come from somewhere else.
// Surfaces: an assignment, a `for` variable, a declaration, a prefix. Names: PATH in each case, PAGER, CDPATH, LD_*.
describe("a loop variable is a sensitive assignment (class 10)", () => {
  test.each([
    "for PATH in .; do ls; done",
    "for path in .; do ls; done",
    "for PAGER in sh; do man ls; done",
    "for CDPATH in /etc; do cd x; done",
    "for LD_PRELOAD in x; do ls; done",
  ])("%s is not read-only", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test("an ordinary loop variable stays read-only", () => {
    expect(bash("for f in a b; do ls; done").readOnly).toBe(true)
  })
})

// Scope matrix: where a name can be changed without the statement list seeing it.
//   loop variable (real scope) / `&` in an if, elif or while condition / elif condition.
describe("scope tracking reports the path bash reads", () => {
  test("a loop variable is unknown after the loop", () => {
    expect(bash("f=a; for f in /etc/hostname; do true; done; cat $f").readOnly).toBe(false)
  })
  test("a loop variable that was not set before is unknown too", () => {
    expect(bash("for f in a; do true; done; cat $f").readOnly).toBe(false)
  })
  test.each([
    ["if", "X=/etc/hostname; if X=a & true; then true; fi; cat $X"],
    ["while", "X=/etc/hostname; while X=a & true; do true; done; cat $X"],
    ["until", "X=/etc/hostname; until X=a & true; do true; done; cat $X"],
    ["elif", "X=/etc/hostname; if true; then true; elif X=a & true; then true; fi; cat $X"],
  ])("a backgrounded assignment in a %s condition does not change the value", (_name, text) => {
    expect(bash(text).readPaths).toEqual(["/etc/hostname"])
  })
  test("an elif condition is walked in a copy", () => {
    expect(bash("X=/etc/shadow; if true; then true; elif X=a; then true; fi; cat $X").readPaths).toEqual(["/etc/shadow"])
  })
  test("an assignment in an if condition is still seen", () => {
    expect(bash("if X=a; then true; fi; cat $X").readPaths).toEqual(["a"])
  })
})

describe("Command.text keeps what runs (class 9)", () => {
  test("a rebuilt text keeps the fd and the redirects of a redirected statement", () => {
    expect(bash("X=a; cat $X 2>/dev/null").commands[0].text).toBe("cat a 2>/dev/null")
  })
  test("an unknown part is a visible placeholder, never a control character", () => {
    const text = bash('for f in a; do echo "x$f"; done').commands[0].text
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
    expect(text).toContain("<unknown>")
  })
})

// Class 6 matrix. Surfaces: a word, a flag value (`--flag=//host/x`), a redirect target, a PowerShell argument, a comma
// element. Spellings: `\\h\s`, `//h/s`, the mixed forms, WebDAV. Bash checks this on win32 only.
describe("a network share anywhere in a word is never read-only (win32)", () => {
  test.each([
    "diff --from-file=//evil/share/x a",
    "wc --files0-from=//evil/share/x",
    "date --reference=//evil/share/x",
    "cat a //evil/share/x",
    "cat x=\\\\\\\\evil\\\\share",
    "cat <//evil/share/x",
    "cat --x=/\\\\evil/share/x",
    "cat a@SSL@443/x",
    "cat '\\\\10.0.0.1\\x'",
    "cat a'\\\\evil\\s'",
    // Backslashes after a colon: the `\\` branch of the pattern has no colon lookbehind.
    "cat 'a:\\\\evil\\share\\x'",
    "cat 'C:\\\\x'",
  ])("%s", (text) => {
    expect(bash(text, windows()).readOnly).toBe(false)
  })
  test("a URL scheme and an ordinary path stay as they were", () => {
    expect(bash("cat a/b/c", linux()).readOnly).toBe(true)
    expect(bash("echo https://example.com/x", windows()).readOnly).toBe(true)
  })
})

describe("PowerShell arrays, shares and bound native flags", () => {
  test.each(arrayAndNetwork)("no: %s", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(false)
  })
  test.each(arrayAndNetworkOk)("ro: %s", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(true)
  })
  test("pwsh 7 chains recorded with pwsh 7 are never read-only", () => {
    for (const text of chain) {
      const result = powershell(text, pwsh())
      expect(result.readOnly).toBe(false)
    }
  })
})

// Class 6 matrix: the NT spelling `\??\UNC\host\share` x bash (word, flag value, redirect target, wc and diff file lists)
// x PowerShell (positional, bound path, bound non-path value), on win32.
describe("the NT spelling of a share (class 6)", () => {
  test.each([
    "cat '\\??\\UNC\\evil\\share\\x'",
    "cat < '\\??\\UNC\\evil\\share\\x'",
    "tail -n 5 '\\??\\UNC\\evil\\share\\x'",
    "diff --from-file='\\??\\UNC\\evil\\share\\x' a",
    "wc --files0-from='\\??\\UNC\\evil\\share\\x'",
  ])("%s is not read-only on win32", (text) => {
    expect(bash(text, windows()).readOnly).toBe(false)
  })
  test("it is an ordinary word elsewhere", () => {
    expect(bash("cat '\\??\\UNC\\evil\\share\\x'", linux()).readOnly).toBe(true)
  })
})

describe("a heredoc body is checked like the reference (class 6)", () => {
  test.each(["echo \"$(cat <<'E'\n/proc/self//environ\nE\n)\"", "echo \"$(cat <<'E'\nsystem (1)\nE\n)\""])("%j", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
})

describe("/proc environ in any spelling", () => {
  test.each([
    "cat /proc/self//environ",
    "cat /proc/./self/environ",
    "cat /proc/self/task/1/environ",
    "cat /proc/self/environ",
    "cat < /proc/self/task/1/environ",
  ])("%s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
})

describe("tables that are no wider than the reference", () => {
  test.each([
    "ps -o pid",
    "ps -o=pid",
    "ps -O x",
    "ps -r",
    "ps -x",
    "ps -M",
    "ps -Z",
    "ps -h",
    "ps --cumulative",
    "ps --noheader",
    "ps e1",
    "ps axe",
    "ps ae9",
    "jq --from-file=x .",
    "jq --from-file x .",
    "jq --library-path=dir .",
    "jq --library-path dir .",
    "jq -nf x",
    "jq -L dir .",
    "jq -Ldir .",
  ])("%s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test.each(["ps aux", "ps -ef", "ps -p 1", "ps --sort=pid", "jq -r .a f", "jq --arg a b .x f"])("%s stays read-only", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
})

describe("PowerShell alias lookups", () => {
  test("aliasTarget follows the edition and platform", () => {
    expect(ShellAnalysis.aliasTarget("spsv", "pwsh", "win32")).toBe("stop-service")
    expect(ShellAnalysis.aliasTarget("curl", "pwsh", "win32")).toBeUndefined()
    expect(ShellAnalysis.aliasTarget("curl", "powershell-5.1", "win32")).toBe("invoke-webrequest")
  })
})
