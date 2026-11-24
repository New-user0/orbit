import { describe, expect, test } from "bun:test"
import { Flock } from "@orbit/util/flock"

function failure(code: string) {
  return Object.assign(new Error(code), { code })
}

describe("Flock.gone", () => {
  test("a missing file or folder is gone", () => {
    expect(Flock.gone(failure("ENOENT"))).toBe(true)
    expect(Flock.gone(failure("ENOTDIR"))).toBe(true)
  })

  // Windows CI met this while one holder released a lock and another checked whether it was stale:
  // stat on the meta.json being deleted threw EPERM, and withLock failed.
  test("on Windows a file whose deletion is pending (EPERM) is gone, and elsewhere EPERM stays an error", () => {
    expect(Flock.gone(failure("EPERM"))).toBe(process.platform === "win32")
  })

  test("a permission error, another error and a value without a code are not", () => {
    expect(Flock.gone(failure("EACCES"))).toBe(false)
    expect(Flock.gone(new Error("boom"))).toBe(false)
    expect(Flock.gone(undefined)).toBe(false)
  })
})
