import { describe, expect, test } from "bun:test"
import { McpRestriction } from "@orbit/core/mcp/restriction"
import { Mcp } from "@orbit/schema/mcp"

const local = (...command: string[]) => new Mcp.LocalConfig({ type: "local", command })
const remote = (url: string) => new Mcp.RemoteConfig({ type: "remote", url })
const verdict = (
  restrictions: Parameters<typeof McpRestriction.check>[0],
  name: string,
  config: Mcp.ServerConfig,
) => {
  const result = McpRestriction.check(restrictions, name, config)
  return result.allowed ? "allowed" : result.reason
}

describe("McpRestriction.check", () => {
  test("allows everything with no lists and nothing with an empty allow list", () => {
    expect(verdict(undefined, "a", local("x"))).toBe("allowed")
    expect(verdict({}, "a", remote("https://a.example/"))).toBe("allowed")
    expect(verdict({ deny: [] }, "a", local("x"))).toBe("allowed")
    expect(verdict({ allow: [] }, "a", local("x"))).toBe("not_allowed")
    expect(verdict({ allow: [] }, "a", remote("https://a.example/"))).toBe("not_allowed")
  })

  test("denies by name exactly, for both kinds, and case counts", () => {
    expect(verdict({ deny: ["github"] }, "github", local("x"))).toBe("denied")
    expect(verdict({ deny: ["github"] }, "github", remote("https://a.example/"))).toBe("denied")
    expect(verdict({ deny: ["github"] }, "GitHub", local("x"))).toBe("allowed")
    expect(verdict({ deny: ["git*"] }, "github", local("x"))).toBe("denied")
    expect(verdict({ deny: ["git*"] }, "other", local("x"))).toBe("allowed")
  })

  test("denies by command, joined with single spaces, for local servers only", () => {
    const deny = { deny: ["command:node server.js"] }
    expect(verdict(deny, "a", local("node", "server.js"))).toBe("denied")
    expect(verdict(deny, "a", local("node", "server.js", "--x"))).toBe("allowed")
    expect(verdict({ deny: ["command:node *"] }, "a", local("node", "server.js", "--x"))).toBe("denied")
    expect(verdict({ deny: ["command:node *"] }, "a", remote("node server.js"))).toBe("allowed")
  })

  test("denies by URL, treating ? and . literally, for remote servers only", () => {
    expect(verdict({ deny: ["url:https://*.corp.example/*"] }, "a", remote("https://a.corp.example/mcp"))).toBe("denied")
    expect(verdict({ deny: ["url:https://*.corp.example/*"] }, "a", remote("https://a.corpXexample/mcp"))).toBe("allowed")
    const query = { deny: ["url:https://x.example/mcp?k=*"] }
    expect(verdict(query, "a", remote("https://x.example/mcp?k=1"))).toBe("denied")
    expect(verdict(query, "a", remote("https://x.example/mcpXk=1"))).toBe("allowed")
    expect(verdict({ deny: ["url:*"] }, "a", local("https://x.example/"))).toBe("allowed")
  })

  test("catches the other spellings of a denied URL", () => {
    const deny = { deny: ["url:https://evil.example/*"] }
    expect(verdict(deny, "a", remote("HTTPS://EVIL.example/mcp"))).toBe("denied")
    expect(verdict(deny, "a", remote("https://evil.example:443/mcp"))).toBe("denied")
    expect(verdict(deny, "a", remote("https://good.example/mcp"))).toBe("allowed")
  })

  test("deny beats allow", () => {
    expect(verdict({ allow: ["github"], deny: ["github"] }, "github", local("x"))).toBe("denied")
  })

  test("an allow list is read by the kind of server it is asked about", () => {
    const commands = { allow: ["github", "command:npx -y @corp/x"] }
    // A command entry exists, so a local server must match one; a name entry alone no longer admits it.
    expect(verdict(commands, "github", local("uvx", "other"))).toBe("not_allowed")
    expect(verdict(commands, "anything", local("npx", "-y", "@corp/x"))).toBe("allowed")
    // The list has no URL entry, so a remote server falls back to the names.
    expect(verdict(commands, "github", remote("https://any.example/"))).toBe("allowed")
    expect(verdict(commands, "other", remote("https://any.example/"))).toBe("not_allowed")

    const urls = { allow: ["github", "url:https://corp.example/*"] }
    expect(verdict(urls, "github", remote("https://other.example/"))).toBe("not_allowed")
    expect(verdict(urls, "x", remote("https://corp.example/mcp"))).toBe("allowed")
    expect(verdict(urls, "github", local("x"))).toBe("allowed")

    // Only a command entry: a remote server has no name entry to match.
    expect(verdict({ allow: ["command:npx *"] }, "a", remote("https://a.example/"))).toBe("not_allowed")
  })

  test("a Windows command is compared as written: no slash rewrite, case counts", () => {
    const allow = { allow: ["command:C:\\tools\\srv.exe"] }
    expect(verdict(allow, "a", local("C:\\tools\\srv.exe"))).toBe("allowed")
    expect(verdict(allow, "a", local("C:/tools/srv.exe"))).toBe("not_allowed")
    expect(verdict(allow, "a", local("c:\\tools\\srv.exe"))).toBe("not_allowed")
  })
})
