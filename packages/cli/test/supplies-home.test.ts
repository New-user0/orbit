import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel } from "./fixture/scripted-model"

// What a session started in the home folder, or below a home folder that is a repository, reads of config that is linked
// in (class 4, `ProjectTrust.supplies`). The person's own config is theirs wherever they start; a downloaded folder's
// `.orbit` that is itself a link out is not read from. ORBIT_TRUST_PROJECT is unset, so a run in a folder that is not
// trusted stops before it reads anything (trust-first), and a run of the person's own config passes --trust.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-supplies-home-")))
const model = scriptedModel(["done"])
const kind = process.platform === "win32" ? "junction" : "dir"

const skill = (name: string, marker: string) => `---\nname: ${name}\ndescription: ${marker}\n---\nBody.\n`

beforeAll(async () => {
  await model.configure(root)
  // The person's own agents and skills live in a dotfiles folder and are linked into their config folder.
  await Bun.write(
    path.join(root, "dotfiles", "agents", "mine.md"),
    "---\ndescription: mine\nmode: primary\n---\nMINE-AGENT-PROMPT-MARKER\n",
  )
  await Bun.write(path.join(root, "dotfiles", "skills", "mine", "SKILL.md"), skill("mine", "OWN-SKILL-DESCRIPTION-MARKER"))
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.symlink(path.join(root, "dotfiles", "agents"), path.join(root, "config", "agents"), kind)
  await fs.symlink(path.join(root, "dotfiles", "skills"), path.join(root, "config", "skills"), kind)
})

afterAll(async () => {
  await model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function run(home: string, directory: string, args: string[]) {
  const before = model.requests.length
  const child = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "run", "--standalone", ...args, "--model", model.model, "say ok"],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(home, {
        USERPROFILE: home,
        PWD: directory,
        ORBIT_TRUST_PROJECT: undefined,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        OLLAMA_CONTEXT_LENGTH: undefined,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr: stderr.slice(-400), sent: JSON.stringify(model.requests.slice(before).map((request) => request.body)) }
}

test("the person's own linked agent and skill are used from a project and from the home folder", async () => {
  const repo = path.join(root, "work", "repo")
  await fs.mkdir(repo, { recursive: true })
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0)
  const rows = []
  for (const directory of [repo, root]) {
    const agent = await run(root, directory, ["--trust", "--agent", "mine"])
    const skills = await run(root, directory, ["--trust"])
    rows.push([
      agent.code === 0 && agent.sent.includes("MINE-AGENT-PROMPT-MARKER"),
      skills.sent.includes("OWN-SKILL-DESCRIPTION-MARKER"),
    ])
  }
  expect(rows).toEqual([
    [true, true],
    [true, true],
  ])
}, 600_000)

for (const homeIsRepo of [true, false])
  test(`a downloaded folder whose .orbit is a link out sends nothing from it, home ${homeIsRepo ? "is" : "is not"} a repository`, async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-supplies-link-")))
    try {
      await model.configure(home)
      await Bun.write(
        path.join(home, "work", "secret", ".orbit", "skills", "private", "SKILL.md"),
        skill("private", "SECRET-PROJECT-SKILL-MARKER"),
      )
      const directory = path.join(home, "Downloads", "x")
      await fs.mkdir(directory, { recursive: true })
      await fs.symlink(path.join(home, "work", "secret", ".orbit"), path.join(directory, ".orbit"), kind)
      if (homeIsRepo) expect(Bun.spawnSync(["git", "init", "--quiet", home]).exitCode).toBe(0)
      // The folder is not trusted, so the run stops before it reads anything of it, and nothing reaches the model.
      const result = await run(home, directory, [])
      expect(result.code).toBe(1)
      // The run keeps the end of stderr, which is the advice on how to trust the folder.
      expect(result.stderr).toContain("--trust")
      expect(result.sent).toBe("[]")
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }, 600_000)
