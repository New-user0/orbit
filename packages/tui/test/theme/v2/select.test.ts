import { expect, test } from "bun:test"
import { selectTheme, selectThemeMode, supportsThemeMode, themeModes } from "@orbit/theme/tui"
import { getOrbitTheme } from "../../../src/theme"

test("selects complete light and dark themes independently", () => {
  const light = selectTheme(getOrbitTheme(), "light")
  const dark = selectTheme(getOrbitTheme(), "dark")
  expect(selectTheme(getOrbitTheme())).toEqual(light)
  expect(light.hue).toEqual(getOrbitTheme().light.hue)
  expect(dark.text).toEqual(getOrbitTheme().base.text)
  expect(dark.hue).toEqual(getOrbitTheme().dark.hue)
  expect(selectThemeMode(getOrbitTheme(), "dark")).toEqual({ theme: dark, mode: "dark" })
})

test("selects the available mode when the requested mode is missing", () => {
  const lightOnly = { base: getOrbitTheme().base, light: getOrbitTheme().light } as const
  const darkOnly = { base: getOrbitTheme().base, dark: getOrbitTheme().dark } as const

  expect(themeModes(lightOnly)).toEqual(["light"])
  expect(themeModes(darkOnly)).toEqual(["dark"])
  expect(supportsThemeMode(lightOnly, "light")).toBeTrue()
  expect(supportsThemeMode(lightOnly, "dark")).toBeFalse()
  expect(selectThemeMode(lightOnly, "dark")).toEqual({ theme: selectTheme(getOrbitTheme(), "light"), mode: "light" })
  expect(selectThemeMode(darkOnly, "light")).toEqual({ theme: selectTheme(getOrbitTheme(), "dark"), mode: "dark" })
})
