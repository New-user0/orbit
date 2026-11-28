import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"
import { AbsolutePath } from "../src/schema.js"
import { Trust } from "../src/trust.js"

describe("Trust", () => {
  test("names the kinds of withheld config once each, with a stable identifier", () => {
    expect([...Trust.Kinds]).toEqual([
      "hooks",
      "mcp",
      "plugins",
      "commands",
      "permissions",
      "providers",
      "shell",
      "env",
      "formatter",
      "lsp",
      "sandbox",
      "skills",
      "network",
      "settings",
    ])
    expect(new Set(Trust.Kinds).size).toBe(Trust.Kinds.length)
    for (const kind of Trust.Kinds) expect(Schema.decodeUnknownSync(Trust.Kind)(kind)).toBe(kind)
    expect(() => Schema.decodeUnknownSync(Trust.Kind)("environment")).toThrow()
    expect(Trust.Kind.ast.annotations?.identifier).toBe("Trust.Kind")
  })

  test("round-trips a status with and without a source", () => {
    const encode = Schema.encodeSync(Trust.Status)
    const decode = Schema.decodeUnknownSync(Trust.Status)
    const untrusted = {
      directory: "/repo",
      trusted: false,
      persistent: true,
      withheld: [{ path: "/repo/orbit.json", kinds: ["hooks", "mcp"] }],
    }
    expect<unknown>(encode(decode(untrusted))).toEqual(untrusted)
    expect(encode(decode(untrusted))).not.toHaveProperty("source")
    for (const source of ["saved", "session", "implicit"] as const) {
      const trusted = { directory: "/repo", trusted: true, persistent: source === "saved", source, withheld: [] }
      expect<unknown>(encode(decode(trusted))).toEqual(trusted)
    }
    expect(() => decode({ ...untrusted, source: "remembered" })).toThrow()
    expect(() => decode({ ...untrusted, withheld: [{ path: "/repo/orbit.json", kinds: ["environment"] }] })).toThrow()
  })

  // E7 of trust-first part 2: a server older than this change still sends what changed since the grant and the folder
  // above the project that holds an entry. Both decode, and neither is kept: nothing reads them any more.
  test("decodes a status from an older server that lists changes and folders above the project, and drops both", () => {
    const encode = Schema.encodeSync(Trust.Status)
    const decode = Schema.decodeUnknownSync(Trust.Status)
    const older = {
      directory: "/repo",
      trusted: true,
      persistent: true,
      source: "saved",
      withheld: [
        { path: "/repo/orbit.json", kinds: ["hooks"] },
        { path: "/orbit.json", kinds: ["hooks"], directory: "/", persistent: false },
      ],
      changed: [{ path: "/repo/orbit.json", kinds: ["hooks", "skills"] }],
    }
    const decoded = encode(decode(older))
    expect(decoded).not.toHaveProperty("changed")
    expect(decoded.withheld).toEqual([
      { path: "/repo/orbit.json", kinds: ["hooks"] },
      { path: "/orbit.json", kinds: ["hooks"] },
    ])
  })

  test("round-trips a grant and rejects a negative time", () => {
    const grant = { directory: "/repo", time: 1_700_000_000_000, via: "terminal" }
    expect<unknown>(Schema.encodeSync(Trust.Grant)(Schema.decodeUnknownSync(Trust.Grant)(grant))).toEqual(grant)
    expect(() => Schema.decodeUnknownSync(Trust.Grant)({ ...grant, time: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Trust.Grant)({ directory: "/repo", time: 1 })).toThrow()
  })
})

describe("Config entries of an untrusted folder", () => {
  test("round-trip the stamp and the kinds a document lost", () => {
    const entries = [
      new Config.Document({
        type: "document",
        path: AbsolutePath.make("/repo/orbit.json"),
        scope: "project",
        trusted: false,
        withheld: ["hooks", "sandbox"],
        info: new Config.Info({ shell: undefined }),
      }),
      new Config.Document({
        type: "document",
        scope: "project",
        trusted: false,
        withheld: [],
        info: new Config.Info({}),
      }),
      new Config.Directory({
        type: "directory",
        path: AbsolutePath.make("/repo/.orbit"),
        scope: "project",
        trusted: false,
      }),
    ]
    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(entries)
    const decoded = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(encoded)

    expect(encoded.map((entry) => entry.trusted)).toEqual([false, false, false])
    expect(encoded[0]).toMatchObject({ withheld: ["hooks", "sandbox"] })
    expect(decoded).toEqual(entries)
    expect(decoded[0]).toBeInstanceOf(Config.Document)
    expect(decoded[2]).toBeInstanceOf(Config.Directory)
  })

  test("omit the stamp when an entry is not subject to trust", () => {
    const encoded = Schema.encodeSync(Config.Entry)(
      new Config.Document({ type: "document", scope: "user", info: new Config.Info({}) }),
    )
    expect(encoded).not.toHaveProperty("trusted")
    expect(encoded).not.toHaveProperty("withheld")
    expect(
      Schema.encodeSync(Config.Entry)(new Config.Directory({ type: "directory", path: AbsolutePath.make("/x") })),
    ).not.toHaveProperty("trusted")
    // Entries written before trust existed still decode, with nothing stamped.
    const decoded = Schema.decodeUnknownSync(Config.Entry)({ type: "document", scope: "project", info: {} })
    expect(decoded).not.toHaveProperty("trusted")
  })

  test("reject a kind that does not exist", () => {
    const decode = Schema.decodeUnknownSync(Config.Entry)
    expect(() => decode({ type: "document", info: {}, trusted: false, withheld: ["environment"] })).toThrow()
    expect(() => decode({ type: "document", info: {}, trusted: "no" })).toThrow()
    expect(() => decode({ type: "directory", path: "/x", trusted: "no" })).toThrow()
  })
})
