/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@orbit/client"
import type { TextareaRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { KeybindingsFile } from "../../../src/config/keybindings-file"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData, type FormWithLocation } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { InteractivityProvider } from "../../../src/context/interactivity"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { FormPrompt, FORM_MODE } from "../../../src/routes/session/form"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function mountPanes(
  root: string,
  render: () => JSX.Element,
  parentID?: string,
  keybindings?: KeybindingsFile.Result,
) {
  const [active, setActive] = createSignal(false)
  const replies: unknown[] = []
  const cancellations: string[] = []
  const submissions: string[] = []
  const ready = Promise.withResolvers<void>()
  let peer!: TextareaRenderable
  let keymap!: Keymap
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/session/ses_scoped")
      return json({
        data: {
          id: "ses_scoped",
          parentID,
          title: "Scoped session",
          projectID: "proj_test",
          location: { directory: root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname.endsWith("/reply"))
      return request.json().then((body) => {
        replies.push(body)
        return new Response(null, { status: 204 })
      })
    if (url.pathname.endsWith("/cancel")) {
      cancellations.push(url.pathname)
      return new Response(null, { status: 204 })
    }
  }, createEventStream())

  function Panes() {
    const data = useData()
    keymap = Keymap.use()
    onMount(() => void data.session.sync("ses_scoped").then(ready.resolve, ready.reject))
    return (
      <box>
        <InteractivityProvider enabled={!active()}>
          <textarea
            ref={(value) => (peer = value)}
            focused={!active()}
            initialValue="peer"
            onSubmit={() => submissions.push(peer.plainText)}
          />
        </InteractivityProvider>
        <InteractivityProvider enabled={active()}>{render()}</InteractivityProvider>
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false }, { keybindings })}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={root}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <ToastProvider>
                      <Panes />
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 90, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await ready.promise
  await app.renderOnce()
  return { app, setActive, replies, cancellations, submissions, peer, keymap }
}

function form(fields: FormWithLocation["fields"]): FormWithLocation {
  return { id: "frm_scoped", sessionID: "ses_scoped", title: "Scoped form", fields }
}

const request = {
  id: "per_scoped",
  sessionID: "ses_scoped",
  action: "shell",
  resources: ["echo scoped"],
} satisfies PermissionRequest

test("an inactive form leaves Enter, navigation, and paste with the focused peer", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => (
    <FormPrompt
      form={form([
        {
          key: "target",
          type: "string",
          options: [
            { value: "staging", label: "Staging" },
            { value: "production", label: "Production" },
          ],
        },
      ])}
    />
  ))
  try {
    expect(panes.keymap.mode.current()).toBe("base")
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressArrow("down")
    panes.app.mockInput.pressKey("2")
    panes.app.mockInput.pressEscape()
    await panes.app.mockInput.pasteBracketedText(" pasted")
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.peer.plainText).toContain("pasted")
    expect(panes.replies).toEqual([])
    expect(panes.cancellations).toEqual([])

    panes.setActive(true)
    expect(panes.keymap.mode.current()).toBe(FORM_MODE)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { target: "staging" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("a form textarea mounts inactive and restores its draft focus after scope and modal changes", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <FormPrompt form={form([{ key: "notes", type: "string" }])} />)
  try {
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.setActive(true)
    const input = panes.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    expect(input?.id).not.toBe(panes.peer.id)
    await panes.app.mockInput.typeText("draft answer")

    const pop = panes.keymap.mode.push("modal")
    expect(panes.app.renderer.currentFocusedEditor).toBeNull()
    panes.setActive(false)
    panes.setActive(true)
    expect(panes.keymap.mode.current()).toBe("modal")
    expect(panes.app.renderer.currentFocusedEditor).toBeNull()
    pop()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)

    panes.setActive(false)
    input?.focus()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    await panes.app.mockInput.typeText(" other")
    await panes.app.mockInput.pasteBracketedText(" pane")
    panes.app.mockInput.pressEnter()
    expect(panes.submissions).toHaveLength(1)
    expect(input?.plainText).toBe("draft answer")
    expect(panes.replies).toEqual([])

    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { notes: "draft answer" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("inactive custom forms cannot intercept a peer using the same form mode", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => (
    <FormPrompt
      form={form([{ key: "target", type: "string", options: [{ value: "staging", label: "Staging" }], custom: true }])}
    />
  ))
  try {
    panes.setActive(true)
    panes.app.mockInput.pressArrow("down")
    panes.setActive(false)
    const pop = panes.keymap.mode.push(FORM_MODE)
    await panes.app.mockInput.typeText(" typed")
    await panes.app.mockInput.pasteBracketedText(" pasted")
    panes.app.mockInput.pressEnter()
    await panes.app.renderOnce()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    expect(panes.submissions).toHaveLength(1)
    expect(panes.peer.plainText).toContain("typed")
    expect(panes.peer.plainText).toContain("pasted")
    expect(panes.app.captureCharFrame()).toContain("Type your own answer")
    expect(panes.replies).toEqual([])
    pop()

    panes.setActive(true)
    await panes.app.mockInput.typeText("production target")
    await panes.app.waitFor(() => panes.app.renderer.currentFocusedEditor?.plainText === "production target")
    panes.setActive(false)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.plainText).toBe("production target")
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { target: "production target" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("permission layers leave the focused peer's Enter and navigation alone until activated", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={request} />)
  try {
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressArrow("right")
    panes.app.mockInput.pressEscape()
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.replies).toEqual([])
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)

    panes.setActive(true)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ decision: "once" }])
    expect(panes.submissions).toHaveLength(1)
  } finally {
    panes.app.renderer.destroy()
  }
})

// The request carries the action under the name the tool has now; the diff must show whichever spelling it uses.
test.each(["Edit", "edit"])("a %s permission request shows the diff it asks to approve", async (action) => {
  await using tmp = await tmpdir()
  const diff = "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-before the change\n+after the change\n"
  const panes = await mountPanes(tmp.path, () => (
    <PermissionPrompt
      request={{
        id: "per_edit",
        sessionID: "ses_scoped",
        action,
        resources: ["notes.txt"],
        metadata: { diff },
      }}
    />
  ))
  try {
    await panes.app.renderOnce()
    expect(panes.app.captureCharFrame()).toContain("after the change")
  } finally {
    panes.app.renderer.destroy()
  }
})

test.each([
  ["permission", true],
  ["dialog", false],
])(
  "a key given to the fullscreen command in the %s context reaches the permission prompt only if that is its own: %s",
  async (context, toggles) => {
    await using tmp = await tmpdir()
    const keybindings = KeybindingsFile.decode(
      JSON.stringify({ contexts: { [context]: { "permission.prompt.fullscreen": "ctrl+alt+f" } } }),
    )
    const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={request} />, undefined, keybindings)
    try {
      panes.setActive(true)
      // The hint beside the prompt names whichever key the keymap holds for the command.
      const hint = await panes.app.waitForFrame((frame) => /\S+ fullscreen/.test(frame))
      expect(hint.includes("ctrl+alt+f fullscreen")).toBe(toggles)
      expect(hint.includes("ctrl+f fullscreen")).toBe(!toggles)

      panes.app.mockInput.pressKey("f", { ctrl: true, meta: true })
      await panes.app.renderOnce()
      await Bun.sleep(100)
      await panes.app.renderOnce()
      // Full screen, the prompt is drawn in a portal that this harness does not lay out, so it leaves the frame.
      expect(panes.app.captureCharFrame().includes("Permission required")).toBe(!toggles)
    } finally {
      panes.app.renderer.destroy()
    }
  },
)

test("permission rejection text keeps its draft and regains focus when its scope resumes", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={request} />, "ses_parent")
  try {
    panes.setActive(true)
    panes.app.mockInput.pressEscape()
    await panes.app.waitForFrame((frame) => frame.includes("Reject permission"))
    const input = panes.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    await panes.app.mockInput.typeText("choose another command")

    panes.setActive(false)
    panes.app.mockInput.pressEnter()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.replies).toEqual([])
    expect(input?.plainText).toBe("choose another command")

    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ decision: "reject", message: "choose another command" }])
  } finally {
    panes.app.renderer.destroy()
  }
})
