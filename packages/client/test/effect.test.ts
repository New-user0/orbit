import { expect, test } from "bun:test"
import { Context, DateTime, Effect, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  AbsolutePath,
  Agent,
  Event,
  Location,
  Model,
  Orbit,
  Prompt,
  Session,
  SessionMessage,
} from "../src/effect/index"

const synced = { type: "log.synced" as const, aggregateID: "ses_test", seq: Event.Seq.make(1) }

test("server.info decodes the readiness response", async () => {
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "current",
          pid: 123,
          urls: ["http://localhost:3000"],
          paths: { tmp: "/tmp/orbit" },
        }),
      ),
    ),
  )
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.server.info()
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result).toEqual({
    version: "current",
    pid: 123,
    urls: ["http://localhost:3000"],
    paths: { tmp: "/tmp/orbit" },
  })
})

test("vcs.base decodes nullable review-base metadata", async () => {
  const location = { directory: "/repo", project: { id: "global", directory: "/repo", canonical: "/repo" } }
  const base = {
    name: "release",
    ref: "refs/remotes/origin/release",
    source: "reflog",
  }
  for (const data of [base, null]) {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ location, data }))),
    )
    const result = await Effect.gen(function* () {
      const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
      return yield* client.vcs.base({ location: { directory: AbsolutePath.make("/repo") } })
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)
    expect(result.data).toEqual(data)
    expect(result.location.directory).toBe("/repo")
  }
})

test("session.get returns the decoded Effect projection", async () => {
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(session))),
  )
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.session.get({ sessionID: Session.ID.make("ses_test") })
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(DateTime.toEpochMillis(result.time.created)).toBe(1_717_171_717_000)
})

test("session instructions methods use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = []
  const instructions = [{ key: "review-notes", value: { text: "Check the diff", priority: 1 } }]
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.method === "GET" ? Response.json({ data: instructions }) : new Response(null, { status: 204 }),
      ),
    )
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const listed = yield* client.session.instructions.entry.list({ sessionID: Session.ID.make("ses_test") })
    yield* client.session.instructions.entry.put({
      sessionID: Session.ID.make("ses_test"),
      key: "review-notes",
      value: instructions[0].value,
    })
    yield* client.session.instructions.entry.remove({
      sessionID: Session.ID.make("ses_test"),
      key: "review-notes",
    })
    return listed
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result).toEqual(instructions)
  expect(requests).toEqual([
    {
      method: "GET",
      url: "http://localhost:3000/api/experimental/session/ses_test/instructions/entries",
      body: undefined,
    },
    {
      method: "PUT",
      url: "http://localhost:3000/api/experimental/session/ses_test/instructions/entries/review-notes",
      body: { value: { text: "Check the diff", priority: 1 } },
    },
    {
      method: "DELETE",
      url: "http://localhost:3000/api/experimental/session/ses_test/instructions/entries/review-notes",
      body: undefined,
    },
  ])
})

// clients-ux-37: a label names the assistant message and its calls; a suggestion sends nothing but the session. Both
// answers decode as text or as null with the reason.
test("session.assist methods use the public HTTP contract and decode both answers", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = []
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: request.url.endsWith("/label") ? { label: "Read notes.txt" } : { suggestion: null, reason: "busy" },
        }),
      ),
    )
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const label = yield* client.session.assist.label({
      sessionID: Session.ID.make("ses_test"),
      messageID: SessionMessage.ID.make("msg_a"),
      toolCallIDs: ["call_1", "call_2"],
    })
    const suggestion = yield* client.session.assist.suggestion({ sessionID: Session.ID.make("ses_test") })
    return { label, suggestion }
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result).toEqual({ label: { label: "Read notes.txt" }, suggestion: { suggestion: null, reason: "busy" } })
  expect(requests).toEqual([
    {
      method: "POST",
      url: "http://localhost:3000/api/session/ses_test/assist/label",
      body: { messageID: "msg_a", toolCallIDs: ["call_1", "call_2"] },
    },
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/assist/suggestion", body: undefined },
  ])
})

// clients-ux-5: a code rewind's dry run and a prompt's own diff reach the server as the HTTP contract says.
test("session.revert.files sends a dry run and decodes its result; session.diff sends the prompt scope", async () => {
  const requests: Array<{ method: string; url: string; query: unknown; body?: unknown }> = []
  const dry = { canRewind: true, filesChanged: ["/repo/a.txt"], insertions: 0, deletions: 1 }
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      query: Object.fromEntries(request.urlParams.params),
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ data: request.method === "POST" ? dry : [] })),
    )
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const rewound = yield* client.session.revert.files({
      sessionID: Session.ID.make("ses_test"),
      messageID: SessionMessage.ID.make("msg_prompt"),
      dryRun: true,
    })
    const diff = yield* client.session.diff({ sessionID: Session.ID.make("ses_test"), scope: "prompt" })
    return { rewound, diff }
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result).toEqual({ rewound: dry, diff: [] })
  expect(requests).toEqual([
    {
      method: "POST",
      url: "http://localhost:3000/api/session/ses_test/revert/files",
      query: {},
      body: { messageID: "msg_prompt", dryRun: true },
    },
    {
      method: "GET",
      url: "http://localhost:3000/api/session/ses_test/diff",
      query: { scope: "prompt" },
      body: undefined,
    },
  ])
})

// A grant names the location and how long it lasts, and nothing else: the trust is decided for the location's project.
test("location.trust.update sends the trust and its persistence, and decodes the status", async () => {
  const requests: Array<{ method: string; url: URL; body: unknown }> = []
  const status = { directory: "/repo", trusted: true, persistent: true, source: "saved", withheld: [] }
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: new URL(request.url),
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(status)))
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.location.trust.update({
      location: { directory: AbsolutePath.make("/repo") },
      trust: true,
      persist: false,
    })
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result).toEqual(status)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.method).toBe("POST")
  expect(requests[0]!.url.pathname).toBe("/api/location/trust")
  expect(requests[0]!.body).toEqual({ trust: true, persist: false })
})

// clients-ux-42: `/memory` lists rows and names one to make by its target, never by a place; the toggle's patch carries
// `memory.enabled`.
test("location.memory and the memory toggle use the public HTTP contract and decode the answers", async () => {
  const requests: Array<{ method: string; url: URL; body: unknown }> = []
  const listing = {
    files: [{ path: "/repo/AGENTS.md", kind: "project", chars: 4, role: "project", exists: true, target: { type: "file", path: "/repo/AGENTS.md" } }],
    warnings: [{ path: "/repo/CLAUDE.md", type: "outside", message: "left out" }],
    folders: [{ type: "agent", agent: "review", scope: "project", path: "/repo/.orbit/agent-memory/review", exists: false, target: { type: "agent", agent: "review" } }],
    enabled: true,
    git: true,
    available: true,
  }
  const ensured = { path: "/repo/.orbit/agent-memory/review", created: true, type: "folder" }
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: new URL(request.url),
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    if (request.method === "PATCH") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: request.method === "GET" ? listing : ensured })))
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const listed = yield* client.location.memory.list({ location: { directory: "/repo" } })
    const made = yield* client.location.memory.ensure({
      location: { directory: "/repo" },
      target: { type: "agent", agent: "review" },
    })
    // The Effect client puts every key of the patch in the body, and one left undefined does not encode, so each is named.
    yield* client.config.update({ shell: null, output_style: null, language: null, memory: { enabled: false } })
    return { listed, made }
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result.listed).toEqual(listing)
  expect(result.made).toEqual(ensured)
  expect(requests.map((request) => [request.method, request.url.pathname])).toEqual([
    ["GET", "/api/location/memory"],
    ["POST", "/api/location/memory"],
    ["PATCH", "/api/experimental/config"],
  ])
  expect(requests[1]!.body).toEqual({ target: { type: "agent", agent: "review" } })
  expect(requests[2]!.body).toEqual({ shell: null, output_style: null, language: null, memory: { enabled: false } })
})

test("event.subscribe exposes and decodes the native Effect event stream", async () => {
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          `data: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {} })}\n\n` +
            `data: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  )
  const events = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.event.subscribe().pipe(Stream.runCollect)
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(Array.from(events).map((event) => event.type)).toEqual(["server.connected", "session.model.selected"])
  const durable = events[1]
  if (durable?.type !== "session.model.selected") throw new Error("Expected model event")
  expect(durable.created).toBe(1_717_171_717_000)
  expect(durable.durable).toEqual({ aggregateID: "ses_test", seq: 1, version: 1 })
})

test("shared event source runs with the Effect context captured by make", async () => {
  const connected = { id: "evt_connected", type: "server.connected", data: {} }
  const Token = Context.Reference("test/effect/token", { defaultValue: () => "missing" })
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const token = yield* Token
      expect(token).toBe("captured")
      return HttpClientResponse.fromWeb(
        request,
        new Response(`data: ${JSON.stringify(connected)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
      )
    }),
  )
  const client = await Effect.runPromise(
    Orbit.make({ baseUrl: "http://localhost:3000" }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Token, "captured"),
    ),
  )
  expect((await Effect.runPromise(Stream.runCollect(client.event.subscribe())))[0]).toEqual(connected)
})

test("event.subscribe terminates on Effect protocol decode failures", async () => {
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(`data: {"type":"server.connected"}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  )
  const error = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.event.subscribe().pipe(Stream.runCollect, Effect.flip)
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(error._tag).toBe("ClientError")
})

test("session methods retain decoded Effect inputs and outputs", async () => {
  const logQueries: Array<Record<string, string>> = []
  const requests: Array<{ method: string; url: string }> = []
  const httpClient = HttpClient.make((request) => {
    const url = request.url
    requests.push({ method: request.method, url })
    if (url.includes("/log")) {
      logQueries.push(Object.fromEntries(request.urlParams.params))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\ndata: ${JSON.stringify(synced)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )
    }
    if (url.includes("/prompt")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(admission)))
    }
    if (url.endsWith("/compact")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(compactionAdmission)))
    }
    if (url.includes("/context")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] })))
    }
    if (url.includes("/message/")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: modelSwitchedMessage })))
    }
    if (url.endsWith("/api/session/active")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ data: { ses_test: { type: "running" } } })),
      )
    }
    if (request.method === "POST" && url.endsWith("/api/session")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(session)))
    }
    if (request.method === "POST") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.includes("/interrupt")
            ? Response.json({ interrupted: true })
            : new Response(null, { status: 204 }),
        ),
      )
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ data: [session.data], cursor: { next: "next" } })),
    )
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const page = yield* client.session.list({ limit: 10 })
    const active = yield* client.session.active()
    const created = yield* client.session.create({
      location: Location.Ref.make({ directory: AbsolutePath.make("/tmp/project") }),
    })
    yield* client.session.view({
      sessionID: Session.ID.make("ses_test"),
      idle: DateTime.makeUnsafe(session.data.time.idle),
    })
    yield* client.session.switchAgent({ sessionID: Session.ID.make("ses_test"), agent: Agent.ID.make("build") })
    yield* client.session.switchModel({
      sessionID: Session.ID.make("ses_test"),
      model: Model.Ref.make({ id: "claude", providerID: "anthropic" }),
    })
    const admitted = yield* client.session.prompt({
      sessionID: Session.ID.make("ses_test"),
      text: "Hello",
      resume: false,
    })
    yield* client.session.compact({ sessionID: Session.ID.make("ses_test") })
    yield* client.session.wait({ sessionID: Session.ID.make("ses_test") })
    const context = yield* client.session.context({ sessionID: Session.ID.make("ses_test") })
    const log = yield* client.session
      .log({ sessionID: Session.ID.make("ses_test"), after: Event.Seq.make(0) })
      .pipe(Stream.runCollect)
    const interrupted = yield* client.session.interrupt({ sessionID: Session.ID.make("ses_test") })
    const message = yield* client.session.message.get({
      sessionID: Session.ID.make("ses_test"),
      messageID: SessionMessage.ID.make("msg_model"),
    })
    return { page, active, created, admitted, context, log, interrupted, message }
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  const listed = result.page.data[0]
  if (!listed?.time.idle || !listed.time.viewed) throw new Error("Expected attention times")
  expect(DateTime.toEpochMillis(listed.time.created)).toBe(1_717_171_717_000)
  expect(DateTime.toEpochMillis(listed.time.idle)).toBe(1_717_171_717_002)
  expect(DateTime.toEpochMillis(listed.time.viewed)).toBe(1_717_171_717_001)
  expect(result.active).toEqual({ ses_test: { type: "running" } })
  expect(result.interrupted).toEqual({ interrupted: true })
  expect(Object.getPrototypeOf(result.page.data[0])).toBe(Object.prototype)
  expect(Object.getPrototypeOf(result.created)).toBe(Object.prototype)
  expect(result.created.id).toBe("ses_test")
  expect(Object.getPrototypeOf(result.admitted)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(result.admitted.payload)).toBe(Object.prototype)
  expect(DateTime.toEpochMillis(result.admitted.time.created)).toBe(1_717_171_717_000)
  expect(result.context).toEqual([])
  expect(logQueries[0]).toEqual({ after: "0" })
  expect(requests).toContainEqual({ method: "POST", url: "http://localhost:3000/api/session/ses_test/view" })
  const logged = Array.from(result.log)
  expect(logged.map((item) => item.type)).toEqual(["session.model.selected", "log.synced"])
  expect(logged[0]?.type === "session.model.selected" && logged[0].created).toBe(1_717_171_717_000)
  expect(logged.at(-1)).toEqual(synced)
  expect(result.message).toEqual(expect.objectContaining({ id: "msg_model", type: "model-switched" }))
})

test("session.log retains the typed SessionNotFoundError", async () => {
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
          { status: 404 },
        ),
      ),
    ),
  )
  const error = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    return yield* client.session.log({ sessionID: Session.ID.make("ses_missing") }).pipe(Stream.runCollect, Effect.flip)
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(error._tag).toBe("SessionNotFoundError")
})

test("session.recap posts to the session's recap route and decodes whether a recap was recorded", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const answers = [
    Response.json({ recorded: true }),
    Response.json({ recorded: false }),
    Response.json({ _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" }, { status: 404 }),
    // An answer that does not decode is a client error, not a recap.
    Response.json({ recorded: "yes" }),
  ]
  const httpClient = HttpClient.make((request) => {
    requests.push({ method: request.method, url: request.url })
    return Effect.succeed(HttpClientResponse.fromWeb(request, answers.shift() ?? new Response(null, { status: 500 })))
  })
  const result = await Effect.gen(function* () {
    const client = yield* Orbit.make({ baseUrl: "http://localhost:3000" })
    const recorded = yield* client.session.recap({ sessionID: Session.ID.make("ses_test") })
    const skipped = yield* client.session.recap({ sessionID: Session.ID.make("ses_test") })
    const missing = yield* client.session.recap({ sessionID: Session.ID.make("ses_missing") }).pipe(Effect.flip)
    const malformed = yield* client.session.recap({ sessionID: Session.ID.make("ses_test") }).pipe(Effect.flip)
    return { recorded, skipped, missing, malformed }
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(result.recorded).toEqual({ recorded: true })
  expect(result.skipped).toEqual({ recorded: false })
  expect(result.missing._tag).toBe("SessionNotFoundError")
  expect(result.malformed._tag).toBe("ClientError")
  expect(requests).toEqual([
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/recap" },
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/recap" },
    { method: "POST", url: "http://localhost:3000/api/session/ses_missing/recap" },
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/recap" },
  ])
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
      idle: 1_717_171_717_002,
      viewed: 1_717_171_717_001,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    id: "msg_test",
    sessionID: "ses_test",
    type: "user",
    payload: { text: "Hello" },
    delivery: "steer",
    time: { created: 1_717_171_717_000 },
  },
}

const compactionAdmission = {
  data: {
    type: "compaction",
    payload: {},
    delivery: "queue",
    id: "msg_compaction",
    sessionID: "ses_test",
    time: { created: 1_717_171_717_000 },
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const modelSwitchedEvent = {
  id: "evt_model",
  created: 1_717_171_717_000,
  type: "session.model.selected",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  },
}
