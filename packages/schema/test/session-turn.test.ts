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

  test("drops keys it does not define", () => {
    expect(decode({ maxSteps: 2, maxTurns: 9 })).toEqual({ maxSteps: 2 })
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
