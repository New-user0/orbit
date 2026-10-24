import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./environment"
import { scriptedModel, type ScriptedReply } from "./scripted-model"

export type Line = Record<string, any>

/**
 * A running `orb` whose standard input the test writes line by line while it reads the lines that come out. Every run is
 * a child process of src/index.ts, so the flags, the handler, the trust gate and the driver are the ones a controller
 * reaches, and a hang fails on its deadline instead of blocking the runner.
 */
export function controller(
  home: string,
  own: ReturnType<typeof scriptedModel>,
  options: { args?: string[]; workspace: string; env?: Record<string, string | undefined>; print?: boolean },
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/index.ts",
      ...(options.print === false ? ["run"] : ["-p"]),
      "--standalone",
      "--model",
      own.model,
      "--input-format",
      "stream-json",
      options.print === false ? "--format" : "--output-format",
      "stream-json",
      ...(options.args ?? []),
    ],
    {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: isolatedEnv(home, {
        USERPROFILE: home,
        PWD: options.workspace,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        OLLAMA_CONTEXT_LENGTH: undefined,
        ...options.env,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const lines: Line[] = []
  const raw: string[] = []
  const waiters: Array<() => void> = []
  const reader = child.stdout.getReader()
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) break
      const chunk = next.value
      buffer += decoder.decode(chunk, { stream: true })
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      parts
        .filter((part) => part.trim() !== "")
        .forEach((part) => {
          raw.push(part)
          lines.push(JSON.parse(part))
        })
      waiters.splice(0).forEach((resolve) => resolve())
    }
  })()
  const stderr = new Response(child.stderr).text()
  return {
    child,
    lines,
    raw,
    send(value: unknown) {
      child.stdin.write(typeof value === "string" ? value : JSON.stringify(value) + "\n")
      child.stdin.flush()
    },
    sendBytes(bytes: Uint8Array) {
      child.stdin.write(bytes)
      child.stdin.flush()
    },
    end() {
      child.stdin.end()
    },
    /** Stops reading standard output, so the next write of the child fails like a program that has gone away. */
    abandon() {
      return reader.cancel()
    },
    /** Waits for the first line that matches at or after `from`, and returns it with the index to continue from. */
    async until(match: (line: Line) => boolean, from = 0, ms = 90_000) {
      const deadline = Date.now() + ms
      while (true) {
        const index = lines.findIndex((line, at) => at >= from && match(line))
        if (index !== -1) return { line: lines[index], next: index + 1 }
        if (Date.now() > deadline) {
          // A child left running keeps the test's temp folder open, and the removal after the test fails with EBUSY.
          child.kill("SIGKILL")
          throw new Error(`No matching line in ${ms} ms. Lines: ${JSON.stringify(lines)}`)
        }
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), Bun.sleep(250)])
      }
    },
    async finish(ms = 120_000) {
      const code = await Promise.race([
        child.exited,
        Bun.sleep(ms).then(() => {
          child.kill("SIGKILL")
          throw new Error(`The run did not exit. Lines: ${JSON.stringify(lines)}`)
        }),
      ])
      await reading
      return { code, stderr: await stderr }
    },
  }
}

export async function scripted<T>(
  replies: ReadonlyArray<ScriptedReply>,
  run: (own: ReturnType<typeof scriptedModel>, home: string) => Promise<T>,
  extraModels: ReadonlyArray<string> = [],
) {
  const own = scriptedModel(replies, undefined, undefined, extraModels)
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-own-")))
  await own.configure(home)
  try {
    return await run(own, home)
  } finally {
    await own.stop()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

/** Waits until the model has been asked for this many steps, so an interrupt lands while a call is in flight. */
export async function modelAsked(own: ReturnType<typeof scriptedModel>, steps: number, ms = 90_000) {
  const deadline = Date.now() + ms
  while (own.steps.length < steps) {
    if (Date.now() > deadline) throw new Error(`The model was asked for ${own.steps.length} of ${steps} steps`)
    await Bun.sleep(100)
  }
}

export const results = (lines: Line[]) => lines.filter((line) => line.type === "result")
