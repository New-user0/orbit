// The scripted model, the root folder and the helpers that print.test.ts and print-output.test.ts share. Each file that
// imports this gets a model and a root of its own, made before its tests and removed after them.
import { afterAll, beforeAll, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./environment"
import { scriptedModel, type ScriptedReply } from "./scripted-model"

export const model = scriptedModel(['{"answer":"ok"}'])
export const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-print-")))
export const workspace = path.join(root, "workspace")
export const instructions = "PROJECT-INSTRUCTION-MARKER"
export const schema = path.join(root, "schema.json")

beforeAll(async () => {
  await model.configure(root)
  await fs.mkdir(workspace, { recursive: true })
  await Bun.write(path.join(workspace, "AGENTS.md"), `${instructions}\n`)
  await Bun.write(
    schema,
    JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    }),
  )
})

afterAll(async () => {
  await model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

export async function orb(args: string[], input?: string, home = root, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: isolatedEnv(home, {
      USERPROFILE: home,
      PWD: workspace,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
      ...extraEnv,
    }),
    stdin: input === undefined ? "ignore" : new Response(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

// The user texts the model was sent by one run, one per step.
export async function sent(args: string[]) {
  const before = model.steps.length
  const result = await orb(args)
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  return { ...result, users: model.steps.slice(before).map((step) => step.user), requests: model.steps.slice(before) }
}

export const base = ["--standalone", "--model", model.model]

// The model hands its answer in through the tool the runner adds, then stops with nothing more to say.
export const handIn = (input: unknown): ScriptedReply => ({ tool: { name: "StructuredOutput", input } })
export const accepted = [handIn({ answer: "ok" }), ""]

// Runs with its own scripted model and its own home, so that each script starts at its first step.
export async function scripted<T>(
  replies: ReadonlyArray<ScriptedReply>,
  run: (model: ReturnType<typeof scriptedModel>, home: string) => Promise<T>,
) {
  const own = scriptedModel(replies)
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-print-own-")))
  await own.configure(home)
  try {
    return await run(own, home)
  } finally {
    await own.stop()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

export function parseLines(output: string) {
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// A line of the envelope must hold no character that acts on a terminal, whatever a tool or a title called itself.
export const raw = /[\p{C}\p{Zl}\p{Zp}]/u

// `orb -p` against a model of its own, in the output format that is given, with the flags that are given.
export function print(own: ReturnType<typeof scriptedModel>, home: string, args: string[], format = "json") {
  return orb(["-p", "--standalone", "--model", own.model, "--output-format", format, ...args], undefined, home)
}
