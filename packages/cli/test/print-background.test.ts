import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel } from "./fixture/scripted-model"

// A command the auto-background timeout moved is still the run's business: the headless runner waits for it and for the
// step its completion notice starts, instead of stopping the server under it (task shell-safety-7, M3 verification).
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

test.each([
  ["orb run", (model: string) => ["run", "--standalone", "--yolo", "--format", "json", "--model", model, "go"]],
  ["orb -p", (model: string) => ["-p", "--standalone", "--yolo", "--model", model, "go"]],
])(
  "%s waits for a command moved to the background and for the step its notice starts",
  async (_name, args) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-bg-")))
    roots.push(root)
    const workspace = path.join(root, "workspace")
    await fs.mkdir(workspace, { recursive: true })
    const marker = path.join(workspace, "marker-done.txt").replaceAll("\\", "/")
    const bun = process.execPath.replaceAll("\\", "/")
    // One scripted model per run: it answers by the step's position in its script.
    const model = scriptedModel([
      {
        tool: {
          name: "Bash",
          input: {
            command: `'${bun}' -e "await Bun.sleep(3000); await Bun.write('${marker}','x')"`,
            description: "slow command",
          },
        },
      },
      "WAITING-TEXT",
      "AFTER-NOTIFICATION",
    ])
    try {
      await model.configure(root)
      const file = path.join(root, "config", "orbit.json")
      await Bun.write(file, JSON.stringify({ ...(await Bun.file(file).json()), shell_tool: { timeout: 1000 } }))
      const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args(model.model)], {
        cwd: path.join(import.meta.dir, ".."),
        env: isolatedEnv(root, {
          USERPROFILE: root,
          PWD: workspace,
          ORBIT_CONFIG: undefined,
          ORBIT_CONFIG_CONTENT: undefined,
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(code).toBe(0)
      expect(model.steps.length).toBe(3)
      expect(stdout).toContain("AFTER-NOTIFICATION")
      expect(await Bun.file(marker).exists()).toBe(true)
    } finally {
      model.stop()
    }
  },
  120_000,
)
