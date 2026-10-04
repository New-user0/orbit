import { expect, test } from "bun:test"
import { CodeModeTool } from "@orbit/core/codemode/tool"
import { Permission } from "@orbit/core/permission"
import { Tool } from "@orbit/core/tool"
import { execute } from "@orbit/core/tool/runtime"
import { Agent } from "@orbit/schema/agent"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import type { Info } from "@orbit/schema/tool"
import { Cause, Effect, Exit, Schema } from "effect"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const createCodeMode = (tools: ReadonlyMap<string, Info>) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context))

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
