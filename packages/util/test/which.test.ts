import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { which } from "@orbit/util/which"
import os from "os"

async function tmpdir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-which-test-")))
  return { path: dir, [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }) }
}

async function cmd(dir: string, name: string, exec = true) {
  const ext = process.platform === "win32" ? ".cmd" : ""
  const file = path.join(dir, name + ext)
  const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n"
  await fs.writeFile(file, body)
  if (process.platform !== "win32") {
    await fs.chmod(file, exec ? 0o755 : 0o644)
  }
  return file
}

function env(PATH: string): NodeJS.ProcessEnv {
  return {
    PATH,
    PATHEXT: process.env["PATHEXT"],
  }
}

function envPath(Path: string): NodeJS.ProcessEnv {
  return {
    Path,
    PathExt: process.env["PathExt"] ?? process.env["PATHEXT"],
  }
}

function same(a: string | null, b: string) {
  if (process.platform === "win32") {
    expect(a?.toLowerCase()).toBe(b.toLowerCase())
    return
  }

  expect(a).toBe(b)
}

// The folder Orbit starts in belongs to the repository it opened, so a lookup run from there must not depend on it.
function inside<T>(directory: string, run: () => T) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return run()
  } finally {
    process.chdir(before)
  }
}

describe("util.which", () => {
  test("returns null when command is missing", () => {
    expect(which("orbit-missing-command-for-test")).toBeNull()
  })

  test("finds a command from PATH override", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = await cmd(bin, "tool")

    same(which("tool", env(bin)), file)
  })

  test("uses first PATH match", async () => {
    await using tmp = await tmpdir()
    const a = path.join(tmp.path, "a")
    const b = path.join(tmp.path, "b")
    await fs.mkdir(a)
    await fs.mkdir(b)
    const first = await cmd(a, "dupe")
    await cmd(b, "dupe")

    same(which("dupe", env([a, b].join(path.delimiter))), first)
  })

  test("returns null for non-executable file on unix", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    await cmd(bin, "noexec", false)

    expect(which("noexec", env(bin))).toBeNull()
  })

  test("uses PATHEXT on windows", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = path.join(bin, "pathext.CMD")
    await fs.writeFile(file, "@echo off\r\n")

    expect(which("pathext", { PATH: bin, PATHEXT: ".CMD" })).toBe(file)
  })

  test("uses Windows Path casing fallback", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = await cmd(bin, "mixed")

    same(which("mixed", envPath(bin)), file)
  })

  test("looks only on PATH, never in the working folder", async () => {
    await using tmp = await tmpdir()
    const here = path.join(tmp.path, "here")
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(here)
    await fs.mkdir(bin)
    await cmd(here, "shadowed")
    await cmd(here, "only-here")
    const installed = await cmd(bin, "shadowed")

    inside(here, () => {
      // The npm `which` package looks in the working folder before PATH on Windows, so a repository could put its own
      // git.exe or rg.exe in front of the installed one.
      same(which("shadowed", env(bin)), installed)
      expect(which("only-here", env(bin))).toBeNull()
    })
  })

  test("does not read an empty PATH entry as the working folder", async () => {
    await using tmp = await tmpdir()
    const here = path.join(tmp.path, "here")
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(here)
    await fs.mkdir(bin)
    await cmd(here, "only-here")
    const installed = await cmd(bin, "installed")

    inside(here, () => {
      expect(which("only-here", env([bin, "", bin].join(path.delimiter)))).toBeNull()
      expect(which("only-here", env(""))).toBeNull()
      same(which("installed", env([bin, ""].join(path.delimiter))), installed)
    })
  })

  test("finds a command in a quoted PATH entry", async () => {
    await using tmp = await tmpdir()
    const file = await cmd(tmp.path, "quoted")

    same(which("quoted", env(`"${tmp.path}"`)), file)
  })

  describe("a relative PATH entry", () => {
    // A decoy in the working folder and in the folders a relative entry can reach from it.
    const plant = async (root: string) => {
      const folders = [root, path.join(root, "bin"), path.join(root, "node_modules", ".bin")]
      await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })))
      return Promise.all(folders.map((folder) => cmd(folder, "relhit")))
    }
    const relative = [".", "./", "bin", "node_modules/.bin", "node_modules/.bin/"].map((entry) => ({
      name: JSON.stringify(entry),
      spell: () => entry,
    }))
    // Spelled from the test folder so that they reach its `bin` from the working folder, where the decoy is: `D:bin` is
    // the working folder's `bin` on its drive, and `\path\to\bin` is the same folder without a drive.
    const windowsOnly = [
      { name: "a drive-relative entry", spell: (root: string) => `${path.parse(root).root.slice(0, 2)}bin` },
      { name: "a root-relative entry", spell: (root: string) => path.join(root, "bin").slice(2) },
    ]

    for (const { name, spell } of [...relative, ...(process.platform === "win32" ? windowsOnly : [])]) {
      test(`skips ${name}`, async () => {
        await using tmp = await tmpdir()
        const entry = spell(tmp.path)
        await plant(tmp.path)

        expect(inside(tmp.path, () => which("relhit", env(entry)))).toBeNull()
        // Behind an entry that does not resolve, the lookup goes on to the next one.
        const real = path.join(tmp.path, "real")
        await fs.mkdir(real)
        const installed = await cmd(real, "relhit")
        same(
          inside(tmp.path, () => which("relhit", env([entry, real].join(path.delimiter)))),
          installed,
        )
      })
    }

    test("skips .. from a subfolder", async () => {
      await using tmp = await tmpdir()
      await plant(tmp.path)

      expect(inside(path.join(tmp.path, "bin"), () => which("relhit", env("..")))).toBeNull()
    })

    test("still finds the same program through an absolute or quoted entry (control)", async () => {
      await using tmp = await tmpdir()
      const [decoy] = await plant(tmp.path)

      same(inside(tmp.path, () => which("relhit", env(tmp.path))), decoy!)
      same(inside(tmp.path, () => which("relhit", env(`"${tmp.path}"`))), decoy!)
    })
  })

  test("checks a command that names a directory as given", async () => {
    await using tmp = await tmpdir()
    const file = await cmd(tmp.path, "direct")

    same(which(file, env("")), file)
    expect(which(path.join(tmp.path, "absent"), env(tmp.path))).toBeNull()
  })
})
