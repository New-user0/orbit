import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRuntimeLifecycle } from "../../src/mini/runtime.lifecycle"
import { resolveRunTheme } from "../../src/mini/theme"
import type { MiniHost } from "../../src/mini/types"
import { DEFAULT_THEMES } from "../../src/theme"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// trust-first part 2, D7 (owner, 2026-10-21: "match refrence"): Mini starts only in a trusted folder (part 1), and then
// reads themes from the project's own folders, as it reads plugins, and never from a folder above the project. A theme
// above the project that names itself as the theme the person chose is not used: Mini falls back to the default theme.
const tmp = await tmpdir()
const previousConfig = process.env.ORBIT_CONFIG_DIR
const before = process.cwd()
beforeAll(() => {
  process.env.ORBIT_CONFIG_DIR = path.join(tmp.path, "config")
})
afterAll(async () => {
  process.chdir(before)
  if (previousConfig === undefined) delete process.env.ORBIT_CONFIG_DIR
  else process.env.ORBIT_CONFIG_DIR = previousConfig
  await tmp[Symbol.asyncDispose]()
})

const palette = ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] as const
const colors: TerminalColors = {
  palette: Array.from({ length: 256 }, (_, index) => palette[index % palette.length]!),
  defaultBackground: "#1a1b26",
  defaultForeground: "#c0caf5",
  cursorColor: "#ff9e64",
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: "#33467c",
  highlightForeground: "#c0caf5",
}
const renderer = {
  get themeMode() {
    return "dark" as const
  },
  waitForThemeMode: async () => "dark" as const,
  getPalette: async () => colors,
} as unknown as CliRenderer

const miniHost: MiniHost = {
  version: "test",
  terminal: { stdin: process.stdin },
  platform: "linux",
  stdout: { write: () => {} },
  stderr: { write: () => {} },
  files: { readText: async () => "" },
  editor: { open: async () => undefined },
  paths: { home: "/home" },
  signals: { sigint: { subscribe: () => () => {} }, sigusr2: { subscribe: () => () => {} } },
  startup: { showTiming: false, now: () => 0 },
  diagnostics: {},
  preferences: { resolveVariant: async () => undefined, saveVariant: async () => {} },
}

const text = async (name: string) => {
  const theme = await resolveRunTheme(renderer, { name, mode: "dark" })
  expect(theme.footer.text).toBeInstanceOf(RGBA)
  return (theme.footer.text as RGBA).toInts()
}

test("Mini uses the project's own theme, and none from a folder above the project", async () => {
  const above = path.join(tmp.path, "work")
  const repo = path.join(above, "repo")
  const app = path.join(repo, "packages", "app")
  await mkdir(path.join(repo, ".git"), { recursive: true })
  await mkdir(app, { recursive: true })
  // Both are the tokyonight theme under a name of their own, so the colors tell which file was read.
  await Bun.write(path.join(above, ".orbit", "themes", "clone-above-theme.json"), JSON.stringify(DEFAULT_THEMES.tokyonight))
  await Bun.write(path.join(repo, ".orbit", "themes", "clone-own-theme.json"), JSON.stringify(DEFAULT_THEMES.tokyonight))
  process.chdir(app)

  const fallback = await text("orbit")
  const tokyonight = await text("tokyonight")
  expect(tokyonight).not.toEqual(fallback)
  // The control: the theme of the project's own root is read.
  expect(await text("clone-own-theme")).toEqual(tokyonight)
  // The folder above the project supplies nothing: the chosen name is unknown, and Mini falls back to the default.
  expect(await text("clone-above-theme")).toEqual(fallback)
})

// Class 3: Mini's own walk takes any `.git` entry as a project's root, a file that names no repository included, while the
// server rejects that file and decides trust for the start folder (core `project-git-trust.test.ts`, "stops at a .git file
// that is no good"). Mini passes on the folder the server decided for (`trustRefusal`), so the walk never reads the themes
// of the folder that holds the file. Without it, the walk reaches that folder: the control.
test("Mini reads no theme above the folder the server decided trust for, though its own walk takes a .git file there", async () => {
  const outer = path.join(tmp.path, "rejected")
  const app = path.join(outer, "app")
  await mkdir(app, { recursive: true })
  await Bun.write(path.join(outer, ".git"), "garbage\n")
  await Bun.write(path.join(outer, ".orbit", "themes", "clone-outer-theme.json"), JSON.stringify(DEFAULT_THEMES.tokyonight))
  process.chdir(app)

  const shown = async (root: string | undefined) => {
    const theme = await resolveRunTheme(renderer, { name: "clone-outer-theme", mode: "dark" }, false, root)
    return (theme.footer.text as RGBA).toInts()
  }
  expect(await shown(await realpath(app))).toEqual(await text("orbit"))
  expect(await shown(undefined)).toEqual(await text("tokyonight"))
})

// The same answer reaches every place the Mini resolves its theme: the first draw (the lifecycle) and a later refresh (the
// footer). The background each one paints tells which theme was read.
test("the Mini's first draw and a theme refresh both keep to the folder the server decided trust for", async () => {
  const outer = path.join(tmp.path, "rejected-lifecycle")
  const app = path.join(outer, "app")
  await mkdir(app, { recursive: true })
  await Bun.write(path.join(outer, ".git"), "garbage\n")
  await Bun.write(path.join(outer, ".orbit", "themes", "clone-outer-theme.json"), JSON.stringify(DEFAULT_THEMES.tokyonight))
  process.chdir(app)

  const painted = async (root: string | undefined) => {
    const test = await createTestRenderer({
      width: 80,
      height: 20,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
    })
    const backgrounds: string[] = []
    const paint = test.renderer.setBackgroundColor.bind(test.renderer)
    test.renderer.setBackgroundColor = (color) => {
      backgrounds.push(color.toString())
      paint(color)
    }
    const lifecycle = await createRuntimeLifecycle({
      host: miniHost,
      createRenderer: async () => test.renderer as CliRenderer,
      getDirectory: () => app,
      findFiles: async () => [],
      agents: [],
      references: [],
      sessionID: "ses_1",
      first: true,
      history: [],
      agent: undefined,
      model: undefined,
      variant: undefined,
      tuiConfig: createTuiResolvedConfig({ theme: { name: "clone-outer-theme" } }),
      root,
      onPermissionReply: () => {},
      onFormReply: () => {},
      onFormCancel: () => {},
    })
    // The refresh resolves the theme again in the footer, and paints once it has.
    lifecycle.refreshTheme()
    const deadline = Date.now() + 5_000
    while (backgrounds.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    lifecycle.footer.destroy()
    test.renderer.destroy()
    return backgrounds
  }
  const bounded = await painted(await realpath(app))
  const unbounded = await painted(undefined)
  // One background for the first draw and one for the refresh.
  expect(bounded).toHaveLength(2)
  expect(bounded[1]).toBe(bounded[0]!)
  // The control: without the server's answer both read the theme of the folder that holds the `.git` file.
  expect(unbounded).toHaveLength(2)
  expect(unbounded[1]).toBe(unbounded[0]!)
  expect(bounded[0]).not.toBe(unbounded[0]!)
})
