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
const decoys = [
  { action: "Read", real: ".env", current: "file_path" },
  { action: "Edit", real: ".github/workflows/ci.yml", current: "file_path" },
] as const

describe("a call that names a file under both spellings", () => {
  decoys.forEach((row) =>
    [false, true].forEach((reversed) =>
      test(`${row.action} shows the current field${reversed ? " (decoy first)" : ""}`, () => {
        const pair = [
          [row.current, row.real],
          ["path", "README.md"],
        ]
        const input = Object.fromEntries(reversed ? pair.reverse() : pair)
        const shown = permissionPresentation({ action: row.action, resources: [row.real], input })
        expect(shown.title).toContain(row.real)
        expect(JSON.stringify(shown)).not.toContain("README.md")
      }),
    ),
  )
})
