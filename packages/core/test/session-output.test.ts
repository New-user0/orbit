import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import path from "path"
import { SessionOutput } from "@orbit/core/session/output"
import { SessionTurn } from "@orbit/schema/session-turn"

const compiled = (schema: unknown) => {
  const result = SessionOutput.compile(schema)
  if (!result.ok) throw new Error(result.message)
  return result.validator
}

const person = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
  required: ["name", "age"],
  additionalProperties: false,
}

describe("SessionOutput.compile", () => {
  // Every keyword the validator enforces, each with an answer that follows it and one that does not.
  const enforced: ReadonlyArray<readonly [string, Record<string, unknown>, unknown, unknown, string]> = [
    ["required", { type: "object", required: ["a"] }, { a: 1 }, {}, "/a: is required but missing"],
    ["enum", { type: "object", properties: { a: { enum: ["x", 2] } } }, { a: 2 }, { a: "y" }, "/a: must be one of"],
    [
      "const",
      { type: "object", properties: { a: { const: { k: [1] } } } },
      { a: { k: [1] } },
      { a: { k: [2] } },
      "/a: must equal",
    ],
    [
      "pattern",
      { type: "object", properties: { a: { type: "string", pattern: "^a+$" } } },
      { a: "aa" },
      { a: "ab" },
      "/a: must match the pattern",
    ],
    [
      "items",
      { type: "object", properties: { a: { type: "array", items: { type: "integer" } } } },
      { a: [1, 2] },
      { a: [1, "x"] },
      "/a/1: must be an integer",
    ],
    [
      "prefixItems (2020-12)",
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { a: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false } },
      },
      { a: ["x", 1] },
      { a: ["x", 1, 2] },
      "/a/2: no value is allowed here",
    ],
    [
      "items array (draft-07)",
      { type: "object", properties: { a: { items: [{ type: "string" }], additionalItems: false } } },
      { a: ["x"] },
      { a: ["x", 1] },
      "/a/1",
    ],
    [
      "oneOf",
      { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "integer" }] } } },
      { a: 1 },
      { a: true },
      '/a: must follow exactly one of the 2 alternatives in "oneOf", but follows 0',
    ],
    [
      "anyOf",
      { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "integer" }] } } },
      { a: "x" },
      { a: null },
      "/a: must follow at least one",
    ],
    [
      "allOf",
      { type: "object", properties: { a: { allOf: [{ type: "integer" }, { minimum: 3 }] } } },
      { a: 3 },
      { a: 2 },
      "/a: must be at least 3",
    ],
    [
      "not",
      { type: "object", properties: { a: { not: { type: "string" } } } },
      { a: 1 },
      { a: "x" },
      "/a: must not follow",
    ],
    [
      "additionalProperties",
      { type: "object", properties: { a: {} }, additionalProperties: false },
      { a: 1 },
      { a: 1, b: 2 },
      "/b: is not an allowed property",
    ],
    [
      "additionalProperties schema",
      { type: "object", additionalProperties: { type: "integer" } },
      { a: 1 },
      { a: "x" },
      "/a: must be an integer",
    ],
    [
      "patternProperties",
      { type: "object", patternProperties: { "^n_": { type: "integer" } } },
      { n_a: 1, other: "x" },
      { n_a: "x" },
      "/n_a: must be an integer",
    ],
    [
      "propertyNames",
      { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
      { ab: 1 },
      { A: 1 },
      "/A: is not an allowed property name",
    ],
    [
      "$ref into $defs",
      { type: "object", properties: { a: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } },
      { a: 1 },
      { a: "x" },
      "/a: must be an integer",
    ],
    [
      "$ref into definitions",
      { type: "object", properties: { a: { $ref: "#/definitions/n" } }, definitions: { n: { type: "integer" } } },
      { a: 1 },
      { a: "x" },
      "/a: must be an integer",
    ],
    [
      "minLength counts characters",
      { type: "object", properties: { a: { type: "string", minLength: 2 } } },
      { a: "\u{1F600}\u{1F600}" },
      { a: "\u{1F600}" },
      "/a: must be at least 2 characters long",
    ],
    [
      "multipleOf",
      { type: "object", properties: { a: { multipleOf: 0.1 } } },
      { a: 0.3 },
      { a: 0.35 },
      "/a: must be a multiple of 0.1",
    ],
    [
      "exclusiveMinimum",
      { type: "object", properties: { a: { exclusiveMinimum: 1 } } },
      { a: 2 },
      { a: 1 },
      "/a: must be greater than 1",
    ],
    [
      "uniqueItems",
      { type: "object", properties: { a: { uniqueItems: true } } },
      { a: [{ x: 1 }, { x: 2 }] },
      { a: [{ x: 1 }, { x: 1 }] },
      "/a: must not repeat an item",
    ],
    [
      "contains",
      { type: "object", properties: { a: { contains: { const: 1 }, minContains: 2 } } },
      { a: [1, 1] },
      { a: [1] },
      "/a: must have at least 2 items",
    ],
    [
      "minProperties",
      { type: "object", minProperties: 1 },
      { a: 1 },
      {},
      "the answer: must have at least 1 properties",
    ],
    [
      "dependentRequired",
      { type: "object", dependentRequired: { a: ["b"] } },
      { a: 1, b: 2 },
      { a: 1 },
      "/b: is required when",
    ],
    [
      "if / then / else",
      {
        type: "object",
        if: { properties: { a: { const: 1 } }, required: ["a"] },
        then: { required: ["b"] },
        else: { required: ["c"] },
      },
      { a: 1, b: 1 },
      { a: 2 },
      "/c: is required but missing",
    ],
    [
      "type list",
      { type: "object", properties: { a: { type: ["string", "null"] } } },
      { a: null },
      { a: 1 },
      "/a: must be a string or a null, not a number",
    ],
  ]

  test.each(enforced)("enforces %s", (_name, schema, ok, wrong, message) => {
    const validator = compiled(schema)

    expect(validator.validate(ok)).toEqual([])
    expect(SessionOutput.rejection(validator.validate(wrong))).toContain(message)
  })

  test("reports every failure, not the first", () => {
    const failures = compiled(person).validate({ age: -1, extra: true })

    expect(failures.map((failure) => failure.pointer).sort()).toEqual(["/age", "/extra", "/name"])
  })

  test("treats format as an annotation, as 2020-12 does by default", () => {
    const validator = compiled({ type: "object", properties: { a: { type: "string", format: "email" } } })

    expect(validator.validate({ a: "not an email" })).toEqual([])
  })

  test("accepts the annotations without enforcing them", () => {
    const validator = compiled({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/person",
      $comment: "c",
      title: "Person",
      description: "d",
      type: "object",
      default: {},
      examples: [{}],
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      properties: { a: { type: "string", contentMediaType: "text/plain", contentEncoding: "7bit" } },
    })

    expect(validator.validate({ a: 1 }).map((failure) => failure.pointer)).toEqual(["/a"])
  })

  test("names a property with control characters without carrying them into the message", () => {
    const validator = compiled({ type: "object", additionalProperties: false })

    const message = SessionOutput.rejection(validator.validate({ "a\u001b]0;pwned\u0007\nb": 1 }))

    expect(message).not.toMatch(/[\u001b\u0007]/)
    expect(message.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1)
  })

  test("caches a compiled schema by its content, whatever the order of its keys", () => {
    const first = compiled({ type: "object", required: ["a"], properties: { a: {} } })
    const second = compiled({ properties: { a: {} }, required: ["a"], type: "object" })

    expect(second).toBe(first)
  })

  test("never builds code from a schema", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../src/session/output.ts")).text()

    expect(source).not.toMatch(/new\s+Function|\beval\s*\(|\bFunction\s*\(|import\s*\(/)
  })

  // A reference that never reads the answer would loop forever in a naive validator; the answer is checked in a child
  // process under a deadline, because a synchronous loop would also stop this runner's own timeout.
  const inChild = async (script: string) => {
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), 15_000)
    const code = await child.exited
    clearTimeout(timer)
    return { code, out: await new Response(child.stdout).text() }
  }
  const outputModule = JSON.stringify(path.join(import.meta.dir, "../src/session/output.ts").replaceAll("\\", "/"))

  test(
    "follows a recursive reference down the answer",
    async () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } },
        required: ["name"],
      }
      const result = await inChild(`
        import { SessionOutput } from ${outputModule}
        const result = SessionOutput.compile(${JSON.stringify(schema)})
        if (!result.ok) throw new Error(result.message)
        console.log(JSON.stringify([
          result.validator.validate({ name: "a", children: [{ name: "b", children: [{ name: "c" }] }] }).length,
          result.validator.validate({ name: "a", children: [{ name: "b", children: [{}] }] }).map((f) => f.pointer),
        ]))
      `)

      expect(result.code).toBe(0)
      expect(JSON.parse(result.out)).toEqual([0, ["/children/0/children/0/name"]])
    },
    30_000,
  )

  test("counts nesting, not chained references, against the depth limit", () => {
    const defs = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`d${index}`, index === 69 ? { type: "string" } : { $ref: `#/$defs/d${index + 1}` }]),
    )

    expect(SessionOutput.compile({ type: "object", properties: { a: { $ref: "#/$defs/d0" } }, $defs: defs }).ok).toBe(true)
  })

  test("refuses a nested $id, which would change what its references point at", () => {
    const result = SessionOutput.compile({
      type: "object",
      properties: { q: { $id: "https://example.com/inner", type: "object" } },
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.message).toMatch(/only allowed at the root/)
  })

  test("names an unknown keyword without carrying control characters", () => {
    const result = SessionOutput.compile({ type: "object", "bad[2Jkey": true })

    expect(result.ok === false && result.message).not.toMatch(//)
  })

  test.each([
    ["a reference to the root", { type: "object", $ref: "#" }],
    [
      "a pair of references to each other",
      { type: "object", $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } },
    ],
    ["a reference through allOf", { type: "object", allOf: [{ $ref: "#" }] }],
  ])(
    "ends the check of %s",
    async (_name, schema) => {
      const script = `
      import { SessionOutput } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/output.ts").replaceAll("\\", "/"))}
      const result = SessionOutput.compile(${JSON.stringify(schema)})
      if (!result.ok) { console.log("refused"); process.exit(0) }
      console.log(JSON.stringify(result.validator.validate({ a: 1 }).map((failure) => failure.reason)))
    `
      const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill(), 15_000)
      const code = await child.exited
      clearTimeout(timer)

      expect(code).toBe(0)
      expect(await new Response(child.stdout).text()).toMatch(
        /refers to itself without reading any of the answer|refused/,
      )
    },
    30_000,
  )
})

describe("SessionOutput.execute", () => {
  const run = (validator: SessionOutput.Validator, input: unknown) =>
    Effect.runPromiseExit(SessionOutput.execute(validator, input))

  test("accepts an answer that follows the schema without echoing it", async () => {
    const exit = await run(compiled(person), { name: "Ada", age: 36 })

    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(JSON.stringify(exit.value.content)).not.toContain("Ada")
    expect(exit.value.metadata).toEqual({ structuredOutput: true })
  })

  test.each([[null], [[1]], ["text"], [3]])("rejects an input that is not an object: %p", async (input) => {
    const exit = await run(compiled(person), input)

    expect(JSON.stringify(exit)).toContain(SessionOutput.REJECTED)
    expect(JSON.stringify(exit)).toContain("must be a JSON object")
  })

  test("rejects the one call, never accepts it, when the validator throws", async () => {
    const validator: SessionOutput.Validator = {
      schema: person,
      validate: () => {
        throw new Error("boom")
      },
    }

    const exit = await run(validator, { name: "Ada", age: 1 })

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain(SessionOutput.REJECTED)
    expect(JSON.stringify(exit)).toContain("could not be checked against the schema")
  })

  test("keeps the message to the model bounded for a long list of failures", async () => {
    const validator = compiled({ type: "object", additionalProperties: false })
    const input = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`k${"x".repeat(100)}${index}`, 1]))

    const message = SessionOutput.rejection(validator.validate(input))

    expect(message.length).toBeLessThanOrEqual(8_100)
    expect(message).toContain("more problems may follow")
  })
})

describe("turn output options", () => {
  const decode = Schema.decodeUnknownExit(SessionTurn.RequestField)

  test.each([[0], [21], [1.5], [-1]])("refuses attempts %p", (attempts) => {
    expect(Exit.isFailure(decode({ output: { schema: person, attempts } }))).toBe(true)
  })

  test.each([[1], [5], [20]])("accepts attempts %p", (attempts) => {
    expect(Exit.isSuccess(decode({ output: { schema: person, attempts } }))).toBe(true)
  })

  test("refuses a key it does not know, beside or inside output", () => {
    expect(Exit.isFailure(decode({ output: { schema: person }, maxSteps: 1, extra: true }))).toBe(true)
    expect(Exit.isFailure(decode({ output: { schema: person, retries: 3 } }))).toBe(true)
  })

  test("refuses output without a schema", () => {
    expect(Exit.isFailure(decode({ output: { attempts: 3 } }))).toBe(true)
  })
})
