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
        expect(CompatAliases.toForeign(registry, [server])).toEqual([foreign])
        // A name written with the raw characters reaches the same tool.
        expect(CompatAliases.mcpToOrbit(`mcp__${server}__${tool}`)).toBe(registry)
      }
  })

  test("take only the servers whose namespace begins the name", () => {
    expect(CompatAliases.toForeign("github_create_issue", ["github", "gitlab"])).toEqual(["mcp__github__create_issue"])
    expect(CompatAliases.toForeign("github_create_issue", [])).toEqual([])
    // Nothing follows the namespace, so there is no tool.
    expect(CompatAliases.toForeign("github_", ["github"])).toEqual([])
    expect(CompatAliases.toForeign("github", ["github"])).toEqual([])
  })

  test("name every server that could own an ambiguous name", () => {
    expect(CompatAliases.toForeign("a_b_c", ["a", "a_b"])).toEqual(["mcp__a__b_c", "mcp__a_b__c"])
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
