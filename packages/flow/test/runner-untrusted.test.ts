import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { run } from "../src/runner"
import type { Workflow } from "../src/workflow"

// Class 14/15: a node that asks for a worktree, a team in a worktree, or a merge fails in a folder that is not trusted,
// and the error says so, which is what `docs/upgrading.md` tells people. Each row has a trusted control that gets past
// the refusal (and fails for another reason or succeeds), so the suffix is what the rows pin. Mutation: dropping the
// " in a trusted folder" suffix of one of the three errors in `runner.ts` fails that row alone.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-untrusted-"))
afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const directory = path.join(root, "repo")
await fs.mkdir(directory, { recursive: true })
for (const args of [
  ["init", "-q", "-b", "main"],
  ["config", "user.email", "t@t"],
  ["config", "user.name", "t"],
])
  Bun.spawnSync(["git", ...args], { cwd: directory })
await Bun.write(path.join(directory, "a.txt"), "one\n")
Bun.spawnSync(["git", "add", "-A"], { cwd: directory })
Bun.spawnSync(["git", "commit", "-qm", "one", "--no-gpg-sign"], { cwd: directory })

const rows = [
  ["a worktree agent", (ctx: Parameters<Workflow["run"]>[0]) => ctx.agent("a", { prompt: "go", worktree: true })],
  [
    "a team in a worktree",
    (ctx: Parameters<Workflow["run"]>[0]) =>
      ctx.team("t", { goal: "g", members: { lead: { role: "lead" } }, worktree: true }),
  ],
  ["a merge", (ctx: Parameters<Workflow["run"]>[0]) => ctx.merge("m", [])],
] as const

test.each(rows)("%s in an untrusted folder says that the folder is not trusted", async (_, body) => {
  const result = await run({
    directory,
    trusted: false,
    file: path.join(directory, "w.ts"),
    workflow: { name: "w", run: body },
  })
  expect(result.status).toBe("failed")
  expect(JSON.stringify(result)).toContain("in a trusted folder")
})

test.each(rows)("%s in a trusted folder does not say it", async (_, body) => {
  const result = await run({
    directory,
    trusted: true,
    file: path.join(directory, "w.ts"),
    workflow: { name: "w", run: body },
  })
  expect(JSON.stringify(result)).not.toContain("in a trusted folder")
})
