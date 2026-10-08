import { Orbit } from "@orbit/client"
import path from "node:path"
import { isolatedEnv } from "../../../cli/test/fixture/environment"

/** Polls `read` until it returns something, for as long as `timeout` allows. */
export async function until<T>(read: () => T | undefined, timeout = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  return undefined
}

/**
 * A real `orb serve` on a free port, from source, with its home, config and database under `root`. A second server on the
 * same `root` sees what the first one stored, so a restart is `stop()` and `serve(root)` again. Folders are trusted only by
 * a grant: ORBIT_TRUST_PROJECT is not set, which is how the shared background service behaves.
 */
export async function serve(root: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "serve", "--port", "0"], {
    cwd: path.join(import.meta.dir, "..", "..", "..", "cli"),
    env: isolatedEnv(root, {
      ORBIT_PASSWORD: "secret",
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      ORBIT_TRUST_PROJECT: undefined,
      // On Windows the home directory comes from here and not from HOME.
      USERPROFILE: root,
      ...env,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  // Both pipes are read to the end, so that the server never waits on a full one, and the errors are there to report.
  const errors = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let url: string | undefined
  while (!url) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`orb serve exited: ${output}${await errors}`)
    output += decoder.decode(chunk.value)
    url = /server listening on (\S+)/.exec(output)?.[1]
  }
  void (async () => {
    while (!(await reader.read()).done);
  })()
  return {
    url,
    client: Orbit.make({ baseUrl: url, headers: { authorization: `Basic ${btoa("orbit:secret")}` } }),
    async stop() {
      child.kill()
      await child.exited
    },
  }
}
