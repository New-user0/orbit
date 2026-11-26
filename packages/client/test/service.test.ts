import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { writeFile } from "node:fs/promises"
import { Service, type EnsureReason } from "../src/effect/service"
import { defaultEnsureTiming } from "../src/service-timing"
import { recordedSignal, serviceFixture, stoppedByClient } from "./fixture/service-fixture"
import { accelerate } from "./fixture/service-timing"

const ensure = accelerate(Service.ensure)

test("a concurrent same-version start cannot invalidate a resolved endpoint", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  fixture.spawn("modern")
  await fixture.waitForFile()
  const original = await Bun.file(registration).json()

  const starts: EnsureReason[] = []
  const first = run(
    ensure({
      file: registration,
      version: "test",
      command: [],
      onStart: (reason) => starts.push(reason),
    }),
  )
  await fixture.waitForFile(registration + ".first-request")

  const resolved = await run(ensure({ file: registration, version: "test" }))
  expect(resolved.url).toBe(original.url)

  await writeFile(registration + ".release", "")
  await first

  expect(starts).toEqual([])
  expect(await Bun.file(registration).json()).toEqual(original)
  expect(await status(resolved.url)).toMatchObject({ version: "test", pid: original.pid })
})

test("reuses a compatible registered service", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const existing = fixture.spawn("compatible")
  await fixture.waitForFile()

  const starts: EnsureReason[] = []
  const endpoint = await run(
    ensure({
      file: registration,
      version: (version) => version.startsWith("2."),
      command: [],
      onStart: (reason) => starts.push(reason),
    }),
  )

  expect(endpoint.url).toBe((await Bun.file(registration).json()).url)
  expect(starts).toEqual([])
  expect(existing.exitCode).toBe(null)
})

test("adds configured environment variables when starting a service", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const endpoint = await run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("environment"),
      env: { ORBIT_SERVICE_ENV_TEST: "configured" },
    }),
  )
  const info = await Bun.file(registration).json()
  fixture.track(info.pid)

  expect(endpoint.url).toBe(info.url)
  expect(await Bun.file(registration + ".environment").text()).toBe("configured")
})

test("replaces an incompatible registered service", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const existing = fixture.spawn("incompatible")
  await fixture.waitForFile()

  const starts: EnsureReason[] = []
  const endpoint = await run(
    ensure({
      file: registration,
      version: (version) => version.startsWith("2."),
      command: fixture.command("delayed-compatible", "10"),
      onStart: (reason) => starts.push(reason),
    }),
  )
  const replacement = await Bun.file(registration).json()
  fixture.track(replacement.pid)

  expect(await existing.exited).toBe(stoppedByClient.exitCode)
  expect(replacement.version).toBe("2.1.0-next.1")
  expect(endpoint.url).toBe(replacement.url)
  expect(starts).toEqual(["version-mismatch"])
})

// The service answers each status probe after 300 ms, as a starting one did under load in CI run 45533775334, where
// three probes past the accelerated 100 ms limit made `ensure` judge it unresponsive and start a replacement, which
// this row gives no command. The row is about waiting and not about an unresponsive service, so its probes get the
// product's own limit.
const patient = accelerate(Service.ensure, { requestTimeout: defaultEnsureTiming.requestTimeout })

test("waits for a registered service to finish starting", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const process = fixture.spawn("starting", "300")
  await fixture.waitForFile()
  const result = run(patient({ file: registration, version: "test", command: [] }))

  await fixture.waitForFile(registration + ".status-request")
  expect(process.exitCode).toBe(null)
  await writeFile(registration + ".release", "")
  expect((await result).url).toBe((await Bun.file(registration).json()).url)
})

test("reports a failed registered service without spawning", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const process = fixture.spawn("failed-owner")
  await fixture.waitForFile()

  await expect(run(ensure({ file: registration, version: "test", command: [] }))).rejects.toThrow(
    "Background service failed to start",
  )
  expect(process.exitCode).toBe(null)
})

test("evicts an unresponsive registered service before starting its replacement", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const existing = fixture.spawn("hanging")
  await fixture.waitForFile()
  const original = await Bun.file(registration).json()

  const endpoint = await run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("delayed", "10"),
    }),
  )
  const replacement = await Bun.file(registration).json()
  fixture.track(replacement.pid)

  expect((await Bun.file(registration + ".requests").text()).trim().split("\n")).toHaveLength(3)
  expect(await existing.exited).toBe(stoppedByClient.exitCode)
  expect(replacement.pid).not.toBe(original.pid)
  expect(endpoint.url).toBe(replacement.url)
  expect(await status(endpoint.url)).toMatchObject({ version: "test", pid: replacement.pid })
})

test("signals an unresponsive registered service process", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const process = fixture.spawn("hanging")
  await fixture.waitForFile()

  await run(Service.stop({ file: registration }))
  await process.exited
  expect(await recordedSignal(registration)).toBe(stoppedByClient.signal)
  expect(await Bun.file(registration).exists()).toBe(false)
})

test("signals an incompatible service before starting its replacement", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const existing = fixture.spawn("old")
  await fixture.waitForFile()
  const endpoint = await run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("delayed", "10"),
    }),
  )
  const replacement = await Bun.file(registration).json()
  fixture.track(replacement.pid)

  expect(await existing.exited).toBe(stoppedByClient.exitCode)
  expect(endpoint.url).toBe(replacement.url)
})

// What `ensure` promises while a winner is slow to register: at most one candidate and one lock probe alive at once,
// the registered service is the winner, and every loser exited. How many probes it starts depends on how slow the
// winner is next to the backed-off spawn delay: a loaded Windows runner saw a third start where the row once counted
// exactly two (run 44986694512), so the rows check the bound and not a total. The second row holds the winner a second
// past the delay, which starts more probes every time.
test.each([
  ["a slow winner", []],
  ["a winner held a second past the spawn delay", ["1000"]],
] as const)("waits for %s while bounding lock probes", async (_, extra) => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const endpoint = await run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("coordinated", ...extra),
    }),
  )
  const info = await Bun.file(registration).json()
  fixture.track(info.pid)

  expect(endpoint.url).toBe(info.url)
  expect(await status(endpoint.url)).toMatchObject({ version: "test", pid: info.pid })
  const events = (await Bun.file(registration + ".events").text())
    .trim()
    .split("\n")
    .map((line) => line.split(" "))
  const alive = events.reduce(
    (state, [kind]) => {
      const now = state.now + (kind === "start" ? 1 : -1)
      return { now, most: Math.max(state.most, now) }
    },
    { now: 0, most: 0 },
  )
  const started = events.flatMap(([kind, pid]) => (kind === "start" ? [Number(pid)] : []))
  const exited = events.flatMap(([kind, pid]) => (kind === "exit" ? [Number(pid)] : []))
  expect(alive.most).toBeLessThanOrEqual(2)
  expect(started.length).toBeGreaterThanOrEqual(2)
  expect(started).toContain(info.pid)
  expect(exited.toSorted()).toEqual(started.filter((pid) => pid !== info.pid).toSorted())
})

test("waits for a live contender when another contender fails", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const endpoint = await run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("coordinated-failed-loser", "300"),
    }),
  )
  const info = await Bun.file(registration).json()
  fixture.track(info.pid)

  expect(endpoint.url).toBe(info.url)
})

test("reports a contender that fails to start", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  await expect(
    run(
      ensure({
        file: registration,
        version: "test",
        command: fixture.command("failed"),
      }),
    ),
  ).rejects.toThrow("Server process exited with code 1")
})

test("reports a bounded contender stderr tail", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const error = await run(
    Service.ensure({
      file: registration,
      version: "test",
      command: fixture.command("stderr-failed"),
    }),
  ).catch((error: unknown) => error)

  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw error
  expect(error.message).toContain("actionable startup failure")
  expect(error.message.length).toBeLessThan(9_000)
}, 10_000)

test("reports a contender terminated by a signal", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  await expect(
    run(
      ensure({
        file: registration,
        version: "test",
        command: fixture.command("signal"),
      }),
    ),
  ).rejects.toThrow(/Server process (terminated by|exited with code)/)
})

test("reports a slow contender that eventually fails", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  await expect(
    run(
      ensure({
        file: registration,
        version: "test",
        command: fixture.command("delayed-failed", "500"),
      }),
    ),
  ).rejects.toThrow("Server process exited with code 1")
})

test("replaces an incompatible owner that appears during startup", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const starting = run(
    ensure({
      file: registration,
      version: "test",
      command: fixture.command("delayed", "500"),
    }),
  )
  await fixture.waitForFile(registration + ".starts")
  const old = fixture.spawn("old")
  await fixture.waitForFile()
  const endpoint = await starting
  const info = await Bun.file(registration).json()
  fixture.track(info.pid)

  expect(endpoint.url).toBe(info.url)
  expect(info.version).toBe("test")
  await old.exited
})

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}

async function status(url: string) {
  return fetch(new URL("/api/info", url), { signal: AbortSignal.timeout(1_000) }).then((response) => response.json())
}
