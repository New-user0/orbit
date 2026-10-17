export * as VimAdapter from "./vim-adapter"

import type { TextareaRenderable } from "@opentui/core"
import { displaySlice, promptOffsetWidth } from "../../prompt/display"
import { Vim } from "./vim-state"

/**
 * Connects the pure engine to the prompt's textarea. The engine counts UTF-16 indexes; the textarea counts display
 * width (a wide character takes two offsets, a line break one), so every position crosses here in both directions.
 */

type Input = Pick<
  TextareaRenderable,
  "plainText" | "cursorOffset" | "setSelection" | "deleteSelection" | "insertText" | "moveCursorUp" | "moveCursorDown"
>

export const toOffset = (text: string, index: number) => promptOffsetWidth(text.slice(0, index))
export const toIndex = (text: string, offset: number) => displaySlice(text, 0, offset).length

/** `parts` are the prompt parts' ranges in the textarea's offset model. */
export function snapshot(input: Input, parts: ReadonlyArray<{ start: number; end: number }>): Vim.Snapshot {
  const text = input.plainText
  return {
    text,
    cursor: toIndex(text, input.cursorOffset),
    parts: parts.map((part) => ({ start: toIndex(text, part.start), end: toIndex(text, part.end) })),
    row(cursor, direction) {
      input.cursorOffset = toOffset(text, cursor)
      if (direction === "down") input.moveCursorDown()
      if (direction === "up") input.moveCursorUp()
      return toIndex(text, input.cursorOffset)
    },
  }
}

/**
 * Applies a result's edits through the textarea's own editing calls, so its undo and redo keep working, and puts the
 * cursor where the engine says. Returns how many native editing steps it took: `u` undoes that many.
 */
export function apply(input: Input, snap: Vim.Snapshot, result: Vim.Result) {
  // One pass over the text instead of one per edit boundary: a count like 500>> has hundreds of edits.
  const offsets = new Map<number, number>()
  const total = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(snap.text)].reduce(
    (at, part) => {
      offsets.set(part.index, at)
      return at + promptOffsetWidth(part.segment)
    },
    0,
  )
  offsets.set(snap.text.length, total)
  const offsetOf = (index: number) => offsets.get(index) ?? toOffset(snap.text, index)
  const steps = [...result.edits].reverse().reduce((count, edit) => {
    const start = offsetOf(edit.start)
    const end = offsetOf(edit.end)
    const removed = end > start
    if (removed) {
      input.setSelection(start, end)
      input.deleteSelection()
    }
    if (edit.insert) {
      input.cursorOffset = start
      input.insertText(edit.insert)
    }
    return count + (removed ? 1 : 0) + (edit.insert ? 1 : 0)
  }, 0)
  input.cursorOffset = toOffset(Vim.apply(snap.text, result.edits), result.cursor)
  return steps
}
