import { describe, expect, test } from "bun:test"
import { Wildcard } from "@orbit/core/shell/wildcard"

// The matcher is a superset of the shell (class 8): a class bound keeps its case, a name is tried in both case forms, a
// negated class matches when any form is outside it, and a name nobody knows matches any character (class 7).
describe("Wildcard.compile", () => {
  // [segment, name, matches, powershell]
  const rows: [string, string, boolean, boolean?][] = [
    ["[[:upper:]]oken.txt", "Token.txt", true],
    ["[A-z]key.txt", "_key.txt", true],
    ["[[:graph:]]ecret", "Secret", true],
    ["[[:blank:]]x", " x", true],
    ["[[:cntrl:]]x", "x", true],
    ["[[:word:]]x", "_x", true],
    ["[[:ascii:]]x", "ax", true],
    ["[[:digit:]]x", "ax", false],
    ["[!a]pple.txt", "Apple.txt", true],
    ["[^[:lower:]]ecret.txt", "Secret.txt", true],
    ["[!a-zA-Z]x", "ax", false],
    ["[[:constructor:]]x", "ax", true],
    ["[[:__proto__:]]x", "ax", true],
    ["[!x]", "!", true, true],
    ["[!x]", "x", true, true],
    ["[!x]", "a", false, true],
  ]
  for (const [segment, name, expected, powershell] of rows)
    test(`${segment} ${expected ? "matches" : "does not match"} ${JSON.stringify(name)}${powershell ? " (PowerShell)" : ""}`, () => {
      expect(Wildcard.compile(segment, true, powershell)(name)).toBe(expected)
    })
})
