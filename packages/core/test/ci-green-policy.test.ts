import { describe, expect, test } from "bun:test"
import path from "path"

// The owner, 2026-11-27: "No alone pass is fine but ci needs to be green always fix this". A failure that passes when
// its file is re-run alone, or when the job is run again, is no longer an answer: every CI job is green on every run,
// and a load failure is fixed at its cause. These rows pin that the rules a contributor reads say so, and that the list
// of known failures holds no load flake to excuse a red job with. The last row is a control: CI itself excuses nothing.

const repo = path.resolve(import.meta.dir, "../../..")
const read = (file: string) => Bun.file(path.join(repo, file)).text()
const owner = "No alone pass is fine but ci needs to be green always"

// The text of a Markdown section, from its heading to the next heading of the same or a higher level.
function section(text: string, heading: string) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === heading)
  if (start === -1) return undefined
  const level = heading.indexOf(" ")
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.indexOf(" ") <= level)
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n")
}

describe("CI is green on every run", () => {
  test("AGENTS.md says CI must be green and excuses no failure that passes when its file is re-run alone", async () => {
    const testing = section(await read("AGENTS.md"), "## Testing")
    expect(testing).toBeDefined()
    expect(testing).not.toMatch(/re-run alone needs no row/)
    expect(testing).toMatch(/CI must be green/)
    expect(testing).toContain(owner)
  })

  test("docs/known-failures.md lists no load flake and says CI must be green", async () => {
    const text = await read("docs/known-failures.md")
    const flaky = section(text, "## Flaky, depend on load")
    // The section may stay as a heading that says it is empty, or go; a row the owner accepts by name says so.
    const rows = (flaky ?? "")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Package |") && !/^\|( *-+ *\|)+$/.test(line))
      .filter((line) => !/accepted by the owner on \d{4}-\d{2}-\d{2}/i.test(line))
    expect(rows).toEqual([])
    // The rules above the history: no excuse for a timeout that passes alone, for a gate or for anything else.
    const rules = text.split(/^## Round 6\r?$/m)[0]!
    expect(rules).not.toMatch(/needs no new row/)
    expect(rules).not.toMatch(/the one exception is a timeout-only failure/)
    expect(rules).not.toMatch(/must pass when re-run alone|re-run its file alone and it must pass/)
    expect(rules).toMatch(/CI must be green/)
    expect(rules).toContain(owner)
  })

  test("docs/untrusted-repositories.md, class 14, has a flaky test fixed, never named and kept", async () => {
    const text = section(
      await read("docs/untrusted-repositories.md"),
      "### 14. Tests, gates and allowlists that do not check what they claim",
    )
    expect(text).toBeDefined()
    expect(text).not.toMatch(/or that PR names it and says why it stays/)
    expect(text).not.toMatch(/named in the PR with the reason it stays/)
    expect(text).toMatch(/CI must be green/)
  })

  // Control: green must mean every job passed. No job or step is allowed to fail, and no test step runs a file again.
  test("the CI workflow lets no job fail and runs no test again", async () => {
    const workflow = Bun.YAML.parse(await read(".github/workflows/check.yml")) as {
      jobs: Record<
        string,
        { "continue-on-error"?: unknown; steps: { name?: string; run?: string; "continue-on-error"?: unknown }[] }
      >
    }
    const allowed = Object.entries(workflow.jobs).flatMap(([name, job]) => [
      ...(job["continue-on-error"] === undefined ? [] : [name]),
      ...job.steps.filter((step) => step["continue-on-error"] !== undefined).map((step) => `${name}: ${step.name}`),
    ])
    expect(allowed).toEqual([])
    for (const name of ["test", "windows"]) {
      const step = workflow.jobs[name]!.steps.find((item) => item.name === "Test")!
      expect(step.run).toContain("set -o pipefail")
      expect(step.run).toMatch(/exit 1/)
      expect(step.run).not.toMatch(/--rerun-each|--retry|\|\| *bun run test/)
    }
  })
})
