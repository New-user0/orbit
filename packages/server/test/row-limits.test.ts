// A row that builds a real server (the embedded routes, ServerFetch, the workerd profile or a server process on a port)
// takes 2 to 3 s on a developer's machine and up to 5 s on a GitHub Windows runner: bun's JUnit report of 22 runs of
// the Windows server job, on this branch and on the base alike, put such rows at 3.5 to 5.4 s, so bun's 5 s default
// failed them at random. Each file that builds a server therefore sets a default limit of at least 30 s, as
// session-diff.test.ts already did, and each wait for a server to become ready (a retried or repeated check with a time
// limit) allows at least 10 s. A row that hangs still fails, at its own limit. A time limit on a single request pins
// that the request does not wait, and stays.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const files = fs
  .readdirSync(import.meta.dir)
  .filter((name) => name.endsWith(".test.ts") && name !== path.basename(import.meta.path))
  .map((name) => ({ name, text: fs.readFileSync(path.join(import.meta.dir, name), "utf8") }))
const building = files.filter((file) => buildsServer(file.text))

describe("server test limits", () => {
  test("the matchers find a server build, a file's default limit and a short wait for readiness, and leave the controls alone", () => {
    expect(buildsServer(`import { startServer } from "./fixture/server"`)).toBe(true)
    expect(buildsServer(`import { ServerFetch } from "../src/fetch"`)).toBe(true)
    expect(buildsServer(`import { createEmbeddedRoutes } from "../src/routes"`)).toBe(true)
    expect(buildsServer(`import { ServerProcess } from "../src/process"`)).toBe(true)
    expect(buildsServer(`import { ServerWorkerd } from "../src/workerd"`)).toBe(true)
    expect(buildsServer(`import { CorsConfig } from "../src/cors"`)).toBe(false)
    expect(defaultLimit(`import { expect } from "bun:test"\n\nsetDefaultTimeout(30_000)\n`)).toBe(30_000)
    expect(defaultLimit(`it.live("x", () => {\n  setDefaultTimeout(30_000)\n})`)).toBeUndefined()
    expect(defaultLimit(`it.live("x", () => Effect.void, 30_000)`)).toBeUndefined()
    expect(limited(`setDefaultTimeout(30_000)`)).toBe(true)
    expect(limited(`setDefaultTimeout(15_000)`)).toBe(false)
    expect(limited(`import { expect } from "bun:test"`)).toBe(false)
    expect(
      shortWaits(`}).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("2 seconds"))`),
    ).toEqual([`Effect.timeout("2 seconds")`])
    expect(
      shortWaits(
        `count.pipe(\n  Effect.repeat({ while: (n) => n === 0, schedule: Schedule.spaced("25 millis") }),\n  Effect.timeout("5 seconds"),\n)`,
      ),
    ).toEqual([`Effect.timeout("5 seconds")`])
    expect(shortWaits(`Effect.retry(Schedule.spaced("10 millis")),\n      Effect.timeout("500 millis"),`)).toEqual([
      `Effect.timeout("500 millis")`,
    ])
    expect(shortWaits(`Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("10 seconds")`)).toEqual([])
    expect(shortWaits(`request("GET", "/api/provider").pipe(Effect.timeout("2 seconds"))`)).toEqual([])
  })

  // The files whose rows timed out in CI build a server, so the list below is not empty by accident.
  test("the files that met bun's default in CI are among the files that build a server", () => {
    expect(building.map((file) => file.name)).toEqual(
      expect.arrayContaining([
        "location-memory.test.ts",
        "session-context-usage.test.ts",
        "session-instructions.test.ts",
        "trust-first.test.ts",
        "vcs.test.ts",
        "worktree.test.ts",
      ]),
    )
  })

  for (const file of building)
    test(`${file.name} gives each row at least 30 s`, () => {
      expect(limited(file.text)).toBe(true)
    })

  test("no wait for a server to become ready allows less than 10 s", () => {
    expect(files.flatMap((file) => shortWaits(file.text).map((wait) => `${file.name}: ${wait}`))).toEqual([])
  })
})

// A test file builds a server when it imports the server fixture, ServerFetch, the embedded routes, the server process
// that the fixture wraps, or the workerd profile.
function buildsServer(text: string) {
  return /from "(\.\/fixture\/server|\.\.\/src\/(fetch|routes|process|workerd))"/.test(text)
}

// Whether a file's own default gives each row at least 30 s.
function limited(text: string) {
  return (defaultLimit(text) ?? 0) >= 30_000
}

// The default limit a file sets at its top level.
function defaultLimit(text: string) {
  const match = /^setDefaultTimeout\(([0-9_]+)\)/m.exec(text)
  return match ? Number(match[1].replaceAll("_", "")) : undefined
}

// Each `Effect.timeout` under 10 s that directly follows an `Effect.retry` or `Effect.repeat` in the same pipe.
function shortWaits(text: string) {
  return [
    ...text.matchAll(
      /Effect\.(?:retry|repeat)\((?:[^()]|\([^()]*\))*\)\s*,\s*(Effect\.timeout\("(\d+) (seconds|millis)"\))/g,
    ),
  ]
    .filter((match) => Number(match[2]) * (match[3] === "seconds" ? 1000 : 1) < 10_000)
    .map((match) => match[1])
}
