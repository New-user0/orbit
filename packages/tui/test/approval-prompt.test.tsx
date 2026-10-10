/** @jsxImportSource @opentui/solid */
// "What is shown is what runs", the terminal UI's session prompt, drawn as the real component (`PermissionPrompt`) and read
// from the screen. The presentation test beside it checks the strings; this one checks what reaches the screen: the edit
// view draws only the diff, and the header hides the title of a shell command, so a value that the presentation holds can
// still be missing from the frame (class 8, class 14).
import path from "node:path"
import os from "node:os"
import type { PermissionRequest } from "@orbit/client"
import type { JsonValue } from "@orbit/client/promise"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { InteractivityProvider } from "../src/context/interactivity"
import { LocationProvider } from "../src/context/location"
import { ThemeProvider } from "../src/context/theme"
import { PermissionPrompt } from "../src/routes/session/permission"
import { ToastProvider } from "../src/ui/toast"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

type Row = {
  id: string
  tool: string
  request: { action: string; resources: string[]; metadata?: Record<string, JsonValue> }
  truth: { places?: string[]; folder?: string; method?: string; url?: string; arguments?: string }
}

const home = os.tmpdir().replaceAll("\\", "/")
const world = { project: `${home}/matrix-project`, outside: `${home}/matrix-outside`, outsideName: "matrix-outside" }
const fixture = path.join(import.meta.dir, "../../core/test/fixture")
const load = async (name: string) =>
  ((await Bun.file(path.join(fixture, name)).json()) as Row[]).map(
    (row): Row =>
      JSON.parse(
        JSON.stringify(row)
          .replaceAll("{project}", world.project)
          .replaceAll("{outsideName}", world.outsideName)
          .replaceAll("{outside}", world.outside),
      ),
  )
const matrix = [...(await load("approval-matrix.json")), ...(await load("approval-matrix-pinned.json"))]
// One row for each kind of request the prompt draws: a file read, an edit, a patch that moves a file, a notebook edit, a
// command, a search, a fetch and an MCP call.
const kinds = [
  "Read/relative path/untrusted",
  "Read/link/untrusted",
  "Edit/relative path/untrusted",
  "Write/absolute path outside/untrusted",
  "NotebookEdit/relative path/untrusted",
  "Patch/relative path/untrusted",
  "Patch (move)/relative path/untrusted",
  "Glob/folder",
  "Grep/folder",
  "Bash/folder",
  "PowerShell/folder",
  "WebFetch/get",
  "WebFetch/redirect-hop",
  "WebFetch/code-mode-post",
  "MCP/code-mode",
]
const rows = kinds.map((id) => {
  const row = matrix.find((item) => item.id === id)
  if (!row) throw new Error(`no matrix row ${id}`)
  return row
})

async function draw(request: Omit<PermissionRequest, "id" | "sessionID">, width: number, height: number, scroll = 0) {
  await using tmp = await tmpdir()
  const ready = Promise.withResolvers<void>()
  const transport = createFetch((url) => {
    if (url.pathname === "/api/session/ses_prompt")
      return json({
        data: {
          id: "ses_prompt",
          title: "Prompt session",
          projectID: "proj_test",
          location: { directory: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
  }, createEventStream())
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={tmp.path}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <ToastProvider>
                      <InteractivityProvider enabled>
                        <PermissionPrompt request={{ id: "per_prompt", sessionID: "ses_prompt", ...request }} />
                      </InteractivityProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height, kittyKeyboard: true },
  )
  ready.resolve()
  try {
    app.renderer.start()
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()
    // Every screen of a prompt that scrolls: the frame as drawn, then after each wheel step over the body.
    const shots = [app.captureCharFrame()]
    for (let step = 0; step < scroll; step++) {
      await app.mockMouse.scroll(10, 4, "down")
      await app.renderOnce()
      shots.push(app.captureCharFrame())
    }
    return shots.join("\n")
  } finally {
    app.renderer.destroy()
  }
}

// A long path wraps at the edge of the screen, so the frame is compared without its line breaks and padding.
const squash = (value: string) => value.replace(/\s+/g, "").replaceAll("\\", "/")
const flat = squash

for (const row of rows)
  test(`the session prompt for ${row.id} draws the request's values on the screen`, async () => {
    const frame = flat(await draw(row.request, 220, 60))
    expect(frame).toContain("Allowonce")
    expect(frame).not.toContain("DECOY")
    // A path may be shown relative to the project or the home folder, so the last two parts of it are what is compared.
    const tail = (value: string) => squash(value.split(/[\\/]/).slice(-2).join("/"))
    for (const place of row.truth.places ?? []) expect(frame).toContain(tail(place))
    if (row.truth.folder) expect(frame).toContain(tail(row.truth.folder))
    if (row.truth.url) expect(frame).toContain(squash(row.truth.url))
    if (row.truth.method && row.truth.method !== "GET") expect(frame).toContain(squash(row.truth.method))
    if (row.truth.arguments) expect(frame).toContain(squash(row.truth.arguments))
    if (["Bash", "PowerShell", "Glob", "Grep"].includes(row.tool))
      for (const resource of row.request.resources.filter((item) => item !== "*")) expect(frame).toContain(squash(resource))
    for (const file of (row.request.metadata?.files ?? []) as { from?: string; patch: string }[]) {
      if (file.from) expect(frame).toContain(tail(file.from))
      // The diff view clips a very long line and scrolls past the first screen, so the first changed lines are compared
      // by their opening text.
      const changed = file.patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line) && line.slice(1).trim() !== "")
      for (const line of changed.slice(0, 3)) expect(frame).toContain(squash(line.slice(1)).slice(0, 30))
    }
  })

// The title of a moved file is the longest line a request has, and a narrow terminal has to show both of its places.
test("the session prompt for a move at a narrow width still names the source and the destination", async () => {
  const frame = flat(
    await draw(
      {
        action: "Edit",
        resources: ["src/old-name.txt", "src/new-name.txt"],
        metadata: {
          paths: ["/work/src/old-name.txt", "/work/src/new-name.txt"],
          files: [
            {
              file: "src/new-name.txt",
              place: "/work/src/new-name.txt",
              from: "/work/src/old-name.txt",
              patch: "--- a\n+++ b\n@@ -1 +1 @@\n-before text\n+after text\n",
            },
          ],
        },
      },
      48,
      40,
    ),
  )
  expect(frame).toContain("old-name.txt")
  expect(frame).toContain("new-name.txt")
  expect(frame).toContain("aftertext")
})

// The model picks the order of an MCP call's arguments, so the value that matters can come after a long one.
test("the session prompt for an MCP call draws every argument, including the ones after a long value", async () => {
  const frame = flat(
    await draw(
      {
        action: "mcp__chat__post",
        resources: ["*"],
        metadata: { arguments: { note: "x".repeat(2100), channel: "#leak-HIDDEN", text: "secrets" } },
      },
      120,
      60,
      40,
    ),
  )
  expect(frame).toContain("#leak-HIDDEN")
  expect(frame).toContain("secrets")
})

// On a short screen the body is taller than the room it has: the value after the long one is off the first screen, and
// scrolling the prompt brings it into view. The prompt already scrolls as a whole, so this pins that and is not a
// mutation test of any change.
test("the session prompt for an MCP call on a short screen scrolls to the arguments after a long value", async () => {
  const request = {
    action: "mcp__chat__post",
    resources: ["*"],
    metadata: { arguments: { note: "x".repeat(2100), channel: "#leak-HIDDEN", text: "secrets" } },
  }
  const first = flat(await draw(request, 60, 14))
  expect(first).not.toContain("#leak-HIDDEN")
  const scrolled = flat(await draw(request, 60, 14, 40))
  expect(scrolled).toContain("#leak-HIDDEN")
  expect(scrolled).toContain("secrets")
})
