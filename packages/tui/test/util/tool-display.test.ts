import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  finiteNumber,
  legacyToolInput,
  primitiveInputSummary,
  toolDisplayMetadata,
  webSearchProviderLabel,
  writtenFile,
} from "../../src/util/tool-display"

// A completed Write's text comes from the diff it recorded, so each way a new file's diff can end reads back exactly.
test.each([
  { name: "ends with a line break", patch: "--- a\n+++ a\n@@ -0,0 +1,2 @@\n+one\n+two\n", text: "one\ntwo\n" },
  {
    name: "has no final line break",
    patch: "--- a\n+++ a\n@@ -0,0 +1,1 @@\n+one\n\\ No newline at end of file\n",
    text: "one",
  },
  { name: "is empty", patch: "--- a\n+++ a\n", text: "" },
])("a new file's written text is read from its recorded diff when it $name", (row) => {
  expect(writtenFile({ files: [{ file: "a", status: "added", patch: row.patch }] })?.text).toBe(row.text)
})

test("a Write's recorded diff that is missing or malformed gives nothing, and an overwrite gives only its diff", () => {
  expect(
    [{}, { files: [] }, { files: [{ file: "", patch: "" }] }, { files: [{ file: "a" }] }].map(writtenFile),
  ).toEqual([undefined, undefined, undefined, undefined])
  expect(writtenFile({ files: [{ file: "a", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y\n" }] })).toEqual({
    file: "a",
    patch: "@@ -1 +1 @@\n-x\n+y\n",
    text: undefined,
  })
})

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

test("reads a call recorded under the reference tool names as the views expect", () => {
  expect(["Bash", "Read", "Edit", "Write", "NotebookEdit", "Agent", "WebFetch", "TaskStop"].map(canonicalToolName)).toEqual([
    "shell",
    "read",
    "edit",
    "write",
    "notebook_edit",
    "subagent",
    "webfetch",
    "shell_stop",
  ])
  expect(legacyToolInput("Edit", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({
    path: "a.ts",
    oldString: "a",
    newString: "b",
    replaceAll: true,
  })
  expect(legacyToolInput("edit", { path: "a.ts" })).toEqual({ path: "a.ts" })
  expect(legacyToolInput("NotebookEdit", { notebook_path: "n.ipynb" })).toEqual({ path: "n.ipynb" })
  expect(legacyToolInput("Bash", { command: "ls", run_in_background: true })).toEqual({ command: "ls", background: true })
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Web Search via Parallel")
    expect(webSearchProviderLabel("exa")).toBe("Web Search via Exa")
    expect(webSearchProviderLabel("firecrawl")).toBe("Web Search via Firecrawl")
    expect(webSearchProviderLabel("tavily")).toBe("Web Search via Tavily")
    expect(webSearchProviderLabel("orbit")).toBe("Web Search via Orbit")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toBe(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
