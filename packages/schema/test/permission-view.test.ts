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

test("MCP arguments are text, and a long set is cut with its length said", () => {
  expect(
    PermissionView.of({ action: "slack_post", resources: ["*"], metadata: { arguments: { text: "hi" } } }).arguments,
  ).toBe('{"text":"hi"}')
  const long = PermissionView.of({ action: "x", resources: ["*"], metadata: { arguments: { text: "a".repeat(5000) } } })
  expect(long.arguments!.length).toBeLessThan(2100)
  expect(long.arguments).toContain("more characters")
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
