import { expect, test } from "bun:test"
import { exitStatus, TrustDeclined } from "../src/index"

// The terminal UI ends with a reason, and the process exits with the status that reason carries. A trust question about
// the folder it started in, answered with Exit or Escape, ends it with 1 and its "no" key with 0, as the reference does;
// any other reason, such as an error the terminal UI prints, has no status of its own and leaves the process's as it is.
// `trust-first.test.ts` drives the real app to each answer and reads the status it leaves.
test("a declined trust question exits 1, the no binding exits 0", () => {
  expect(exitStatus(new TrustDeclined(1))).toBe(1)
  expect(exitStatus(new TrustDeclined(0))).toBe(0)
  expect(exitStatus(new Error("the server went away"))).toBeUndefined()
  expect(exitStatus(undefined)).toBeUndefined()
})
