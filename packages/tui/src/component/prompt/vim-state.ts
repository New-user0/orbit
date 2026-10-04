export * as Vim from "./vim-state"

import type { TextareaRenderable } from "@opentui/core"

/**
 * Vim-style editing for the prompt. Insert mode is the ordinary editor; Escape enters normal mode, where keys move
 * and edit instead of typing. Only the common motions and edits are supported.
 */

export type Mode = "insert" | "normal"

export interface State {
  readonly mode: Mode
  /** The first key of a two-key command such as `dd` or `gg`. */
  readonly pending?: "d" | "g"
}

export type Editor = Pick<
  TextareaRenderable,
  | "moveCursorLeft"
  | "moveCursorRight"
  | "moveCursorUp"
  | "moveCursorDown"
  | "moveWordForward"
  | "moveWordBackward"
  | "gotoLineHome"
  | "gotoLineEnd"
  | "gotoBufferHome"
  | "gotoBufferEnd"
  | "deleteChar"
  | "deleteCharBackward"
  | "deleteLine"
  | "deleteToLineEnd"
  | "deleteWordForward"
  | "newLine"
  | "undo"
  | "redo"
>

export interface Key {
  readonly name: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly sequence?: string
}

/**
 * Handles one key in normal mode and returns the next state, or undefined when the key is not a normal-mode command
 * and should go through untouched (Enter to submit, for example).
 */
export function normal(state: State, key: Key, editor: Editor): State | undefined {
  const char = key.sequence?.length === 1 ? key.sequence : key.shift ? key.name.toUpperCase() : key.name
  if (key.ctrl) {
    if (key.name !== "r") return undefined
    editor.redo()
    return { mode: "normal" }
  }
  if (state.pending === "d") {
    if (char === "d") editor.deleteLine()
    if (char === "w") editor.deleteWordForward()
    if (char === "$") editor.deleteToLineEnd()
    return { mode: "normal" }
  }
  if (state.pending === "g") {
    if (char === "g") editor.gotoBufferHome()
    return { mode: "normal" }
  }
  const run = COMMANDS[char]
  if (!run) return key.name === "return" || key.name === "enter" ? undefined : state
  return run(editor)
}

const stay = (action: (editor: Editor) => unknown) => (editor: Editor) => {
  action(editor)
  return { mode: "normal" } as State
}
const insert = (action: (editor: Editor) => unknown) => (editor: Editor) => {
  action(editor)
  return { mode: "insert" } as State
}

const COMMANDS: Record<string, (editor: Editor) => State> = {
  h: stay((editor) => editor.moveCursorLeft()),
  l: stay((editor) => editor.moveCursorRight()),
  j: stay((editor) => editor.moveCursorDown()),
  k: stay((editor) => editor.moveCursorUp()),
  w: stay((editor) => editor.moveWordForward()),
  b: stay((editor) => editor.moveWordBackward()),
  "0": stay((editor) => editor.gotoLineHome()),
  "^": stay((editor) => editor.gotoLineHome()),
  $: stay((editor) => editor.gotoLineEnd()),
  G: stay((editor) => editor.gotoBufferEnd()),
  x: stay((editor) => editor.deleteChar()),
  X: stay((editor) => editor.deleteCharBackward()),
  D: stay((editor) => editor.deleteToLineEnd()),
  u: stay((editor) => editor.undo()),
  d: () => ({ mode: "normal", pending: "d" }),
  g: () => ({ mode: "normal", pending: "g" }),
  i: insert(() => undefined),
  a: insert((editor) => editor.moveCursorRight()),
  I: insert((editor) => editor.gotoLineHome()),
  A: insert((editor) => editor.gotoLineEnd()),
  o: insert((editor) => {
    editor.gotoLineEnd()
    editor.newLine()
  }),
  O: insert((editor) => {
    editor.gotoLineHome()
    editor.newLine()
    editor.moveCursorUp()
  }),
}
