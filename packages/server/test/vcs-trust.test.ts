import path from "node:path"
import { expect } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect, Schedule } from "effect"
import { keys, planted, type Key } from "../../core/test/fixture/git-keys"
import { traced } from "../../core/test/fixture/git-trace"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// Class 1 (register FU-M1-022), over the real server: a client opens a folder and asks for its branch, status and diff before
// anyone is asked about trusting it. Git applies the folder's own `.git/config`, so the filter, text conversion and
// signature programs that it names would run. A server that trusts no folder on its own starts no git for it and runs none
// of them, and starts them once a request trusts the folder, with no reconnect. A server that trusts every folder is the
// control. The oracle is git's trace of every process it starts and a program that the config names and that records its runs.
const untrusted = { trust: { implicit: false } }
// The keys that a command of the provider reaches (`provider: true`), and the one that it switches off, over HTTP.
const rows = keys.filter((key) => key.name === "core.fsmonitor" || key.provider === true)
const SLOW = 90_000

/** What the endpoints of the provider answer for a folder, once the provider is registered. */
const answers = (server: { base: string; headers: Record<string, string> }, directory: string) =>
  Effect.gen(function* () {
    const get = (pathname: string, extra: Record<string, string> = {}) =>
      Effect.promise(async () => {
        const url = new URL(pathname, server.base)
        url.searchParams.set("location[directory]", directory)
        for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value)
        const response = await fetch(url, { headers: server.headers })
        return { status: response.status, body: (await response.json()) as { data?: unknown } }
      })
    // The provider registers when the location's plugins have started, so the first answers may be those of no provider.
    const info = yield* get("/api/vcs").pipe(
      Effect.filterOrFail((answer) => (answer.body.data as { provider?: string } | undefined)?.provider === "git"),
      Effect.retry(Schedule.spaced("20 millis")),
      Effect.timeout("10 seconds"),
    )
    return {
      info: info.body.data,
      status: (yield* get("/api/vcs/status")).body.data,
      working: (yield* get("/api/vcs/diff", { mode: "working" })).body.data,
      branches: (yield* get("/api/vcs/branch")).body.data,
      base: (yield* get("/api/vcs/base")).status,
    }
  })

const withKey = (key: Key) =>
  Effect.gen(function* () {
    const found = yield* planted(key)
    return { found, config: path.join(found.folder, "config") }
  })

for (const key of rows) {
  it.live(
    `serves a clone that sets ${key.name} with no git, and starts git once a request trusts the folder`,
    () =>
      Effect.gen(function* () {
        const { found, config } = yield* withKey(key)
        const server = yield* startServer(config, untrusted)
        const api = Orbit.make({ baseUrl: server.base, headers: server.headers })

        const before = yield* traced(answers(server, found.root))

        expect(before.git).toEqual([])
        expect(yield* found.ran()).toEqual([])
        expect(before.value.info).toEqual({ provider: "git", branch: {} })
        expect(before.value.status).toEqual([])
        expect(before.value.working).toEqual([])
        expect(before.value.branches).toEqual([])

        yield* Effect.promise(() => api.location.trust.update({ location: { directory: found.root }, trust: true }))
        // The grant reloads the provider, which answers from git now.
        const after = yield* traced(
          Effect.gen(function* () {
            return yield* Effect.promise(async () => {
              const url = new URL("/api/vcs/status", server.base)
              url.searchParams.set("location[directory]", found.root)
              const response = await fetch(url, { headers: server.headers })
              return ((await response.json()) as { data: readonly { file: string }[] }).data
            }).pipe(
              Effect.filterOrFail((rows) => rows.length > 0),
              Effect.retry(Schedule.spaced("20 millis")),
              Effect.timeout("10 seconds"),
            )
          }),
        )
        expect(after.value.map((row) => row.file)).toContain("a.txt")
        expect(after.git.some((command) => command.includes("status"))).toBe(true)
      }),
    SLOW,
  )

  it.live(
    `serves a trusted clone that sets ${key.name} from git, as the control`,
    () =>
      Effect.gen(function* () {
        const { found, config } = yield* withKey(key)
        const server = yield* startServer(config, { trust: { implicit: true } })

        const { value, git } = yield* traced(answers(server, found.root))

        expect(git.some((command) => command.includes("status"))).toBe(true)
        expect(value.info).toMatchObject({ provider: "git", branch: { current: "main" } })
        // `true`: a command of the provider runs the program. `false`: the provider switches it off.
        if (key.provider === true) expect((yield* found.ran()).length).toBeGreaterThan(0)
        if (key.provider === false) expect(yield* found.ran()).toEqual([])
      }),
    SLOW,
  )
}
