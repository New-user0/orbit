import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ToolNames } from "@orbit/core/tool/names"

const root = path.join(import.meta.dir, "..", "src")
const sources = (pattern: string) =>
  Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root })).then((files) => files.map((file) => path.join(root, file)))

describe("the names the model is told", () => {
  test("no tool advertises a name that the table lists as an old one", async () => {
    const files = [...(await sources("tool/plugin/*.ts")), path.join(root, "codemode", "tool.ts")]
    const advertised = (
      await Promise.all(
        files.map(async (file) => {
          const text = await fs.readFile(file, "utf8")
          return Array.from(text.matchAll(/^(?:export const name = |\s+name: )"([^"]+)"/gm), (match) => match[1])
        }),
      )
    ).flat()
    // The scan finds the tools it is meant to, and the control is a name the table does list.
    expect(advertised).toContain("Bash")
    expect(advertised).toContain("Execute")
    expect(Object.keys(ToolNames.tools)).toContain("shell")
    expect(advertised.filter((name) => Object.hasOwn(ToolNames.tools, name))).toEqual([])
  })

  // A tool result, a description or a prompt that names a tool by its old name sends the model to a tool that is not
  // advertised. The text is searched where a name stands for a tool: in backticks, after `tool`, or after a verb.
  test("no description, prompt or tool result names a tool by an old name", async () => {
    const files = (
      await Promise.all(
        [
          "tool/**/*.{ts,txt}",
          "plugin/**/*.{ts,txt}",
          "skill/**/*.{ts,txt}",
          "codemode/**/*.{ts,txt}",
          "mcp/instructions.ts",
          "session/**/*.txt",
          "agent/**/*.{ts,txt}",
        ].map(sources),
      )
    ).flat()
    const old = Object.keys(ToolNames.tools)
    const alternatives = old.join("|")
    const naming = new RegExp(
      [
        `\`(?:${alternatives})\`(?= tool)`,
        `\\b(?:${alternatives}) tool\\b`,
        `\\b(?:[Uu]se|[Uu]sing|call|calling|entered with) (?:the )?\`?(?:${alternatives})\`?(?= to\\b| tool\\b|[.,]|$)`,
      ].join("|"),
    )
    const hits = (
      await Promise.all(
        files.map(async (file) => {
          const lines = (await fs.readFile(file, "utf8")).split("\n")
          return lines.flatMap((line, index) => {
            // Comments are for the people who read the code, not for the model.
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
            return naming.test(line) ? [`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 100)}`] : []
          })
        }),
      )
    ).flat()
    expect(hits).toEqual([])
    // The control: the pattern does see an old name used the way the text above used to use one.
    expect(naming.test("use exit_worktree to return")).toBe(true)
    expect(naming.test("Use the `question` tool for one batch")).toBe(true)
  })
})
