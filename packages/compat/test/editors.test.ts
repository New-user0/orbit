import { expect, test } from "bun:test"
import { CompatEditors } from "../src/editors.js"

test.each([
  [{ TERM_PROGRAM: "vscode" }, "vscode"],
  [{ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" }, "cursor"],
  [{ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_MAIN: "/apps/Cursor/askpass.sh" }, "cursor"],
  [{ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_MAIN: "/apps/Windsurf/askpass.sh" }, "windsurf"],
  [{ VSCODE_GIT_ASKPASS_MAIN: "/apps/windsurf/askpass.sh" }, "windsurf"],
  [{ TERM_PROGRAM: "ghostty" }, undefined],
  [{}, undefined],
] as const)("%o is the terminal of %s", (env, id) => {
  expect(CompatEditors.terminal(env)).toBe(id)
})

test("each editor has a name, a folder and a server folder of its own", () => {
  expect(CompatEditors.ids.map(CompatEditors.name)).toEqual(["VS Code", "Cursor", "Windsurf"])
  expect(CompatEditors.ids.map(CompatEditors.userFolder)).toEqual(["Code", "Cursor", "Windsurf"])
  expect(CompatEditors.ids.map(CompatEditors.remoteFolder)).toEqual([".vscode-server", ".cursor-server", ".windsurf-server"])
})

test.each([...CompatEditors.ids])("a server folder of %s in the git helper or in PATH makes the session remote", (id) => {
  const folder = CompatEditors.remoteFolder(id)
  expect(CompatEditors.remote({ VSCODE_GIT_ASKPASS_MAIN: `/home/me/${folder}/bin/askpass.sh` })).toBe(true)
  expect(CompatEditors.remote({ PATH: `/usr/bin:/home/me/${folder}/bin` })).toBe(true)
  expect(CompatEditors.remote({ PATH: "/usr/bin", VSCODE_GIT_ASKPASS_MAIN: "/usr/lib/askpass" })).toBe(false)
})

test("the program of each editor family, and none for another editor", () => {
  expect(CompatEditors.program("Visual Studio Code")).toBe("code")
  expect(CompatEditors.program("VSCode")).toBe("code")
  expect(CompatEditors.program("Cursor")).toBe("cursor")
  expect(CompatEditors.program("Windsurf")).toBe("windsurf")
  expect(CompatEditors.program("VSCodium")).toBe("codium")
  expect(CompatEditors.program("Zed")).toBeUndefined()
  expect(CompatEditors.program("IntelliJ IDEA")).toBeUndefined()
})

test("a person own GIT_ASKPASS is not a sign of an editor or of a remote session", () => {
  expect(CompatEditors.terminal({ GIT_ASKPASS: "/apps/Cursor/askpass.sh" })).toBeUndefined()
  expect(CompatEditors.terminal({ TERM_PROGRAM: "vscode", GIT_ASKPASS: "/apps/Windsurf/askpass.sh" })).toBe("vscode")
  expect(CompatEditors.remote({ GIT_ASKPASS: "/home/me/.vscode-server/bin/askpass.sh" })).toBe(false)
})
