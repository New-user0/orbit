import { describe, expect, test } from "bun:test"
import { VcsInstructions } from "@orbit/core/vcs/instructions"

const snapshot = (overrides: Partial<VcsInstructions.Snapshot> = {}): VcsInstructions.Snapshot => ({
  branch: "feature",
  main: "main",
  user: "Ada",
  status: " M src/a.ts\n?? notes.txt",
  truncated: false,
  commits: ["abc1234 second", "def5678 first"],
  late: false,
  ...overrides,
})

describe("the render of the git snapshot", () => {
  test("holds the header, then the branch, the main branch, the user, the status and the commits, in blank-line sections", () => {
    const sections = VcsInstructions.render(snapshot()).split("\n\n")

    expect(sections).toHaveLength(6)
    expect(sections[0]).toContain("when the session began")
    expect(sections[0]).toContain("not updated")
    expect(sections.slice(1)).toEqual([
      "Current branch: feature",
      "Main branch (pull requests usually target this branch): main",
      "Git user: Ada",
      "Status:\n M src/a.ts\n?? notes.txt",
      "Recent commits:\nabc1234 second\ndef5678 first",
    ])
  })

  test("keeps the leading space of the first status entry", () => {
    expect(VcsInstructions.render(snapshot({ status: " M a.ts" }))).toContain("Status:\n M a.ts")
  })

  test("says the tree is clean when the status is empty", () => {
    expect(VcsInstructions.render(snapshot({ status: "" }))).toContain("Status:\n(clean)")
  })

  test("leaves the user out when git has none", () => {
    expect(VcsInstructions.render(snapshot({ user: "" }))).not.toContain("Git user")
  })

  test("leaves the commit section empty, and still present, when there are no commits", () => {
    expect(VcsInstructions.render(snapshot({ commits: [] })).endsWith("Recent commits:")).toBe(true)
  })

  test("shows a detached head as HEAD", () => {
    expect(VcsInstructions.render(snapshot({ branch: "HEAD" }))).toContain("Current branch: HEAD")
  })

  test("says in its header that a snapshot taken later was not taken at the start", () => {
    const text = VcsInstructions.render(snapshot({ late: true }))

    expect(text).toContain("partway through the session")
    expect(text).not.toContain("when the session began")
    expect(text).toContain("not updated")
  })

  test("adds the marker line under a truncated status, and none under one that is not", () => {
    const cut = VcsInstructions.render(snapshot({ truncated: true }))

    expect(cut).toContain("2,000 characters")
    expect(cut).toContain("git status")
    expect(cut.indexOf("2,000 characters")).toBeGreaterThan(cut.indexOf(" M src/a.ts"))
    expect(cut.indexOf("2,000 characters")).toBeLessThan(cut.indexOf("Recent commits:"))
    expect(VcsInstructions.render(snapshot())).not.toContain("2,000")
  })
})

describe("the cut of the status", () => {
  test("keeps the first 2,000 characters of a longer status and says it was cut", () => {
    const text = "x".repeat(VcsInstructions.STATUS_LIMIT + 1)

    expect(VcsInstructions.cutStatus(text)).toEqual({ status: "x".repeat(VcsInstructions.STATUS_LIMIT), truncated: true })
  })

  test("leaves a status of exactly 2,000 characters whole, with no marker", () => {
    const text = "x".repeat(VcsInstructions.STATUS_LIMIT)

    expect(VcsInstructions.cutStatus(text)).toEqual({ status: text, truncated: false })
  })

  test("does not split a surrogate pair at the cut", () => {
    // The pair starts at index 1999, so the cut would leave its first half.
    const text = `${"x".repeat(VcsInstructions.STATUS_LIMIT - 1)}\u{1F600}tail`

    const cut = VcsInstructions.cutStatus(text)

    expect(cut.truncated).toBe(true)
    expect(cut.status).toBe("x".repeat(VcsInstructions.STATUS_LIMIT - 1))
  })

  test("keeps a whole pair that ends exactly at the cut", () => {
    const text = `${"x".repeat(VcsInstructions.STATUS_LIMIT - 2)}\u{1F600}tail`

    expect(VcsInstructions.cutStatus(text).status.endsWith("\u{1F600}")).toBe(true)
    expect(VcsInstructions.cutStatus(text).status).toHaveLength(VcsInstructions.STATUS_LIMIT)
  })
})
