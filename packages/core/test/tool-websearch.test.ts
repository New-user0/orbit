import { describe, expect } from "bun:test"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { HttpClientError } from "effect/unstable/http"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Permission } from "@orbit/core/permission"
import { KV } from "@orbit/core/kv"
import { Form } from "@orbit/core/form"
import { WebSearch } from "@orbit/core/websearch"
import { Session } from "@orbit/core/session"
import { toSessionError } from "@orbit/core/session/to-session-error"
import { Tool } from "@orbit/core/tool"
import { WebSearchTool } from "@orbit/core/tool/plugin/websearch"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Image } from "@orbit/core/image"
import { ToolOutput } from "@orbit/core/tool-output"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"
import { webSearchHost } from "./plugin/host"
import { TestWebSearch } from "./lib/websearch"

const webSearchToolNode = makeLocationNode({
  name: "test/websearch-tool-plugin",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      yield* registerToolPlugin(WebSearchTool.Plugin, { websearch: webSearchHost(websearch) })
    }),
  ),
  deps: [Tool.node, Permission.node, WebSearch.node, Form.node],
})

const sessionID = Session.ID.make("ses_websearch_test")
const providers = [
  { id: WebSearch.ID.make("exa"), name: "Exa" },
  { id: WebSearch.ID.make("parallel"), name: "Parallel" },
]

class Fixture {
  assertions: Permission.AssertInput[] = []
  events: string[] = []
  providerInputs: unknown[] = []
  formRequests: Form.CreateInput[] = []
  formResponse: Form.TerminalState = { status: "cancelled" }
  formResponses: Form.TerminalState[] = []
  formWait: Effect.Effect<void, Form.InvalidFormError> = Effect.void
  error: HttpClientError.HttpClientError | undefined
  results: readonly WebSearch.Result[] = [
    { url: "https://example.com", title: "Search results", content: "search results", time: {} },
  ]
}

const it = testEffect(TestWebSearch.layer)
// `realForm` keeps the real Form service, so a test answers, cancels or times out a form the way a client does.
const makeSetup = (realForm: boolean) => Effect.gen(function* () {
  const fixture = new Fixture()
  const websearch = yield* TestWebSearch.Service
  const kv = yield* KV.Service
  yield* websearch.transform((editor) =>
    providers.forEach((provider) =>
      editor.add({
        ...provider,
        execute: (input) =>
          Effect.gen(function* () {
            fixture.events.push("query")
            fixture.providerInputs.push(input)
            if (fixture.error) return yield* fixture.error
            return fixture.results
          }),
      }),
    ),
  )
  const context = yield* Layer.build(
    AppNodeBuilder.build(LayerNode.group([Tool.node, webSearchToolNode, Form.node]), [
      Permission.node.replace(
        permissionLayer({
          assert: (input) =>
            Effect.sync(() => {
              fixture.events.push("permission")
              fixture.assertions.push(input)
            }),
        }),
      ),
      WebSearch.node.replace(Layer.succeed(WebSearch.Service, websearch)),
      ...(realForm
        ? []
        : [
            Form.node.replace(
              Layer.mock(Form.Service, {
                ask: (input) =>
                  Effect.gen(function* () {
                    fixture.formRequests.push(input)
                    yield* fixture.formWait
                    return fixture.formResponses.shift() ?? fixture.formResponse
                  }),
              }),
            ),
          ]),
      Image.node.replace(imagePassthrough),
    ]),
  )
  return Object.assign(fixture, {
    websearch,
    kv,
    registry: Context.get(context, Tool.Service),
    forms: Context.get(context, Form.Service),
  })
})
const setup = makeSetup(false)
const setupReal = makeSetup(true)

describe("WebSearchTool registration", () => {
  it.effect("asserts permission before delegating to WebSearch", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const registry = fixture.registry
      yield* fixture.websearch.select(WebSearch.ID.make("exa"))

      expect(yield* toolTraits(registry, "WebSearch", { query: "effect" })).toMatchObject({
        readOnly: true,
        concurrencySafe: true,
        openWorld: true,
        interruptBehavior: "cancel",
      })
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["WebSearch", "Execute"])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-search",
            name: "WebSearch",
            input: { query: "effect typescript" },
          },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          {
            type: "text",
            text: `${WebSearchTool.SOURCES_REMINDER}

## [Search results](https://example.com)\n\nsearch results`,
          },
        ],
      })
      expect(fixture.assertions).toMatchObject([
        {
          sessionID,
          action: "WebSearch",
          resources: ["effect typescript"],
          save: ["*"],
          metadata: { query: "effect typescript" },
        },
      ])
      expect(fixture.websearch.queries).toEqual([
        {
          query: "effect typescript",
          providerID: undefined,
        },
      ])
      expect(fixture.events).toEqual(["permission", "query"])
      expect(fixture.websearch.sessionIDs).toEqual([sessionID])
    }),
  )

  it.effect("keeps normalized results in structured output", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select(WebSearch.ID.make("parallel"))
      fixture.results = [
        {
          url: "https://effect.website",
          title: "Effect",
          content: "parallel results",
          time: { published: Date.parse("2026-07-25T00:00:00.000Z") },
        },
      ]
      const registry = fixture.registry

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-parallel", name: "WebSearch", input: { query: "effect layers" } },
        }),
      ).toEqual({
        status: "completed",
        output: {
          provider: "parallel",
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "parallel results",
              time: { published: Date.parse("2026-07-25T00:00:00.000Z") },
            },
          ],
        },
        content: [
          {
            type: "text",
            text: `${WebSearchTool.SOURCES_REMINDER}

## [Effect](https://effect.website)\nPublished: 2026-07-25T00:00:00.000Z\n\nparallel results`,
          },
        ],
        metadata: { provider: "parallel" },
      })
    }),
  )

  it.effect("keeps only results from allowed domains and drops blocked ones", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select(WebSearch.ID.make("parallel"))
      fixture.results = ["https://docs.python.org/3/", "https://blog.python.org/x", "https://spam.example.com/"].map(
        (url) => ({ url, title: url, content: "", time: {} }),
      )
      const search = (input: Record<string, unknown>) =>
        executeTool(fixture.registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-domains", name: "WebSearch", input: { query: "python", ...input } },
        }).pipe(
          Effect.map((result) => (result.output as { results: { url: string }[] }).results.map((item) => item.url)),
        )

      expect(yield* search({ allowedDomains: ["python.org"], blockedDomains: ["blog.python.org"] })).toEqual([
        "https://docs.python.org/3/",
      ])
      expect(yield* search({ blockedDomains: ["example.com"] })).toEqual([
        "https://docs.python.org/3/",
        "https://blog.python.org/x",
      ])
      // Domains filter the results only; the provider and the recorded query see just the query.
      expect(fixture.providerInputs).toEqual([{ query: "python" }, { query: "python" }])
      expect(fixture.websearch.queries).toEqual([
        { query: "python", providerID: undefined },
        { query: "python", providerID: undefined },
      ])

      // The model sees only `content`, so the filter must hold there too.
      const filtered = yield* executeTool(fixture.registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-domains-content",
          name: "WebSearch",
          input: { query: "python", allowedDomains: ["python.org"], blockedDomains: ["blog.python.org"] },
        },
      })
      const text = (filtered.content?.[0] as { text: string }).text
      expect(text.startsWith(WebSearchTool.SOURCES_REMINDER)).toBe(true)
      expect(text).toContain("https://docs.python.org/3/")
      expect(text).not.toContain("blog.python.org")
      expect(text).not.toContain("spam.example.com")

      const empty = yield* executeTool(fixture.registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-domains-empty",
          name: "WebSearch",
          input: { query: "python", allowedDomains: ["nowhere.test"] },
        },
      })
      expect(empty.content).toEqual([{ type: "text", text: WebSearchTool.NO_RESULTS }])
      expect((empty.output as { results: unknown[] }).results).toEqual([])
    }),
  )

  it.effect("requires a Sources section in the description and starts results with a reminder", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select(WebSearch.ID.make("exa"))
      const definition = (yield* toolDefinitions(fixture.registry)).find((tool) => tool.name === "WebSearch")
      expect(definition?.description).toContain('"Sources:" section')
      expect(definition?.description).toContain("allowedDomains")
      expect(definition?.description).toContain("blockedDomains")
      expect(definition?.description).toContain(String(new Date().getFullYear()))
      const result = yield* executeTool(fixture.registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-sources", name: "WebSearch", input: { query: "effect" } },
      })
      expect(result.content).toMatchObject([{ type: "text" }])
      const text = (result.content?.[0] as { text: string }).text
      expect(text.startsWith(WebSearchTool.SOURCES_REMINDER)).toBe(true)
      expect(WebSearchTool.SOURCES_REMINDER).toContain('"Sources:"')
      expect(definition?.description).toContain('"Sources:"')

      // The session runner keeps the head of an oversized result, so the reminder must survive that bound.
      fixture.results = Array.from({ length: 30 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `Result ${i}`,
        content: "line\n".repeat(20),
        time: {},
      }))
      const large = yield* executeTool(fixture.registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large", name: "WebSearch", input: { query: "effect" } },
      })
      const bounded = yield* Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const output = yield* ToolOutput.Service
            yield* output.transform((editor) => editor.configure({ maxLines: 50 }))
            return yield* output.truncate({ content: large.content as Tool.Content[] })
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
                Global.node.replace(Global.layerWith({ data: tmp.path })),
              ]),
            ),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      expect(bounded.metadata).toMatchObject({ truncated: true })
      expect(JSON.stringify(bounded.content)).toContain("Reminder: when your reply uses these results")
    }),
  )

  it.effect("uses the concise no-results fallback", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select(WebSearch.ID.make("exa"))
      fixture.results = []
      const registry = fixture.registry

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-empty", name: "WebSearch", input: { query: "nothing" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: WebSearchTool.NO_RESULTS }],
      })
      expect(WebSearchTool.NO_RESULTS).not.toContain("Sources")
    }),
  )

  it.effect("asks once and uses the default provider when web search is first enabled", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      fixture.formResponse = { status: "answered", answer: { choice: "allow" } }
      const registry = fixture.registry

      const first = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-enable", name: "WebSearch", input: { query: "effect" } },
      })
      expect(first.status).toBe("completed")
      expect(["exa", "parallel"]).toContain(first.metadata?.provider)
      expect(fixture.websearch.sessionIDs).toEqual([sessionID, sessionID])
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe("random")
      expect(fixture.websearch.queries).toHaveLength(2)
      expect(fixture.formRequests).toEqual([
        {
          sessionID,
          title: "Web Search",
          metadata: { kind: "websearch.provider" },
          fields: [
            {
              key: "choice",
              description: "Allow Orbit to search the web for up-to-date information?",
              type: "string",
              required: true,
              custom: false,
              options: [
                {
                  value: "allow",
                  label: "Allow search via Exa, Parallel",
                },
                {
                  value: "choose",
                  label: "Choose another provider",
                },
                { value: "disable", label: "Disable web search" },
              ],
            },
          ],
        },
      ])

      const second = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-enabled", name: "WebSearch", input: { query: "effect schema" } },
      })
      expect(second.status).toBe("completed")
      expect(["exa", "parallel"]).toContain(second.metadata?.provider)
      expect(second.metadata?.provider).toBe(first.metadata?.provider)
      expect(fixture.formRequests).toHaveLength(1)
      expect(fixture.websearch.queries).toHaveLength(3)
    }),
  )

  it.effect("honors automatic consent when the configured provider is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.transform((editor) => editor.default.set(WebSearch.ID.make("missing")))
      fixture.formResponse = { status: "answered", answer: { choice: "allow" } }
      const result = yield* executeTool(fixture.registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-missing", name: "WebSearch", input: { query: "effect" } },
      })
      expect(result.status).toBe("completed")
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe("random")
      expect(result.metadata?.provider).toBe(
        (yield* fixture.websearch.query({ query: "next" }, { sessionID })).providerID,
      )
      expect(fixture.formRequests).toHaveLength(1)
    }),
  )

  it.effect("asks a second form when choosing another provider", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      fixture.formResponses.push(
        { status: "answered", answer: { choice: "choose" } },
        { status: "answered", answer: { provider: "parallel" } },
      )
      const registry = fixture.registry

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-choose", name: "WebSearch", input: { query: "effect" } },
        }),
      ).toMatchObject({ status: "completed", metadata: { provider: "parallel" } })
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe(WebSearch.ID.make("parallel"))
      expect(fixture.websearch.queries).toHaveLength(2)
      expect(fixture.websearch.queries[1]?.providerID).toBe(WebSearch.ID.make("parallel"))
      expect(fixture.formRequests[1]).toEqual({
        sessionID,
        title: "Choose a web search provider",
        metadata: { kind: "websearch.provider" },
        fields: [
          {
            key: "provider",
            description: "Choose a provider for web search.",
            type: "string",
            required: true,
            custom: false,
            options: [
              { value: "exa", label: "Exa" },
              { value: "parallel", label: "Parallel" },
            ],
          },
        ],
      })
    }),
  )

  it.effect("shares provider consent across concurrent searches", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      fixture.formResponse = { status: "answered", answer: { choice: "allow" } }
      fixture.formWait = fixture.websearch.wait(5)
      const registry = fixture.registry

      const results = yield* Effect.all(
        Array.from({ length: 5 }, (_, index) =>
          executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: `call-concurrent-${index}`,
              name: "WebSearch",
              input: { query: `effect ${index}` },
            },
          }),
        ),
        { concurrency: "unbounded" },
      )

      expect(results.every((item) => item.status === "completed")).toBe(true)
      expect(fixture.formRequests).toHaveLength(1)
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe("random")
    }),
  )

  it.effect("persists the choice to disable web search", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      fixture.formResponse = { status: "answered", answer: { choice: "disable" } }
      const registry = fixture.registry

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disable", name: "WebSearch", input: { query: "effect" } },
        }),
      ).toMatchObject({ status: "error" })
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe(false)
      expect(yield* fixture.websearch.default().pipe(Effect.flip)).toBeInstanceOf(WebSearch.DisabledError)
      expect(fixture.websearch.queries).toHaveLength(1)
    }),
  )

  it.effect("keeps provider progress, output, and metadata accurate across automatic failover", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select("random")
      const first = (yield* fixture.websearch.query({ query: "seed" }, { sessionID })).providerID
      yield* fixture.websearch.transform((editor) =>
        editor.add({
          id: first,
          name: first,
          execute: () => Effect.fail(TestWebSearch.httpError()),
        }),
      )
      const progress: Tool.Metadata[] = []
      const tools = yield* fixture.registry.snapshot()
      const result = yield* tools.execute({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-failover", name: "WebSearch", input: { query: "effect" } },
        progress: (metadata) =>
          Effect.sync(() => {
            progress.push(metadata)
          }),
      })
      const replacement = WebSearch.ID.make(first === "exa" ? "parallel" : "exa")
      expect(progress).toEqual([{ provider: first }, { provider: replacement }])
      expect(result).toMatchObject({
        output: { provider: replacement, results: fixture.results },
        metadata: { provider: replacement },
      })
      expect(fixture.formRequests).toEqual([])
      expect((yield* fixture.websearch.query({ query: "next" }, { sessionID })).providerID).toBe(replacement)
    }),
  )

  it.effect("does not reopen consent when all automatic providers are cooling down", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.websearch.select("random")
      fixture.error = TestWebSearch.httpError()
      const tools = yield* fixture.registry.snapshot()
      yield* Effect.forEach(["first", "cooling"], (query) =>
        Effect.gen(function* () {
          const error = yield* tools
            .execute({
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: `call-${query}`, name: "WebSearch", input: { query } },
            })
            .pipe(Effect.flip)
          expect(toSessionError(error)).toEqual({
            type: "tool.execution",
            message: "Web search rate limited (HTTP 429)",
          })
          expect(error.metadata).toMatchObject({ provider: expect.stringMatching(/^(exa|parallel)$/) })
        }),
      )
      expect(fixture.events.filter((event) => event === "query")).toHaveLength(2)
      expect(fixture.formRequests).toEqual([])
    }),
  )

  it.effect("reports safe HTTP failures with the attempted provider", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const registry = fixture.registry
      const tools = yield* registry.snapshot()
      yield* fixture.websearch.select(WebSearch.ID.make("exa"))

      yield* Effect.forEach(
        [
          { status: 403, message: "Web search request failed (HTTP 403)" },
          { status: 429, message: "Web search rate limited (HTTP 429)" },
          { status: 401, message: "Web search authentication failed (HTTP 401)" },
        ],
        ({ status, message }, index) =>
          Effect.gen(function* () {
            fixture.error = TestWebSearch.httpError(status, undefined, "https://mcp.exa.ai/mcp?exaApiKey=secret")
            const progress: Tool.Metadata[] = []
            const error = yield* tools
              .execute({
                sessionID,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: `call-http-${index}`,
                  name: "WebSearch",
                  input: { query: "effect" },
                },
                progress: (metadata) => Effect.sync(() => progress.push(metadata)),
              })
              .pipe(Effect.flip)

            const sessionError = toSessionError(error)
            expect(sessionError).toEqual({ type: "tool.execution", message })
            expect(sessionError.message).not.toContain("secret")
            expect(error.metadata).toEqual({ provider: "exa" })
            expect(progress).toEqual([{ provider: "exa" }])
          }),
        { discard: true },
      )
    }),
  )
})

describe("WebSearchTool consent stays a user decision", () => {
  const call = (id: string, query = "effect") =>
    ({ sessionID, ...toolIdentity, call: { type: "tool-call", id, name: "WebSearch", input: { query } } }) as const

  // Waits until a consent form is pending, the way a client sees it.
  const pending = (fixture: Effect.Success<typeof setupReal>, exclude: readonly string[] = []) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        const form = (yield* fixture.forms.list({ sessionID })).find((item) => !exclude.includes(item.id))
        if (form) return form
        yield* Effect.yieldNow
      }
      return yield* Effect.die("no pending form")
    })
  const start = (fixture: Effect.Success<typeof setupReal>, id: string, progress: unknown[] = []) =>
    Effect.gen(function* () {
      const tools = yield* fixture.registry.snapshot()
      const fiber = yield* tools
        .execute({ ...call(id), progress: (metadata) => Effect.sync(() => progress.push(metadata)) })
        .pipe(Effect.flip, Effect.forkChild)
      return { fiber, form: yield* pending(fixture) }
    })
  const expectNothingHappened = (fixture: Effect.Success<typeof setupReal>, progress: unknown[] = []) =>
    Effect.gen(function* () {
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBeUndefined()
      expect(fixture.events.filter((event) => event === "query")).toHaveLength(0)
      expect(progress).toEqual([])
    })
  const expectNotEnabled = (error: Tool.Error) => {
    expect(toSessionError(error)).toEqual({ type: "websearch.not-enabled", message: WebSearchTool.NOT_ENABLED })
    expect(WebSearchTool.NOT_ENABLED).toContain("websearch")
  }

  it.effect("fails not-enabled when the first form is cancelled, with or without a message", () =>
    Effect.gen(function* () {
      for (const options of [undefined, { message: "no thanks" }]) {
        const fixture = yield* setupReal
        const progress: unknown[] = []
        const started = yield* start(fixture, "call-cancel", progress)
        yield* fixture.forms.cancel(started.form.id, options)
        expectNotEnabled(yield* Fiber.join(started.fiber))
        yield* expectNothingHappened(fixture, progress)
      }
    }),
  )

  it.effect("fails not-enabled when the provider form is cancelled after choosing another provider", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const progress: unknown[] = []
      const started = yield* start(fixture, "call-choose", progress)
      yield* fixture.forms.reply({ id: started.form.id, answer: { choice: "choose" } })
      yield* fixture.forms.cancel((yield* pending(fixture, [started.form.id])).id)
      expectNotEnabled(yield* Fiber.join(started.fiber))
      yield* expectNothingHappened(fixture, progress)
    }),
  )

  it.effect("fails not-enabled after a minute, cancels the form and stores nothing for a late reply", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const started = yield* start(fixture, "call-timeout")
      yield* TestClock.adjust("1 minute")
      expectNotEnabled(yield* Fiber.join(started.fiber))
      expect(yield* fixture.forms.state(started.form.id)).toMatchObject({ status: "cancelled" })
      expect(yield* fixture.forms.list({ sessionID })).toEqual([])
      const late = yield* fixture.forms.reply({ id: started.form.id, answer: { choice: "allow" } }).pipe(Effect.flip)
      expect(late).toBeInstanceOf(Form.AlreadySettledError)
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("fails not-enabled when the minute runs out during the provider form", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const started = yield* start(fixture, "call-timeout-2")
      yield* fixture.forms.reply({ id: started.form.id, answer: { choice: "choose" } })
      const second = yield* pending(fixture, [started.form.id])
      yield* TestClock.adjust("1 minute")
      expectNotEnabled(yield* Fiber.join(started.fiber))
      expect(yield* fixture.forms.state(second.id)).toMatchObject({ status: "cancelled" })
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("fails not-enabled when the form service closes while the form is pending", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const started = yield* start(fixture, "call-close")
      yield* fixture.forms.close
      expectNotEnabled(yield* Fiber.join(started.fiber))
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("fails not-enabled when the form cannot be created", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      fixture.formWait = Effect.fail(new Form.InvalidFormError({ message: "refused" }))
      const tools = yield* fixture.registry.snapshot()
      expectNotEnabled(yield* tools.execute(call("call-invalid")).pipe(Effect.flip))
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("keeps an interrupt an interrupt and cancels the form", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const tools = yield* fixture.registry.snapshot()
      const fiber = yield* tools.execute(call("call-interrupt")).pipe(Effect.forkChild)
      const form = yield* pending(fixture)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* fixture.forms.state(form.id)).toMatchObject({ status: "cancelled" })
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("asks again on the next call, because a cancel is not remembered", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const first = yield* start(fixture, "call-first")
      yield* fixture.forms.cancel(first.form.id)
      expectNotEnabled(yield* Fiber.join(first.fiber))
      const second = yield* start(fixture, "call-second")
      expect(second.form.id).not.toBe(first.form.id)
      yield* fixture.forms.cancel(second.form.id)
      expectNotEnabled(yield* Fiber.join(second.fiber))
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("fails both concurrent calls when the form is cancelled", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const tools = yield* fixture.registry.snapshot()
      const fibers = yield* Effect.forEach(["a", "b"], (id) =>
        tools.execute(call(`call-${id}`, id)).pipe(Effect.flip, Effect.forkChild),
      )
      const first = yield* pending(fixture)
      yield* fixture.forms.cancel(first.id)
      const second = yield* pending(fixture, [first.id])
      yield* fixture.forms.cancel(second.id)
      yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber).pipe(Effect.map(expectNotEnabled)))
      yield* expectNothingHappened(fixture)
    }),
  )

  it.effect("still stores and queries when the user allows", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const tools = yield* fixture.registry.snapshot()
      const fiber = yield* tools.execute(call("call-allow")).pipe(Effect.forkChild)
      const form = yield* pending(fixture)
      yield* fixture.forms.reply({ id: form.id, answer: { choice: "allow" } })
      yield* Fiber.join(fiber)
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe("random")
      expect(fixture.events.filter((event) => event === "query")).toHaveLength(1)
    }),
  )

  it.effect("still stores false when the user disables", () =>
    Effect.gen(function* () {
      const fixture = yield* setupReal
      const started = yield* start(fixture, "call-disable-real")
      yield* fixture.forms.reply({ id: started.form.id, answer: { choice: "disable" } })
      yield* Fiber.join(started.fiber)
      expect(yield* fixture.kv.get(WebSearch.ProviderKey)).toBe(false)
      expect(fixture.events.filter((event) => event === "query")).toHaveLength(0)
    }),
  )
})
