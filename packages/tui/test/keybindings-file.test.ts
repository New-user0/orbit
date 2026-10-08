import { expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canLinkFile } from "../../core/test/fixture/symlink"
import { TuiKeybind } from "../src/config/keybind"
import { KeybindingsFile } from "../src/config/keybindings-file"
import { tmpdir } from "./fixture/fixture"

const messages = (result: KeybindingsFile.Result) => result.diagnostics.map((item) => item.message)

test("applies a valid file, comments and trailing commas included", () => {
  const result = KeybindingsFile.decode(`{
    // Keys of my own.
    "$schema": "https://example.invalid/keybindings.json",
    "leader": "ctrl+a",
    "bindings": {
      "session.new": "ctrl+k ctrl+s",
      "session.list": ["<leader>l", "ctrl+n"],
      "prompt.paste": { "key": "ctrl+shift+v", "preventDefault": false },
      "mcp.list": { "name": "m", "ctrl": true },
    },
    "contexts": {
      "session-list": { "session.rename": "ctrl+shift+r" },
      "mini": { "prompt.clear": "ctrl+g" },
    },
  }`)

  expect(result).toEqual({
    leader: "ctrl+a",
    bindings: {
      "session.new": "ctrl+k ctrl+s",
      "session.list": ["<leader>l", "ctrl+n"],
      "prompt.paste": { key: "ctrl+shift+v", preventDefault: false },
      "mcp.list": { name: "m", ctrl: true },
    },
    contexts: {
      "session-list": { "session.rename": "ctrl+shift+r" },
      mini: { "prompt.clear": "ctrl+g" },
    },
    diagnostics: [],
  })
})

const goodBinding = '"session.new": "ctrl+n"'
const goodContext = '"session-list": { "session.rename": "ctrl+shift+r" }'

// Each case is one bad entry, put beside good ones in both of the places an entry can be.
test.each([
  ["a name that is not a command", `${goodBinding}, "no.such.command": "ctrl+z"`, goodContext, "", '"no.such.command"'],
  ["the leader named as a command", `${goodBinding}, "leader": "ctrl+z"`, goodContext, "", '"leader"'],
  ["a key with no name", `${goodBinding}, "model.list": "ctrl+"`, goodContext, "", '"ctrl+"'],
  ["a chord with a stroke missing", `${goodBinding}, "model.list": "ctrl+k ctrl+"`, goodContext, "", '"ctrl+k ctrl+"'],
  ["an empty key", `${goodBinding}, "model.list": ""`, goodContext, "", '"model.list"'],
  ["a comma list with an empty member", `${goodBinding}, "model.list": "ctrl+a,"`, goodContext, "", '"ctrl+a,"'],
  ["a <name> that does not exist", `${goodBinding}, "model.list": "<nothing>q"`, goodContext, "", "<nothing>"],
  ["a number for keys", `${goodBinding}, "model.list": 12`, goodContext, "", '"model.list"'],
  ["a list that holds a bad key", `${goodBinding}, "model.list": ["ctrl+m", "ctrl+"]`, goodContext, "", '"ctrl+"'],
  [
    "a context that does not exist",
    goodBinding,
    `${goodContext}, "sessoin": { "model.list": "ctrl+m" }`,
    "",
    '"sessoin"',
  ],
  ["a context that is not an object", goodBinding, `${goodContext}, "mini": 5`, "", "contexts.mini"],
  ["a bad key in a context", goodBinding, `${goodContext}, "diff": { "diff.down": "shift+" }`, "", '"shift+"'],
  ["a setting the file does not have", goodBinding, goodContext, ', "extra": true', '"extra"'],
])("leaves out %s and applies the rest", (_name, bindings, contexts, extra, mention) => {
  const result = KeybindingsFile.decode(`{ "bindings": { ${bindings} }, "contexts": { ${contexts} }${extra} }`)

  expect(result.diagnostics.filter((item) => item.severity === "error")).toHaveLength(1)
  expect(messages(result).join("\n")).toContain(mention)
  // The bad entry is not in the result and its good neighbours are.
  const everything = JSON.stringify(result.bindings) + JSON.stringify(result.contexts)
  for (const dropped of [
    "no.such.command",
    "sessoin",
    "ctrl+z",
    "<nothing>",
    "model.list",
    '"leader"',
    '"diff"',
    '"mini"',
  ])
    expect(everything).not.toContain(dropped)
  expect(result.contexts["session-list"]).toEqual({ "session.rename": "ctrl+shift+r" })
  expect(result.bindings).toEqual({ "session.new": "ctrl+n" })
})

test.each([
  ["bindings", '{ "bindings": [], "contexts": { "mini": { "prompt.clear": "ctrl+g" } } }'],
  ["contexts", '{ "bindings": { "session.new": "ctrl+n" }, "contexts": 5 }'],
])("ignores a %s section that is not an object and applies the other", (section, text) => {
  const result = KeybindingsFile.decode(text)

  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.message).toContain(`${section} has to be an object`)
  expect(Object.keys(result.bindings).length + Object.keys(result.contexts).length).toBe(1)
})

test("null unbinds a command, everywhere or in one context", () => {
  const result = KeybindingsFile.decode(`{
    "bindings": { "app.exit": null },
    "contexts": { "session-list": { "session.delete": null } }
  }`)

  expect(result.diagnostics).toEqual([])
  expect(result.bindings["app.exit"]).toBe("none")
  const override = KeybindingsFile.overrides(result)
  // An empty list is what tells a layer to leave the command's default key unbound.
  expect(override(undefined, "app.exit")).toEqual([])
  expect(override("permission", "app.exit")).toEqual([])
  expect(override("session-list", "session.delete")).toEqual([])
  expect(override("session", "session.delete")).toBeUndefined()
  expect(override(undefined, "session.delete")).toBeUndefined()
})

test("answers for a context first, then for any layer", () => {
  const override = KeybindingsFile.overrides(
    KeybindingsFile.decode(`{
      "bindings": { "session.rename": "ctrl+n", "session.fork": "f6" },
      "contexts": { "session-list": { "session.rename": "ctrl+shift+r" } }
    }`),
  )

  expect(override("session-list", "session.rename")).toMatchObject([{ key: "ctrl+shift+r", cmd: "session.rename" }])
  expect(override("session", "session.rename")).toMatchObject([{ key: "ctrl+n", cmd: "session.rename" }])
  expect(override(undefined, "session.rename")).toMatchObject([{ key: "ctrl+n" }])
  // A context that the file does not mention falls back to what applies everywhere.
  expect(override("session-list", "session.fork")).toMatchObject([{ key: "f6" }])
  expect(override("session-list", "model.list")).toBeUndefined()
  expect(override("session-list", "session.rename")?.[0]?.desc).toBe("Rename session")
})

test.each([
  [
    "two commands on the same key in bindings",
    '{ "bindings": { "session.new": "ctrl+n", "session.list": "ctrl+n" } }',
    'bindings: "session.new" and "session.list" both use ctrl+n.',
  ],
  [
    "two commands on the same chord in one context",
    '{ "contexts": { "mini": { "prompt.clear": "ctrl+k ctrl+s", "prompt.paste": "ctrl+k ctrl+s" } } }',
    "contexts.mini:",
  ],
  [
    "a chord that two commands spell differently",
    '{ "bindings": { "session.new": "ctrl+k enter", "session.list": "ctrl+k return" } }',
    "both use ctrl+k ",
  ],
  [
    "a key that is also the start of a chord",
    '{ "bindings": { "session.new": "ctrl+k", "session.list": "ctrl+k ctrl+s" } }',
    "start the same way",
  ],
  [
    "a leader sequence that spells out the leader",
    '{ "leader": "ctrl+a", "bindings": { "session.new": "<leader>n", "session.list": "ctrl+a n" } }',
    "both use",
  ],
])("warns about %s", (_name, text, expected) => {
  const result = KeybindingsFile.decode(text)

  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.severity).toBe("warning")
  expect(result.diagnostics[0]?.message).toContain(expected)
  // A conflict is only a warning: both entries still apply.
  expect(Object.keys(result.bindings).length + Object.keys(result.contexts.mini ?? {}).length).toBe(2)
})

test("does not warn when the same keys are set in different scopes, or twice for one command", () => {
  const result = KeybindingsFile.decode(`{
    "bindings": { "session.new": "ctrl+n", "session.list": ["ctrl+l", "ctrl+l"] },
    "contexts": {
      "session": { "session.fork": "ctrl+n" },
      "mini": { "prompt.clear": "ctrl+n" }
    }
  }`)

  expect(result.diagnostics).toEqual([])
})

test("never compares the file with Orbit's own default keys", () => {
  // ctrl+l is app.clear's default, ctrl+p is the palette's and ctrl+r is session.rename's: the layers of each already
  // decide which of those wins, so using them is not a conflict.
  const result = KeybindingsFile.decode(`{
    "bindings": { "session.new": "ctrl+l", "session.list": "ctrl+p", "model.list": "ctrl+r" },
    "contexts": { "session-list": { "session.pin.toggle": "ctrl+r" } }
  }`)

  expect(result.diagnostics).toEqual([])
  expect(Object.keys(result.bindings)).toEqual(["session.new", "session.list", "model.list"])
})

test.each([
  ["a file that is cut short", '{ "bindings": { "session.new": "ctrl+n" '],
  ["a missing comma", '{ "bindings": { "session.new": "ctrl+n" "session.list": "ctrl+l" } }'],
  ["text after the object", '{ "bindings": {} } trailing'],
  ["a list", "[1, 2]"],
  ["a number", "7"],
])("ignores all of a file with %s, with one note", (_name, text) => {
  const result = KeybindingsFile.decode(text)

  expect(result.bindings).toEqual({})
  expect(result.contexts).toEqual({})
  expect(result.leader).toBeUndefined()
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.severity).toBe("error")
  expect(result.diagnostics[0]?.message).toContain("Orbit is ignoring all of it")
})

test("names the place of a syntax error", () => {
  const result = KeybindingsFile.decode('{\n  "bindings": {\n    "session.new": ,\n  }\n}')

  expect(result.diagnostics[0]?.message).toContain("line 3")
})

test("says nothing about an empty file or one that holds only comments", () => {
  for (const text of ["", "  \n", "// nothing here yet\n", "/* nothing */"])
    expect(KeybindingsFile.decode(text)).toEqual(KeybindingsFile.empty)
})

test("reads chords, comma lists and spelled-out keys as the keymap does", () => {
  const result = KeybindingsFile.decode(`{
    "bindings": {
      "session.new": "ctrl+k ctrl+s,<leader>n",
      "session.list": "ctrl+k enter",
      "model.list": "esc",
      "agent.list": "gg",
      "mcp.list": "ctrl+x ctrl+c"
    }
  }`)

  expect(result.diagnostics).toEqual([])
  expect(Object.keys(result.bindings)).toHaveLength(5)
})

test("takes one key as the leader and says why it refuses another", () => {
  expect(KeybindingsFile.decode('{ "leader": "ctrl+a" }')).toMatchObject({ leader: "ctrl+a", diagnostics: [] })
  expect(KeybindingsFile.decode('{ "leader": { "name": "a", "ctrl": true } }')).toMatchObject({
    leader: { name: "a", ctrl: true },
    diagnostics: [],
  })

  for (const text of [
    '{ "leader": "ctrl+k ctrl+s" }',
    '{ "leader": "ctrl+a,ctrl+b" }',
    '{ "leader": 4 }',
    '{ "leader": [] }',
  ]) {
    const refused = KeybindingsFile.decode(text)
    expect(refused.leader).toBeUndefined()
    expect(refused.diagnostics).toHaveLength(1)
    expect(refused.diagnostics[0]?.message).toContain(`it stays ${TuiKeybind.LeaderDefault}`)
  }
})

test("null turns the leader off, and a sequence that starts with it then has nothing to start from", () => {
  const result = KeybindingsFile.decode(
    '{ "leader": null, "bindings": { "session.new": "<leader>n", "session.list": "ctrl+l" } }',
  )

  expect(result.leader).toBe("none")
  expect(Object.keys(result.bindings)).toEqual(["session.list"])
  expect(messages(result)).toEqual([
    'bindings: "session.new": "<leader>n" uses <leader> while the leader key is turned off.',
  ])
})

test("checks a <leader> sequence against the leader the file sets", () => {
  // With the leader on ctrl+a, `<leader>n` and `ctrl+a n` are the same keys, which is a clash the file made itself.
  const result = KeybindingsFile.decode(
    '{ "leader": "ctrl+a", "bindings": { "session.new": "<leader>n", "session.list": "ctrl+a n" } }',
  )

  expect(result.diagnostics.map((item) => item.severity)).toEqual(["warning"])
})

// Text that acts on a terminal: an OSC title, a CSI erase, a C1 control and a right-to-left override.
const hostile = "\u001b]0;pwned\u0007\u001b[2K\u009b\u{202e}"
const written = ["\\x1b", "\\x07", "\\x9b", "\\u{202e}"]

test.each([
  ["a setting", { [`top${hostile}`]: 1 }],
  ["a command", { bindings: { [`cmd${hostile}`]: "ctrl+z" } }],
  ["a context", { contexts: { [`place${hostile}`]: {} } }],
  ["a <name> in a key", { bindings: { "model.list": `<${hostile}>q` } }],
  ["a key that cannot be read", { bindings: { "model.list": `ctrl+${hostile}ctrl+` } }],
  ["keys that two commands share", { bindings: { "session.list": `ctrl+${hostile}`, "session.fork": `ctrl+${hostile}` } }],
  ["a leader", { leader: `ctrl+${hostile} ctrl+k` }],
])("writes out what acts on a terminal in %s", (_name, file) => {
  const result = KeybindingsFile.decode(JSON.stringify(file))

  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.message).not.toMatch(/\p{C}/u)
  // The control: the text is in the note, written out and not dropped.
  for (const escape of written) expect(result.diagnostics[0]?.message).toContain(escape)
})

test("locates the file beside cli.json", () => {
  const configFile = path.join(os.tmpdir(), "orbit-config", "cli.json")

  expect(KeybindingsFile.locate(configFile)).toBe(path.join(os.tmpdir(), "orbit-config", "keybindings.json"))
})

test("loads a file, and a missing file says nothing", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "keybindings.json")

  expect(await KeybindingsFile.load(file)).toEqual(KeybindingsFile.empty)

  await writeFile(file, '{ "bindings": { "session.new": "ctrl+n" } }')
  expect(await KeybindingsFile.load(file)).toMatchObject({ bindings: { "session.new": "ctrl+n" }, diagnostics: [] })
})

test("a file that is nested too deeply to check costs only itself, and loading it does not reject", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "keybindings.json")
  // The parser reads nesting by recursion, and this overflows its stack.
  await writeFile(file, "[".repeat(100_000) + "]".repeat(100_000))

  const result = await KeybindingsFile.load(file)

  expect(result.bindings).toEqual({})
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.message).toContain("could not be checked")
  expect(result.diagnostics[0]?.message).toContain("Orbit is ignoring all of it")
})

test("reads a file that starts with a byte order mark, as some Windows editors save it", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "keybindings.json")
  await writeFile(file, "﻿" + '{ "bindings": { "session.new": "ctrl+n" } }')

  expect(await KeybindingsFile.load(file)).toMatchObject({ bindings: { "session.new": "ctrl+n" }, diagnostics: [] })
})

test("reports a file that cannot be read and does not reject", async () => {
  await using directory = await tmpdir()
  // A folder where the file should be cannot be read as text.
  await mkdir(path.join(directory.path, "keybindings.json"))

  const result = await KeybindingsFile.load(path.join(directory.path, "keybindings.json"))

  expect(result.bindings).toEqual({})
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.message).toContain("could not be read")
})

test("writes a template that applies nothing and lists every context with its commands", () => {
  const template = KeybindingsFile.template()

  expect(KeybindingsFile.decode(template)).toEqual(KeybindingsFile.empty)
  TuiKeybind.Contexts.forEach((context) => expect(template).toContain(`"${context}": {`))
  // Every command that a context lists is a real command, and the template lists it.
  const listed = new Set(
    [...template.matchAll(/^\s+\/\/ "([^"]+)": /gm)].map((match) => match[1] ?? "").filter((name) => name !== "leader"),
  )
  listed.forEach((command) => expect(TuiKeybind.isCommand(command)).toBe(true))
  const commands = [
    "session.rename",
    "session.pin.toggle",
    "diff.next_file",
    "composer.shell.kill",
    "permission.prompt.fullscreen",
    "dialog.select.next",
    "prompt.history.previous",
    "session.page.up",
    "command.palette.show",
    "keybindings.open",
    "prompt.clear",
  ]
  commands.forEach((command) => expect(listed.has(command)).toBe(true))
})

test("writes a template whose examples are all valid once they are uncommented", () => {
  // Lines whose example key is the empty placeholder for an unbound command are left as comments.
  const blocks = TuiKeybind.Contexts.map((context) => {
    const block = KeybindingsFile.template().split(`"${context}": {\n`)[1]?.split("\n    }")[0] ?? ""
    const entries = block
      .split("\n")
      .filter((line) => /^\s+\/\/ "/.test(line) && !line.includes(': "",'))
      .map((line) => line.replace("// ", "").replace(/, \/\/.*$/, ""))
    return `"${context}": {${entries.join(",")}}`
  })

  const result = KeybindingsFile.decode(`{ "contexts": { ${blocks.join(",")} } }`)

  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([])
  expect(Object.keys(result.contexts)).toEqual(TuiKeybind.Contexts.filter((context) => context !== "which-key"))
})

test("creates the template where nothing is, and leaves what is there alone", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "config", "keybindings.json")

  expect(await KeybindingsFile.create(file)).toBe(true)
  expect(await readFile(file, "utf8")).toBe(KeybindingsFile.template())

  // A file the person has edited, even one that does not parse, is never replaced.
  await writeFile(file, "{ broken")
  expect(await KeybindingsFile.create(file)).toBe(false)
  expect(await readFile(file, "utf8")).toBe("{ broken")
})

test("does not touch a folder that is in the way", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "keybindings.json")
  await mkdir(file)
  await writeFile(path.join(file, "kept.txt"), "kept")

  expect(await KeybindingsFile.create(file)).toBe(false)
  expect(await readFile(path.join(file, "kept.txt"), "utf8")).toBe("kept")
})

// A Windows account can make a link to a file only with a privilege or in developer mode, so this reports a skip on one
// that cannot. The test above covers every platform.
const linked = canLinkFile ? test : test.skip

linked("does not write through a link that is in the way", async () => {
  await using directory = await tmpdir()
  const target = path.join(directory.path, "elsewhere.json")
  const file = path.join(directory.path, "keybindings.json")
  // The link points at nothing, so the file it names is the one that a plain write would create.
  await symlink(target, file)

  expect(await KeybindingsFile.create(file)).toBe(false)
  expect(await Bun.file(target).exists()).toBe(false)
})
