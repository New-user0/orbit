import { expect, test } from "bun:test"
import { CodeModeTool } from "@orbit/core/codemode/tool"
import { Permission } from "@orbit/core/permission"
import { Tool } from "@orbit/core/tool"
import { execute } from "@orbit/core/tool/runtime"
import { Agent } from "@orbit/schema/agent"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import type { Info } from "@orbit/schema/tool"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const createCodeMode = (tools: ReadonlyMap<string, Info>, authorize: CodeModeTool.Authorize = () => Effect.void) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context), authorize)

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
      "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.all`.",
    ].join("\n"),
  )
})

test("canonical execution distinguishes declared, model-only, and raw schema outputs", async () => {
  const declared: Info = {
    name: "declared",
    description: "Declared",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: ({ value }) => Effect.succeed({ output: { value } }),
  }
  const modelOnlyInput = Schema.Struct({})
  const modelOnly = {
    name: "model_only",
    description: "Model only",
    input: modelOnlyInput,
    execute: () => Effect.succeed({ content: "visible only", metadata: { kind: "model" } }),
  } satisfies Info<typeof modelOnlyInput, undefined>
  const raw: Info = {
    name: "raw",
    description: "Raw",
    input: {},
    output: {},
    execute: (input) => Effect.succeed({ output: input, content: "raw" }),
  }

  expect(await Effect.runPromise(execute(declared, { value: "encoded" }, context))).toEqual({
    output: { value: "encoded" },
    content: [{ type: "text", text: '{"value":"encoded"}' }],
  })
  expect(await Effect.runPromise(execute(modelOnly, {}, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: "visible only" }],
    metadata: { kind: "model" },
  })
  expect(await Effect.runPromise(execute(raw, { unchecked: true }, context))).toEqual({
    output: { unchecked: true },
    content: [{ type: "text", text: "raw" }],
  })
})

test("declared outputs cannot bypass validation and raw outputs stay JSON-compatible", async () => {
  const missing: Info = {
    name: "missing",
    description: "Missing output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed({ content: "not an output" }),
  }
  const invalid: Info = {
    name: "invalid",
    description: "Invalid raw output",
    input: {},
    output: {},
    execute: () => Effect.succeed({ output: 1n, content: "not JSON" }),
  }

  expect((await Effect.runPromiseExit(execute(missing, {}, context))).toString()).toContain(
    "Tool did not return its declared output",
  )
  expect((await Effect.runPromiseExit(execute(invalid, {}, context))).toString()).toContain(
    "Tool returned a non-JSON value",
  )
})

test("foreign typed failures settle as Tool.Error at the untrusted boundary", async () => {
  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  const lying: Info = {
    name: "lying",
    description: "Fails with a non-Tool.Error typed failure",
    input: Schema.Struct({}),
    execute: () => new ForeignFailure({ message: "transport died" }) as never,
  }

  const error = await Effect.runPromise(execute(lying, {}, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe("transport died")
})

test("execute supports callable namespace tools", async () => {
  const callable: Info = {
    name: "admin",
    description: "Administer Slack",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack" },
    execute: () => Effect.succeed({ output: "admin" }),
  }
  const child: Info = {
    name: "create",
    description: "Create a Slack resource",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack.admin" },
    execute: () => Effect.succeed({ output: "created" }),
  }
  const codeMode = createCodeMode(
    new Map([
      ["slack_admin", callable],
      ["slack_admin_create", child],
    ]),
  )
  const result = await Effect.runPromise(
    codeMode.execute({ code: "return [await tools.slack.admin({}), await tools.slack.admin.create({})]" }, context),
  )

  expect(result.metadata).toEqual({
    toolCalls: [
      { tool: "slack.admin", status: "completed" },
      { tool: "slack.admin.create", status: "completed" },
    ],
  })
  expect(result.content).toEqual([{ type: "text", text: '[\n  "admin",\n  "created"\n]' }])
})

const reply = (name: string, run: Info["execute"]): [string, Info] => [
  name,
  { name, description: `Settles as ${name}`, input: Schema.Struct({}), output: Schema.String, execute: run },
]

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.flatMap((reason) => (Cause.isDieReason(reason) ? [reason.defect] : [])) : []

// A step that never ends is what a regression looks like here, so a real-clock bound turns the wait into a failure.
const bounded = <A, E>(effect: Effect.Effect<A, E>) => Effect.timeout(effect, "2 seconds")

test("a plain decline ends the execution with that defect and runs no later call", async () => {
  const ran: Array<string> = []
  const decline = new Permission.DeclinedError()
  const codeMode = createCodeMode(
    new Map([
      reply("declined", () => Effect.die(decline)),
      reply("later", () =>
        Effect.sync(() => {
          ran.push("later")
          return { output: "ran" }
        }),
      ),
    ]),
  )

  // The program cannot carry on: not behind a try/catch, not by leaving the declined call un-awaited, and not by
  // finishing without ever looking at it.
  for (const code of [
    `try { await tools.declined({}) } catch (e) { return "caught" }; await tools.later({}); return "unreachable"`,
    `tools.declined({}); await tools.later({}); return "unreachable"`,
    `tools.declined({}); return "done"`,
  ]) {
    const exit = await Effect.runPromiseExit(codeMode.execute({ code }, context))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(defects(exit)).toEqual([decline])
    expect(defects(exit)[0]).toBe(decline)
  }
  expect(ran).toEqual([])
})

test("a decline interrupts calls still in flight instead of waiting for them", async () => {
  const interrupted: Array<string> = []
  const decline = new Permission.DeclinedError()
  const codeMode = createCodeMode(
    new Map([
      reply("slow", () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("slow")))),
      ),
      reply("declined", () => Effect.die(decline)),
    ]),
  )

  // Whether or not the program is waiting on the declined call, the call it does wait on is stopped, not finished.
  for (const code of [
    `return await Promise.all([tools.slow({}), tools.declined({})])`,
    `const slow = tools.slow({}); tools.declined({}).catch(() => {}); return await slow`,
    `const slow = tools.slow({}); try { await tools.declined({}) } catch (e) {}; return await slow`,
  ]) {
    interrupted.length = 0
    const exit = await Effect.runPromiseExit(bounded(codeMode.execute({ code }, context)))

    expect(defects(exit)).toEqual([decline])
    expect(interrupted).toEqual(["slow"])
  }
})

test("interrupting the execution still interrupts the calls it is waiting on", async () => {
  const interrupted: Array<string> = []
  const codeMode = createCodeMode(
    new Map([
      reply("slow", () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("slow")))),
      ),
    ]),
  )

  // The program runs raced against a decline; that race must not stand between an interrupt and the calls.
  const exit = await Effect.runPromiseExit(
    codeMode.execute({ code: `return await tools.slow({})` }, context).pipe(Effect.timeout("100 millis")),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(interrupted).toEqual(["slow"])
})

test("a decline stops a program that can only finish through handlers of a call that never settles", async () => {
  const ran: Array<string> = []
  const decline = new Permission.DeclinedError()
  const codeMode = createCodeMode(
    new Map([
      reply("declined", () => Effect.die(decline)),
      reply("later", () =>
        Effect.sync(() => {
          ran.push("later")
          return { output: "ran" }
        }),
      ),
    ]),
  )

  // An interrupted call never runs its handlers, so a program that waits for one to settle it would wait forever.
  for (const code of [
    `return await new Promise((resolve) => { tools.declined({}).then(resolve, resolve) })`,
    `const { promise, resolve } = Promise.withResolvers(); tools.declined({}).finally(() => resolve("settled")); return await promise`,
    `let left = 2; const { promise, resolve } = Promise.withResolvers(); const done = () => { left -= 1; if (left === 0) resolve("settled") }; tools.declined({}).then(done, done); tools.declined({}).then(done, done); return await promise`,
    // The same holds for a call the decline halts before it starts.
    `tools.declined({}); return await new Promise((resolve) => { tools.later({}).then(resolve, resolve) })`,
  ]) {
    const exit = await Effect.runPromiseExit(bounded(codeMode.execute({ code }, context)))

    expect(defects(exit)).toEqual([decline])
  }
  expect(ran).toEqual([])
})

test("a decline also stops a later fetch from being made", async () => {
  const hits: Array<string> = []
  const decline = new Permission.DeclinedError()
  const codeMode = createCodeMode(new Map([reply("declined", () => Effect.die(decline))]))

  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              hits.push(request.url)
              return new Response("served")
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const url = `http://127.0.0.1:${server.port}/`

      const served = yield* codeMode.execute({ code: `return await (await fetch("${url}")).text()` }, context)
      expect(served.output.output).toBe("served")
      expect(hits).toEqual([url])

      const exit = yield* Effect.exit(
        codeMode.execute({ code: `tools.declined({}); await fetch("${url}"); return "unreachable"` }, context),
      )
      expect(defects(exit)).toEqual([decline])
      // The stop does not cancel a request that was already sent, which would still reach the server a moment later.
      yield* Effect.sleep("200 millis")
      expect(hits).toEqual([url])
    }).pipe(Effect.scoped),
  )
})

test("feedback and policy blocks stay tool failures the program can catch", async () => {
  const ran: Array<string> = []
  const codeMode = createCodeMode(
    new Map([
      reply("corrected", () =>
        Effect.fail(new Permission.CorrectedError({ feedback: "Use the staging bucket" })).pipe(
          Effect.mapError((error) => new Tool.Error({ message: error.feedback })),
        ),
      ),
      reply("blocked", () =>
        Effect.fail(new Permission.BlockedError({ rules: [], permission: "blocked", resources: ["*"] })).pipe(
          Effect.mapError((error) => new Tool.Error({ message: error.message })),
        ),
      ),
      reply("later", () =>
        Effect.sync(() => {
          ran.push("later")
          return { output: "ran" }
        }),
      ),
    ]),
  )

  const result = await Effect.runPromise(
    codeMode.execute(
      {
        code: `
          const seen = []
          try { await tools.corrected({}) } catch (e) { seen.push(e.message) }
          try { await tools.blocked({}) } catch (e) { seen.push(e.message) }
          seen.push(await tools.later({}))
          return seen
        `,
      },
      context,
    ),
  )

  expect(JSON.parse(result.output.output)).toEqual(["Use the staging bucket", "Permission denied: blocked", "ran"])
  expect(result.output.error).toBeUndefined()
  expect(ran).toEqual(["later"])
})

// A local server records what reaches the network, so a refused fetch can be shown to send nothing. It sends /old on
// to /new.
const serving = <A, E>(use: (origin: string, hits: Array<string>) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const hits: Array<string> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              const path = new URL(request.url).pathname
              hits.push(`${request.method} ${path}`)
              if (path === "/old") return new Response(null, { status: 302, headers: { location: "/new" } })
              return new Response("served")
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      return yield* use(`http://127.0.0.1:${server.port}`, hits)
    }),
  )

test("authorizes a fetch with its call and the execute context before anything is sent", async () => {
  const seen: Array<{ call: unknown; context: unknown; sent: number }> = []
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), (call, ctx) =>
          Effect.sync(() => void seen.push({ call, context: ctx, sent: hits.length })),
        )

        const result = yield* codeMode.execute(
          { code: `return (await fetch("${origin}/a", { method: "post", body: "x" })).status` },
          context,
        )

        expect(result.output.output).toBe("200")
        expect(hits).toEqual(["POST /a"])
        expect(seen).toEqual([
          {
            call: { extension: "web", name: "fetch", args: [`${origin}/a`, { method: "post", body: "x" }] },
            context,
            sent: 0,
          },
        ])
      }),
    ),
  )
})

test("a fetch that fails authorization is never made, and the program can catch the failure", async () => {
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), () => Effect.fail(new Tool.Error({ message: "Not for this host" })))

        const result = yield* codeMode.execute(
          { code: `try { await fetch("${origin}/a") } catch (e) { return e.message }; return "unreachable"` },
          context,
        )

        expect(result.output.output).toBe("Not for this host")
        expect(result.output.error).toBeUndefined()
        expect(hits).toEqual([])
      }),
    ),
  )
})

test("a declined fetch ends the execution like a declined tool call", async () => {
  const decline = new Permission.DeclinedError()
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), () => Effect.die(decline))

        // The program cannot catch its way past it, leave the call un-awaited, or run another call first.
        for (const code of [
          `try { await fetch("${origin}/a") } catch (e) { return "caught" }; return "unreachable"`,
          `fetch("${origin}/a"); return "done"`,
          `return await Promise.all([fetch("${origin}/a"), fetch("${origin}/b")])`,
          `return await new Promise((resolve) => { fetch("${origin}/a").then(resolve, resolve) })`,
        ]) {
          const exit = yield* Effect.exit(bounded(codeMode.execute({ code }, context)))
          expect(defects(exit)).toEqual([decline])
        }
        expect(hits).toEqual([])
      }),
    ),
  )
})

test("authorizes each redirect a fetch follows with a call of its own, and a refusal ends the fetch", async () => {
  const seen: Array<{ call: unknown; context: unknown; sent: number }> = []
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), (call, ctx) => {
          // A URL object is compared by what it spells.
          seen.push({ call: { ...call, args: [String(call.args[0]), call.args[1]] }, context: ctx, sent: hits.length })
          return String(call.args[0]).endsWith("/new")
            ? Effect.fail(new Tool.Error({ message: "Not for this host" }))
            : Effect.void
        })

        const result = yield* codeMode.execute(
          {
            code: `try { await fetch("${origin}/old", { method: "post", body: "x" }) } catch (e) { return e.message }; return "unreachable"`,
          },
          context,
        )

        expect(result.output.output).toBe("Not for this host")
        expect(hits).toEqual(["POST /old"])
        // A 302 turns the POST into a GET, so the redirect is asked about as the request it has become.
        expect(seen).toEqual([
          {
            call: { extension: "web", name: "fetch", args: [`${origin}/old`, { method: "post", body: "x" }] },
            context,
            sent: 0,
          },
          { call: { extension: "web", name: "fetch", args: [`${origin}/new`, { method: "GET" }] }, context, sent: 1 },
        ])
      }),
    ),
  )
})

test("a declined redirect ends the execution like a declined call, and sends nothing more", async () => {
  const decline = new Permission.DeclinedError()
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), (call) =>
          String(call.args[0]).endsWith("/new") ? Effect.die(decline) : Effect.void,
        )

        // The program cannot catch its way past it, whichever way it waits for the fetch.
        for (const code of [
          `try { await fetch("${origin}/old") } catch (e) { return "caught" }; return "unreachable"`,
          `return await Promise.all([fetch("${origin}/old"), fetch("${origin}/old")])`,
          `return await new Promise((resolve) => { fetch("${origin}/old").then(resolve, resolve) })`,
        ]) {
          hits.length = 0
          const exit = yield* Effect.exit(bounded(codeMode.execute({ code }, context)))
          expect(defects(exit)).toEqual([decline])
          expect(hits.filter((hit) => hit.endsWith("/new"))).toEqual([])
        }
      }),
    ),
  )
})

test("holds a fetch until its authorization settles", async () => {
  await Effect.runPromise(
    serving((origin, hits) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const codeMode = createCodeMode(new Map(), () => Deferred.await(gate))

        const fiber = yield* codeMode
          .execute({ code: `return (await fetch("${origin}/a")).status` }, context)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("100 millis")
        expect(hits).toEqual([])

        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(fiber)).output.output).toBe("200")
        expect(hits).toEqual(["GET /a"])
      }),
    ),
  )
})

test("shows a fetch as running only once it may go ahead, and a refused one as an error", async () => {
  const updates: Array<unknown> = []
  const tracked = {
    ...context,
    progress: (update: { toolCalls?: unknown }) => Effect.sync(() => void updates.push(update.toolCalls)),
  }
  await Effect.runPromise(
    serving((origin) =>
      Effect.gen(function* () {
        const codeMode = createCodeMode(new Map(), (call) =>
          String(call.args[0]).endsWith("/ok") ? Effect.void : Effect.fail(new Tool.Error({ message: "Not here" })),
        )

        yield* codeMode.execute(
          {
            code: `await fetch("${origin}/ok"); try { await fetch("${origin}/no", { method: "POST" }) } catch (e) {}; return "done"`,
          },
          tracked,
        )

        const ok = { tool: "fetch", input: { method: "GET", url: `${origin}/ok` } }
        expect(updates).toEqual([
          [{ ...ok, status: "running" }],
          [{ ...ok, status: "completed" }],
          [
            { ...ok, status: "completed" },
            { tool: "fetch", status: "error", input: { method: "POST", url: `${origin}/no` } },
          ],
        ])
      }),
    ),
  )
})
