import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("orb -s ses_123")
})

test("writes out the control characters of a session title instead of printing them", () => {
  // A set-title sequence, one that erases the line and a right-to-left override: a title can come from a model, or from
  // a workflow that an older release ran.
  const epilogue = sessionEpilogue({ title: "A\u001b]0;pwned\u0007\u001b[2K\u{202e}b", sessionID: "ses_123" })

  expect(epilogue).toContain("A\\x1b]0;pwned\\x07\\x1b[2K\\u{202e}b")
  // What is left is the colours that the epilogue sets for itself.
  expect(epilogue.replace(/\u001b\[[0-9;]*m/g, "").replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})
