import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { openStore } from "../src/runner"

// Class 6 (M3 verification round 6): every `orb flow` command that reads the run store (ls, approve, cost, clean, replay,
// show, trace, watch, resume) opens it through `openStore`, before any trust answer. A clone can ship `.orbit` as a link to
// a share, and SQLite creating `runs.db` through it connects to a host the clone chose. The recorder is a local listener
// that a WebDAV share is served from: a connection to it is the failure. Only Windows has links to shares, so the share row
// runs there (it needs the right to make a link, and skips without it).
const windows = process.platform === "win32"
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-share-"))
const connections: string[] = []
const recorder = net.createServer((socket) => {
  connections.push(`${socket.remoteAddress}`)
  socket.destroy()
})
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve))
  port = (recorder.address() as net.AddressInfo).port
})
beforeEach(() => {
  connections.length = 0
})
afterAll(async () => {
  recorder.close()
  await fs.rm(root, { recursive: true, force: true })
})

test("a run store folder that links to a share is refused and never opened", async () => {
  if (!windows) return
  const project = path.join(root, "linked")
  await fs.mkdir(project, { recursive: true })
  const made = await fs.symlink(`\\\\127.0.0.1@${port}\\DavWWWRoot\\store`, path.join(project, ".orbit"), "dir").then(
    () => true,
    () => false,
  )
  if (!made) return
  const started = Date.now()
  await expect(openStore(project)).rejects.toThrow("network share")
  expect(connections).toEqual([])
  // Followed, the link takes about 40 seconds to fail.
  expect(Date.now() - started).toBeLessThan(10_000)
})

test("a plain run store folder is still opened (control)", async () => {
  const project = path.join(root, "plain")
  await fs.mkdir(project, { recursive: true })
  const store = await openStore(project)
  expect(store.runs()).toEqual([])
  store.close()
  expect(connections).toEqual([])
})

test("a run store folder that links to a folder on the disk is still opened (control)", async () => {
  const project = path.join(root, "local")
  const real = path.join(root, "real-store")
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(real, { recursive: true })
  const made = await fs.symlink(real, path.join(project, ".orbit"), "junction").then(
    () => true,
    () => false,
  )
  if (!made) return
  const store = await openStore(project)
  expect(store.runs()).toEqual([])
  store.close()
})
