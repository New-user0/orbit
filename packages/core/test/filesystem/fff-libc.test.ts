import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/tmpdir"

// The file finder's library (@ff-labs/fff-bun) picks its native binary by the C library, and on Linux it found that by
// running `ldd --version` through a synchronous spawn when it first loads its library. In Bun a synchronous spawn on
// Linux sometimes never returns after its child exits: the process spins at full CPU and leaves the child a zombie. A
// Linux Docker run of the core suite caught a test worker stuck in exactly that call
// (`/bin/sh -c "ldd --version 2>&1"`, timeout 5000, never returned) and the job never ended. Every process that loads the
// finder from source (tests, `bun run dev`) made that call, so loading it must start no program at all.
//
// The child below records every synchronous spawn (node's execSync and spawnSync go through Bun.spawnSync) and then
// asks the finder whether its library is available, which is the first load.

test.skipIf(process.platform !== "linux")("loading the file finder starts no program synchronously", async () => {
  await using dir = await tmpdir()
  const log = path.join(dir.path, "spawned.txt")
  const fff = path.resolve(import.meta.dir, "../../src/filesystem/fff.bun.ts")
  const script = `
import { appendFileSync } from "node:fs"
const original = Bun.spawnSync
Bun.spawnSync = (...args) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(Array.isArray(args[0]) ? args[0] : args[0].cmd) + "\\n")
  return original(...args)
}
const { Fff } = await import(${JSON.stringify(fff)})
console.log("available", Fff.available())
`
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(deadline)
  // Control: the child really loaded the finder and asked for its library.
  expect({ code, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: "available true", stderr: "" })
  const spawned = (await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n") : []
  expect(spawned).toEqual([])
})
