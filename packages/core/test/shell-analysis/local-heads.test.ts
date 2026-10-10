import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { currentDirectoryOnPath, plant } from "../fixture/decoy"
import { tmpdir } from "../fixture/tmpdir"
import { linux, windows } from "./helper"

// A program the shell would find in the working folder is project code, so a command that starts it is never read-only
// (class 10). These rows run the real locator (`inspect` supplies it), not a stub.
const inspect = (command: string, ctx: ShellAnalysis.Context) =>
  Effect.runPromise(
    ShellAnalysis.inspect(command, ctx).pipe(
      Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("not used") }),
    ),
  )

describe("project-local heads, through the real locator", () => {
  test("a program in the working folder, named on PATH by its full path, is local (any platform)", async () => {
    await using tmp = await tmpdir()
    const name = process.platform === "win32" ? "ls.exe" : "ls"
    await Bun.write(path.join(tmp.path, name), "")
    await fs.chmod(path.join(tmp.path, name), 0o755)
    const ctx =
      process.platform === "win32"
        ? windows({ cwd: tmp.path, env: { Path: `${tmp.path};C:\\Windows\\System32` } })
        : linux({ cwd: tmp.path, env: { PATH: `${tmp.path}:/usr/bin` } })
    expect((await inspect("ls", ctx)).readOnly).toBe(false)
  })

  test("a program outside the working folder is not local", async () => {
    await using tmp = await tmpdir()
    await using bin = await tmpdir()
    const name = process.platform === "win32" ? "ls.exe" : "ls"
    await Bun.write(path.join(bin.path, name), "")
    await fs.chmod(path.join(bin.path, name), 0o755)
    const ctx =
      process.platform === "win32"
        ? windows({ cwd: tmp.path, env: { Path: bin.path } })
        : linux({ cwd: tmp.path, env: { PATH: bin.path } })
    expect((await inspect("ls", ctx)).readOnly).toBe(true)
  })

  test("a head that is not on PATH at all is not local", async () => {
    await using tmp = await tmpdir()
    expect((await inspect("ls", linux({ cwd: tmp.path, env: { PATH: "/nonexistent" } }))).readOnly).toBe(true)
  })

  test("a working folder that does not exist is not local", async () => {
    expect((await inspect("ls", linux({ cwd: "/nonexistent/dir", env: { PATH: "/nonexistent" } }))).readOnly).toBe(true)
  })
})

const onWindows = process.platform === "win32" ? describe : describe.skip

onWindows("Windows decoys", () => {
  test("cmd starts the decoy from the working folder; analysis finds it and never starts it", async () => {
    await using tmp = await tmpdir()
    using _ = currentDirectoryOnPath()
    const ran = await plant(tmp.path, "ls", "cat")
    // Control: the decoy really is what cmd runs in that folder.
    Bun.spawnSync(["cmd", "/c", "ls"], { cwd: tmp.path, env: { ...process.env } })
    expect(await ran()).toHaveLength(1)

    // The real locator, with PATH naming the folder by its full path.
    const named = windows({ cwd: tmp.path, env: { Path: `${tmp.path};C:\\Windows\\System32` } })
    expect((await inspect("ls", named)).readOnly).toBe(false)
    expect((await inspect("cat x", named)).readOnly).toBe(false)

    // The default PATH does not name the folder, so the locator does not report it.
    const plain = windows({ cwd: tmp.path, env: { Path: "C:\\Windows\\System32" } })
    expect((await inspect("ls", plain)).readOnly).toBe(true)

    // Analysis only looked: the decoy ran once, in the control.
    expect(await ran()).toHaveLength(1)
  })

  test("cmd.exe is unanalysed, so nothing under it is read-only", async () => {
    await using tmp = await tmpdir()
    using _ = currentDirectoryOnPath()
    await plant(tmp.path, "ls")
    const ctx = windows({ shell: "C:\\Windows\\System32\\cmd.exe", cwd: tmp.path })
    expect((await inspect("ls", ctx)).readOnly).toBe(false)
    expect((await inspect("ls", ctx)).opaque?.reason).toBe("dialect")
  })
})
