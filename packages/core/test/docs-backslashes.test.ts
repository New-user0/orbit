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

describe("control bytes in the docs", () => {
  // A backslash before b, t or n in a shell string turns into a control byte; a note once held a backspace.
  const control = (text: string) =>
    text.split("\n").flatMap((line, index) => (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line) ? [index + 1] : []))

  test("no document under docs/ holds a C0 control byte", async () => {
    const dir = path.join(import.meta.dir, "../../../docs")
    const hits = await Promise.all(
      [...new Bun.Glob("**/*.md").scanSync(dir)].map(async (name) => ({
        name,
        lines: control(await Bun.file(path.join(dir, name)).text()),
      })),
    )
    expect(hits.filter((hit) => hit.lines.length > 0)).toEqual([])
  })

  test("the check finds a backspace (control)", () => {
    expect(control(`usr${String.fromCharCode(8)}in`)).toEqual([1])
    expect(control("usr\\bin")).toEqual([])
  })
})
