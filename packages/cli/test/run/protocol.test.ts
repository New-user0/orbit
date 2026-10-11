import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { decodeInput, lineReader } from "../../src/run/protocol"

const ok = (value: unknown) => {
  const decoded = decodeInput(typeof value === "string" ? value : JSON.stringify(value))
  if (Result.isFailure(decoded)) throw new Error(`Did not decode: ${JSON.stringify(decoded.failure)}`)
  return decoded.success
}

const bad = (value: unknown) => {
  const decoded = decodeInput(typeof value === "string" ? value : JSON.stringify(value))
  if (Result.isSuccess(decoded)) throw new Error(`Decoded: ${JSON.stringify(decoded.success)}`)
  return decoded.failure
}

describe("every input decodes", () => {
  test.each([
    ["a user message", { type: "user", text: "hi" }],
    ["a user message with files", { type: "user", text: "hi", files: ["a.txt", "data:text/plain;base64,AA=="] }],
    ["a steered user message", { type: "user", text: "hi", delivery: "steer" }],
    ["a queued user message", { type: "user", text: "hi", delivery: "queue" }],
    ["a user message with an id", { type: "user", text: "hi", id: "msg_abc123" }],
    ["an interrupt", { type: "interrupt" }],
    ["a permission reply of once", { type: "permission_reply", requestID: "per_1", decision: "once" }],
    ["a permission reply of always", { type: "permission_reply", requestID: "per_1", decision: "always" }],
    ["a permission reply of reject", { type: "permission_reply", requestID: "per_1", decision: "reject" }],
    [
      "a permission reply of reject with a message",
      { type: "permission_reply", requestID: "per_1", decision: "reject", message: "no" },
    ],
    ["a form reply", { type: "form_reply", formID: "frm_1", answer: { q0: "a", q1: ["b"], q2: 3, q3: true } }],
    ["a form cancel", { type: "form_cancel", formID: "frm_1" }],
    ["a form cancel with a message", { type: "form_cancel", formID: "frm_1", message: "later" }],
    ["set_model with a model", { type: "set_model", model: "provider/model#variant" }],
    ["set_model without one", { type: "set_model" }],
    ["set_model with default", { type: "set_model", model: "default" }],
    ["end", { type: "end" }],
  ])("%s", (_, value) => {
    expect(ok(value)).toMatchObject(value)
  })
})

describe("a line that does not decode names the field at fault", () => {
  test.each([
    ["an unknown type", { type: "teleport" }, ["type"]],
    ["no type", { text: "hi" }, ["type"]],
    ["a type that is not a string", { type: 5 }, ["type"]],
    ["an inherited key as the type", { type: "toString" }, ["type"]],
    ["a missing text", { type: "user" }, ["text"]],
    ["a text that is not a string", { type: "user", text: 5 }, ["text"]],
    ["a bad delivery", { type: "user", text: "x", delivery: "now" }, ["delivery"]],
    ["an id that is not a message ID", { type: "user", text: "x", id: "ses_1" }, ["id"]],
    ["files that are not a list", { type: "user", text: "x", files: "a.txt" }, ["files"]],
    ["a request ID without the per prefix", { type: "permission_reply", requestID: "x", decision: "once" }, ["requestID"]],
    ["a decision that is not known", { type: "permission_reply", requestID: "per_1", decision: "maybe" }, ["decision"]],
    ["a bad form ID", { type: "form_reply", formID: "x", answer: {} }, ["formID"]],
    ["an answer that is not a record", { type: "form_reply", formID: "frm_1", answer: [] }, ["answer"]],
    ["a bad form ID on cancel", { type: "form_cancel", formID: "x" }, ["formID"]],
    ["a model with no provider", { type: "set_model", model: "model" }, ["model"]],
    ["a model with two variants", { type: "set_model", model: "a/b#c#d" }, ["model"]],
  ])("%s", (_, value, path) => {
    expect(bad(value).path).toEqual(path)
  })

  test.each([
    ["text that is not JSON", "this is not json"],
    ["JSON null", "null"],
    ["an array", "[1]"],
    ["a number", "7"],
    ["a string", '"user"'],
    ["an empty object", "{}"],
  ])("%s", (_, line) => {
    const failure = bad(line)
    expect(failure.path).toEqual(line === "{}" ? ["type"] : [])
    // The message never quotes the line, which is the controller's text.
    expect(failure.message).not.toContain(line === "{}" ? "\u0000" : line)
  })

  test("the message does not echo the value", () => {
    expect(bad({ type: "user", text: 5, secret: "ECHO-MARKER" }).message).not.toContain("ECHO-MARKER")
    expect(bad("ECHO-MARKER {").message).not.toContain("ECHO-MARKER")
  })
})

test("extra keys are ignored", () => {
  expect(ok({ type: "interrupt", extra: { deep: true } })).toEqual({ type: "interrupt" })
  expect(ok({ type: "user", text: "x", forged: "y" })).toEqual({ type: "user", text: "x" })
})

test("a CRLF-terminated line and a line with surrounding whitespace decode", () => {
  expect(ok('{"type":"interrupt"}\r')).toEqual({ type: "interrupt" })
  expect(ok('  {"type":"end"} \t')).toEqual({ type: "end" })
})

describe("lineReader", () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  test("splits on newlines only, keeps the unterminated tail for the end, and keeps empty lines", () => {
    const reader = lineReader()
    expect(reader.push(encode("a\nb\r\n\nc"))).toEqual(["a", "b\r", ""])
    expect(reader.push(encode("d\ne"))).toEqual(["cd"])
    expect(reader.end()).toEqual(["e"])
    expect(reader.end()).toEqual([])
  })

  test("drops one byte-order mark at the start of the stream, and only there", () => {
    const reader = lineReader()
    expect(reader.push(new Uint8Array([0xef, 0xbb, 0xbf, ...encode("first\n")]))).toEqual(["first"])
    expect(reader.push(encode("﻿second\n"))).toEqual(["﻿second"])
  })

  test("a byte-order mark split across chunks is dropped too", () => {
    const reader = lineReader()
    expect(reader.push(new Uint8Array([0xef, 0xbb]))).toEqual([])
    expect(reader.push(new Uint8Array([0xbf, ...encode("first\n")]))).toEqual(["first"])
  })

  test("a multi-byte character split across chunks arrives intact", () => {
    const bytes = encode("snow ☃ and \u{1F680}\n")
    for (let cut = 1; cut < bytes.length; cut++) {
      const reader = lineReader()
      expect([...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))]).toEqual([
        "snow ☃ and \u{1F680}",
      ])
    }
  })

  test("a text with no final newline is one line at the end", () => {
    const reader = lineReader()
    expect(reader.push(encode("only"))).toEqual([])
    expect(reader.end()).toEqual(["only"])
  })
})
