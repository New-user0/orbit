import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { discoverThemes } from "../src/theme/discovery"
import { themeDirectories } from "../src/util/config-directories"
import { tmpdir } from "./fixture/fixture"

// Class 6 (M3 verification round 6): the terminal UI and Mini read custom themes from `.orbit/themes` of the folders from
// the project's root down to the working folder (once the folder is trusted, trust-first part 2). Each row makes one of
// those names a link to a WebDAV share served by a local listener that records connections, and asks the real
// `discoverThemes` through `themeDirectories`, the call both clients make. A recorder counts a connection that a slow or failing host would hide.
// Only Windows has links to shares, so the share rows run there (they need the right to make a link, and skip without
// it). The folder's trust decision does not enter: the loader never touches a share in either mode, so the trusted
// control is a plain folder read by the same call.
const windows = process.platform === "win32"
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
afterAll(() => {
  recorder.close()
})

const share = () => `\\\\127.0.0.1@${port}\\DavWWWRoot\\themes`

// The folders both clients read themes from for a trusted folder at `cwd`.
const read = async (root: string, cwd: string) =>
  discoverThemes(
    await themeDirectories({ config: path.join(root, "config"), home: path.join(root, "home"), cwd, project: {} }),
  )

describe("theme discovery and a link to a share", () => {
  for (const place of [".orbit", ".orbit/themes", ".orbit/themes/x.json"])
    test(
      `${place} linked to a share is skipped and costs only itself`,
      async () => {
        if (!windows) return
        await using root = await tmpdir()
        const project = path.join(root.path, "project")
        const app = path.join(project, "app")
        const target = path.join(app, place)
        await mkdir(path.dirname(target), { recursive: true })
        // A good theme in the project's root, so that skipping one entry is not skipping all of them. The root is the folder
        // that holds `.git`: nothing above it is read.
        await mkdir(path.join(project, ".git"), { recursive: true })
        await mkdir(path.join(project, ".orbit", "themes"), { recursive: true })
        await writeFile(path.join(project, ".orbit", "themes", "good.json"), '{"ok":true}')
        const kind = place.endsWith(".json") ? "file" : "dir"
        const made = await symlink(share(), target, kind).then(
          () => true,
          () => false,
        )
        if (!made) return
        const found = await read(root.path, app)
        expect(connections).toEqual([])
        expect(found).toEqual({ good: { ok: true } })
      },
      60_000,
    )

  test("a theme that is not valid JSON costs only itself", async () => {
    await using root = await tmpdir()
    const themes = path.join(root.path, ".orbit", "themes")
    await mkdir(themes, { recursive: true })
    await writeFile(path.join(themes, "bad.json"), "{")
    await writeFile(path.join(themes, "good.json"), '{"ok":true}')
    expect(await read(root.path, root.path)).toEqual({
      good: { ok: true },
    })
  })

  test("a plain .orbit/themes folder is still read (control)", async () => {
    await using root = await tmpdir()
    const themes = path.join(root.path, "project", ".orbit", "themes")
    await mkdir(themes, { recursive: true })
    await writeFile(path.join(themes, "good.json"), '{"ok":true}')
    expect(await read(root.path, path.join(root.path, "project"))).toEqual({
      good: { ok: true },
    })
    expect(connections).toEqual([])
  })
})
