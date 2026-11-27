import path from "node:path"
import { isolatedEnv } from "./environment"
import { startSlot } from "./start-gate"
import { tmpdir } from "./tmpdir"

const pkg = path.join(import.meta.dir, "..", "..")

/**
 * Runs `orb` from source to its end, as the tests that only read what a command prints run it. A child that took the
 * parent's environment used the runner's own data, config and state folders, which every worker and file of a CI job
 * shared, and started without a start slot: on a loaded Windows runner such an `orb session export` did not answer in
 * 30 s although it takes under a second alone (run 45902385785). Here the child gets `isolatedEnv` below a fresh folder
 * of its own (or `home`), and it holds a start slot until it exits, as these commands answer only by exiting.
 */
export async function runOrb(
  args: string[],
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdin?: string
    home?: string
    /** Bun's own arguments before `run`, for example a config file. */
    bun?: string[]
  } = {},
) {
  await using root = options.home === undefined ? await tmpdir() : undefined
  // Awaited here, so the folder is removed only once the child has ended.
  return await startSlot(async () => {
    const child = Bun.spawn([process.execPath, ...(options.bun ?? []), "run", path.join(pkg, "src", "index.ts"), ...args], {
      cwd: options.cwd ?? pkg,
      env: isolatedEnv(options.home ?? root!.path, options.env),
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  })
}
