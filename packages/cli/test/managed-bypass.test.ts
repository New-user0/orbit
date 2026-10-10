import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-managed-bypass-"))
const closed = path.join(root, "managed-closed")
const open = path.join(root, "managed-open")
const project = path.join(root, "project")

await Promise.all([
  Bun.write(path.join(closed, "managed-settings.json"), JSON.stringify({ managed: { disable_bypass_permissions: true } })),
  Bun.write(path.join(open, "managed-settings.json"), JSON.stringify({ managed: { organization: "Acme" } })),
  Bun.write(path.join(project, "workflow.ts"), `export default { name: "w", run: () => "done" }`),
  Bun.write(
    path.join(project, "suite.ts"),
    `export default { name: "s", tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`,
  ),
])

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

async function orb(args: string[], managed: string) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { USERPROFILE: root, PWD: project, ORBIT_MANAGED_DIR: managed }),
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
  return { code, output: stdout + stderr }
}

const message = "turned off by your organization's managed settings"

// Every door of the command line that can select the mode that skips permission prompts.
const doors = {
  "run --auto": ["run", "--standalone", "--auto", "say ok"],
  "run --yolo": ["run", "--standalone", "--yolo", "say ok"],
  "run --dangerously-skip-permissions": ["run", "--standalone", "--dangerously-skip-permissions", "say ok"],
  "-p --auto": ["-p", "--standalone", "--auto", "say ok"],
  "-p --dangerously-skip-permissions": ["-p", "--standalone", "--dangerously-skip-permissions", "say ok"],
  "loop --auto": ["loop", "--standalone", "--auto", "--times", "1", "10s", "say ok"],
  "flow run --auto": ["flow", "run", "--standalone", "--auto", "workflow.ts"],
  "eval --auto": ["eval", "--standalone", "--auto", "--models", "x/y", "suite.ts"],
}

describe("orb with managed settings that turn bypass off", () => {
  for (const [name, args] of Object.entries(doors)) {
    test(`${name} exits non-zero with the managed message`, async () => {
      const result = await orb(args, closed)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain(message)
    }, 90_000)
  }

  test("a run that does not ask to skip prompts is not stopped by it", async () => {
    const result = await orb(["flow", "run", "--standalone", "workflow.ts"], closed)
    expect(result.output).not.toContain(message)
    expect(result.code).toBe(0)
  }, 90_000)

  test("the same flags are not refused when managed settings leave bypass open", async () => {
    const result = await orb(["flow", "run", "--standalone", "--auto", "workflow.ts"], open)
    expect(result.output).not.toContain(message)
    expect(result.code).toBe(0)
  }, 90_000)
})
