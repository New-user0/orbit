import path from "path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@orbit/core/config"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Document, Info, type Entry, type Scope } from "@orbit/schema/config"

const repo = path.resolve("/experimental-fixture/repo")
const place = { roots: [repo], directory: repo }
const decode = Schema.decodeUnknownSync(Info)
const document = (scope: Scope, experimental: unknown) =>
  new Document({
    type: "document",
    path: AbsolutePath.make(path.join(repo, "orbit.json")),
    scope,
    info: decode({ experimental }),
  })

describe("Config.experimental", () => {
  const keys = ["allow_local_fetch", "portable_shell_scanner", "subagent_depth"] as const
  const person = { allow_local_fetch: true, portable_shell_scanner: true, subagent_depth: 3 }
  const project = { allow_local_fetch: false, portable_shell_scanner: false, subagent_depth: 2 }

  test.each(keys)("%s: a later block that does not set it leaves the earlier value", (key) => {
    const others = Object.fromEntries(Object.entries(project).filter(([name]) => name !== key))
    expect(Config.experimental([document("user", person), document("project", others)], key)).toBe(person[key])
  })

  test.each(keys)("%s: a later block that sets it wins", (key) => {
    const entries: Entry[] = [document("user", person), document("project", project)]
    expect(Config.experimental(entries, key)).toBe(project[key])
  })

  test.each(keys)("%s: an untrusted project leaves the person's value, and nothing sets it alone", (key) => {
    const untrusted = ConfigTrust.stamp(document("project", { ...project, subagent_depth: 5 }), place)
    expect(Config.experimental([document("user", person), untrusted], key)).toBe(person[key])
    expect(Config.experimental([untrusted], key)).toBeUndefined()
  })
})
