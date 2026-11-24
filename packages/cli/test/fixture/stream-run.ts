// The root folder, workspace and helpers that run/stream.test.ts and run/stream-input.test.ts share. Each file that
// imports this gets a root of its own, made before its tests and removed after them.
import { afterAll, beforeAll } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { controller as start } from "./stream-controller"

export const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-")))
export const workspace = path.join(root, "workspace")

beforeAll(async () => {
  await fs.mkdir(workspace, { recursive: true })
  // Writes ask, so a run has something for the controller to decide.
  await Bun.write(path.join(workspace, "orbit.json"), JSON.stringify({ permission: { edit: "ask" } }))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

export const controller = (home: string, own: Parameters<typeof start>[1], args: string[] = []) =>
  start(home, own, { args, workspace })

export const write = (name: string, extra: Record<string, unknown> = {}) => ({
  tool: { name: "Write", input: { file_path: path.join(workspace, name), content: "written", ...extra } },
})

export const slow = { chunks: ["slow"], delayMs: 60_000 }

export const question = {
  tool: {
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          options: [
            { label: "Alpha", description: "a" },
            { label: "Beta", description: "b" },
          ],
        },
      ],
    },
  },
}

// `orb` with its standard input closed, for the checks that end before any input is read.
export async function spawnOrb(home: string, own: { model: string }, args: string[], env: Record<string, string> = {}) {
  const { isolatedEnv } = await import("../fixture/environment")
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/index.ts",
      ...args.slice(0, 1),
      "--standalone",
      "--model",
      own.model,
      ...args.slice(1),
    ],
    {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: isolatedEnv(home, {
        USERPROFILE: home,
        PWD: workspace,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        ...env,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
