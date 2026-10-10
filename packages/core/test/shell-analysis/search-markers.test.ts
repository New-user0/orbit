import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { which } from "../../src/util/which"
import { bash, pwsh, powershell } from "./helper"

// Each attack plants a marker outside a temporary project and a control run shows that the attack really reads it. The
// verdict then has to refuse the attack and allow the safe form (class 14: a negative test must not pass vacuously).

const bashPath = which("bash")
const windows = process.platform === "win32"
const dirs: string[] = []

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbit-search-")))
  dirs.push(root)
  const outside = path.join(root, "outside")
  const inside = path.join(root, "project")
  fs.mkdirSync(outside)
  fs.mkdirSync(inside)
  fs.writeFileSync(path.join(outside, "marker.txt"), "OUTSIDE_MARKER\n")
  return { root, outside, inside }
}

function run(cwd: string, command: string) {
  const result = Bun.spawnSync([bashPath!, "-c", command], { cwd, env: { ...process.env, RIPGREP_CONFIG_PATH: "" } })
  return result.stdout.toString() + result.stderr.toString()
}

function link(target: string, at: string) {
  try {
    fs.symlinkSync(target, at, windows ? "junction" : "dir")
    return true
  } catch {
    return false
  }
}

process.on("exit", () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe("xargs splits a name at a blank", () => {
  test("a directory named `a ` plus an absolute path reads the outside marker", () => {
    if (!bashPath) return
    const { outside, inside } = project()
    // `./a <outside>/x.txt` splits into `./a` and `<outside>/x.txt`.
    const planted = path.join(inside, `a ${outside}`)
    try {
      fs.mkdirSync(planted, { recursive: true })
    } catch {
      return
    }
    fs.writeFileSync(path.join(planted, "marker.txt"), "INSIDE\n")
    fs.writeFileSync(path.join(outside, "marker.txt"), "OUTSIDE_MARKER\n")
    const unsafe = "find . -type f | xargs head"
    const safe = "find . -type f -print0 | xargs -0 head"
    // Control: the attack prints the marker.
    expect(run(inside, unsafe)).toContain("OUTSIDE_MARKER")
    expect(bash(unsafe).readOnly).toBe(false)
    // The safe form prints only the files that exist under the project and is read-only.
    const output = run(inside, safe)
    expect(output).not.toContain("OUTSIDE_MARKER")
    expect(output).toContain("INSIDE")
    expect(bash(safe).readOnly).toBe(true)
  })
})

describe("recursion that follows a link", () => {
  test("grep -R reads through a link and grep -r does not", () => {
    if (!bashPath) return
    const { outside, inside } = project()
    if (!link(outside, path.join(inside, "docs"))) return
    const control = run(inside, "grep -R OUTSIDE_MARKER .")
    // A grep that does not follow the link in this environment gives nothing to compare against.
    if (!control.includes("OUTSIDE_MARKER")) return
    expect(run(inside, "grep -r OUTSIDE_MARKER .")).not.toContain("OUTSIDE_MARKER")
    expect(bash("grep -R OUTSIDE_MARKER .").readOnly).toBe(false)
    expect(bash("grep -r OUTSIDE_MARKER .").readOnly).toBe(true)
  })
  test("rg -L reads through a link and rg does not", () => {
    if (!bashPath || !which("rg")) return
    const { outside, inside } = project()
    if (!link(outside, path.join(inside, "docs"))) return
    expect(run(inside, "rg -L OUTSIDE_MARKER")).toContain("OUTSIDE_MARKER")
    expect(run(inside, "rg OUTSIDE_MARKER")).not.toContain("OUTSIDE_MARKER")
    expect(bash("rg -L OUTSIDE_MARKER").readOnly).toBe(false)
    expect(bash("rg OUTSIDE_MARKER").readOnly).toBe(true)
  })
  test("findstr /S reads through a junction, so it is not on the list", () => {
    if (!windows) return
    const { outside, inside } = project()
    if (!link(outside, path.join(inside, "docs"))) return
    const result = Bun.spawnSync(["findstr", "/S", "/M", "OUTSIDE_MARKER", "*"], { cwd: inside })
    expect(result.stdout.toString()).toContain("marker.txt")
    expect(powershell("findstr /S foo *.ts", pwsh()).readOnly).toBe(false)
    expect(powershell("findstr /I foo *.ts", pwsh()).readOnly).toBe(true)
  })
})

describe("the program a search starts", () => {
  test("rg --pre runs a program per file, and the verdict refuses it", () => {
    if (!bashPath || !which("rg") || windows) return
    const { inside } = project()
    fs.writeFileSync(path.join(inside, "a.txt"), "hello\n")
    fs.writeFileSync(path.join(inside, "pre.sh"), "#!/bin/sh\necho PRE_RAN > ran.txt\ncat \"$1\"\n", { mode: 0o755 })
    expect(run(inside, "rg --pre ./pre.sh hello a.txt")).toContain("hello")
    expect(fs.existsSync(path.join(inside, "ran.txt"))).toBe(true)
    expect(bash("rg --pre ./pre.sh hello a.txt").readOnly).toBe(false)
  })
  test("find -exec writes a file, and the verdict refuses it", () => {
    if (!bashPath) return
    const { inside } = project()
    fs.writeFileSync(path.join(inside, "a.txt"), "x\n")
    run(inside, "find . -name a.txt -exec touch made.txt ';'")
    expect(fs.existsSync(path.join(inside, "made.txt"))).toBe(true)
    expect(bash("find . -name a.txt -exec touch made.txt ';'").readOnly).toBe(false)
  })
  test("sed w writes a file, and the verdict refuses it", () => {
    if (!bashPath) return
    const { inside } = project()
    fs.writeFileSync(path.join(inside, "a.txt"), "x\n")
    run(inside, "sed -n 'w copy.txt' a.txt")
    expect(fs.existsSync(path.join(inside, "copy.txt"))).toBe(true)
    expect(bash("sed -n 'w copy.txt' a.txt").readOnly).toBe(false)
    expect(bash("sed -n 1p a.txt").readOnly).toBe(true)
  })
})
