import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Git } from "../src/git"
import { run } from "../src/runner"

// Classes 1 and 3: `orb flow run` in a trusted folder `sub`, inside a repository `clone` that nobody trusted and whose
// config and hooks name a program that records each run. A `.git` in `sub` either leads git into `clone` (a `gitdir:`
// file, a `commondir`, a junction or link, a submodule's directory), or is one that git passes over, so that a git which
// walks up uses `clone`. The runner asks git which repository it uses, looking no further up than the project's folder,
// and uses one only when its work tree, git directory and common directory are inside the folders the decision covers
// (`Git.root`). Each row first checks with a plain git that git does use `clone`'s directories from `sub`.
// Mutations: `Git.root` taking git's answer whatever folders it names fails every pointer row (the program runs); the
// `.git` that git passes over is caught by the ceiling of `Git.git`, whose rows fail when the ceiling is dropped.
// Controls: a run in `clone` once it is the trusted project runs its program, and so does a run in a linked worktree that
// `clone` lists, with `clone` as its main checkout.
const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-passed-")))
afterAll(async () => {
  // A row makes a folder that cannot be searched; open it again so that it can be removed.
  for (const name of await fs.readdir(root))
    await fs.chmod(path.join(root, name, "clone", "sub", ".git", "objects"), 0o755).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
const unix = (file: string) => file.replaceAll("\\", "/")

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
      list: async () => ({ data: [{ id: `msg_${sessions}`, type: "assistant", content: [{ type: "text", text: "ok" }], tokens: {}, cost: 0 }] }),
    },
    model: { list: async () => ({ data: [] }) },
    event: { subscribe: async function* () {} },
  } as unknown as OrbitClient
}

let count = 0
// A repository `clone` with a commit, whose hooks and file system monitor run a program that records each run, and a
// folder `sub` in it.
async function outer() {
  const folder = path.join(root, `case-${++count}`)
  const clone = path.join(folder, "clone")
  await fs.mkdir(path.join(clone, "sub"), { recursive: true })
  const vcs = (...args: string[]) => expect(Bun.spawnSync(["git", ...args], { cwd: clone }).exitCode).toBe(0)
  vcs("init", "-q", "-b", "main")
  vcs("config", "user.email", "t@t")
  vcs("config", "user.name", "t")
  await Bun.write(path.join(clone, "a.txt"), "one\n")
  vcs("add", "-A")
  vcs("commit", "-qm", "one", "--no-gpg-sign")
  const marker = path.join(folder, "ran")
  const program = path.join(folder, "program.sh")
  await Bun.write(program, `#!/bin/sh\necho ran >> "${unix(marker)}"\n`)
  await fs.chmod(program, 0o755)
  const hooks = path.join(folder, "hooks")
  await fs.mkdir(hooks)
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
    await Bun.write(path.join(hooks, hook), `#!/bin/sh\n"${unix(program)}"\n`)
    await fs.chmod(path.join(hooks, hook), 0o755)
  }
  vcs("config", "core.hooksPath", unix(hooks))
  vcs("config", "core.fsmonitor", unix(program))
  return { folder, clone, sub: path.join(clone, "sub"), ran: () => existsSync(marker) }
}

const valid = async (entry: string, head: string | Uint8Array = "ref: refs/heads/main\n") => {
  await fs.mkdir(path.join(entry, "objects"), { recursive: true })
  await fs.mkdir(path.join(entry, "refs"), { recursive: true })
  await fs.writeFile(path.join(entry, "HEAD"), head)
}

// A `.git` in `sub` that leads git into the git directory of `clone`.
const pointers: readonly (readonly [string, (sub: string) => Promise<void>])[] = [
  ["a .git file that names the git directory above", (sub) => fs.writeFile(path.join(sub, ".git"), "gitdir: ../.git\n")],
  [
    "a .git directory whose commondir names the git directory above",
    async (sub) => {
      await fs.mkdir(path.join(sub, ".git"))
      await fs.writeFile(path.join(sub, ".git", "HEAD"), "ref: refs/heads/main\n")
      await fs.writeFile(path.join(sub, ".git", "commondir"), "../../.git\n")
    },
  ],
  [
    "a .git that is a junction or link to the git directory above",
    (sub) => fs.symlink(path.join(sub, "..", ".git"), path.join(sub, ".git"), process.platform === "win32" ? "junction" : "dir"),
  ],
  [
    "a .git file that names a submodule's directory in the repository above, with that repository's config",
    async (sub) => {
      const outer = path.join(sub, "..", ".git")
      const copy = path.join(sub, "..", "..", "module")
      await fs.cp(outer, copy, { recursive: true })
      await fs.mkdir(path.join(outer, "modules"))
      await fs.rename(copy, path.join(outer, "modules", "sub"))
      await fs.writeFile(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n")
    },
  ],
]

// A `.git` in `sub` that git passes over, looking for the repository in `clone` above. A folder that cannot be searched
// stops git only outside Windows, and not for root, who may search any folder.
const passed: readonly (readonly [string, (sub: string) => Promise<void>])[] = [
  ["a .git that holds only HEAD", (sub) => fs.mkdir(path.join(sub, ".git")).then(() => fs.writeFile(path.join(sub, ".git", "HEAD"), "ref: refs/heads/main\n"))],
  [
    "a .git whose HEAD starts with a byte order mark",
    (sub) => valid(path.join(sub, ".git"), new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("ref: refs/heads/main\n")])),
  ],
  ...(process.platform !== "win32" && process.getuid?.() !== 0
    ? ([
        [
          "a .git whose objects folder cannot be searched (mode 000)",
          async (sub: string) => {
            await valid(path.join(sub, ".git"))
            await fs.chmod(path.join(sub, ".git", "objects"), 0o000)
          },
        ],
      ] as const)
    : []),
]

// What a plain git in `folder` uses as its common directory, and as its work tree.
const plain = (folder: string, flag: string) => {
  const child = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", flag], { cwd: folder, stderr: "ignore" })
  return realpathSync.native(child.stdout.toString().trim())
}

const workflow = { name: "w", run: (ctx: Parameters<Parameters<typeof run>[0]["workflow"]["run"]>[0]) => ctx.agent("a", { prompt: "x" }) }

// A run in `directory`, which the person trusted and the server names as the project `project`.
const trustedRun = (directory: string, project: Git.Project, lines: string[] = []) =>
  run({
    client: client(),
    directory,
    trusted: true,
    project,
    file: path.join(directory, "w.ts"),
    workflow,
    log: (line) => lines.push(line),
  })

for (const [name, make] of pointers)
  test(`a trusted run in sub uses no git of the untrusted repository above, for ${name}`, async () => {
    const found = await outer()
    await make(found.sub)
    expect(path.relative(path.join(found.clone, ".git"), plain(found.sub, "--git-common-dir")).startsWith("..")).toBe(false)
    const lines: string[] = []

    const result = await trustedRun(found.sub, { directory: found.sub, canonical: found.sub }, lines)

    expect(result.status).toBe("succeeded")
    expect(found.ran()).toBe(false)
    expect(lines.some((line) => line.startsWith("! git is not used:"))).toBe(true)
  }, 60_000)

for (const [name, make] of passed) {
  test(`a trusted run in sub uses no git of the untrusted repository above, for ${name}`, async () => {
    const found = await outer()
    await make(found.sub)
    expect(plain(found.sub, "--show-toplevel")).toBe(found.clone)

    const result = await trustedRun(found.sub, { directory: found.sub, canonical: found.sub })

    expect(result.status).toBe("succeeded")
    expect(found.ran()).toBe(false)
  }, 60_000)

  // The ceiling: git that the runner starts in `sub` finds no repository, where a plain git finds `clone`.
  test(`Git.git looks for no repository above the folder it is given, for ${name}`, async () => {
    const found = await outer()
    await make(found.sub)

    expect((await Git.git(found.sub, ["rev-parse", "--show-toplevel"])).code).not.toBe(0)
    expect(await Git.root(found.sub)).toEqual({})
    expect(found.ran()).toBe(false)
  }, 60_000)
}

test("a trusted run in the repository itself uses its git and runs its program (control)", async () => {
  const found = await outer()

  const result = await trustedRun(found.clone, { directory: found.clone, canonical: found.clone })

  expect(result.status).toBe("succeeded")
  expect(found.ran()).toBe(true)
})

test("a trusted run in a linked worktree that the repository lists uses its git, with the repository as the main checkout (control)", async () => {
  const found = await outer()
  const worktree = path.join(found.folder, "linked")
  expect(Bun.spawnSync(["git", "-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "worktree", "add", "-q", "--detach", worktree], { cwd: found.clone }).exitCode).toBe(0)
  const linked = realpathSync.native(worktree)
  expect(found.ran()).toBe(false)

  const result = await trustedRun(linked, { directory: linked, canonical: found.clone })

  expect(result.status).toBe("succeeded")
  expect(found.ran()).toBe(true)
})
