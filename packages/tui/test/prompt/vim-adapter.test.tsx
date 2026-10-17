import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { VimAdapter } from "../../src/component/prompt/vim-adapter"
import { Vim } from "../../src/component/prompt/vim-state"

// The engine counts UTF-16 indexes and the textarea counts display width, so the adapter is checked against a real
// textarea: the engine runs over its snapshot, the adapter applies the result, and the textarea's own text and cursor
// are what is read back.
async function mount(text: string, width = 20) {
  let input!: TextareaRenderable
  const setup = await testRender(
    () => <textarea ref={(node: TextareaRenderable) => (input = node)} focused width={width} height={8} />,
    {
      width,
      height: 8,
    },
  )
  await setup.renderOnce()
  input.insertText(text)
  await setup.renderOnce()
  let state: Vim.State = { ...Vim.initial, mode: "normal" }
  return {
    input,
    setup,
    cursor(index: number) {
      input.cursorOffset = VimAdapter.toOffset(input.plainText, index)
    },
    press(keys: string) {
      for (const char of keys) {
        const snap = VimAdapter.snapshot(input, [])
        const result = Vim.step(
          state,
          { name: char.toLowerCase(), sequence: char, shift: char !== char.toLowerCase() },
          snap,
        )
        state = result.state
        VimAdapter.apply(input, snap, result)
      }
    },
    index: () => VimAdapter.toIndex(input.plainText, input.cursorOffset),
    [Symbol.dispose]() {
      setup.renderer.destroy()
    },
  }
}

test("offsets round-trip through wide characters and an emoji", async () => {
  const text = "日本a😀b\ncd"
  for (let index = 0; index <= text.length; index++) {
    if (index === 4 || index === 1 || index === 3) continue // inside a surrogate pair or between code units of one grapheme
    expect(VimAdapter.toIndex(text, VimAdapter.toOffset(text, index))).toBe(index)
  }
  // Two wide characters take four offsets, the emoji two more.
  expect(VimAdapter.toOffset(text, 2)).toBe(4)
  expect(VimAdapter.toOffset(text, 5)).toBe(7)
})

test("offsets match the textarea's own count for a tab, soft hyphen, CJK, ZWJ emoji and combining mark", async () => {
  for (const text of ["\tfoo", "a­b", "日本語", "x👨‍👩‍👧y", "éz", "a\tb\nc"]) {
    using e = await mount(text)
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    for (const part of [...segments.map((s) => s.index), text.length]) {
      e.input.cursorOffset = VimAdapter.toOffset(text, part)
      expect(e.input.getTextRange(0, e.input.cursorOffset)).toBe(text.slice(0, part))
      expect(VimAdapter.toIndex(text, VimAdapter.toOffset(text, part))).toBe(part)
    }
  }
})

test("a tab-indented line edits the right characters", async () => {
  using dw = await mount("\tfoo bar")
  dw.press("$")
  dw.press("b")
  dw.press("dw")
  expect(dw.input.plainText).toBe("\tfoo ")

  using shift = await mount("\tx")
  shift.cursor(1)
  shift.press("<<")
  expect(shift.input.plainText).toBe("x")

  using word = await mount("\tabc def")
  word.cursor(0)
  word.press("w")
  expect(word.index()).toBe(1)

  using escape = await mount("\tabc")
  const snap = VimAdapter.snapshot(escape.input, [])
  escape.input.cursorOffset = VimAdapter.toOffset(snap.text, Vim.leaveInsert(snap))
  expect(VimAdapter.toIndex(escape.input.plainText, escape.input.cursorOffset)).toBe(3)
})

test("w and x work by grapheme on a textarea that holds wide characters and an emoji", async () => {
  using editor = await mount("日本 😀 abc")
  editor.cursor(0)
  editor.press("w")
  expect(editor.index()).toBe(3)
  editor.press("w")
  expect(editor.index()).toBe(6)
  editor.cursor(3)
  editor.press("x")
  expect(editor.input.plainText).toBe("日本  abc")
  expect(editor.index()).toBe(3)
  editor.press("0")
  editor.press("x")
  expect(editor.input.plainText).toBe("本  abc")
})

test("an emoji is one grapheme for l and x", async () => {
  using editor = await mount("a😀b")
  editor.cursor(0)
  editor.press("l")
  expect(editor.index()).toBe(1)
  editor.press("l")
  expect(editor.index()).toBe(3)
  editor.cursor(1)
  editor.press("x")
  expect(editor.input.plainText).toBe("ab")
})

test("gj moves one display row down inside a wrapped line, and dgj deletes characterwise up to it", async () => {
  const text = "alpha beta gamma delta epsilon"
  using editor = await mount(text, 12)
  expect(editor.input.virtualLineCount).toBeGreaterThan(1)
  editor.cursor(0)
  editor.press("gj")
  const moved = editor.index()
  expect(moved).toBeGreaterThan(0)
  expect(moved).toBeLessThan(text.length)
  // Still the first logical line.
  expect(editor.input.plainText).toBe(text)
  editor.cursor(0)
  editor.press("dgj")
  expect(editor.input.plainText).toBe(text.slice(moved))
  editor.cursor(editor.input.plainText.length - 1)
  editor.press("gk")
  expect(editor.index()).toBeLessThan(editor.input.plainText.length - 1)
})

test("a command that deletes and inserts takes two native steps, and the adapter reports them", async () => {
  using editor = await mount("foo bar")
  editor.cursor(0)
  const snap = VimAdapter.snapshot(editor.input, [])
  const result = Vim.step(
    { ...Vim.initial, mode: "normal", pending: { kind: "replace", count: 0 } },
    { name: "q", sequence: "q" },
    snap,
  )
  expect(VimAdapter.apply(editor.input, snap, result)).toBe(2)
  expect(editor.input.plainText).toBe("qoo bar")
  editor.input.undo()
  editor.input.undo()
  expect(editor.input.plainText).toBe("foo bar")
})
