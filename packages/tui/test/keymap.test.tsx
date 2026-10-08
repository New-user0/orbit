/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider, resolve, useConfig } from "../src/config"
import { KeybindingsFile } from "../src/config/keybindings-file"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          "session.page.up": "pgup",
          "session.page.down": "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("returns every formatted command shortcut", async () => {
  let read = () => [] as readonly string[]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [{ id: "demo.command", bind: "x,y", run() {} }],
    }))
    read = () => shortcuts.list("demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})

const keybindings = (file: object) =>
  createTuiResolvedConfig({}, { keybindings: KeybindingsFile.decode(JSON.stringify(file)) })
const nothingPending = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a session-list override of session.rename applies only in the session-list layer", async () => {
  const calls: string[] = []
  const [listOpen, setListOpen] = createSignal(false)

  function Harness() {
    // The same command in two places, as the session list and a session both have session.rename.
    Keymap.createLayer(() => ({
      context: "session-list",
      enabled: () => listOpen(),
      commands: [{ id: "session.rename", run: () => void calls.push("list") }],
    }))
    Keymap.createLayer(() => ({
      context: "session",
      enabled: () => !listOpen(),
      commands: [{ id: "session.rename", run: () => void calls.push("session") }],
    }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider config={keybindings({ contexts: { "session-list": { "session.rename": "ctrl+alt+r" } } })}>
      <Harness />
    </Keymap.Provider>
  ))
  try {
    // A session keeps the stock key, and the key given to the list does nothing there.
    app.mockInput.pressKey("r", { ctrl: true, meta: true })
    app.mockInput.pressKey("r", { ctrl: true })
    expect(calls).toEqual(["session"])

    // The list takes the key it was given and has given up the stock one.
    setListOpen(true)
    app.mockInput.pressKey("r", { ctrl: true })
    expect(calls).toEqual(["session"])
    app.mockInput.pressKey("r", { ctrl: true, meta: true })
    expect(calls).toEqual(["session", "list"])
  } finally {
    app.renderer.destroy()
  }
})

test("null in a context unbinds the command there and nowhere else", async () => {
  const calls: string[] = []
  const [listOpen, setListOpen] = createSignal(true)

  function Harness() {
    Keymap.createLayer(() => ({
      context: "session-list",
      enabled: () => listOpen(),
      commands: [{ id: "session.rename", run: () => void calls.push("list") }],
    }))
    Keymap.createLayer(() => ({
      context: "session",
      enabled: () => !listOpen(),
      commands: [{ id: "session.rename", run: () => void calls.push("session") }],
    }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider config={keybindings({ contexts: { "session-list": { "session.rename": null } } })}>
      <Harness />
    </Keymap.Provider>
  ))
  try {
    app.mockInput.pressKey("r", { ctrl: true })
    expect(calls).toEqual([])
    setListOpen(false)
    app.mockInput.pressKey("r", { ctrl: true })
    expect(calls).toEqual(["session"])
  } finally {
    app.renderer.destroy()
  }
})

test("a layer with no context, or one that Orbit does not know, gets only what applies everywhere", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({ commands: [{ id: "session.new", run: () => void calls.push("untagged") }] }))
    Keymap.createLayer(() => ({
      context: "made-up",
      commands: [{ id: "session.rename", run: () => void calls.push("made-up") }],
    }))
    Keymap.createLayer(() => ({
      context: "session",
      commands: [{ id: "session.fork", run: () => void calls.push("session") }],
    }))
    Keymap.createLayer(() => ({ commands: [{ id: "session.list", run: () => void calls.push("everywhere") }] }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider
      config={keybindings({
        bindings: { "session.list": "ctrl+alt+l" },
        contexts: {
          session: { "session.new": "ctrl+alt+n", "session.rename": "ctrl+alt+r", "session.fork": "ctrl+alt+f" },
        },
      })}
    >
      <Harness />
    </Keymap.Provider>
  ))
  try {
    // The session context's keys reach the layer of that context alone.
    app.mockInput.pressKey("n", { ctrl: true, meta: true })
    app.mockInput.pressKey("r", { ctrl: true, meta: true })
    expect(calls).toEqual([])
    app.mockInput.pressKey("f", { ctrl: true, meta: true })
    expect(calls).toEqual(["session"])
    // What was set for a command everywhere reaches every layer.
    app.mockInput.pressKey("l", { ctrl: true, meta: true })
    expect(calls).toEqual(["session", "everywhere"])
    // The stock keys of the layers without a context still work.
    app.mockInput.pressKey("r", { ctrl: true })
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["session", "everywhere", "made-up", "untagged"])
  } finally {
    app.renderer.destroy()
  }
})

test("a ctrl+k ctrl+s chord dispatches its command once both strokes are pressed", async () => {
  const calls: string[] = []
  let pending = () => 0

  function Harness() {
    const sequence = Keymap.usePendingSequence()
    pending = () => sequence().length
    Keymap.createLayer(() => ({ commands: [{ id: "session.new", run: () => void calls.push("new") }] }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider config={keybindings({ bindings: { "session.new": "ctrl+k ctrl+s" } })}>
      <Harness />
    </Keymap.Provider>
  ))
  try {
    app.mockInput.pressKey("k", { ctrl: true })
    await nothingPending()
    expect(calls).toEqual([])
    expect(pending()).toBe(1)

    app.mockInput.pressKey("s", { ctrl: true })
    await nothingPending()
    expect(calls).toEqual(["new"])
    expect(pending()).toBe(0)

    // The second stroke alone is nothing.
    app.mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["new"])
  } finally {
    app.renderer.destroy()
  }
})

test("Escape clears a chord that is waiting for its second stroke", async () => {
  const calls: string[] = []
  let pending = () => 0

  function Harness() {
    const sequence = Keymap.usePendingSequence()
    pending = () => sequence().length
    Keymap.createLayer(() => ({ commands: [{ id: "session.new", run: () => void calls.push("new") }] }))
    return <box />
  }

  const app = await testRender(
    () => (
      <Keymap.Provider config={keybindings({ bindings: { "session.new": "ctrl+k ctrl+s" } })}>
        <Harness />
      </Keymap.Provider>
    ),
    { kittyKeyboard: true },
  )
  try {
    app.mockInput.pressKey("k", { ctrl: true })
    await nothingPending()
    expect(pending()).toBe(1)

    app.mockInput.pressEscape()
    await nothingPending()
    expect(pending()).toBe(0)

    app.mockInput.pressKey("s", { ctrl: true })
    await nothingPending()
    expect(calls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("<leader> sequences work beside chords", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [
        // The stock key of session.new is <leader>n, and session.list is moved to a chord.
        { id: "session.new", run: () => void calls.push("new") },
        { id: "session.list", run: () => void calls.push("list") },
      ],
    }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider config={keybindings({ bindings: { "session.list": "ctrl+k ctrl+s" } })}>
      <Harness />
    </Keymap.Provider>
  ))
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["new"])

    app.mockInput.pressKey("k", { ctrl: true })
    app.mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["new", "list"])
  } finally {
    app.renderer.destroy()
  }
})

test("chords combine with comma lists, spelled-out keys and the leader key", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.new", run: () => void calls.push("new") },
        { id: "session.list", run: () => void calls.push("list") },
        { id: "model.list", run: () => void calls.push("model") },
      ],
    }))
    return <box />
  }

  const app = await testRender(() => (
    <Keymap.Provider
      config={keybindings({
        bindings: {
          "session.new": "ctrl+k ctrl+s,ctrl+g ctrl+y,<leader>n",
          "session.list": "ctrl+k enter",
          "model.list": "ctrl+x ctrl+c",
        },
      })}
    >
      <Harness />
    </Keymap.Provider>
  ))
  try {
    app.mockInput.pressKey("k", { ctrl: true })
    app.mockInput.pressKey("s", { ctrl: true })
    app.mockInput.pressKey("g", { ctrl: true })
    app.mockInput.pressKey("y", { ctrl: true })
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["new", "new", "new"])

    app.mockInput.pressKey("k", { ctrl: true })
    app.mockInput.pressEnter()
    expect(calls.at(-1)).toBe("list")

    // ctrl+x starts both the leader sequences and the chord, and the second stroke tells them apart.
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("c", { ctrl: true })
    expect(calls.at(-1)).toBe("model")
  } finally {
    app.renderer.destroy()
  }
})

test("the second stroke of a chord matches on the key's position when the layout is not Latin", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({ commands: [{ id: "session.new", run: () => void calls.push("new") }] }))
    return <box />
  }

  const app = await testRender(
    () => (
      <Keymap.Provider config={keybindings({ bindings: { "session.new": "ctrl+k ctrl+s" } })}>
        <Harness />
      </Keymap.Provider>
    ),
    { kittyKeyboard: true },
  )
  try {
    // A Cyrillic layout types U+044B for the key that a Latin layout calls s, and says which key it is:
    // CSI 1099 : : 115 ; 5 u.
    app.mockInput.pressKey("k", { ctrl: true })
    app.mockInput.pressKey("\x1b[1099::115;5u")
    expect(calls).toEqual(["new"])
  } finally {
    app.renderer.destroy()
  }
})

test("the text area's keys stay below the app's own when a change to the config gives it other keys", async () => {
  const calls: string[] = []
  let current = {}
  const service = {
    get: async () => current,
    update: async (update: (draft: Record<string, any>) => void) => {
      const draft: Record<string, any> = { ...current }
      update(draft)
      current = draft
      return draft
    },
  }
  let change = async () => {}

  function Harness() {
    const config = useConfig()
    change = async () => {
      await config.update((draft) => {
        draft.keybinds = { "input.delete.to.line.end": "ctrl+alt+k" }
      })
    }
    // A layer that reads nothing from the config, so a change to it leaves it where it registered. ctrl+d is also what the
    // text area uses to delete a character.
    Keymap.createLayer(() => ({ commands: [{ bind: "ctrl+d", title: "App", run: () => void calls.push("app") }] }))
    return <textarea focused initialValue="text" />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={resolve({}, { terminalSuspend: true })} service={service}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  try {
    app.mockInput.pressKey("d", { ctrl: true })
    expect(calls).toEqual(["app"])

    await change()
    app.mockInput.pressKey("d", { ctrl: true })
    expect(calls).toEqual(["app", "app"])
  } finally {
    app.renderer.destroy()
  }
})

test("a change to the leader key in the config takes effect while the app runs", async () => {
  const calls: string[] = []
  let current = {}
  const service = {
    get: async () => current,
    update: async (update: (draft: Record<string, any>) => void) => {
      const draft: Record<string, any> = { ...current }
      update(draft)
      current = draft
      return draft
    },
  }
  let change = async () => {}

  function Harness() {
    const config = useConfig()
    change = async () => {
      await config.update((draft) => {
        draft.keybinds = { leader: "ctrl+o" }
      })
    }
    Keymap.createLayer(() => ({ commands: [{ id: "session.new", run: () => void calls.push("new") }] }))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={resolve({}, { terminalSuspend: true })} service={service}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["new"])

    await change()
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["new"])

    app.mockInput.pressKey("o", { ctrl: true })
    app.mockInput.pressKey("n")
    expect(calls).toEqual(["new", "new"])
  } finally {
    app.renderer.destroy()
  }
})
