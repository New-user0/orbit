// Commands that read the run store, the version control programs of a clone, and review doors. The scripted model, the
// shared root and the helpers are in fixture/trust-harness.ts; every `orb` here runs without ORBIT_TRUST_PROJECT, so a
// folder is trusted only when a grant says so, and each test uses a repository of its own.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { refusal } from "../src/util/trust"
import {
  model,
  runs,
  toolAnswers,
  root,
  workflow,
  suite,
  mark,
  user,
  hooked,
  quiet,
  bare,
  orb,
  spawned,
  finished,
  succeeded,
  readOnNextReview
} from "./fixture/trust-harness"

// `orb -p --trust false` once sent "false ..." as the message with the folder trusted, where `orb run --trust false`
// refuses it. A word after a bare flag that widens what runs is a usage error before anything starts.
test("orb -p with a word after a flag that widens what runs starts nothing", async () => {
  const repository = await hooked("print-widening")
  const marker = path.join(repository, "print.marker")
  await Bun.write(
    path.join(repository, ".orbit", "plugins", "mark.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "loaded")\nexport default { id: "mark", async setup() {} }`,
  )
  const before = runs
  const rows = ["--trust", "--auto", "--yolo", "--dangerously-skip-permissions"].flatMap((flag) =>
    ["false", "off"].map((word) => [flag, word] as const),
  )

  for (const [flag, word] of rows) {
    const result = await orb(repository, ["-p", "--standalone", flag, word, "--model", model, "say ok"])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("ambiguous")
  }
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(runs).toBe(before)
}, 300_000)

// Class 1 and class 12 (review of #118): `orb flow clean` removes branches, which runs the hooks that the folder's own config
// names, and the commands that only read the run store looked for the repository root with a git process in the folder.
// A hook that leaves a marker is the oracle; a trusted run is the control that the hook is live.
test("orb flow clean runs no hook of an untrusted repository, and the commands that read the run store start no git", async () => {
  const repository = await hooked("flow-clean")
  const vcs = async (...args: string[]) => (await spawned(["git", ...args], repository)).code
  expect(await vcs("init", "--quiet", "-b", "main")).toBe(0)
  expect(await vcs("config", "user.email", "t@orbit.test")).toBe(0)
  expect(await vcs("config", "user.name", "T")).toBe(0)
  expect(await vcs("config", "commit.gpgsign", "false")).toBe(0)
  expect(await vcs("commit", "--allow-empty", "-q", "-m", "root")).toBe(0)
  // A run that finished, made while the folder is trusted.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", workflow]))
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  expect(await vcs("branch", `orbit/${id}/n`)).toBe(0)
  // The clone's own config names a hook for every update of a ref.
  const marker = path.join(root, "flow-clean-hook.marker")
  const hook = path.join(repository, "hooks", "reference-transaction")
  await Bun.write(hook, `#!/bin/sh\necho ran >> "${marker.replaceAll("\\", "/")}"\n`)
  await fs.chmod(hook, 0o755)
  expect(await vcs("config", "core.hooksPath", "hooks")).toBe(0)

  const trace = path.join(root, "flow-clean-trace.txt")
  for (const args of [
    ["ls", "--format", "json"],
    ["show", id],
    ["cost", id],
    ["trace", id],
  ]) {
    await fs.rm(trace, { force: true })
    await orb(repository, ["flow", ...args, "--standalone"], { GIT_TRACE2: trace })
    expect(await Bun.file(trace).exists()).toBe(false)
  }

  const refused = await orb(repository, ["flow", "clean", "--standalone"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("is not trusted")
  expect(await Bun.file(marker).exists()).toBe(false)

  // The control: trusted for this command, the same branch removal runs the hook.
  succeeded(await orb(repository, ["flow", "clean", "--trust", "--standalone"]))
  expect(await Bun.file(marker).exists()).toBe(true)
}, 300_000)

// Class 1 and class 12 (M4 round 4): `orb flow run`, `flow resume`, `eval` and `flow replay` started the folder's version
// control to find its root, its head and its changes, which applies the config a clone ships. Each key below names a
// program of the clone; a marker is the oracle, and the trace of the version control shows that no process of it started
// at all. The workflow and the suite are the person's files outside the clone and define nothing; since trust-first every
// door refuses the untrusted folder before it starts any work there (`requireTrust`), and the flow runner's own
// `options.trusted` gate on `Git.root` stays behind it. The trusted control shows that each key is live: with `--trust`
// the same door runs it.
const gateFile = path.join(root, "vcs-gate.yaml")
const taskSuite = path.join(root, "vcs-suite.json")

const unix = (file: string) => file.replaceAll("\\", "/")

const programKeys = [
  {
    name: "core.fsmonitor",
    arm: async (repository: string, marker: string) => {
      const script = `${repository}-fsmonitor.sh`
      await Bun.write(script, `#!/bin/sh\necho ran >> "${unix(marker)}"\n`)
      await fs.chmod(script, 0o755)
      return ["config", "core.fsmonitor", unix(script)]
    },
  },
  {
    name: "filter.<driver>.clean",
    arm: async (repository: string, marker: string) => {
      const script = `${repository}-clean.sh`
      await Bun.write(script, `#!/bin/sh\necho ran >> "${unix(marker)}"\ncat\n`)
      await fs.chmod(script, 0o755)
      return ["config", "filter.marker.clean", unix(script)]
    },
  },
  {
    name: "hooks/post-checkout",
    arm: async (repository: string, marker: string) => {
      const hook = path.join(repository, ".git", "hooks", "post-checkout")
      await Bun.write(hook, `#!/bin/sh\necho ran >> "${unix(marker)}"\n`)
      await fs.chmod(hook, 0o755)
      return undefined
    },
  },
] as const

// A repository with one commit and a run that waits at a gate (so `resume` has one), made while the folder is trusted and
// before the key exists. Then the key, and a tracked file that differs from the index, which is what makes the version
// control run a clean filter or a file system monitor.
async function armed(name: string, key: (typeof programKeys)[number]) {
  const repository = await bare(name)
  const marker = path.join(root, `${name}.marker`)
  const vcs = async (...args: string[]) => (await spawned(["git", ...args], repository)).code
  expect(await vcs("init", "--quiet", "-b", "main")).toBe(0)
  expect(await vcs("config", "user.email", "t@orbit.test")).toBe(0)
  expect(await vcs("config", "user.name", "T")).toBe(0)
  expect(await vcs("config", "commit.gpgsign", "false")).toBe(0)
  await Bun.write(path.join(repository, ".gitattributes"), "*.txt filter=marker\n")
  await Bun.write(path.join(repository, "a.txt"), "one\n")
  expect(await vcs("add", "-A")).toBe(0)
  expect(await vcs("commit", "-q", "-m", "root")).toBe(0)
  await Bun.write(gateFile, "name: pause\nnodes:\n  - id: approve\n    type: gate\n    message: Go on?\n")
  await Bun.write(taskSuite, JSON.stringify({ name: "vcs", tasks: [{ id: "task", prompt: "say ok", checks: [] }] }))
  expect((await orb(repository, ["flow", "run", "--trust", "--standalone", gateFile])).code).toBe(2)
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  succeeded(await orb(repository, ["flow", "approve", "--standalone", "--trust", id, "approve"]))
  const config = await key.arm(repository, marker)
  if (config) expect(await vcs(...config)).toBe(0)
  await Bun.write(path.join(repository, "a.txt"), "two\n")
  return { repository, marker, id }
}

for (const key of programKeys) {
  const slug = key.name.replace(/\W+/g, "-")

  test(`orb flow run, resume, replay and eval start no git, and so run no ${key.name} program, in an untrusted clone`, async () => {
    const { repository, marker, id } = await armed(`vcs-${slug}`, key)
    const trace = `${repository}-trace.txt`
    const doors = [
      ["flow run", ["flow", "run", "--standalone", gateFile]],
      ["flow resume", ["flow", "resume", "--standalone", id]],
      ["flow replay", ["flow", "replay", "--standalone", id]],
      ["eval", ["eval", taskSuite, "--standalone"]],
    ] as const

    for (const [door, args] of doors) {
      await fs.rm(trace, { force: true })
      await fs.rm(marker, { force: true })
      const result = await orb(repository, [...args], { GIT_TRACE2: trace })
      // The folder is not trusted, so every door stops before it starts any work there, whatever the file defines
      // (trust-first): a resume and a replay before they open the run store, a run and an eval before they load the file.
      expect({ door, refused: result.stderr.includes("is not trusted") }).toEqual({ door, refused: true })
      expect({ door, ran: await Bun.file(marker).exists() }).toEqual({ door, ran: false })
      // The tasks of an eval run agents in the folder, which this row does not judge; what must not appear is a process of
      // the runner's own, which reads the clone itself.
      const started =
        ((await Bun.file(trace).exists()) ? await Bun.file(trace).text() : "").match(/cmd_name \S+/g) ?? []
      const runner = new Set(["rev-parse", "worktree", "branch", "reset", "merge", "commit"])
      expect({
        door,
        started: door === "eval" ? started.filter((item) => runner.has(item.slice(9))) : started,
      }).toEqual({
        door,
        started: [],
      })
    }
  }, 600_000)

  test(`the ${key.name} program of a trusted clone runs from the same doors: the control for the rows above`, async () => {
    const { repository, marker } = await armed(`vcs-control-${slug}`, key)
    // The hook needs a worktree, which only the tasks of an eval add; the other keys run on the first call of a run.
    const args = key.name.startsWith("hooks/")
      ? ["eval", taskSuite, "--trust", "--standalone"]
      : ["flow", "run", "--trust", "--standalone", gateFile]
    await orb(repository, args)
    expect(await Bun.file(marker).exists()).toBe(true)
  }, 600_000)
}

// Classes 1, 5 and 12 (M4 rounds 4 to 6): a run store is a file that a clone ships, and a run that goes on from it
// picks up what it records: the base commit and the worktree that the review diff starts git in, and the folder that a
// reviewer's session opens in, where the reviewer can read any file and send it to the provider. So `flow resume`,
// `eval --resume` and `flow replay` refuse an untrusted folder before they open the store. The store below records a
// finished verify iteration whose worktree is a copy of the clone outside it, holding a secret, with a base of HEAD. The
// clone's config names a file system monitor that leaves a marker when git runs, and the scripted reviewer answers its
// first review with a Read of the secret. The key of the recorded node is the one a runner in a trusted folder computes,
// as the clone that ships such a store would compute it, so a resume reuses the node and goes on to the review.
// Untrusted: refused with status 1 and the store as the reason, with no model request, no git and no read. The --trust
// control gets past the gate: a resume and an eval review in the recorded folder, start git and read the secret, and a
// replay answers from the recording.
// Mutation: dropping the `strict: "recorded"` gate from `flow resume` or `flow replay`, or the `trustRefusal` gate from
// `eval`, fails that door's untrusted rows; the trusted rows pass either way.
const secret = "SECRET-5e1c7a"
const reviewFlow = {
  workflow: "review",
  node: "v",
  file: "review.yaml",
  text: "name: review\nnodes:\n  - id: v\n    type: verify\n    prompt: x\n    judge: true\n",
  key: { prompt: "x", worktree: true, within: { worktree: "v" } },
}
const reviewSuite = {
  workflow: "eval:reviewed",
  node: `${model}.task`,
  file: "suite.json",
  text: JSON.stringify({ name: "reviewed", tasks: [{ id: "task", prompt: "x", checks: [], judge: true }] }),
  key: { prompt: "x", model, worktree: true, within: { worktree: `${model}.task` } },
}
const resumeDoors = [
  {
    door: "flow resume",
    ...reviewFlow,
    json: false,
    reviews: true,
    args: (id: string, trust: string[]) => ["flow", "resume", ...trust, "--standalone", id],
  },
  {
    door: "eval --resume",
    ...reviewSuite,
    json: false,
    reviews: true,
    args: (id: string, trust: string[]) => ["eval", "suite.json", ...trust, "--resume", id, "--standalone"],
  },
  {
    door: "eval --resume --format json",
    ...reviewSuite,
    json: true,
    reviews: true,
    args: (id: string, trust: string[]) => [
      "eval",
      "suite.json",
      ...trust,
      "--resume",
      id,
      "--format",
      "json",
      "--standalone",
    ],
  },
  {
    door: "flow replay",
    ...reviewFlow,
    json: false,
    reviews: false,
    args: (id: string, trust: string[]) => ["flow", "replay", ...trust, "--standalone", id],
  },
] as const

for (const door of resumeDoors)
  for (const trust of [false, true])
    test(`${door.door} of a run store that the clone ships ${trust ? "goes on from it with --trust (control)" : "is refused in an untrusted clone before the store is read, with no model request, git or read"}`, async () => {
      const { createHash } = await import("node:crypto")
      const { Store } = await import("@orbit/flow")
      const name = `resume-${door.door.replace(/\W+/g, "-")}-${trust}`
      const repository = await bare(name)
      const vcs = async (directory: string, ...args: string[]) => (await spawned(["git", ...args], directory)).code
      expect(await vcs(repository, "init", "--quiet", "-b", "main")).toBe(0)
      expect(await vcs(repository, "config", "user.email", "t@orbit.test")).toBe(0)
      expect(await vcs(repository, "config", "user.name", "T")).toBe(0)
      expect(await vcs(repository, "config", "commit.gpgsign", "false")).toBe(0)
      await Bun.write(path.join(repository, "a.txt"), "one\n")
      expect(await vcs(repository, "add", "a.txt")).toBe(0)
      expect(await vcs(repository, "commit", "-q", "-m", "one")).toBe(0)
      // The folder the store names: a copy of the clone outside it, so a diff from HEAD works there, with a file of the
      // person's in it.
      const outside = path.join(root, "work", `${name}-outside`)
      expect(await vcs(root, "clone", "--quiet", repository, outside)).toBe(0)
      const target = path.join(outside, "secret.txt")
      await Bun.write(target, `${secret}\n`)
      const marker = path.join(root, `${name}.marker`)
      const script = path.join(root, `${name}.sh`)
      await Bun.write(script, `#!/bin/sh\necho ran >> "${unix(marker)}"\n`)
      await fs.chmod(script, 0o755)
      expect(await vcs(repository, "config", "core.fsmonitor", unix(script))).toBe(0)
      await Bun.write(path.join(repository, "a.txt"), "two\n")
      await Bun.write(path.join(repository, door.file), door.text)

      const id = "run_20260101000000_abcdef"
      const key = createHash("sha256").update(JSON.stringify(door.key)).digest("hex").slice(0, 16)
      const store = Store.at(repository)
      store.create(
        {
          id,
          workflow: door.workflow,
          file: path.join(repository, door.file),
          directory: repository,
          input: { models: [model] },
        },
        { base: "HEAD" },
      )
      store.append(id, `${door.node}#1`, "node.started", { key })
      store.append(id, `${door.node}#1`, "node.succeeded", {
        key,
        result: {
          id: `${door.node}#1`,
          status: "succeeded",
          text: "done",
          worktree: outside,
          sessions: [],
          attempts: 1,
          usage: {},
        },
      })
      store.status(id, "waiting")
      store.close()
      const before = runs
      const answered = toolAnswers.length
      readOnNextReview(target)

      const result = await orb(repository, door.args(id, trust ? ["--trust"] : [])).finally(() => {
        readOnNextReview(undefined)
      })

      const read = toolAnswers.slice(answered).some((answer) => answer.includes(secret))
      if (!trust) {
        expect(result.code).toBe(1)
        const refusal = door.json ? JSON.parse(result.stdout).error.message : result.stderr
        if (door.json) expect(JSON.parse(result.stdout)).toMatchObject({ type: "error", error: { type: "unknown" } })
        expect(refusal).toContain(`${repository} is not trusted`)
        expect(refusal).toContain("goes on from a run that the folder's run store")
        expect(refusal).toContain("--trust")
        expect({ asked: runs - before, read, git: await Bun.file(marker).exists() }).toEqual({
          asked: 0,
          read: false,
          git: false,
        })
        return
      }
      expect(result.stdout + result.stderr).not.toContain(`${repository} is not trusted`)
      if (!door.reviews) {
        expect(result.stderr).toContain(`= ${door.node}#1 (replayed)`)
        expect(runs).toBe(before)
        return
      }
      // The run goes on from the store, but the worktree it records lies outside the trusted folder, and no session
      // starts in a folder that is not trusted (trust-first): the reviewer of that iteration is refused, so the person's
      // file there is not read. The folder's own version control runs, as it is trusted.
      expect({ read, git: await Bun.file(marker).exists() }).toEqual({ read: false, git: true })
    }, 600_000)

// The refusal comes before the run store is opened: opening it creates `.orbit/runs.db` in a folder that has none, so an
// untrusted folder without a store is left without one, and the --trust control opens it and finds no such run.
// Mutation: moving a door's gate after `openStore` leaves the store behind and fails that door's row.
const absent = "run_20260101000000_abcdef"
test.each([
  ["flow resume", ["flow", "resume", "--standalone", absent], ["flow", "resume", "--trust", "--standalone", absent]],
  [
    "eval --resume",
    ["eval", "suite.json", "--resume", absent, "--standalone"],
    ["eval", "suite.json", "--trust", "--resume", absent, "--standalone"],
  ],
  ["flow replay", ["flow", "replay", "--standalone", absent], ["flow", "replay", "--trust", "--standalone", absent]],
] as const)(
  "%s refuses an untrusted folder before it opens the run store",
  async (door, refusedArgs, trustedArgs) => {
    const folder = await bare(`store-unopened-${door.replace(/\W+/g, "-")}`)
    await Bun.write(path.join(folder, "suite.json"), JSON.stringify({ name: "s", tasks: [] }))
    const store = path.join(folder, ".orbit", "runs.db")

    const refused = await orb(folder, [...refusedArgs])

    expect({ door, code: refused.code, created: await Bun.file(store).exists() }).toEqual({
      door,
      code: 1,
      created: false,
    })
    expect(refused.stderr).toContain(`${folder} is not trusted`)

    const trusted = await orb(folder, [...trustedArgs])

    expect(trusted.stderr).toContain(`No run ${absent} in this repository`)
    expect(await Bun.file(store).exists()).toBe(true)
  },
  240_000,
)
