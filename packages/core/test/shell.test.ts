import { describe, expect, test } from "bun:test"
import path from "path"
import { ShellSelect } from "@orbit/core/shell/select"
import { FSUtil } from "@orbit/util/fs-util"
import { which } from "@orbit/util/which"
import fs from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  ShellSelect.resolve.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    ShellSelect.resolve.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(ShellSelect.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(ShellSelect.name("C:/tools/NU.EXE")).toBe("nu")
      expect(ShellSelect.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(ShellSelect.login("/bin/bash")).toBe(true)
    expect(ShellSelect.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const configured = ShellSelect.resolve({ priority: "config" })
      const compatible = ShellSelect.resolve({ priority: "compat" })
      expect(ShellSelect.resolve({ priority: "config" }, "orbit-missing-shell")).toBe(configured)
      expect(ShellSelect.resolve({ priority: "compat" }, "orbit-missing-shell")).toBe(compatible)
    })
  })

  test("falls back for terminal-only shells when compatibility is required", () => {
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "fish"))).not.toBe("fish")
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "nu"))).not.toBe("nu")
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "tcsh"))).not.toBe("tcsh")
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "csh"))).not.toBe("csh")
  })

  test("builds command args per shell family", () => {
    expect(ShellSelect.args("/bin/sh", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/usr/bin/fish", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/bin/zsh", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/bin/bash", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("pwsh", "Write-Output hi")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Write-Output hi",
    ])
  })

  if (process.platform !== "win32") {
    test("resolves the environment shell without retaining a removed executable", async () => {
      await withShell(undefined, async () => {
        await using directory = await tmpdir()
        const fallback = ShellSelect.environment()
        const shell = path.join(directory.path, "preferred-shell")
        await fs.symlink("/bin/sh", shell)
        process.env.SHELL = shell
        expect(ShellSelect.environment()).toBe(shell)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(shell)
        await fs.unlink(shell)
        expect(ShellSelect.environment()).toBe(fallback)
      })
    })
  }

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }))).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      // The Cygwin spelling of this machine's own Git Bash, wherever Git is installed: the resolver keeps a shell only
      // when its file exists, so a fixed drive and folder would test the fallback instead.
      const bash = ShellSelect.gitbash()
      if (!bash) throw new Error(`Git Bash is required for the Windows shell tests; git on PATH is ${which("git")}`)
      const shell = `/cygdrive/${bash[0].toLowerCase()}${bash.slice(2).replaceAll("\\", "/")}`
      await withShell(shell, async () => {
        expect(ShellSelect.resolve({ priority: "config" })).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("finds Git Bash from each folder Git for Windows keeps git.exe in", async () => {
      await using directory = await tmpdir()
      const root = path.join(directory.path, "Git")
      const bash = path.join(root, "bin", "bash.exe")
      await fs.mkdir(path.dirname(bash), { recursive: true })
      await fs.writeFile(bash, "bash")
      // A git.exe in some other bin folder is not Git for Windows' toolchain copy, so nothing one folder up is taken.
      const unrelated = path.join(directory.path, "tools", "bin")
      const rows = [
        { folder: path.join(root, "cmd"), expected: bash },
        { folder: path.join(root, "bin"), expected: bash },
        { folder: path.join(root, "mingw64", "bin"), expected: bash },
        { folder: path.join(root, "mingw32", "bin"), expected: bash },
        { folder: path.join(root, "ucrt64", "bin"), expected: bash },
        { folder: path.join(root, "clang64", "bin"), expected: bash },
        { folder: path.join(root, "clangarm64", "bin"), expected: bash },
        // Windows names a folder in any case, and PATH keeps the case it was written in.
        { folder: path.join(root, "MinGW64", "bin"), expected: bash },
        { folder: unrelated, expected: undefined },
        // Only a folder named exactly as a toolchain is one: a name that merely contains one is some other bin folder.
        { folder: path.join(root, "my-mingw64", "bin"), expected: undefined },
        { folder: path.join(root, "mingw64-tools", "bin"), expected: undefined },
      ]
      await fs.mkdir(path.join(directory.path, "bin"))
      await fs.writeFile(path.join(directory.path, "bin", "bash.exe"), "decoy")
      const previous = process.env.PATH
      try {
        const found = []
        for (const row of rows) {
          await fs.mkdir(row.folder, { recursive: true })
          await fs.writeFile(path.join(row.folder, "git.exe"), "git")
          process.env.PATH = row.folder
          found.push({ folder: row.folder, expected: ShellSelect.gitbash() })
        }
        expect(found).toEqual(rows)
      } finally {
        process.env.PATH = previous
      }
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = ShellSelect.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = ShellSelect.gitbash()
      if (!bash) return
      expect(ShellSelect.resolve({ priority: "compat" }, "bash")).toBe(bash)
      expect(ShellSelect.resolve({ priority: "config" }, "bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(ShellSelect.resolve({ priority: "config" })).toBe(shell)
      })
    })
  }
})
