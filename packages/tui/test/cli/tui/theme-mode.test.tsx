/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { getOrbitTheme } from "../../../src/theme"
import orbitSource from "../../../src/theme/assets/orbit.json" with { type: "json" }
import type { ThemeV1Json } from "@orbit/theme/tui/v1"
import { ConfigProvider } from "../../../src/config"
import { ThemeContextProvider, ThemeProvider, type ThemeError, useTheme, useThemes } from "../../../src/context/theme"

async function wait(fn: () => boolean) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for theme mode")
    await Bun.sleep(10)
  }
}

test("uses an available mode while retaining the pinned preference", async () => {
  const orbitV1 = orbitSource as ThemeV1Json
  const lightOnly = structuredClone(orbitV1)
  lightOnly.theme.background = "#eeeeee"
  lightOnly.theme.text = "#111111"
  const dual = structuredClone(orbitV1)
  dual.theme.background = { light: "#eeeeee", dark: "#111111" }
  dual.theme.text = { light: "#111111", dark: "#eeeeee" }
  const darkOnly = structuredClone(orbitV1)
  darkOnly.theme.background = "#111111"
  darkOnly.theme.text = "#eeeeee"
  const native = {
    base: { ...getOrbitTheme().base, text: { ...getOrbitTheme().base.text, base: "#abcdef" } },
    dark: { hue: getOrbitTheme().dark.hue },
  } as const
  let themes: ReturnType<typeof useThemes> | undefined

  function Probe() {
    const value = useThemes()
    themes = value
    return <text>{value.mode()}</text>
  }

  function current() {
    if (!themes) throw new Error("Theme provider is not mounted")
    return themes
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "light-only", mode: "dark" } })}>
        <ThemeProvider
          mode="dark"
          source={{ discover: () => Promise.resolve({ "light-only": lightOnly, "dark-only": darkOnly, dual, native }) }}
        >
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => themes?.ready === true)
    expect(current().mode()).toBe("light")
    expect(current().modes()).toEqual(["light"])
    expect(current().supports("dark")).toBeFalse()
    expect(current().setMode("dark")).toBeFalse()
    expect(current().set("dark-only")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().modes()).toEqual(["dark"])
    expect(current().set("light-only")).toBeTrue()
    await wait(() => current().mode() === "light")
    expect(current().set("dual")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().modes()).toEqual(["light", "dark"])
    expect(current().set("native")).toBeTrue()
    await wait(() => current().selected === "native")
    expect(current().modes()).toEqual(["dark"])
    expect(current().current.text.base.equals(RGBA.fromHex("#abcdef"))).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  ["schema", { base: {}, light: {} }],
  ["partial mode", { base: { text: { base: "#ffffff" } }, light: {} }],
  [
    "token reference",
    {
      base: { ...getOrbitTheme().base, text: { ...getOrbitTheme().base.text, base: "$missing" } },
      light: getOrbitTheme().light,
    },
  ],
] as const)("falls back to Orbit when configured V2 theme %s is invalid", async (_label, source) => {
  let themes: ReturnType<typeof useThemes> | undefined
  let failure: ThemeError | undefined
  let unsubscribe: (() => void) | undefined
  const discovery = Promise.withResolvers<Record<string, unknown>>()

  function Probe() {
    const value = useThemes()
    themes = value
    unsubscribe = value.onError((error) => (failure = error))
    return <text>{value.selected}</text>
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "invalid" } })}>
        <ThemeProvider mode="dark" source={{ discover: () => discovery.promise }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()
  discovery.resolve({ invalid: source })

  try {
    await wait(() => themes?.ready === true)
    expect(themes?.selected).toBe("orbit")
    expect(failure?.name).toBe("invalid")
    expect(failure?.error).toBeInstanceOf(Error)
    expect(failure?.error.message.length).toBeGreaterThan(0)
  } finally {
    unsubscribe?.()
    app.renderer.destroy()
  }
})

test("dialog surfaces are absolute and can be inherited through the theme context", async () => {
  let themes: ReturnType<typeof useThemes> | undefined
  let theme: ReturnType<typeof useTheme> | undefined
  let contextual: ReturnType<typeof useTheme> | undefined

  function ContextProbe() {
    contextual = useTheme()
    return <text>{contextual.text.base.toString()}</text>
  }

  function Probe() {
    themes = useThemes()
    theme = useTheme()
    return (
      <ThemeContextProvider context="dialog">
        <ContextProbe />
      </ThemeContextProvider>
    )
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "orbit", mode: "dark" } })}>
        <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => themes?.ready === true)
    if (!themes || !theme || !contextual) throw new Error("Theme provider is not mounted")
    const dialog = theme.surface("dialog")
    expect(theme.surface("dialog")).toBe(dialog)
    expect(dialog.surface("dialog")).toBe(dialog)
    expect(dialog.background.base).toBe(themes.currentTokens().background.raised.base)
    expect(contextual.background.base).toBe(dialog.background.base)
    expect(contextual.text.base).toBe(dialog.text.base)
    expect(dialog.decrease(dialog.background.raised.base)).toBe(themes.currentTokens().hue.neutral[600])
  } finally {
    app.renderer.destroy()
  }
})

// A discovery is asked for again whenever what the source would find changes, such as when the start folder is trusted
// and then revoked. One that began first and finishes last found what is no longer there, so its themes are dropped and
// only the newest discovery's themes are kept (class 1: a revoked folder's theme does not come back).
test("a theme discovery that a newer one overtook does not bring back the themes it found", async () => {
  const replies: ((themes: Record<string, unknown>) => void)[] = []
  let rediscover: (() => void) | undefined
  let themes: ReturnType<typeof useThemes> | undefined
  function Probe() {
    themes = useThemes()
    return <text>probe</text>
  }
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider
          mode="dark"
          source={{
            discover: () => new Promise((resolve) => replies.push(resolve)),
            subscribeDiscover: (discover) => {
              rediscover = discover
              return () => {}
            },
          }}
        >
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => replies.length === 1)
    replies[0]!({})
    await wait(() => themes?.ready === true)
    // The folder is trusted (its discovery is slow), then revoked (its discovery is quick and finds nothing).
    rediscover!()
    rediscover!()
    expect(replies).toHaveLength(3)
    replies[2]!({})
    replies[1]!({ "overtaken-project-theme": getOrbitTheme() })
    await Bun.sleep(20)
    expect(themes!.has("overtaken-project-theme")).toBeFalse()
    // The control: the newest discovery's themes are kept.
    rediscover!()
    replies[3]!({ "overtaken-project-theme": getOrbitTheme() })
    await wait(() => themes!.has("overtaken-project-theme"))
  } finally {
    app.renderer.destroy()
  }
})
