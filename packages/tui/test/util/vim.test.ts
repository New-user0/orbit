import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Vim } from "../../src/component/prompt/vim-state"

// An in-memory editor over a plain string. `|` in a fixture marks the cursor, before the character it precedes.
// A fixture may mark prompt parts with `[[` and `]]` (removed from the text).
type Clip = { data: string; mime: string } | undefined | "fail"

function editor(fixture: string, input: { mode?: Vim.Mode; register?: string; clip?: Clip; width?: number } = {}) {
  const parts: Vim.Part[] = []
  let text = ""
  let cursor = -1
  let open = -1
  for (let i = 0; i < fixture.length; i++) {
    if (fixture.startsWith("[[", i)) {
      open = text.length
      i++
    } else if (fixture.startsWith("]]", i)) {
      parts.push({ start: open, end: text.length })
      i++
    } else if (fixture[i] === "|") cursor = text.length
    else text += fixture[i]
  }
  const state = {
    text,
    cursor,
    parts,
    vim: { ...Vim.initial, mode: input.mode ?? "normal", register: input.register ?? "" },
  }
  const history: Array<{ text: string; cursor: number }> = []
  const written: string[] = []
  let selection: Vim.Result["selection"]
  const snapshot = (): Vim.Snapshot => ({
    text: state.text,
    cursor: state.cursor,
    parts: state.parts,
    // Rows of `width` code units: enough to test the display-row commands.
    row: (at, direction) => {
      const width = input.width ?? 1000
      const column = at % width
      const target = direction === "down" ? at + width : at - width
      return Math.max(0, Math.min(state.text.length, target - (target % width) + column))
    },
  })
  const run = (result: Vim.Result) => {
    if (result.undo) {
      const previous = history.pop()
      if (previous) {
        state.text = previous.text
        state.cursor = previous.cursor
      }
      state.vim = result.state
      return
    }
    if (result.edits.length > 0) history.push({ text: state.text, cursor: state.cursor })
    state.text = Vim.apply(state.text, result.edits)
    state.cursor = result.cursor
    state.vim = result.state
    selection = result.selection
    if (result.clipboard && "write" in result.clipboard) written.push(result.clipboard.write)
    if (result.clipboard && "read" in result.clipboard) {
      const text = input.clip === "fail" ? undefined : Vim.clipboardText(input.clip)
      if (text !== undefined)
        run(Vim.paste(state.vim, snapshot(), text, result.clipboard.read.before, result.clipboard.read.count))
    }
  }
  return {
    state,
    written,
    passed: [] as string[],
    press(keys: string) {
      for (const token of keys.match(/<[A-Za-z-]+>|[\s\S]/gu) ?? []) this.send(key(token), token)
      return this
    },
    /** One key. In insert mode the key is typed into the text the way the prompt's textarea would, and recorded. */
    send(input: Vim.Key, token = input.sequence ?? input.name) {
      if (state.vim.mode === "insert") {
        if (input.name === "escape") {
          state.cursor = Vim.leaveInsert(snapshot())
          state.vim = Vim.leave(state.vim)
          return this
        }
        state.vim = Vim.insertKey(state.vim, input)
        const insert = input.name === "return" ? "\n" : input.ctrl || input.meta ? "" : (input.sequence ?? "")
        if (input.name === "backspace") {
          if (state.cursor > 0) {
            state.text = state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor)
            state.cursor--
          }
        } else if (insert === "\n" || (insert.length > 0 && !/\p{Cc}/u.test(insert))) {
          state.text = state.text.slice(0, state.cursor) + insert + state.text.slice(state.cursor)
          state.cursor += insert.length
        }
        return this
      }
      const result = Vim.step(state.vim, input, snapshot())
      if (result.pass) this.passed.push(token)
      run(result)
      return this
    },
    /** The text the engine says is selected. */
    selected() {
      return selection ? state.text.slice(selection.start, selection.end) : undefined
    },
    shown() {
      return state.text.slice(0, state.cursor) + "|" + state.text.slice(state.cursor)
    },
  }
}

function key(token: string): Vim.Key {
  const named: Record<string, Vim.Key> = {
    "<Esc>": { name: "escape", sequence: "\x1b" },
    "<BS>": { name: "backspace", sequence: "\x7f" },
    "<Del>": { name: "delete", sequence: "\x1b[3~" },
    "<Right>": { name: "right", sequence: "\x1b[C" },
    "<Left>": { name: "left", sequence: "\x1b[D" },
    "<Up>": { name: "up", sequence: "\x1b[A" },
    "<Down>": { name: "down", sequence: "\x1b[B" },
    "<CR>": { name: "return", sequence: "\r" },
    "<Tab>": { name: "tab", sequence: "\t" },
    "<C-r>": { name: "r", sequence: "\x12", ctrl: true },
    "<C-x>": { name: "x", sequence: "\x18", ctrl: true },
    "<S-Right>": { name: "right", sequence: "\x1b[1;2C", shift: true },
    "<S-Left>": { name: "left", sequence: "\x1b[1;2D", shift: true },
  }
  const found = named[token]
  if (found) return found
  return { name: token.toLowerCase(), sequence: token, shift: token !== token.toLowerCase() }
}

type Row = [start: string, keys: string, expected: string, extra?: { reg?: string; mode?: Vim.Mode; register?: string }]

function table(name: string, rows: Row[]) {
  describe(name, () => {
    for (const [start, keys, expected, extra] of rows) {
      test(`${JSON.stringify(start)} ${keys}`, () => {
        const e = editor(start, { register: extra?.register })
        e.press(keys)
        expect(e.shown()).toBe(expected)
        if (extra?.reg !== undefined) expect(e.state.vim.register).toBe(extra.reg)
        expect(e.state.vim.mode).toBe(extra?.mode ?? "normal")
        expect(e.state.vim.pending).toEqual({ kind: "idle" })
      })
    }
  })
}

table("counts and motions", [
  ["|one two three four", "3w", "one two three |four"],
  ["|foo.bar baz", "w", "foo|.bar baz"],
  ["|foo.bar baz", "ww", "foo.|bar baz"],
  ["|foo.bar baz", "www", "foo.bar |baz"],
  ["|foo.bar baz", "e", "fo|o.bar baz"],
  ["|foo.bar baz", "W", "foo.bar |baz"],
  ["|foo.bar baz", "E", "foo.ba|r baz"],
  ["foo.bar |baz", "b", "foo.|bar baz"],
  ["foo.bar |baz", "B", "|foo.bar baz"],
  ["|héllo wörld", "w", "héllo |wörld"],
  // A letter written as a base plus a separate combining mark is still a word character.
  ["|héllo wörld", "w", "héllo |wörld"],
  ["|👍🏽a", "l", "👍🏽|a"],
  ["abcd|ef\nxy\nlmnop", "j", "abcdef\nxy|\nlmnop"],
  ["abcd|ef\nxy\nlmnop", "jj", "abcdef\nxy\nlm|nop"],
  ["ab\nc|d", "j", "ab\ncd|"],
  ["a|b\ncd", "k", "|ab\ncd"],
  ["   a|bc", "^", "   |abc"],
  ["   a|bc", "0", "|   abc"],
  ["   a|bc", "$", "   abc|"],
  ["a\nb\nc|", "gg", "|a\nb\nc"],
  ["|a\nb\nc", "G", "a\nb\n|c"],
  ["a\nb\nc|", "2G", "a\n|b\nc"],
  ["a\nb|\nc", "1G", "a\nb\n|c"],
  ["|a\nb\nc", "5gg", "a\nb\n|c"],
  ["|a\nb\nc", "2gg", "a\n|b\nc"],
  ["|abc", "99999l", "abc|"],
  ["|abc", "3zl", "a|bc"],
  ["|abc", "0", "|abc"],
  ["|a b c", "10w", "a b c|"],
  ["a|bc", "h", "|abc"],
  ["|abc", "h", "|abc"],
  ["a\n|b", "h", "a|\nb"],
])

describe("count cap", () => {
  test("typing more digits never grows the count past 10000", () => {
    const e = editor("|abc").press("9999999")
    expect(e.state.vim.pending).toEqual({ kind: "count", count: Vim.COUNT_LIMIT })
  })
})

table("operators with motions", [
  ["|foo bar", "dw", "|bar", { reg: "foo " }],
  ["|foo bar", "de", "| bar", { reg: "foo" }],
  ["|foo bar", "cw", "| bar", { reg: "foo", mode: "insert" }],
  ["|a b c", "cw", "| b c", { reg: "a", mode: "insert" }],
  ["|a b c", "c2w", "| c", { mode: "insert" }],
  ["fo|o bar", "cw", "fo| bar", { reg: "o", mode: "insert" }],
  ["foo| bar", "cw", "foo|", { mode: "insert" }],
  ["|a b c d e f g h", "2d3w", "|g h"],
  ["|foo bar", "yw", "|foo bar", { reg: "foo " }],
  ["foo |bar", "db", "|bar"],
  ["a|bc\ndef", "d$", "a|\ndef"],
  ["a|bc\ndef", "D", "a|\ndef"],
  ["a|bc\ndef", "C", "a|\ndef", { mode: "insert" }],
  ["a|bc\ndef", "y$", "a|bc\ndef", { reg: "bc" }],
  ["abc|def", "d0", "|def"],
  ["|abcdefghijkl", "d10l", "|kl"],
  ["a|b\ncd\nef", "dj", "|ef", { reg: "ab\ncd\n" }],
  ["ab\nc|d\nef", "dk", "|ef"],
  ["ab\nc|d", "dj", "ab\nc|d"],
  ["a\nb|\nc", "dG", "|a"],
  ["ab\nc|d\nef", "dgg", "|ef"],
  ["ab\nc|d", "dk", "|"],
  ["ab|\ncd", "dk", "ab|\ncd"],
  ["foo |bar\nbaz", "dw", "foo |\nbaz", { reg: "bar" }],
  ["ab\n|cd", "dh", "ab|cd"],
  ["|abc", "d<Right>", "|bc"],
  ["|abc def", "d<Esc>w", "abc |def"],
  ["|abc def", "dzw", "abc |def"],
  ["|abc", "dh", "|abc", { register: "keep", reg: "keep" }],
  ["|abc def", "2dw", "|", { reg: "abc def" }],
  ["a|bc", "yl", "a|bc", { reg: "b" }],
  ["|abc\ndef", "d2d", "|abc\ndef"],
  ["|abc\ndef", "dgx", "|abc\ndef"],
])

table("text objects", [
  ["foo b|ar", "diw", "foo| ", { reg: "bar" }],
  ["foo b|ar baz", "daw", "foo |baz"],
  ["foo b|ar", "daw", "fo|o"],
  ["a | b", "diw", "a|b"],
  ["a | b", "daw", "a|b"],
  ["x foo.b|ar y", "diW", "x | y"],
  ["x foo.b|ar y", "daW", "x |y"],
  ['say "h|i there" now', 'di"', 'say "|" now'],
  ['say "h|i there" now', 'da"', "say | now"],
  ['say "h|i there" now', 'ci"', 'say "|" now', { mode: "insert" }],
  ['a "b" |c "d"', 'di"', 'a "b" |c "d"'],
  ["f(a|, (b), c)", "di(", "f(|)"],
  ["f(a|, (b), c)", "dib", "f(|)"],
  ["f(a|, (b), c)", "di)", "f(|)"],
  ["f(a|, (b), c)", "da(", "|f"],
  ["f(a|)", "di(", "f(|)"],
  ["f(|)", "di(", "f(|)"],
  ["{\n  |x\n}", "di{", "{|}"],
  ["{\n  |x\n}", "diB", "{|}"],
  ["a[|b]c", "di[", "a[|]c"],
  ["a<|b>c", "di<", "a<|>c"],
  ["a`|b`c", "di`", "a`|`c"],
  ["ab|c", "di(", "ab|c", { register: "keep", reg: "keep" }],
  ["foo b|ar baz", "2diw", "foo | baz"],
  ["foo b|ar baz", "d2iw", "foo | baz"],
  ["f(a|, b)", "yi(", "f(|a, b)", { reg: "a, b" }],
  ["foo b|ar", "diz", "foo b|ar"],
  ["f(|)", "ci(", "f(|)", { mode: "insert" }],
])

table("line commands and single commands", [
  ["|a\nb\nc\nd", "2dd", "|c\nd", { reg: "a\nb\n" }],
  ["a\n|b", "dd", "|a"],
  ["a\n|b\nc", "5dd", "|a"],
  ["|only", "cc", "|", { mode: "insert" }],
  ["a\n  |b\nc", "cc", "a\n|\nc", { mode: "insert" }],
  ["a\n  b|c", "yy", "a\n|  bc", { reg: "  bc\n" }],
  ["a\n  b|c", "Y", "a\n|  bc", { reg: "  bc\n" }],
  ["|a\nb\nc", "2Y", "|a\nb\nc", { reg: "a\nb\n" }],
  ["ab|c\ndef", "2D", "ab|\ndef"],
  ["|abcdef", "5x", "|f", { reg: "abcde" }],
  ["ab|", "x", "ab|"],
  ["a|b\ncd", "3x", "a|\ncd", { reg: "b" }],
  ["ab|\ncd", "x", "ab|\ncd"],
  ["|abc", "rz", "|zbc"],
  ["|abc", "3rz", "zz|z"],
  ["|abc", "4rz", "|abc"],
  ["|abc", "r<BS>", "|abc"],
  ["|abc", "r<Del>", "|abc"],
  ["|abc", "r<Esc>", "|abc"],
  ["|abc", "r👍", "|👍bc"],
  ["|aBc", "3~", "AbC|"],
  ["|ab\ncd", "5~", "AB|\ncd"],
  ["|a\n  b", "J", "a| b"],
  ["|a \nb", "J", "a |b"],
  ["|a\n\nb", "J", "a|\nb"],
  ["|a\nb\nc\nd", "2J", "a| b c\nd"],
  ["a\n|b", "J", "a\n|b"],
  ["|abc", "p", "|abc", { register: "" }],
  ["|abc", "p", "ax|ybc", { register: "xy" }],
  ["|abc", "P", "x|yabc", { register: "xy" }],
  ["|abc", "3p", "axyxyx|ybc", { register: "xy" }],
  ["abc|", "p", "abcx|y", { register: "xy" }],
  ["|a\nb", "p", "a\n|L\nb", { register: "L\n" }],
  ["|a\nb", "P", "|L\na\nb", { register: "L\n" }],
  ["|a\nb", "2p", "a\n|L\nL\nb", { register: "L\n" }],
  ["a\n|b", "p", "a\nb\n|L", { register: "L\n" }],
  ["|a\nb", "2>>", "  |a\n  b"],
  ["  |a\n  b", "<<", "|a\n  b"],
  ["|\tx", "<<", "|x"],
  ["| x", "<<", "|x"],
  ["|    x", "<<", "  |x"],
  ["|a\nb", ">x", "|a\nb"],
  ["|ab\ncd", "o", "ab\n|\ncd", { mode: "insert" }],
  ["|ab\ncd", "O", "|\nab\ncd", { mode: "insert" }],
  ["  a|b", "I", "  |ab", { mode: "insert" }],
  ["  a|b", "A", "  ab|", { mode: "insert" }],
  ["  a|b", "a", "  ab|", { mode: "insert" }],
  ["ab|\ncd", "a", "ab|\ncd", { mode: "insert" }],
  ["|abc", "?", "|abc"],
  ["|abc", "v?", "|abc", { mode: "visual" }],
  ["|", ">>", "  |"],
  ["|a\n\nb", "3>>", "  |a\n  \n  b"],
  ["a\n|\nb", ">>", "a\n  |\nb"],
  ["|  a", ">>", "    |a"],
  ["|abc", "2s", "|c", { reg: "ab", mode: "insert" }],
  ["a\n  |b", "S", "a\n|", { reg: "  b\n", mode: "insert" }],
  ["ab|c", "X", "a|c", { reg: "b" }],
  ["ab|c", "2X", "|c", { reg: "ab" }],
  ["a\nb|c", "3X", "a\n|c", { reg: "b" }],
  ["abc|", "u", "abc|"],
])

describe("keys that are not commands", () => {
  test("idle: arrows, Enter, Escape and Ctrl chords go to the ordinary editor", () => {
    for (const token of ["<Left>", "<Right>", "<Up>", "<Down>", "<CR>", "<Esc>", "<C-r>"]) {
      const e = editor("a|bc")
      e.press(token)
      expect(e.passed).toEqual([token])
      expect(e.shown()).toBe("a|bc")
    }
  })

  test("idle: other keys are swallowed", () => {
    const e = editor("a|bc")
    e.press("z<Tab>")
    expect(e.passed).toEqual([])
    expect(e.shown()).toBe("a|bc")
  })

  test("Escape and Enter drop a pending command and still pass through", () => {
    const e = editor("|abc def")
    e.press("2d<Esc>")
    expect(e.passed).toEqual(["<Esc>"])
    expect(e.state.vim.pending).toEqual({ kind: "idle" })
    e.press("d<CR>")
    expect(e.passed).toEqual(["<Esc>", "<CR>"])
    expect(e.state.vim.pending).toEqual({ kind: "idle" })
    expect(e.shown()).toBe("|abc def")
  })

  test("Backspace moves left as h, Delete deletes as x", () => {
    const e = editor("ab|c")
    e.press("<BS>")
    expect(e.shown()).toBe("a|bc")
    e.press("<Del>")
    expect(e.shown()).toBe("a|c")
    expect(e.state.vim.register).toBe("b")
  })

  test("Delete after an operator or inside a count drops the command", () => {
    const e = editor("|abc")
    e.press("d<Del>")
    expect(e.shown()).toBe("|abc")
    e.press("2<Del>")
    expect(e.shown()).toBe("|abc")
    expect(e.state.vim.pending).toEqual({ kind: "idle" })
  })

  test("arrows act as h j k l while a count or operator is pending", () => {
    expect(editor("a|bc\ndef").press("d<Down>").shown()).toBe("|")
    expect(editor("|abc").press("2<Right>").shown()).toBe("ab|c")
  })
})

describe("mode changes", () => {
  test("leaving insert mode steps one grapheme left, but not at the start of a line or text", () => {
    const left = (fixture: string) => {
      const e = editor(fixture, { mode: "insert" })
      const snap = { text: e.state.text, cursor: e.state.cursor, parts: e.state.parts }
      return e.state.text.slice(0, Vim.leaveInsert(snap)) + "|" + e.state.text.slice(Vim.leaveInsert(snap))
    }
    expect(left("ab|c")).toBe("a|bc")
    expect(left("ab\n|cd")).toBe("ab\n|cd")
    expect(left("|abc")).toBe("|abc")
    expect(left("a👍🏽|")).toBe("a|👍🏽")
  })
})

describe("registers", () => {
  test("d, x, cw, yiw, s and X overwrite the unnamed register; p r ~ J >> leave it", () => {
    const e = editor("|aa bb cc dd ee ff\ngg\nhh", { register: "keep" })
    e.press("p")
    expect(e.state.vim.register).toBe("keep")
    e.press("rx~")
    expect(e.state.vim.register).toBe("keep")
    e.press("J>>")
    expect(e.state.vim.register).toBe("keep")
    for (const [start, keys, reg] of [
      ["|one two", "yiw", "one"],
      ["|one two", "x", "o"],
      ["|one two", "dd", "one two\n"],
      ["|one two", "s", "o"],
      ["|one two", "cw", "one"],
      ["o|ne two", "X", "o"],
    ] as const) {
      const fresh = editor(start, { register: "keep" })
      fresh.press(keys)
      expect(fresh.state.vim.register).toBe(reg)
    }
  })

  test('"+ before x and dd writes what they delete', () => {
    const e = editor("|ab\ncd")
    e.press('"+x"+dd')
    expect(e.written).toEqual(["a", "b\n"])
  })

  test('"+ writes the yank to the clipboard and the unnamed register', () => {
    const e = editor("|one two\nthree")
    e.press('"+yy')
    expect(e.written).toEqual(["one two\n"])
    expect(e.state.vim.register).toBe("one two\n")
    e.press('"+yiw')
    expect(e.written).toEqual(["one two\n", "one"])
    expect(e.state.vim.clipboard).toBe(false)
  })

  test('"+p reads the clipboard: CRLF folds, text pastes linewise or charwise', () => {
    const lines = editor("|a\nb", { clip: { data: "one\r\ntwo\r\n", mime: "text/plain" } })
    lines.press('"+p')
    expect(lines.shown()).toBe("a\n|one\ntwo\nb")
    const chars = editor("|ab", { clip: { data: "x", mime: "text/plain" } })
    chars.press('"+p')
    expect(chars.shown()).toBe("a|xb")
    const before = editor("|ab", { clip: { data: "x", mime: "text/plain" } })
    before.press('"+P')
    expect(before.shown()).toBe("|xab")
  })

  test.each([
    ["an image", { data: "AAAA", mime: "image/png" }],
    ["an empty result", { data: "", mime: "text/plain" }],
    ["no content", undefined],
    ["a failed read", "fail"],
  ] as Array<[string, Clip]>)('"+p with %s pastes nothing', (_name, clip) => {
    const e = editor("|ab", { clip, register: "reg" })
    e.press('"+p')
    expect(e.shown()).toBe("|ab")
    expect(e.state.vim.register).toBe("reg")
  })

  test('"z drops the prefix and "" is the unnamed register', () => {
    const e = editor("|ab", { register: "xy" })
    e.press('"zp')
    expect(e.shown()).toBe("ax|yb")
    const f = editor("|ab", { register: "xy" })
    f.press('""p')
    expect(f.shown()).toBe("ax|yb")
    expect(f.written).toEqual([])
  })

  test("a half-typed prefix is dropped by Escape", () => {
    const e = editor("|ab", { register: "xy" })
    e.press('"+<Esc>p')
    expect(e.state.vim.clipboard).toBe(false)
    expect(e.shown()).toBe("ax|yb")
  })
})

describe("undo", () => {
  test("u steps back once", () => {
    const e = editor("|a\nb\nc\nd")
    e.press("3dd")
    expect(e.shown()).toBe("|d")
    e.press("u")
    expect(e.shown()).toBe("|a\nb\nc\nd")
  })
})

describe("prompt parts", () => {
  test("dw whose range would end inside a part removes the whole part", () => {
    const e = editor("|ab [[@src/file.ts]] z")
    // The word `ab`, then the space, then the part: the range ends at the part start, so only `ab ` goes.
    e.press("dw")
    expect(e.shown()).toBe("|@src/file.ts z")
  })

  test("a range that starts inside a part widens to it", () => {
    const e = editor("[[@src/f|ile.ts]] z")
    e.press("diw")
    expect(e.shown()).toBe("| z")
    expect(e.state.vim.register).toBe("@src/file.ts")
  })

  test("l from just before a part lands just after it", () => {
    const e = editor("a|[[@src/file.ts]] z")
    e.press("l")
    expect(e.shown()).toBe("a@src/file.ts| z")
  })

  test("h from just after a part lands before it", () => {
    const e = editor("a[[@src/file.ts]]| z")
    e.press("h")
    expect(e.shown()).toBe("a|@src/file.ts z")
  })

  test("r and ~ leave the part unchanged", () => {
    const e = editor("|[[@src/file.ts]] z")
    e.press("rx")
    expect(e.shown()).toBe("|@src/file.ts z")
    e.press("~")
    expect(e.shown()).toBe("@src/file.ts| z")
    expect(e.state.text).toBe("@src/file.ts z")
  })

  test("x removes the whole part", () => {
    const e = editor("|[[@src/file.ts]] z")
    e.press("x")
    expect(e.shown()).toBe("| z")
  })
})

describe("display rows", () => {
  test("gj and gk move one display row; dgj is characterwise", () => {
    const e = editor("abcdefghij|klmnopqrst", { width: 10 }).press("gj")
    expect(e.shown()).toBe("abcdefghijklmnopqrst|")
    const d = editor("abc|defghijklmnopqrst", { width: 10 }).press("dgj")
    expect(d.state.text).toBe("abcnopqrst")
    expect(d.state.vim.register).toBe("defghijklm")
  })
})

describe("long first line that wraps (C4)", () => {
  const long = "x".repeat(25)
  test("J, linewise p and o act on the logical line", () => {
    const joined = editor(`|${long}\nb`, { width: 10 }).press("J")
    expect(joined.state.text).toBe(`${long} b`)
    const pasted = editor(`|${long}\nb`, { width: 10, register: "L\n" }).press("p")
    expect(pasted.state.text).toBe(`${long}\nL\nb`)
    const opened = editor(`${long}\n|b`, { width: 10 }).press("o")
    expect(opened.state.text).toBe(`${long}\nb\n`)
  })
})

const char = (value: string): Vim.Key => ({ name: value.toLowerCase(), sequence: value })

describe("find motions", () => {
  table("f, F, t, T and the repeats", [
    ["|a-b-c", "f-", "a|-b-c"],
    ["|a-b-c", "2f-", "a-b|-c"],
    ["|a-b-c", "f-;", "a-b|-c"],
    ["|a-b-c", "f-;,", "a|-b-c"],
    ["|a-b-c-d", "f-2;", "a-b-c|-d"],
    ["|abc-d", "t-", "ab|c-d"],
    ["|a-b-c", "t-", "|a-b-c"],
    // After a t whose target is the next grapheme, ; stays put instead of skipping ahead.
    ["|a-b-c", "t-;", "|a-b-c"],
    ["a-bc|d", "F-", "a|-bcd"],
    ["a-bc|d", "T-", "a-|bcd"],
    ["|abc", "Fa", "|abc"],
    ["|ab\ncd", "fc", "ab\n|cd"],
    ["|a-b-c-", "f-fz;", "a-b|-c-"],
    ["|a3b", "f3", "a|3b"],
    ["|adb", "fd", "a|db"],
    ["|a b", "f ", "a| b"],
    ["|a[[@x(y)]]b(", "f(", "a@x(y)b|("],
    ["|a-b", ";", "|a-b"],
    ["a-b|-c", ",", "a-b|-c"],
    ["|a-b-c", "f-,", "a|-b-c"],
    ["|a-b", "f<Esc>", "|a-b"],
    ["|a-b", "f<BS>", "|a-b"],
    ["|a-b", "f<Left>", "|a-b"],
    ["|a-b", "f<Tab>", "|a-b"],
  ])

  test("a failed find keeps the last find, and a repeat does not replace it", () => {
    const e = editor("|a-b-c-").press("f-fz")
    expect(e.state.vim.lastFind).toEqual({ kind: "f", char: "-" })
    e.press(",")
    expect(e.state.vim.lastFind).toEqual({ kind: "f", char: "-" })
  })

  test("Enter while a find waits passes and leaves nothing pending", () => {
    const e = editor("|a-b").press("f<CR>")
    expect(e.passed).toEqual(["<CR>"])
    expect(e.state.vim.pending).toEqual({ kind: "idle" })
  })

  test("a multi-code-point grapheme matches whole, a bare part of it does not", () => {
    const e = editor("|a\u{1F44D}\u{1F3FD}b\u{1F44D}\u{1F3FD}")
    e.send(char("f")).send({ name: "", sequence: "\u{1F44D}" })
    expect(e.state.cursor).toBe(0)
    e.send(char("f")).send({ name: "", sequence: "\u{1F44D}\u{1F3FD}" })
    expect(e.state.cursor).toBe(1)
  })

  test("a count above the text finishes at once and moves nothing", () => {
    const e = editor("|a-b").press("10000f-")
    expect(e.shown()).toBe("|a-b")
  })

  table("an operator with a find", [
    ["|abc-def", "df-", "|def", { reg: "abc-" }],
    ["|abc-def", "dt-", "|-def", { reg: "abc" }],
    ["|abc-def", "cf-", "|def", { reg: "abc-", mode: "insert" }],
    ["|abc-def", "yf-", "|abc-def", { reg: "abc-" }],
    ["abc-de|f", "dF-", "ab|c", { reg: "-def" }],
    ["abc-de|f", "dT-", "abc|-", { reg: "def" }],
    ["|a-b", "dt-", "|-b", { reg: "a" }],
    ["|a-b-c-d-e", "d2f-", "|c-d-e", { reg: "a-b-" }],
    ["|a-b-c-d-e", "2df-", "|c-d-e", { reg: "a-b-" }],
    ["|abcd", "xdfz", "|bcd", { reg: "a" }],
    ["|abc", "dfz", "|abc", { reg: "" }],
    ["|a-b", "f-d;", "a|-b"],
    ["|a-b", "f-c,", "a|-b"],
    ["|abc[[@x]]-d", "df-", "|d", { reg: "abc@x-" }],
    ["|abc-[[@x]]d", "dt-", "|-@xd", { reg: "abc" }],
  ])

  test("an operator find remembers the find", () => {
    const e = editor("|a-b-c").press("df-fz")
    expect(e.state.vim.lastFind).toEqual({ kind: "f", char: "-" })
  })
})

describe("percent", () => {
  table("bracket matching", [
    ["|(a(b)c)", "%", "(a(b)c|)"],
    ["|(a(b)c)", "%%", "|(a(b)c)"],
    ["x|y(a)", "%", "xy(a|)"],
    ["(a\nb|)", "%", "|(a\nb)"],
    ["|ab\n(c)", "%", "|ab\n(c)"],
    ["|abc", "%", "|abc"],
    ["|(abc", "%", "|(abc"],
    ["|([)]", "%", "([|)]"],
    ["|<a>", "%", "|<a>"],
    ['|("(")', "%", '|("(")'],
    ["|(a)", "5%", "|(a)"],
    ["|[[@f(x)]](y)", "%", "@f(x)(y|)"],
    ["x|(a)y", "d%", "x|y", { reg: "(a)" }],
    ["|x(a)y", "d%", "|y", { reg: "x(a)" }],
    ["(a|b)", "d%", "|)", { reg: "(ab" }],
    ["|(a)b", "y%", "|(a)b", { reg: "(a)" }],
    ["|(a)b", "c%", "|b", { reg: "(a)", mode: "insert" }],
    ["|(a)", "d5%", "|(a)"],
    ["|(a)", "5d%", "|(a)"],
  ])

  test("a long unbalanced line finishes at once", () => {
    const e = editor("|" + "(".repeat(20000))
    e.press("%")
    expect(e.state.cursor).toBe(0)
  })
})

describe("dot repeat", () => {
  table("repeating the last change", [
    ["|a\nb\nc\nd\ne", "2dd.", "|e"],
    ["a\nb\n|c\nd\ne", "dgg", "|d\ne"],
    ["a\nb\n|c\nd\ne", "dggj.", "|"],
    ["|a\nb\nc\nd", "d3G.", "|"],
    ["|a b c d", "dw.", "|c d"],
    ["|abcdef", "2x.", "|ef"],
    // A count typed before . is dropped: the change repeats with its own count.
    ["|abcdef", "x5.", "|cdef"],
    ["|abcd", "rXl.", "X|Xcd"],
    ["|ab", "~.", "AB|"],
    ["|a\nb", ">>j.", "  a\n  |b"],
    ["|a\nb\nc", "J.", "a b| c"],
    ["|a-b-c", "df-.", "|c"],
    ["|a-b-c-d", "df-fz.", "|c-d"],
    ["|abcdef", "D.", "|"],
    ["|a\nb\nc", "yyj.", "a\n|b\nc", { reg: "b\n" }],
    ["|abcd", "xdfz.", "|cd"],
    ["|abc", "xp.", "b|c"],
    ["|abc", ".", "|abc"],
    ["|a b c", "dww.", "b| "],
    ["|one two", "dwyw.", "|two", { reg: "two" }],
  ])

  test("the line operators repeat as they ran, and cc repeats into insert mode", () => {
    const e = editor("|ab\ncd").press("cc<Esc>j.")
    expect(e.state.text).toBe("\n")
    expect(e.state.vim.mode).toBe("insert")
  })

  test("typed text is repeated at the cursor and leaves normal mode with the cursor after it", () => {
    const e = editor("|xy").press("ihello<Esc>$.")
    expect(e.state.text).toBe("helloxyhello")
    expect(e.shown()).toBe("helloxyhello|")
    expect(e.state.vim.mode).toBe("normal")
  })

  test("Backspace trims what was typed, and an empty record ignores it", () => {
    expect(editor("|").press("iabc<BS>d<Esc>.").state.text).toBe("ababdd")
    const e = editor("ab|", { mode: "insert" }).press("<BS><BS>x<Esc>")
    expect(e.state.vim.lastChange).toEqual({ kind: "text", text: "x" })
  })

  test("typed text replaces the change that opened insert mode", () => {
    const e = editor("|one two").press("cwfoo<Esc>w.")
    expect(e.state.text).toBe("foo footwo")
  })

  test("an insert with nothing typed keeps the opening change", () => {
    const e = editor("|one two").press("cw<Esc>w.")
    expect(e.state.text).toBe(" ")
    expect(e.state.vim.mode).toBe("insert")
  })

  test("o with text repeats the text, not the new line", () => {
    const e = editor("|ab").press("oabc<Esc>.")
    expect(e.state.text).toBe("ab\nababcc")
  })

  test("a replay does not replace the change, and can be repeated", () => {
    const e = editor("|abcdef").press("x...")
    expect(e.state.text).toBe("ef")
    expect(e.state.vim.lastChange).toEqual({ kind: "keys", keys: ["x"] })
  })

  test("restarting the typed record keeps the last change", () => {
    const base = editor("|abc").press("x").state.vim
    const typing = Vim.insertKey({ ...base, mode: "insert" }, char("a"))
    expect(typing.typed).toBe("a")
    const sent = Vim.restartTyped(typing)
    expect(sent.typed).toBe("")
    expect(sent.lastChange).toEqual(base.lastChange)
  })

  test("keys that are not typing add nothing to the record", () => {
    const e = editor("|", { mode: "insert" })
    e.send({ name: "x", sequence: "\x18", ctrl: true })
      .send({ name: "return", sequence: "\r" })
      .send({ name: "tab", sequence: "\t" })
      .send({ name: "left", sequence: "\x1b[D" })
    expect(e.state.vim.typed).toBe("")
    e.send(char("a")).send({ name: "left", sequence: "\x1b[D" }).send(char("b"))
    expect(e.state.vim.typed).toBe("ab")
  })

  test("replaying an operator find uses its own find and remembers it again", () => {
    const e = editor("|a-b+c-d+e").press("df-f+.")
    expect(e.state.text).toBe("bd+e")
    expect(e.state.vim.lastFind).toEqual({ kind: "f", char: "-" })
  })
})

describe("visual mode", () => {
  table("operators on a selection", [
    ["|abc def", "vlld", "| def", { reg: "abc" }],
    ["|abc def", "vey", "|abc def", { reg: "abc" }],
    ["|abc def", "vec", "| def", { reg: "abc", mode: "insert" }],
    ["a|bc\nde", "v$d", "a|de", { reg: "bc\n" }],
    ["a|bc\nde", "vjd", "|a", { reg: "bc\nde" }],
    ["|abcdef", "vllold", "a|def", { reg: "bc" }],
    ["|a\nb\nc", "Vd", "|b\nc", { reg: "a\n" }],
    ["|a\nb\nc", "Vjd", "|c", { reg: "a\nb\n" }],
    ["|a\nb\nc", "Vjy", "|a\nb\nc", { reg: "a\nb\n" }],
    ["|a\nb", "Vc", "|\nb", { reg: "a\n", mode: "insert" }],
    ["|ab\ncd", "vjVd", "|", { reg: "ab\ncd\n" }],
    ["|ab", "Vvd", "|b", { reg: "a" }],
    ["|ab", "vv", "|ab"],
    ["|a\nb", "Vj>", "  |a\n  b"],
    ["|a\nb", "V2>", "    |a\nb"],
    ["|  a\n  b", "vj<", "|a\nb"],
    ["|a\nb", "v>", "  |a\nb"],
    ["|abcdef", "v3ld", "|ef", { reg: "abcd" }],
    ["|a-b-c", "vf-d", "|b-c", { reg: "a-" }],
    ["|a-b-c", "vf-;d", "|c", { reg: "a-b-" }],
    ["|(ab)c", "v%d", "|c", { reg: "(ab)" }],
    ["|ab", "v<Esc>", "|ab"],
    ["|ab", "vl<CR>", "a|b"],
    ["|abc", "v<Right><Right>d", "|", { reg: "abc" }],
    ["|abc", "v<S-Right>d", "|c", { reg: "ab" }],
    ["a|bc", "v<BS>d", "|c", { reg: "ab" }],
    ["|[[@x]]b", "vd", "|b", { reg: "@x" }],
    ["|", "vd", "|"],
    ["|", "Vd", "|", { reg: "\n" }],
    ["|", "vc", "|", { mode: "insert" }],
    ["|ab", "vp", "|ab", { mode: "visual" }],
    ["|ab", "vu", "|ab", { mode: "visual" }],
    ["|ab", "vx", "|ab", { mode: "visual" }],
    ["|ab", "v.", "|ab", { mode: "visual" }],
    ["|ab", "3v", "|ab", { mode: "visual" }],
    ["|abc", "vlll<Esc>", "abc|"],
  ])

  test('"+y in visual mode sends the selection to the clipboard and the register', () => {
    const e = editor("|abc").press('vl"+y')
    expect(e.written).toEqual(["ab"])
    expect(e.state.vim.register).toBe("ab")
  })

  test("the selection follows the head, o swaps the ends, and leaving removes it", () => {
    const e = editor("|abcdef").press("vll")
    expect(e.selected()).toBe("abc")
    e.press("o")
    expect(e.selected()).toBe("abc")
    expect(e.shown()).toBe("|abcdef")
    e.press("V")
    expect(e.selected()).toBe("abcdef")
    e.press("<Esc>")
    expect(e.selected()).toBeUndefined()
  })

  test("Escape is consumed, Enter and a chord pass and end the selection", () => {
    const esc = editor("|ab").press("v<Esc>")
    expect(esc.passed).toEqual([])
    expect(esc.state.vim.mode).toBe("normal")
    const enter = editor("|ab").press("vl<CR>")
    expect(enter.passed).toEqual(["<CR>"])
    expect(enter.state.vim.mode).toBe("normal")
    const chord = editor("|ab").press("v<C-x>")
    expect(chord.passed).toEqual(["<C-x>"])
    expect(chord.state.vim.mode).toBe("normal")
    expect(chord.selected()).toBeUndefined()
  })

  test("repeating a visual operator covers the same amount of text", () => {
    expect(editor("|abcdef").press("vlld.").state.text).toBe("")
    expect(editor("|a\nb\nc\nd").press("Vjd.").state.text).toBe("")
    const e = editor("|ab\ncd\nef").press("vjd")
    expect(e.shown()).toBe("|d\nef")
    e.press(".")
    expect(e.shown()).toBe("|f")
  })

  test("a visual yank is recorded like the other operators", () => {
    const e = editor("|ab cd").press("vly")
    expect(e.state.vim.lastChange?.kind).toBe("visual")
  })

  test("a count before v is dropped and pending state is cleared on leaving", () => {
    const e = editor("|abc").press("2v")
    expect(e.state.vim.mode).toBe("visual")
    e.press("2<Esc>")
    expect(e.state.vim.pending).toEqual({ kind: "idle" })
    expect(e.state.vim.mode).toBe("normal")
  })

  test("the selection ends at a part, never inside one", () => {
    const e = editor("a|b[[@file]]c").press("vl")
    expect(e.selected()).toBe("b@file")
  })
})

// A loop that never advances blocks the event loop, so these run in a child process with a deadline.
describe("loops", () => {
  test("a huge count, a bracket search and a word motion next to a part finish at once", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Vim } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/component/prompt/vim-state.ts"))})
const press = (text, cursor, parts, keys) => {
  let state = { ...Vim.initial, mode: "normal" }
  let at = cursor
  let body = text
  for (const char of keys) {
    const result = Vim.step(state, { name: char.toLowerCase(), sequence: char, shift: char !== char.toLowerCase() }, { text: body, cursor: at, parts, row: (x) => x })
    state = result.state
    body = Vim.apply(body, result.edits)
    at = result.cursor
  }
  return at
}
press("word ".repeat(2000), 0, [], "9999w")
press("(".repeat(5000) + "x" + ")".repeat(5000), 5000, [], "di(")
press("ab cd ef", 0, [{ start: 3, end: 5 }], "www")
press("a-".repeat(30000), 0, [], "10000f-")
press("(".repeat(20000), 0, [], "%d%")
console.log("done")`,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    )
    expect(await new Response(child.stdout).text()).toBe("done\n")
    expect(await child.exited).toBe(0)
  })
})
