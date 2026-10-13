import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { openStore } from "../src/runner"
import { loadSuite, loadWorkflow, suiteCommands, workflowCommands } from "../src/load"

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

const share = () => `\\\\127.0.0.1@${port}\\DavWWWRoot\\x`
const linkFile = (target: string, file: string) =>
  fs.symlink(target, file, "file").then(
    () => true,
    () => false,
  )

// SQLite in WAL mode opens `runs.db-wal` and `runs.db-shm` as well, and a clone can ship either as a link to a share.
for (const suffix of ["-wal", "-shm", "-journal"])
  test(`a run store whose runs.db${suffix} links to a share is refused and never opened`, async () => {
    if (!windows) return
    const project = path.join(root, `companion${suffix}`)
    await fs.mkdir(path.join(project, ".orbit"), { recursive: true })
    if (!(await linkFile(share(), path.join(project, ".orbit", `runs.db${suffix}`)))) return
    const started = Date.now()
    await expect(openStore(project)).rejects.toThrow("network share")
    expect(connections).toEqual([])
    expect(Date.now() - started).toBeLessThan(10_000)
  })

// `trustOptions` and `load` read the workflow or suite file before `requireTrust`, and `resume` takes the file name from
// the run store: each reader goes through the same check.
for (const [name, read] of [
  ["workflowCommands", (file: string) => workflowCommands(file)],
  ["loadWorkflow", (file: string) => loadWorkflow(file)],
  ["suiteCommands", (file: string) => suiteCommands(file)],
  ["loadSuite", (file: string) => loadSuite(file)],
] as const)
  test(`${name} does not read a file that links to a share, and still reads a plain one (control)`, async () => {
    const extension = name.includes("uite") ? "json" : "yaml"
    const plain = path.join(root, `plain-${name}.${extension}`)
    await fs.writeFile(plain, extension === "json" ? '{"name":"s","tasks":[]}' : "name: w\nnodes: []\n")
    await read(plain).catch(() => undefined)
    expect(connections).toEqual([])
    if (!windows) return
    const linked = path.join(root, `linked-${name}.${extension}`)
    if (!(await linkFile(share(), linked))) return
    const started = Date.now()
    await expect(read(linked)).rejects.toThrow("network share")
    expect(connections).toEqual([])
    expect(Date.now() - started).toBeLessThan(10_000)
  })

test("a workflow named by a share spelling is not read", async () => {
  if (!windows) return
  await expect(workflowCommands(`\\\\127.0.0.1@${port}\\DavWWWRoot\\wf.yaml`)).rejects.toThrow("network share")
  expect(connections).toEqual([])
})
