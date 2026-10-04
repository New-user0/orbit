import { describe, expect, test } from "bun:test"
import { Mcp } from "@orbit/schema/mcp"
import { CompatAliases } from "../src/aliases.js"
import { CompatNames } from "../src/names.js"

describe("CompatAliases.toOrbit", () => {
  test("maps the edit family to the editing tool and to patch", () => {
    // Orbit swaps edit and write for patch on some models, so a rule or matcher for either must reach patch too.
    expect(CompatAliases.toOrbit("Edit")).toEqual(["edit", "patch"])
    expect(CompatAliases.toOrbit("MultiEdit")).toEqual(["edit", "patch"])
    expect(CompatAliases.toOrbit("Write")).toEqual(["write", "patch"])
  })

  test("maps the notebook tool and every other tool to the one Orbit tool", () => {
    expect(CompatAliases.toOrbit("NotebookEdit")).toEqual(["notebook_edit"])
    expect(
      Object.fromEntries(
        ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite"].map((name) => [
          name,
          CompatAliases.toOrbit(name),
        ]),
      ),
    ).toEqual({
      Bash: ["shell"],
      Read: ["read"],
      Glob: ["glob"],
      Grep: ["grep"],
      WebFetch: ["webfetch"],
      WebSearch: ["websearch"],
      Task: ["subagent"],
      Agent: ["subagent"],
      TodoWrite: ["todo"],
    })
  })

  test("stands for nothing when the name is not an alias", () => {
    // Orbit's own names, other spellings of the aliases, and names an object inherits are not in the table.
    for (const name of ["shell", "edit", "bash", "EDIT", "", "toString", "constructor", "__proto__"])
      expect(CompatAliases.toOrbit(name)).toEqual([])
  })
})

describe("CompatAliases.toForeign", () => {
  test("answers to every editing name for patch, and to its own for edit and write", () => {
    expect(CompatAliases.toForeign("patch")).toEqual(["Edit", "MultiEdit", "Write"])
    expect(CompatAliases.toForeign("edit")).toEqual(["Edit", "MultiEdit"])
    expect(CompatAliases.toForeign("write")).toEqual(["Write"])
  })

  test("reports the shell tool as Bash and a tool nothing aliases as nothing", () => {
    expect(CompatAliases.toForeign("shell")).toEqual(["Bash"])
    expect(CompatAliases.toForeign("memory")).toEqual([])
    expect(CompatAliases.toForeign("Bash")).toEqual([])
  })

  test("reverses every row of the table", () => {
    for (const [foreign, orbit] of Object.entries(CompatNames.tools)) {
      expect(CompatAliases.toOrbit(foreign)).toEqual(orbit)
      for (const tool of orbit) expect(CompatAliases.toForeign(tool)).toContain(foreign)
    }
  })

  test("lists the names in the order of the table, so the first is the one to report", () => {
    const names = Object.keys(CompatNames.tools)
    for (const tool of ["edit", "write", "patch", "subagent"]) {
      const listed = CompatAliases.toForeign(tool)
      expect(listed).toEqual(names.filter((name) => listed.includes(name)))
    }
  })

  test("reports the subagent tool as Agent, its current name, and keeps Task as a name after it", () => {
    expect(CompatAliases.toForeign("subagent")).toEqual(["Agent", "Task"])
    // A matcher written with either name still reaches the tool.
    expect(CompatAliases.toOrbit("Agent")).toEqual(["subagent"])
    expect(CompatAliases.toOrbit("Task")).toEqual(["subagent"])
  })
})

describe("CompatAliases MCP names", () => {
  test("translate the double-underscore form to the registry name", () => {
    expect(CompatAliases.mcpToOrbit("mcp__github__create_issue")).toBe("github_create_issue")
    expect(CompatAliases.toOrbit("mcp__github__create_issue")).toEqual(["github_create_issue"])
  })

  test("end the server at the first double underscore, and keep the rest in the tool", () => {
    expect(CompatAliases.mcpToOrbit("mcp__docs__search__v2")).toBe("docs_search__v2")
    expect(CompatAliases.mcpToOrbit("mcp__docs___private")).toBe("docs__private")
  })

  test("are not names when a part is missing or the prefix differs", () => {
    for (const name of [
      "mcp__docs",
      "mcp__docs__",
      "mcp____search",
      "mcp__",
      "mcp_docs__search",
      "MCP__docs__search",
      "docs__search",
    ])
      expect(CompatAliases.mcpToOrbit(name)).toBeUndefined()
  })

  test("round trip through the shared helpers, characters the sanitizer replaces included", () => {
    const servers = ["github", "context 7", "my.server", "docs-2", "x_y"]
    const tools = ["create_issue", "resolve.library/id", "get-item", "a b"]
    for (const server of servers)
      for (const tool of tools) {
        // The product writes names with those characters already replaced, and the registry names the tool alike.
        const foreign = `mcp__${Mcp.namespace(server)}__${Mcp.namespace(tool)}`
        const registry = Mcp.name(server, tool)

        expect(CompatAliases.mcpToOrbit(foreign)).toBe(registry)
        expect(CompatAliases.toForeign(registry, [{ server, name: tool }])).toEqual([foreign])
        // A name written with the raw characters reaches the same tool.
        expect(CompatAliases.mcpToOrbit(`mcp__${server}__${tool}`)).toBe(registry)
      }
  })

  test("name a tool from the server and tool that registered it, not from the prefix of its name", () => {
    // `github` begins both registry names, and the name alone cannot say where the server ends.
    const connected = [
      { server: "github", name: "create_issue" },
      { server: "github_enterprise", name: "create_issue" },
    ]

    expect(CompatAliases.toForeign("github_create_issue", connected)).toEqual(["mcp__github__create_issue"])
    expect(CompatAliases.toForeign("github_enterprise_create_issue", connected)).toEqual([
      "mcp__github_enterprise__create_issue",
    ])
    // A tool of the second server that merely begins like the first server's is still the second's.
    expect(
      CompatAliases.toForeign("github_enterprise_audit", [
        ...connected,
        { server: "github_enterprise", name: "audit" },
      ]),
    ).toEqual(["mcp__github_enterprise__audit"])
  })

  test("take the split between server and tool from the connected tool when the name leaves it open", () => {
    // Both give the registry name `a_b_c`, so the name alone fits either split.
    expect(CompatAliases.toForeign("a_b_c", [{ server: "a", name: "b_c" }])).toEqual(["mcp__a__b_c"])
    expect(CompatAliases.toForeign("a_b_c", [{ server: "a_b", name: "c" }])).toEqual(["mcp__a_b__c"])
  })

  test("give no MCP name to a name that no connected MCP tool has", () => {
    const connected = [{ server: "github", name: "create_issue" }]

    expect(CompatAliases.toForeign("github_delete_issue", connected)).toEqual([])
    expect(CompatAliases.toForeign("github_create_issue", [])).toEqual([])
    expect(CompatAliases.toForeign("github", connected)).toEqual([])
    // A server called `shell` does not make Orbit's own `shell_output` one of the server's tools.
    expect(CompatAliases.toForeign("shell_output", [{ server: "shell", name: "run" }])).toEqual([])
    // The shell tool is told as Bash, whichever servers are connected.
    expect(CompatAliases.toForeign("shell", [{ server: "shell", name: "run" }])).toEqual(["Bash"])
  })
})

describe("CompatAliases.hookEnv", () => {
  test("names the project directory under the variable that hooks written for another product read", () => {
    expect(CompatAliases.hookEnv("/work/repo")).toEqual({ [CompatNames.vendor.projectDirVariable]: "/work/repo" })
  })

  test("leaves Orbit's own variable to the caller", () => {
    expect(Object.keys(CompatAliases.hookEnv("/work/repo"))).not.toContain("ORBIT_PROJECT_DIR")
  })
})
