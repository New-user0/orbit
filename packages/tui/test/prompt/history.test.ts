import { describe, expect, test } from "bun:test"
import {
  appendPrompt,
  MAX_HISTORY_BYTES,
  parsePromptInfo,
  savedEntry,
  searchPromptHistory,
  isDuplicateEntry,
  DEFAULT_HISTORY_LIMIT,
  parsePromptHistory,
  type PromptInfo,
} from "../../src/prompt/history"

const entry = (text: string, files: PromptInfo["files"] = []): PromptInfo => ({
  text,
  files,
  agents: [],
  pasted: [],
})

describe("prompt history", () => {
  test("recovers valid JSONL entries around corruption", () => {
    expect(parsePromptHistory(`${JSON.stringify(entry("one"))}\nnot-json\n${JSON.stringify(entry("two"))}\n`)).toEqual([
      entry("one"),
      entry("two"),
    ])
  })

  test("ignores the legacy parts shape", () => {
    expect(parsePromptHistory(JSON.stringify({ input: "old", parts: [] }))).toEqual([])
  })

  test("retains only the newest entries", () => {
    const input = Array.from({ length: DEFAULT_HISTORY_LIMIT + 5 }, (_, index) =>
      JSON.stringify(entry(String(index))),
    ).join("\n")
    const result = parsePromptHistory(input)
    expect(result).toHaveLength(DEFAULT_HISTORY_LIMIT)
    expect(result[0]?.text).toBe("5")
  })

  test("dedupes only identical consecutive entries", () => {
    expect(isDuplicateEntry(undefined, entry("hello"))).toBe(false)
    expect(isDuplicateEntry(entry("hello"), entry("hello"))).toBe(true)
    expect(isDuplicateEntry(entry("foo"), entry("bar"))).toBe(false)
    expect(isDuplicateEntry({ ...entry("ls"), mode: "normal" }, { ...entry("ls"), mode: "shell" })).toBe(false)
  })

  test("does not dedupe entries with different attachments", () => {
    const a = entry("describe this", [{ name: "a.png", uri: "data:image/png;base64,AAA" }])
    const b = entry("describe this", [{ name: "b.png", uri: "data:image/png;base64,BBB" }])
    expect(isDuplicateEntry(a, b)).toBe(false)
  })

  test("preserves duplicate attachment mentions for prompt restoration", () => {
    const value = entry("[Image 1] [Image 1]", [
      {
        name: "clipboard",
        uri: "file:///clipboard.png",
        mention: { start: 0, end: 9, text: "[Image 1]" },
      },
      {
        name: "clipboard",
        uri: "file:///clipboard.png",
        mention: { start: 10, end: 19, text: "[Image 1]" },
      },
    ])

    expect(parsePromptHistory(JSON.stringify(value))).toEqual([value])
  })

  test("reads legacy lines that have no directory or time", () => {
    const [legacy] = parsePromptHistory(JSON.stringify(entry("old")))
    expect(legacy).toEqual(entry("old"))
    expect(legacy?.directory).toBeUndefined()
    expect(legacy?.time).toBeUndefined()
    expect(parsePromptInfo({ ...entry("new"), directory: "/a", time: 5 })).toMatchObject({ directory: "/a", time: 5 })
  })

  test("keeps the number of entries that the limit names", () => {
    const input = Array.from({ length: 12 }, (_, index) => JSON.stringify(entry(String(index)))).join("\n")
    expect(parsePromptHistory(input, 3).map((item) => item.text)).toEqual(["9", "10", "11"])
  })

  test("trims the oldest entries to stay under the byte cap", () => {
    const body = "y".repeat(400 * 1024)
    const input = ["old", "older", "newest"].map((name) => JSON.stringify(entry(name + body))).join("\n")
    const result = parsePromptHistory(input)
    // Three of these are over 1 MiB together, so the oldest is dropped.
    expect(result.map((item) => item.text.slice(0, 6))).toEqual(
      ["older" + "y", "newest"].map((text) => text.slice(0, 6)),
    )
    expect(result.reduce((sum, item) => sum + JSON.stringify(item).length + 1, 0)).toBeLessThanOrEqual(
      MAX_HISTORY_BYTES,
    )
  })

  test.each([
    ["an image", { files: [{ uri: "data:image/png;base64,AAAA" }] }],
    ["a pdf", { files: [{ uri: "data:application/pdf;base64,AAAA" }] }],
    ["a large paste", { pasted: [{ text: "z".repeat(5000), source: { start: 0, end: 3, text: "[P]" } }] }],
  ])("does not save %s", (_name, value) => {
    const saved = JSON.stringify(savedEntry({ ...entry("see attachment"), ...value }))
    expect(saved).not.toContain("data:")
    expect(saved).not.toContain("zzzz")
    // The notice names why the body is gone, and the text around it is kept.
    expect(saved).toContain("see attachment")
    expect(saved.length).toBeLessThan(500)
  })

  test("keeps a small paste and a file that is not inline", () => {
    const value = {
      ...entry("x", [{ uri: "file:///a.ts" }]),
      pasted: [{ text: "short", source: { start: 0, end: 1, text: "x" } }],
    }
    expect(savedEntry(value)).toEqual(value)
  })

  describe("search", () => {
    const at = (text: string, directory?: string, mode?: "shell"): PromptInfo => ({ ...entry(text), directory, mode })
    const history = [
      at("deploy staging", "/a"),
      at("deploy production", "/b"),
      at("run the tests", "/a"),
      at("deploy staging", "/b"),
      at("old deploy notes"),
    ]

    test("lists everything newest first without a query, once per distinct prompt", () => {
      expect(searchPromptHistory(history, "").map((item) => item.text)).toEqual([
        "old deploy notes",
        "deploy staging",
        "run the tests",
        "deploy production",
      ])
    })

    test("keeps only the entries that match the query", () => {
      expect(searchPromptHistory(history, "deploy").map((item) => item.text)).toEqual([
        "old deploy notes",
        "deploy staging",
        "deploy production",
      ])
      expect(searchPromptHistory(history, "zzz")).toEqual([])
    })

    test("puts the current directory first, then the newest", () => {
      expect(searchPromptHistory(history, "deploy", "/a").map((item) => `${item.directory}:${item.text}`)).toEqual([
        "/a:deploy staging",
        "undefined:old deploy notes",
        "/b:deploy production",
      ])
      expect(searchPromptHistory(history, "", "/a")[0]?.text).toBe("run the tests")
    })

    test("treats the same text in another mode as another prompt", () => {
      expect(searchPromptHistory([at("ls"), at("ls", undefined, "shell")], "ls")).toHaveLength(2)
    })
  })

  test("appends a prompt on a new line and shifts its ranges by display width", () => {
    const output = appendPrompt(
      { ...entry("日本"), pasted: [{ text: "long", source: { start: 0, end: 4, text: "日本" } }] },
      {
        ...entry("@a.ts [Pasted]", [{ uri: "file:///a.ts", mention: { start: 0, end: 5, text: "@a.ts" } }]),
        agents: [{ name: "build" }],
        pasted: [{ text: "more", source: { start: 6, end: 14, text: "[Pasted]" } }],
      },
    )

    expect(output).toEqual({
      text: "日本\n\n@a.ts [Pasted]",
      files: [{ uri: "file:///a.ts", mention: { start: 6, end: 11, text: "@a.ts" } }],
      agents: [{ name: "build", mention: undefined }],
      skills: [],
      pasted: [
        { text: "long", source: { start: 0, end: 4, text: "日本" } },
        { text: "more", source: { start: 12, end: 20, text: "[Pasted]" } },
      ],
    })
    expect(appendPrompt(entry(""), entry("next")).text).toBe("next")
  })
})
