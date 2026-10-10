import { describe, expect, test } from "bun:test"
import path from "path"
import { PluginRestriction } from "../src/restriction"

const verdict = (restrictions: PluginRestriction.Restrictions, subject: PluginRestriction.Subject) => {
  const result = PluginRestriction.check(restrictions, subject)
  return result.allowed ? "allowed" : result.reason
}

describe("scoped wildcards and real paths", () => {
  test("@scope/* matches every package in the scope and nothing outside it", () => {
    expect(verdict({ block: ["@corp/*"] }, { target: "@corp/x" })).toBe("blocked")
    expect(verdict({ block: ["@corp/*"] }, { target: "@corporate/x" })).toBe("allowed")
    expect(verdict({ allow: ["@corp/*"] }, { target: "@corp/x" })).toBe("allowed")
    expect(verdict({ allow: ["@corp/*"] }, { target: "@other/x" })).toBe("not_allowed")
  })

  test("only a whole * or a .* or /* suffix is a wildcard", () => {
    for (const selector of ["*", "acme.*", "@corp/*"]) expect(PluginRestriction.wildcard(selector)).toBe(true)
    for (const selector of ["@corp/*-tools", "a*b", "**", "@co*/x/*", "/opt/plugins/*", "C:/plugins/*", "C:\\plugins\\*", "\\\\host\\share\\*"])
      expect(PluginRestriction.wildcard(selector)).toBe(false)
  })

  test("real() resolves each absolute selector and leaves names alone", async () => {
    const link = path.resolve("link", "plugin")
    const target = path.resolve("target", "plugin")
    const real = await PluginRestriction.real({ allow: ["@corp/x", link], block: [link] }, async (file) =>
      file.replace(`${path.sep}link${path.sep}`, `${path.sep}target${path.sep}`),
    )
    expect(real).toEqual({ allow: ["@corp/x", target], block: [target] })
    expect(await PluginRestriction.real({}, async (file) => file)).toEqual({})
  })

  test("real() keeps a selector it cannot resolve as written, reports it once, and resolves the rest", async () => {
    const bad = path.resolve("bad", "plugin")
    const good = path.resolve("good", "plugin")
    const failed: string[] = []
    const real = await PluginRestriction.real(
      { block: [bad, good] },
      async (file) => {
        if (file === bad) throw new Error("ENOTDIR")
        return file + "-real"
      },
      (file) => failed.push(file),
    )
    expect(real).toEqual({ block: [bad, good + "-real"] })
    expect(failed).toEqual([bad])
  })
})
