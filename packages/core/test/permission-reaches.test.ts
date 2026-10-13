// `reaches` decides a shell wildcard that could not be expanded: a deny rule counts when it could match a file below the
// folder the wildcard starts in. It errs towards yes (class 8, the shell-paths round).
import { describe, expect, test } from "bun:test"
import { Permission } from "@orbit/core/permission"

describe("Permission.reaches", () => {
  // [folder, rule resource, whether the rule could match a file below the folder]
  const rows: [string, string, boolean][] = [
    ["/p", "/p/secret.txt", true],
    ["/p", "/p/sub/secret.txt", true],
    ["/p/sub", "/p/secret.txt", false],
    ["/p/sub", "/p/**", true],
    ["/p/sub", "/p/s*/x", true],
    ["/p/sub", "/p/t*/x", false],
    ["/p", "/other/**", false],
    ["/p", "/pp/x", false],
    ["/p/", "/p/x", true],
    ["/p", "**/.env", true],
    ["/p", ".env", true],
    ["/p", "~/x", true],
    ["/p", "*", true],
    ["/P/Sub", "/p/sub/x", true],
    ["C:/p", "c:/P/x", true],
    ["C:\\p", "C:\\other\\x", false],
    ["C:\\p\\sub", "C:/p/*", true],
  ]
  test.each(rows)("%s against %s", (folder, rule, expected) => {
    expect(Permission.reaches(folder, rule)).toBe(expected)
  })
})
