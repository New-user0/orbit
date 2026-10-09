import { describe, expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

// The runner drops an old field name that arrives beside the current one, so the prompt must name the file that runs.
// NotebookEdit asks as Edit, so the tool's own name has to pick its field names.
const decoys = [
  { action: "Read", tool: "Read", real: ".env", current: "file_path" },
  { action: "Edit", tool: "Edit", real: ".github/workflows/ci.yml", current: "file_path" },
  { action: "Edit", tool: "NotebookEdit", real: "analysis.ipynb", current: "notebook_path" },
] as const

describe("a call that names a file under both spellings", () => {
  decoys.forEach((row) =>
    [false, true].forEach((reversed) =>
      test(`${row.tool} shows the current field${reversed ? " (decoy first)" : ""}`, () => {
        const pair = [
          [row.current, row.real],
          ["path", "README.md"],
        ]
        const input = Object.fromEntries(reversed ? pair.reverse() : pair)
        const shown = permissionPresentation({ action: row.action, tool: row.tool, resources: [row.real], input })
        expect(shown.title).toContain(row.real)
        expect(JSON.stringify(shown)).not.toContain("README.md")
      }),
    ),
  )
})

// A patch asks once, as Edit, for every file it changes. The prompt must name each file and show each file's diff.
describe("a patch that changes several files", () => {
  const files = [
    { file: "README.md", patch: "--- README.md\n+typo fix" },
    { file: ".orbit/config.json", patch: "--- .orbit/config.json\n+SECOND_FILE_CHANGE" },
  ]
  ;[true, false].forEach((joined) =>
    test(`names every file and shows every diff${joined ? "" : " (no joined diff)"}`, () => {
      const shown = permissionPresentation({
        action: "Edit",
        tool: "Patch",
        resources: files.map((item) => item.file),
        metadata: { files, ...(joined ? { diff: files.map((item) => item.patch).join("\n") } : {}) },
      })
      expect(shown.title).toContain("README.md")
      expect(shown.title).toContain(".orbit/config.json")
      expect(shown.diff).toContain("+typo fix")
      expect(shown.diff).toContain("SECOND_FILE_CHANGE")
    }),
  )

  test("a single-file patch keeps the single-file prompt", () => {
    const shown = permissionPresentation({
      action: "Edit",
      tool: "Patch",
      resources: ["README.md"],
      metadata: { files: [files[0]] },
    })
    expect(shown.title).toBe("Edit README.md")
    expect(shown.lines).toEqual([])
  })
})
