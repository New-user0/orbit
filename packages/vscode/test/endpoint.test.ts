import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { headers, start, version } from "../src/endpoint"

// `orb` from source behind a wrapper script, isolated in a temporary home so it starts its own background service.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-endpoint-"))
const cli = path.join(import.meta.dir, "..", "..", "cli")
const orb = path.join(root, "orb")
await Bun.write(
  orb,
  [
    "#!/bin/sh",
    `export HOME="${root}" XDG_STATE_HOME="${root}/state" XDG_DATA_HOME="${root}/data"`,
    `export XDG_CONFIG_HOME="${root}/config" XDG_CACHE_HOME="${root}/cache" ORBIT_DISABLE_FILEWATCHER=true`,
    `cd "${cli}" && exec "${process.execPath}" run src/index.ts "$@"`,
  ].join("\n"),
)
await fs.chmod(orb, 0o755)

afterAll(async () => {
  await Bun.spawn([orb, "service", "stop"], { stdout: "ignore", stderr: "ignore" }).exited
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("starts the background service through orb and returns an endpoint that authenticates", async () => {
  const endpoint = await start(orb)

  expect(endpoint.url).toStartWith("http://127.0.0.1:")
  const response = await fetch(new URL("/api/info", endpoint.url), { headers: headers(endpoint) })
  expect(response.status).toBe(200)
  // A second start reuses the running service.
  expect((await start(orb)).url).toBe(endpoint.url)
}, 120_000)

test("reports why orb could not start", async () => {
  const broken = path.join(root, "broken")
  await Bun.write(broken, "#!/bin/sh\necho 'orb: something is wrong' >&2\nexit 3\n")
  await fs.chmod(broken, 0o755)

  await expect(start(broken)).rejects.toThrow("orb: something is wrong")
  await expect(start(path.join(root, "missing"))).rejects.toThrow()
})

test("reads the version orb prints", async () => {
  // A source checkout reports "vlocal"; a release reports its number.
  expect(await version(orb)).toMatch(/^v\S+$/)
  await expect(version(path.join(root, "missing"))).rejects.toThrow()
}, 60_000)
