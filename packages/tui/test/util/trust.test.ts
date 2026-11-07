import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { asksTrust } from "../../src/util/trust"

const untrusted: TrustStatus = { directory: "/projects/app", trusted: false, persistent: true, withheld: [] }

// A server older than this client still sends the changes since the grant, and files above the project, for a trusted
// folder: neither asks anything (D8, D7).
const older = {
  ...untrusted,
  trusted: true,
  source: "saved" as const,
  withheld: [{ path: "/projects/app/orbit.json", kinds: ["hooks" as const] }],
  changed: [{ path: "/projects/app/orbit.json", kinds: ["hooks"] }],
} as TrustStatus

test.each([
  // trust-first: a folder that is not trusted is asked about whatever it holds, because nothing of it loads until then.
  ["an untrusted folder", untrusted, true],
  ["a trusted folder", { ...untrusted, trusted: true, source: "saved" as const }, false],
  ["a trusted folder that an older server lists changes for", older, false],
  ["a folder whose status is not known", undefined, false],
])("%s: whether it needs an answer", (_, status, expected) => {
  expect(asksTrust(status)).toBe(expected)
})
