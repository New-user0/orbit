import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Message } from "@orbit/ai"
import { Document, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Location } from "@orbit/core/location"
import { Model } from "@orbit/core/model"
import { Permission } from "@orbit/core/permission"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Provider } from "@orbit/core/provider"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { toLLMMessages } from "@orbit/core/session/runner/to-llm-message"
import { ShellSelect } from "@orbit/core/shell/select"
import { ToolNames } from "@orbit/core/tool/names"
import { effectiveName } from "../src/tool/runtime"
import { SessionMessage as SessionMessageSchema } from "@orbit/schema/session-message"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"
import { EditTool } from "../src/tool/plugin/edit"
import { ReadTool } from "../src/tool/plugin/read"
import { ShellTool } from "../src/tool/plugin/shell"
import { WriteTool } from "../src/tool/plugin/write"
import { NotebookEditTool } from "../src/tool/plugin/notebook-edit"

// Spelled out, not read from the table, so that dropping an entry from the table fails a test instead of shrinking it.
const renamed: ReadonlyArray<readonly [string, string]> = [
  ["shell", "Bash"],
  ["shell_output", "TaskOutput"],
  ["shell_watch", "TaskWatch"],
  ["shell_stop", "TaskStop"],
  ["read", "Read"],
  ["edit", "Edit"],
  ["write", "Write"],
  ["patch", "Patch"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["question", "AskUserQuestion"],
  ["todo", "TodoWrite"],
  ["task_create", "TaskCreate"],
  ["task_update", "TaskUpdate"],
  ["task_list", "TaskList"],
  ["subagent", "Agent"],
  ["skill", "Skill"],
  ["notebook_edit", "NotebookEdit"],
  ["lsp", "LSP"],
  ["enter_plan_mode", "EnterPlanMode"],
  ["exit_plan_mode", "ExitPlanMode"],
  ["enter_worktree", "EnterWorktree"],
  ["exit_worktree", "ExitWorktree"],
  ["workflow", "Workflow"],
  ["memory", "Memory"],
  ["execute", "Execute"],
]

// The permission action a tool asks about: the editing tools share one.
const actionOf = (tool: string) => (["Write", "Patch", "NotebookEdit"].includes(tool) ? "Edit" : tool)

describe("tool names", () => {
  test("the table maps every old name to its reference name", () => {
    for (const [old, name] of renamed) {
      expect(ToolNames.canonical(old)).toBe(name)
      expect(ToolNames.canonical(name)).toBe(name)
      expect(ToolNames.legacy(name)).toBe(old)
    }
    expect(ToolNames.canonical("plugin_tool")).toBe("plugin_tool")
  })

  test("a name read from a file is looked up as data, never as a property of the table", () => {
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      // A field key is data too: it keeps its own name and never becomes a function or a prototype.
      const input = Object.fromEntries([[hostile, "x"]])
      expect(Object.keys(ToolNames.raiseInput("Edit", input))).toEqual([hostile])
      expect(Object.keys(ToolNames.lowerInput("Edit", input))).toEqual([hostile])
      expect(ToolNames.canonical(hostile)).toBe(hostile)
      expect(ToolNames.legacy(hostile)).toBe(hostile)
      expect(ToolNames.spellings(hostile)).toEqual([hostile])
      expect(ToolNames.lowerInput(hostile, { path: "a" })).toEqual({ path: "a" })
    }
    // Only the tools with renamed fields change an input, and a non-object input passes through untouched.
    expect(ToolNames.lowerInput("Edit", null)).toBeNull()
    expect(ToolNames.lowerInput("Edit", ["path"])).toEqual(["path"])
  })

  test("the built-in tools register under the reference names", () => {
    expect([EditTool.name, ReadTool.name, ShellTool.name, WriteTool.name, NotebookEditTool.name]).toEqual([
      "Edit",
      "Read",
      "Bash",
      "Write",
      "NotebookEdit",
    ])
  })

  test("the renamed tools take the reference input fields", () => {
    const edit = Schema.decodeUnknownSync(EditTool.Input)({
      file_path: "a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    })
    expect(edit.replace_all).toBe(true)
    expect(() => Schema.decodeUnknownSync(EditTool.Input)({ path: "a.ts", oldString: "a", newString: "b" })).toThrow()
    expect(Schema.decodeUnknownSync(ReadTool.Input)({ file_path: "a.ts", offset: 2, limit: 3 }).file_path).toBe("a.ts")
    expect(
      Schema.decodeUnknownSync(ShellTool.Input)({ command: "ls", run_in_background: true }).run_in_background,
    ).toBe(true)
  })

  test("old fields lower to the current ones and raise back", () => {
    expect(ToolNames.lowerInput("edit", { path: "a", oldString: "b", newString: "c", replaceAll: true })).toEqual({
      file_path: "a",
      old_string: "b",
      new_string: "c",
      replace_all: true,
    })
    expect(ToolNames.lowerInput("Edit", { file_path: "a" })).toEqual({ file_path: "a" })
    expect(ToolNames.lowerInput("shell", { command: "ls", background: true })).toEqual({
      command: "ls",
      run_in_background: true,
    })
    expect(ToolNames.raiseInput("Edit", { file_path: "a", old_string: "b" })).toEqual({ path: "a", oldString: "b" })
    // A tool whose fields did not change keeps its input as it is.
    expect(ToolNames.lowerInput("grep", { path: "a" })).toEqual({ path: "a" })
    expect(ToolNames.lowerInput("shell", "raw text")).toBe("raw text")
  })

  // A guard that confines a call by `delete event.input.background` withdraws the field, as it did when the field was real.
  test("deleting an old field name from the input a hook was given withdraws the current field", () => {
    const rows: ReadonlyArray<readonly [tool: string, input: Record<string, unknown>, old: string, left: Record<string, unknown>]> = [
      ["Bash", { command: "ls", run_in_background: true }, "background", { command: "ls" }],
      ["Edit", { file_path: "a", old_string: "b" }, "path", { old_string: "b" }],
      ["Write", { file_path: "a", content: "c" }, "path", { content: "c" }],
      ["Read", { file_path: "a", limit: 2 }, "path", { limit: 2 }],
    ]
    for (const [tool, input, old, left] of rows) {
      const given = ToolNames.view(tool, input) as Record<string, unknown>
      // The control: a view the hook leaves alone lowers to what it was given.
      expect(ToolNames.lowerInput(tool, given)).toEqual(input)
      delete given[old]
      expect(ToolNames.lowerInput(tool, given)).toEqual(left)
      // A name the hook sets again after deleting it is a write, not a withdrawal.
      const again = ToolNames.view(tool, input) as Record<string, unknown>
      delete again[old]
      again[old] = "x"
      expect(Object.values(ToolNames.lowerInput(tool, again))).toContain("x")
      // A write through the old name followed by a delete of it is a withdrawal too, not a surviving write.
      const wrote = ToolNames.view(tool, input) as Record<string, unknown>
      wrote[old] = "/b"
      delete wrote[old]
      expect(ToolNames.lowerInput(tool, wrote)).toEqual(left)
    }
  })

  test("a view is returned unchanged, and a current field written after a delete is a write", () => {
    const rows: ReadonlyArray<readonly [tool: string, input: Record<string, unknown>, current: string, old: string, next: unknown]> = [
      ["Bash", { command: "ls", run_in_background: true }, "run_in_background", "background", false],
      ["Edit", { file_path: "/a", old_string: "b" }, "file_path", "path", "/safe/file"],
      ["Write", { file_path: "/a", content: "c" }, "file_path", "path", "/safe/file"],
      ["Read", { file_path: "/a" }, "file_path", "path", "/safe/file"],
      ["NotebookEdit", { notebook_path: "/a" }, "notebook_path", "path", "/safe/book"],
    ]
    for (const [tool, input, current, old, next] of rows) {
      const given = ToolNames.view(tool, input) as Record<string, unknown>
      expect(ToolNames.view(tool, given)).toBe(given)
      // A withdrawal recorded by one hook survives the view the next hook is given.
      delete given[old]
      const second = ToolNames.view(tool, given) as Record<string, unknown>
      expect(second).toBe(given)
      expect(ToolNames.lowerInput(tool, second)).not.toHaveProperty(current)
      // delete then set the current field: the write stands.
      const written = ToolNames.view(tool, input) as Record<string, unknown>
      delete written[old]
      written[current] = next
      expect(ToolNames.lowerInput(tool, written)).toMatchObject({ [current]: next })
    }
  })

  test("a record keyed by tool name answers to the old names too", () => {
    const tools = ToolNames.aliased({ Write: 1, Bash: 2, plugin_tool: 3 } as Record<string, number>)
    expect(tools.write).toBe(1)
    expect("shell" in tools).toBe(true)
    delete tools.write
    tools.shell = 4
    expect(Object.entries(tools)).toEqual([
      ["Bash", 4],
      ["plugin_tool", 3],
    ])
    expect(tools.toString).toBe(Object.prototype.toString)
  })

  test("an entry under the exact key is not read as the built-in it shares an old name with", () => {
    const tools = ToolNames.aliased({ Write: 1, write: 9 } as Record<string, number>)
    expect(tools.write).toBe(9)
    expect(tools.Write).toBe(1)
    expect(Object.entries(tools)).toEqual([
      ["Write", 1],
      ["write", 9],
    ])
    delete tools.write
    expect(Object.entries(tools)).toEqual([["Write", 1]])
  })

  // A plugin that confined `shell` under its old name replaces the built-in, as it did before the rename.
  test.each(renamed)("a tool registered as %s takes the place of %s", (old, name) => {
    expect(effectiveName({ name: old } as Tool.Info)).toBe(name)
    expect(effectiveName({ name, options: { namespace: "mcp" } } as Tool.Info)).toBe(`mcp_${name}`)
  })

  test("PowerShell is another spelling of the shell tool and of nothing else", () => {
    const shell = ["Bash", "shell", "PowerShell"]
    shell.forEach((name) => expect([...ToolNames.spellings(name)].sort()).toEqual([...shell].sort()))
    expect(ToolNames.legacy("PowerShell")).toBe("shell")
    expect(ToolNames.canonical("PowerShell")).toBe("PowerShell")
    expect(ToolNames.lowerInput("PowerShell", { background: true })).toEqual({ run_in_background: true })
    expect(ToolNames.spellings("Read")).not.toContain("PowerShell")
    // A rule written for either spelling governs the action the tool asks about.
    expect(Permission.actionMatches("PowerShell", "Bash")).toBe(true)
    expect(Permission.actionMatches("Bash", "PowerShell")).toBe(true)
  })

  test("the spellings of two tools never overlap", () => {
    const groups = renamed.map(([old]) => new Set(ToolNames.spellings(old)))
    groups.forEach((group, index) =>
      groups.slice(index + 1).forEach((other) => expect([...group].filter((name) => other.has(name))).toEqual([])),
    )
  })
})

describe("permission rules written with old names", () => {
  // Every rule an earlier version could have written: one per tool, under each effect.
  test.each(renamed.map(([old, name]) => [old, name]))(
    "a deny rule for %s still denies %s, and an ask rule asks",
    (old, name) => {
      // The editing tools ask about `edit`, which is the only old spelling of that action.
      const action = actionOf(name)
      const rule = (effect: "deny" | "ask" | "allow") => [{ action: ToolNames.legacy(action), resource: "*", effect }]
      expect(Permission.evaluate(action, "*", rule("deny")).effect).toBe("deny")
      expect(Permission.evaluate(action, "src/a.ts", rule("ask")).effect).toBe("ask")
      expect(Permission.evaluate(action, "src/a.ts", rule("allow")).effect).toBe("allow")
      expect(old).toBe(ToolNames.legacy(name))
    },
  )

  test("a rule keeps its place in the order: the last matching rule decides, in either spelling", () => {
    const rules: Permission.Ruleset = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "Edit", resource: "docs/*", effect: "allow" },
    ]
    expect(Permission.evaluate("Edit", "docs/a.md", rules).effect).toBe("allow")
    expect(Permission.evaluate("Edit", "src/a.ts", rules).effect).toBe("deny")
    expect(Permission.evaluate("edit", "src/a.ts", rules).effect).toBe("deny")
  })

  test("a rule with a wildcard in the action still reaches the tool through its old spelling", () => {
    expect(Permission.evaluate("Bash", "ls", [{ action: "sh*", resource: "*", effect: "deny" }]).effect).toBe("deny")
    expect(Permission.evaluate("Bash", "ls", [{ action: "*", resource: "*", effect: "allow" }]).effect).toBe("allow")
  })

  test("an allow rule never covers another tool", () => {
    renamed.forEach(([, allowed]) => {
      const rules = ToolNames.spellings(actionOf(allowed)).map(
        (action): Permission.Rule => ({ action, resource: "*", effect: "allow" }),
      )
      renamed.forEach(([, other]) => {
        // The editing tools share the `Edit` action, as they always have.
        expect(Permission.evaluate(actionOf(other), "*", rules).effect).toBe(
          actionOf(other) === actionOf(allowed) ? "allow" : "ask",
        )
      })
    })
  })

  test("the actions are what the matcher compares, not the tool names", () => {
    expect(Permission.actionMatches("Edit", "edit")).toBe(true)
    expect(Permission.actionMatches("edit", "Edit")).toBe(true)
    expect(Permission.actionMatches("Edit", "write")).toBe(false)
    expect(Permission.actionMatches("Bash", "read")).toBe(false)
    expect(Permission.actionMatches("external_directory", "external_directory")).toBe(true)
  })
})

describe("history lowering", () => {
  const created = DateTime.makeUnsafe(0)
  const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
  const assistant = (tools: SessionMessage.Assistant["content"]) =>
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_lowering"),
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content: tools,
      time: { created, completed: created },
    })
  const completed = (id: string, name: string, input: Record<string, unknown>, executed?: true) =>
    SessionMessage.AssistantTool.make({
      type: "tool",
      id,
      name,
      ...(executed ? { executed } : {}),
      state: SessionMessage.ToolStateCompleted.make({
        status: "completed",
        input,
        content: [{ type: "text", text: "ok" }],
      }),
      time: { created, completed: created },
    })

  test("a recorded shell call lowers as Bash, an edit as Edit with the current fields", () => {
    const messages = toLLMMessages(
      [
        assistant([
          completed("shell", "shell", { command: "ls", background: true }),
          completed("edit", "edit", { path: "a.ts", oldString: "a", newString: "b", replaceAll: false }),
          completed("new", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }),
          completed("hosted", "write", { path: "x" }, true),
        ]),
      ],
      model,
    )
    const calls = messages.flatMap((message) =>
      message.content.flatMap((part) =>
        typeof part !== "string" && part.type === "tool-call" ? [{ name: part.name, input: part.input }] : [],
      ),
    )
    expect(calls).toEqual([
      { name: "Bash", input: { command: "ls", run_in_background: true } },
      { name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: false } },
      { name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } },
      // A tool the provider ran keeps the name the provider gave it.
      { name: "write", input: { path: "x" } },
    ])
    const results = messages.flatMap((message) =>
      message.content.flatMap((part) => (typeof part !== "string" && part.type === "tool-result" ? [part.name] : [])),
    )
    expect(results).toEqual(["write", "Bash", "Edit", "Edit"])
    expect(Message).toBeDefined()
  })
})

describe("hooks written with old names", () => {
  const it = testEffect(
    Layer.mergeAll(
      PluginTestLayer,
      Config.testLayer(),
      AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
    ),
  )
  const decode = Schema.decodeUnknownSync(Info)
  const hooks = (value: unknown) => new Document({ type: "document", info: decode({ hooks: value }) })
  const base = {
    sessionID: Session.ID.make("ses_names_test"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessageSchema.ID.make("msg_names_test"),
    id: Tool.CallID.make("call_names_test"),
  }
  const blocked = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? String(exit.cause) : "")

  it.live("a guard matching the old name blocks the renamed tool, and reads the old name and fields", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      const directory = (yield* tmpdirScoped()).path
      const seen = path.join(directory, "seen.json")
      // The guard is a script, so it reads the event the same way whichever shell runs the command.
      const guard = path.join(directory, "guard.ts")
      yield* Effect.promise(() =>
        fs.writeFile(
          guard,
          [
            "const [mode, out] = Bun.argv.slice(2)",
            "const event = JSON.parse(await Bun.stdin.text())",
            "await Bun.write(out, JSON.stringify(event))",
            // A guard keyed on the old field name blocks a path that is in `path`.
            'if (mode === "always" || (mode === "env" && event.tool_input?.path === ".env")) {',
            '  console.error("blocked by " + mode + " guard")',
            "  process.exit(2)",
            "}",
          ].join("\n"),
        ),
      )
      const block = (mode: string) => ({
        type: "command",
        command: `bun "${guard}" ${mode} "${seen}"; exit $LASTEXITCODE`,
      })
      yield* config.setEntries([
        hooks({
          PreToolUse: [
            { matcher: "shell", hooks: [block("always")] },
            { matcher: "edit|write", hooks: [block("always")] },
            { matcher: "read", hooks: [block("env")] },
          ],
        }),
      ])
      const plugins = yield* Plugin.Service
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(plugins))

      const shell = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Bash", input: { command: "ls", run_in_background: true } })
        .pipe(Effect.exit)
      expect(blocked(shell)).toContain("blocked by always guard")
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(seen, "utf8")))).toMatchObject({
        tool_name: "shell",
        tool_input: { command: "ls", background: true, run_in_background: true },
      })
      for (const tool of ["Edit", "Write"]) {
        const edit = yield* registry
          .trigger("tool", "execute.before", { ...base, tool, input: { file_path: "a.ts" } })
          .pipe(Effect.exit)
        expect(blocked(edit)).toContain("blocked by always guard")
      }
      const secrets = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Read", input: { file_path: ".env" } })
        .pipe(Effect.exit)
      expect(blocked(secrets)).toContain("blocked by env guard")
      const fine = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Read", input: { file_path: "a.ts" } })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(fine)).toBe(true)
    }),
  )

  // A guard of the user's own that checks `tool_name == "read"` or `tool_input.path` must see them whatever its matcher
  // is, or a matcher that is absent, `*` or `.*` makes the guard fail open.
  it.live("a native hook sees the old name and old fields whichever matcher reaches it", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      const directory = (yield* tmpdirScoped()).path
      const record = path.join(directory, "record.ts")
      yield* Effect.promise(() =>
        fs.writeFile(record, "await Bun.write(Bun.argv[2], JSON.stringify(JSON.parse(await Bun.stdin.text())))\n"),
      )
      const matchers = [undefined, "*", ".*", "read", "Read|read", "Read"] as const
      const file = (index: number) => path.join(directory, `seen-${index}.json`)
      yield* config.setEntries([
        hooks({
          PreToolUse: matchers.map((matcher, index) => ({
            ...(matcher === undefined ? {} : { matcher }),
            hooks: [{ type: "command", command: `bun "${record}" "${file(index)}"` }],
          })),
        }),
      ])
      const plugins = yield* Plugin.Service
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(plugins))
      yield* registry.trigger("tool", "execute.before", { ...base, tool: "Read", input: { file_path: ".env" } })
      const seen = yield* Effect.promise(() =>
        Promise.all(matchers.map(async (_, index) => JSON.parse(await fs.readFile(file(index), "utf8")))),
      )
      // A matcher that names only the current spelling is told that spelling, as the person wrote it.
      expect(seen.map((event) => event.tool_name)).toEqual(["read", "read", "read", "read", "read", "Read"])
      expect(seen.map((event) => event.tool_input)).toEqual(matchers.map(() => ({ path: ".env", file_path: ".env" })))
    }),
  )

  it.live("a matcher never reaches a tool it does not name", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([
        hooks({
          PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "exit 2" }] }],
        }),
      ])
      const plugins = yield* Plugin.Service
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(plugins))
      // The control: the hook does run, for the tool it names.
      const control = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Bash", input: {} })
        .pipe(Effect.exit)
      expect(Exit.isFailure(control)).toBe(true)
      for (const tool of ["Read", "Edit", "Write", "TaskStop", "plugin_tool"]) {
        const result = yield* registry.trigger("tool", "execute.before", { ...base, tool, input: {} }).pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(true)
      }
    }),
  )
})
