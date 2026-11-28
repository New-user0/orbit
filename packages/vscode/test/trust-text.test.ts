import { expect, test } from "bun:test"
import type { TrustStatus } from "@orbit/client"
import path from "node:path"
import { asksTrust, prompt, readStatus, tooltip, trusted, view } from "../src/trust"

// What the extension says about trust, from the answer of the server. The strings in it come from the server and from the
// names of folders that a repository chose, so they are written out before anything shows them.
const repo = path.resolve(path.sep, "work", "repo")
const outer = path.resolve(path.sep, "work")

const untrusted = {
  directory: repo,
  trusted: false,
  persistent: true,
  withheld: [
    { path: path.join(repo, "orbit.json"), kinds: ["hooks", "mcp"] },
    { path: path.join(repo, ".orbit", "plugins"), kinds: ["plugins"] },
  ],
} satisfies TrustStatus

// What a server older than this extension sends for a trusted folder whose config changed since the grant, with config
// in a folder above the project as well.
const older = {
  ...untrusted,
  trusted: true,
  source: "saved",
  withheld: [...untrusted.withheld, { path: path.join(outer, "orbit.json"), kinds: ["hooks"], directory: outer }],
  changed: [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }],
} as TrustStatus

// ESC ] 0 BEL sets a window title, CSI 2 K erases the line, U+009B starts an escape sequence on a terminal that takes
// 8-bit controls, U+202E reorders the text after it, and a line break moves it.
const hostile = "evil\u001b]0;pwned\u0007\u001b[2K\u009b‮gpj.\r\nrest"
const controls = /\p{C}/u

test("lists nothing of an untrusted folder, whatever the answer carries", () => {
  expect(view(untrusted, repo)).toEqual({ directory: repo, persistent: true, summary: "", held: [] })
  const asked = prompt(view(untrusted, repo))
  expect(asked.message).toBe(`Trust ${repo}?`)
  expect(asked.detail).toContain("Do you know where this folder came from?")
  expect(asked.detail).toContain("Orbit can read, change and run the files here")
  expect(asked.detail).not.toContain("orbit.json")
  expect(asked.accept).toBe("Trust this folder")
  // The indicator says that nothing of the folder loads, not what an empty list leaves out.
  expect(tooltip(view(untrusted, repo))).toBe(`Orbit loads nothing from ${repo} until you trust it. Select to review.`)
})

test("names the folder VS Code opened when it is not the project's folder", () => {
  const sub = path.join(repo, "packages", "app")

  expect(view(untrusted, sub).opened).toBe(sub)
  expect(view(untrusted, sub).directory).toBe(repo)
  // The same folder spelled with a trailing separator is the same folder.
  expect(view(untrusted, repo + path.sep).opened).toBeUndefined()
})

// D8: a trusted folder is never asked about again, as the reference does, even when an older server lists its changes.
test("asks for every folder that is not trusted, whatever it holds, and never for a trusted one", () => {
  expect(asksTrust(untrusted)).toBe(true)
  expect(asksTrust({ ...untrusted, withheld: [] })).toBe(true)
  expect(asksTrust({ ...untrusted, trusted: true, withheld: [] })).toBe(false)
  expect(asksTrust(older)).toBe(false)
  expect(asksTrust(undefined)).toBe(false)
})

test("writes out the control and format characters that a repository chose, wherever they show", () => {
  const shown = view(
    { directory: path.join(outer, hostile), trusted: false, persistent: true, withheld: [] },
    path.join(outer, hostile, hostile),
  )
  const everything = JSON.stringify(shown)
  const asked = prompt(shown)

  expect(everything).not.toMatch(controls)
  // A line break, as a carriage return and a line feed or as either, is written as \n.
  expect(shown.directory).toContain("\\x1b]0;pwned\\x07\\x1b[2K\\x9b\\u{202e}gpj.\\nrest")
  expect(asked.message + asked.detail.replaceAll("\n", "")).not.toMatch(controls)
  expect(trusted({ directory: shown.directory, persistent: true })).not.toMatch(controls)
  expect(tooltip(shown)).not.toMatch(controls)
})

test("says what a grant lasts, and prints no command but the one that ends it", () => {
  const sub = path.join(repo, "sub")
  const stored = prompt(view(untrusted, sub))
  const session = prompt(view({ ...untrusted, persistent: false }, repo))

  expect(stored.detail).toContain("It stays trusted until `orb trust --revoke`.")
  expect(stored.detail).toContain(`VS Code opened ${sub}.`)
  expect(session.accept).toBe("Trust until Orbit restarts")
  expect(session.detail).toContain("lasts only until Orbit restarts")
  for (const asked of [stored, session]) expect(asked.detail.replaceAll("`orb trust --revoke`", "")).not.toMatch(/orb trust/)
  expect(trusted({ directory: repo, persistent: true })).toBe(`Trusted ${repo}.`)
  expect(trusted({ directory: repo, persistent: false })).toBe(`Trusted ${repo} until Orbit restarts.`)
})

test("accepts a trust status and nothing else", () => {
  const good = [untrusted, { ...untrusted, trusted: true, source: "saved", withheld: [] }, { ...untrusted, extra: 1 }, older]
  const bad: unknown[] = [
    undefined,
    null,
    "trusted",
    7,
    [],
    {},
    { ...untrusted, directory: 7 },
    { ...untrusted, trusted: "yes" },
    { ...untrusted, persistent: undefined },
    { ...untrusted, withheld: undefined },
    { ...untrusted, withheld: {} },
  ]

  for (const value of good) expect({ value, ok: readStatus(value) !== undefined }).toEqual({ value, ok: true })
  for (const value of bad) expect({ value, ok: readStatus(value) !== undefined }).toEqual({ value, ok: false })
})

test("drops a withheld entry that does not fit and keeps the rest of the answer", () => {
  const odd: unknown[] = [null, { path: 7, kinds: [] }, { path: "a", kinds: "hooks" }, { path: "a", kinds: [1] }]

  expect(readStatus({ ...untrusted, withheld: [odd[0], ...untrusted.withheld, ...odd.slice(1)] })?.withheld).toEqual(
    untrusted.withheld,
  )
})
