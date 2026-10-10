import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Form } from "@orbit/core/form"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { QuestionTool } from "@orbit/core/tool/plugin/question"
import { Image } from "@orbit/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

const sessionID = Session.ID.make("ses_question_tool_test")
const assertions: Permission.AssertInput[] = []
let captured: Form.CreateInput | undefined
let reject = false
let deny = false
const capturedInput = () => captured
const questionInput = {
  questions: [
    {
      question: "Continue?",
      header: "Continue",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
}
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        deny
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})
const form = Layer.mock(Form.Service, {
  ask: (input: Form.CreateInput) =>
    Effect.sync(() => {
      captured = input
    }).pipe(
      Effect.andThen(
        Effect.sync(
          (): Form.TerminalState =>
            reject ? { status: "cancelled" } : { status: "answered", answer: { q0: "Build", q1: ["Dev"] } },
        ),
      ),
    ),
})
const questionToolNode = makeLocationNode({
  name: "test/question-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(QuestionTool.Plugin)),
  deps: [Tool.node, Permission.node, Form.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, questionToolNode]), [
    Permission.node.replace(permission),
    Form.node.replace(form),
    Image.node.replace(imagePassthrough),
  ]),
)

describe("QuestionTool", () => {
  it.effect("emits one item schema for the nonempty questions array", () =>
    Effect.gen(function* () {
      captured = undefined
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "AskUserQuestion")).toMatchObject({
        readOnly: false,
        concurrencySafe: false,
        requiresUserInteraction: true,
        interruptBehavior: "cancel",
      })
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === QuestionTool.name)

      expect(definition?.inputSchema).toHaveProperty("properties.questions.type", "array")
      expect(definition?.inputSchema).toHaveProperty("properties.questions.minItems", 1)
      expect(definition?.inputSchema).toHaveProperty("properties.questions.items")
      expect(definition?.inputSchema).not.toHaveProperty("properties.questions.prefixItems")
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-empty", name: QuestionTool.name, input: { questions: [] } },
        }),
      ).toMatchObject({
        status: "error",
        error: {
          type: "tool.input-invalid",
          message:
            'Invalid arguments for tool "AskUserQuestion":\n- questions: Expected a value with a length of at least 1\n\nArguments provided:\n{\n  "questions": []\n}\n\nUpdate the arguments and call the tool again.',
        },
      })
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("omits a catalog-denied question and enforces its leaf permission", () =>
    Effect.gen(function* () {
      captured = undefined
      deny = true
      yield* Effect.addFinalizer(() => Effect.sync(() => (deny = false)))
      const registry = yield* Tool.Service

      expect(
        (yield* toolDefinitions(registry, [{ action: "AskUserQuestion", resource: "*", effect: "deny" }])).map(
          (tool) => tool.name,
        ),
      ).toEqual(["Execute"])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-denied", name: "AskUserQuestion", input: questionInput },
        }),
      ).toEqual({
        status: "error",
        error: {
          type: "permission.rejected",
          message: "Permission denied: AskUserQuestion",
        },
      })
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("registers question and projects user answers without a permission assertion", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* Tool.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [
            { label: "Build", description: "Build it" },
            { label: "Skip", description: "Skip it" },
          ],
        },
        {
          question: "Which environment?",
          header: "Environment",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
          multiple: true,
        },
        {
          question: "Anything else?",
          header: "Optional",
          options: [
            { label: "Nothing", description: "No more" },
            { label: "More", description: "Some more" },
          ],
        },
      ]

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["AskUserQuestion", "Execute"])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "AskUserQuestion", input: { questions } },
        }),
      ).toEqual({
        status: "completed",
        output: { answers: [["Build"], ["Dev"], []] },
        content: [
          {
            type: "text",
            text: 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
          },
        ],
        metadata: { answers: [["Build"], ["Dev"], []] },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "AskUserQuestion", resources: ["*"] }])
      expect(capturedInput()).toEqual({
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, id: "call-question" } },
        fields: [
          {
            key: "q0",
            title: "Action",
            description: "What should happen?",
            options: [
              { value: "Build", label: "Build", description: "Build it" },
              { value: "Skip", label: "Skip", description: "Skip it" },
            ],
            custom: true,
            type: "string",
          },
          {
            key: "q1",
            title: "Environment",
            description: "Which environment?",
            options: [
              { value: "Dev", label: "Dev", description: "Development" },
              { value: "Prod", label: "Prod", description: "Production" },
            ],
            custom: true,
            type: "multiselect",
          },
          {
            key: "q2",
            title: "Optional",
            description: "Anything else?",
            options: [
              { value: "Nothing", label: "Nothing", description: "No more" },
              { value: "More", label: "More", description: "Some more" },
            ],
            custom: true,
            type: "string",
          },
        ],
      })
    }),
  )

  it.effect("does not invent tool ownership metadata without a durable registry source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registryService = yield* Tool.Service

      yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "AskUserQuestion", input: questionInput },
      })
      expect(capturedInput()).toEqual({
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, id: "call-question" } },
        fields: [
          {
            key: "q0",
            title: "Continue",
            description: "Continue?",
            options: [
              { value: "Yes", label: "Yes", description: "Continue" },
              { value: "No", label: "No", description: "Stop" },
            ],
            custom: true,
            type: "string",
          },
        ],
      })
    }),
  )

  it.effect("keeps dismissed questions out of model-facing output", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = true
      deny = false
      const registryService = yield* Tool.Service
      const fiber = yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "AskUserQuestion", input: questionInput },
      }).pipe(Effect.forkScoped)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(QuestionTool.CancelledError)
        expect(error).toHaveProperty("message", "The user dismissed this question")
      }
    }),
  )

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
  const pair = (label: string, extra: object = {}) => ({ label, description: label, ...extra })
  const question = (text: string, labels: string[], extra: object = {}) => ({
    question: text,
    header: text.slice(0, 12),
    options: labels.map((label) => pair(label)),
    ...extra,
  })
  const run = (registry: Tool.Interface, questions: unknown[]) =>
    executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-question-limits", name: QuestionTool.name, input: { questions } },
    })

  it.effect("states the count limits in the tool JSON Schema and the optional preview", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const schema = (yield* toolDefinitions(registry)).find((tool) => tool.name === QuestionTool.name)?.inputSchema
      const find = (node: unknown, key: string): unknown => {
        if (!isRecord(node)) return undefined
        if (key in node) return node[key]
        return Object.values(node)
          .map((child) => find(child, key))
          .find((hit) => hit !== undefined)
      }
      expect(find(schema, "questions")).toMatchObject({ minItems: 1, maxItems: 4, description: "Questions to ask (1-4)" })
      expect(find(schema, "options")).toMatchObject({ minItems: 2, maxItems: 4, description: "Available choices (2-4)" })
      expect(find(schema, "preview")).toMatchObject({ type: "string", description: expect.stringContaining("markdown") })
      expect(find(schema, "multiple")).toMatchObject({ description: "Allow selecting multiple choices" })
      expect(JSON.stringify(schema)).not.toMatch(/"required":\[[^\]]*"preview"/)
    }),
  )

  it.effect("rejects question and option counts outside the limits before any form is created", () =>
    Effect.gen(function* () {
      reject = false
      deny = false
      const registry = yield* Tool.Service
      const valid = (n: number) => question(`Question ${n}?`, ["A", "B"])
      const bad = [
        [],
        [valid(1), valid(2), valid(3), valid(4), valid(5)],
        [question("Zero?", [])],
        [question("One?", ["A"])],
        [question("Five?", ["A", "B", "C", "D", "E"])],
      ]
      for (const questions of bad) {
        captured = undefined
        expect(yield* run(registry, questions)).toMatchObject({ status: "error", error: { type: "tool.input-invalid" } })
        expect(capturedInput()).toBeUndefined()
      }
      for (const questions of [
        [valid(1)],
        [valid(1), valid(2), valid(3), valid(4)],
        [question("Four?", ["A", "B", "C", "D"])],
      ]) {
        captured = undefined
        expect(yield* run(registry, questions)).toMatchObject({ status: "completed" })
        expect(capturedInput()).toBeDefined()
      }
    }),
  )

  it.effect("requires unique question texts and unique option labels per question (exact compare)", () =>
    Effect.gen(function* () {
      reject = false
      deny = false
      const registry = yield* Tool.Service
      const rejected = [
        [question("Same?", ["Yes", "Yes"])],
        [question("Same?", ["A", "B"]), question("Same?", ["C", "D"])],
      ]
      for (const questions of rejected) {
        captured = undefined
        expect(yield* run(registry, questions)).toMatchObject({ status: "error", error: { type: "tool.input-invalid" } })
        expect(capturedInput()).toBeUndefined()
      }
      const accepted = [
        [question("First?", ["Yes", "No"]), question("Second?", ["Yes", "No"])],
        [question("Case?", ["Yes", "yes"])],
        [question("One?", ["A", "B"], { header: "Shared" }), question("Two?", ["A", "B"], { header: "Shared" })],
      ]
      for (const questions of accepted) {
        captured = undefined
        expect(yield* run(registry, questions)).toMatchObject({ status: "completed" })
        expect(capturedInput()).toBeDefined()
      }
    }),
  )

  it.effect("copies previews to single-select form options only", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* Tool.Service
      yield* run(registry, [
        {
          question: "Layout?",
          header: "Layout",
          options: [pair("Wide", { preview: "+----+\n|    |\n+----+" }), pair("Narrow"), pair("Empty", { preview: "" })],
        },
        {
          question: "Extras?",
          header: "Extras",
          multiple: true,
          options: [pair("Dev", { preview: "dev preview" }), pair("Prod")],
        },
      ])
      const fields = capturedInput()?.fields ?? []
      expect(fields.map((field) => ("custom" in field ? field.custom : undefined))).toEqual([true, true])
      expect(fields[0]).toHaveProperty("type", "string")
      expect(fields[1]).toHaveProperty("type", "multiselect")
      expect((fields[0] as { options: ReadonlyArray<object> }).options).toEqual([
        { value: "Wide", label: "Wide", description: "Wide", preview: "+----+\n|    |\n+----+" },
        { value: "Narrow", label: "Narrow", description: "Narrow" },
        { value: "Empty", label: "Empty", description: "Empty" },
      ])
      expect((fields[1] as { options: ReadonlyArray<object> }).options).toEqual([
        { value: "Dev", label: "Dev", description: "Dev" },
        { value: "Prod", label: "Prod", description: "Prod" },
      ])
    }),
  )

  it.effect("echoes the chosen preview only for a single-select label with a preview", () =>
    Effect.sync(() => {
      const previewed = {
        question: "Layout?",
        header: "Layout",
        options: [pair("Wide", { preview: "WIDE-SKETCH" }), pair("Narrow")],
      }
      const chosen = QuestionTool.toModelContent([previewed], [["Wide"]])
      expect(chosen).toContain('"Layout?"="Wide"')
      expect(chosen.indexOf("WIDE-SKETCH")).toBeGreaterThan(chosen.indexOf('"Layout?"="Wide"'))
      expect(QuestionTool.toModelContent([previewed], [["Something else"]])).not.toContain("WIDE-SKETCH")
      expect(QuestionTool.toModelContent([previewed], [["Narrow"]])).toBe(
        'User has answered your questions: "Layout?"="Narrow". You can now continue with the user\'s answers in mind.',
      )
      expect(QuestionTool.toModelContent([{ ...previewed, multiple: true }], [["Wide"]])).not.toContain("WIDE-SKETCH")
      expect(QuestionTool.toModelContent([previewed], [["Wide", "Narrow"]])).not.toContain("WIDE-SKETCH")
    }),
  )

  it.effect("declares a result cap and a description that states the contract without a product name", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "AskUserQuestion")).toMatchObject({ maxResultChars: 100000 })
      for (const needle of ["1 to 4", "2 to 4", "multiple", "preview", "Type your own answer", "ExitPlanMode"])
        expect(QuestionTool.description).toContain(needle)
      expect(QuestionTool.description).not.toMatch(/claude|anthropic/i)
    }),
  )
})
