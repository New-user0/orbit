import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { headers, start, version } from "../src/endpoint"
import { launch } from "../src/program"
import { failing, standIn } from "./fixture/orb"

// `orb` from source behind a stand-in, isolated in a temporary home so it starts its own background service.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-endpoint-"))
const orb = path.join(root, "orb")
await standIn(orb, root)

afterAll(async () => {
  // Stopped through the extension's own lookup, which finds the stand-in on every platform, and waited for, so the
  // service no longer holds files in the folder when it is removed.
  await launch(orb, ["service", "stop"], { timeout: 60_000 })
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("the stand-in orb runs in its own home, not the machine's", async () => {
  // Windows takes the home folder from USERPROFILE and POSIX from HOME; the stand-in sets both, so a service it starts
  // reads no config of the person running the tests.
  expect((await launch(orb, ["debug", "paths", "home"], { timeout: 60_000 })).trim()).toBe(root)
}, 60_000)

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
  await failing(broken, "orb: something is wrong", 3)

  await expect(start(broken)).rejects.toThrow("orb: something is wrong")
  await expect(start(path.join(root, "missing"))).rejects.toThrow()
})

test("reads the version orb prints", async () => {
  // A source checkout reports "vlocal"; a release reports its number.
  expect(await version(orb)).toMatch(/^v\S+$/)
  // Windows also takes the full path with its extension, which is the file the lookup completes the path above to.
  if (process.platform === "win32") expect(await version(`${orb}.exe`)).toMatch(/^v\S+$/)
  await expect(version(path.join(root, "missing"))).rejects.toThrow()
}, 60_000)
