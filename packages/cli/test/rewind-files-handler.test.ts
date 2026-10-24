import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { headlessInput } from "../src/commands/handlers/run"
import { ORBIT_VERSION } from "../src/version"

// clients-ux-5: `--rewind-files` in `orb run` and `orb -p`. `rewind-files.test.ts` runs the whole path against a real
// server in a separate process; these run the same handler in this process against a server that answers as told, so
// each refusal is seen with the request it did or did not make: a rewind that names no session, or that comes with a
// prompt, is refused before any request; `--continue` takes the folder's latest session, and a folder with none, a
// lookup that fails and a rewind the server refuses each exit 1 with their reason on standard error.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-rewind-handler-")))
const session = {
  id: "ses_rewind_handler",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Rewind",
  location: { directory: root },
}
const replies = {
  list: (): Response => Response.json({ data: [session], cursor: {} }),
  rewind: (): Response => Response.json({ data: { canRewind: true } }),
}
// Every request the server got, as "<method> <path>", leaving out the version check that connecting makes.
const requests: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION })
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/api/location/trust")
      return Response.json({
        directory: root,
        trusted: true,
        persistent: true,
        source: "saved",
        withheld: [],
        changed: [],
      })
    if (url.pathname === "/api/location")
      return Response.json({ directory: root, project: { id: "global", directory: root, canonical: root } })
    if (url.pathname === "/api/session" && request.method === "GET") return replies.list()
    if (url.pathname === `/api/session/${session.id}` && request.method === "GET")
      return Response.json({ data: session })
    if (url.pathname === `/api/session/${session.id}/revert/files`) return replies.rewind()
    return new Response("not found", { status: 404 })
  },
})
const before = process.env.PWD

beforeAll(() => {
  // The handler takes its folder from PWD, as `orb` started in that folder would.
  process.env.PWD = root
})

afterAll(async () => {
  if (before === undefined) delete process.env.PWD
  else process.env.PWD = before
  await server.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

afterEach(() => {
  ;(process.stdout.write as unknown as { mockRestore?: () => void }).mockRestore?.()
  ;(process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.()
  replies.list = () => Response.json({ data: [session], cursor: {} })
  replies.rewind = () => Response.json({ data: { canRewind: true } })
})

const input = {
  server: Option.some(server.url.origin),
  standalone: false,
  trust: false,
  bare: false,
  settings: [],
  mcpConfig: [],
  agents: Option.none(),
  message: [],
  continue: false,
  session: Option.none(),
  resume: Option.none(),
  fork: false,
  model: Option.none(),
  agent: Option.none(),
  format: "default",
  jsonSchema: Option.none(),
  file: [],
  inputFormat: Option.none(),
  title: Option.none(),
  thinking: false,
  maxSteps: Option.none(),
  maxCost: Option.none(),
  maxTokens: Option.none(),
  fallbackModel: Option.none(),
  auto: false,
  yolo: false,
  dangerouslySkipPermissions: false,
  rewindFiles: Option.some("msg_prompt"),
} satisfies Parameters<typeof headlessInput>[0]

const rewind = async (overrides: Partial<Parameters<typeof headlessInput>[0]>) => {
  requests.length = 0
  const out: string[] = []
  const err: string[] = []
  spyOn(process.stdout, "write").mockImplementation(((text: string) => (out.push(String(text)), true)) as never)
  spyOn(process.stderr, "write").mockImplementation(((text: string) => (err.push(String(text)), true)) as never)
  const code = process.exitCode
  process.exitCode = 0
  const exit = await Effect.runPromiseExit(
    headlessInput({ ...input, ...overrides }).pipe(
      Effect.scoped,
      Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  const result = { code: process.exitCode, out: out.join(""), err: err.join(""), requests: [...requests] }
  // Bun keeps the last code when it is set to undefined, and a refusal's 1 would fail the test run.
  process.exitCode = code ?? 0
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return result
}

test("refuses a rewind that names no session, or that comes with a prompt, before any request", async () => {
  const unnamed = await rewind({})
  expect(unnamed).toMatchObject({ code: 1, out: "", requests: [] })
  expect(unnamed.err).toContain("--rewind-files needs the session named with --session, --continue or --resume")
  for (const prompt of [{ message: ["do more"] }, { file: ["notes.txt"] }]) {
    const refused = await rewind({ session: Option.some(session.id), ...prompt })
    expect(refused).toMatchObject({ code: 1, out: "", requests: [] })
    expect(refused.err).toContain("--rewind-files takes no prompt: it only puts files back")
  }
})

test("rewinds the named session's files, and the latest session's with --continue", async () => {
  expect(await rewind({ session: Option.some(session.id) })).toEqual({
    code: 0,
    out: "Rewound the files to message msg_prompt\n",
    err: "",
    requests: [
      `GET /api/session/${session.id}`,
      "GET /api/location/trust",
      `POST /api/session/${session.id}/revert/files`,
    ],
  })
  expect(await rewind({ continue: true })).toEqual({
    code: 0,
    out: "Rewound the files to message msg_prompt\n",
    err: "",
    requests: [
      "GET /api/location/trust",
      "GET /api/location",
      "GET /api/session",
      `POST /api/session/${session.id}/revert/files`,
    ],
  })
})

test("exits 1 with the reason when --continue finds no session, or its lookup fails, and rewinds nothing", async () => {
  replies.list = () => Response.json({ data: [], cursor: {} })
  const none = await rewind({ continue: true })
  expect(none).toMatchObject({ code: 1, out: "" })
  expect(none.err).toContain("No session to rewind in this folder")
  expect(none.requests).not.toContain(`POST /api/session/${session.id}/revert/files`)

  replies.list = () => new Response("down", { status: 500 })
  const failed = await rewind({ continue: true })
  expect(failed).toMatchObject({ code: 1, out: "" })
  expect(failed.err).not.toBe("")
  expect(failed.requests).not.toContain(`POST /api/session/${session.id}/revert/files`)
})

test("exits 1 with the server's reason when it refuses the rewind", async () => {
  replies.rewind = () =>
    Response.json(
      {
        _tag: "RewindFilesError",
        sessionID: session.id,
        messageID: "msg_prompt",
        reason: "no-checkpoint",
        message: "This message has no checkpoint to rewind the files to.",
      },
      { status: 409 },
    )
  const refused = await rewind({ session: Option.some(session.id) })
  expect(refused).toMatchObject({ code: 1, out: "" })
  expect(refused.err).toContain("Could not rewind the files to msg_prompt")
  expect(refused.err).toContain("This message has no checkpoint to rewind the files to.")
})
