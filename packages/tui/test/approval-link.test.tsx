/** @jsxImportSource @opentui/solid */
// m5-link-warning: every stage of the terminal UI's and Mini's approval of a file change says where a link leads, from
// the request alone (class 8), written out (class 9). Each is the real component, drawn and read from the screen. A
// list that is cut or scrolled never hides that a warning exists: the fixed line is above whatever the request can
// make tall, and every linked file's own line can be reached by scrolling.
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import type { PermissionRequest } from "@orbit/client"
import type { JsonValue } from "@orbit/client/promise"
import { parseColor, type CapturedFrame, type RGBA } from "@opentui/core"
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
    compact?: boolean
    fullscreen?: boolean
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
            <box width="100%" height={options.fullscreen ? "100%" : undefined}>
              <PermissionPrompt request={request} />
            </box>
          }
        >
          <EditorDiffPrompt request={request} editor="Test Editor" onSelect={() => {}} />
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
    await Bun.sleep(0)
    await app.renderOnce()
    const shots = [app.captureCharFrame()]
    options.painted?.(app.captureSpans(), colors!.warning, colors!.text)
    for (let step = 0; step < (options.scroll ?? 0); step++) {
      // The wheel over each row of the body, whichever row the list starts on.
      await app.mockMouse.scroll(10, 4 + (step % 8), "down")
      await app.renderOnce()
      shots.push(app.captureCharFrame())
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
            block={theme.block}
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

test("Mini still says a warning exists on a screen too narrow for the sentence, which it cuts in the middle", async () => {
  for (const stage of stages) {
    const frame = flat((await drawMini(ask([out("a.txt")]), stage, { width: 24, height: 11 }, false))[0]!)
    expect([stage, frame.includes("Linkends")]).toEqual([stage, true])
    // The middle is what is cut, with a mark where it was.
    expect([stage, frame.includes("Linkends...theproject")]).toEqual([stage, true])
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

test("the title is cut only while Always allow is focused", async () => {
  const names = Array.from({ length: 8 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  const request = ask([...names.map(plainFile), out("last.txt")])
  const size = { width: 120, height: 40 }
  // The seventh name is past the three rows, and within those that the dialog has for a title.
  const seventh = flat(`${names[6]}`)
  expect(flat((await drawFull(request, "permission", size))[0]!)).toContain(seventh)
  expect(flat((await drawFull(request, "always", size))[0]!)).not.toContain(seventh)
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
            // Several are counted on the fixed line and named in the body.
            expect([several, compact, stage, drawn.length]).toEqual([several, compact, stage, several && stage === "permission" ? 3 : 1])
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

test("a title that names many files keeps three rows while Always allow is focused", async () => {
  const names = Array.from({ length: 18 }, (_, index) => `${"long-folder-name-".repeat(3)}${index}.txt`)
  for (const width of [120, 80]) {
    const frame = (await drawFull(ask([...names.map(plainFile), out("last.txt")]), "always", { width, height: 40 }))[0]!
    const rows = frame.split("\n").map(squash)
    const title = rows.findIndex((row) => row.startsWith("▲"))
    expect([width, title !== -1]).toEqual([width, true])
    expect([width, rows.slice(title).indexOf("")]).toEqual([width, 3])
  }
})
