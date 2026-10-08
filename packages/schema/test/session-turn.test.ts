import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionInbox } from "../src/session-inbox.js"
import { SessionMessage } from "../src/session-message.js"
import { SessionTurn } from "../src/session-turn.js"

const decode = Schema.decodeUnknownSync(SessionTurn.Options)
const fallbackModel = { id: "model", providerID: "provider" }

describe("SessionTurn.Options", () => {
  test("decodes every option, and an empty set that asks for nothing", () => {
    const every = { maxSteps: 3, maxCost: 0.5, maxTokens: 20_000, fallbackModel: { ...fallbackModel, variant: "fast" } }

    // The decoded options carry the Money.USD brand, which a plain literal does not.
    expect<unknown>(decode(every)).toEqual(every)
    expect(decode({})).toEqual({})
  })

  // Stored messages and inbox rows read with Options, so a key that another version added must not make them unreadable.
  // A request is held to a stricter schema: see SessionTurn.RequestField.
  test("ignores keys it does not define, wherever a stored message or inbox payload carries them", () => {
    const stored = { maxSteps: 2, maxTurns: 9 }
    const user = { id: "msg_turn", time: { created: 1 }, type: "user" as const, text: "hello", turn: stored }

    expect(decode(stored)).toEqual({ maxSteps: 2 })
    expect(Schema.decodeUnknownSync(SessionMessage.User)(user).turn).toEqual({ maxSteps: 2 })
    expect(Schema.decodeUnknownSync(SessionInbox.UserPayload)({ text: "hello", turn: stored }).turn).toEqual({
      maxSteps: 2,
    })
  })

  test.each([
    ["maxSteps of zero", { maxSteps: 0 }],
    ["a negative maxSteps", { maxSteps: -1 }],
    ["a fractional maxSteps", { maxSteps: 1.5 }],
    ["a maxCost of zero", { maxCost: 0 }],
    ["a negative maxCost", { maxCost: -0.01 }],
    ["a maxCost that is not finite", { maxCost: Number.POSITIVE_INFINITY }],
    ["a maxCost written as text", { maxCost: "1" }],
    ["maxTokens of zero", { maxTokens: 0 }],
    ["a negative maxTokens", { maxTokens: -100 }],
    ["a fallbackModel written as text", { fallbackModel: "provider/model" }],
    ["a fallbackModel without a provider", { fallbackModel: { id: "model" } }],
    ["a fallbackModel whose id is not text", { fallbackModel: { id: 1, providerID: "provider" } }],
  ])("rejects %s", (_name, input) => {
    expect(() => decode(input)).toThrow()
  })

  test("is optional on a prompt's inbox payload and on the user message, and round trips there", () => {
    const turn = { maxSteps: 3, fallbackModel }
    const payload = Schema.decodeUnknownSync(SessionInbox.UserPayload)
    const message = Schema.decodeUnknownSync(SessionMessage.User)
    const user = { id: "msg_turn", time: { created: 1 }, type: "user" as const, text: "hello" }

    expect(payload({ text: "hello" })).toEqual({ text: "hello" })
    expect(Schema.encodeSync(SessionInbox.UserPayload)(payload({ text: "hello", turn }))).toEqual({
      text: "hello",
      turn,
    })
    expect(Schema.encodeSync(SessionMessage.User)(message(user))).toEqual(user)
    expect(Schema.encodeSync(SessionMessage.User)(message({ ...user, turn, delivery: "queue" }))).toEqual({
      ...user,
      turn,
      delivery: "queue",
    })
    expect(() => payload({ text: "hello", turn: { maxSteps: 0 } })).toThrow()
    expect(() => message({ ...user, turn: { maxCost: -1 } })).toThrow()
  })
})

describe("SessionTurn.RequestField", () => {
  const decodeRequest = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String, turn: SessionTurn.RequestField }))

  test("reads the options Options reads, and may be left out", () => {
    const every = { maxSteps: 3, maxCost: 0.5, maxTokens: 20_000, fallbackModel: { ...fallbackModel, variant: "fast" } }

    expect<unknown>(decodeRequest({ text: "hello", turn: every })).toEqual({ text: "hello", turn: every })
    expect(decodeRequest({ text: "hello", turn: {} })).toEqual({ text: "hello", turn: {} })
    expect(decodeRequest({ text: "hello" })).toEqual({ text: "hello" })
  })

  // A dropped key would admit the prompt with fewer limits than it asked for, and an empty set lifts the turn's limits.
  test.each([
    ["a snake case spelling of a limit", { max_steps: 2 }],
    ["a limit that does not exist", { maxTurns: 9 }],
    ["a different case", { MaxSteps: 2 }],
    ["a misspelled limit beside a valid one", { maxSteps: 2, max_cost: 1 }],
    ["a key beside a fallbackModel", { fallbackModel, maxCosts: 1 }],
  ])("refuses %s instead of dropping it", (_name, turn) => {
    expect(() => decodeRequest({ text: "hello", turn })).toThrow("Expected no excess property")
  })

  test("refuses the values Options refuses", () => {
    for (const turn of [{ maxSteps: 0 }, { maxCost: -0.01 }, { maxTokens: 1.5 }, { fallbackModel: "provider/model" }])
      expect(() => decodeRequest({ text: "hello", turn })).toThrow()
  })
})

describe("message delivery", () => {
  test("is the inbox's delivery, optional on user and synthetic messages", () => {
    const user = { id: "msg_user", time: { created: 1 }, type: "user" as const, text: "hello" }
    const synthetic = { id: "msg_synthetic", time: { created: 1 }, type: "synthetic" as const, text: "done" }

    expect(SessionInbox.Delivery.literals).toEqual(["steer", "queue"])
    expect(Schema.decodeUnknownSync(SessionMessage.User)({ ...user, delivery: "steer" }).delivery).toBe("steer")
    expect(Schema.decodeUnknownSync(SessionMessage.Synthetic)({ ...synthetic, delivery: "queue" }).delivery).toBe(
      "queue",
    )
    expect(Schema.decodeUnknownSync(SessionMessage.User)(user)).not.toHaveProperty("delivery")
    expect(Schema.decodeUnknownSync(SessionMessage.Synthetic)(synthetic)).not.toHaveProperty("delivery")
    expect(() => Schema.decodeUnknownSync(SessionMessage.User)({ ...user, delivery: "later" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SessionMessage.Synthetic)({ ...synthetic, delivery: "later" })).toThrow()
  })
})
