import { expect, test } from "bun:test"
import path from "path"

test("each managed network warning is logged once per process, and only when it applies", async () => {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixture/managed-network-warnings.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(exitCode).toBe(0)
  const lines: string[] = JSON.parse(stdout.trim().split("\n").at(-1)!)
  expect(lines.filter((line) => line.includes("sandbox network is off"))).toHaveLength(1)
  expect(lines.filter((line) => line.includes("do not bind shell commands"))).toHaveLength(1)
  expect(lines).toHaveLength(2)
})
