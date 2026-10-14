import { describe, expect, test } from "bun:test"
import path from "path"

// Class 15: a network share is two backslashes, the host, one backslash and the share, and a device path starts with two
// backslashes too. The notes twice lost one of them when a paragraph was rewritten, so the shape is pinned here: a code
// span in either document must not start with a lone backslash.
// A span that starts with one backslash and then names a host (or a period) and a second backslash.
const lone = (line: string) => [...line.matchAll(/`\\(?:\.|[A-Za-z][A-Za-z0-9_.-]+)\\[^`]*`/g)]

describe("share and device spellings in the docs", () => {
  for (const name of ["upgrading.md", "untrusted-repositories.md", "follow-ups.md"])
    test(`${name} has no code span that starts with a single backslash`, async () => {
      const text = await Bun.file(path.join(import.meta.dir, "../../../docs", name)).text()
      expect(
        text.split("\n").flatMap((line, index) => lone(line).map((match) => `${name}:${index + 1} ${match[0]}`)),
      ).toEqual([])
    })

  test("the check finds a single-backslash spelling (control)", () => {
    expect(lone("(`\\host\\share`)")).toHaveLength(1)
    expect(lone("(`\\\\host\\share`, `\\\\.\\...`)")).toHaveLength(0)
  })
})
