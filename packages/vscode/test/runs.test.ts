import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decide, nodeItem, nodes, orb, runItem, runs } from "../src/runs"

// `orb` from source behind a wrapper script. orb reads the working directory from PWD, which the wrapper's own `cd`
// would change, so it hands on the directory it was called from.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-runs-"))
const cli = path.join(import.meta.dir, "..", "..", "cli")
const executable = path.join(root, "orb")
await Bun.write(
  executable,
  [
    "#!/bin/sh",
    `export HOME="${root}" XDG_STATE_HOME="${root}/state" XDG_DATA_HOME="${root}/data"`,
    `export XDG_CONFIG_HOME="${root}/config" XDG_CACHE_HOME="${root}/cache" ORBIT_DISABLE_FILEWATCHER=true`,
    `cd "${cli}" && PWD="$OLDPWD" exec "${process.execPath}" run src/index.ts "$@"`,
  ].join("\n"),
)
await fs.chmod(executable, 0o755)
const repository = path.join(root, "repo")

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

test("lists runs and their nodes, and approves a waiting gate", async () => {
  await fs.mkdir(repository, { recursive: true })
  await Bun.write(
    path.join(repository, "gate.ts"),
    `export default {
  name: "gated",
  async run(ctx) {
    const decision = await ctx.gate("ship", { message: "Ship it?" })
    return decision
  },
}
`,
  )
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
  ])
    await Bun.spawn(["git", ...args], { cwd: repository, stdout: "ignore", stderr: "ignore" }).exited
  await orb(executable, repository, ["flow", "run", "--standalone", "gate.ts"], 120_000).catch(() => undefined)

  const listed = await runs(executable, repository)

  expect(listed).toHaveLength(1)
  expect(runItem(listed[0])).toMatchObject({ label: "gated", icon: "question", context: "run-waiting" })
  const waiting = await nodes(executable, repository, listed[0].id)
  expect(waiting.map(nodeItem)).toEqual([
    {
      label: "ship",
      description: "waiting for a decision",
      tooltip: "ship\n\nShip it?",
      icon: "question",
      context: "gate",
    },
  ])

  await decide(executable, repository, { run: listed[0].id, gate: "ship", approve: true, note: "go" })

  expect((await nodes(executable, repository, listed[0].id)).map((node) => [node.id, node.status])).toEqual([
    ["ship", "succeeded"],
  ])
  await expect(decide(executable, repository, { run: listed[0].id, gate: "ship", approve: true })).rejects.toThrow(
    "ship is not waiting for a decision",
  )
}, 180_000)
