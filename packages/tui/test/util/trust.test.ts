import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { expect, test } from "bun:test"
import { groupWithheld, holdsBack } from "../../src/util/trust"

const own: TrustWithheld = { path: "/projects/app/orbit.json", kinds: ["hooks"] }
// A file in a folder above the project names that folder, because each folder is trusted on its own.
const above: TrustWithheld = { path: "/projects/orbit.json", kinds: ["mcp"], directory: "/projects" }

const untrusted: TrustStatus = { directory: "/projects/app", trusted: false, persistent: true, withheld: [own] }

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
  ["a folder whose status is not known", undefined, false],
])("%s: whether it holds something back", (_, status, expected) => {
  expect(holdsBack(status)).toBe(expected)
})

test("what trusting the project turns on is told from what the folder above decides", () => {
  expect(groupWithheld([above, own])).toEqual({ own: [own], above: [above] })
})
