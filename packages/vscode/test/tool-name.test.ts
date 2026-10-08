import { expect, test } from "bun:test"
import { ToolNames } from "../../schema/src/tool-names"
import { legacyToolName } from "../src/tool-name"

// This package keeps its own copy of the table, as it does not depend on the schema package. The copy must not drift.
test("the extension reads every reference tool name as the old name in the shared table", () => {
  for (const [old, current] of Object.entries(ToolNames.tools)) {
    expect(legacyToolName(current)).toBe(old)
    expect(legacyToolName(old)).toBe(old)
  }
})

test("the extension reads PowerShell as the shell tool", () => {
  expect(legacyToolName("PowerShell")).toBe(ToolNames.legacy("PowerShell"))
  expect(legacyToolName("PowerShell")).toBe("shell")
})

// The webview cannot be mounted here, so the test reads its source: a raw comparison with the old name draws a
// generic row for a workflow recorded as `Workflow`, and the card with it.
test("the webview draws a workflow card for a call recorded under either name", async () => {
  const source = await Bun.file(new URL("../src/webview/main.ts", import.meta.url)).text()
  expect(source).not.toMatch(/item\.name === "workflow"/)
  expect(source.match(/legacyToolName\(item\.name\) === "workflow"/g)).toHaveLength(2)
  expect(legacyToolName("Workflow")).toBe("workflow")
})

test("a name read from a chat is looked up as data", () => {
  for (const hostile of ["__proto__", "constructor", "toString", ""]) expect(legacyToolName(hostile)).toBe(hostile)
})
