import { expect, test } from "bun:test"
import type { TrustKind, TrustStatus } from "@orbit/client"
import path from "node:path"
import { aboveFolders, asksTrust, prompt, readStatus, trusted, view } from "../src/trust"

// The client types a kind as the closed set the protocol knows, and the server's answer is not checked against it, so a
// newer server, or a hostile one, can send another.
const kinds = (...names: string[]) => names as TrustKind[]

// What the extension says about trust, from the answer of the server. The strings in it come from the server and from the
// names of files that a repository chose, so they are written out before anything shows them.
const repo = path.resolve(path.sep, "work", "repo")
const outer = path.resolve(path.sep, "work")

const untrusted = {
  directory: repo,
  trusted: false,
  persistent: true,
  withheld: [
    { path: path.join(repo, "orbit.json"), kinds: ["hooks", "mcp"] },
    { path: path.join(repo, ".orbit", "plugins"), kinds: ["plugins"] },
    { path: path.join(outer, "orbit.json"), kinds: ["hooks"], directory: outer },
  ],
} satisfies TrustStatus

// ESC ] 0 BEL sets a window title, CSI 2 K erases the line, U+009B starts an escape sequence on a terminal that takes
// 8-bit controls, U+202E reorders the text after it, and a line break moves it.
const hostile = "evil\u001b]0;pwned\u0007\u001b[2K\u009b‮gpj.\r\nrest"
const controls = /\p{C}/u

test("splits what trusting the folder turns on from what stays off above it", () => {
  const shown = view(untrusted, repo)

  expect(shown.directory).toBe(repo)
  expect(shown.persistent).toBe(true)
  expect(shown.summary).toBe("hooks, MCP servers, plugins")
  expect(shown.held).toEqual([
    { name: "orbit.json", kinds: "hooks, MCP servers" },
    { name: path.join(".orbit", "plugins"), kinds: "plugins" },
  ])
  expect(shown.above).toEqual([outer])
  expect(shown.opened).toBeUndefined()
  expect(aboveFolders(untrusted)).toEqual([outer])
})

test("asks about the changes of a trusted folder, listing only what changed", () => {
  const changed = {
    directory: repo,
    trusted: true,
    source: "saved",
    persistent: true,
    withheld: [
      { path: path.join(repo, "orbit.json"), kinds: ["hooks"] },
      { path: path.join(outer, "orbit.json"), kinds: ["mcp"], directory: outer },
    ],
    changed: [{ path: path.join(repo, "orbit.json"), kinds: ["hooks"] }],
  } satisfies TrustStatus

  expect(asksTrust(changed)).toBe(true)
  // A trusted folder whose only held-back config is above it has nothing that trusting it would turn on.
  expect(asksTrust({ ...changed, changed: [], withheld: [changed.withheld[1]] })).toBe(false)
  const shown = view(changed, repo)
  expect(shown.changed).toBe(true)
  expect(shown.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])
  const asked = prompt(shown)
  expect(asked.message).toBe(`Trust the changes in ${repo}?`)
  expect(asked.detail).toContain("changed since you trusted it")
  expect(asked.accept).toBe("Trust changes")
  // The question for an untrusted folder is the one it was.
  expect(prompt(view(untrusted, repo)).accept).toBe("Trust this folder")
})

test("names the folder VS Code opened when it is not the project's folder", () => {
  const sub = path.join(repo, "packages", "app")

  expect(view(untrusted, sub).opened).toBe(sub)
  expect(view(untrusted, sub).directory).toBe(repo)
  // The same folder spelled with a trailing separator is the same folder.
  expect(view(untrusted, repo + path.sep).opened).toBeUndefined()
})

test("asks only for a folder that is untrusted and holds something of its own back", () => {
  const above = { ...untrusted, withheld: [untrusted.withheld[2]] }

  expect(asksTrust(untrusted)).toBe(true)
  expect(asksTrust({ ...untrusted, trusted: true, withheld: [] })).toBe(false)
  expect(asksTrust({ ...untrusted, withheld: [] })).toBe(false)
  // What sits above the project follows its own folder's decision, so trusting the project would turn nothing on.
  expect(asksTrust(above)).toBe(false)
  expect(asksTrust(undefined)).toBe(false)
})

test("writes out the control and format characters that a repository chose, wherever they show", () => {
  const shown = view(
    {
      directory: path.join(outer, hostile),
      trusted: false,
      persistent: true,
      withheld: [
        { path: path.join(outer, hostile, `${hostile}.json`), kinds: kinds("hooks", hostile) },
        { path: path.join(outer, hostile, "x"), kinds: kinds("mcp"), directory: path.join(outer, hostile, hostile) },
      ],
    },
    path.join(outer, hostile, hostile),
  )
  const everything = JSON.stringify(shown)
  const asked = prompt(shown)

  expect(everything).not.toMatch(controls)
  // A line break, as a carriage return and a line feed or as either, is written as \n.
  expect(shown.directory).toContain("\\x1b]0;pwned\\x07\\x1b[2K\\x9b\\u{202e}gpj.\\nrest")
  expect(shown.held[0]?.kinds).toContain("\\x1b")
  expect(asked.message + asked.detail.replaceAll("\n", "")).not.toMatch(controls)
  expect(trusted({ directory: shown.directory, persistent: true, above: shown.above })).not.toMatch(controls)
})

test("lists the first files in the question and says how many more there are", () => {
  const files = Array.from({ length: 9 }, (_, index) => ({
    path: path.join(repo, `f${index}.json`),
    kinds: kinds("hooks"),
  }))
  const asked = prompt(view({ ...untrusted, withheld: files }, repo))

  expect(asked.message).toBe(`Trust ${repo}?`)
  expect(asked.detail).toContain("f0.json: hooks")
  expect(asked.detail).toContain("f5.json: hooks")
  expect(asked.detail).not.toContain("f6.json")
  expect(asked.detail).toContain("and 3 more")
  expect(asked.accept).toBe("Trust this folder")
})

test("says what a grant lasts, and gives no command for config above the project", () => {
  const sub = path.join(repo, "sub")
  const stored = prompt(view(untrusted, sub))
  const session = prompt(view({ ...untrusted, persistent: false }, repo))

  expect(stored.detail).toContain("It stays trusted until `orb trust --revoke`.")
  expect(stored.detail).toContain(`VS Code opened ${sub}.`)
  expect(session.accept).toBe("Trust until Orbit restarts")
  expect(session.detail).toContain("lasts only until Orbit restarts")
  // A grant always goes to the project's root, which is not always the folder that holds the config above it, so the
  // only command the question may print is the one that ends a grant.
  for (const asked of [stored, session]) {
    expect(asked.detail).toContain(`Config in ${outer} stays off: each folder is trusted on its own.`)
    expect(asked.detail.replaceAll("`orb trust --revoke`", "")).not.toMatch(/orb trust/)
  }
  expect(trusted({ directory: repo, persistent: true, above: [outer] })).toBe(
    `Trusted ${repo}. Config in ${outer} stays off: each folder is trusted on its own.`,
  )
  expect(trusted({ directory: repo, persistent: false, above: [] })).toBe(`Trusted ${repo} until Orbit restarts.`)
})

test("falls back to the kind as written when the protocol has no words for it", () => {
  const shown = view(
    { ...untrusted, withheld: [{ path: path.join(repo, "a"), kinds: kinds("hooks", "constructor", "teleport") }] },
    repo,
  )

  expect(shown.summary).toBe("hooks, constructor, teleport")
})

test("accepts a trust status and nothing else", () => {
  const good = [untrusted, { ...untrusted, trusted: true, source: "saved", withheld: [] }, { ...untrusted, extra: 1 }]
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
  const odd: unknown[] = [
    null,
    { path: 7, kinds: [] },
    { path: "a", kinds: "hooks" },
    { path: "a", kinds: [1] },
    { path: "a", kinds: [], directory: 7 },
  ]

  expect(readStatus({ ...untrusted, withheld: [odd[0], ...untrusted.withheld, ...odd.slice(1)] })?.withheld).toEqual(
    untrusted.withheld,
  )
})
