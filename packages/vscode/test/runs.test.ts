import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decide, decisionText, decodeNodes, decodeRuns, nodeItem, nodes, orb, runItem, runs } from "../src/runs"

// `orb` from source behind a wrapper script. orb reads the working directory from PWD, which the wrapper's own `cd`
// would change, so it hands on the directory it was called from. `orb flow run` runs a workflow's code only in a trusted
// folder, so the wrapper trusts the test repository the way the CLI tests' environment does.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-runs-"))
const cli = path.join(import.meta.dir, "..", "..", "cli")
const executable = path.join(root, "orb")
await Bun.write(
  executable,
  [
    "#!/bin/sh",
    `export HOME="${root}" XDG_STATE_HOME="${root}/state" XDG_DATA_HOME="${root}/data"`,
    `export XDG_CONFIG_HOME="${root}/config" XDG_CACHE_HOME="${root}/cache" ORBIT_DISABLE_FILEWATCHER=true`,
    "export ORBIT_TRUST_PROJECT=1",
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

test("writes out control characters that a run store holds, in labels and tooltips", () => {
  const hostile = "a\u202Eb\u001b[2Jc"
  const run = runItem({ id: hostile, workflow: hostile, status: "failed", updated: 0 })
  const node = nodeItem({
    id: hostile,
    status: "failed",
    attempts: 1,
    message: hostile,
    error: { message: hostile },
    started: 0,
  })
  const lying = runItem({ id: "a", workflow: "w", status: hostile as "failed", updated: 0 })
  const words = decisionText(true, hostile, hostile)
  for (const text of [
    run.label,
    run.tooltip,
    node.label,
    node.tooltip,
    lying.description,
    lying.tooltip,
    words.title,
    words.failure,
    words.done,
    decisionText(false, hostile, hostile).title,
  ]) {
    expect(text).not.toContain("\u202E")
    expect(text).not.toContain("\u001b")
  }
})

test("decodes a run store's JSON once: strings and finite numbers are kept, anything else costs only itself", () => {
  const hostile = "a\u202Eb\u001b[2Jc"
  const items = decodeNodes({
    nodes: [
      {
        id: "odd",
        status: "succeeded",
        attempts: 1,
        started: 0,
        ended: 1,
        result: { usage: { input: hostile, output: 2, cost: hostile } },
      },
      {
        id: "loud",
        status: "succeeded",
        attempts: 1,
        started: 0,
        result: { usage: { input: 1, output: 2, cost: { a: 1 } } },
      },
      { id: 7, status: "failed" },
      null,
      { id: "plain", status: hostile, attempts: hostile, started: hostile, error: { message: 7 }, message: 3 },
    ],
  }).map(nodeItem)

  expect(items.map((item) => item.label)).toEqual(["odd", "loud", "plain"])
  expect(items[0].description).toBe("2 tokens \u00B7 0s")
  expect(items[1].description).toBe("3 tokens")
  expect(items[2]).toMatchObject({ icon: "error", tooltip: "plain" })
  for (const item of items)
    for (const text of [item.label, item.description, item.tooltip]) expect(text).not.toMatch(/[\u202E\u001b]/)
  expect(decodeNodes("nope")).toEqual([])
  expect(decodeRuns([{ id: "r", workflow: hostile, status: hostile, updated: "x" }, "x", { id: 1 }])).toEqual([
    { id: "r", workflow: hostile, status: "failed", updated: 0 },
  ])
})
