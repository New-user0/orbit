import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src/effect"

const Input = Schema.Struct({ id: Schema.String })

test("exports the Effect form of tool traits and the resolved traits a tool receives", () => {
  const traits: Tool.Traits<{ readonly id: string }> = {
    readOnly: (input) => Effect.succeed(input.id.length > 0),
    concurrencySafe: (input) => input.id !== "*",
    destructive: false,
    displayName: "Lookup",
  }
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    traits,
    execute: ({ id }, context) => {
      const resolved: Tool.ResolvedTraits = context.traits
      return Effect.succeed({ content: `${id}:${resolved.readOnly}` })
    },
  }

  expect(tool.traits?.displayName).toBe("Lookup")
})

test("keeps Promise answers out of the Effect form", () => {
  // @ts-expect-error An Effect plugin answers with a boolean or an Effect, not a Promise.
  const promise: Tool.Traits = { readOnly: async () => true }

  expect(promise).toBeDefined()
})
