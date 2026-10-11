import path from "path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Directory, Document, Info } from "@orbit/schema/config"

const repo = path.resolve("/trust-fixture/repo")
const place = { roots: [repo], directory: repo }
const decode = Schema.decodeUnknownSync(Info)

describe("ConfigTrust.sanitize with only", () => {
  const hook = { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] }

  test("takes out the fields of the kinds named and keeps everything else as written", () => {
    const info = decode({
      hooks: hook,
      mcp: { servers: {} },
      shell: "bash",
      model: "acme/big",
      websearch: { provider: "random" },
      permissions: [{ action: "shell", resource: "*", effect: "allow" }],
      commands: { a: { template: "!`one`" } },
    })
    const result = ConfigTrust.sanitize(info, place, ["hooks"])
    expect(result.withheld).toEqual(["hooks"])
    expect(result.info.hooks).toBeUndefined()
    // Nothing else is touched: a folder that was trusted stays trusted for the rest.
    expect(result.info.mcp).toEqual(info.mcp)
    expect(result.info.shell).toBe("bash")
    expect(result.info.websearch).toEqual({ provider: "random" })
    expect(result.info.permissions).toEqual(info.permissions)
    expect(result.info.commands).toEqual(info.commands)
  })

  test("is the same document when none of its fields is of a kind named", () => {
    const info = decode({ shell: "bash" })
    const result = ConfigTrust.sanitize(info, place, ["hooks", "mcp"])
    expect(result.info).toBe(info)
    expect(result.withheld).toEqual([])
  })

  test("files the skills field under skills, which an untrusted folder still withholds whole", () => {
    expect(ConfigTrust.sanitize(decode({ skills: ["./s"] }), place, ["skills"]).info.skills).toBeUndefined()
    expect(ConfigTrust.sanitize(decode({ skills: ["./s"] }), place).withheld).toEqual(["skills"])
  })
})

describe("ConfigTrust.partial", () => {
  const document = (info: unknown, scope: "project" | "local" | "user" = "project") =>
    new Document({ type: "document", path: AbsolutePath.make(path.join(repo, "orbit.json")), scope, info: decode(info) })

  test("takes the kinds out of a document without calling it untrusted", () => {
    const entry = ConfigTrust.partial(document({ shell: "bash", env: { A: "1" } }), place, ["shell"])
    expect(entry).toMatchObject({ withheld: ["shell"] })
    expect(entry.type === "document" && entry.info.shell).toBeUndefined()
    expect(entry.type === "document" && entry.info.env).toEqual({ A: "1" })
    expect(entry.trusted).toBeUndefined()
  })

  test("lists the kinds a directory holds back, in the order of Trust.Kinds", () => {
    const orbit = new Directory({ type: "directory", path: AbsolutePath.make(path.join(repo, ".orbit")), scope: "project" })
    expect(ConfigTrust.partial(orbit, place, ["plugins", "hooks"])).toMatchObject({ withheld: ["hooks", "plugins"] })
  })

  test("leaves an entry that is not a project's or local, or has nothing to hold back, as it is", () => {
    const user = document({ shell: "bash" }, "user")
    expect(ConfigTrust.partial(user, place, ["shell"])).toBe(user)
    const project = document({ shell: "bash" })
    expect(ConfigTrust.partial(project, place, [])).toBe(project)
  })
})

describe("ConfigTrust.allows with a kind", () => {
  const base = path.resolve("/trust-fixture")
  const file = (...parts: string[]) => path.join(base, ...parts)
  const context = { roots: [file("repo")], trusted: true, compat: [] }
  const orbit = (withheld?: Directory["withheld"]) =>
    new Directory({
      type: "directory",
      path: AbsolutePath.make(file("repo", ".orbit")),
      scope: "project",
      ...(withheld === undefined ? {} : { withheld }),
    })

  test("refuses the files of a directory that holds back that kind, and only theirs", () => {
    const entries = [orbit(["hooks"])]
    const skill = file("repo", ".orbit", "skills", "x", "SKILL.md")
    expect(ConfigTrust.allows(entries, skill, context, "hooks")).toBe(false)
    // Another kind, and no kind at all, are the folder's decision, which is trusted.
    expect(ConfigTrust.allows(entries, skill, context, "mcp")).toBe(true)
    expect(ConfigTrust.allows(entries, skill, context)).toBe(true)
    expect(ConfigTrust.allows(entries, file("repo", "src", "a.md"), context, "hooks")).toBe(true)
  })

  test("takes the verdict of the caller over the stamp of the entry", () => {
    const stamped = new Directory({
      type: "directory",
      path: AbsolutePath.make(file("repo", "pkg", ".orbit")),
      scope: "project",
    })
    const inside = file("repo", "pkg", ".orbit", "skills", "x", "SKILL.md")
    const revoked = { ...context, trusted: false, verdicts: new Map([[stamped, { trusted: false, withheld: [] }]]) }
    // The stamp is the last load's: it says trusted although the project is not, and it is the nearest cover.
    expect(ConfigTrust.allows([stamped], inside, { ...context, trusted: false })).toBe(true)
    // The caller knows better.
    expect(ConfigTrust.allows([stamped], inside, revoked)).toBe(false)
    const granted = { ...context, verdicts: new Map([[stamped, { trusted: true, withheld: [] }]]) }
    expect(ConfigTrust.allows([stamped], inside, granted)).toBe(true)
    expect(
      ConfigTrust.allows([stamped], inside, { ...context, verdicts: new Map([[stamped, { trusted: true, withheld: ["hooks"] }]]) }, "hooks"),
    ).toBe(false)
  })
})

describe("ConfigTrust.reach", () => {
  const drive = path.parse(path.resolve("/")).root
  const rows = [
    // A holder that is a folder of a project is reached whole.
    { name: "a persistent holder", holder: path.join(drive, "work"), container: path.join(drive, "work", ".orbit"), persistent: true, reaches: [path.join(drive, "work")] },
    // A filesystem root, the home directory and a share root hold the whole drive: the container alone is reached.
    { name: "a filesystem root", holder: drive, container: path.join(drive, ".orbit"), persistent: false, reaches: [path.join(drive, ".orbit")] },
    { name: "the home directory", holder: path.join(drive, "home"), container: path.join(drive, "home", ".orbit"), persistent: false, reaches: [path.join(drive, "home", ".orbit")] },
    // Config that sits directly in the holder has no container at all, and reaches nothing.
    { name: "a document directly in a filesystem root", holder: drive, container: drive, persistent: false, reaches: [] },
    { name: "a document directly in the home directory", holder: path.join(drive, "home"), container: path.join(drive, "home"), persistent: false, reaches: [] },
  ]
  for (const row of rows) {
    test(`for ${row.name}`, () => {
      expect(ConfigTrust.reach(row)).toEqual(row.reaches)
    })
  }
})
