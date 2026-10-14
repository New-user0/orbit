import { describe, expect, test } from "bun:test"
import path from "path"
import { PluginRestriction } from "../src/restriction"

const verdict = (restrictions: PluginRestriction.Restrictions, subject: PluginRestriction.Subject) => {
  const result = PluginRestriction.check(restrictions, subject)
  return result.allowed ? "allowed" : result.reason
}

describe("PluginRestriction.check", () => {
  test("a selector is *, prefix.* or exact", () => {
    expect(verdict({ block: ["*"] }, { target: "anything" })).toBe("blocked")
    expect(verdict({ block: ["acme.*"] }, { id: "acme.tools" })).toBe("blocked")
    expect(verdict({ block: ["acme.*"] }, { id: "acmex" })).toBe("allowed")
    expect(verdict({ block: ["acme.*"] }, { id: "acme" })).toBe("allowed")
    expect(verdict({ block: ["@corp/x"] }, { target: "@corp/x" })).toBe("blocked")
    expect(verdict({ block: ["@corp/x"] }, { target: "@corp/xy" })).toBe("allowed")
  })

  test("block wins over allow, and an empty block does nothing", () => {
    expect(verdict({ allow: ["@corp/x"], block: ["@corp/x"] }, { target: "@corp/x" })).toBe("blocked")
    expect(verdict({ block: [] }, { target: "@corp/x" })).toBe("allowed")
  })

  test("no allow list allows, an empty one allows no external plugin, otherwise a target must match", () => {
    expect(verdict({}, { target: "@corp/x" })).toBe("allowed")
    expect(verdict({ allow: [] }, { target: "@corp/x" })).toBe("not_allowed")
    expect(verdict({ allow: ["@corp/x"] }, { target: "@corp/x" })).toBe("allowed")
    expect(verdict({ allow: ["@corp/x"] }, { target: "@corp/y" })).toBe("not_allowed")
    expect(verdict({ allow: ["@corp.*"] }, { target: "@corp.tools" })).toBe("allowed")
  })

  test("an ID is checked against block only", () => {
    expect(verdict({ allow: [] }, { id: "acme.tools" })).toBe("allowed")
    expect(verdict({ allow: ["other"], block: ["acme.tools"] }, { id: "acme.tools" })).toBe("blocked")
  })

  test("a target whose package cannot be named is not allowed while an allow list is set, but can be blocked as written", () => {
    expect(verdict({ allow: ["foo"] }, { target: "foo", verified: false })).toBe("not_allowed")
    expect(verdict({}, { target: "git+https://host/x.git", verified: false })).toBe("allowed")
    expect(verdict({ block: ["git+https://host/x.git"] }, { target: "git+https://host/x.git", verified: false })).toBe(
      "blocked",
    )
  })

  test("paths compare as paths: normalized, absolute with absolute, and case folds on Windows only", () => {
    const base = path.resolve("plugins", "one")
    expect(verdict({ block: [base] }, { target: base })).toBe("blocked")
    expect(verdict({ block: [base + path.sep] }, { target: base })).toBe("blocked")
    expect(verdict({ block: [base.replaceAll("\\", "/")] }, { target: base })).toBe("blocked")
    expect(verdict({ block: [base.toUpperCase()] }, { target: base })).toBe(process.platform === "win32" ? "blocked" : "allowed")
    // A relative selector never names a path, and a path selector never names a package.
    expect(verdict({ block: ["plugins/one"] }, { target: base })).toBe("allowed")
    expect(verdict({ block: [base] }, { target: "@corp/x" })).toBe("allowed")
    // A prefix is not a containment test: the selector names one folder only.
    expect(verdict({ block: [base] }, { target: path.join(base, "child") })).toBe("allowed")
    expect(verdict({ block: [base] }, { target: base + "-other" })).toBe("allowed")
    expect(verdict({ allow: [base] }, { target: path.join(base, "child") })).toBe("not_allowed")
    expect(verdict({ block: ["*"] }, { target: base })).toBe("blocked")
  })
})

describe("PluginRestriction.identify", () => {
  test("names a registry spec by its package, without the version", async () => {
    expect(await PluginRestriction.identify("@corp/x@^1.2")).toEqual({ target: "@corp/x", verified: true })
    expect(await PluginRestriction.identify("plain")).toEqual({ target: "plain", verified: true })
    expect(await PluginRestriction.identify("plain@1.0.0")).toEqual({ target: "plain", verified: true })
  })

  test("keeps the raw spec, unverified, for an alias, a git spec and a tarball", async () => {
    for (const spec of ["foo@npm:bar", "github:corp/repo", "git+https://host/x.git", "https://host/x.tgz"])
      expect(await PluginRestriction.identify(spec)).toEqual({ target: spec, verified: false })
  })

  test("keeps an absolute path as it is", async () => {
    const base = path.resolve("plugins", "one")
    expect(await PluginRestriction.identify(base)).toEqual({ target: base, verified: true })
  })

  test("fails closed under an allow list and can still be blocked as written", async () => {
    const alias = await PluginRestriction.identify("foo@npm:bar")
    expect(verdict({ allow: ["foo", "bar"] }, alias)).toBe("not_allowed")
    expect(verdict({}, alias)).toBe("allowed")
    expect(verdict({ block: ["foo@npm:bar"] }, alias)).toBe("blocked")
  })
})
