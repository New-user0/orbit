import { expect, test } from "bun:test"
import { Vim } from "../../src/component/prompt/vim-state"

const recorder = () => {
  const calls: string[] = []
  const editor = new Proxy({} as Vim.Editor, {
    get: (_target, name) => () => void calls.push(String(name)),
  })
  return { calls, editor }
}
const key = (name: string, extra: Partial<Vim.Key> = {}): Vim.Key => ({ name, sequence: name, ...extra })

test("normal mode moves, edits, and returns to insert mode", () => {
  const { calls, editor } = recorder()
  const normal: Vim.State = { mode: "normal" }
  expect(Vim.normal(normal, key("h"), editor)).toEqual(normal)
  expect(Vim.normal(normal, key("w"), editor)).toEqual(normal)
  expect(Vim.normal(normal, key("A", { shift: true }), editor)).toEqual({ mode: "insert" })
  expect(calls).toEqual(["moveCursorLeft", "moveWordForward", "gotoLineEnd"])
})

test("two-key commands wait for their second key, and unknown keys are swallowed", () => {
  const { calls, editor } = recorder()
  const pending = Vim.normal({ mode: "normal" }, key("d"), editor)
  expect(pending).toEqual({ mode: "normal", pending: "d" })
  expect(Vim.normal(pending!, key("d"), editor)).toEqual({ mode: "normal" })
  expect(Vim.normal({ mode: "normal", pending: "g" }, key("g"), editor)).toEqual({ mode: "normal" })
  expect(calls).toEqual(["deleteLine", "gotoBufferHome"])
  expect(Vim.normal({ mode: "normal" }, key("z"), editor)).toEqual({ mode: "normal" })
  expect(Vim.normal({ mode: "normal" }, key("return", { sequence: "\r" }), editor)).toBeUndefined()
})
