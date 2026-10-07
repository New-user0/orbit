import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../core/test/fixture/decoy"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

// On Windows a program that is started by its name is looked for in the working folder before PATH, unless
// NoDefaultCurrentDirectoryInExePath is in the environment of the process that starts it. The working folder can be a
// clone that is not trusted yet, so what the entry of each Orbit process does before anything else decides whether a
// program of the clone runs. These tests start the real entries without the variable, in a folder that holds a decoy.
const windows = process.platform === "win32" ? test : test.skip

// Flow starts git by its name with Bun's spawn, not through the spawner of Orbit, so nothing but the entry of the CLI
// can stop a git.exe of the folder: `orb flow clean` asks git where the repository is before it does anything else.
windows(
  "orb starts git from PATH and never from the folder it runs in",
  async () => {
    await using root = await tmpdir()
    const folder = path.join(root.path, "clone")
    await fs.mkdir(folder)
    const ran = await plant(folder, "git")
    using _ = currentDirectoryOnPath()

    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "flow", "clean"], {
      cwd: path.join(import.meta.dir, ".."),
      // The ceiling keeps git from finding a repository above the temporary folder, which would not be an error.
      env: isolatedEnv(root.path, { USERPROFILE: root.path, PWD: folder, GIT_CEILING_DIRECTORIES: root.path }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ])

    expect(await ran()).toEqual([])
    // The real git ran, or none was found, and said that the folder is not a repository.
    expect(stderr).toContain("orb flow clean works inside a git repository")
  },
  60_000,
)

// `orb.cjs` is what npm installs as `orb`, and it runs under Node before the binary. On Windows it asks PowerShell by its
// name whether the processor has AVX2, which ran a powershell.exe of the folder that `orb` was typed in. The file ships
// alone, so it cannot share the code that the other entries use.
windows(
  "the launcher that npm installs starts PowerShell from PATH and never from the folder it runs in",
  async () => {
    const node = Bun.which("node")
    if (!node) return

    await using root = await tmpdir()
    const folder = path.join(root.path, "clone")
    await fs.mkdir(folder)
    const ran = await plant(folder, "powershell")
    using _ = currentDirectoryOnPath()

    const child = Bun.spawn([node, path.join(import.meta.dir, "../bin/orb.cjs")], {
      cwd: folder,
      // The launcher ends by starting this program, which is the one that a real install would start.
      env: {
        ...process.env,
        ORBIT_BIN_PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, , code] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ])

    expect(await ran()).toEqual([])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  },
  60_000,
)
