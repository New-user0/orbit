import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel } from "./fixture/scripted-model"

const model = scriptedModel(["ok"])
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-managed-bypass-"))
await model.configure(root)
const closed = path.join(root, "managed-closed")
const open = path.join(root, "managed-open")
const asking = path.join(root, "managed-asking")
const askingOpen = path.join(root, "managed-asking-open")
const project = path.join(root, "project")

await Promise.all([
  Bun.write(
    path.join(closed, "managed-settings.json"),
    JSON.stringify({ managed: { disable_bypass_permissions: true } }),
  ),
  Bun.write(path.join(open, "managed-settings.json"), JSON.stringify({ managed: { organization: "Acme" } })),
  // Bypass is off and every shell command is asked about: with the mode dropped, the question is declined headless.
  Bun.write(
    path.join(asking, "managed-settings.json"),
    JSON.stringify({
      managed: { disable_bypass_permissions: true },
      permissions: [{ action: "Bash", resource: "*", effect: "ask" }],
    }),
  ),
  Bun.write(
    path.join(askingOpen, "managed-settings.json"),
    JSON.stringify({ permissions: [{ action: "Bash", resource: "*", effect: "ask" }] }),
  ),
  Bun.write(path.join(project, "workflow.ts"), `export default { name: "w", run: () => "done" }`),
  Bun.write(
    path.join(project, "suite.ts"),
    `export default { name: "s", tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`,
  ),
])

afterAll(async () => {
  model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function orb(args: string[], managed: string, extra: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { USERPROFILE: root, PWD: project, ORBIT_MANAGED_DIR: managed, ...extra }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  return { code, output: stdout + stderr, stdout, stderr }
}

const notice = "turned off by your organization's managed settings"
const occurrences = (text: string) => text.split(notice).length - 1
const useModel = ["--model", model.model]

// Every door of the command line that can select the mode that skips permission prompts. With managed settings that
// turn it off, each ignores the mode, prints the notice once and goes on (FU-M3-307).
const doors = {
  "run --auto": ["run", "--standalone", ...useModel, "--auto", "say ok"],
  "run --yolo": ["run", "--standalone", ...useModel, "--yolo", "say ok"],
  "run --dangerously-skip-permissions": ["run", "--standalone", ...useModel, "--dangerously-skip-permissions", "say ok"],
  "-p --auto": ["-p", "--standalone", ...useModel, "--auto", "say ok"],
  "-p --dangerously-skip-permissions": ["-p", "--standalone", ...useModel, "--dangerously-skip-permissions", "say ok"],
  "loop --auto": ["loop", "--standalone", ...useModel, "--auto", "--times", "1", "10s", "say ok"],
  "flow run --auto": ["flow", "run", "--standalone", "--auto", "workflow.ts"],
  "eval --auto": ["eval", "--standalone", "--auto", "--models", model.model, "suite.ts"],
}

describe("orb with managed settings that turn bypass off", () => {
  for (const [name, args] of Object.entries(doors)) {
    test(`${name} goes on without the mode and prints the notice once`, async () => {
      const result = await orb(args, closed)
      expect(result.code).toBe(0)
      expect(occurrences(result.output)).toBe(1)
    }, 90_000)
  }

  test("--format json puts the notice in a warning line of the same stream", async () => {
    const result = await orb(["run", "--standalone", ...useModel, "--auto", "--format", "json", "say ok"], closed)
    expect(result.code).toBe(0)
    const lines = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(lines.filter((line) => line.type === "warning")).toEqual([
      expect.objectContaining({ message: expect.stringContaining(notice) }),
    ])
    expect(occurrences(result.stderr)).toBe(0)
  }, 90_000)

  test("the root command goes on to the terminal UI instead of being refused", async () => {
    const result = await orb(["--standalone", "--auto"], closed)
    expect(occurrences(result.output)).toBe(1)
  }, 90_000)

  // Dropping the mode is never wider than refusing: the run keeps asking, and a question nobody can answer is declined.
  test("a managed ask in the run is declined where nothing can answer", async () => {
    const marker = path.join(project, "asked.txt")
    await fs.rm(marker, { force: true })
    const asked = scriptedModel([{ tool: { name: "Bash", input: { command: "echo hi > asked.txt" } } }, "done"])
    await asked.configure(root)
    try {
      const result = await orb(
        ["run", "--standalone", "--model", asked.model, "--auto", "do it"],
        asking,
      )
      expect(occurrences(result.output)).toBe(1)
      expect(result.output).toContain("auto-rejecting")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      asked.stop()
      await model.configure(root)
    }
  }, 90_000)

  test("control: with bypass allowed the same ask is answered and the command runs", async () => {
    const marker = path.join(project, "asked.txt")
    await fs.rm(marker, { force: true })
    const asked = scriptedModel([{ tool: { name: "Bash", input: { command: "echo hi > asked.txt" } } }, "done"])
    await asked.configure(root)
    try {
      const result = await orb(["run", "--standalone", "--model", asked.model, "--auto", "do it"], askingOpen)
      expect(occurrences(result.output)).toBe(0)
      expect(result.output).not.toContain("auto-rejecting")
      expect(await Bun.file(marker).exists()).toBe(true)
    } finally {
      asked.stop()
      await model.configure(root)
      await fs.rm(marker, { force: true })
    }
  }, 90_000)

  test("a run that does not ask to skip prompts prints no notice", async () => {
    const result = await orb(["flow", "run", "--standalone", "workflow.ts"], closed)
    expect(occurrences(result.output)).toBe(0)
    expect(result.code).toBe(0)
  }, 90_000)

  test("the same flags print no notice when managed settings leave bypass open", async () => {
    const result = await orb(["flow", "run", "--standalone", "--auto", "workflow.ts"], open)
    expect(occurrences(result.output)).toBe(0)
    expect(result.code).toBe(0)
  }, 90_000)
})
