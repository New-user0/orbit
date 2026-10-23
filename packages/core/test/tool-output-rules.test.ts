// tool-runtime-8: the pure rules of per-call persistence. The threshold follows the reference (Infinity first, then the
// smaller of the declared limit and the ceiling), with the person's `tool_output.max_result_chars`, else `max_bytes`,
// as the ceiling in place of the reference's fixed 50,000 (class 8: a trusted scope sets it). A file name comes from a
// call ID that a provider or a model chose, so it is sanitized and hash-suffixed into one plain segment (class 5).
import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { ToolOutput } from "@orbit/core/tool-output"

describe("ToolOutput.threshold", () => {
  test.each([
    ["undeclared, no config", undefined, undefined, 50_000],
    ["Grep's 20,000", 20_000, undefined, 20_000],
    ["100,000 under the default ceiling", 100_000, undefined, 50_000],
    ["Infinity", Infinity, undefined, Infinity],
    ["Infinity under a ceiling of 10", Infinity, { max_result_chars: 10 }, Infinity],
    ["100,000 under a ceiling of 200,000", 100_000, { max_result_chars: 200_000 }, 100_000],
    ["undeclared under a ceiling of 200,000", undefined, { max_result_chars: 200_000 }, 200_000],
    ["20,000 under a ceiling of 500", 20_000, { max_result_chars: 500 }, 500],
    ["undeclared under max_bytes alone", undefined, { max_bytes: 80_000 }, 80_000],
    [
      "undeclared where max_result_chars wins over max_bytes",
      undefined,
      { max_result_chars: 30_000, max_bytes: 80_000 },
      30_000,
    ],
    ["undeclared under max_lines alone, which no longer bounds a result", undefined, { max_lines: 5 }, 50_000],
  ] as const)("%s", (_, declared, config, expected) => {
    expect(ToolOutput.threshold(declared, config)).toBe(expected)
  })
})

describe("ToolOutput.fileName", () => {
  const hash = (id: string) => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8)
  const message = "msg_0123456789abcdefABCDEF"

  test.each([
    ["call_01ABC", "call_01ABC"],
    ["toolu_01-x", "toolu_01-x"],
    ["../../x", "______x"],
    ["a/b", "a_b"],
    ["C:\\evil", "C__evil"],
    ["\\\\host\\share\\x", "__host_share_x"],
    ["nul\u0000byte", "nul_byte"],
    ["", ""],
    ["c".repeat(300), "c".repeat(64)],
  ] as const)("names the call %p by its sanitized ID and a hash of the raw one", (id, cleaned) => {
    const name = ToolOutput.fileName(message, id, "txt")
    expect(name).toBe(`${message}-${cleaned}-${hash(id)}.txt`)
    expect(name).toMatch(/^msg_[A-Za-z0-9]{1,64}-[A-Za-z0-9_-]{0,64}-[0-9a-f]{8}\.txt$/)
  })

  test("keeps IDs apart that sanitize alike or differ only in letter case", () => {
    const names = ["a/b", "a_b", "ABC", "abc"].map((id) => ToolOutput.fileName(message, id, "json").toLowerCase())
    expect(new Set(names).size).toBe(4)
    expect(names.every((name) => name.endsWith(".json"))).toBe(true)
  })
})

describe("ToolOutput texts", () => {
  test("names the tool in the empty marker", () => {
    expect(ToolOutput.emptyMarker("Bash")).toBe("(Bash finished and returned no output)")
  })

  test("cuts a long error to its first and last 5,000 characters", () => {
    const message = `${"h".repeat(5_000)}${"m".repeat(2)}${"t".repeat(5_000)}`
    expect(ToolOutput.cutError(message)).toBe(
      `${"h".repeat(5_000)}\n\n[2 characters cut from the middle]\n\n${"t".repeat(5_000)}`,
    )
    expect(ToolOutput.cutError("x".repeat(10_000))).toBe("x".repeat(10_000))
  })
})
