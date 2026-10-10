// "What is shown is what runs", VS Code's half. The rows are the requests the tools really asked
// (`packages/core/test/fixture/approval-matrix.json`, pinned by `packages/core/test/approval-values.test.ts`) plus the
// requests of the tools whose rows core pins in their own tests. Each becomes the chat item the extension builds and the
// card the webview draws. The card shows the request's places, files, method, URL and arguments, and nothing from the
// calling tool's input, which the item does not even carry (class 8, class 14).
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { permissionItem } from "../src/controller"
import { approvalCard } from "../src/webview/approval"

type Row = {
  id: string
  tool: string
  input: Record<string, unknown>
  request: { action: string; resources: string[]; metadata?: Record<string, unknown> }
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
const rows = [...(await load("approval-matrix.json")), ...(await load("approval-matrix-pinned.json"))]

for (const row of rows)
  test(`the VS Code card for ${row.id} shows the request's values and no decoy`, () => {
    const item = permissionItem({
      id: "per_matrix",
      sessionID: "ses_matrix",
      action: row.request.action,
      resources: row.request.resources,
      metadata: row.request.metadata,
    })
    // The item carries the request's values and never the calling tool's input.
    expect(JSON.stringify(item)).not.toContain("DECOY")
    const card = approvalCard(item)
    const shown = JSON.stringify(card)
    expect(shown).not.toContain("DECOY")
    for (const place of row.truth.places ?? []) expect(shown).toContain(place)
    if (row.truth.folder) expect(shown).toContain(row.truth.folder)
    if (row.truth.url) expect(shown).toContain(row.truth.url)
    if (row.truth.method && row.truth.method !== "GET") expect(shown).toContain(row.truth.method)
    if (row.truth.arguments) expect(shown).toContain(JSON.stringify(row.truth.arguments).slice(1, -1))
    for (const file of (row.request.metadata?.files ?? []) as { from?: string }[])
      if (file.from) expect(shown).toContain(file.from)
  })

test("the matrix reaches every request kind the card draws", () => {
  expect(rows.some((row) => row.truth.folder)).toBe(true)
  expect(rows.some((row) => row.truth.url)).toBe(true)
  expect(rows.some((row) => row.truth.arguments)).toBe(true)
  expect(rows.some((row) => (row.request.metadata?.files as unknown[] | undefined)?.length)).toBe(true)
})
