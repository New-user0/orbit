import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Git } from "../src/git"
import { run } from "../src/runner"

// Classes 1 and 3 (M4 verification round 9): `orb flow run` in a folder `sub` that a person trusted, which is a repository
// of its own inside a repository `clone` that nobody trusted. The index of `sub` holds a gitlink `inner` that names the
// commit `clone` has checked out, and `inner/.git` names the git directory of `clone`. The runner uses `sub`'s own
// repository, which is inside the trusted folder (`Git.root`), and its dirty check, commits, merges and review diff then
// started a git in `inner` that took the config of `clone`: its file system monitor and its clean filter ran. Every git
// that the runner starts leaves submodules alone (`GitSubmodules.skip`), a commit leaves each gitlink out of `git add` by
// name, and a merge sets `ignore = all` for each submodule, because `git merge` first saves the work tree with a
// `git stash create` of its own, which takes no switch and follows `.gitmodules` (`GitSubmodules.pinned`).
//
// The matrix: `Git.dirty`, `Git.commit`, `Git.merge` (a conflict, which lists the conflicting files and checks the
// checkout again), `Git.diff` and a whole run x the gitlink alone and with a `.gitmodules` that asks git to look inside it
// (`ignore = none`). The oracles are the program of `clone`, which records its runs, and git's event trace, which names
// the repository each git process works in. Every row first runs a plain `git status` in `sub`, which does run the
// program. The control that the runner does run the program of a repository it may use is in git-passed-over.test.ts
// ("a trusted run in the repository itself ...").
//
// Mutations (recorded in the commit): `GitSubmodules.skip` returning its arguments fails every row but the commit's;
// leaving out only `--ignore-submodules=all` fails every `ignore = none` row but the commit's; dropping the gitlinks from
// the pathspecs of `git add` in `Git.commit` fails both commit rows; dropping the settings per submodule from `Git.merge`
// fails the `ignore = none` row of the merge, and so does giving them with `-c`, since the name of that submodule holds a
// `=`.
const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-gitlink-")))
afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
const unix = (file: string) => file.replaceAll("\\", "/")

const plain = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
const sh = (cwd: string, ...args: string[]) => expect(plain(cwd, ...args).exitCode).toBe(0)

let count = 0
// `clone`, whose config gives every `.txt` file a clean filter and sets a file system monitor, both the recording program,
// and `sub` in it with the gitlink. `inner/a.txt` differs from the `a.txt` of `clone`'s index at the same size, so git has
// to run the filter to compare them.
async function nested(none: boolean) {
  const folder = path.join(root, `case-${++count}`)
  const clone = path.join(folder, "clone")
  const sub = path.join(clone, "sub")
  await fs.mkdir(sub, { recursive: true })
  for (const directory of [clone, sub]) {
    sh(directory, "init", "-q", "-b", "main")
    sh(directory, "config", "user.email", "t@t")
    sh(directory, "config", "user.name", "t")
    sh(directory, "config", "commit.gpgsign", "false")
  }
  await Bun.write(path.join(clone, "a.txt"), "one\n")
  sh(clone, "add", "a.txt")
  sh(clone, "commit", "-qm", "one")
  const marker = path.join(folder, "ran")
  const program = path.join(folder, "program.sh")
  await Bun.write(program, `#!/bin/sh\necho ran >> "${unix(marker)}"\n`)
  await fs.chmod(program, 0o755)
  sh(clone, "config", "core.fsmonitor", unix(program))
  sh(clone, "config", "filter.marker.clean", `"${unix(program)}"`)
  await Bun.write(path.join(clone, ".git", "info", "attributes"), "*.txt filter=marker\n")
  await Bun.write(path.join(sub, "x.txt"), "x\n")
  sh(sub, "add", "x.txt")
  sh(
    sub,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${plain(clone, "rev-parse", "HEAD").stdout.toString().trim()},inner`,
  )
  if (none) {
    // A name with `=` in it, which `-c` would cut short.
    await Bun.write(
      path.join(sub, ".gitmodules"),
      '[submodule "in=ner"]\n\tpath = inner\n\turl = ./inner\n\tignore = none\n',
    )
    sh(sub, "add", ".gitmodules")
  }
  sh(sub, "commit", "-qm", "sub")
  await fs.mkdir(path.join(sub, "inner"))
  await fs.writeFile(path.join(sub, "inner", ".git"), "gitdir: ../../.git\n")
  await Bun.write(path.join(sub, "inner", "a.txt"), "six\n")
  const runs = async () => (existsSync(marker) ? (await Bun.file(marker).text()).split("\n").filter(Boolean).length : 0)
  // The gitlink is live: a plain `git status` in `sub` runs the program of `clone`.
  plain(sub, "status")
  expect(await runs()).toBeGreaterThan(0)
  return { folder, clone, sub, inner: path.join(sub, "inner"), runs }
}

/**
 * Runs `act` with git told to write its event trace, and returns the work tree that each git process works in. Git numbers
 * the repositories one process opens: its own is 1, and a submodule's whose `HEAD` it reads in the same process comes
 * later and is not counted.
 */
async function processes<A>(folder: string, act: () => Promise<A>) {
  const file = path.join(folder, "events.json")
  const before = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = file
  const value = await act().finally(() => {
    if (before === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = before
  })
  const text = existsSync(file) ? await Bun.file(file).text() : ""
  const worktrees = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; repo?: number; worktree?: string })
    .flatMap((event) =>
      event.event === "def_repo" && event.repo === 1 && event.worktree ? [path.resolve(event.worktree)] : [],
    )
  return { value, worktrees }
}

const same = (a: string, b: string) => path.relative(a, b) === ""

function client() {
  let sessions = 0
  return {
    config: { effective: async () => ({ permissions: { bypass: true } }) },
    session: {
      create: async () => ({ id: `ses_${++sessions}` }),
      prompt: async () => {},
      wait: async () => ({}),
      get: async () => undefined,
    },
    shell: { list: async () => ({ data: [] }) },
    message: {
      list: async () => ({
        data: [
          { id: `msg_${sessions}`, type: "assistant", content: [{ type: "text", text: "ok" }], tokens: {}, cost: 0 },
        ],
      }),
    },
    model: { list: async () => ({ data: [] }) },
    event: { subscribe: async function* () {} },
  } as unknown as OrbitClient
}

type Found = Awaited<ReturnType<typeof nested>>

interface Row {
  readonly name: string
  /** Sets `sub` up with plain git commands that look at no gitlink: `add` and `commit` of named files, a quiet checkout. */
  readonly prepare?: (found: Found) => Promise<void>
  readonly act: (found: Found) => Promise<unknown>
  readonly check: (value: unknown) => void
}

const rows: readonly Row[] = [
  { name: "Git.dirty", act: (found) => Git.dirty(found.sub), check: (value) => expect(value).toEqual([]) },
  {
    name: "Git.commit",
    prepare: (found) => Bun.write(path.join(found.sub, "y.txt"), "y\n").then(() => undefined),
    act: (found) => Git.commit(found.sub, "agent work"),
    check: (value) => expect(value).toBe(true),
  },
  {
    name: "Git.merge of a branch that conflicts",
    prepare: async (found) => {
      sh(found.sub, "checkout", "-q", "-b", "agent")
      await Bun.write(path.join(found.sub, "x.txt"), "agent\n")
      sh(found.sub, "add", "x.txt")
      sh(found.sub, "commit", "-qm", "agent")
      sh(found.sub, "checkout", "-q", "main")
      await Bun.write(path.join(found.sub, "x.txt"), "main\n")
      sh(found.sub, "add", "x.txt")
      sh(found.sub, "commit", "-qm", "main")
    },
    act: (found) => Git.merge(found.sub, "agent", "merge agent"),
    check: (value) => expect(value).toEqual({ merged: false, files: ["x.txt"], blocked: [] }),
  },
  {
    name: "Git.diff for a reviewer",
    prepare: (found) => Bun.write(path.join(found.sub, "x.txt"), "y\n").then(() => undefined),
    act: async (found) => Git.diff(found.sub, await Git.head(found.sub)),
    check: (value) => expect([String(value).includes("x.txt"), String(value).includes("inner")]).toEqual([true, false]),
  },
  {
    name: "a trusted run in sub",
    act: (found) =>
      run({
        client: client(),
        directory: found.sub,
        trusted: true,
        project: { directory: found.sub, canonical: found.sub },
        file: path.join(found.sub, "w.ts"),
        workflow: { name: "w", run: (ctx) => ctx.agent("a", { prompt: "x" }) },
      }),
    check: (value) => expect((value as { status: string }).status).toBe("succeeded"),
  },
]

for (const row of rows)
  for (const none of [false, true])
    test(`${row.name} leaves a gitlink that names the untrusted repository above alone${none ? ", with ignore = none in .gitmodules" : ""}`, async () => {
      const found = await nested(none)
      await row.prepare?.(found)
      const before = await found.runs()

      const result = await processes(found.folder, () => row.act(found))

      row.check(result.value)
      expect(result.worktrees.some((worktree) => same(worktree, found.sub))).toBe(true)
      expect(result.worktrees.some((worktree) => same(worktree, found.inner))).toBe(false)
      expect(await found.runs()).toBe(before)
    }, 60_000)
