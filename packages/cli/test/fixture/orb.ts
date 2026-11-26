import path from "node:path"
import { isolatedEnv } from "./environment"
import { takeStartSlot } from "./start-gate"
import { tmpdir } from "./tmpdir"

const pkg = path.join(import.meta.dir, "..", "..")

/**
 * Runs `orb` from source to its end, as the tests that only read what a command prints run it. A child that took the
 * parent's environment used the runner's own data, config and state folders, which every worker and file of a CI job
 * shared, and started without a start slot: on a loaded Windows runner such an `orb session export` did not answer in
 * 30 s although it takes under a second alone. Here the child gets `isolatedEnv` below a fresh folder of its own (or
 * `home`) and holds a start slot until it first writes or exits, as the other cli children do.
 */
export async function runOrb(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; home?: string } = {},
) {
  await using root = options.home === undefined ? await tmpdir() : undefined
  const release = once(await takeStartSlot())
  const child = Bun.spawn([process.execPath, "run", path.join(pkg, "src", "index.ts"), ...args], {
    cwd: options.cwd ?? pkg,
    env: isolatedEnv(options.home ?? root!.path, options.env),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    text(child.stdout, release),
    text(child.stderr, release),
    child.exited.finally(release),
  ])
  return { stdout, stderr, exitCode }
}

// The whole stream as text; `started` runs at its first chunk.
async function text(stream: ReadableStream<Uint8Array>, started: () => void) {
  const decoder = new TextDecoder()
  const parts: string[] = []
  for await (const chunk of stream) {
    started()
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  return parts.join("") + decoder.decode()
}

function once(run: () => void) {
  const state = { done: false }
  return () => {
    if (state.done) return
    state.done = true
    run()
  }
}
