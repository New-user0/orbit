/** @jsxImportSource @opentui/solid */
// m5-link-warning: every stage of the terminal UI's and Mini's approval of a file change says where a link leads, from
// the request alone (class 8), written out (class 9). Each is the real component, drawn and read from the screen. A
// list that is cut or scrolled never hides that a warning exists: the fixed line is above whatever the request can
// make tall, and it and the title leave rows to what is approved, so every linked file's own line can be reached by
// scrolling and what Always allow grants is in sight, at the sizes drawn here.
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import type { PermissionRequest } from "@orbit/client"
import type { JsonValue } from "@orbit/client/promise"
import { parseColor, SyntaxStyle, type CapturedFrame, type RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount, Show } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { InteractivityProvider } from "../src/context/interactivity"
import { Keymap } from "../src/context/keymap"
import { LocationProvider } from "../src/context/location"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { RunPermissionBody } from "../src/mini/footer.permission"
import { pickBlockerView } from "../src/mini/session-data"
import { RUN_THEME_FALLBACK, RUN_THEME_MONO } from "../src/mini/theme"
import { EditorDiffPrompt, PermissionPrompt } from "../src/routes/session/permission"
import { permissionAlwaysLines, permissionPresentation } from "../src/util/permission"
import { ToastProvider } from "../src/ui/toast"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { canonicalToolPart } from "./mini/fixture/tool-part"

type Entry = Record<string, JsonValue>
const patch = (name: string) => `--- ${name}\n+++ ${name}\n@@ -1,1 +1,1 @@\n-old\n+new\n`
const ask = (files: Entry[], resources = files.map((file) => String(file.file))): PermissionRequest => ({
  id: "per_link",
  sessionID: "ses_link",
  action: "Edit",
  resources,
  save: ["*"],
  metadata: { paths: files.map((file) => file.place ?? file.file ?? ""), files },
})

const out = (name: string): Entry => ({
  file: `linked/${name}`,
  place: `/elsewhere/real/${name}`,
  patch: patch(name),
  link: { place: `/elsewhere/real/${name}`, outside: true },
})
const inside = (name: string): Entry => ({
  file: `alias/${name}`,
  place: `/work/alias/${name}`,
  patch: patch(name),
  link: { place: `/work/src/${name}`, outside: false },
})
const plainFile = (name: string): Entry => ({ file: name, place: `/work/${name}`, patch: patch(name) })

const OUT = "Link ends outside the project"
const IN = "Link ends inside the project"

// What each request says: the fixed line of every stage, and the line of each linked end.
const kinds: Array<{ name: string; request: PermissionRequest; fixed: string; lines: string[][] }> = [
  { name: "one, out", request: ask([out("a.txt")]), fixed: OUT, lines: [[OUT, "real/a.txt"]] },
  { name: "one, inside", request: ask([inside("b.txt")]), fixed: IN, lines: [[IN, "alias/b.txt", "leads to", "src/b.txt"]] },
  {
    name: "a notebook",
    request: ask([out("n.ipynb")]),
    fixed: OUT,
    lines: [[OUT, "real/n.ipynb"]],
  },
  {
    name: "a deletion",
    request: ask([{ ...out("gone.txt"), status: "deleted" }]),
    fixed: OUT,
    lines: [[OUT, "real/gone.txt"]],
  },
  {
    name: "a move from a link",
    request: ask([
      {
        ...plainFile("to.txt"),
        from: "/elsewhere/real/from.txt",
        fromLink: { place: "/elsewhere/real/from.txt", outside: true },
      },
    ]),
    fixed: OUT,
    lines: [[OUT, "real/from.txt"]],
  },
  {
    name: "several",
    request: ask([plainFile("c.txt"), inside("b.txt"), out("a.txt")]),
    fixed: "2 linked paths, 1 outside the project",
    lines: [
      [OUT, "real/a.txt"],
      [IN, "src/b.txt"],
    ],
  },
  {
    name: "several, all inside",
    request: ask([inside("b.txt"), inside("e.txt")]),
    fixed: "2 linked paths, all inside the project",
    lines: [
      [IN, "src/b.txt"],
      [IN, "src/e.txt"],
    ],
  },
]
const noWarning = /Linkends|linkedpaths/

// A frame without its breaks, padding, borders and scroll bar, so that a wrapped line reads as one.
const squash = (value: string) => value.replace(/[\s│┃█▀▄─╭╮╰╯]/g, "")
const flat = (value: string) => squash(value).replaceAll("\\", "/")

type Stage = "permission" | "always" | "reject"
type Size = { width: number; height: number }

async function drawFull(
  asks: PermissionRequest | ((directory: string) => PermissionRequest),
  stage: Stage,
  size: Size,
  options: {
    scroll?: number
    // Scrolls to the end, with the wheel over the row above the options, which is the last of what scrolls.
    read?: boolean
    // The prompt in a column narrower than the screen, as beside a sidebar.
    column?: number
    compact?: boolean
    fullscreen?: boolean
    // What the frame waits for, where the body is drawn only once it is highlighted.
    drawn?: string
    painted?: (frame: CapturedFrame, warning: RGBA, text: RGBA) => void
  } = {},
) {
  await using tmp = await tmpdir()
  const request = typeof asks === "function" ? asks(tmp.path) : asks
  const transport = createFetch((url) => {
    if (url.pathname === "/api/session/ses_link")
      return json({
        data: {
          id: "ses_link",
          // The question of a subagent: the one that has a reject stage.
          parentID: "ses_parent",
          title: "Link session",
          projectID: "proj_test",
          location: { directory: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
  }, createEventStream())
  let colors: { warning: RGBA; text: RGBA } | undefined
  function Route() {
    const data = useData()
    const theme = useTheme()
    colors = { warning: theme.text.feedback.warning.base, text: theme.text.base }
    onMount(() => void data.session.sync("ses_link"))
    return (
      <Show when={data.session.get("ses_link")}>
        <Show
          when={options.compact}
          fallback={
            // Fullscreen is placed from the bottom of a screen that the route fills, as the session does.
            <box width={options.column ?? "100%"} height={options.fullscreen ? "100%" : undefined}>
              <PermissionPrompt request={request} />
            </box>
          }
        >
          <box width={options.column ?? "100%"}>
            <EditorDiffPrompt request={request} editor="Test Editor" onSelect={() => {}} />
          </box>
        </Show>
      </Show>
    )
  }
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
                        <Route />
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
    { ...size, kittyKeyboard: true },
  )
  const until = async (text: string) => {
    const started = Date.now()
    while (true) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (flat(frame).includes(flat(text))) return frame
      if (Date.now() - started > 8_000) throw new Error(`timed out waiting for ${text}:\n${frame}`)
      await Bun.sleep(10)
    }
  }
  // A scroll bar that comes or goes is a column for the text beside it, which a later render gives it.
  const settled = async () => {
    const seen: string[] = []
    while (seen.length < 3 || seen.at(-1) !== seen.at(-2)) {
      if (seen.length > 50) throw new Error("the frame does not settle")
      await app.renderOnce()
      seen.push(app.captureCharFrame())
    }
    return seen.at(-1)!
  }
  try {
    app.renderer.start()
    await until(options.compact ? "Reviewing in" : "Allow once")
    if (stage === "always") {
      app.mockInput.pressArrow("down")
      await until("This will always allow")
    }
    if (stage === "reject") {
      app.mockInput.pressKey("3")
      await until("Tell Orbit")
    }
    if (options.fullscreen) {
      app.mockInput.pressKey("f", { ctrl: true })
      await until("minimize")
    }
    if (options.drawn) await until(options.drawn)
    await Bun.sleep(0)
    await app.renderOnce()
    const shots = [await settled()]
    options.painted?.(app.captureSpans(), colors!.warning, colors!.text)
    for (let step = 0; step < (options.scroll ?? 0); step++) {
      // The wheel over each row of the body, whichever row the list starts on.
      await app.mockMouse.scroll(10, 4 + (step % 8), "down")
      await app.renderOnce()
      shots.push(app.captureCharFrame())
    }
    if (!options.read) return shots
    const over = shots[0]!.split("\n").findIndex((row) => squash(row).endsWith("1Allowonce")) - 1
    while (true) {
      await app.mockMouse.scroll(10, over, "down")
      const next = await settled()
      if (next === shots.at(-1)) break
      if (shots.length > 600) throw new Error("the scroll has no end")
      shots.push(next)
    }
    return shots
  } finally {
    app.renderer.destroy()
  }
}

async function drawMini(
  request: PermissionRequest,
  stage: Stage,
  size: Size,
  mono: boolean,
  pages = 0,
  directory?: string,
  painted?: (frame: CapturedFrame) => void,
  // The theme's highlighter, and what the frame waits for where it draws a joined diff.
  highlighted?: { syntax: SyntaxStyle; drawn: string },
) {
  const view = pickBlockerView({
    permission: {
      ...request,
      // The calling tool's input names links too, and nothing of it is drawn.
      tool: canonicalToolPart(
        "Patch",
        { status: "running", input: { link: { place: "/DECOY-LINK", outside: true } }, metadata: {} },
        "call-link",
      ),
    },
  })
  if (view.type !== "permission") throw new Error("not a permission")
  const theme = mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK
  const app = await testRender(
    () => (
      <Keymap.Provider config={createTuiResolvedConfig({ animations: false })}>
        <box {...size}>
          <RunPermissionBody
            request={view.request}
            directory={directory === undefined ? undefined : () => directory}
            theme={theme.footer}
            block={highlighted ? { ...theme.block, syntax: highlighted.syntax } : theme.block}
            mono={mono}
            onReply={() => {}}
          />
        </box>
      </Keymap.Provider>
    ),
    { ...size, kittyKeyboard: true },
  )
  const settle = async () => {
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()
  }
  try {
    await settle()
    if (stage === "always") {
      app.mockInput.pressArrow("right")
      await settle()
      app.mockInput.pressEnter()
      await settle()
      expect(app.captureCharFrame()).toContain("Always allow")
    }
    if (stage === "reject") {
      app.mockInput.pressArrow("right")
      await settle()
      app.mockInput.pressArrow("right")
      await settle()
      app.mockInput.pressEnter()
      await settle()
      expect(app.captureCharFrame()).toContain("Reject")
    }
    const started = Date.now()
    while (highlighted && !flat(app.captureCharFrame()).includes(flat(highlighted.drawn))) {
      if (Date.now() - started > 8_000) throw new Error(`timed out waiting for ${highlighted.drawn}`)
      await Bun.sleep(10)
      await app.renderOnce()
    }
    const shots = [app.captureCharFrame()]
    painted?.(app.captureSpans())
    for (let page = 0; page < pages; page++) {
      app.mockInput.pressKey("\x1b[6~")
      await settle()
      shots.push(app.captureCharFrame())
    }
    return shots
  } finally {
    app.renderer.currentFocusedEditor?.blur()
    app.renderer.destroy()
  }
}

const stages: Stage[] = ["permission", "always", "reject"]

for (const kind of kinds)
  for (const stage of stages)
    test(`the full dialog, ${stage} stage, warns about ${kind.name}`, async () => {
      for (const size of [
        { width: 200, height: 40 },
        { width: 80, height: 24 },
      ]) {
        const shots = await drawFull(kind.request, stage, size)
        const first = flat(shots[0]!)
        // One link is said whole where it is fixed; several are counted there.
        const fixed = kind.lines.length === 1 ? kind.lines[0]! : [kind.fixed]
        for (const part of fixed) expect(first).toContain(flat(part))
        expect(first).not.toContain("DECOY")
      }
      if (stage !== "permission") return
      // Every linked end's line can be read, scrolling where the list is longer than the prompt.
      const all = flat((await drawFull(kind.request, stage, { width: 200, height: 40 }, { scroll: 24 })).join("\n"))
      for (const line of kind.lines) for (const part of line) expect(all).toContain(flat(part))
    })

for (const kind of kinds.filter((item) => item.lines.length === 1))
  for (const stage of ["permission", "always"] as const)
    test(`the compact editor prompt, ${stage} stage, warns about ${kind.name}`, async () => {
      for (const size of [
        { width: 200, height: 40 },
        { width: 80, height: 24 },
      ]) {
        const frame = flat((await drawFull(kind.request, stage, size, { compact: true }))[0]!)
        for (const part of kind.lines[0]!) expect(frame).toContain(flat(part))
      }
    })

for (const kind of kinds)
  for (const stage of stages)
    for (const mono of [false, true])
      test(`Mini, ${stage} stage, mono=${mono}, warns about ${kind.name}`, async () => {
        // The footer's own height, a roomy one, and a compact one.
        for (const size of [
          { width: 100, height: 14 },
          { width: 200, height: 40 },
          { width: 40, height: 9 },
        ]) {
          const frame = flat((await drawMini(kind.request, stage, size, mono))[0]!)
          expect(frame).toContain(flat(kind.fixed))
          expect(frame).not.toContain("DECOY")
        }
        if (stage === "reject") return
        // The reject stage has only its field; the others name every end, scrolling where they must.
        const all = flat((await drawMini(kind.request, stage, { width: 100, height: 14 }, mono, 8)).join("\n"))
        for (const line of kind.lines) for (const part of line) expect(all).toContain(flat(part))
      })

test("Mini still says a warning exists on a screen too narrow for the sentence, which it shortens", async () => {
  for (const stage of stages) {
    const frame = flat((await drawMini(ask([out("a.txt")]), stage, { width: 24, height: 11 }, false))[0]!)
    expect([stage, frame.includes("Linkends")]).toEqual([stage, true])
    // The short form keeps the word that matters, where a cut in the middle lost it.
    expect([stage, frame.includes("Linkendsoutside")]).toEqual([stage, true])
  }
})

// The request chooses how many files there are and how long their names are, so neither may push the warning away.
test("a long list of files never hides that a warning exists", async () => {
  const names = Array.from({ length: 16 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  const request = ask([...names.map(plainFile), out("last.txt"), inside("last.txt")])
  const fixed = flat("2 linked paths, 1 outside the project")
  for (const size of [
    { width: 120, height: 40 },
    { width: 80, height: 24 },
  ])
    for (const stage of stages)
      expect([size, stage, flat((await drawFull(request, stage, size))[0]!).includes(fixed)]).toEqual([size, stage, true])
  for (const mono of [false, true])
    for (const stage of stages) {
      const shots = await drawMini(request, stage, { width: 80, height: 14 }, mono, stage === "permission" ? 4 : 0)
      // Fixed: it is there before any scrolling and after it.
      for (const shot of shots) expect([mono, stage, flat(shot).includes(fixed)]).toEqual([mono, stage, true])
    }
})

test("many links are counted, and the ones that end outside come first", async () => {
  const request = ask([...Array.from({ length: 5 }, (_, index) => inside(`in-${index}.txt`)), out("last.txt")])
  const fixed = flat("6 linked paths, 1 outside the project")
  for (const frame of [
    flat((await drawFull(request, "permission", { width: 200, height: 40 }))[0]!),
    flat((await drawMini(request, "permission", { width: 200, height: 40 }, false))[0]!),
  ]) {
    expect(frame).toContain(fixed)
    expect(frame).toContain(flat(OUT))
    // An inside line that fits on the first screen comes after the outside one.
    const first = frame.indexOf(flat(IN))
    if (first !== -1) expect(frame.indexOf(flat(OUT))).toBeLessThan(first)
  }
})

test("a place with control, bidi and line-break characters is written out (class 9)", async () => {
  const place = "/elsewhere/\u001b]0;pwned\u0007‮gnp.ts​\nLink ends inside the project"
  const request = ask([{ ...inside("b.txt"), link: { place, outside: true } }])
  const drawn = [
    (await drawFull(request, "permission", { width: 220, height: 40 }))[0]!,
    (await drawFull(request, "permission", { width: 220, height: 40 }, { compact: true }))[0]!,
    (await drawMini(request, "permission", { width: 220, height: 40 }, false))[0]!,
    (await drawMini(request, "permission", { width: 220, height: 40 }, true))[0]!,
  ]
  for (const frame of drawn) {
    for (const raw of ["\u001b", "\u0007", "‮", "​"]) expect(frame).not.toContain(raw)
    const text = squash(frame)
    expect(text).toContain("\\x1b]0;pwned\\x07\\u{202e}gnp.ts\\u{200b}\\nLinkendsinsidetheproject")
    // The break in the name starts no line that reads as Orbit's own.
    for (const line of frame.split("\n")) expect(squash(line).startsWith("Linkendsinside")).toBe(false)
  }
})

test("no client follows the link to word the warning: the request's place is what is drawn (classes 4, 6 and 8)", async () => {
  await using tmp = await tmpdir()
  const really = path.join(tmp.path, "FOLLOWED")
  const named = path.join(tmp.path, "as-the-server-said")
  await mkdir(really)
  await writeFile(path.join(really, "a.txt"), "")
  await symlink(really, named, "junction")
  const share = process.platform === "win32" ? "\\\\orbit-test.invalid\\share\\a.txt" : "//orbit-test.invalid/share/a.txt"
  const rows = [
    { place: path.join(named, "a.txt"), shows: "as-the-server-said/a.txt" },
    { place: share, shows: "orbit-test.invalid/share/a.txt" },
  ]
  for (const row of rows) {
    const request = ask([{ ...inside("a.txt"), link: { place: row.place, outside: true } }])
    for (const frame of [
      flat((await drawFull(request, "permission", { width: 220, height: 40 }))[0]!),
      flat((await drawFull(request, "permission", { width: 220, height: 40 }, { compact: true }))[0]!),
      flat((await drawMini(request, "permission", { width: 220, height: 40 }, false))[0]!),
    ]) {
      expect(frame).toContain(flat(row.shows))
      expect(frame).not.toContain("FOLLOWED")
    }
  }
})

test("an older server, no link or a malformed one draws as today, and a malformed one costs only itself (class 7)", async () => {
  const bad: JsonValue[] = [null, 7, "linked", {}, { place: 7, outside: true }, { place: "/r/a.txt", outside: "true" }]
  const quiet = [ask([plainFile("c.txt")]), ...bad.map((link) => ask([{ ...plainFile("c.txt"), link, fromLink: link }]))]
  for (const request of quiet)
    for (const frame of [
      flat((await drawFull(request, "permission", { width: 160, height: 40 }))[0]!),
      flat((await drawMini(request, "permission", { width: 160, height: 40 }, false))[0]!),
    ]) {
      expect(frame).toContain("Allowonce")
      expect(frame).not.toMatch(noWarning)
    }
  for (const link of bad) {
    const request = ask([{ ...plainFile("c.txt"), link }, out("a.txt")])
    for (const frame of [
      flat((await drawFull(request, "permission", { width: 160, height: 40 }))[0]!),
      flat((await drawMini(request, "permission", { width: 160, height: 40 }, false))[0]!),
    ]) {
      expect(frame).toContain("Allowonce")
      expect(frame).toContain(flat(OUT))
      expect(frame).not.toContain("linkedpaths")
    }
  }
})

test("a linked file's own name with a line break starts no line that reads as a warning (class 9)", async () => {
  const place = "/elsewhere/real/a.txt\nLink ends inside the project"
  const linked = { ...out("a.txt"), place, link: { place, outside: true } }
  for (const request of [ask([linked], ["linked/a.txt"]), ask([plainFile("c.txt"), linked], ["c.txt", "linked/a.txt"])])
    for (const frame of [
      (await drawFull(request, "permission", { width: 220, height: 40 }))[0]!,
      (await drawMini(request, "permission", { width: 220, height: 40 }, false))[0]!,
      (await drawMini(request, "permission", { width: 220, height: 40 }, true))[0]!,
    ]) {
      expect(flat(frame)).toContain(flat(OUT))
      for (const line of frame.split("\n")) expect(squash(line).startsWith("Linkendsinside")).toBe(false)
    }
})

test("the full dialog says one link once", async () => {
  const frame = flat((await drawFull(ask([out("a.txt")]), "permission", { width: 200, height: 40 }))[0]!)
  expect(frame.split(flat(OUT))).toHaveLength(2)
})

test("several links are each named where no file has a diff to draw", async () => {
  const request = ask([out("a.txt"), inside("b.txt")].map(({ patch: _, ...entry }) => entry))
  for (const frame of [
    flat((await drawFull(request, "permission", { width: 200, height: 40 }))[0]!),
    flat((await drawMini(request, "permission", { width: 200, height: 40 }, false))[0]!),
  ])
    for (const part of [OUT + ", at", IN + ":"]) expect(frame).toContain(flat(part))
})

test("a warning shows its places from the session's folder, as the rest of the prompt does", async () => {
  const here = (directory: string) =>
    ask([{ ...plainFile("b.txt"), place: path.join(directory, "alias", "b.txt"), link: { place: path.join(directory, "src", "b.txt"), outside: false } }])
  const said = flat(`${IN}: alias/b.txt leads to src/b.txt`)
  for (const compact of [false, true])
    expect(flat((await drawFull(here, "permission", { width: 220, height: 40 }, { compact }))[0]!)).toContain(said)
  await using tmp = await tmpdir()
  expect(flat((await drawMini(here(tmp.path), "permission", { width: 220, height: 40 }, false, 0, tmp.path))[0]!)).toContain(said)
})

test("the fullscreen dialog keeps the fixed line", async () => {
  for (const kind of kinds) {
    const shots = await drawFull(kind.request, "permission", { width: 120, height: 30 }, { fullscreen: true })
    expect([kind.name, flat(shots[0]!).includes(flat(kind.lines.length === 1 ? kind.lines[0]![0]! : kind.fixed))]).toEqual([
      kind.name,
      true,
    ])
  }
})

// The title names every file, and how many rows that takes differs with the length of the system's paths.
test("a long list of files leaves what Always allow grants inside the dialog, under the link line", async () => {
  for (const count of [8, 12, 18, 40]) {
    const names = Array.from({ length: count }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
    for (const size of [
      { width: 120, height: 40 },
      { width: 80, height: 24 },
      { width: 70, height: 24 },
    ]) {
      const frame = flat((await drawFull(ask([...names.map(plainFile), out("last.txt")]), "always", size))[0]!)
      const grant = frame.indexOf("Thiswillalwaysallow")
      expect([count, size, frame.indexOf(flat(OUT)) < grant, grant < frame.indexOf("Allowonce")]).toEqual([
        count,
        size,
        true,
        true,
      ])
    }
  }
})

test("while Always allow is focused the title takes the rows that the grant leaves", async () => {
  const names = Array.from({ length: 8 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  const request = ask([...names.map(plainFile), out("last.txt")])
  const size = { width: 120, height: 40 }
  // The seventh name is past three rows, and within those that the dialog has for a title.
  const seventh = flat(`${names[6]}`)
  expect(flat((await drawFull(request, "permission", size))[0]!)).toContain(seventh)
  expect(flat((await drawFull(request, "always", size))[0]!)).toContain(seventh)
})

// The colour that every piece of a warning is drawn in, where a wrapped one is several pieces.
function warningColors(frame: CapturedFrame) {
  return frame.lines
    .flatMap((line) => line.spans)
    .filter((span) => noWarning.test(squash(span.text)))
    .map((span) => span.fg.toInts())
}

test("the terminal UI and Mini draw every warning in the warning colour, in each stage", async () => {
  const mini = RUN_THEME_FALLBACK.footer
  expect(parseColor(mini.warning).toInts()).not.toEqual(parseColor(mini.text).toInts())
  for (const request of [ask([out("a.txt")]), ask([inside("b.txt"), out("a.txt")])]) {
    const several = Array.isArray(request.metadata?.files) && request.metadata.files.length > 1
    for (const compact of several ? [false] : [false, true])
      for (const stage of compact ? (["permission", "always"] as const) : stages)
        await drawFull(request, stage, { width: 200, height: 40 }, {
          compact,
          painted: (frame, warning, text) => {
            expect(warning.toInts()).not.toEqual(text.toInts())
            const drawn = warningColors(frame)
            // Several are counted on the fixed line and named in the body, under the grant while Always allow is focused.
            expect([several, compact, stage, drawn.length]).toEqual([several, compact, stage, several && stage !== "reject" ? 3 : 1])
            for (const color of drawn) expect([several, compact, stage, color]).toEqual([several, compact, stage, warning.toInts()])
          },
        })
    for (const stage of stages)
      await drawMini(request, stage, { width: 200, height: 40 }, false, 0, undefined, (frame) => {
        const drawn = warningColors(frame)
        expect([several, stage, drawn.length]).toEqual([several, stage, stage === "reject" ? 1 : several ? 3 : 2])
        for (const color of drawn) expect([several, stage, color]).toEqual([several, stage, parseColor(mini.warning).toInts()])
      })
  }
})

test("a long warning wraps, so the end of where it leads can be read", async () => {
  const tail = `${"deep-folder/".repeat(7)}the-very-end.txt`
  const place = `/elsewhere/${tail}`
  const request = ask([{ ...out("a.txt"), place, link: { place, outside: true } }])
  // Between the words and the tail is only the start of the place, which each system writes its own way.
  const said = new RegExp(`${flat(OUT)},at.{0,24}${flat(tail).replaceAll(".", "\\.")}`)
  for (const stage of ["permission", "always"] as const)
    for (const frame of [
      (await drawFull(request, stage, { width: 80, height: 24 }))[0]!,
      (await drawFull(request, stage, { width: 80, height: 24 }, { compact: true }))[0]!,
      (await drawMini(request, stage, { width: 60, height: 30 }, false))[0]!,
    ])
      expect([stage, said.test(flat(frame))]).toEqual([stage, true])
})

test("Mini's fixed line is right under its header, with no gap", async () => {
  for (const stage of stages) {
    const lines = (await drawMini(ask([out("a.txt")]), stage, { width: 200, height: 40 }, false))[0]!.split("\n").map(squash)
    const header = lines.findIndex((line) => line.startsWith("△"))
    expect([stage, header !== -1]).toEqual([stage, true])
    expect([stage, lines[header + 1]]).toEqual([stage, squash(OUT)])
  }
})

test("a title that names many files takes every row but the grant's while Always allow is focused", async () => {
  const names = Array.from({ length: 18 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  for (const width of [120, 80]) {
    const frame = (await drawFull(ask([...names.map(plainFile), out("last.txt")]), "always", { width, height: 40 }))[0]!
    const rows = frame.split("\n").map(squash)
    const title = rows.findIndex((row) => row.startsWith("▲"))
    expect([width, title !== -1]).toEqual([width, true])
    // Nine rows: the fixed line, six of the title, the gap and the grant.
    expect([width, rows.slice(title).indexOf("")]).toEqual([width, 6])
    expect([width, rows[title + 7]?.includes(squash("This will always allow Edit for this project."))]).toEqual([width, true])
  }
})

// Fix loop 1 (class 8): the repository chooses how long a path is and how many are linked, so neither may take the
// screen from what is approved. Each is a table, drawn as the real component.
const LENGTHS = [40, 100, 160, 260, 400, 1000]
const WIDTHS = [70, 80, 120]
const END = "the-very-end.txt"
const longPlace = (length: number) => `/elsewhere/${"d".repeat(Math.max(1, length - END.length - 12))}/${END}`
const longLink = (length: number, outside: boolean): Entry =>
  outside
    ? { ...out("a.txt"), place: longPlace(length), link: { place: longPlace(length), outside } }
    : { ...inside("b.txt"), link: { place: longPlace(length), outside } }
const GRANT = squash("This will always allow Edit for this project.")

// The rows of a dialog as drawn, where each is closed by the border and nothing is painted below it.
function dialog(frame: string) {
  const lines = frame.split("\n").map((line) => line.trimEnd())
  const bottom = lines.findIndex((line) => line.startsWith("╰"))
  expect(lines[0]).toMatch(/^╭─+╮$/)
  expect(bottom).toBeGreaterThan(0)
  expect(lines[bottom]).toMatch(/^╰─+╯$/)
  for (const line of lines.slice(1, bottom)) expect(line).toMatch(/^│.*│$/)
  expect(lines.slice(bottom + 1).join("")).toBe("")
  return lines.slice(1, bottom).map(squash)
}

for (const width of WIDTHS)
  for (const outside of [true, false])
    for (const compact of [false, true])
      test(`what Always allow grants is inside the ${compact ? "compact prompt" : "dialog"} at ${width} columns, whatever the length of a link ${outside ? "out" : "inside"}`, async () => {
        for (const length of LENGTHS) {
          const rows = dialog(
            (await drawFull(ask([longLink(length, outside)]), "always", { width, height: 24 }, { compact }))[0]!,
          )
          const said = rows.join("")
          expect([length, said.includes(GRANT)]).toEqual([length, true])
          expect([length, said.includes(squash(outside ? "Link ends outside" : "Link ends inside"))]).toEqual([length, true])
          const options = rows.findIndex((row) => row.endsWith("1Allowonce"))
          expect([length, rows.slice(options + 1, options + 3)]).toEqual([length, ["›2Alwaysallow", "3Reject"]])
          // The hints are stacked under 80 columns and are one row from there.
          const hints = compact ? ["↑↓select", "enterconfirm", "1–3shortcut"] : ["↑↓select", "enterconfirm", "1–3shortcut", "ctrl+ffullscreen"]
          expect([length, rows.slice(options + 3)]).toEqual([length, width < 80 ? hints : [hints.join("")]])
        }
      }, 30_000)

for (const width of WIDTHS)
  for (const compact of [false, true])
    test(`the whole of a long link's warning can be read in the ${compact ? "compact prompt" : "dialog"} at ${width} columns, fixed or by scrolling`, async () => {
      for (const length of LENGTHS) {
        const shots = await drawFull(
          ask([longLink(length, true)]),
          "permission",
          { width, height: 24 },
          { compact, scroll: length < 300 ? 48 : 200 },
        )
        const all = flat(shots.join("\n"))
        expect([length, all.includes(flat(OUT + ", at"))]).toEqual([length, true])
        expect([length, all.includes(END)]).toEqual([length, true])
        dialog(shots[0]!)
      }
    }, 30_000)

test("a warning that is summed up while Always allow is focused scrolls under the grant", async () => {
  for (const compact of [false, true]) {
    const shots = await drawFull(ask([longLink(400, true)]), "always", { width: 120, height: 24 }, { compact, scroll: 120 })
    expect([compact, flat(shots[0]!).includes(GRANT)]).toEqual([compact, true])
    expect([compact, flat(shots.join("\n")).includes(END)]).toEqual([compact, true])
  }
})

test("the reject stage keeps its field and hints, and the word outside or inside, whatever the length of a link", async () => {
  for (const width of WIDTHS)
    for (const outside of [true, false])
      for (const length of LENGTHS) {
        const frame = flat((await drawFull(ask([longLink(length, outside)]), "reject", { width, height: 24 }))[0]!)
        for (const part of [outside ? OUT : IN, "enter confirm", "esc cancel"])
          expect([width, length, part, frame.includes(flat(part))]).toEqual([width, length, part, true])
        // A warning of more than three rows is summed up, and one of a row is whole.
        if (length === 40) expect([width, outside, frame.includes(END)]).toEqual([width, outside, true])
        if (length === 1000) expect([width, outside, frame.includes(END)]).toEqual([width, outside, false])
      }
}, 30_000)

test("a grant of several lines stays in sight under a link and a long title", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  const request = { ...ask([...names.map(plainFile), out("last.txt")]), save: ["src/*", "docs/*"] }
  for (const width of [80, 120]) {
    const rows = dialog((await drawFull(request, "always", { width, height: 24 }))[0]!).join("")
    for (const part of ["Thiswillalwaysallowthefollowingpatterns", "-src/*", "-docs/*"])
      expect([width, part, rows.includes(part)]).toEqual([width, part, true])
  }
})

test("the compact prompt cuts a long name with a mark, above what Always allow grants", async () => {
  const name = `${"n".repeat(240)}.txt`
  const before = process.env.TERM_PROGRAM
  try {
    // With the row that says saving answers, and without it.
    for (const program of ["vscode", "other"]) {
      process.env.TERM_PROGRAM = program
      for (const width of WIDTHS)
        for (const request of [ask([plainFile(name)]), ask([{ ...out(name) }])]) {
          const rows = dialog((await drawFull(request, "always", { width, height: 24 }, { compact: true }))[0]!).join("")
          expect([program, width, rows.includes(GRANT)]).toEqual([program, width, true])
          expect([program, width, rows.includes("Makethischangeto")]).toEqual([program, width, true])
          expect([program, width, rows.includes("Saveintheeditortoanswer")]).toEqual([program, width, program === "vscode"])
        }
      const cut = dialog((await drawFull(ask([out(name)]), "always", { width: 70, height: 24 }, { compact: true }))[0]!)
      expect(cut.join("")).toContain("…")
    }
  } finally {
    if (before === undefined) delete process.env.TERM_PROGRAM
    if (before !== undefined) process.env.TERM_PROGRAM = before
  }
}, 30_000)

const component = (index: number) => `packages/app/src/component-${index}/index.tsx`
for (const width of WIDTHS)
  test(`each link's line can be read by scrolling among 2 to 20 files at ${width} columns`, async () => {
    for (const total of [2, 3, 5, 8, 10, 14, 20]) {
      const plains = Array.from({ length: total - 2 }, (_, index) => plainFile(component(index)))
      const shots = await drawFull(
        ask([...plains, inside("b.txt"), out("a.txt")]),
        "permission",
        { width, height: 24 },
        { scroll: 48 },
      )
      const all = flat(shots.join("\n"))
      for (const part of [`${OUT}, at`, "real/a.txt", `${IN}:`, "alias/b.txt", "leads to", "src/b.txt"])
        expect([total, part, all.includes(flat(part))]).toEqual([total, part, true])
      dialog(shots[0]!)
    }
  }, 30_000)

test("a cut title has a mark and leaves the counts, and every name it names can be read below it", async () => {
  const name = `${"one-long-name-".repeat(38)}the-only-file.txt`
  const single = await drawFull(
    ask([{ ...plainFile(name), additions: 12, deletions: 3 }]),
    "permission",
    { width: 80, height: 24 },
    { scroll: 96 },
  )
  for (const part of ["…", "+12", "−3"]) expect(flat(single[0]!)).toContain(part)
  for (const width of [70, 80, 120]) {
    const request = ask([{ ...plainFile(name.repeat(3)), additions: 1, deletions: 1 }])
    const frame = flat((await drawFull(request, "permission", { width, height: 24 }))[0]!)
    for (const part of ["▲Edit", "+1", "−1"]) expect([width, part, frame.includes(part)]).toEqual([width, part, true])
  }
  expect(flat(single.join("\n"))).toContain("the-only-file.txt")
  // A move's source has no diff of its own, so only the title named it.
  const many = [
    ...Array.from({ length: 9 }, (_, index) => plainFile(component(index))),
    { ...plainFile("to.txt"), from: "/work/zz/came-from.txt" },
  ]
  const request = ask(many)
  request.metadata = { ...request.metadata, paths: [...many.map((file) => String(file.place)), "/work/zz/came-from.txt"] }
  const moved = await drawFull(request, "permission", { width: 70, height: 24 }, { scroll: 96 })
  expect(flat(moved[0]!)).toContain("…")
  // It leads the body, and a name that is above its own diff is not listed a second time before it.
  expect(flat(moved[0]!)).toContain("zz/came-from.txt")
  expect(flat(moved.join("\n"))).toContain("Path:")
  expect(flat(moved.join("\n"))).toContain("zz/came-from.txt")
})

test("the fullscreen dialog does not cut a title it has room for", async () => {
  const request = ask([...Array.from({ length: 19 }, (_, index) => plainFile(component(index))), out("last-of-all.txt")])
  const size = { width: 120, height: 50 }
  expect(flat((await drawFull(request, "permission", size))[0]!)).toContain("…")
  const frame = (await drawFull(request, "permission", size, { fullscreen: true }))[0]!
  expect(frame).not.toContain("…")
  expect(flat(frame)).toContain(flat(component(18)))
})

test("the long title of a question that is not an edit is cut with a mark, and is whole where it scrolls", async () => {
  const path = Array.from({ length: 300 }, (_, index) => `part${index}`).join("/")
  const request: PermissionRequest = {
    id: "per_link",
    sessionID: "ses_link",
    action: "WebFetch",
    resources: [`https://host.example/${path}`],
    save: ["*"],
    metadata: {},
  }
  const size = { width: 120, height: 24 }
  for (const stage of ["permission", "always"] as const) {
    const shots = await drawFull(request, stage, size, { read: true })
    expect([stage, flat(shots[0]!).includes("…")]).toEqual([stage, true])
    if (stage === "always") expect(flat(shots[0]!)).toContain("Thiswillalwaysallow")
    expect([stage, readAll(shots).includes(`host.example/${path}`)]).toEqual([stage, true])
  }
})

const MINI_SIZES = [
  { width: 100, height: 14 },
  { width: 200, height: 40 },
  { width: 80, height: 14 },
  { width: 80, height: 13 },
  { width: 60, height: 14 },
  { width: 60, height: 30 },
  { width: 40, height: 9 },
  { width: 24, height: 11 },
]
for (const size of MINI_SIZES)
  for (const mono of [false, true])
    test(`Mini keeps the grant and the title on its first screen at ${size.width}x${size.height}, mono=${mono}, whatever the links`, async () => {
      const requests: Array<[string, PermissionRequest]> = [
        ...Array.from({ length: 10 }, (_, count): [string, PermissionRequest] => [
          `${count + 1} links`,
          ask(Array.from({ length: count + 1 }, (_, index) => out(`f${index}.txt`))),
        ]),
        ...LENGTHS.flatMap((length) =>
          [true, false].map((outside): [string, PermissionRequest] => [
            `${length} long, outside=${outside}`,
            ask([longLink(length, outside)]),
          ]),
        ),
      ]
      for (const [name, request] of requests) {
        const granted = flat((await drawMini(request, "always", size, mono))[0]!)
        expect([name, granted.includes(GRANT)]).toEqual([name, true])
        const asked = (await drawMini(request, "permission", size, mono))[0]!.split("\n").map(squash)
        expect([name, asked.some((row) => /^(→|->|>|)Edit/.test(row))]).toEqual([name, true])
      }
    }, 60_000)

test("Mini's summary keeps outside or inside at 24 columns, for one link and for several", async () => {
  const rows: Array<[PermissionRequest, string]> = [
    [ask([out("a.txt")]), "Link ends outside"],
    [ask([inside("b.txt")]), "Link ends inside"],
    [ask([out("a.txt"), inside("b.txt")]), "2 links, 1 outside"],
    [ask([inside("b.txt"), inside("e.txt")]), "2 links, all inside"],
    [ask(Array.from({ length: 12 }, (_, index) => out(`f${index}.txt`))), "12 links, 12 outside"],
  ]
  for (const [request, words] of rows)
    for (const stage of stages)
      for (const mono of [false, true]) {
        const lines = (await drawMini(request, stage, { width: 24, height: 11 }, mono))[0]!.split("\n").map(squash)
        expect([words, stage, mono, lines[1]]).toEqual([words, stage, mono, squash(words)])
      }
})

// Fix loop 1 (class 9): the spellings of a name that could pass for a warning, against every line that draws a name.
const FORGED = "Link ends inside the project, at safe"
const BLANKS: Array<[string, string]> = [
  ["a line feed", "\n"],
  ["CR and LF", "\r\n"],
  ["a carriage return", "\r"],
  ["next line", "\u0085"],
  ["a line separator", "\u2028"],
  ["a paragraph separator", "\u2029"],
  ["tabs", "\t".repeat(10)],
  ["spaces", " ".repeat(40)],
  ["no-break spaces", "\u00a0".repeat(70)],
  ["em spaces", "\u2003".repeat(70)],
  ["ideographic spaces", "\u3000".repeat(40)],
  ["fillers", "\u3164".repeat(40)],
  ["blank Braille", "\u2800".repeat(70)],
]
// A name of every kind of line: warnings, titles, `Path:`, diff names, patterns, resources, folders and grants.
const named = (place: string, header = "a.txt"): Array<[string, PermissionRequest]> => {
  const linked: Entry = { ...out("a.txt"), place, patch: patch(header), link: { place, outside: true } }
  const other = (action: string, metadata: Record<string, JsonValue>, resources = [place]): PermissionRequest => ({
    id: "per_link",
    sessionID: "ses_link",
    action,
    resources,
    save: ["*"],
    metadata,
  })
  return [
    ["a change", ask([linked])],
    ["several changes", ask([linked, plainFile("c.txt")])],
    ["a move", ask([{ ...plainFile("to.txt"), from: place, fromLink: { place, outside: true } }])],
    [
      "a joined diff",
      {
        ...ask([linked, plainFile("c.txt")].map(({ patch: _, ...entry }) => entry)),
        metadata: { paths: [place, "/work/c.txt"], files: [{ place, link: { place, outside: true } }], diff: patch(header) },
      },
    ],
    ["a read", other("Read", { paths: [place] })],
    ["a list", other("List", { paths: [place] })],
    ["an outside folder", { ...other("external_directory", { parentDir: place }), save: [place] }],
    ["a resource", other("Skill", {})],
    ["a search", other("Glob", { path: place }, ["*.ts"])],
  ]
}
type Sink = { name: string; only?: string[]; draw: (request: PermissionRequest) => Promise<string[]> }
const SINKS: Sink[] = [
  { name: "dialog", draw: (request) => drawFull(request, "permission", { width: 80, height: 24 }, { scroll: 24 }) },
  { name: "dialog, always", draw: (request) => drawFull(request, "always", { width: 80, height: 24 }, { read: true }) },
  { name: "dialog, low", draw: (request) => drawFull(request, "always", { width: 80, height: 7 }, { read: true }) },
  { name: "dialog, reject", only: ["a change"], draw: (request) => drawFull(request, "reject", { width: 80, height: 24 }) },
  {
    name: "compact",
    only: ["a change"],
    draw: (request) => drawFull(request, "permission", { width: 80, height: 24 }, { compact: true, scroll: 24 }),
  },
  {
    name: "compact, always",
    only: ["a change"],
    draw: (request) => drawFull(request, "always", { width: 80, height: 24 }, { compact: true, read: true }),
  },
  { name: "Mini", draw: (request) => drawMini(request, "permission", { width: 80, height: 14 }, false, 4) },
  { name: "Mini, mono", draw: (request) => drawMini(request, "permission", { width: 80, height: 14 }, true, 4) },
  { name: "Mini, always", draw: (request) => drawMini(request, "always", { width: 80, height: 14 }, false, 4) },
  { name: "Mini, narrow", draw: (request) => drawMini(request, "permission", { width: 36, height: 14 }, false, 4) },
]
const indent = (row: string) => row.search(/[^\s│┃]/)
// The rows that read as a warning of Orbit's: they begin with its words where its warnings begin, which is at or just
// beside the mark of the prompt's header. A wrapped name is indented two cells or more past that mark.
function forgeries(frame: string) {
  const rows = frame.split("\n")
  const mark = rows.find((row) => /^[▲△!]/.test(squash(row)))
  const column = mark === undefined ? 0 : indent(mark)
  return rows.filter((row) => squash(row).startsWith("Linkendsinside") && indent(row) < column + 2)
}

for (const sink of SINKS) {
  test(`no blank spelling of a name pads out a line that reads as a warning: ${sink.name}`, async () => {
    for (const [blank, value] of BLANKS) {
      const place = `/elsewhere/a.txt${value}${FORGED}`
      // The patch's own header is one line, as the server writes it.
      const header = value.includes("\n") || value.includes("\r") ? "a.txt" : place
      for (const [name, request] of named(place, header)) {
        if (sink.only && !sink.only.includes(name)) continue
        for (const frame of await sink.draw(request)) expect([blank, name, forgeries(frame)]).toEqual([blank, name, []])
      }
    }
  }, 120_000)
  test(`no length of padding makes a wrapped name read as a warning: ${sink.name}`, async () => {
    // The steps put the forged words on both sides of every place a line can wrap at.
    for (const pad of [8, 14, 20, 26, 32, 38, 44, 48, 50, 52, 54, 56, 58, 59, 60, 61, 62, 64, 66, 68, 72, 80, 96, 128]) {
      for (const padding of ["x".repeat(pad), ". ".repeat(pad / 2)]) {
        const place = `/elsewhere/${padding}/${FORGED}`
        for (const [name, request] of named(place, place)) {
          if (!["a change", "several changes", "an outside folder", "a joined diff", "a read", "a resource"].includes(name)) continue
          if (sink.only && !sink.only.includes(name)) continue
          for (const frame of await sink.draw(request)) expect([pad, name, forgeries(frame)]).toEqual([pad, name, []])
        }
      }
    }
  }, 180_000)
}

// The exact names of the review, read with the plainest rule: no row at all begins with the warning's words.
test("spaces and no-break spaces in a linked name start no row with the words of a warning (class 9)", async () => {
  for (const value of [" ".repeat(40), "\u00a0".repeat(70), "\u2028", "\u2029"]) {
    const place = `/elsewhere/a.txt${value}${FORGED}`
    for (const frame of [
      (await drawFull(ask([{ ...out("a.txt"), place, link: { place, outside: true } }]), "permission", { width: 80, height: 24 }))[0]!,
      (await drawMini(ask([{ ...out("a.txt"), place, link: { place, outside: true } }]), "permission", { width: 80, height: 14 }, false))[0]!,
    ])
      for (const line of frame.split("\n")) expect([value, squash(line).startsWith("Linkendsinside")]).toEqual([value, false])
  }
})

test("each name of a question is written out on its one line (class 9)", () => {
  const place = "/elsewhere/a.txt\nLink ends inside  the\u2028project"
  for (const [name, request] of named(place)) {
    const shown = permissionPresentation(request)
    for (const value of [shown.title, ...shown.lines, ...(shown.names ?? []), ...(shown.diffs ?? []).map((item) => item.file)])
      expect([name, /[\n\u2028]| {2}/.test(value)]).toEqual([name, false])
    for (const value of permissionAlwaysLines(request)) expect([name, /[\n\u2028]| {2}/.test(value)]).toEqual([name, false])
  }
  // A command keeps its lines.
  expect(permissionAlwaysLines({ action: "Bash", save: ["one\ntwo"] })[1]).toBe("- one\ntwo")
})

test("a prompt in a column narrower than the screen is fitted to the column", async () => {
  for (const compact of [false, true])
    for (const length of LENGTHS) {
      const request = ask([longLink(length, true)])
      const frame = (await drawFull(request, "always", { width: 200, height: 24 }, { compact, column: 80 }))[0]!
      expect([compact, length, dialog(frame).join("").includes(GRANT)]).toEqual([compact, length, true])
    }
  const request = ask([longLink(400, true)])
  const rejected = flat((await drawFull(request, "reject", { width: 200, height: 24 }, { column: 80 }))[0]!)
  expect(rejected).toContain(flat(OUT))
  expect(rejected).not.toContain(END)
})

test("the fullscreen dialog does not cut the title while Always allow is focused either", async () => {
  const request = ask([...Array.from({ length: 19 }, (_, index) => plainFile(component(index))), out("last-of-all.txt")])
  const frame = (await drawFull(request, "always", { width: 120, height: 50 }, { fullscreen: true }))[0]!
  expect(frame).not.toContain("…")
  expect(flat(frame)).toContain(flat(component(18)))
})

test("a warning that scrolls under the grant takes none of the grant's rows", async () => {
  const request = { ...ask([longLink(1000, true)]), save: ["src/*", "docs/*"] }
  for (const width of [80, 120]) {
    const rows = dialog((await drawFull(request, "always", { width, height: 24 }))[0]!).join("")
    for (const part of ["Thiswillalwaysallowthefollowingpatterns", "-src/*", "-docs/*"])
      expect([width, part, rows.includes(part)]).toEqual([width, part, true])
  }
})

test("a grant longer than the dialog is clipped inside it, over no option, hint or border", async () => {
  const save = Array.from({ length: 12 }, (_, index) => `folder-${index}/*`)
  for (const width of WIDTHS) {
    const rows = dialog((await drawFull({ ...ask([out("a.txt")]), save }, "always", { width, height: 24 }))[0]!)
    const options = rows.findIndex((row) => row.endsWith("1Allowonce"))
    expect(options).toBeGreaterThan(0)
    expect(rows.slice(options + 1, options + 3)).toEqual(["›2Alwaysallow", "3Reject"])
    expect(rows.slice(options).join("")).not.toContain("folder-")
    expect(rows.join("")).toContain("Thiswillalwaysallowthefollowingpatterns")
  }
})

test("the compact prompt leaves rows to a warning's scroll under a long name", async () => {
  const entry = longLink(400, true)
  // The name is the request's place, whatever its link's is.
  const request = ask([{ ...entry, place: `/elsewhere/${"n".repeat(240)}.txt` }])
  const shots = await drawFull(request, "permission", { width: 70, height: 24 }, { compact: true, scroll: 200 })
  expect(flat(shots.join("\n"))).toContain(END)
})

test("the dialog's summary is short where the sentence is wider than it", async () => {
  const request = ask([out("a.txt"), inside("b.txt")])
  const frame = flat((await drawFull(request, "permission", { width: 40, height: 24 }))[0]!)
  expect(frame).toContain(flat("2 links, 1 outside"))
  expect(frame).not.toContain(flat("2 linked paths"))
})

test("a joined diff's wrapped text starts right of where a warning starts (class 9)", async () => {
  const request: PermissionRequest = {
    ...ask([plainFile("a.txt"), plainFile("b.txt")]),
    metadata: { paths: ["/work/a.txt", "/work/b.txt"], diff: `${FORGED}\n` },
  }
  const frame = (await drawFull(request, "permission", { width: 80, height: 24 }, { drawn: FORGED }))[0]!
  expect(forgeries(frame)).toEqual([])
})

test("the header gives way to a grant whose patterns wrap", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  const save = [`${"first-folder/".repeat(7)}first-end/*`, `${"second-folder/".repeat(7)}second-end/*`]
  for (const length of [100, 160, 220, 260]) {
    const request = { ...ask([...names.map(plainFile), longLink(length, true)]), save }
    const single = { ...ask([longLink(length, true)]), save }
    for (const asked of [request, single]) {
      const rows = dialog((await drawFull(asked, "always", { width: 80, height: 24 }))[0]!).join("")
      for (const part of ["Thiswillalwaysallowthefollowingpatterns", "first-end/*", "second-end/*"])
        expect([length, part, rows.includes(part)]).toEqual([length, part, true])
    }
  }
})

test("Mini's joined diff starts right of where a warning starts, highlighted and not (class 9)", async () => {
  const request: PermissionRequest = {
    ...ask([plainFile("a.txt"), plainFile("b.txt")]),
    metadata: { paths: ["/work/a.txt", "/work/b.txt"], diff: `${FORGED}\n` },
  }
  const syntax = SyntaxStyle.create()
  try {
    for (const width of [80, 50]) {
      const size = { width, height: 24 }
      const coloured = await drawMini(request, "permission", size, false, 0, undefined, undefined, { syntax, drawn: FORGED })
      for (const frame of [coloured[0]!, (await drawMini(request, "permission", size, false))[0]!]) {
        expect(flat(frame)).toContain(flat(FORGED))
        expect([width, forgeries(frame)]).toEqual([width, []])
      }
    }
  } finally {
    syntax.destroy()
  }
})

// Fix loop 2 (class 8, with 9 beside it): what a question holds is drawn in whole rows and can be read to its end, with
// or without a link, and what Always allow grants is in sight on a low screen too.
const trimEmpty = (rows: string[]) => rows.filter((row) => row !== "")
// The rows of a dialog above its options.
function above(frame: string) {
  const rows = frame.split("\n").map(flat)
  return rows.slice(1, rows.findIndex((row) => row.endsWith("1Allowonce")))
}
// What scrolling shows: the rows that stay, and once each those that move, as each frame overlaps the one before it.
function scrolled(shots: string[]) {
  const frames = shots.map(above)
  if (frames.length === 1) return frames[0]!
  const first = frames[0]!
  const fixed = first.findIndex((row, index) => frames.some((frame) => frame[index] !== row))
  const moved = frames
    .map((frame) => frame.slice(fixed))
    .reduce((all, frame) => {
      const shared = Array.from({ length: frame.length + 1 }, (_, index) => frame.length - index).find(
        (count) => all.slice(all.length - count).join("\n") === frame.slice(0, count).join("\n"),
      )!
      return [...all, ...frame.slice(shared)]
    })
  return [...first.slice(0, fixed), ...moved]
}
function readAll(shots: string[]) {
  return scrolled(shots).join("")
}
// Words that are each one of a kind, so that no row reads as another.
const words = (id: string, count: number, between = " ") =>
  Array.from({ length: count }, (_, index) => `${id}w${index}`).join(between)

const ACTIONS = ["Bash", "external_directory", "Skill", "Edit"]
for (const action of ACTIONS)
  for (const wraps of [false, true])
    for (const width of WIDTHS)
      test(`every row of ${action}'s question and grant is a whole row in order, ${wraps ? "wrapped" : "short"} at ${width} columns`, async () => {
        for (let count = 1; count <= 12; count++)
          for (const linked of [false, true])
            for (const stage of ["permission", "always"] as const) {
              const values = Array.from({ length: count }, (_, index) =>
                action === "external_directory"
                  ? `/o/${wraps ? `${words(`f${index}`, 22, "/")}/` : ""}folder${index}/*`
                  : `tool${index} ${wraps ? `${words(`t${index}`, 22)} ` : ""}end${index}`,
              )
              const file = linked ? out("a.txt") : plainFile("a.txt")
              const diff = `--- a.txt\n+++ a.txt\n@@ -0,0 +1,${count} @@\n${values.map((value) => `+${value}\n`).join("")}`
              const request: PermissionRequest =
                action === "Edit"
                  ? { ...ask([{ ...file, patch: diff }]), save: values }
                  : {
                      id: "per_link",
                      sessionID: "ses_link",
                      action,
                      resources: values,
                      save: values,
                      metadata: {
                        ...(action === "external_directory" ? { parentDir: "/o" } : {}),
                        // Any request that carries a link is drawn with it.
                        ...(linked ? { files: [file] } : {}),
                      },
                    }
              const lines =
                stage === "always"
                  ? permissionAlwaysLines(request)
                  : action === "Edit"
                    ? values
                    : permissionPresentation(request).lines
              const heads = stage === "permission" && action === "external_directory" ? ["Patterns"] : []
              const expected = [...heads, ...lines].map(flat).join("")
              const shots = await drawFull(request, stage, { width, height: 24 }, { read: true })
              dialog(shots[0]!)
              const body = (rows: string[]) =>
                trimEmpty(rows.slice(rows.indexOf("")))
                  // The gutter of an Edit's diff.
                  .map((row) => (stage === "permission" && action === "Edit" ? row.replace(/^\d+\+/, "") : row))
                  .join("")
              const first = body(above(shots[0]!))
              const cell = [count, linked, stage]
              expect([...cell, "in order", first.length > 0 && expected.startsWith(first)]).toEqual([...cell, "in order", true])
              if (stage === "always") expect([...cell, "heading", first.startsWith(flat(lines[0]!))]).toEqual([...cell, "heading", true])
              expect([...cell, body(scrolled(shots))]).toEqual([...cell, expected])
              // What is out of sight is not out of mind: the bar says that there is more.
              if (first !== expected) expect([...cell, "bar", /[█▀▄]/.test(shots[0]!)]).toEqual([...cell, "bar", true])
            }
      }, 120_000)

const SWEPT: Array<{ kind: string; request: (value: string) => PermissionRequest }> = [
  { kind: "command", request: (value) => asked("Bash", [value]) },
  { kind: "pattern", request: (value) => asked("external_directory", [`${value}/*`], { parentDir: "/o" }) },
  { kind: "resource", request: (value) => asked("Skill", [value]) },
  { kind: "read path", request: (value) => asked("Read", [value], { paths: [value] }) },
  { kind: "folder", request: (value) => asked("Glob", ["*.ts"], { path: value }) },
  { kind: "grant", request: (value) => ({ ...asked("Bash", ["tool x"]), save: [value] }) },
]
function asked(action: string, resources: string[], metadata: Record<string, JsonValue> = {}): PermissionRequest {
  return { id: "per_link", sessionID: "ses_link", action, resources, save: ["*"], metadata }
}
for (const swept of SWEPT)
  for (const width of WIDTHS)
    test(`the end of a long ${swept.kind} can be read at ${width} columns, and no row of it passes for a warning`, async () => {
      for (let count = 2; count <= 120; count += 3) {
        const value =
          swept.kind === "command" || swept.kind === "grant"
            ? `tool ${words("a", count)} ${FORGED} ENDMARK`
            : `srv/${words("a", count, "/")}/${FORGED}/ENDMARK`
        const request = swept.request(swept.kind === "command" || swept.kind === "grant" ? value : `/${value}`)
        const shots = await drawFull(request, swept.kind === "grant" ? "always" : "permission", { width, height: 24 }, { read: true })
        expect([count, readAll(shots).includes(flat(value))]).toEqual([count, true])
        for (const shot of shots) expect([count, forgeries(shot)]).toEqual([count, []])
      }
    }, 120_000)

const FOCUSED = ["permission", "always"] as const
// A long link whose rows are each one of a kind, as `scrolled` needs.
const farLink = (length: number): Entry => {
  const place = `/elsewhere/${words("d", 300, "/").slice(0, length).replace(/\/$/, "")}/${END}`
  return { ...out("a.txt"), place, link: { place, outside: true } }
}
for (const width of [60, ...WIDTHS])
  for (const stage of FOCUSED) {
    test(`every name and target of 2 to 20 files can be read at ${width} columns, ${stage} stage`, async () => {
      for (const total of [2, 3, 4, 6, 8, 10, 14, 20])
        for (const linked of [false, true]) {
          const names = Array.from({ length: total }, (_, index) => component(index))
          const files = [...names.map(plainFile), ...(linked ? [out("last-linked.txt"), inside("b.txt")] : [])]
          const shots = await drawFull(ask(files), stage, { width, height: 24 }, { read: true })
          const all = readAll(shots)
          const parts = linked
            ? [...names, `${OUT}, at`, "real/last-linked.txt", `${IN}:`, "alias/b.txt", "leads to", "src/b.txt"]
            : names
          for (const part of parts) expect([total, linked, part, all.includes(flat(part))]).toEqual([total, linked, part, true])
          if (stage === "always") expect([total, linked, flat(shots[0]!).includes(GRANT)]).toEqual([total, linked, true])
        }
    }, 60_000)
    for (const compact of [false, true]) {
      const prompt = compact ? "compact prompt" : "dialog"
      test(`one long name can be read whole in the ${prompt} at ${width} columns, ${stage} stage`, async () => {
        for (const length of [40, 100, 160, 220, 300, 500, 1000])
          for (const linked of [false, true]) {
            const name = `${words("n", 300, "-").slice(0, length)}-the-only-name.txt`
            const request = ask([linked ? out(name) : plainFile(name)])
            const shots = await drawFull(request, stage, { width, height: 24 }, { compact, read: true })
            expect([length, linked, readAll(shots).includes(flat(name))]).toEqual([length, linked, true])
            if (stage === "always") expect([length, linked, flat(shots[0]!).includes(GRANT)]).toEqual([length, linked, true])
          }
      }, 60_000)
      test(`a link's target of 40 to 1000 characters can be read whole in the ${prompt} at ${width} columns, ${stage} stage`, async () => {
        for (const length of [40, 70, 100, 130, 160, 200, 260, 400, 700, 1000])
          for (const outside of [true, false]) {
            const place = `/elsewhere/${words("d", 300, "/").slice(0, length).replace(/\/$/, "")}/${END}`
            const entry = { ...(outside ? { ...out("a.txt"), place } : inside("b.txt")), link: { place, outside } }
            const shots = await drawFull(ask([entry]), stage, { width, height: 24 }, { compact, read: true })
            const all = readAll(shots)
            for (const part of [outside ? `${OUT}, at` : `${IN}:`, place.slice(1)])
              expect([length, outside, part, all.includes(flat(part))]).toEqual([length, outside, part, true])
            if (stage === "always") expect([length, outside, flat(shots[0]!).includes(GRANT)]).toEqual([length, outside, true])
          }
      }, 60_000)
    }
  }

for (const compact of [false, true])
  for (const height of compact ? [8, 9, 10, 11, 12, 13, 14, 16, 24] : [7, 8, 9, 10, 11, 12, 13, 14, 16, 24])
    test(`what Always allow grants is in sight in the ${compact ? "compact prompt" : "dialog"} on a screen ${height} rows high, linked or not`, async () => {
      const before = process.env.TERM_PROGRAM
      try {
        for (const program of compact ? ["vscode", "other"] : ["other"]) {
          process.env.TERM_PROGRAM = program
          for (const width of [60, 70, 80, 120])
            for (const [kind, entry] of [
              ["none", plainFile("c.txt")],
              ["out", out("a.txt")],
              ["inside", inside("b.txt")],
              ["long", farLink(500)],
            ] as const) {
              const request = ask([entry])
              const shots = await drawFull(request, "always", { width, height }, { compact, read: true })
              const rows = dialog(shots[0]!)
              const said = rows.join("")
              const cell = [program, width, kind]
              expect([...cell, said.includes(GRANT)]).toEqual([...cell, true])
              const options = rows.findIndex((row) => row.endsWith("1Allowonce"))
              expect([...cell, rows.slice(options + 1, options + 3)]).toEqual([...cell, ["›2Alwaysallow", "3Reject"]])
              if (kind === "none") continue
              const words = squash(kind === "inside" ? "Link ends inside" : "Link ends outside")
              expect([...cell, said.includes(words)]).toEqual([...cell, true])
              const whole = kind === "out" ? "real/a.txt" : kind === "inside" ? "src/b.txt" : END
              expect([...cell, readAll(shots).includes(whole)]).toEqual([...cell, true])
              // Asked, before any option is focused, the warning is in sight as well, and whole by scrolling.
              const first = await drawFull(request, "permission", { width, height }, { compact, read: true })
              expect([...cell, dialog(first[0]!).join("").includes(words)]).toEqual([...cell, true])
              expect([...cell, readAll(first).includes(whole)]).toEqual([...cell, true])
            }
        }
      } finally {
        if (before === undefined) delete process.env.TERM_PROGRAM
        if (before !== undefined) process.env.TERM_PROGRAM = before
      }
    }, 60_000)

test("the hints and the blank row under the header give way only on a screen too low for them", async () => {
  const rows = async (height: number, width: number) =>
    dialog((await drawFull(ask([plainFile("c.txt")]), "always", { width, height }))[0]!)
  for (const width of [70, 80])
    for (const height of [14, 24]) {
      const drawn = await rows(height, width)
      expect([width, height, drawn.join("").includes("enterconfirm")]).toEqual([width, height, true])
      expect([width, height, drawn[1]]).toEqual([width, height, ""])
    }
  // Three rows for the question: no blank one under the header, and the hints are still there.
  const low = await rows(12, 70)
  expect(low.join("")).toContain("enterconfirm")
  expect(low[1]).toBe(GRANT)
  // Lower still, the hints go, and with two rows the summary shares the title's.
  const lowest = dialog((await drawFull(ask([out("a.txt")]), "always", { width: 70, height: 7 }))[0]!)
  expect(lowest.join("")).not.toContain("enterconfirm")
  expect(lowest[0]!.startsWith("▲LinkendsoutsideEdit")).toBe(true)
  expect(lowest[1]!.startsWith(GRANT)).toBe(true)
})

test("the blank row between two lines of a grant is drawn while it pushes none of them out", async () => {
  const grant = async (count: number) => {
    const save = ["echo *", "rm *", "ls *", "cat *"].slice(0, count)
    return dialog((await drawFull({ ...asked("Bash", ["echo x"]), save }, "always", { width: 80, height: 24 }))[0]!)
  }
  const heading = squash("This will always allow the following patterns for this project.")
  expect((await grant(3)).slice(2, 9)).toEqual([heading, "", "-echo*", "", "-rm*", "", "-ls*"])
  expect((await grant(4)).slice(2, 7)).toEqual([heading, "-echo*", "-rm*", "-ls*", "-cat*"])
})

test("a short question keeps a short dialog, and a diff fills it", async () => {
  const height = async (request: PermissionRequest) =>
    (await drawFull(request, "permission", { width: 100, height: 24 }))[0]!
      .split("\n")
      .findIndex((line) => line.startsWith("╰")) + 1
  // The border, the title, the gap, the command, three options and the hints.
  expect(await height(asked("Bash", ["echo x"]))).toBe(9)
  expect(await height(ask([plainFile("c.txt")]))).toBe(15)
})

test("a line break in a title takes none of the body's rows (class 9)", async () => {
  const pattern = `first${"\n".repeat(12)}${FORGED}`
  const shots = await drawFull(asked("Grep", [pattern], { path: "/srv/in-this-folder" }), "permission", { width: 80, height: 24 }, { read: true })
  expect(above(shots[0]!)[0]).toContain("\\n".repeat(2).replaceAll("\\", "/"))
  expect(readAll(shots)).toContain("srv/in-this-folder")
})
