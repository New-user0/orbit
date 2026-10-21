import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import launch from "cross-spawn"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { resolveGitExecutable } from "@orbit/core/util/git-executable"
import { which } from "@orbit/util/which"
import { plant } from "../fixture/decoy"
import { tmpdir } from "../fixture/tmpdir"

describe("Git executable", () => {
  test("uses an absolute executable on Windows", () => {
    expect(resolveGitExecutable("win32", "bin/git.exe")).toBe(path.resolve("bin/git.exe"))
  })

  test("leaves lookup to the process outside Windows", () => {
    expect(resolveGitExecutable("linux", "/usr/bin/git")).toBe("git")
  })

  // The library that starts a program looks in the working folder for a bare name, so on Windows no name is handed to it
  // when git is on no PATH: a file in System32 that is not there fails like a git that is not installed.
  test("hands Windows a path that is not there, and never the bare name, when Git is unresolved", () => {
    const missing = resolveGitExecutable("win32", null)
    expect(missing).not.toBe("git")
    expect(path.win32.isAbsolute(missing)).toBe(true)
    expect(path.win32.dirname(missing).toLowerCase()).toBe(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase())
  })

  test("keeps the bare name outside Windows when Git is unresolved, which no spawn looks up in the working folder", () => {
    expect(resolveGitExecutable("linux", null)).toBe("git")
  })

  test("takes Git from PATH, never from the folder Orbit starts in", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const here = path.join(tmp.path, "here")
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(here)
    await fs.mkdir(bin)
    await fs.writeFile(path.join(here, "git.cmd"), "@echo off\r\n")
    await fs.writeFile(path.join(bin, "git.cmd"), "@echo off\r\n")

    // The path is resolved when the module loads, so load it in a process that starts in the folder, as `orb` does.
    const module = pathToFileURL(path.join(import.meta.dir, "../../src/util/git-executable.ts")).href
    const child = Bun.spawn(
      [process.execPath, "-e", `import { gitExecutable } from "${module}"\nconsole.log(gitExecutable)`],
      {
        cwd: here,
        env: { ...hostEnv(), PATH: bin },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [output, error] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(error).toBe("")
    expect(output.trim().toLowerCase()).toBe(path.join(bin, "git.cmd").toLowerCase())
  })
})

// Class 10 and 14 (register FU-M1-012): git is on no PATH, so `gitExecutable` is what the code falls back to, and the folder
// Orbit asks git something in holds a program named `git`. Under each host that runs the core, the Git service starts git
// through the spawner of Orbit; nothing in the folder may run. Windows looks in the working folder before PATH for a bare
// name, by Bun's spawn, by Node's and by `cmd.exe`, unless the process that spawns has `NoDefaultCurrentDirectoryInExePath`,
// which the spawner sets. The library under the spawner resolves the name itself as well, and starts the interpreter that
// a `#!` line in a file called `git` gives, which the variable does not stop. The file system lookup is the one a `.exe`, a
// `.bat` and a `.cmd` take. Each kind is alone in its folder, because a `git.exe` hides the file with no extension.
const node = Bun.which("node")
const windows = process.platform === "win32"
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-git-fallback-")))
const entry = path.join(import.meta.dir, "../fixture/git-host.ts")
const bundle = path.join(root, "host.mjs")

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [entry], outdir: root, naming: "host.mjs", target: "node", format: "esm" })
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle the git host for Node")
}, 60_000)

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

let count = 0
const folder = async () => {
  const directory = path.join(root, `case-${++count}`)
  // `.git` is what makes the Git service start git in the folder.
  await fs.mkdir(path.join(directory, ".git"), { recursive: true })
  return directory
}

// A parent that spells the variable `Path` (PowerShell) gives a Node child both keys when a copy sets `PATH` too, and the
// child then sees the host's. Every spelling goes before the one the test sets.
const hostEnv = () => {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== "path") env[key] = value
  return env
}

/** The environment of a host that has no git on PATH: the folder of the program that runs the host, and on Windows System32. */
const without = (extra: string[] = []) => {
  const env = hostEnv()
  // The shell that runs the tests may set it, and the spawner sets it again, which hides what a decoy can do before.
  delete env.NoDefaultCurrentDirectoryInExePath
  env.PATH = [
    ...extra,
    path.dirname(process.execPath),
    ...(windows ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : []),
  ].join(path.delimiter)
  return env
}

const start = async (host: "bun" | "node", directory: string, env: Record<string, string | undefined>) => {
  const child = Bun.spawn(host === "bun" ? [process.execPath, "run", entry, directory] : [node!, bundle, directory], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const line = out.split(/\r?\n/).find((item) => item.startsWith('{"gitExecutable"'))
  return { code, ...(line ? (JSON.parse(line) as { gitExecutable: string; found: boolean }) : { gitExecutable: "", found: undefined }) }
}

/** A program named `git` of each kind that Windows can run, alone in a folder, with the reader of what it has run. */
const decoys = {
  exe: async (directory: string) => {
    const ran = await plant(directory, "git")
    return ran
  },
  bat: async (directory: string) => {
    await fs.writeFile(path.join(directory, "git.bat"), `@echo off\r\necho bat>> "${path.join(directory, "ran.txt")}"\r\n`)
    return marker(directory)
  },
  cmd: async (directory: string) => {
    await fs.writeFile(path.join(directory, "git.cmd"), `@echo off\r\necho cmd>> "${path.join(directory, "ran.txt")}"\r\n`)
    return marker(directory)
  },
  // No extension, and a first line that names an interpreter: the library that starts the program reads it and starts the
  // interpreter with the file.
  shebang: async (directory: string) => {
    await fs.writeFile(
      path.join(directory, "git"),
      `#!/usr/bin/env bun\nrequire("fs").appendFileSync(require("path").join(__dirname, "ran.txt"), "shebang\\n")\n`,
    )
    return marker(directory)
  },
}

const marker = (directory: string) => async () => {
  const file = path.join(directory, "ran.txt")
  return (await Bun.file(file).exists()) ? (await Bun.file(file).text()).split(/\r?\n/).filter(Boolean) : []
}

describe.skipIf(!windows)("the git that Windows falls back to, with a program named git in the folder", () => {
  for (const host of ["bun", "node"] as const)
    for (const kind of Object.keys(decoys) as (keyof typeof decoys)[])
      test.skipIf(host === "node" && !node)(
        `${host}: starts no git.${kind === "shebang" ? "(no extension)" : kind} that the folder holds`,
        async () => {
          const directory = await folder()
          const ran = await decoys[kind](directory)
          const env = without()
          // Git is on no PATH, which is what puts the fallback in use. With one, the row would pass without testing it.
          expect(which("git", env)).toBeNull()

          const result = await start(host, directory, env)

          expect(await ran()).toEqual([])
          // The fallback file, which is not there. A row that ran the machine's own git would not name it.
          expect(path.basename(result.gitExecutable)).toBe("git-is-not-on-path")
          expect(result).toMatchObject({ code: 0, found: false })
        },
        60_000,
      )

  for (const host of ["bun", "node"] as const)
    test.skipIf(host === "node" && !node)(
      `${host}: starts the git of PATH by its full path, and none of the folder's (control)`,
      async () => {
        const directory = await folder()
        const bin = path.join(root, `bin-${++count}`)
        await fs.mkdir(bin)
        const inFolder = await decoys.shebang(directory)
        const onPath = await plant(bin, "git")

        const result = await start(host, directory, without([bin]))

        expect(path.normalize(result.gitExecutable).toLowerCase()).toBe(path.join(bin, "git.exe").toLowerCase())
        // The program of PATH ran as git, with the arguments of the Git service, which shows that a decoy of this kind runs.
        expect((await onPath()).map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual([
          "git.exe -c diff.ignoreSubmodules=all rev-parse",
        ])
        expect(await inFolder()).toEqual([])
      },
      60_000,
    )

  // The rows above pass whatever the program is, unless it can run. These start each kind the way that finds it.
  test("each kind of program runs when it is started the way that finds it (control)", async () => {
    for (const kind of ["exe", "bat", "cmd", "shebang"] as const) {
      const directory = await folder()
      const ran = await decoys[kind](directory)
      if (kind === "exe") await Bun.spawn([path.join(directory, "git.exe")], { cwd: directory, stdout: "ignore" }).exited
      // `cmd.exe` and the library look in the working folder when nothing tells them not to.
      else if (kind === "shebang")
        await new Promise((resolve) =>
          launch("git", [], { cwd: directory, env: without(), stdio: "ignore" }).on("close", resolve).on("error", resolve),
        )
      else await Bun.spawn(["cmd", "/c", "git"], { cwd: directory, env: without(), stdout: "ignore", stderr: "ignore" }).exited
      expect({ kind, ran: (await ran()).length > 0 }).toEqual({ kind, ran: true })
    }
  }, 60_000)
})

describe.skipIf(windows)("the git that POSIX falls back to, with a program named git in the folder", () => {
  const script = (target: string) => `#!/bin/sh\necho ran >> "${path.join(target, "ran.txt")}"\n`
  const plantScript = async (directory: string) => {
    await fs.writeFile(path.join(directory, "git"), script(directory))
    await fs.chmod(path.join(directory, "git"), 0o755)
    return marker(directory)
  }

  for (const host of ["bun", "node"] as const)
    test.skipIf(host === "node" && !node)(
      `${host}: starts no git that the folder holds when git is on no PATH`,
      async () => {
        const directory = await folder()
        const empty = path.join(root, `empty-${++count}`)
        await fs.mkdir(empty)
        const ran = await plantScript(directory)
        const env = without([empty])
        // The row means something only where PATH holds no git. On a machine that keeps git beside bun it holds one, and the
        // decoy must not run either way.
        const result = await start(host, directory, env)

        expect(await ran()).toEqual([])
        expect(result).toMatchObject({ code: 0, gitExecutable: "git", found: false })
      },
      60_000,
    )

  for (const host of ["bun", "node"] as const)
    test.skipIf(host === "node" && !node)(
      `${host}: starts the git of PATH, and not the folder's (control)`,
      async () => {
        const directory = await folder()
        const bin = path.join(root, `bin-${++count}`)
        await fs.mkdir(bin)
        const inFolder = await plantScript(directory)
        const onPath = await plantScript(bin)

        const result = await start(host, directory, without([bin]))

        expect(result).toMatchObject({ code: 0, gitExecutable: "git", found: false })
        expect(await onPath()).toEqual(["ran"])
        expect(await inFolder()).toEqual([])
      },
      60_000,
    )

  test("the folder's program runs when it is started by its path (control)", async () => {
    const directory = await folder()
    const ran = await plantScript(directory)
    await Bun.spawn([path.join(directory, "git")], { cwd: directory, stdout: "ignore" }).exited
    expect(await ran()).toEqual(["ran"])
  })
})
