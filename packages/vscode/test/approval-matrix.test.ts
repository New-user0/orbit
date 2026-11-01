// "What is shown is what runs", VS Code's half. The rows are the requests the tools really asked
// (`packages/core/test/fixture/approval-matrix.json`, pinned by `packages/core/test/approval-values.test.ts`) plus the
// requests of the tools whose rows core pins in their own tests. Each becomes the chat item the extension builds and the
// card the webview draws. The card shows the request's places, files, method, URL and arguments, and nothing from the
// calling tool's input, which the item does not even carry (class 8, class 14).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, expect, test } from "bun:test"
import { permissionItem } from "../src/controller"
import { approvalCard } from "../src/webview/approval"
import { excerpt } from "../src/webview/present"

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
    // What a rule matches on a command or a search is on the card, beside the folder: the command is what a person approves.
    if (["Bash", "PowerShell", "Glob", "Grep", "read_mcp_resource", "list_mcp_resources", "Skill"].includes(row.tool))
      for (const resource of row.request.resources.filter((item) => item !== "*"))
        expect(shown).toContain(JSON.stringify(resource).slice(1, -1))
    // The diff is the request's patch of each file, and the lines drawn for it are that patch's changed lines.
    const patches = ((row.request.metadata?.files ?? []) as { patch: string }[]).map((file) => file.patch)
    expect(item.files.map((file) => file.patch)).toEqual(patches)
    expect(item.files.flatMap((file) => excerpt(file.patch, 6))).toEqual(patches.flatMap((patch) => excerpt(patch, 6)))
    for (const line of item.files.flatMap((file) => excerpt(file.patch, 6))) expect(line.text).not.toContain("DECOY")
  })

const cardOf = (request: Row["request"]) =>
  approvalCard(permissionItem({ id: "per_card", sessionID: "ses_card", ...request }))

test("a shell approval names its command and its folder, a search its pattern and its folder", () => {
  const shell = cardOf({ action: "Bash", resources: ["rm -rf ~/important"], metadata: { workdir: "/home/u/project" } })
  expect(shell.title).toContain("rm -rf ~/important")
  expect(shell.lines.join("\n")).toContain("rm -rf ~/important")
  expect(shell.lines).toContain("Folder: /home/u/project")
  const search = cardOf({ action: "Grep", resources: ["needle"], metadata: { path: "/home/u/project" } })
  expect(search.lines.join("\n")).toContain("needle")
  expect(search.lines).toContain("Folder: /home/u/project")
})

test("the card writes out the characters that reorder or hide text", () => {
  const card = cardOf({
    action: "mcp__chat__post",
    resources: ["*"],
    metadata: { arguments: { text: "safe‮/etc/passwd\u001b[2K" } },
  })
  expect(JSON.stringify(card)).not.toContain("‮")
  expect(JSON.stringify(card)).not.toContain("\u001b")
  expect(card.lines.join("\n")).toContain("\\u{202e}")
})

test("the card writes out those characters in the changed lines of a diff too", () => {
  const card = approvalCard(
    permissionItem({
      id: "per_diff",
      sessionID: "ses_diff",
      action: "edit",
      resources: ["a.ts"],
      metadata: {
        files: [{ file: "a.ts", place: "/p/a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+safe‮gpj.exe\u001b[2K\n" }],
      },
    }),
  )
  expect(card.changes.length).toBe(2)
  expect(JSON.stringify(card.changes)).not.toContain("‮")
  expect(JSON.stringify(card.changes)).not.toContain("\u001b")
  expect(card.changes[1]?.text).toContain("\\u{202e}")
})

test("the card shows every argument of an MCP call, including the ones after a long value", () => {
  const card = cardOf({
    action: "mcp__chat__post",
    resources: ["*"],
    metadata: { arguments: { note: "x".repeat(2100), channel: "#leak-HIDDEN", text: "secrets" } },
  })
  expect(card.lines.join("\n")).toContain("#leak-HIDDEN")
})

test("the matrix reaches every request kind the card draws", () => {
  expect(rows.some((row) => row.truth.folder)).toBe(true)
  expect(rows.some((row) => row.truth.url)).toBe(true)
  expect(rows.some((row) => row.truth.arguments)).toBe(true)
  expect(rows.some((row) => (row.request.metadata?.files as unknown[] | undefined)?.length)).toBe(true)
})

// The VS Code diff of each request: the review reads only the request's own `place` and `from`, never a path the tool's
// input names, and only when its real path is inside the session's folder and the window's; a place outside is shown on
// the card only (classes 4 and 8). The review module is imported when these rows run, so the rows above keep passing on
// a base without it.
type ReviewDisk = {
  realpath(file: string): Promise<string>
  lstat(file: string): Promise<unknown>
  readFile(file: string): Promise<Uint8Array>
}
const reviewRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-matrix-review-")))
const reviewWorld = {
  project: path.join(reviewRoot, "matrix-project").replaceAll("\\", "/"),
  outside: path.join(reviewRoot, "matrix-outside").replaceAll("\\", "/"),
}
for (const folder of [reviewWorld.project, reviewWorld.outside])
  for (const name of ["file.txt", "file.ipynb", "src/file.txt", "src/file.ipynb"])
    await Bun.write(path.join(folder, name), "alpha\n")
afterAll(() => fs.rm(reviewRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
const reviewRows = rows.map(
  (row): Row =>
    JSON.parse(
      JSON.stringify(row).replaceAll(world.project, reviewWorld.project).replaceAll(world.outside, reviewWorld.outside),
    ),
)

for (const row of reviewRows)
  test(`the VS Code diff for ${row.id} reads only the request's place and from, and an outside place is shown as text`, async () => {
    const module = await import(`../src/${"review"}.ts`)
    const disk: ReviewDisk = module.disk
    const touched: string[] = []
    const reads: string[] = []
    const recorder: ReviewDisk = {
      realpath: (file) => (touched.push(file), disk.realpath(file)),
      lstat: (file) => (touched.push(file), disk.lstat(file)),
      readFile: (file) => (reads.push(file), disk.readFile(file)),
    }
    const tabs: Array<{ title: string }> = []
    const host = {
      reply: async () => "sent" as const,
      folders: async () => ({ folders: [reviewWorld.project] }),
      workspace: () => [reviewRoot],
      show: async (tab: { title: string }) => void tabs.push(tab),
      changes: async () => {},
      close: async () => {},
      note: () => {},
      warn: () => {},
    }
    const item = permissionItem({ id: "per_matrix", sessionID: "ses_matrix", ...row.request })
    await new module.Review(host, recorder).open(item, true)

    expect([...touched, ...reads].filter((file) => file.includes("DECOY"))).toEqual([])
    // What is read is the request's own place, or where its move came from, and only inside the project.
    const project = await fs.realpath(reviewWorld.project)
    const allowed = await Promise.all(
      item.files
        .flatMap((file) => [file.place, file.from])
        .filter((file): file is string => file !== undefined)
        // A file the move has not made yet is named by its folder's real path.
        .map((file) =>
          fs.realpath(file).catch(async () => path.join(await fs.realpath(path.dirname(file)), path.basename(file))),
        ),
    )
    for (const file of reads) {
      expect(allowed).toContain(file)
      expect(path.relative(project, file).startsWith("..")).toBe(false)
    }
    // Every file outside the project is shown on the card only, and a request with no files touches nothing.
    const outside = item.files.filter((file) =>
      [file.place, file.from].some((place) => place?.startsWith(reviewWorld.outside)),
    )
    if (outside.length === item.files.length) expect(tabs).toEqual([])
    if (item.files.length === 0) expect([touched, reads, tabs]).toEqual([[], [], []])
  })

test("the VS Code diff rows reach files inside and outside the project", () => {
  const files = reviewRows.flatMap((row) => (row.request.metadata?.files ?? []) as Array<{ place?: string }>)
  expect(files.some((file) => file.place?.startsWith(`${reviewWorld.project}/src`))).toBe(true)
  expect(files.some((file) => file.place?.startsWith(reviewWorld.outside))).toBe(true)
})
