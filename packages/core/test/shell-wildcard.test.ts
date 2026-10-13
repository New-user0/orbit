// The wildcard expander on its own (class 7, class 8): the bracket classes bash knows, case folding that stays a superset,
// `***` in zsh, and the work caps that must hold however a word repeats its recursion.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Wildcard } from "@orbit/core/shell/wildcard"

const budget = () => ({ entries: 50_000, until: Date.now() + 3_000 })
const options = (extra: Partial<Wildcard.Options> = {}) => ({ dot: false, globstar: false, limit: 500, budget: budget(), ...extra })

const folder = async (files: string[]) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wildcard-"))
  await Promise.all(files.map((file) => fs.writeFile(path.join(dir, file), "x")))
  return dir
}

describe("a bracket class", () => {
  // [word, names it must reach]
  const rows: [string, string[]][] = [
    ["[[:graph:]]*", ["secret.txt", "Zeta.txt"]],
    ["[[:word:]]*", ["secret.txt", "Zeta.txt"]],
    ["[[:ascii:]]*", ["secret.txt", "Zeta.txt"]],
    ["[[:print:]]*", ["secret.txt", "Zeta.txt"]],
    ["[[:alnum:]]*", ["secret.txt", "Zeta.txt"]],
    ["[[:upper:]]*", ["Zeta.txt"]],
    ["[[:upper:]]eta.txt", ["Zeta.txt"]],
    ["[[:lower:]]ecret.txt", ["secret.txt"]],
    ["[[=s=]]ecret.txt", ["secret.txt"]],
    ["[[.s.]]ecret.txt", ["secret.txt"]],
    ["[!z]*", ["secret.txt", "Zeta.txt"]],
    ["[^z]*", ["secret.txt", "Zeta.txt"]],
    ["[A-z]eta.txt", ["Zeta.txt"]],
    ["Z*", ["Zeta.txt"]],
  ]
  for (const [word, names] of rows)
    test(`${word} reaches ${names.join(", ")}`, async () => {
      const dir = await folder(["secret.txt", "Zeta.txt", "other.md"])
      const found = (await Wildcard.expand(dir, word, options()))?.map((item) => path.basename(item))
      expect(found).toBeDefined()
      for (const name of names) expect(found).toContain(name)
    })

  test("a control that matches nothing reaches nothing", async () => {
    const dir = await folder(["secret.txt", "Zeta.txt"])
    expect(await Wildcard.expand(dir, "Q*", options())).toEqual([])
    expect(await Wildcard.expand(dir, "[[:digit:]]*", options())).toEqual([])
  })

  // A form the matcher does not know leaves the word undecided and is never read as literal characters.
  for (const word of ["[[:nope:]]*", "[[=ss=]]*", "[[.ab.]]*"])
    test(`${word} is undecided`, async () => {
      const dir = await folder(["secret.txt"])
      expect(await Wildcard.expand(dir, word, options())).toBeUndefined()
    })
})

describe("zsh stars", () => {
  const tree = async () => {
    const dir = await folder([])
    await fs.mkdir(path.join(dir, "src", "a", "b"), { recursive: true })
    await fs.writeFile(path.join(dir, "src", "a", "b", "n.ts"), "n")
    return dir
  }
  // [word, options, whether src/a/b/n.ts is reached]
  const rows: [string, Partial<Wildcard.Options>, boolean][] = [
    ["***/n.ts", { globstar: true, follow: true }, true],
    ["src/***/n.ts", { globstar: true, follow: true }, true],
    ["***/n.ts", { globstar: true }, false],
    ["src/***/n.ts", {}, false],
    ["**/n.ts", { globstar: true }, true],
  ]
  for (const [word, extra, reached] of rows)
    test(`${word} ${JSON.stringify(extra)} ${reached ? "reaches" : "does not reach"} n.ts`, async () => {
      const dir = await tree()
      const found = await Wildcard.expand(dir, word, options(extra))
      expect(found?.some((item) => item.endsWith("n.ts"))).toBe(reached)
    })

  test("a link met while `***` recurses leaves the word undecided, and `**` does not enter it", async () => {
    const dir = await tree()
    await fs.symlink(path.join(dir, "src"), path.join(dir, "link"), "junction")
    expect(await Wildcard.expand(dir, "***/n.ts", options({ globstar: true, follow: true }))).toBeUndefined()
    expect(await Wildcard.expand(dir, "**/n.ts", options({ globstar: true }))).toBeDefined()
  })
})

describe("the work caps", () => {
  const chain = async (depth: number) => {
    const dir = await folder([])
    await fs.mkdir(path.join(dir, ...Array.from({ length: depth }, () => "d")), { recursive: true })
    return dir
  }

  test("a run of recursive segments over a deep chain is decided at once", async () => {
    const dir = await chain(30)
    const spent = budget()
    const started = Date.now()
    const found = await Wildcard.expand(dir, "**/**/**/**/**/**/**/**/zz", options({ globstar: true, budget: spent }))
    expect(found).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
    // One recursion listing and one `zz` listing per folder, one entry each (30 of them): not a multiple per extra `**`.
    expect(50_000 - spent.entries).toBeLessThanOrEqual(60)
  }, 10_000)

  test("a cached listing is charged again when it is visited again", async () => {
    const dir = await folder(["a", "b", "c", "d"])
    await fs.mkdir(path.join(dir, "x1"))
    // The folder holds five names. `[x]*` lists it, `..` steps back to it and the last `*` lists it again from the cache.
    const word = "[x]*/../*"
    const once = { entries: 50_000, until: Date.now() + 3_000 }
    await Wildcard.expand(dir, word, options({ budget: once }))
    expect(50_000 - once.entries).toBe(10)
    const small = { entries: 7, until: Date.now() + 3_000 }
    expect(await Wildcard.expand(dir, word, options({ budget: small }))).toBeUndefined()
  })

  test("the deadline is read inside a long listing", async () => {
    const dir = await folder(Array.from({ length: 600 }, (_, index) => `f${index}`))
    let reads = 0
    // The read before the listing is in time; every later one, inside the entry loop, is past.
    const timed = {
      entries: 50_000,
      get until() {
        return reads++ === 0 ? Number.MAX_SAFE_INTEGER : 0
      },
    }
    expect(await Wildcard.expand(dir, "*", options({ budget: timed }))).toBeUndefined()
  })

  test("the entries cap decides a listing that is too large", async () => {
    const dir = await folder(Array.from({ length: 50 }, (_, index) => `f${index}`))
    expect(await Wildcard.expand(dir, "*", options({ budget: { entries: 49, until: Date.now() + 3_000 } }))).toBeUndefined()
    expect(await Wildcard.expand(dir, "*", options({ budget: { entries: 50, until: Date.now() + 3_000 } }))).toHaveLength(50)
  })
})
