// m5-link-warning: the VS Code card says where a link leads, from the item the extension builds of the request alone
// (class 8), with each place written out (class 9). A malformed link costs only that warning (class 7).
import { expect, test } from "bun:test"
import path from "node:path"
import { permissionItem } from "../src/controller"
import { approvalCard, type Card } from "../src/webview/approval"

const patch = "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n"
const out = { file: "linked/a.txt", place: "/out/a.txt", patch, link: { place: "/out/a.txt", outside: true } }
const inside = { file: "alias/b.txt", place: "/p/alias/b.txt", patch, link: { place: "/p/src/b.txt", outside: false } }
const none = { file: "c.txt", place: "/p/c.txt", patch }

const OUT = "Link ends outside the project, at /out/a.txt"
const IN = "Link ends inside the project: /p/alias/b.txt leads to /p/src/b.txt"

// The warnings are typed here, so that each test fails on its own assertion while the card does not have them.
const card = (files: unknown): Card & { readonly warnings?: ReadonlyArray<string> } =>
  approvalCard(
    permissionItem({ id: "per_link", sessionID: "ses_link", action: "Edit", resources: ["a"], metadata: { files } }),
  )

test("one link is one warning, with where it leads", () => {
  expect(card([out]).warnings).toEqual([OUT])
  expect(card([inside]).warnings).toEqual([IN])
})

test("a move names the link of its source", () => {
  const from = "/out/from.txt"
  expect(card([{ ...none, from, fromLink: { place: from, outside: true } }]).warnings).toEqual([
    `Link ends outside the project, at ${from}`,
  ])
})

test("several are counted first and then named, the outside ones first", () => {
  expect(card([none, inside, out]).warnings).toEqual(["2 linked paths, 1 outside the project", OUT, IN])
})

test("a long list of files keeps every warning", () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ ...none, place: `/p/c-${index}.txt` }))
  expect(card([...many, inside, out]).warnings).toEqual(["2 linked paths, 1 outside the project", OUT, IN])
})

test("a place with control, bidi and line-break characters is written out on one line (class 9)", () => {
  const place = "/out/\u001b]0;pwned\u0007‮gnp.ts​\nLink ends inside the project"
  expect(card([{ ...out, place, link: { place, outside: true } }]).warnings).toEqual([
    "Link ends outside the project, at /out/\\x1b]0;pwned\\x07\\u{202e}gnp.ts\\u{200b}\\nLink ends inside the project",
  ])
})

test("a linked file's own name with a line break starts no line of the card (class 9)", () => {
  const place = "/out/a.txt\nLink ends inside the project"
  const shown = card([{ ...out, place, from: place, link: { place, outside: true } }])
  expect(shown.title).toBe("Edit a.txt\\nLink ends inside the project")
  expect(shown.lines).toContain("Path: /out/a.txt\\nLink ends inside the project")
  for (const line of shown.lines) expect(line).not.toContain("\n")
})

test("a share is named as the request names it (classes 4 and 6)", () => {
  const place = "//orbit-test.invalid/share/a.txt"
  expect(card([{ ...none, link: { place, outside: true } }]).warnings).toEqual([
    `Link ends outside the project: /p/c.txt leads to ${place}`,
  ])
})

test("no link, or a malformed one, warns of nothing and costs only itself (class 7)", () => {
  expect(card(undefined).warnings).toEqual([])
  const bad = [undefined, null, 7, "linked", {}, { place: 7, outside: true }, { place: "/r", outside: "true" }]
  for (const link of bad) {
    const alone = card([{ ...none, link, fromLink: link }])
    expect(alone.warnings).toEqual([])
    expect(alone.title).toBe("Edit c.txt")
    expect(card([{ ...none, link }, out]).warnings).toEqual([OUT])
  }
})

// The card hides what overflows it, so a long place that does not wrap would be cut where nobody can read it.
test("a warning is drawn in the warning colour and wraps anywhere", async () => {
  const css = await Bun.file(path.join(import.meta.dir, "../src/webview/main.css")).text()
  const rule = css.match(/^\.perm-warning \{([^}]*)\}/m)?.[1]
  expect(rule).toContain("color: var(--vscode-editorWarning-foreground);")
  expect(rule).toContain("overflow-wrap: anywhere;")
  expect(rule).not.toMatch(/display|visibility|white-space|overflow:|max-height|opacity/)
})

// Fix loop 1 (class 9): every spelling of a blank, against every line of the card that draws a name.
test("no blank of a name is left in the card's title, warnings or lines", () => {
  const forged = "Link ends inside the project, at safe"
  for (const [blank, written] of [
    ["\n", "\\n"],
    ["\r", "\\x0d"],
    ["\t", "\\x09"],
    ["\u2028", "\\u{2028}"],
    ["\u2029", "\\u{2029}"],
    ["\u00a0\u00a0", "\\xa0\\xa0"],
    ["\u3164", "\\u{3164}"],
    ["  ", "\\x20\\x20"],
  ] as const) {
    const place = `/out/a.txt${blank}${forged}`
    const shown = `/out/a.txt${written}${forged}`
    const changed = card([{ ...out, place, from: place, link: { place, outside: true } }])
    expect(changed.warnings).toEqual([`Link ends outside the project, at ${shown}`])
    expect(changed.title).toBe(`Edit a.txt${written}${forged}`)
    expect(changed.lines).toContain(`Path: ${shown}`)
    const asks = (action: string, resources: string[], metadata: Record<string, string | string[]>) =>
      approvalCard(permissionItem({ id: "per_link", sessionID: "ses_link", action, resources, metadata }))
    const read = asks("Read", ["rel.txt"], { paths: [place] })
    expect(read.title).toBe(`Read ${shown}`)
    expect(read.lines).toEqual(["Resource: rel.txt", `Path: ${shown}`])
    expect(asks("Read", [place], { paths: ["/p/a.txt"] }).lines).toContain(`Resource: ${shown}`)
    const folder = asks("external_directory", [place], {})
    expect(folder.title).toBe(`external_directory ${shown}`)
    expect(folder.lines).toEqual([`Resource: ${shown}`])
    expect(asks("Grep", ["needle"], { path: place }).lines).toContain(`Folder: ${shown}`)
  }
  // A command keeps its lines.
  const command = approvalCard(
    permissionItem({ id: "per_link", sessionID: "ses_link", action: "shell", resources: ["one\ntwo  three"], metadata: {} }),
  )
  expect(command.title).toBe("Run one\ntwo  three")
})

test("what wraps in the card's title and warnings is indented, so a wrapped name starts no line as a warning does", async () => {
  const css = await Bun.file(path.join(import.meta.dir, "../src/webview/main.css")).text()
  const warning = css.match(/^\.perm-warning \{([^}]*)\}/m)?.[1]
  expect(warning).toContain("padding: 0 10px 6px 26px;")
  expect(warning).toContain("text-indent: -16px;")
  const title = css.match(/^\.perm-head \.strong \{([^}]*)\}/m)?.[1]
  for (const rule of ["padding-left: 16px;", "text-indent: -16px;", "overflow-wrap: anywhere;"]) expect(title).toContain(rule)
})
