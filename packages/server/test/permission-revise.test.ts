// clients-ux-15 part 1, the route: `POST /api/session/:sessionID/permission/:requestID/reply` takes the person's revised
// content of an Edit or Write proposal. The reply names no file: the server writes to the place the request resolved, so
// a key a client adds to the payload cannot move the write (class 8). A revision the server cannot take is refused with a
// typed 400 and leaves the question pending, so every client can say why (classes 7 and 13). Runs the server that
// `orb serve` starts, in this process, with a scripted model.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startServer } from "./fixture/server"

// The scripted model: a prompt `CALL {"name":…,"arguments":…}` makes it call that tool once, and a tool result ends the
// step with a line of text.
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { tools?: unknown; messages?: Array<{ role: string; content?: unknown }> }
    if (!body.tools) return sse([{ delta: { content: "Title" } }], "stop")
    const last = body.messages?.at(-1)
    const texts =
      last?.role !== "user"
        ? []
        : typeof last.content === "string"
          ? [last.content]
          : Array.isArray(last.content)
            ? last.content.flatMap((part: { text?: unknown }) => (typeof part.text === "string" ? [part.text] : []))
            : []
    const call = texts.map((item) => /^CALL (\{.*\})$/s.exec(item.trim())?.[1]).find((item) => item !== undefined)
    if (!call) return sse([{ delta: { content: "Done." } }], "stop")
    const parsed = JSON.parse(call) as { name: string; arguments: unknown }
    return sse(
      [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
              },
            ],
          },
        },
      ],
      "tool_calls",
    )
  },
})

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-revise-")))
const workspace = path.join(root, "workspace")
const outside = path.join(root, "outside")
const server: { url?: string } = {}
const scope = Scope.makeUnsafe()
const authorization = `Basic ${btoa("orbit:secret")}`

beforeAll(async () => {
  await Promise.all([
    fs.mkdir(path.join(root, "config"), { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ])
  await Bun.write(path.join(outside, "marker.txt"), "marker\n")
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      model: "test/test-model",
      // Every call asks, so each row has a question to answer.
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
      providers: {
        test: {
          name: "Test",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "test", baseURL: `http://127.0.0.1:${llm.port}/v1` },
          models: {
            "test-model": {
              name: "Test Model",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0 },
              limit: { context: 100_000, output: 10_000 },
            },
          },
        },
      },
    }),
  )
  server.url = (await Effect.runPromise(startServer(path.join(root, "config")).pipe(Scope.provide(scope)))).base
}, 60_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await llm.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a once reply with revised content writes it where the request resolved, whatever keys the client adds", async () => {
  const session = await start("Write", { file_path: "a.txt", content: "proposed\n" })
  const request = await pending(session, "Edit")
  // The question a client lists says it takes the person's own version.
  expect(request.revisable).toBe(true)
  const outsideFile = path.join(outside, "marker.txt")
  const answer = await reply(session, request.id, {
    decision: "once",
    content: "revised\n",
    // Keys a client can add. The reply names no file, so none of them is read.
    place: outsideFile,
    file: outsideFile,
    path: outsideFile,
    filePath: outsideFile,
    file_path: outsideFile,
    files: [{ file: outsideFile, place: outsideFile, patch: "" }],
  })
  expect(answer.status).toBe(204)
  // Waits for the tool to write, then compares: the base ignores the content and writes the proposal.
  expect(await until(() => read("a.txt"))).toBe("revised\n")
  expect(await fs.readFile(outsideFile, "utf8")).toBe("marker\n")
  expect(await fs.readdir(outside)).toEqual(["marker.txt"])
}, 60_000)

test("a once reply with revised content to an Edit writes the person's version, not the replacement", async () => {
  // The session writes the file first, so the Edit that follows edits a file this session knows.
  const session = await start("Write", { file_path: "e.txt", content: "alpha\nbeta\n" })
  expect((await reply(session, (await pending(session, "Edit")).id, { decision: "once" })).status).toBe(204)
  expect(await until(() => read("e.txt"))).toBe("alpha\nbeta\n")
  // The Edit is prompted only once the Write's run is over: a prompt sent while it still runs reaches the model wrapped
  // as a message sent mid-task, which the scripted model does not read as a call.
  await until(async () => ((await client().session.active())[session] ? undefined : true))
  await prompt(session, "Edit", { file_path: "e.txt", old_string: "beta", new_string: "BETA" })
  // The Write's question is gone once its reply is taken, so the next Edit question is the Edit tool's.
  const request = await pending(session, "Edit")
  expect(request.revisable).toBe(true)
  expect((await reply(session, request.id, { decision: "once", content: "alpha\nmine\n" })).status).toBe(204)
  expect(await until(async () => ((await read("e.txt")) === "alpha\nbeta\n" ? undefined : read("e.txt")))).toBe(
    "alpha\nmine\n",
  )
}, 60_000)

test("revised content with an always reply is a typed 400, and the question stays for a plain reply", async () => {
  const session = await start("Write", { file_path: "b.txt", content: "proposed\n" })
  const request = await pending(session, "Edit")
  const refused = await reply(session, request.id, { decision: "always", content: "revised\n" })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({
    _tag: "InvalidRequestError",
    field: "content",
    message: "Revised content can only be given with a once reply",
  })
  expect((await list(session)).map((item) => item.id)).toContain(request.id)
  expect((await reply(session, request.id, { decision: "once" })).status).toBe(204)
  expect(await until(() => read("b.txt"))).toBe("proposed\n")
}, 60_000)

test("revised content on a question that is not an Edit or Write is a typed 400, and the question stays", async () => {
  await Bun.write(path.join(workspace, "c.txt"), "c\n")
  const session = await start("Glob", { pattern: "*.txt" })
  const request = await pending(session)
  expect(request.action).not.toBe("Edit")
  const refused = await reply(session, request.id, { decision: "once", content: "revised\n" })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({
    _tag: "InvalidRequestError",
    field: "content",
    message: "This question does not take revised content: only an Edit or Write approval does",
  })
  expect(request.revisable).toBeUndefined()
  expect((await list(session)).map((item) => item.id)).toContain(request.id)
  expect((await reply(session, request.id, { decision: "once" })).status).toBe(204)
}, 60_000)

function client() {
  return Orbit.make({ baseUrl: server.url ?? "", headers: { authorization } })
}

async function start(name: string, args: Record<string, unknown>) {
  const session = await client().session.create({ location: { directory: workspace } })
  await prompt(session.id, name, args)
  return session.id
}

function prompt(sessionID: string, name: string, args: Record<string, unknown>) {
  return client().session.prompt({ sessionID, text: `CALL ${JSON.stringify({ name, arguments: args })}` })
}

type Request = { id: string; action: string; revisable?: boolean }

async function list(sessionID: string): Promise<Request[]> {
  const response = await fetch(`${server.url}/api/session/${sessionID}/permission`, { headers: { authorization } })
  return ((await response.json()) as { data: Request[] }).data
}

// The first question of the session, or the first about `action`; other questions are answered once on the way.
async function pending(sessionID: string, action?: string) {
  const found = await until(async () => {
    const requests = await list(sessionID)
    const match = requests.find((item) => action === undefined || item.action === action)
    if (match) return match
    for (const other of requests) await reply(sessionID, other.id, { decision: "once" })
    return undefined
  })
  if (!found) throw new Error(`no ${action ?? ""} question was asked`)
  return found
}

function reply(sessionID: string, requestID: string, body: Record<string, unknown>) {
  return fetch(`${server.url}/api/session/${sessionID}/permission/${requestID}/reply`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function read(name: string) {
  return fs.readFile(path.join(workspace, name), "utf8").catch(() => undefined)
}

async function until<T>(check: () => Promise<T | undefined>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  return undefined
}

function sse(deltas: Array<{ delta: Record<string, unknown> }>, finish: string) {
  const chunks = [
    ...deltas.map((item) => ({ choices: [{ index: 0, delta: item.delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
