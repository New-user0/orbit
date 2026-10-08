import { afterAll, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { configured, find, launch, missing } from "../src/program"

// The program the extension starts is `orb`, found on PATH and started by its full path. The workspace is the folder that
// a repository chooses, and a program that is started by a bare name is looked for there first on Windows, by Node's
// `execFile` as much as by Bun's. So these tests plant real programs named `orb` in the workspace and on PATH, with the
// variable that turns the lookup off deleted from this process, which a shell may set and which hides the attack.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-program-")))
const windows = process.platform === "win32"
// What a program named `orb` is called on disk.
const file = windows ? "orb.exe" : "orb"
const node = Bun.which("node")

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

let count = 0
// A fresh workspace and a folder on PATH, each holding a program named `orb`, and a reader of what each one has run.
async function plantAll() {
  const base = path.join(root, `case-${++count}`)
  const workspace = path.join(base, "workspace")
  const bin = path.join(base, "bin")
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(bin, { recursive: true })
  return { workspace, bin, ranInWorkspace: await decoy(workspace), ranOnPath: await decoy(bin) }
}

// A program named `orb` in `directory` that leaves the arguments it was started with in `ran.txt` beside itself, and a
// reader of them, one entry for each start. Windows gets a compiled `.exe`, which is what a lookup by name finds there.
async function decoy(directory: string) {
  const lines = windows ? await plant(directory, "orb") : await script(directory)
  return async () => (await lines()).map((line) => line.replace(/^orb(\.exe)? ?/, ""))
}

async function script(directory: string) {
  const program = path.join(directory, "orb")
  await Bun.write(program, `#!/bin/sh\necho "orb $*" >> "$(dirname "$0")/ran.txt"\n`)
  await fs.chmod(program, 0o755)
  const marker = path.join(directory, "ran.txt")
  return async () =>
    (await Bun.file(marker).exists()) ? (await Bun.file(marker).text()).split(/\r?\n/).filter(Boolean) : []
}

// What the extension did before: `execFile` of the bare name, with the workspace as the working folder.
function bare(cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve) =>
    execFile("orb", ["--version"], { cwd, env, windowsHide: true, timeout: 20_000 }, () => resolve()),
  )
}

const withPath = (...folders: string[]) => ({ ...process.env, PATH: folders.join(path.delimiter) })

test("finds orb on PATH, the first folder that holds it first", async () => {
  const first = await plantAll()
  const second = await plantAll()

  expect(find("orb", { PATH: [first.bin, second.bin].join(path.delimiter) })).toBe(path.join(first.bin, file))
  expect(find("orb", { PATH: [second.bin, first.bin].join(path.delimiter) })).toBe(path.join(second.bin, file))
  // A folder that holds none, and a quoted entry as Windows allows, do not get in the way.
  expect(find("orb", { PATH: [`${first.bin}-none`, `"${first.bin}"`].join(path.delimiter) })).toBe(
    path.join(first.bin, file),
  )
  expect(find("orb", { PATH: "" })).toBeUndefined()
  expect(find("orb", {})).toBeUndefined()
})

test("never finds orb in the working folder, however PATH names it", async () => {
  const folders = await plantAll()
  const cwd = process.cwd()
  process.chdir(folders.workspace)
  try {
    // The workspace holds `orb` and is the working folder, so each of these entries would find it if it were followed:
    // the folder itself, an empty entry, which a shell reads as the folder, and a path from it to the workspace or to
    // the folder on PATH, which is a relative entry too.
    for (const entry of [".", "", "./", ".\\", path.join("..", "workspace"), path.join("..", "bin")]) {
      expect({ entry, alone: find("orb", { PATH: entry }) }).toEqual({ entry, alone: undefined })
      const listed = find("orb", { PATH: [entry, folders.bin].join(path.delimiter) })
      expect({ entry, listed }).toEqual({ entry, listed: path.join(folders.bin, file) })
    }
    // Neither does a name with a directory in it that is not a full path: execFile would read it from this folder.
    for (const name of [
      `.${path.sep}orb`,
      "./orb",
      `..${path.sep}workspace${path.sep}orb`,
      path.join("..", "bin", "orb"),
    ])
      expect({ name, found: find(name, withPath(folders.bin)) }).toEqual({ name, found: undefined })
  } finally {
    process.chdir(cwd)
  }
  // A full path is a full path, and a folder is not a program.
  expect(find(path.join(folders.workspace, file), {})).toBe(path.join(folders.workspace, file))
  expect(find(path.join(folders.workspace, "missing", file), {})).toBeUndefined()
  await fs.mkdir(path.join(folders.bin, "dir", "orb.exe"), { recursive: true })
  expect(find(path.join(folders.bin, "dir", "orb.exe"), {})).toBeUndefined()
})

test.skipIf(!windows)(
  "on Windows only a .exe or .com is found, and the extension is added to a bare name",
  async () => {
    const folders = await plantAll()
    const env = { PATH: folders.bin }
    await fs.rm(path.join(folders.bin, file))
    for (const name of ["orb.cmd", "orb.bat", "orb"]) await Bun.write(path.join(folders.bin, name), "")

    // execFile cannot start a script or a file that has no extension, so those are not found.
    expect(find("orb", env)).toBeUndefined()
    await Bun.write(path.join(folders.bin, "orb.com"), "")
    expect(find("orb", env)).toBe(path.join(folders.bin, "orb.com"))
    await Bun.write(path.join(folders.bin, "orb.exe"), "")
    expect(find("orb", env)).toBe(path.join(folders.bin, "orb.exe"))
    // The name as written still counts when it has an extension, and a full path without one gets it added.
    expect(find("orb.exe", env)).toBe(path.join(folders.bin, "orb.exe"))
    expect(find(path.join(folders.bin, "orb"), {})).toBe(path.join(folders.bin, "orb.exe"))
  },
)

test.skipIf(windows)("on Unix only a file that can be executed is found", async () => {
  const folders = await plantAll()
  await fs.chmod(path.join(folders.bin, "orb"), 0o644)

  expect(find("orb", { PATH: folders.bin })).toBeUndefined()
  await fs.chmod(path.join(folders.bin, "orb"), 0o755)
  expect(find("orb", { PATH: folders.bin })).toBe(path.join(folders.bin, "orb"))
})

test("starts the orb on PATH and never the one in the workspace", async () => {
  using _ = currentDirectoryOnPath()
  const folders = await plantAll()
  const env = withPath(folders.bin, ...(process.env.PATH ? [process.env.PATH] : []))

  // The control: the planted program in the workspace does run when it is started by its path, so a test that sees it
  // not run is seeing the lookup and not a program that cannot start.
  await launch(path.join(folders.workspace, file), ["control"], { cwd: folders.workspace, env, timeout: 20_000 })
  expect(await folders.ranInWorkspace()).toEqual(["control"])

  await launch("orb", ["--version"], { cwd: folders.workspace, env, timeout: 20_000 })

  expect(await folders.ranOnPath()).toEqual(["--version"])
  expect(await folders.ranInWorkspace()).toEqual(["control"])
})

test("a bare execFile runs the workspace's orb when PATH names the working folder, and launch does not", async () => {
  using _ = currentDirectoryOnPath()
  // `.` on PATH is the working folder on every platform. This is the call the extension made before, and the proof that
  // the planted program is found by it.
  const before = await plantAll()
  await bare(before.workspace, withPath(".", before.bin))
  expect(await before.ranInWorkspace()).toEqual(["--version"])
  expect(await before.ranOnPath()).toEqual([])

  const after = await plantAll()
  await launch("orb", ["--version"], { cwd: after.workspace, env: withPath(".", after.bin), timeout: 20_000 })
  expect(await after.ranInWorkspace()).toEqual([])
  expect(await after.ranOnPath()).toEqual(["--version"])
})

test.skipIf(!windows)(
  "on Windows a bare execFile runs the workspace's orb before the one on PATH, and launch does not",
  async () => {
    using _ = currentDirectoryOnPath()
    const before = await plantAll()
    await bare(before.workspace, withPath(before.bin))
    expect(await before.ranInWorkspace()).toEqual(["--version"])
    expect(await before.ranOnPath()).toEqual([])

    const after = await plantAll()
    await launch("orb", ["--version"], { cwd: after.workspace, env: withPath(after.bin), timeout: 20_000 })
    expect(await after.ranInWorkspace()).toEqual([])
    expect(await after.ranOnPath()).toEqual(["--version"])
  },
)

// VS Code's extension host is Node, which the tests above are not. The same two calls run in a real Node process, with the
// program bundled for it and without the variable that turns the lookup off in its environment.
test.skipIf(!node)(
  "in a Node process, launch starts the orb on PATH and a bare execFile starts the workspace's",
  async () => {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "..", "src", "program.ts")],
      outdir: path.join(root, "node"),
      naming: "program.mjs",
      target: "node",
      format: "esm",
    })
    expect(build.success).toBe(true)
    await Bun.write(
      path.join(root, "node", "start.mjs"),
      `import { execFile } from "node:child_process"
import { launch } from "./program.mjs"
const [mode, cwd, bin] = process.argv.slice(2)
const env = { ...process.env, PATH: [".", bin].join(process.platform === "win32" ? ";" : ":") }
if (mode === "bare") await new Promise((resolve) => execFile("orb", ["--version"], { cwd, env, windowsHide: true }, resolve))
else await launch("orb", ["--version"], { cwd, env, timeout: 20000 })
`,
    )
    const start = async (mode: "bare" | "launch", folders: { workspace: string; bin: string }) => {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.NoDefaultCurrentDirectoryInExePath
      const child = Bun.spawn(
        [node ?? "node", path.join(root, "node", "start.mjs"), mode, folders.workspace, folders.bin],
        {
          cwd: folders.workspace,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ mode, code, stderr }).toEqual({ mode, code: 0, stderr: "" })
    }

    const before = await plantAll()
    await start("bare", before)
    expect(await before.ranInWorkspace()).toEqual(["--version"])
    expect(await before.ranOnPath()).toEqual([])

    const after = await plantAll()
    await start("launch", after)
    expect(await after.ranInWorkspace()).toEqual([])
    expect(await after.ranOnPath()).toEqual(["--version"])
  },
  60_000,
)

test("reports a program it cannot find, and starts nothing", async () => {
  const folders = await plantAll()

  await expect(
    launch("orb", ["--version"], { cwd: folders.workspace, env: { PATH: "" }, timeout: 5_000 }),
  ).rejects.toThrow(missing("orb"))
  await expect(
    launch(`.${path.sep}orb`, ["--version"], { cwd: folders.workspace, env: withPath(folders.bin), timeout: 5_000 }),
  ).rejects.toThrow("Could not find")
  expect(await folders.ranInWorkspace()).toEqual([])
  expect(await folders.ranOnPath()).toEqual([])
  expect(missing("orb")).toContain("orbit.executable")
  expect(missing("orb")).toContain("user settings")
})

test("takes orbit.executable from the user's settings and never from the workspace's", () => {
  // `inspect` hands over the value of every scope. Whatever scope VS Code gives the setting, only these two count.
  const inWorkspace = {
    defaultValue: "orb",
    globalValue: undefined,
    workspaceValue: "./evil",
    workspaceFolderValue: "./evil",
  }
  const inBoth = { defaultValue: "orb", globalValue: "C:\\tools\\orb.exe", workspaceValue: "./evil" }
  const onlyDefault = { defaultValue: "orb-dev", workspaceValue: "./evil" }

  expect(configured(inWorkspace)).toBe("orb")
  expect(configured(inBoth)).toBe("C:\\tools\\orb.exe")
  expect(configured(onlyDefault)).toBe("orb-dev")
  expect(configured(undefined)).toBe("orb")
  expect(configured({ globalValue: "" })).toBe("orb")
  expect(configured({ globalValue: 7, defaultValue: null })).toBe("orb")
})
