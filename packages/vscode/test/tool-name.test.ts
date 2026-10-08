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

test("a name read from a chat is looked up as data", () => {
  for (const hostile of ["__proto__", "constructor", "toString", ""]) expect(legacyToolName(hostile)).toBe(hostile)
})
