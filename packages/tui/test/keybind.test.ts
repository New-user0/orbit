import { expect, test } from "bun:test"
import { createTestKeymap } from "@opentui/keymap/testing"
import { TuiKeybind } from "../src/config/keybind"

test("binds agent cycling only to shift+tab by default", () => {
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("shift+tab")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})

test("names the contexts a layer can belong to", () => {
  expect(TuiKeybind.Contexts).toEqual([
    "global",
    "prompt",
    "session",
    "permission",
    "composer",
    "dialog",
    "session-list",
    "diff",
    "which-key",
    "mini",
  ])
  expect(TuiKeybind.Contexts.every((context) => TuiKeybind.isContext(context))).toBe(true)
  for (const name of ["", "Session", "sessions", "plugin", "toString", undefined, null, 3])
    expect(TuiKeybind.isContext(name)).toBe(false)
})

test("tells a command from the leader key and from names that are not commands", () => {
  expect(TuiKeybind.isCommand("session.rename")).toBe(true)
  expect(TuiKeybind.isCommand("keybindings.open")).toBe(true)
  for (const name of ["leader", "", "session_rename", "toString", "__proto__", "constructor"])
    expect(TuiKeybind.isCommand(name)).toBe(false)
})

test("registers the keybindings command with no key", () => {
  expect(TuiKeybind.Definitions["keybindings.open"].default).toBe("none")
})

test("reads the strokes of a chord and leaves every other sequence as it was", () => {
  const stock = createTestKeymap({ defaultKeys: true })
  const syntax = createTestKeymap({ defaultKeys: true })
  TuiKeybind.registerSyntax(syntax.keymap)
  for (const harness of [stock, syntax]) harness.keymap.registerToken({ name: "leader", key: "ctrl+x" })
  const matches = (harness: typeof stock, key: string) => harness.keymap.parseKeySequence(key).map((part) => part.match)

  expect(syntax.keymap.parseKeySequence("ctrl+k ctrl+s")).toHaveLength(2)
  expect(matches(syntax, "ctrl+k ctrl+s")).toEqual([...matches(syntax, "ctrl+k"), ...matches(syntax, "ctrl+s")])
  // Without the syntax a space inside a key is not a chord, it is an error.
  expect(() => stock.keymap.parseKeySequence("ctrl+k ctrl+s")).toThrow()
  // A sequence that has no space in it, a leader sequence included, reads the same with it as without it.
  const sequences = ["gg", "ctrl+x", "shift+?", "ctrl+alt+k", "f2", "space", "ctrl+comma", "<leader>q", "<leader>return"]
  for (const key of sequences) expect(matches(syntax, key)).toEqual(matches(stock, key))
  stock.cleanup()
  syntax.cleanup()
})
