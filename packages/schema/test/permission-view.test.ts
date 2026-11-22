import { expect, test } from "bun:test"
import { PermissionView } from "../src/permission-view.js"

// The view reads a permission request and nothing else: the places, files, method, URL and arguments an approval shows.

test("places come from the paths the server resolved, over a single path and over the resources", () => {
  expect(
    PermissionView.of({ action: "Edit", resources: ["rel.txt"], metadata: { paths: ["/abs/a.txt", "/abs/b.txt"] } })
      .places,
  ).toEqual(["/abs/a.txt", "/abs/b.txt"])
  expect(
    PermissionView.of({ action: "Read", resources: ["rel.txt"], metadata: { path: "/abs/a.txt" } }).places,
  ).toEqual(["/abs/a.txt"])
  // A Glob or Grep names a folder, not a place, in `path`.
  const search = PermissionView.of({ action: "Grep", resources: ["needle"], metadata: { path: "/abs/dir" } })
  expect([search.places, search.folder, search.pattern]).toEqual([[], "/abs/dir", "needle"])
})

test("a request from a server that names no places falls back to the resources of a file action only", () => {
  expect(PermissionView.of({ action: "Edit", resources: ["src/a.ts", "*"] }).places).toEqual(["src/a.ts"])
  expect(PermissionView.of({ action: "slack_post", resources: ["*", "#ops"] }).places).toEqual([])
  expect(PermissionView.of({ action: "WebFetch", resources: ["https://a.example/"] }).places).toEqual([])
})

test("a shell request names the folder it runs in", () => {
  expect(PermissionView.of({ action: "Bash", resources: ["ls"], metadata: { workdir: "/abs/run" } }).folder).toBe(
    "/abs/run",
  )
  expect(PermissionView.of({ action: "PowerShell", resources: ["ls"] }).folder).toBeUndefined()
})

test("a fetch names its method and URL, from the metadata or from the resources", () => {
  const url = "https://api.example/collect"
  expect(PermissionView.of({ action: "WebFetch", resources: [url], metadata: { url } })).toMatchObject({
    method: "GET",
    url,
  })
  expect(
    PermissionView.of({ action: "WebFetch", resources: [url, `POST ${url}`], metadata: { method: "post", url } }),
  ).toMatchObject({ method: "POST", url })
  expect(PermissionView.of({ action: "WebFetch", resources: [url, `DELETE ${url}`] })).toMatchObject({
    method: "DELETE",
    url,
  })
  // Only a fetch has a method: an MCP tool's metadata that happens to carry one is not a fetch.
  expect(
    PermissionView.of({ action: "slack_post", resources: ["*"], metadata: { method: "POST", url } }),
  ).toMatchObject({
    method: undefined,
    url: undefined,
  })
})

test("MCP arguments are text, and a long set is shown whole, never cut", () => {
  expect(
    PermissionView.of({ action: "slack_post", resources: ["*"], metadata: { arguments: { text: "hi" } } }).arguments,
  ).toBe('{"text":"hi"}')
  // The model picks the key order, so nothing is cut: a deciding value after a long one is still in the text.
  const long = PermissionView.of({
    action: "x",
    resources: ["*"],
    metadata: { arguments: { note: "a".repeat(5000), channel: "#leak-HIDDEN" } },
  })
  expect(long.arguments).toContain("#leak-HIDDEN")
  expect(long.arguments).not.toContain("more characters")
})

test("files keep their diff and place, and an entry without both is dropped", () => {
  const view = PermissionView.of({
    action: "Edit",
    resources: ["a.txt"],
    metadata: {
      files: [
        { file: "a.txt", patch: "@@\n-a\n+b\n", place: "/abs/a.txt", from: "/abs/old.txt" },
        { file: "no-patch.txt" },
        { patch: "no file" },
        null,
        "text",
      ],
    },
  })
  expect(view.files).toEqual([{ file: "a.txt", patch: "@@\n-a\n+b\n", place: "/abs/a.txt", from: "/abs/old.txt" }])
})

test("the names of a tool and its old name are one action", () => {
  for (const name of ["Bash", "shell", "PowerShell"]) expect(PermissionView.action(name)).toBe("shell")
  expect(PermissionView.action("apply_patch")).toBe("patch")
  expect(PermissionView.action("NotebookEdit")).toBe("notebook_edit")
})

// m5-link-warning: the links of a request, and the words every client warns with.
const out = { place: "/real/outside/a.txt", outside: true }
const inner = { place: "/p/src/b.txt", outside: false }
// What the view adds, typed here so that each test fails on its own assertion while the view does not have it.
type Ended = { readonly file: string; readonly place: string; readonly outside: boolean }
const linked: typeof PermissionView & {
  linkWarning?: (link: Ended, show: (value: string) => string) => string
  linkSummary?: (links: ReadonlyArray<Ended>) => string | undefined
} = PermissionView
const viewOf = (request: PermissionView.Request): PermissionView.View & { readonly links?: ReadonlyArray<Ended> } =>
  PermissionView.of(request)
const linksOf = (files: unknown, action = "Edit") => viewOf({ action, resources: ["x"], metadata: { files } }).links

test("the links of a request are one per linked end, the ones that end outside first", () => {
  const files = [
    { file: "alias/b.txt", place: "/p/alias/b.txt", patch: "x", link: inner },
    { file: "a.txt", place: out.place, patch: "x", link: out },
    { file: "c.txt", place: "/p/c.txt", patch: "x" },
    // A move: the destination is plain and the source is linked.
    { file: "d.txt", place: "/p/d.txt", from: "/p/way/e.txt", patch: "x", fromLink: { place: "/real/e.txt", outside: true } },
    // What a move replaces repeats its destination's link, which is one link.
    { file: "a.txt", place: out.place, patch: "y", link: out },
  ]
  expect(linksOf(files)).toEqual([
    { file: out.place, ...out },
    { file: "/p/way/e.txt", place: "/real/e.txt", outside: true },
    { file: "/p/alias/b.txt", ...inner },
  ])
  // One end said to be outside and inside takes the stricter answer (class 3).
  expect(
    linksOf([
      { file: "f", place: "/p/f", patch: "x", link: { place: "/r/f", outside: false } },
      { file: "f", place: "/p/f", patch: "x", link: { place: "/r/f", outside: true } },
    ]),
  ).toEqual([{ file: "/p/f", place: "/r/f", outside: true }])
})

test("a link is named from an entry with no patch or no place, so the warning never goes with them", () => {
  expect(linksOf([{ file: "a.txt", link: out }])).toEqual([{ file: "a.txt", ...out }])
  expect(linksOf([{ link: out }])).toEqual([{ file: out.place, ...out }])
})

test("no link, an older server and a malformed link: each costs only that warning (class 7)", () => {
  expect(viewOf({ action: "Edit", resources: ["a.txt"] }).links).toEqual([])
  expect(linksOf("not a list")).toEqual([])
  const bad = [null, 7, "linked", [], {}, { place: 7, outside: true }, { place: "", outside: true }, { place: "/r" }, { place: "/r", outside: "true" }]
  for (const value of bad) {
    const view = viewOf({
      action: "Edit",
      resources: ["x"],
      metadata: {
        files: [
          null,
          { file: "bad", place: "/p/bad", from: "/p/was", patch: "x", link: value, fromLink: value },
          { file: "a.txt", place: out.place, patch: "x", link: out },
        ],
      },
    })
    expect([value, view.links]).toEqual([value, [{ file: out.place, ...out }]])
    expect(view.files.map((file) => file.file)).toEqual(["bad", "a.txt"])
  }
})

test("the words of the warning: where a link ends comes first, so a cut line still says it", () => {
  const ends = { file: out.place, ...out }
  const alias = { file: "/p/alias/b.txt", ...inner }
  const show = (value: string) => `<${value}>`
  expect(linksOf([])).toEqual([])
  expect(linked.linkWarning?.(ends, show)).toBe(`Link ends outside the project, at <${out.place}>`)
  expect(linked.linkWarning?.(alias, show)).toBe(
    "Link ends inside the project: </p/alias/b.txt> leads to </p/src/b.txt>",
  )
  expect(linked.linkSummary).toBeFunction()
  expect(linked.linkSummary?.([])).toBeUndefined()
  expect(linked.linkSummary?.([ends])).toBe("Link ends outside the project")
  expect(linked.linkSummary?.([alias])).toBe("Link ends inside the project")
  expect(linked.linkSummary?.([ends, alias, { ...ends, file: "/p/other" }])).toBe("3 linked paths, 2 outside the project")
  expect(linked.linkSummary?.([alias, { ...alias, file: "/p/other" }])).toBe("2 linked paths, all inside the project")
})
