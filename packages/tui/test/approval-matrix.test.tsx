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
// The calling tool's input also spells the change itself (old_string, new_string, content, patchText), and here it spells
// a change other than the one the request carries: a client that built a diff from it would draw a decoy.
const decoyChange = { old_string: "DECOY-OLD", new_string: "DECOY-NEW", content: "DECOY-CONTENT", patchText: "DECOY-PATCH" }
const instantiate = (row: Row): Row => {
  const result: Row = JSON.parse(
    JSON.stringify(row)
      .replaceAll("{project}", world.project)
      .replaceAll("{outsideName}", world.outsideName)
      .replaceAll("{outside}", world.outside),
  )
  return { ...result, input: { ...result.input, ...decoyChange } }
}
// What a rule matches on a command or a search, which a person must see to approve it.
const resourcesOf = (row: Row) =>
  ["Bash", "PowerShell", "Glob", "Grep", "read_mcp_resource", "list_mcp_resources", "Skill"].includes(row.tool) ? row.request.resources.filter((item) => item !== "*") : []
const patchesOf = (row: Row) => ((row.request.metadata?.files ?? []) as { patch: string }[]).map((file) => file.patch)

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

// The input's own spelling of the file, when it names another place than the request does (a link, a spelling that
// leads elsewhere): read lexically against the project, as a person reading the prompt would. Whatever a client draws
// outside the raw input must not contain it, so a title built from the input rather than the request fails here.
// JSON doubles a backslash, so both spellings are folded to one slash.
const slashed = (value: string) => value.replaceAll("\\\\", "/").replaceAll("\\", "/").toLowerCase()
const lexicalOf = (raw: string) =>
  slashed(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(world.project, raw))
const misleading = (row: Row) => {
  const raw = [row.input.file_path, row.input.notebook_path, row.input.path].find(
    (item): item is string => typeof item === "string" && !item.includes("DECOY"),
  )
  if (raw === undefined) return undefined
  const lexical = lexicalOf(raw)
  return (row.truth.places ?? []).some((place) => slashed(path.resolve(place)) === lexical) ? undefined : raw
}
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
  expect([...tools].sort()).toEqual([
    "Edit",
    "LSP",
    "NotebookEdit",
    "Patch",
    "Patch (add over)",
    "Patch (move onto)",
    "Patch (move)",
    "Read",
    "Write",
  ])
  const spellings = new Set(golden.map((row) => row.id.split("/")[1]))
  for (const name of ["relative path", "absolute path", "dot-dot path", "absolute path outside", "tilde path", "link"])
    expect(spellings.has(name)).toBe(true)
  expect(golden.some((row) => row.id.endsWith("/trusted"))).toBe(true)
  expect(golden.some((row) => row.id.endsWith("/untrusted"))).toBe(true)
  // Rows whose own spelling leads somewhere else than the request's place exist, or the check above is vacuous.
  expect(golden.filter((row) => misleading(row) !== undefined).length).toBeGreaterThan(0)
  // The control: every row's input carries the decoys, so a client that read it would show one.
  for (const row of golden) expect(text(row.input)).toContain("DECOY")
})

for (const row of rows)
  test(`the terminal UI's prompt for ${row.id} shows the request's values and no decoy`, () => {
    const shown = text(present(row))
    expect(shown).not.toContain("DECOY")
    const own = misleading(row)
    if (own !== undefined) {
      expect(slashed(shown)).not.toContain(slashed(own))
      expect(slashed(shown)).not.toContain(lexicalOf(own))
    }
    for (const place of row.truth.places ?? []) expect(shown).toContain(place)
    if (row.truth.folder) expect(shown).toContain(row.truth.folder)
    if (row.truth.url) expect(shown).toContain(row.truth.url)
    if (row.truth.method && row.truth.method !== "GET") expect(shown).toContain(row.truth.method)
    if (row.truth.arguments) expect(shown).toContain(JSON.stringify(row.truth.arguments).slice(1, -1))
    for (const resource of resourcesOf(row)) expect(shown).toContain(JSON.stringify(resource).slice(1, -1))
    // The diffs drawn are the request's patches, one per file, and no other.
    const drawn = present(row)
    expect(drawn.diffs?.map((item) => item.diff) ?? (drawn.diff ? [drawn.diff] : [])).toEqual(patchesOf(row))
    // A moved file shows its source as well as its destination.
    for (const file of (row.request.metadata?.files ?? []) as { from?: string }[])
      if (file.from) expect(shown).toContain(file.from)
  })

for (const row of rows)
  test(`Mini's presentation for ${row.id} is the same values, as text and as mono`, () => {
    for (const mono of [false, true]) {
      const shown = text(permissionInfo(request(row), undefined, mono))
      expect(shown).not.toContain("DECOY")
      const own = misleading(row)
      if (own !== undefined) {
      expect(slashed(shown)).not.toContain(slashed(own))
      expect(slashed(shown)).not.toContain(lexicalOf(own))
    }
      for (const place of row.truth.places ?? []) expect(shown).toContain(toolPath(place, { home: true }))
      if (row.truth.folder) expect(shown).toContain(toolPath(row.truth.folder, { home: true }))
      if (row.truth.url) expect(shown).toContain(row.truth.url)
      if (row.truth.arguments) expect(shown).toContain(JSON.stringify(row.truth.arguments).slice(1, -1))
      for (const resource of resourcesOf(row)) expect(shown).toContain(JSON.stringify(resource).slice(1, -1))
      // As text the diffs are drawn on their own; as mono they lead the lines.
      const info = permissionInfo(request(row), undefined, mono)
      const diffs = mono ? info.lines.slice(0, patchesOf(row).length) : (info.diffs?.map((item) => item.diff) ?? (info.diff ? [info.diff] : []))
      if (patchesOf(row).length > 0) expect(diffs).toEqual(patchesOf(row))
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
        for (const resource of resourcesOf(row)) expect(frame).toContain(resource)
        // Every changed line of the request's patches is on the screen, as the changed text, and no decoy change is.
        if (!mono)
          for (const patch of patchesOf(row))
            for (const line of patch.split("\n"))
              if (/^[+-](?![+-])/.test(line) && line.slice(1).trim() !== "") expect(frame).toContain(line.slice(1).trim())
      } finally {
        app.renderer.destroy()
      }
    }
  })
}

// The model picks the order of an MCP call's arguments, so the value that matters can come after a long one. The argument
// text is whole in the presentation and on Mini's screen.
const longArguments: Row = {
  id: "MCP/long-arguments",
  tool: "mcp__chat__post",
  input: {},
  request: {
    action: "mcp__chat__post",
    resources: ["*"],
    metadata: { arguments: { note: "x".repeat(2100), channel: "#leak-HIDDEN", text: "secrets" } },
  },
  truth: {},
}
test("an MCP call's arguments are shown whole by the presentation and by Mini, whatever comes first", async () => {
  expect(text(present(longArguments))).toContain("#leak-HIDDEN")
  expect(text(present(longArguments))).not.toContain("more characters")
  expect(text(permissionInfo(request(longArguments), undefined, true))).toContain("#leak-HIDDEN")
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={request(longArguments)}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        mono={false}
        onReply={() => {}}
      />
    ),
    { width: 200, height: 60 },
  )
  try {
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()
    expect(app.captureCharFrame().replace(/\s+/g, "")).toContain("#leak-HIDDEN")
  } finally {
    app.renderer.destroy()
  }
})
