import { expect, test } from "bun:test"
import { outcome, runTerminalSetup } from "../../src/component/terminal-setup"
import type { Result } from "../../src/util/terminal-setup"
import { renderLocal } from "../fixture/local"

// Class 9: the path of the keybindings file comes from the environment, and the reason an install failed from the
// file system, so each reaches the person through `plain`. Either one can hold an escape sequence.
const hostile = "C:\\Users\\x\u001b]0;pwn\u0007\u001b[2Jy"

test.each<[string, Result]>([
  ["installed", { type: "installed", file: hostile, backup: `${hostile}.bak` }],
  ["present", { type: "present", file: hostile }],
  ["conflict", { type: "conflict", file: hostile }],
  ["unparsable", { type: "unparsable", file: hostile }],
  ["failed", { type: "failed", file: hostile, reason: `no access to ${hostile}\r\n\u001b[31m` }],
])("the %s outcome of /terminal-setup writes out the control characters of a path and a reason", (_name, result) => {
  const message = outcome(result).message
  expect(message).not.toMatch(/[\p{C}]/u)
  // Control: the path is still named, in its written-out form.
  expect(message).toContain("C:\\Users\\x")
})

test("the confirm dialog of /terminal-setup draws the keybindings path without control characters", async () => {
  await using setup = await renderLocal()
  await runTerminalSetup({
    env: { TERM_PROGRAM: "vscode", APPDATA: hostile },
    platform: "win32",
    capabilities: null,
    newlineKeys: "ctrl+j",
    dialog: setup.dialog,
    toast: { show: () => {} },
    copy: async () => {},
  })
  const frame = await setup.waitForFrame((frame) => frame.includes("Add Shift+Enter for newlines"))
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
  expect(frame.replace(/\s+/g, "")).toContain("C:\\Users\\x")
})
