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
      withheld: [
        { path: "/repo/orbit.json", kinds: ["hooks", "mcp"] },
        // A file above the project names the folder whose trust lifts it.
        { path: "/work/.orbit", kinds: ["plugins"], directory: "/work" },
      ],
    }
    expect<unknown>(encode(decode(untrusted))).toEqual(untrusted)
    expect(encode(decode(untrusted))).not.toHaveProperty("source")
    expect(encode(decode(untrusted)).withheld[0]).not.toHaveProperty("directory")
    for (const source of ["saved", "session", "implicit"] as const) {
      const trusted = { directory: "/repo", trusted: true, persistent: source === "saved", source, withheld: [] }
      expect<unknown>(encode(decode(trusted))).toEqual(trusted)
    }
    expect(() => decode({ ...untrusted, source: "remembered" })).toThrow()
    expect(() => decode({ ...untrusted, withheld: [{ path: "/repo/orbit.json", kinds: ["environment"] }] })).toThrow()
  })

  test("round-trips what changed since the grant, and a status from a server that sends no such list", () => {
    const encode = Schema.encodeSync(Trust.Status)
    const decode = Schema.decodeUnknownSync(Trust.Status)
    const changed = {
      directory: "/repo",
      trusted: true,
      persistent: true,
      source: "saved",
      withheld: [
        { path: "/repo/orbit.json", kinds: ["hooks"] },
        // A holder that can never be trusted for good says so.
        { path: "/orbit.json", kinds: ["hooks"], directory: "/", persistent: false },
      ],
      changed: [{ path: "/repo/orbit.json", kinds: ["hooks", "skills"] }],
    }
    expect<unknown>(encode(decode(changed))).toEqual(changed)
    const { changed: _, ...older } = changed
    expect(encode(decode(older))).not.toHaveProperty("changed")
    expect(() => decode({ ...changed, changed: [{ path: "/repo/orbit.json", kinds: ["environment"] }] })).toThrow()
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
