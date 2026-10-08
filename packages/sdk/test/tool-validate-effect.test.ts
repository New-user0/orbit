import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src/effect"

const Input = Schema.Struct({ path: Schema.String })

test("exports the Effect form of validate and the codes that Orbit gives its own failures", () => {
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    validate: ({ path }, context) =>
      path === ""
        ? Effect.fail(
            new Tool.Error({ message: `Call ${context.id} names no path`, code: Tool.ErrorCode.FileNotFound }),
          )
        : Effect.void,
    execute: ({ path }) => Effect.succeed({ content: path }),
  }

  expect(tool.validate).toBeFunction()
  expect(Tool.ErrorCode.FileNotFound).toBe("file.not-found")
  expect(new Tool.Error({ message: "Missing", code: Tool.ErrorCode.EditNoMatch }).code).toBe("edit.no-match")
})

test("keeps Promise answers out of the Effect form of validate", () => {
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    // @ts-expect-error An Effect plugin validates with an Effect, not a Promise.
    validate: async () => {},
    execute: ({ path }) => Effect.succeed({ content: path }),
  }

  expect(tool).toBeDefined()
})
