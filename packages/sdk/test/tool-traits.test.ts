import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src"

const Input = Schema.Struct({ id: Schema.String })

test("exports the Promise form of tool traits and the resolved traits a tool receives", () => {
  const traits: Tool.Traits<{ readonly id: string }> = {
    readOnly: async (input) => input.id.length > 0,
    concurrencySafe: (input) => input.id !== "*",
    destructive: false,
    displayName: "Lookup",
  }
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    traits,
    execute: async ({ id }, context) => {
      const resolved: Tool.ResolvedTraits = context.traits
      return { content: `${id}:${resolved.readOnly}` }
    },
  }

  expect(tool.traits?.displayName).toBe("Lookup")
})

test("keeps Effect answers out of the Promise form", () => {
  // @ts-expect-error A Promise plugin answers with a boolean or a Promise, not an Effect.
  const effect: Tool.Traits = { readOnly: () => Effect.succeed(true) }
  // @ts-expect-error A predicate answers with a boolean, not a string.
  const text: Tool.Traits = { concurrencySafe: () => "yes" }

  expect([effect, text]).toHaveLength(2)
})
