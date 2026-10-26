/** @jsxImportSource @opentui/solid */
// What is shown is what ran (class 8): an approval answered with the person's own version of a file writes that version,
// so the terminal UI draws a completed Write from the diff the tool recorded and never from the model's `content`. Each row
// draws the real `Write` component and reads the screen. Drawing from `input.content` again fails the revised rows, which
// would show PROPOSED (class 14).
import type { JsonValue, SessionMessageAssistantTool } from "@orbit/client/promise"
import { addDefaultParsers } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider } from "../../../src/context/route"
import { ThemeProvider } from "../../../src/context/theme"
import parsers from "../../../src/parsers-config"
import { Write } from "../../../src/routes/session"
import { createTimelineAnchors } from "../../../src/routes/session/anchors"
import { context } from "../../../src/routes/session/render-context"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { agent, model } from "../../fixture/local"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const rows = [
  {
    name: "a new file written with the person's revision",
    status: "completed",
    files: [
      {
        file: "a.txt",
        status: "added",
        patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+REVISED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["# Wrote", "a.txt", "REVISED"],
    hides: ["PROPOSED"],
  },
  {
    name: "a file that was there, written with the person's revision",
    status: "completed",
    files: [
      {
        file: "a.txt",
        status: "modified",
        patch: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-before\n+REVISED\n",
        additions: 1,
        deletions: 1,
      },
    ],
    shows: ["# Wrote", "a.txt", "before", "REVISED"],
    hides: ["PROPOSED"],
  },
  {
    name: "a new file written as proposed",
    status: "completed",
    files: [
      {
        file: "a.txt",
        status: "added",
        patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+PROPOSED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["# Wrote", "a.txt", "PROPOSED"],
    hides: [],
  },
  // A completed call that recorded no diff names its file and shows no text: the input's content may not be what ran.
  {
    name: "a completed call that recorded no diff",
    status: "completed",
    files: undefined,
    shows: ["Write a.txt"],
    hides: ["PROPOSED", "# Wrote"],
  },
  // While the call runs nothing is written yet, so the row names the file from the input and shows no text either.
  {
    name: "a call still running",
    status: "running",
    files: undefined,
    shows: ["Write a.txt"],
    hides: ["PROPOSED", "# Wrote"],
  },
  // Only a completed call wrote what its diff records: a call still running or one that failed is not drawn as written,
  // even when its metadata already holds a diff. Drawing the recorded diff for every status fails these rows.
  {
    name: "a call still running whose metadata already holds a diff",
    status: "running",
    files: [
      {
        file: "a.txt",
        status: "added",
        patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+REVISED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["Write a.txt"],
    hides: ["REVISED", "# Wrote"],
  },
  {
    name: "a failed call whose metadata holds a diff",
    status: "error",
    files: [
      {
        file: "a.txt",
        status: "added",
        patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+REVISED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["Write a.txt"],
    hides: ["REVISED", "# Wrote"],
  },
  // The recorded file name can come from the model or the repository, so the completed header writes out a control or
  // bidi character instead of drawing it (class 9). Without `bodyText` on the header the frame holds the raw character.
  {
    name: "a completed call whose file name holds a bidi override",
    status: "completed",
    path: "ab‮txt.exe",
    files: [
      {
        file: "ab‮txt.exe",
        status: "added",
        patch: "--- x\n+++ x\n@@ -0,0 +1,1 @@\n+REVISED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["# Wrote", "ab\\u{202e}txt.exe", "REVISED"],
    hides: ["‮"],
  },
  {
    name: "a completed call whose file name holds an escape",
    status: "completed",
    path: "ab\u001b[2Jc.txt",
    files: [
      {
        file: "ab\u001b[2Jc.txt",
        status: "added",
        patch: "--- x\n+++ x\n@@ -0,0 +1,1 @@\n+REVISED\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["# Wrote", "REVISED"],
    hides: ["\u001b"],
  },
  // What the file holds comes from the repository or the person, so the drawn diff of a file that was there and the drawn
  // text of a new file write out control and bidi characters too (class 9). Without `bodyText` on the diff or the text the
  // frame holds the raw character.
  {
    name: "a file that was there, whose recorded diff holds a bidi override and an escape",
    status: "completed",
    files: [
      {
        file: "a.txt",
        status: "modified",
        patch: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-before\n+RE‮V\u001b[2JD\n",
        additions: 1,
        deletions: 1,
      },
    ],
    shows: ["# Wrote", "before", "\\u{202e}"],
    hides: ["‮", "\u001b"],
  },
  {
    name: "a new file whose text holds a bidi override and an escape",
    status: "completed",
    files: [
      {
        file: "a.txt",
        status: "added",
        patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+RE‮V\u001b[2JD\n",
        additions: 1,
        deletions: 0,
      },
    ],
    shows: ["# Wrote", "\\u{202e}"],
    hides: ["‮", "\u001b"],
  },
] as const

for (const row of rows)
  test(`a Write in the session draws what ran: ${row.name}`, async () => {
    const frame = await draw({
      status: row.status,
      path: "path" in row ? row.path : "a.txt",
      metadata: row.files ? { files: row.files.map((file) => ({ ...file })) } : {},
    })
    for (const text of row.shows) expect(frame).toContain(text)
    for (const text of row.hides) expect(frame).not.toContain(text)
  })

// A file that was there is drawn as its diff, laid out as the other file diffs are: unified when the session is narrow,
// split when it is wide, and as the `diffs.view` setting says when it names a layout. Split draws the removed and the
// added line on one row; unified draws them on two.
const overwrite = {
  files: [
    {
      file: "a.txt",
      status: "modified",
      patch: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-before\n+REVISED\n",
      additions: 1,
      deletions: 1,
    },
  ],
}
for (const layout of [
  { name: "a narrow session draws it unified", width: 80, view: undefined, split: false },
  { name: "a wide session draws it split", width: 160, view: undefined, split: true },
  { name: "a wide session with the unified setting draws it unified", width: 160, view: "unified", split: false },
  { name: "a narrow session with the split setting draws it split", width: 80, view: "split", split: true },
] as const)
  test(`a Write over a file that was there: ${layout.name}`, async () => {
    const frame = await draw({
      status: "completed",
      path: "a.txt",
      metadata: overwrite,
      width: layout.width,
      view: layout.view,
    })
    const lines = frame.split("\n")
    expect(lines.some((line) => line.includes("before"))).toBe(true)
    expect(lines.some((line) => line.includes("REVISED"))).toBe(true)
    expect(lines.some((line) => line.includes("before") && line.includes("REVISED"))).toBe(layout.split)
  })

async function draw(input: {
  status: "completed" | "running" | "error"
  path: string
  metadata: Record<string, JsonValue>
  width?: number
  view?: "split" | "unified"
}) {
  addDefaultParsers(parsers.parsers)
  await using temporary = await tmpdir()
  const width = input.width ?? 80
  const metadata = input.metadata
  const toolInput = { path: input.path, content: "PROPOSED\n" }
  const part: SessionMessageAssistantTool =
    input.status === "completed"
      ? {
          type: "tool",
          id: "call_write",
          name: "write",
          time: { created: 0, completed: 1 },
          state: { status: "completed", input: toolInput, content: [{ type: "text", text: "" }], metadata },
        }
      : input.status === "error"
        ? {
            type: "tool",
            id: "call_write",
            name: "write",
            time: { created: 0, completed: 1 },
            state: {
              status: "error",
              input: toolInput,
              error: { type: "unknown", message: "write failed" },
              metadata,
            },
          }
        : {
            type: "tool",
            id: "call_write",
            name: "write",
            time: { created: 0 },
            state: { status: "running", input: toolInput, metadata },
          }
  const config = createTuiResolvedConfig({ animations: false, ...(input.view ? { diffs: { view: input.view } } : {}) })
  const calls = createFetch((url) => {
    const location = { directory }
    if (url.pathname === "/api/agent") return json({ location, data: [agent("build")] })
    if (url.pathname === "/api/model") return json({ location, data: [model("first")] })
  }, createEventStream())
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <ArgsProvider>
          <ConfigProvider config={config}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "home" }}>
                    <ClientProvider api={createApi(calls.fetch)}>
                      <DataProvider directory={directory}>
                        <LocationProvider>
                          <PermissionProvider directory={directory}>
                            <LocalProvider>
                              <DialogProvider>
                                <context.Provider
                                  value={{
                                    width,
                                    terminal: { width, height: 20 },
                                    sessionID: "ses_write",
                                    anchors: createTimelineAnchors(),
                                    groupExpanded: () => true,
                                    setGroupExpanded: () => {},
                                    thinkingMode: () => "hide",
                                    markdownMode: () => "rendered",
                                    groupExploration: () => false,
                                    legacyTurns: () => false,
                                    diffWrapMode: () => "word",
                                    models: () => [],
                                    messageIndex: () => undefined,
                                    config,
                                    mutatePending: async () => true,
                                    pendingDelivery: () => undefined,
                                    rewind: async () => {},
                                  }}
                                >
                                  <Write input={toolInput} metadata={metadata} tool="write" output="" part={part} />
                                </context.Provider>
                              </DialogProvider>
                            </LocalProvider>
                          </PermissionProvider>
                        </LocationProvider>
                      </DataProvider>
                    </ClientProvider>
                  </RouteProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width, height: 20 },
  )
  try {
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}
