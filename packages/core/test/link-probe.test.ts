import { expect, test } from "bun:test"
import { linkProbe } from "./fixture/symlink"

const refusal = (code: string) => Object.assign(new Error(code), { code })

test("a link that can be made is a yes", () => {
  expect(linkProbe(() => {})).toBe(true)
})

test("a refusal for lack of privilege is a no", () => {
  expect(
    linkProbe(() => {
      throw refusal("EPERM")
    }),
  ).toBe(false)
})

test.each(["EBUSY", "EMFILE", "ENOSPC", "EACCES"])("%s is a failed probe, not a no that drops the link rows", (code) => {
  expect(() =>
    linkProbe(() => {
      throw refusal(code)
    }),
  ).toThrow(code)
})
