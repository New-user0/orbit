import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import approve from "../src/commands/handlers/flow/approve"
import cost from "../src/commands/handlers/flow/cost"
import ls from "../src/commands/handlers/flow/ls"
import show from "../src/commands/handlers/flow/show"
import trace from "../src/commands/handlers/flow/trace"
import watch from "../src/commands/handlers/flow/watch"
import { ORBIT_VERSION } from "../src/version"

// The readers of a folder's run store (`orb flow ls`, `show`, `cost`, `trace`, `watch`, `approve`) ask the server whether
// the folder is trusted before they open the store (trust-first, class 12; FU-M4-202). `trust-first.test.ts` runs each
// one in an untrusted folder as a separate process and sees it stop before the store; these run the same handlers in this
// process against a server that answers "trusted", and see each one go on to the store, which it creates when there is
// none. A server that does not say the folder is trusted would stop them before that (the refusal exits the process).
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-readers-")))
const asked: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION })
    if (url.pathname === "/api/location/trust") {
      const directory = url.searchParams.get("location[directory]") ?? ""
      asked.push(directory)
      return Response.json({ directory, trusted: true, persistent: true, source: "saved", withheld: [], changed: [] })
    }
    return new Response("not found", { status: 404 })
  },
})
const before = process.env.PWD

beforeAll(() => {
  // The readers take their folder from PWD, as `orb` started in that folder would.
  process.env.PWD = root
})

afterAll(async () => {
  if (before === undefined) delete process.env.PWD
  else process.env.PWD = before
  await server.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const connection = { server: Option.some(server.url.origin), standalone: false, trust: false }

const failure = async (effect: Effect.Effect<unknown, unknown, Effect.Services<ReturnType<typeof ls>>>) => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

test("a trusted folder's run store is opened by every reader once the server says the folder is trusted", async () => {
  expect(await failure(ls({ ...connection, format: "json" }))).toBeUndefined()
  // The store did not exist; the reader made it, which it does only after the trust check.
  expect(await Bun.file(path.join(root, ".orbit", "runs.db")).exists()).toBe(true)

  // The other readers ask for a run the store does not have, so each one fails only after it read the store.
  expect(await failure(show({ ...connection, run: "run-none", format: "table" }))).toBe(
    "No run run-none in this repository",
  )
  expect(await failure(cost({ ...connection, run: "run-none", format: "table" }))).toBe(
    "No run run-none in this repository",
  )
  expect(
    await failure(trace({ ...connection, run: "run-none", format: "timeline", otlp: Option.none() })),
  ).toBe("No run run-none in this repository")
  expect(await failure(watch({ ...connection, run: Option.none() }))).toBe("No runs in this repository yet")
  expect(
    await failure(approve({ ...connection, run: "run-none", gate: "gate", reject: false, note: Option.none() })),
  ).toContain("run-none")

  // Each reader asked about the folder it was started in, before anything else.
  expect(asked).toEqual([root, root, root, root, root, root])
})
