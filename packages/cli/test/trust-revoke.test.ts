import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import trust from "../src/commands/handlers/trust"
import { ORBIT_VERSION } from "../src/version"

// `orb trust` in this process, against a server that answers with the status the trust store gives after the request.
// A folder that a grant for a folder above covers stays trusted after its own revoke, and the answer names that folder
// as the one whose grant to end; a server that trusts every folder is named as the reason only when it is (class 3).
// `trust.test.ts` runs the same command as a separate process against a real server.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trust-revoke-")))
const parent = path.join(root, "parent")
const child = path.join(parent, "child")
await fs.mkdir(child, { recursive: true })
// What the server answers about the folder: before a grant (GET) and after the request (POST).
let before: Record<string, unknown> = {}
let after: Record<string, unknown> = {}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION })
    if (url.pathname === "/api/trust") return Response.json([])
    if (url.pathname !== "/api/location/trust") return new Response("not found", { status: 404 })
    const directory = url.searchParams.get("location[directory]") ?? ""
    return Response.json({
      directory,
      persistent: true,
      withheld: [],
      changed: [],
      ...(request.method === "GET" ? before : after),
    })
  },
})
const written = spyOn(process.stdout, "write")

afterEach(() => written.mockClear())

afterAll(async () => {
  written.mockRestore()
  await server.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const run = async (input: { readonly revoke: boolean }) => {
  const exit = await Effect.runPromiseExit(
    trust({
      list: false,
      revoke: input.revoke,
      directory: Option.some(child),
      for: Option.none(),
      server: Option.some(server.url.origin),
      standalone: false,
    }).pipe(
      Effect.scoped,
      Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return written.mock.calls.map((call) => String(call[0])).join("")
}

test("a revoked folder that a parent's grant still covers is said to be trusted through that parent", async () => {
  after = { trusted: true, source: "saved", granted: parent }

  const printed = await run({ revoke: true })

  expect(printed).toContain(`${child} is still trusted, because ${parent} is trusted`)
  expect(printed).toContain("End that grant with: orb trust --revoke")
  expect(printed).not.toContain("trusts every folder")
})

test("a covering folder whose name no quoting makes safe gets no command to paste", async () => {
  after = { trusted: true, source: "saved", granted: `${parent}\nrm -rf x` }

  const printed = await run({ revoke: true })

  expect(printed).toContain("is not printed as a command")
  expect(printed).not.toContain("End that grant with: orb trust --revoke ")
})

test("a server that trusts every folder is named as the reason, and an ended grant says the folder is not trusted: the controls", async () => {
  after = { trusted: true, source: "implicit" }
  expect(await run({ revoke: true })).toContain(`${child} is still trusted: this server trusts every folder`)

  written.mockClear()
  after = { trusted: false }
  expect(await run({ revoke: true })).toContain(`${child} is not trusted.`)
})

test("trusting a folder that only a parent's grant covers stores a grant of its own", async () => {
  before = { trusted: true, source: "saved", granted: parent }
  after = { trusted: true, source: "saved" }

  const printed = await run({ revoke: false })

  expect(printed).toContain(`Trusted ${child}`)
  expect(printed).not.toContain("already trusted")
})
