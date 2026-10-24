// tool-runtime-9: which of a step's new tool results the message budget saves. The runner rows in
// `session-runner.test.ts` drive the whole pass; these pin the choice itself on histories the runner rarely makes: hosted
// results, file parts, overrides already in the history (an import or a fork), a marker that does not decode, and an
// attempt that an output-escalation notice replaced.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@orbit/core/agent"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionMessageBudget } from "@orbit/core/session/runner/message-budget"

const decode = Schema.decodeUnknownSync(SessionMessage.Info)
const user = (id: string) => decode({ id, type: "user", text: "Search", time: { created: 0 } })
const assistant = (id: string, content: ReadonlyArray<Record<string, unknown>>) =>
  decode({
    id,
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "model", providerID: "provider" },
    content: content.map((part) => ({ type: "tool", name: "emit", time: { created: 0, completed: 0 }, ...part })),
    time: { created: 0, completed: 0 },
  })
const result = (id: string, size: number, extra: Record<string, unknown> = {}) => ({
  id,
  state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(size) }] },
  ...extra,
})
// A limit of 100 characters; `unbounded` is the tool that declares no result limit.
const chosen = (messages: ReadonlyArray<SessionMessage.Info>) =>
  SessionMessageBudget.select({ messages, exempt: (name) => name === "unbounded", limit: 100 })?.chosen.map(
    (candidate) => candidate.id,
  )

describe("SessionMessageBudget.select", () => {
  test("decides only the results of the newest assistant message", () => {
    const history = [
      user("msg_u1"),
      assistant("msg_old", [result("call_old", 300)]),
      user("msg_u2"),
      assistant("msg_new", [result("call_1", 60), result("call_2", 50)]),
    ]
    expect(chosen(history)).toEqual(["call_1"])
    expect(SessionMessageBudget.select({ messages: history, exempt: () => false, limit: 100 })?.messageID).toBe(
      SessionMessage.ID.make("msg_new"),
    )
  })

  test("decides nothing in a history without an assistant message", () => {
    expect(chosen([user("msg_u1")])).toBeUndefined()
  })

  test("leaves a hosted result whole and out of the sum", () => {
    expect(
      chosen([assistant("msg_a", [result("call_hosted", 300, { executed: true }), result("call_1", 60)])]),
    ).toEqual([])
  })

  test("leaves a result with a file part whole and out of the sum", () => {
    const file = { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" }
    const withFile = {
      id: "call_file",
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(300) }, file] },
    }
    expect(chosen([assistant("msg_a", [withFile, result("call_1", 60)])])).toEqual([])
  })

  test("leaves a tool without a result limit whole and out of the sum", () => {
    expect(
      chosen([assistant("msg_a", [result("call_read", 300, { name: "unbounded" }), result("call_1", 60)])]),
    ).toEqual([])
  })

  // An imported or forked history can carry an override on its newest group; valid or not, it is never decided again.
  test("leaves a result that carries an override out of the sum, whether it decodes or not", () => {
    const valid = { session: "ses_source", name: "msg_0123abc-call_v-1a2b3c4d.txt", format: 1 }
    expect(
      chosen([
        assistant("msg_a", [
          result("call_valid", 300, { override: valid }),
          result("call_malformed", 300, { override: "../../.ssh/id_rsa" }),
          result("call_1", 60),
        ]),
      ]),
    ).toEqual([])
  })

  test("saves nothing when the new results come to exactly the limit", () => {
    expect(chosen([assistant("msg_a", [result("call_1", 60), result("call_2", 40)])])).toEqual([])
  })

  // Its own step already saved it and lowering sends the wrapper, so it neither counts nor goes.
  test("leaves a result its step saved on its own out of the sum", () => {
    const marker = {
      persisted: { session: "ses_source", name: "msg_0123abc-call_m-1a2b3c4d.txt", size: 300, format: 1 },
    }
    expect(
      chosen([
        assistant("msg_a", [
          { ...result("call_marker", 300), state: { ...result("call_marker", 300).state, metadata: marker } },
          result("call_1", 60),
        ]),
      ]),
    ).toEqual([])
  })

  // Lowering sends a result whose marker does not decode as stored, so it counts and can go.
  test("counts a result whose saved marker does not decode", () => {
    const marker = { persisted: { session: "../x", name: "msg_0123abc-call_m-1a2b3c4d.txt", size: 80, format: 1 } }
    expect(
      chosen([
        assistant("msg_a", [
          { ...result("call_marker", 80), state: { ...result("call_marker", 80).state, metadata: marker } },
          result("call_1", 60),
        ]),
      ]),
    ).toEqual(["call_marker"])
  })

  test("skips an attempt that an output-escalation notice replaced", () => {
    const cut = decode({
      id: "msg_cut",
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text", text: "cut off" }],
      time: { created: 0, completed: 0 },
    })
    const notice = decode({
      id: "msg_notice",
      type: "synthetic",
      text: "escalated",
      metadata: { notice: "output-escalation", replaces: "msg_cut" },
      time: { created: 0 },
    })
    expect(
      chosen([user("msg_u1"), assistant("msg_tools", [result("call_1", 60), result("call_2", 50)]), cut, notice]),
    ).toEqual(["call_1"])
  })
})
