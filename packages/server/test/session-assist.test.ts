import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { startServer } from "./fixture/server"

// clients-ux-37: the two routes a client calls for a tool label and a prompt suggestion. Nothing they do is durable: they
// ask the model beside the session, never through it, and answer with the text or with why there is none.

type Reply = {
  readonly text?: string
  readonly tool?: { readonly name: string; readonly input: unknown }
  readonly delayMs?: number
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
  /** Answer with this HTTP status and no stream, as a provider that refuses the request does. */
  readonly status?: number
}

type Recorded = {
  readonly kind: "step" | "suggestion" | "other"
  readonly body: { model?: string; messages: Array<{ role: string; content?: unknown }>; tools?: unknown }
}

// A model server that answers each step from a queue and every other request from a function, and keeps what each
// request carried. A suggestion sends the session's history, so it carries the session's tools with
// `tool_choice: "none"`; a label carries no tools.
const scriptedModel = Effect.acquireRelease(
  Effect.sync(() => {
    const requests: Recorded[] = []
    const script = {
      steps: [] as Reply[],
      suggestion: (_count: number): Reply => ({ text: "run the tests" }),
      other: (_body: string): Reply => ({ text: "Title" }),
    }
    const counts = { suggestion: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Recorded["body"] & { tool_choice?: unknown }
        const kind = body.tools ? (body.tool_choice === "none" ? "suggestion" : "step") : "other"
        requests.push({ kind, body })
        const reply =
          kind === "step"
            ? (script.steps.shift() ?? { text: "done" })
            : kind === "suggestion"
              ? script.suggestion(++counts.suggestion)
              : script.other(JSON.stringify(body.messages))
        if (reply.delayMs) await Bun.sleep(reply.delayMs)
        if (reply.status)
          return Response.json(
            { error: { message: "refused", type: "invalid_request_error" } },
            { status: reply.status },
          )
        const events = [
          ...(reply.text === undefined
            ? []
            : [{ choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] }]),
          ...(reply.tool
            ? [
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: `call_${requests.length}`,
                            type: "function",
                            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
              ]
            : []),
          { choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }] },
          {
            choices: [],
            usage: { ...(reply.usage ?? { prompt_tokens: 10, completion_tokens: 2 }), total_tokens: 12 },
          },
        ]
        return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    return { requests, script, server }
  }),
  (model) => Effect.promise(() => model.server.stop(true)),
)

const model = (name: string) => ({
  name,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: { input: 0, output: 0 },
  limit: { context: 100_000, output: 10_000 },
})

// The session runs on test-model; side queries are pinned to small-model, so a request shows which one it took.
const config = (port: number | undefined) => ({
  model: "test/test-model",
  agents: { side: { model: "test/small-model" } },
  permission: { edit: "ask" },
  providers: {
    test: {
      name: "Test",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
      models: { "test-model": model("Test Model"), "small-model": model("Small Model") },
    },
  },
})

const OUTPUT_MARK = "READ-OUTPUT-MARK"

const layout = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-session-assist-")))
  const root = yield* Effect.promise(() => fs.realpath(tmp.path))
  const folders = { config: path.join(root, "config"), repo: path.join(root, "repo") }
  const llm = yield* scriptedModel
  yield* Effect.promise(async () => {
    await fs.mkdir(folders.config, { recursive: true })
    await fs.mkdir(folders.repo, { recursive: true })
    await Bun.write(path.join(folders.config, "orbit.json"), JSON.stringify(config(llm.server.port)))
    // The marker comes first, inside the 300 characters of the output a label request carries.
    await Bun.write(path.join(folders.repo, "notes.txt"), `${OUTPUT_MARK}\n${"o".repeat(1000)}\n`)
  })
  return { folders, llm, notes: path.join(folders.repo, "notes.txt") }
})

type Server = {
  readonly base: string
  readonly headers: Record<string, string>
  readonly fetch?: (request: Request) => Promise<Response>
}

// The fields of an answer that these tests read.
type Body = {
  readonly _tag?: string
  readonly directory?: string
  readonly data?: { readonly [key: string]: unknown }
}

// The fields of a listed message that these tests read.
type Message = {
  readonly id: string
  readonly type: string
  readonly error?: unknown
  readonly tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  readonly content: ReadonlyArray<{ readonly type: string; readonly id: string; readonly state: { status: string } }>
}

// What the reference counts as the part of a response that the prompt cache did not cover.
const uncached = (message: Message | undefined) =>
  message
    ? message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.write
    : undefined

function request(server: Server, method: string, route: string, input: { directory?: string; body?: unknown } = {}) {
  const url = new URL(route, server.base)
  if (input.directory !== undefined) url.searchParams.set("location[directory]", input.directory)
  const sent = new Request(url, {
    method,
    headers: { ...server.headers, "content-type": "application/json" },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  return (server.fetch ?? fetch)(sent).then(async (response) => ({
    status: response.status,
    body: (await response.json().catch(() => undefined)) as Body | undefined,
  }))
}

const createSession = async (server: Server, directory: string, parentID?: string) => {
  const created = await request(server, "POST", "/api/session", {
    directory,
    body: parentID ? { parentID } : { location: { directory } },
  })
  expect(created.status).toBe(200)
  return String(created.body?.data?.id)
}

// Admits a prompt and waits until the session is idle again.
const prompt = async (server: Server, id: string, text: string) => {
  expect((await request(server, "POST", `/api/session/${id}/prompt`, { body: { text } })).status).toBe(200)
  expect((await request(server, "POST", `/api/experimental/session/${id}/wait`)).status).toBe(204)
}

// The session's assistant messages, oldest first.
const assistants = async (server: Server, id: string) =>
  (
    (await request(server, "GET", `/api/session/${id}/message?order=asc&limit=200`)).body?.data as unknown as Message[]
  ).filter((message) => message.type === "assistant")

const label = (server: Server, id: string, body: unknown) =>
  request(server, "POST", `/api/session/${id}/assist/label`, { body })
const suggestion = (server: Server, id: string) => request(server, "POST", `/api/session/${id}/assist/suggestion`)

// A session whose history holds a Read of the notes and the answer after it: two assistant messages, the first a batch
// of one finished call.
const withBatch = async (server: Server, llm: { script: { steps: Reply[] } }, notes: string, directory: string) => {
  const id = await createSession(server, directory)
  // The text before the call is the intent, cut to 200 characters: the J's after the first 39 never reach the model.
  llm.script.steps.push(
    { text: `${"I".repeat(150)}INTENT-MARK${"J".repeat(300)}`, tool: { name: "Read", input: { file_path: notes } } },
    { text: "first answer" },
  )
  await prompt(server, id, "read the notes")
  const [batch] = await assistants(server, id)
  const call = batch?.content.find((part) => part.type === "tool")
  expect(call?.state.status).toBe("completed")
  return { id, messageID: String(batch?.id), toolCallID: String(call?.id) }
}

const refusedFor = (directory: string) => ({
  status: 403,
  body: expect.objectContaining({ _tag: "UntrustedFolderError", directory }),
})

// ---- trust (class 1, class 12) ------------------------------------------------------------------------------------

it.live(
  "both routes refuse a session whose folder is not trusted, on a port and in process, and the model is not asked; the trusted control answers",
  () =>
    Effect.gen(function* () {
      const { folders, llm, notes } = yield* layout
      const servers: Array<readonly [string, Server]> = [
        ["port", yield* startServer(folders.config, { trust: { implicit: false } })],
        [
          "in process",
          yield* ServerFetch.make({
            app: { version: "test-version" },
            database: { path: ":memory:" },
            config: { directory: folders.config },
            managed: { directory: path.join(folders.config, "managed-missing") },
            fs: { filewatcher: false },
            models: { fetch: false },
            trust: { implicit: false },
          }).pipe(Effect.map((handler): Server => ({ base: "http://orbit.local", headers: {}, fetch: handler }))),
        ],
      ]
      yield* Effect.promise(async () => {
        for (const [name, server] of servers) {
          const trust = (value: boolean) =>
            request(server, "POST", "/api/location/trust", {
              directory: folders.repo,
              body: value ? { trust: true, persist: false } : { trust: false },
            })
          expect((await trust(true)).status).toBe(200)
          const batch = await withBatch(server, llm, notes, folders.repo)
          await prompt(server, batch.id, "second")
          expect((await trust(false)).status).toBe(200)
          const asked = llm.requests.length

          expect({
            name,
            ...(await label(server, batch.id, { messageID: batch.messageID, toolCallIDs: [batch.toolCallID] })),
          }).toEqual({
            name,
            ...refusedFor(folders.repo),
          })
          expect({ name, ...(await suggestion(server, batch.id)) }).toEqual({ name, ...refusedFor(folders.repo) })
          expect(llm.requests.length).toBe(asked)

          // The control: the same session, once its folder is trusted again.
          expect((await trust(true)).status).toBe(200)
          expect(
            (await label(server, batch.id, { messageID: batch.messageID, toolCallIDs: [batch.toolCallID] })).status,
          ).toBe(200)
          expect((await suggestion(server, batch.id)).status).toBe(200)
        }
      })
    }),
  120_000,
)

it.live("an unknown session is a typed not-found on either route; a known one is answered (the control)", () =>
  Effect.gen(function* () {
    const { folders } = yield* layout
    const server = yield* startServer(folders.config)
    yield* Effect.promise(async () => {
      const known = await createSession(server, folders.repo)
      const missing = "ses_0000000000000000000000000000"
      const call = { messageID: "msg_0000000000000000000000000000", toolCallIDs: ["call_1"] }

      expect((await label(server, known, call)).body).toEqual({ data: { label: null, reason: "not_found" } })
      expect((await suggestion(server, known)).body).toEqual({
        data: { suggestion: null, reason: "early_conversation" },
      })
      for (const answered of [await label(server, missing, call), await suggestion(server, missing)])
        expect(answered).toEqual({ status: 404, body: expect.objectContaining({ _tag: "SessionNotFoundError" }) })
    })
  }),
)

// ---- labels ---------------------------------------------------------------------------------------------------------

it.live(
  "a label is one request to the side model, with no tools and no history, that carries each call's name, input and output cut to 300 characters and the intent cut to 200",
  () =>
    Effect.gen(function* () {
      const { folders, llm, notes } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const batch = await withBatch(server, llm, notes, folders.repo)
        const before = llm.requests.length
        llm.script.other = (body) => ({ text: body.includes(OUTPUT_MARK) ? "  Read the notes \n" : "Title" })

        const answered = await label(server, batch.id, { messageID: batch.messageID, toolCallIDs: [batch.toolCallID] })

        // The text comes back trimmed.
        expect(answered).toEqual({ status: 200, body: { data: { label: "Read the notes" } } })
        const asked = llm.requests.slice(before)
        expect(asked).toHaveLength(1)
        expect(asked[0].kind).toBe("other")
        expect(asked[0].body.model).toBe("small-model")
        expect(asked[0].body.messages.map((message) => message.role)).toEqual(["system", "user"])
        const text = JSON.stringify(asked[0].body.messages[1].content)
        expect(text).toContain("Read")
        expect(text).toContain("notes.txt")
        expect(text).toContain(OUTPUT_MARK)
        expect(text).toContain("...")
        expect(text).not.toContain("o".repeat(400))
        // The output is cut to exactly 300 characters of JSON, the last three of them the dots.
        const sent = asked[0].body.messages[1].content
        const promptText =
          typeof sent === "string" ? sent : (sent as Array<{ text?: string }>).map((part) => part.text).join("")
        const output = promptText
          .split("\n")
          .find((line) => line.startsWith("Output: "))
          ?.slice("Output: ".length)
        expect({ length: output?.length, dots: output?.endsWith("...") }).toEqual({ length: 300, dots: true })
        expect(text).toContain(`${"I".repeat(150)}INTENT-MARK${"J".repeat(39)}`)
        expect(text).not.toContain("J".repeat(40))
        // No history: the person's message is not sent.
        expect(JSON.stringify(asked[0].body.messages)).not.toContain("read the notes")
      })
    }),
  60_000,
)

it.live(
  "a label is null, with its reason, for a blank answer, a refused request, calls it cannot find and a subagent's batch",
  () =>
    Effect.gen(function* () {
      const { folders, llm, notes } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const batch = await withBatch(server, llm, notes, folders.repo)
        const other = await withBatch(server, llm, notes, folders.repo)
        const ask = (id: string, body: unknown) => label(server, id, body)
        const own = { messageID: batch.messageID, toolCallIDs: [batch.toolCallID] }

        llm.script.other = () => ({ text: "   " })
        expect((await ask(batch.id, own)).body).toEqual({ data: { label: null, reason: "empty" } })
        llm.script.other = () => ({ status: 400 })
        expect((await ask(batch.id, own)).body).toEqual({ data: { label: null, reason: "unavailable" } })
        llm.script.other = () => ({ text: "Read the notes" })

        // Nothing to label, so the model is not asked: a call that is not in the message, and a message of another session.
        const before = llm.requests.length
        expect((await ask(batch.id, { messageID: batch.messageID, toolCallIDs: ["call_missing"] })).body).toEqual({
          data: { label: null, reason: "not_found" },
        })
        expect((await ask(batch.id, { messageID: other.messageID, toolCallIDs: [other.toolCallID] })).body).toEqual({
          data: { label: null, reason: "not_found" },
        })
        expect(llm.requests.length).toBe(before)

        // A subagent's batch is not labelled, as in the reference; the root's own batch is the control.
        const child = await createSession(server, folders.repo, batch.id)
        llm.script.steps.push({ tool: { name: "Read", input: { file_path: notes } } }, { text: "child answer" })
        await prompt(server, child, "child reads")
        const [childBatch] = await assistants(server, child)
        const childCall = childBatch?.content.find((part) => part.type === "tool")
        expect(childCall?.state.status).toBe("completed")
        const asked = llm.requests.length
        expect((await ask(child, { messageID: childBatch?.id, toolCallIDs: [childCall?.id] })).body).toEqual({
          data: { label: null, reason: "subagent" },
        })
        expect(llm.requests.length).toBe(asked)
        expect((await ask(batch.id, own)).body).toEqual({ data: { label: "Read the notes" } })
      })
    }),
  90_000,
)

// A call still waiting for its approval has not finished, and a call the interruption ended is not labelled, as in the
// reference; the model is not asked for either. The finished batches above are the control.
it.live(
  "a label is null for a call that has not finished (unsettled) and for one an interruption ended (aborted)",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        llm.script.steps.push({
          tool: { name: "Write", input: { file_path: path.join(folders.repo, "out.txt"), content: OUTPUT_MARK } },
        })
        expect(
          (await request(server, "POST", `/api/session/${id}/prompt`, { body: { text: "write it" } })).status,
        ).toBe(200)
        const deadline = Date.now() + 30_000
        while (
          ((await request(server, "GET", `/api/session/${id}/permission`)).body?.data as unknown as unknown[])
            .length === 0
        ) {
          if (Date.now() > deadline) throw new Error("The write never asked")
          await Bun.sleep(50)
        }
        const call = async () => {
          const [batch] = await assistants(server, id)
          const part = batch?.content.find((item) => item.type === "tool")
          return { messageID: String(batch?.id), toolCallIDs: [String(part?.id)], status: part?.state.status }
        }
        const asked = llm.requests.length

        const waiting = await call()
        expect(waiting.status).toBe("running")
        expect(
          (await label(server, id, { messageID: waiting.messageID, toolCallIDs: waiting.toolCallIDs })).body,
        ).toEqual({
          data: { label: null, reason: "unsettled" },
        })

        expect((await request(server, "POST", `/api/session/${id}/interrupt`)).status).toBe(200)
        expect((await request(server, "POST", `/api/experimental/session/${id}/wait`)).status).toBe(204)
        const ended = await call()
        expect(ended.status).toBe("error")
        expect((await label(server, id, { messageID: ended.messageID, toolCallIDs: ended.toolCallIDs })).body).toEqual({
          data: { label: null, reason: "aborted" },
        })
        expect(llm.requests.length).toBe(asked)
      })
    }),
  60_000,
)

// ---- suggestions ----------------------------------------------------------------------------------------------------

it.live(
  "a suggestion is one request to the session's own model with its history and tools, which it may not call",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "FIRST-USER-LINE")
        await prompt(server, id, "SECOND-USER-LINE")
        const before = llm.requests.length
        llm.script.suggestion = () => ({ text: "  run the tests \n" })

        expect(await suggestion(server, id)).toEqual({ status: 200, body: { data: { suggestion: "run the tests" } } })
        const asked = llm.requests.slice(before)
        expect(asked).toHaveLength(1)
        expect(asked[0].kind).toBe("suggestion")
        expect(asked[0].body.model).toBe("test-model")
        const history = JSON.stringify(asked[0].body.messages)
        expect(history).toContain("FIRST-USER-LINE")
        expect(history).toContain("SECOND-USER-LINE")
        // The instruction is a user message of its own, after the history.
        const last = asked[0].body.messages.at(-1)
        expect(last?.role).toBe("user")
        expect(JSON.stringify(last?.content)).not.toContain("SECOND-USER-LINE")
        // Nothing the request did reached the session's history.
        expect(await assistants(server, id)).toHaveLength(2)
      })
    }),
  60_000,
)

// Each row leaves a session in the state that suppresses a suggestion, checks that state through the API first, and
// expects the reason with no request to the model. The boundary row is the control for the spend guard.
const suppressions: ReadonlyArray<{
  readonly name: string
  readonly reason: string | undefined
  readonly setup: (input: {
    server: Server
    llm: { script: { steps: Reply[] }; requests: Recorded[] }
    directory: string
  }) => Promise<string>
}> = [
  {
    name: "one assistant message",
    reason: "early_conversation",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      expect(await assistants(server, id)).toHaveLength(1)
      return id
    },
  },
  {
    name: "the last response failed",
    reason: "last_response_error",
    setup: async ({ server, llm, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      llm.script.steps.push({ status: 400 })
      await prompt(server, id, "two")
      const list = await assistants(server, id)
      expect(list.length).toBeGreaterThanOrEqual(2)
      expect(list.at(-1)?.error).toBeDefined()
      return id
    },
  },
  {
    name: "the last response wrote 10,001 uncached tokens",
    reason: "cache_cold",
    setup: async ({ server, llm, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      llm.script.steps.push({ text: "big", usage: { prompt_tokens: 9_991, completion_tokens: 10 } })
      await prompt(server, id, "two")
      expect(uncached((await assistants(server, id)).at(-1))).toBe(10_001)
      return id
    },
  },
  {
    name: "the last response wrote exactly 10,000 uncached tokens (the control)",
    reason: undefined,
    setup: async ({ server, llm, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      llm.script.steps.push({ text: "big", usage: { prompt_tokens: 9_990, completion_tokens: 10 } })
      await prompt(server, id, "two")
      expect(uncached((await assistants(server, id)).at(-1))).toBe(10_000)
      return id
    },
  },
  {
    name: "a permission request is waiting",
    reason: "pending_permission",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      const created = await request(server, "POST", `/api/session/${id}/permission`, {
        body: { action: "edit", resources: ["x.txt"] },
      })
      expect(created.body?.data?.effect).toBe("ask")
      expect((await request(server, "GET", `/api/session/${id}/permission`)).body?.data).toHaveLength(1)
      return id
    },
  },
  {
    name: "a form is waiting",
    reason: "elicitation_active",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      const created = await request(server, "POST", `/api/session/${id}/form`, {
        body: { title: "Pick", fields: [{ key: "a", type: "boolean" }] },
      })
      expect(created.status).toBe(200)
      return id
    },
  },
  {
    name: "the session is in Plan mode",
    reason: "plan_mode",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      expect((await request(server, "POST", `/api/session/${id}/agent`, { body: { agent: "plan" } })).status).toBe(204)
      return id
    },
  },
  {
    name: "the session is running",
    reason: "busy",
    setup: async ({ server, llm, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      llm.script.steps.push({ text: "slow", delayMs: 20_000 })
      const steps = llm.requests.filter((item) => item.kind === "step").length
      expect((await request(server, "POST", `/api/session/${id}/prompt`, { body: { text: "three" } })).status).toBe(200)
      const deadline = Date.now() + 30_000
      while (llm.requests.filter((item) => item.kind === "step").length === steps) {
        if (Date.now() > deadline) throw new Error("The third step never reached the model")
        await Bun.sleep(50)
      }
      return id
    },
  },
  {
    name: "a subagent's permission request is waiting",
    reason: "pending_permission",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      const child = await createSession(server, directory, id)
      const created = await request(server, "POST", `/api/session/${child}/permission`, {
        body: { action: "edit", resources: ["x.txt"] },
      })
      expect(created.body?.data?.effect).toBe("ask")
      expect((await request(server, "GET", `/api/session/${id}/permission`)).body?.data).toHaveLength(0)
      return id
    },
  },
  {
    name: "a subagent's form is waiting",
    reason: "elicitation_active",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      const child = await createSession(server, directory, id)
      const created = await request(server, "POST", `/api/session/${child}/form`, {
        body: { title: "Pick", fields: [{ key: "a", type: "boolean" }] },
      })
      expect(created.status).toBe(200)
      return id
    },
  },
  {
    name: "a prompt waits in the inbox, not yet delivered",
    reason: "busy",
    setup: async ({ server, directory }) => {
      const id = await createSession(server, directory)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      const admitted = await request(server, "POST", `/api/session/${id}/prompt`, {
        body: { text: "three", resume: false },
      })
      expect(admitted.status).toBe(200)
      expect((await request(server, "GET", `/api/session/${id}/inbox`)).body?.data).toHaveLength(1)
      return id
    },
  },
  {
    name: "a subagent's session",
    reason: "subagent",
    setup: async ({ server, directory }) => {
      const parent = await createSession(server, directory)
      const id = await createSession(server, directory, parent)
      await prompt(server, id, "one")
      await prompt(server, id, "two")
      return id
    },
  },
]

for (const row of suppressions)
  it.live(
    `a suggestion when ${row.name}: ${row.reason ?? "answered"}`,
    () =>
      Effect.gen(function* () {
        const { folders, llm } = yield* layout
        const server = yield* startServer(folders.config)
        yield* Effect.promise(async () => {
          const id = await row.setup({ server, llm, directory: folders.repo })
          const before = llm.requests.filter((item) => item.kind === "suggestion").length

          const answered = await suggestion(server, id)

          expect(answered.status).toBe(200)
          expect(answered.body?.data).toEqual(
            row.reason ? { suggestion: null, reason: row.reason } : { suggestion: "run the tests" },
          )
          expect(llm.requests.filter((item) => item.kind === "suggestion").length - before).toBe(row.reason ? 0 : 1)
          await request(server, "POST", `/api/session/${id}/interrupt`)
        })
      }),
    90_000,
  )

// The reference's filters, in its order, with a kept row beside each rule that has a boundary. They are English, as in
// the reference.
const words = (count: number) => Array.from({ length: count }, (_, index) => `step${index}`).join(" ")
const filters: ReadonlyArray<readonly [string, string | undefined]> = [
  ["   ", "empty"],
  ["done", "done"],
  ["nothing to suggest right now", "meta_text"],
  ["I would stay silent here", "meta_text"],
  ["...silence...", "meta_text"],
  ["Nothing found.", "meta_text"],
  ["No suggestion this time", "meta_text"],
  ["[no suggestion]", "meta_wrapped"],
  ["(waiting for the user)", "meta_wrapped"],
  ["API Error: 500 upstream", "error_message"],
  ["Prompt is too long for this", "error_message"],
  ["Suggestion: run the tests", "prefixed_label"],
  ["refactor", "too_few_words"],
  ["yes", undefined],
  ["/commit", undefined],
  [words(13), "too_many_words"],
  [words(12), undefined],
  [`${"b".repeat(20)} ${"b".repeat(19)} ${"b".repeat(19)} ${"b".repeat(19)} ${"b".repeat(19)}`, "too_long"],
  [`${"b".repeat(19)} ${"b".repeat(19)} ${"b".repeat(19)} ${"b".repeat(19)} ${"b".repeat(19)}`, undefined],
  ["Run the tests. Then commit", "multiple_sentences"],
  ["run the **tests** now", "has_formatting"],
  ["run the\ntests now", "has_formatting"],
  ["that works for me", "evaluative"],
  ["thanks, run them", "evaluative"],
  ["Let me run the tests", "assistant_voice"],
  ["I'll commit this", "assistant_voice"],
  ["run the tests", undefined],
]

it.live(
  "each suggestion filter drops the text it names, and the text beside its boundary is kept",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "one")
        await prompt(server, id, "two")
        const seen: Array<readonly [string, unknown]> = []
        for (const [text] of filters) {
          llm.script.suggestion = () => ({ text })
          seen.push([text, (await suggestion(server, id)).body?.data])
        }
        expect(seen).toEqual(
          filters.map(([text, reason]) => [text, reason ? { suggestion: null, reason } : { suggestion: text.trim() }]),
        )
      })
    }),
  120_000,
)

// The spend guard counts every kind of token of the last response that the prompt cache did not cover, and not the ones
// it read. A provider decides which kinds it reports, so each row imports a copy of a finished session whose last
// response reports one kind; the cache-read row is the control.
const spends: ReadonlyArray<readonly [string, Message["tokens"], string | undefined]> = [
  ["input", { input: 10_001, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, "cache_cold"],
  ["output", { input: 0, output: 10_001, reasoning: 0, cache: { read: 0, write: 0 } }, "cache_cold"],
  ["reasoning", { input: 0, output: 0, reasoning: 10_001, cache: { read: 0, write: 0 } }, "cache_cold"],
  ["cache write", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 10_001 } }, "cache_cold"],
  ["cache read", { input: 0, output: 0, reasoning: 0, cache: { read: 50_000, write: 0 } }, undefined],
]

it.live(
  "a suggestion counts each kind of uncached token of the last response, and not the tokens the cache read",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "one")
        await prompt(server, id, "two")
        const exported = (await request(server, "GET", `/api/experimental/session/${id}/export`)).body?.data
        const seen: Array<readonly [string, unknown]> = []
        for (const [index, [kind, tokens]] of spends.entries()) {
          // A copy under new IDs, with the same order, whose last response reports these tokens.
          const copy = JSON.parse(
            JSON.stringify(exported).replace(/"((?:ses|msg|prt)_[A-Za-z0-9]+)"/g, `"$1c${index}"`),
          ) as { info: { id: string }; messages: Array<{ type: string; tokens?: unknown }> }
          const last = copy.messages.findLast((message) => message.type === "assistant")
          if (last) last.tokens = tokens
          const imported = await request(server, "POST", "/api/experimental/session/import", {
            body: { ...copy, location: { directory: folders.repo } },
          })
          expect(imported.status).toBe(200)
          expect(uncached((await assistants(server, copy.info.id)).at(-1))).toBe(
            tokens.input + tokens.output + tokens.reasoning + tokens.cache.write,
          )
          seen.push([kind, (await suggestion(server, copy.info.id)).body?.data])
        }
        expect(seen).toEqual(
          spends.map(([kind, , reason]) => [
            kind,
            reason ? { suggestion: null, reason } : { suggestion: "run the tests" },
          ]),
        )
        expect(llm.requests.filter((item) => item.kind === "suggestion")).toHaveLength(1)
      })
    }),
  90_000,
)

it.live(
  "a label of a failed call carries the error as the call's output",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        llm.script.steps.push(
          { tool: { name: "Read", input: { file_path: path.join(folders.repo, "MISSING-MARK.txt") } } },
          { text: "it is not there" },
        )
        await prompt(server, id, "read the missing file")
        const [batch] = await assistants(server, id)
        const call = batch?.content.find((part) => part.type === "tool")
        expect(call?.state.status).toBe("error")
        const before = llm.requests.length
        llm.script.other = () => ({ text: "Read a missing file" })

        const answered = await label(server, id, { messageID: batch?.id, toolCallIDs: [call?.id] })

        expect(answered.body).toEqual({ data: { label: "Read a missing file" } })
        const sent = llm.requests.slice(before)[0]?.body.messages[1]?.content
        const promptText =
          typeof sent === "string" ? sent : (sent as Array<{ text?: string }>).map((part) => part.text).join("")
        const output = promptText.split("\n").find((line) => line.startsWith("Output: "))
        expect(output).toContain("MISSING-MARK")
      })
    }),
  60_000,
)

// ---- cancellation ---------------------------------------------------------------------------------------------------

it.live(
  "a prompt admitted while a suggestion is being written cancels it",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "one")
        await prompt(server, id, "two")
        llm.script.suggestion = () => ({ text: "run the tests", delayMs: 10_000 })
        const started = Date.now()
        const pending = suggestion(server, id)
        const deadline = Date.now() + 10_000
        while (!llm.requests.some((item) => item.kind === "suggestion")) {
          if (Date.now() > deadline) throw new Error("The suggestion never reached the model")
          await Bun.sleep(25)
        }
        expect(
          (await request(server, "POST", `/api/session/${id}/prompt`, { body: { text: "three", resume: false } }))
            .status,
        ).toBe(200)

        expect((await pending).body?.data).toEqual({ suggestion: null, reason: "aborted" })
        expect(Date.now() - started).toBeLessThan(8_000)
      })
    }),
  60_000,
)

it.live(
  "a second suggestion for the same session supersedes the first",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "one")
        await prompt(server, id, "two")
        llm.script.suggestion = (count) =>
          count === 1 ? { text: "stale suggestion here", delayMs: 10_000 } : { text: "fresh suggestion here" }
        const first = suggestion(server, id)
        const deadline = Date.now() + 10_000
        while (!llm.requests.some((item) => item.kind === "suggestion")) {
          if (Date.now() > deadline) throw new Error("The first suggestion never reached the model")
          await Bun.sleep(25)
        }

        const second = await suggestion(server, id)

        expect(second.body?.data).toEqual({ suggestion: "fresh suggestion here" })
        expect((await first).body?.data).toEqual({ suggestion: null, reason: "aborted" })
      })
    }),
  60_000,
)

it.live(
  "a prompt admitted for another session leaves the suggestion being written alone",
  () =>
    Effect.gen(function* () {
      const { folders, llm } = yield* layout
      const server = yield* startServer(folders.config)
      yield* Effect.promise(async () => {
        const id = await createSession(server, folders.repo)
        await prompt(server, id, "one")
        await prompt(server, id, "two")
        const other = await createSession(server, folders.repo)
        llm.script.suggestion = () => ({ text: "run the tests", delayMs: 1_500 })
        const pending = suggestion(server, id)
        const deadline = Date.now() + 10_000
        while (!llm.requests.some((item) => item.kind === "suggestion")) {
          if (Date.now() > deadline) throw new Error("The suggestion never reached the model")
          await Bun.sleep(25)
        }
        expect(
          (
            await request(server, "POST", `/api/session/${other}/prompt`, {
              body: { text: "elsewhere", resume: false },
            })
          ).status,
        ).toBe(200)

        expect((await pending).body?.data).toEqual({ suggestion: "run the tests" })
      })
    }),
  60_000,
)
