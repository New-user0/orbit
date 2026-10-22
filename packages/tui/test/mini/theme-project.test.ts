import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { resolveRunTheme } from "../../src/mini/theme"
import { DEFAULT_THEMES } from "../../src/theme"
import { tmpdir } from "../fixture/fixture"

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
