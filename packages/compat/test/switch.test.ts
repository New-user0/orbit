import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Directory, Document, Info, type Entry, type Scope } from "@orbit/schema/config"
import { AbsolutePath } from "@orbit/schema/schema"
import { CompatSwitch } from "../src/switch.js"

const decode = Schema.decodeUnknownSync(Info)
// A document from the given scope, with `compatibility.enabled` set or, when omitted, left out. A missing scope is the
// case of entries produced before scopes existed.
const document = (scope: Scope | undefined, enabled?: boolean) =>
  new Document({
    type: "document",
    ...(scope === undefined ? {} : { scope }),
    info: decode(enabled === undefined ? {} : { compatibility: { enabled } }),
  })
const on = (scope?: Scope) => document(scope, true)
const off = (scope?: Scope) => document(scope, false)
const enabled = (entries: readonly Entry[], env: Record<string, string | undefined> = {}) =>
  CompatSwitch.enabled(entries, env)

describe("CompatSwitch.enabled", () => {
  test("is on unless something that may turn it off says so", () => {
    expect(enabled([])).toBe(true)
    expect(enabled([document("user"), document("flag")])).toBe(true)
    expect(enabled([on("user")])).toBe(true)
  })

  for (const scope of ["user", "flag", "managed"] as const)
    test(`compatibility.enabled: false at ${scope} scope turns it off`, () => {
      expect(enabled([off(scope)])).toBe(false)
    })

  test("counts an entry without a scope as user", () => {
    expect(enabled([off(undefined)])).toBe(false)
  })

  for (const scope of ["project", "local", "remote"] as const)
    test(`ignores the same key at ${scope} scope`, () => {
      expect(enabled([off(scope)])).toBe(true)
    })

  test("lets a repository neither turn it back on nor off after the user decided", () => {
    expect(enabled([off("user"), on("project"), on("local"), on("remote")])).toBe(false)
    expect(enabled([on("user"), off("project"), off("local")])).toBe(true)
  })

  test("takes the latest of the user, flag and managed documents", () => {
    expect(enabled([off("user"), on("flag")])).toBe(true)
    expect(enabled([on("user"), off("flag"), on("managed")])).toBe(true)
    expect(enabled([off("user"), on("flag"), off("managed")])).toBe(false)
    // Entries arrive from lowest to highest priority, so a project document between two others changes nothing.
    expect(enabled([off("user"), on("project"), document("user")])).toBe(false)
  })

  test("passes over documents that do not set the key and entries that are not documents", () => {
    const directory = new Directory({ type: "directory", scope: "managed", path: AbsolutePath.make("/org") })
    expect(enabled([off("user"), document("flag"), directory])).toBe(false)
  })

  test("is forced off by ORBIT_DISABLE_COMPAT=1 whatever the documents say", () => {
    const everywhere = [on("user"), on("flag"), on("managed")]
    expect(enabled(everywhere, { ORBIT_DISABLE_COMPAT: "1" })).toBe(false)
    expect(enabled([], { ORBIT_DISABLE_COMPAT: "1" })).toBe(false)
    for (const value of [undefined, "", "0", "false"])
      expect(enabled(everywhere, { ORBIT_DISABLE_COMPAT: value })).toBe(true)
  })
})
