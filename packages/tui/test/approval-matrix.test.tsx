/** @jsxImportSource @opentui/solid */
// "What is shown is what runs", the terminal UI's and Mini's half. The rows are the requests the tools really asked
// (`packages/core/test/fixture/approval-matrix.json`, pinned by `packages/core/test/approval-values.test.ts`), each with
// the calling tool's input as the model wrote it, decoy keys included, plus the requests of the tools whose rows are
// pinned by their own core tests (Glob, Grep, Bash, WebFetch, MCP). Mini is drawn as the real component; the session
// route's prompt reads the same presentation. A client that shows a place, file, method, URL or arguments other than
// the request's, or a decoy the model added, fails here (class 8, class 14).
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JsonValue } from "@orbit/client/promise"
import { RunPermissionBody } from "../src/mini/footer.permission"
import { permissionInfo } from "../src/mini/permission.shared"
import { RUN_THEME_FALLBACK, RUN_THEME_MONO } from "../src/mini/theme"
import { toolPath } from "../src/mini/tool"
import type { MiniPermissionRequest } from "../src/mini/types"
import { permissionPresentation } from "../src/util/permission"
import { canonicalToolPart } from "./mini/fixture/tool-part"

type Json = Record<string, JsonValue>
type Row = {
  id: string
  tool: string
  input: Json
  request: { action: string; resources: string[]; metadata?: Json }
  truth: { places?: string[]; folder?: string; method?: string; url?: string; arguments?: string }
}

const home = os.tmpdir().replaceAll("\\", "/")
const world = { project: `${home}/matrix-project`, outside: `${home}/matrix-outside`, outsideName: "matrix-outside" }
const instantiate = (row: Row): Row =>
  JSON.parse(
    JSON.stringify(row)
      .replaceAll("{project}", world.project)
      .replaceAll("{outsideName}", world.outsideName)
      .replaceAll("{outside}", world.outside),
  )

const fixture = path.join(import.meta.dir, "../../core/test/fixture")
const load = async (name: string) => ((await Bun.file(path.join(fixture, name)).json()) as Row[]).map(instantiate)
const golden = await load("approval-matrix.json")
// The requests of the tools whose rows core pins in their own tests (Glob and Grep, Bash and PowerShell, WebFetch, an
// MCP call through Code Mode): each row names the test that pins its request.
const others = await load("approval-matrix-pinned.json")
const rows = [...golden, ...others]

const present = (row: Row) =>
  permissionPresentation({
    action: row.request.action,
    resources: row.request.resources,
    metadata: row.request.metadata,
    input: row.input,
    toolMetadata: {},
    tool: row.tool,
  })

const text = (value: unknown) => JSON.stringify(value)
const request = (row: Row): MiniPermissionRequest => ({
  id: "per_matrix",
  sessionID: "ses_matrix",
  action: row.request.action,
  resources: row.request.resources,
  metadata: row.request.metadata,
  save: ["*"],
  tool: canonicalToolPart(row.tool, { status: "running", input: row.input, metadata: {} }, "call-matrix"),
})

test("the matrix has every tool, every spelling and both trust states", () => {
  const tools = new Set(golden.map((row) => row.id.split("/")[0]))
  expect([...tools].sort()).toEqual(["Edit", "LSP", "NotebookEdit", "Patch", "Patch (move)", "Read", "Write"])
  const spellings = new Set(golden.map((row) => row.id.split("/")[1]))
  for (const name of ["relative path", "absolute path", "dot-dot path", "absolute path outside", "tilde path", "link"])
    expect(spellings.has(name)).toBe(true)
  expect(golden.some((row) => row.id.endsWith("/trusted"))).toBe(true)
  expect(golden.some((row) => row.id.endsWith("/untrusted"))).toBe(true)
  // The control: every row's input carries the decoys, so a client that read it would show one.
  for (const row of golden) expect(text(row.input)).toContain("DECOY")
})

for (const row of rows)
  test(`the terminal UI's prompt for ${row.id} shows the request's values and no decoy`, () => {
    const shown = text(present(row))
    expect(shown).not.toContain("DECOY")
    for (const place of row.truth.places ?? []) expect(shown).toContain(place)
    if (row.truth.folder) expect(shown).toContain(row.truth.folder)
    if (row.truth.url) expect(shown).toContain(row.truth.url)
    if (row.truth.method && row.truth.method !== "GET") expect(shown).toContain(row.truth.method)
    if (row.truth.arguments) expect(shown).toContain(JSON.stringify(row.truth.arguments).slice(1, -1))
    // A moved file shows its source as well as its destination.
    for (const file of (row.request.metadata?.files ?? []) as { from?: string }[])
      if (file.from) expect(shown).toContain(file.from)
  })

for (const row of rows)
  test(`Mini's presentation for ${row.id} is the same values, as text and as mono`, () => {
    for (const mono of [false, true]) {
      const shown = text(permissionInfo(request(row), undefined, mono))
      expect(shown).not.toContain("DECOY")
      for (const place of row.truth.places ?? []) expect(shown).toContain(toolPath(place, { home: true }))
      if (row.truth.folder) expect(shown).toContain(toolPath(row.truth.folder, { home: true }))
      if (row.truth.url) expect(shown).toContain(row.truth.url)
      if (row.truth.arguments) expect(shown).toContain(JSON.stringify(row.truth.arguments).slice(1, -1))
    }
  })

// The real component, drawn: a place that is shown is on the screen, and so is no decoy.
for (const row of rows.filter((item, index) => index % 4 === 0 || !item.id.startsWith("Edit"))) {
  test(`Mini draws the prompt for ${row.id} from the request`, async () => {
    for (const mono of [false, true]) {
      const app = await testRender(
        () => (
          <RunPermissionBody
            request={request(row)}
            theme={mono ? RUN_THEME_MONO.footer : RUN_THEME_FALLBACK.footer}
            block={mono ? RUN_THEME_MONO.block : RUN_THEME_FALLBACK.block}
            mono={mono}
            onReply={() => {}}
          />
        ),
        { width: 200, height: 40 },
      )
      try {
        await app.renderOnce()
        await Bun.sleep(0)
        await app.renderOnce()
        const frame = app.captureCharFrame()
        expect(frame).toContain("Permission required")
        expect(frame).not.toContain("DECOY")
        const expected = [...(row.truth.places ?? []), ...(row.truth.folder ? [row.truth.folder] : [])]
        for (const place of expected) expect(frame).toContain(toolPath(place, { home: true }))
        if (row.truth.url) expect(frame).toContain(row.truth.url)
      } finally {
        app.renderer.destroy()
      }
    }
  })
}
