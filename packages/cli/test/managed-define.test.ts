import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { ManagedPath } from "@orbit/util/managed-path"
import { managedDefine } from "../script/managed-define"

// FU-M3-054: a released build must not let an environment move the organization's policy folder. The build replaces
// the one read of the override with `undefined`; this bundles a small entry the way the build does and runs it.
const source = path.resolve(import.meta.dirname, "../../util/src/managed-path.ts")

const run = async (define: Record<string, string>) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbit-managed-define-"))
  try {
    await writeFile(
      path.join(directory, "entry.ts"),
      `import { ManagedPath } from ${JSON.stringify(source)}\nconsole.log(ManagedPath.directory(process.platform, process.env))\n`,
    )
    const built = await Bun.build({
      entrypoints: [path.join(directory, "entry.ts")],
      outdir: path.join(directory, "out"),
      target: "bun",
      define,
    })
    expect(built.success).toBe(true)
    const child = Bun.spawn([process.execPath, path.join(directory, "out", "entry.js")], {
      env: { ...process.env, ORBIT_MANAGED_DIR: path.resolve(directory, "elsewhere") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { out: out.trim(), elsewhere: path.resolve(directory, "elsewhere") }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("a build with the managed define resolves the per-OS folder whatever ORBIT_MANAGED_DIR says", async () => {
  const built = await run(managedDefine)
  expect(built.out).toBe(ManagedPath.directory(process.platform, {}))
  expect(built.out).not.toBe(built.elsewhere)
}, 30_000)

test("the build applies the define", async () => {
  expect(await Bun.file(path.resolve(import.meta.dirname, "../script/build.ts")).text()).toContain("...managedDefine")
})

test("control: the same entry without the define honours the variable", async () => {
  const built = await run({})
  expect(built.out).toBe(built.elsewhere)
}, 30_000)
