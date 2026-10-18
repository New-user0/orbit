import { expect, test } from "bun:test"
import path from "node:path"
import { IdeLock } from "./ide-lock.js"

test("a token is 43 characters of base64url, and no two are alike", () => {
  const tokens = Array.from({ length: 20 }, () => IdeLock.token())

  for (const token of tokens) expect(token).toMatch(IdeLock.tokenPattern)
  expect(new Set(tokens).size).toBe(tokens.length)
})

test("only a name of digits and .lock is a lock, and its number is the port", () => {
  expect(IdeLock.port("4021.lock")).toBe(4021)
  for (const name of ["4021.lock.bak", ".4021.lock", "a4021.lock", "4021.LOCK", "4021", "123456.lock", "-1.lock", "4021.tmp"])
    expect(IdeLock.port(name)).toBeUndefined()
})

test("the lock folder is ide in the state folder, and a lock is named after its port", () => {
  expect(path.basename(IdeLock.directory())).toBe("ide")
  expect(IdeLock.file("/state/ide", 4021)).toBe(path.join("/state/ide", "4021.lock"))
})
