import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { resolveGitExecutable } from "@orbit/core/util/git-executable"
import { tmpdir } from "../fixture/tmpdir"

describe("Git executable", () => {
  test("uses an absolute executable on Windows", () => {
    expect(resolveGitExecutable("win32", "bin/git.exe")).toBe(path.resolve("bin/git.exe"))
  })

  test("leaves lookup to the process outside Windows", () => {
    expect(resolveGitExecutable("linux", "/usr/bin/git")).toBe("git")
  })

  test("falls back to PATH lookup when Git is unresolved", () => {
    expect(resolveGitExecutable("win32", null)).toBe("git")
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
        env: { ...process.env, PATH: bin },
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
