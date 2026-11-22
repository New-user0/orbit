// m5-link-warning: the VS Code card says where a link leads, from the item the extension builds of the request alone
// (class 8), with each place written out (class 9). A malformed link costs only that warning (class 7).
import { expect, test } from "bun:test"
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
