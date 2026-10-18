import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { CompatEditors } from "@orbit/compat/editors"
import { binding, detect, install, keybindingsFile, newlineSequence, snippet } from "../../src/util/terminal-setup"

async function folder() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orbit-terminal-setup-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

const existing = `// my keys
[
    // open the palette
    { "key": "ctrl+k", "command": "workbench.action.showCommands" },
    { "key": "ctrl+j", "command": "workbench.action.togglePanel", }, // trailing comma
]
`

test("installs the binding after the existing ones, keeps comments, and backs up the old bytes", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  await writeFile(file, existing)
  const result = await install({ file })
  expect(result.type).toBe("installed")
  const text = await readFile(file, "utf8")
  expect(text).toContain("// my keys")
  expect(text).toContain("// open the palette")
  expect(text).toContain("// trailing comma")
  const list = parse(text) as any[]
  expect(list).toHaveLength(3)
  expect(list.at(-1)).toEqual({
    key: "shift+enter",
    command: "workbench.action.terminal.sendSequence",
    args: { text: "\u001b\r" },
    when: "terminalFocus",
  })
  expect(list.at(-1).args.text).toBe(newlineSequence)
  const backups = (await readdir(tmp.dir)).filter((name) => /^keybindings\.json\.[0-9a-f]{8}\.bak$/.test(name))
  expect(backups).toHaveLength(1)
  expect(await readFile(path.join(tmp.dir, backups[0]!), "utf8")).toBe(existing)
})

test("a byte-order mark does not stop the install", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  await writeFile(file, `\uFEFF[{ "key": "ctrl+k", "command": "x" }]`)
  expect((await install({ file })).type).toBe("installed")
  expect(parse(await readFile(file, "utf8"))).toHaveLength(2)
})

test("a missing file and a missing user folder are created with the one binding and no backup", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "Code", "User", "keybindings.json")
  expect(await install({ file })).toEqual({ type: "installed", file })
  expect(parse(await readFile(file, "utf8"))).toEqual([binding])
  expect(await readdir(path.dirname(file))).toEqual(["keybindings.json"])
})

test.each([
  ["an unclosed bracket", '[{ "key": "ctrl+k", "command": "x" '],
  ["an object", "{}"],
  ["text", "not json"],
])("%s is left untouched with no backup and says it cannot be read", async (_name, content) => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  await writeFile(file, content)
  expect(await install({ file })).toEqual({ type: "unparsable", file })
  expect(await readFile(file, "utf8")).toBe(content)
  expect(await readdir(tmp.dir)).toEqual(["keybindings.json"])
})

test("the binding that is already there is reported and nothing changes", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  const content = JSON.stringify([binding])
  await writeFile(file, content)
  expect(await install({ file })).toEqual({ type: "present", file })
  expect(await readFile(file, "utf8")).toBe(content)
  expect(await readdir(tmp.dir)).toEqual(["keybindings.json"])
})

test("a different binding on shift+enter in the terminal is a conflict and nothing changes", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  const content = `[{ "key": "shift+enter", "command": "other", "when": "terminalFocus" }]`
  await writeFile(file, content)
  expect(await install({ file })).toEqual({ type: "conflict", file })
  expect(await readFile(file, "utf8")).toBe(content)
  expect(await readdir(tmp.dir)).toEqual(["keybindings.json"])
})

test("a backup that cannot be made writes nothing", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  await writeFile(file, existing)
  await mkdir(`${file}.00000000.bak`)
  const result = await install({ file, suffix: () => "00000000" })
  expect(result.type).toBe("failed")
  expect(await readFile(file, "utf8")).toBe(existing)
})

test("an earlier backup is never overwritten", async () => {
  await using tmp = await folder()
  const file = path.join(tmp.dir, "keybindings.json")
  await writeFile(file, existing)
  await writeFile(`${file}.aaaaaaaa.bak`, "older")
  const names = ["aaaaaaaa", "bbbbbbbb"]
  const result = await install({ file, suffix: () => names.shift()! })
  expect(result).toEqual({ type: "installed", file, backup: `${file}.bbbbbbbb.bak` })
  expect(await readFile(`${file}.aaaaaaaa.bak`, "utf8")).toBe("older")
})

test.each([...CompatEditors.ids])("a remote %s is recognised from the git helper and from PATH", (id) => {
  const server = CompatEditors.remoteFolder(id)
  const base = { TERM_PROGRAM: "vscode" }
  expect(detect({ ...base, VSCODE_GIT_ASKPASS_MAIN: `/home/me/${server}/bin/askpass.sh` }, null).remote).toBe(true)
  expect(detect({ ...base, PATH: `/usr/bin:/home/me/${server}/bin` }, null).remote).toBe(true)
  expect(detect(base, null).remote).toBe(false)
})

test("a renderer that reports the enhanced keyboard wins over the terminal's name", () => {
  expect(detect({ TERM_PROGRAM: "vscode" }, { kitty_keyboard: true }).distinct).toBe(true)
  expect(detect({ TERM_PROGRAM: "vscode" }, { kitty_keyboard: false }).distinct).toBe(false)
  expect(detect({ TERM_PROGRAM: "ghostty" }, null).distinct).toBe(true)
  expect(detect({ TERM_PROGRAM: "vscode" }, null).distinct).toBe(false)
})

test.each([
  [{ TERM: "xterm-kitty" }, "kitty"],
  [{ TERM_PROGRAM: "Apple_Terminal" }, "apple-terminal"],
  [{ TMUX: "/tmp/tmux" }, "tmux"],
  [{ WT_SESSION: "1" }, "windows-terminal"],
  [{ TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux" }, "editor"],
  [{ TERM_PROGRAM: "vscode" }, "editor"],
  [{}, "other"],
] as const)("%o is %s", (env, terminal) => {
  expect(detect(env, null).terminal).toBe(terminal)
})

test("an editor's terminal says which editor it is", () => {
  expect(detect({ TERM_PROGRAM: "vscode" }, null).editor).toBe("vscode")
  expect(detect({ TMUX: "/tmp/tmux" }, null).editor).toBeUndefined()
})

test("each editor keeps its keybindings where the platform puts them", () => {
  const home = { win32: "C:\\Users\\me", darwin: "/Users/me", linux: "/home/me" }
  for (const editor of CompatEditors.ids) {
    const folder = CompatEditors.userFolder(editor)
    const where = (platform: keyof typeof home, env = {}) =>
      keybindingsFile({ editor, platform, home: home[platform], env })
    expect(where("win32", { APPDATA: "D:\\Roam" })).toBe(`D:\\Roam\\${folder}\\User\\keybindings.json`)
    expect(where("win32")).toBe(`C:\\Users\\me\\AppData\\Roaming\\${folder}\\User\\keybindings.json`)
    expect(where("darwin")).toBe(`/Users/me/Library/Application Support/${folder}/User/keybindings.json`)
    expect(where("linux")).toBe(`/home/me/.config/${folder}/User/keybindings.json`)
    expect(where("linux", { XDG_CONFIG_HOME: "/xdg" })).toBe(`/xdg/${folder}/User/keybindings.json`)
  }
})

test("every terminal this command only shows has a snippet, and an unknown one has none", () => {
  for (const terminal of ["windows-terminal", "alacritty", "zed", "apple-terminal", "tmux", "editor"] as const)
    expect(snippet(terminal)?.text.length).toBeGreaterThan(0)
  expect(snippet("other")).toBeUndefined()
})
