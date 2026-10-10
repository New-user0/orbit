import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SedScript } from "../../src/shell/sed"

const line = (n: number) => ({ kind: "line", line: n }) as const
const last = { kind: "last" } as const
const regex = (source: string) => ({ kind: "regex", source }) as const

const accepted: Array<[string, SedScript.Command[]]> = [
  ["p", [{ name: "p", addresses: [] }]],
  ["5p", [{ name: "p", addresses: [line(5)] }]],
  ["1,20p", [{ name: "p", addresses: [line(1), line(20)] }]],
  ["$p", [{ name: "p", addresses: [last] }]],
  ["/foo/p", [{ name: "p", addresses: [regex("foo")] }]],
  ["/a\\/b/,$d", [{ name: "d", addresses: [regex("a\\/b"), last] }]],
  ["=", [{ name: "=", addresses: [] }]],
  ["l", [{ name: "l", addresses: [] }]],
  ["n", [{ name: "n", addresses: [] }]],
  ["3q", [{ name: "q", addresses: [line(3)] }]],
  ["s/a/b/", [{ name: "s", addresses: [], delimiter: "/", pattern: "a", replacement: "b", flags: "" }]],
  ["s|a|b|g", [{ name: "s", addresses: [], delimiter: "|", pattern: "a", replacement: "b", flags: "g" }]],
  ["s#a#b#Ip", [{ name: "s", addresses: [], delimiter: "#", pattern: "a", replacement: "b", flags: "Ip" }]],
  ["s/a\\/b/c/2", [{ name: "s", addresses: [], delimiter: "/", pattern: "a\\/b", replacement: "c", flags: "2" }]],
  ["sxaxbx", [{ name: "s", addresses: [], delimiter: "x", pattern: "a", replacement: "b", flags: "" }]],
  ["s/a/b/gm", [{ name: "s", addresses: [], delimiter: "/", pattern: "a", replacement: "b", flags: "gm" }]],
  ["y/abc/xyz/", [{ name: "y", addresses: [], delimiter: "/", source: "abc", target: "xyz" }]],
  ["1p; 3p", [{ name: "p", addresses: [line(1)] }, { name: "p", addresses: [line(3)] }]],
  [" 1 p ", [{ name: "p", addresses: [line(1)] }]],
  ["s/a/b/ ; p", [{ name: "s", addresses: [], delimiter: "/", pattern: "a", replacement: "b", flags: "" }, { name: "p", addresses: [] }]],
  // A pattern that holds characters sed would otherwise read as syntax: the tokenizer knows where the pattern ends.
  ["s/x/hello world/", [{ name: "s", addresses: [], delimiter: "/", pattern: "x", replacement: "hello world", flags: "" }]],
  ["s/#{;}!/b/", [{ name: "s", addresses: [], delimiter: "/", pattern: "#{;}!", replacement: "b", flags: "" }]],
  ["s/a/b\tc/", [{ name: "s", addresses: [], delimiter: "/", pattern: "a", replacement: "b\tc", flags: "" }]],
]

const rejected: Array<[string, string]> = [
  ["1,3{p}", "sed:block"],
  ["p}", "sed:block"],
  ["p\np", "sed:newline"],
  ["#x", "sed:comment"],
  ["p;#x", "sed:comment"],
  ["s/a/é/", "sed:non-ascii"],
  ["s/a/b/\u0000", "sed:non-ascii"],
  ["p\r", "sed:non-ascii"],
  ["w out", "sed:command"],
  ["1W out", "sed:command"],
  ["e id", "sed:command"],
  ["r /etc/passwd", "sed:command"],
  ["R f", "sed:command"],
  ["a text", "sed:command"],
  ["h", "sed:command"],
  ["x", "sed:command"],
  ["s/a/b/w out", "sed:flag"],
  ["s/a/b/e", "sed:flag"],
  ["s/a/b/ge", "sed:flag"],
  ["s/a/b/E", "sed:flag"],
  ["s/a/b/gg", "sed:flag"],
  ["s/a/b/1 2", "sed:syntax"],
  ["s/a/b/1g2", "sed:flag"],
  ["s/a/b/0", "sed:flag"],
  ["1!p", "sed:negation"],
  ["!p", "sed:negation"],
  ["1~2p", "sed:address"],
  ["1,+2p", "sed:address"],
  ["1,~2p", "sed:address"],
  ["0,/x/p", "sed:address"],
  ["\\%x%p", "sed:address"],
  ["/x/Ip", "sed:address"],
  ["1,3q", "sed:address"],
  ["s/a/b", "sed:syntax"],
  ["s/a", "sed:syntax"],
  ["y/a/b", "sed:syntax"],
  ["1p;", "sed:syntax"],
  [";p", "sed:syntax"],
  ["p;;p", "sed:syntax"],
  ["", "sed:syntax"],
  ["   ", "sed:syntax"],
  ["s/a/b/g x", "sed:syntax"],
  ["p x", "sed:syntax"],
  ["q5", "sed:syntax"],
  ["l 5", "sed:syntax"],
  ["/x", "sed:syntax"],
  ["1,", "sed:syntax"],
  ["s\\a\\b\\", "sed:syntax"],
  ["@", "sed:syntax"],
]

describe("sed tokenizer", () => {
  test.each(accepted)("accepts %j", (script, commands) => {
    expect(SedScript.parse(script)).toEqual({ ok: true, commands })
  })
  test.each(rejected)("rejects %j with %s", (script, reason) => {
    expect(SedScript.parse(script)).toEqual({ ok: false, reason })
  })
  test("a multi-digit s number is one number", () => {
    expect(SedScript.parse("s/a/b/12")).toEqual({
      ok: true,
      commands: [{ name: "s", addresses: [], delimiter: "/", pattern: "a", replacement: "b", flags: "12" }],
    })
  })
  test("a backslash at the end of the script is an unterminated command, not a crash", () => {
    expect(SedScript.parse("s/a\\")).toEqual({ ok: false, reason: "sed:syntax" })
    expect(SedScript.parse("/a\\")).toEqual({ ok: false, reason: "sed:syntax" })
  })
  test("a reason is a fixed code and never holds script text", () => {
    for (const script of ["w /etc/passwd-secret", "s/a/b/w /etc/passwd-secret", "é-secret"]) {
      const result = SedScript.parse(script)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/^sed:[a-z-]+$/)
    }
  })
  // Run in a child process with a deadline: a tokenizer that loops would hang the runner, not fail it.
  test("long and adversarial scripts finish inside a deadline", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "sed-limits-child.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(import.meta.dir, "..", ".."),
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    const output = await new Response(child.stdout).text()
    clearTimeout(timer)
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toHaveLength(7)
  }, 15_000)
})
