import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { expect, test } from "bun:test"
import { shellArgument } from "@orbit/util/shell-argument"
import { groupWithheld, holdsBack, trustCommands } from "../../src/util/trust"

const own: TrustWithheld = { path: "/projects/app/orbit.json", kinds: ["hooks"] }
// A file in a folder above the project names that folder, because each folder is trusted on its own.
const above: TrustWithheld = { path: "/projects/orbit.json", kinds: ["mcp"], directory: "/projects" }

const untrusted: TrustStatus = { directory: "/projects/app", trusted: false, persistent: true, withheld: [own], changed: [] }

test.each([
  ["an untrusted folder that holds its own config back", untrusted, true],
  [
    "an untrusted folder that holds its own config and config above it back",
    { ...untrusted, withheld: [above, own] },
    true,
  ],
  // Trusting the folder would turn nothing on, as what is held back is decided by the folder that holds it.
  ["an untrusted folder whose only held-back config is above it", { ...untrusted, withheld: [above] }, false],
  ["an untrusted folder that holds nothing back", { ...untrusted, withheld: [] }, false],
  ["a trusted folder", { ...untrusted, trusted: true, source: "saved" as const, withheld: [] }, false],
  ["a trusted folder with config above it held back", { ...untrusted, trusted: true, withheld: [above] }, false],
  [
    "a trusted folder whose own config changed since",
    { ...untrusted, trusted: true, source: "saved" as const, changed: [{ path: own.path, kinds: own.kinds }] },
    true,
  ],
  [
    "a trusted folder whose config above it changed, which its own folder decides",
    { ...untrusted, trusted: true, withheld: [above], changed: [{ path: above.path, kinds: above.kinds }] },
    false,
  ],
  [
    "a trusted folder on a server that sends no list of changes",
    { directory: "/projects/app", trusted: true, persistent: true, withheld: [own] },
    false,
  ],
  ["a folder whose status is not known", undefined, false],
])("%s: whether it holds something back", (_, status, expected) => {
  expect(holdsBack(status)).toBe(expected)
})

test("names the location a folder above the project is trusted through, and no command for one that cannot be trusted", () => {
  const folder = "/projects"
  expect(trustCommands([above], "/projects/app")).toBe("`orb trust /projects --for /projects/app`")
  expect(trustCommands([above], folder)).toBe("`orb trust /projects`")
  // A name with a space is one argument, quoted as the platform's shells take it.
  expect(trustCommands([{ ...above, directory: "/my work" }], "/my projects/app")).toBe(
    `\`orb trust ${shellArgument("/my work")} --for ${shellArgument("/my projects/app")}\``,
  )
  // A name a shell would act on is never the bare argument of a command: it is quoted, or there is no command.
  for (const name of ["/work/$(touch PWNED)", "/work/`touch PWNED`", "/work/a\u001bb"]) {
    const text = trustCommands([{ ...above, directory: name }], "/projects/app")
    expect(text).not.toContain(`orb trust ${name}`)
    expect(text).not.toContain("\u001b")
  }
  expect(trustCommands([{ ...above, directory: "/", persistent: false }], "/projects/app")).not.toContain("orb trust /")
  expect(trustCommands([{ ...above, directory: "/", persistent: false }], "/projects/app")).toContain("--trust")
})

test("what trusting the project turns on is told from what the folder above decides", () => {
  expect(groupWithheld([above, own])).toEqual({ own: [own], above: [above] })
})
