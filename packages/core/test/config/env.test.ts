import { describe, expect, test } from "bun:test"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { AbsolutePath } from "@orbit/schema/schema"
import { Environment } from "@orbit/util/environment"
import { ConfigEnv } from "@orbit/core/config/env"
import { ConfigNormalize } from "@orbit/core/config/normalize"

const document = (scope: Document["scope"], env?: Record<string, string>) =>
  new Document({ type: "document", scope, info: new Info(env === undefined ? {} : { env }) })

describe("ConfigEnv.resolve", () => {
  test("folds name by name, lowest scope first, and the managed document wins", () => {
    const entries: Entry[] = [
      document("remote", { A: "remote", ONLY_REMOTE: "r" }),
      document("user", { A: "user", B: "user", ONLY_USER: "u" }),
      document("project", { B: "project", C: "project" }),
      document("local", { C: "local" }),
      document("project"),
      document("local", {}),
      document("managed", { A: "managed", C: "managed" }),
    ]
    expect(ConfigEnv.resolve(entries, "linux")).toEqual({
      A: "managed",
      B: "project",
      C: "managed",
      ONLY_REMOTE: "r",
      ONLY_USER: "u",
    })
  })

  test("ignores a directory entry", () => {
    const directory: Entry = { type: "directory", path: AbsolutePath.make(process.cwd()), scope: "project", trusted: true }
    expect(ConfigEnv.resolve([directory, document("user", { A: "1" })], "linux")).toEqual({ A: "1" })
  })

  test("on win32 a later spelling replaces an earlier one, elsewhere both stay", () => {
    const entries = [document("user", { Path: "a" }), document("project", { PATH: "b" })]
    expect(ConfigEnv.resolve(entries, "win32")).toEqual({ PATH: "b" })
    expect(ConfigEnv.resolve(entries, "linux")).toEqual({ Path: "a", PATH: "b" })
  })

  test("on win32 the later key of one document wins", () => {
    expect(ConfigEnv.resolve([document("user", { Path: "a", PATH: "b" })], "win32")).toEqual({ PATH: "b" })
  })

  for (const platform of ["win32", "linux"] as const) {
    test(`never carries the reserved lookup variable in any spelling (${platform})`, () => {
      const entries = [
        document("user", {
          NoDefaultCurrentDirectoryInExePath: "",
          nodefaultcurrentdirectoryinexepath: "0",
          KEEP: "1",
        }),
      ]
      expect(ConfigEnv.resolve(entries, platform)).toEqual({ KEEP: "1" })
    })
  }
})

describe("ConfigEnv.applyTo", () => {
  test("writes only into the record it is given", () => {
    const before = JSON.stringify(process.env)
    const target: Record<string, string | undefined> = { KEEP: "1" }
    ConfigEnv.applyTo(target, { ZZ_ENV_TEST: "2" })
    expect(target).toEqual({ KEEP: "1", ZZ_ENV_TEST: "2" })
    expect(JSON.stringify(process.env)).toBe(before)
  })

  test("on win32 removes every other spelling of a name it writes", () => {
    expect(ConfigEnv.applyTo({ Path: "inherited", Other: "x" }, { PATH: "config" }, "win32")).toEqual({
      Other: "x",
      PATH: "config",
    })
    expect(ConfigEnv.applyTo({ Path: "inherited" }, { PATH: "config" }, "linux")).toEqual({
      Path: "inherited",
      PATH: "config",
    })
  })

  test("keeps __proto__ as a variable", () => {
    const target = Environment.assign({}, JSON.parse('{"__proto__": "x"}'), "linux")
    expect(Object.keys(target)).toEqual(["__proto__"])
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
  })
})

describe("env decoding", () => {
  const normalize = (env: unknown) => {
    const result = ConfigNormalize.normalize({ env })
    if (result.type !== "normalized") throw new Error("rejected")
    return result
  }

  test("one bad entry costs only itself", () => {
    const result = normalize({
      A: "1",
      "": "x",
      "B=C": "y",
      D: "a\0b",
      E: { x: 1 },
      F: 2,
      G: true,
      H: null,
      I: [1],
      J: Number.NaN,
      NoDefaultCurrentDirectoryInExePath: "",
    })
    expect(result.encoded.env).toEqual({ A: "1", F: "2", G: "true" })
    expect(result.diagnostics.map((item) => item.path.join("."))).toEqual([
      "env.",
      "env.B=C",
      "env.D",
      "env.E",
      "env.H",
      "env.I",
      "env.J",
      "env.NoDefaultCurrentDirectoryInExePath",
    ])
  })

  test("keeps the document's key order", () => {
    expect(Object.keys(normalize({ Path: "a", B: "b", PATH: "c" }).encoded.env as object)).toEqual(["Path", "B", "PATH"])
  })

  for (const value of ["x", 1, null, ["A"]]) {
    test(`a ${JSON.stringify(value)} value is one diagnostic and no env`, () => {
      const result = normalize(value)
      expect(result.encoded).not.toHaveProperty("env")
      expect(result.diagnostics).toEqual([
        { kind: "invalid", path: ["env"], message: "skipped malformed recognized value" },
      ])
    })
  }
})

// Class 8: Orbit's own control variables keep the value the parent process has, in every scope and spelling, so a
// nested `orb` reads the same managed folder and trust decision. Without the reserved names each row resolves a value.
describe("Orbit's own control variables", () => {
  const names = [
    "ORBIT_MANAGED_DIR",
    "ORBIT_TRUST_PROJECT",
    "ORBIT_CONFIG",
    "ORBIT_CONFIG_DIR",
    "ORBIT_CONFIG_CONTENT",
    "ORBIT_CONFIG_CONTENT_FILE",
    "ORBIT_PASSWORD",
  ]
  const spellings = names.flatMap((name) => [name, name.toLowerCase(), name.replace("ORBIT", "Orbit")])
  const scopes: Document["scope"][] = ["remote", "user", "project", "local", "flag", "managed"]

  scopes.forEach((scope) =>
    test(`resolve drops every spelling from a ${scope} document, keeping its other variables`, () => {
      const env = Object.fromEntries([...spellings.map((name) => [name, "/elsewhere"]), ["ORBIT_OTHER", "kept"]])
      expect(ConfigEnv.resolve([document(scope, env)], "linux")).toEqual({ ORBIT_OTHER: "kept" })
      expect(ConfigEnv.resolve([document(scope, env)], "win32")).toEqual({ ORBIT_OTHER: "kept" })
    }),
  )

  test("decoding reports each one once, at its own path, and keeps the siblings", () => {
    const result = ConfigNormalize.normalize({
      env: { ...Object.fromEntries(spellings.map((name) => [name, "x"])), KEEP: "1" },
    })
    if (result.type !== "normalized") throw new Error("rejected")
    expect(result.encoded.env).toEqual({ KEEP: "1" })
    expect(result.diagnostics.map((item) => item.path.join("."))).toEqual(spellings.map((name) => `env.${name}`))
    expect(new Set(result.diagnostics.map((item) => item.kind))).toEqual(new Set(["unsupported"]))
  })
})
