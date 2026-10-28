import { expect, test } from "bun:test"
import { contextBar } from "../../src/util/session"

test("the context bar fills one cell per eighth of the window", () => {
  expect(contextBar(0)).toBe("▯▯▯▯▯▯▯▯ 0%")
  expect(contextBar(34)).toBe("▮▮▮▯▯▯▯▯ 34%")
  expect(contextBar(100)).toBe("▮▮▮▮▮▮▮▮ 100%")
  expect(contextBar(140)).toBe("▮▮▮▮▮▮▮▮ 140%")
})
