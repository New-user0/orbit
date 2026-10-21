import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import doctor from "../src/commands/handlers/doctor"
import importSession from "../src/commands/handlers/session/import"
import { ORBIT_VERSION } from "../src/version"

// `orb doctor --probe` and `orb session import` start work in a folder, so each asks the server whether that folder is
// trusted before it starts anything there (trust-first, class 12), and the folder it asks about is the one the work then
// lands in (class 3): the folder `orb` was started in (PWD), or the one `--directory` names. `trust-first.test.ts` runs
// both in an untrusted folder as separate processes and sees each stop; these run the same handlers in this process
// against a server that answers "trusted", and see each ask first and then work in the very folder it asked about. The
// test process's own folder is a different one, so a handler that used it would be seen.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trust-first-handlers-")))
const started = path.join(root, "started")
const named = path.join(root, "named")
const model = "ollama/doctor:1b"
// Every request the server got, in order, as "<method> <path> <folder>", where the folder is the one the request names.
const requests: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json()
    const folder =
      url.searchParams.get("location[directory]") ??
      (body as { location?: { directory?: string } } | undefined)?.location?.directory ??
      ""
    requests.push(`${request.method} ${url.pathname} ${folder}`)
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION })
    if (url.pathname === "/api/location/trust")
      return Response.json({
        directory: folder,
        trusted: true,
        persistent: true,
        source: "saved",
        withheld: [],
        changed: [],
      })
    if (url.pathname === "/api/location")
      return Response.json({ directory: folder, project: { id: "global", directory: folder, canonical: folder } })
    if (url.pathname === "/api/model") return Response.json({ data: [{ providerID: "ollama", id: "doctor:1b" }] })
    if (url.pathname === "/api/session" && request.method === "POST")
      return Response.json({ data: { id: "ses_doctor_probe" } })
    if (url.pathname === "/api/session/ses_doctor_probe/generate") return Response.json({ data: { text: "ok" } })
    if (url.pathname === "/api/session/ses_doctor_probe") return new Response(null, { status: 204 })
    if (url.pathname === "/api/provider")
      return Response.json({ data: [{ id: "ollama", settings: { baseURL: `${url.origin}/v1` } }] })
    if (url.pathname === "/api/ps") return Response.json({ models: [] })
    if (url.pathname === "/api/experimental/session/import")
      return Response.json({ data: { ...session, location: { directory: folder } } })
    return new Response("not found", { status: 404 })
  },
})
const session = {
  id: "ses_trust_first_handlers",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Exported session",
  location: { directory: "/project" },
}
const file = path.join(root, "session.json")
const before = process.env.PWD

beforeAll(async () => {
  await Promise.all([started, named].map((folder) => fs.mkdir(folder, { recursive: true })))
  await Bun.write(
    file,
    JSON.stringify({
      info: session,
      messages: [{ id: "msg_first", type: "user", text: "First", time: { created: 1 } }],
    }),
  )
  // The handlers take their folder from PWD, as `orb` started in that folder would.
  process.env.PWD = started
})

afterAll(async () => {
  if (before === undefined) delete process.env.PWD
  else process.env.PWD = before
  await server.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const connection = { server: Option.some(server.url.origin), standalone: false, trust: false }

const run = async (
  effect: Effect.Effect<
    unknown,
    unknown,
    Effect.Services<ReturnType<typeof doctor>> | Effect.Services<ReturnType<typeof importSession>>
  >,
) => {
  requests.length = 0
  // A check this host fails (a missing ripgrep, say) sets the exit code; this test is about the probe, not the host.
  const code = process.exitCode
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  process.exitCode = code
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  // The version check that connecting makes is not about a folder.
  return requests.filter((line) => !line.startsWith("GET /api/info"))
}

test("orb doctor --probe asks about the folder it was started in before its probe session, and probes in that folder", async () => {
  const seen = await run(doctor({ ...connection, probe: true, model: Option.some(model) }))
  expect(seen[0]).toBe(`GET /api/location/trust ${started}`)
  expect(seen).toContain(`POST /api/session ${started}`)
  expect(seen).toContain(`GET /api/provider ${started}`)
})

test("orb session import asks about the folder the session lands in before it imports, and imports it there", async () => {
  expect(await run(importSession({ ...connection, file, directory: Option.none() }))).toEqual([
    `GET /api/location/trust ${started}`,
    `GET /api/location ${started}`,
    `POST /api/experimental/session/import ${started}`,
  ])
  // --directory names another folder, which is then the one asked about and the one the session lands in.
  expect(await run(importSession({ ...connection, file, directory: Option.some(named) }))).toEqual([
    `GET /api/location/trust ${named}`,
    `GET /api/location ${named}`,
    `POST /api/experimental/session/import ${named}`,
  ])
})
