import { ToolNames } from "@orbit/core/tool/names"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { CompatAliases } from "@orbit/compat/aliases"
import { CompatNames } from "@orbit/compat/names"
import { CompatSettings } from "@orbit/compat/settings"
import { Document, Info, type Entry, type Scope } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Mcp } from "@orbit/core/mcp/index"
import { ShellSelect } from "@orbit/core/shell/select"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import { AbsolutePath } from "@orbit/core/schema"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { GlobTool } from "@orbit/core/tool/plugin/glob"
import { GrepTool } from "@orbit/core/tool/plugin/grep"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { SubagentTool } from "@orbit/core/tool/plugin/subagent"
import { TodoTool } from "@orbit/core/tool/plugin/todo"
import { WebFetchTool } from "@orbit/core/tool/plugin/webfetch"
import { WebSearchTool } from "@orbit/core/tool/plugin/websearch"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { SessionMessage } from "@orbit/schema/session-message"
import { Effect, Exit, Layer, Schema } from "effect"
import { location, tempLocationLayer } from "./fixture/location"
import { emptyMcp } from "./fixture/mcp"
import { withEnv } from "./fixture/env"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// The shared plugin fixture has no shell selection; hooks need it to pick the shell their commands run in.
const layer = (compat: Config.Compat = Config.defaultCompat) =>
  Layer.mergeAll(
    PluginTestLayer,
    Config.testLayer([], compat),
    AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
  )
const it = testEffect(layer())
const itWithout = testEffect(layer({ enabled: false, roots: [] }))

const decode = Schema.decodeUnknownSync(Info)
const vendor = CompatNames.vendor.directory
const base = {
  sessionID: Session.ID.make("ses_compat_hooks_test"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_compat_hooks_test"),
  id: Tool.CallID.make("call_compat_hooks_test"),
}

// A hook that blocks any tool call its matcher reaches, saying which hook it is.
const guard = (matcher: string, reason: string) => ({
  PreToolUse: [{ matcher, hooks: [{ type: "command", command: `echo '${reason}' >&2; exit 2` }] }],
})
// A hook that keeps the event it receives, and blocks nothing.
const recorder = (matcher: string, file: string) => ({
  PreToolUse: [{ matcher, hooks: [{ type: "command", command: `cat > '${file}'` }] }],
})
// A group of hooks for each matcher, which keeps the event in the file that `file` names for its place in the list. A
// matcher that is left out takes every tool.
const recorders = (matchers: readonly (string | undefined)[], file: (index: number) => string) => ({
  PreToolUse: matchers.map((matcher, index) => ({
    matcher,
    hooks: [{ type: "command", command: `cat > '${file(index)}'` }],
  })),
})

// What the compatibility reader makes of vendor settings files written in a directory: the settings folder of a
// project, or of the user's own home.
const readVendor = (directory: string, files: Record<string, unknown>, scope: "user" | "project" = "project") =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      Promise.all(
        Object.entries(files).map(async ([name, contents]) => {
          const file = path.join(directory, vendor, name)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, JSON.stringify(contents))
        }),
      ),
    )
    return yield* CompatSettings.read([
      { path: AbsolutePath.make(path.join(directory, vendor)), kind: "vendor", scope },
    ])
  })

// The documents of vendor settings files that are all readable, as the configuration loader reports them.
const vendorDocuments = (directory: string, files: Record<string, unknown>, scope: "user" | "project" = "project") =>
  Effect.gen(function* () {
    const result = yield* readVendor(directory, files, scope)
    expect(result.diagnostics).toEqual([])
    return result.documents
  })

// A document of the project's own orbit.json, or of the user's.
const nativeDocument = (file: string, hooks: unknown, scope: Scope = "project") =>
  new Document({ type: "document", path: AbsolutePath.make(file), scope, info: decode({ hooks }) })

const start = Effect.gen(function* () {
  yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
})

// The plugin in a session that runs in `directory`, which must exist: the hooks run in it.
const startIn = (directory: string) =>
  start.pipe(
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )

const setEntries = (entries: Entry[]) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries(entries)
  })

// What a PreToolUse call to the tool fails with, or nothing when no hook blocks it.
const blockedBy = (tool: string) =>
  Effect.gen(function* () {
    const registry = yield* PluginHooks.Service
    const exit = yield* registry
      .trigger("tool", "execute.before", { ...base, tool, input: { command: "ls" } })
      .pipe(Effect.exit)
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  })

// The event a hook kept on its standard input.
const payload = (file: string): Effect.Effect<unknown> =>
  Effect.promise(async () => JSON.parse(await fs.readFile(file, "utf8")))

// The events that hooks from a vendor settings file keep when a call of `tool` reaches them, one hook for each matcher
// and in the order of the matchers.
const eventsFor = (tool: string, matchers: readonly (string | undefined)[]) =>
  Effect.gen(function* () {
    const directory = (yield* tmpdirScoped()).path
    const file = (index: number) => path.join(directory, `hook-${index}.json`)
    yield* setEntries(yield* vendorDocuments(directory, { "settings.json": { hooks: recorders(matchers, file) } }))
    yield* start
    yield* blockedBy(tool)
    return yield* Effect.forEach(matchers, (_, index) => payload(file(index)))
  })

describe("the compatibility alias table and the built-in tools", () => {
  const builtIn = [
    ShellTool.name,
    ReadTool.name,
    EditTool.name,
    WriteTool.name,
    PatchTool.name,
    NotebookEditTool.name,
    GlobTool.name,
    GrepTool.name,
    WebFetchTool.name,
    WebSearchTool.name,
    SubagentTool.name,
    TodoTool.name,
  ].map(ToolNames.legacy)

  test("names only tools that Orbit has", () => {
    for (const names of Object.values(CompatNames.tools)) for (const name of names) expect(builtIn).toContain(name)
  })

  test("reaches patch from every editing name, as it takes the place of the editing tools on some models", () => {
    for (const foreign of ["Edit", "MultiEdit", "Write"]) {
      expect(CompatAliases.toOrbit(foreign)).toContain(ToolNames.legacy(PatchTool.name))
      expect(CompatAliases.toOrbit(foreign)).toContain(ToolNames.legacy(foreign === "Write" ? WriteTool.name : EditTool.name))
    }
    expect(CompatAliases.toForeign(ToolNames.legacy(PatchTool.name))).toEqual(["Edit", "MultiEdit", "Write"])
  })
})

describe("LifecycleHooksPlugin with another product's settings files", () => {
  if (process.platform === "win32") return

  it.live("runs a hook from a vendor settings file, matched by the vendor's name for the tool", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(
        yield* vendorDocuments(directory, {
          // Only the hooks of the file reach the runner.
          "settings.json": { permissions: { allow: ["Bash(ls:*)"] }, hooks: guard("Bash", "from shared settings") },
        }),
      )
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toContain("Blocked by a PreToolUse hook: from shared settings")
      expect(yield* blockedBy(ReadTool.name)).toBe("")
    }),
  )

  it.live("runs the hooks of the local settings file beside those of the shared one", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(
        yield* vendorDocuments(directory, {
          "settings.json": { hooks: guard("Bash", "from shared settings") },
          "settings.local.json": { hooks: guard("Read", "from local settings") },
        }),
      )
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toContain("from shared settings")
      expect(yield* blockedBy(ReadTool.name)).toContain("from local settings")
      expect(yield* blockedBy(GlobTool.name)).toBe("")
    }),
  )

  it.live("fires a foreign Edit matcher for patch, which stands in for edit on a patch-tool model", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(yield* vendorDocuments(directory, { "settings.json": { hooks: guard("Edit", "edit hook") } }))
      yield* start

      // The tool the model has is patch, or edit and write, and the hook is for the edit family either way.
      expect(yield* blockedBy(PatchTool.name)).toContain("edit hook")
      expect(yield* blockedBy(EditTool.name)).toContain("edit hook")
      expect(yield* blockedBy(WriteTool.name)).toBe("")
      expect(yield* blockedBy(ReadTool.name)).toBe("")
    }),
  )

  it.live("fires a foreign Write matcher for patch too, and for write", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(yield* vendorDocuments(directory, { "settings.json": { hooks: guard("Write", "write hook") } }))
      yield* start

      expect(yield* blockedBy(PatchTool.name)).toContain("write hook")
      expect(yield* blockedBy(WriteTool.name)).toContain("write hook")
      expect(yield* blockedBy(EditTool.name)).toBe("")
    }),
  )

  it.live("fires a list of foreign names for any of them, with MultiEdit reaching edit and patch", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(
        yield* vendorDocuments(directory, {
          "settings.json": { hooks: guard("MultiEdit|NotebookEdit", "multi hook") },
        }),
      )
      yield* start

      expect(yield* blockedBy(PatchTool.name)).toContain("multi hook")
      expect(yield* blockedBy(EditTool.name)).toContain("multi hook")
      expect(yield* blockedBy(NotebookEditTool.name)).toContain("multi hook")
      expect(yield* blockedBy(WriteTool.name)).toBe("")
      expect(yield* blockedBy(ReadTool.name)).toBe("")
    }),
  )

  it.live("accepts the vendor's names in a native document too, while compatibility is on", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries([nativeDocument(path.join(directory, "orbit.json"), guard("Bash|Edit", "native hook"))])
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toContain("native hook")
      expect(yield* blockedBy(PatchTool.name)).toContain("native hook")
      expect(yield* blockedBy(ReadTool.name)).toBe("")
    }),
  )

  it.live("matches a foreign name as a regular expression, like any other matcher", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries(yield* vendorDocuments(directory, { "settings.json": { hooks: guard("Web.*", "web hook") } }))
      yield* start

      expect(yield* blockedBy(WebFetchTool.name)).toContain("web hook")
      expect(yield* blockedBy(WebSearchTool.name)).toContain("web hook")
      expect(yield* blockedBy(GrepTool.name)).toBe("")
    }),
  )

  it.live("tells a hook from a vendor settings file the vendor's name for the tool, and no one else", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const files = { vendor: path.join(directory, "vendor.json"), native: path.join(directory, "native.json") }
      yield* setEntries([
        ...(yield* vendorDocuments(directory, { "settings.json": { hooks: recorder("Bash", files.vendor) } })),
        nativeDocument(path.join(directory, "orbit.json"), recorder("shell", files.native)),
      ])
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toBe("")

      // The event is the same but for the tool's name, and the vendor's hook reads that product's.
      expect(yield* payload(files.native)).toMatchObject({
        hook_event_name: "PreToolUse",
        session_id: base.sessionID,
        tool_name: "shell",
        tool_input: { command: "ls" },
      })
      expect(yield* payload(files.vendor)).toMatchObject({
        hook_event_name: "PreToolUse",
        session_id: base.sessionID,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      })
    }),
  )

  it.live("tells a hook the first of the vendor's names for the tool that its own matcher accepts", () =>
    Effect.gen(function* () {
      // patch stands in for edit and write, so the vendor has three names for it: Edit, MultiEdit and Write, in that
      // order. Each row is a matcher, and the name that a hook with it is told when it runs for patch.
      const rows = [
        ["Write", "Write"],
        ["Edit|Write", "Edit"],
        ["MultiEdit", "MultiEdit"],
        ["Multi.*|Write", "MultiEdit"],
        [".*", "Edit"],
        [undefined, "Edit"],
      ] as const

      expect(
        yield* eventsFor(
          PatchTool.name,
          rows.map(([matcher]) => matcher),
        ),
      ).toMatchObject(rows.map(([, tool]) => ({ tool_name: tool })))
    }),
  )

  it.live("tells a hook the current name of the subagent tool, and the older one to a hook that names only that", () =>
    Effect.gen(function* () {
      const told = yield* eventsFor(SubagentTool.name, ["Agent", "Task", "Agent|Task", "Task|Agent", ".*", undefined])

      expect(told).toMatchObject(
        ["Agent", "Task", "Agent", "Agent", "Agent", "Agent"].map((tool_name) => ({ tool_name })),
      )
    }),
  )

  it.live("tells a hook the first of the vendor's names when its matcher names the tool only the Orbit way", () =>
    Effect.gen(function* () {
      expect(yield* eventsFor(PatchTool.name, ["patch"])).toMatchObject([{ tool_name: "Edit" }])
    }),
  )

  it.live("keeps Orbit's name for a tool that the vendor has no name for", () =>
    Effect.gen(function* () {
      expect(yield* eventsFor("memory", ["memory", undefined])).toMatchObject([
        { tool_name: "memory" },
        { tool_name: "memory" },
      ])
    }),
  )

  it.live("sets the vendor's variable for the project directory beside Orbit's, for a hook in Orbit's own files", () =>
    Effect.gen(function* () {
      const session = yield* Location.Service
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "env.txt")
      const variable = CompatNames.vendor.projectDirVariable
      const command = `printf '%s\\n%s' "$ORBIT_PROJECT_DIR" "$${variable}" > '${file}'`
      yield* setEntries([
        nativeDocument(path.join(directory, "orbit.json"), {
          PreToolUse: [{ hooks: [{ type: "command", command }] }],
        }),
      ])
      yield* start

      yield* withEnv({ [variable]: undefined }, () => blockedBy(ShellTool.name))

      expect((yield* Effect.promise(() => fs.readFile(file, "utf8"))).split("\n")).toEqual([
        session.directory,
        session.directory,
      ])
      expect(CompatAliases.hookEnv(session.directory)).toEqual({ [variable]: session.directory })
    }),
  )

  it.live("finds the script of a hook in the project's settings folder above the session, through the variable", () =>
    Effect.gen(function* () {
      const repo = (yield* tmpdirScoped()).path
      const app = path.join(repo, "app")
      const variable = CompatNames.vendor.projectDirVariable
      const script = path.join(repo, vendor, "hooks", "guard.sh")
      yield* Effect.promise(async () => {
        await fs.mkdir(app)
        await fs.mkdir(path.dirname(script), { recursive: true })
        await fs.writeFile(script, "echo 'the script guard' >&2\nexit 2\n")
      })
      // The settings folder is in the repository, and the session runs in a directory inside it, where discovery finds
      // the folder by walking up. The hook runs in the session's directory, and is written for a project directory
      // that holds the folder.
      const command = `sh "$${variable}/${vendor}/hooks/guard.sh"`
      yield* setEntries(
        yield* vendorDocuments(repo, {
          "settings.json": { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } },
        }),
      )
      yield* startIn(app)

      expect(yield* withEnv({ [variable]: undefined }, () => blockedBy(ShellTool.name))).toContain(
        "Blocked by a PreToolUse hook: the script guard",
      )
    }),
  )

  it.live("gives each hook the project directory of its own document, and the session's when it has none", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const home = path.join(root, "home")
      const repo = path.join(root, "repo")
      const app = path.join(repo, "app")
      const session = path.join(app, "web")
      yield* Effect.promise(() => fs.mkdir(session, { recursive: true }))
      const variable = CompatNames.vendor.projectDirVariable
      const file = (name: string) => path.join(root, `${name}.txt`)
      // A hook that keeps the directory its variable names.
      const record = (name: string) => ({
        PreToolUse: [{ hooks: [{ type: "command", command: `printf '%s' "$${variable}" > '${file(name)}'` }] }],
      })
      yield* setEntries([
        ...(yield* vendorDocuments(home, { "settings.json": { hooks: record("user") } }, "user")),
        ...(yield* vendorDocuments(repo, {
          "settings.json": { hooks: record("repo") },
          "settings.local.json": { hooks: record("repo-local") },
        })),
        ...(yield* vendorDocuments(app, { "settings.json": { hooks: record("app") } })),
        nativeDocument(path.join(app, "orbit.json"), record("native")),
      ])
      yield* startIn(session)

      yield* withEnv({ [variable]: undefined }, () => blockedBy(ShellTool.name))

      // The project folders answer for the directories that hold them, at whatever depth the walk found them, and
      // the user's own folder and Orbit's own files for the directory the session runs in.
      expect(
        yield* Effect.forEach(["user", "repo", "repo-local", "app", "native"], (name) =>
          Effect.promise(() => fs.readFile(file(name), "utf8")),
        ),
      ).toEqual([session, repo, repo, app, session])
    }),
  )

  it.live("lets a native document outrank a vendor one of the same scope when both block", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      // The configuration loader puts the vendor's documents before the native ones of their scope.
      yield* setEntries([
        ...(yield* vendorDocuments(directory, { "settings.json": { hooks: guard("Bash", "from the vendor") } })),
        nativeDocument(path.join(directory, "orbit.json"), guard("shell", "from orbit.json")),
      ])
      yield* start

      const reason = yield* blockedBy(ShellTool.name)
      expect(reason).toContain("from orbit.json")
      expect(reason).not.toContain("from the vendor")
    }),
  )

  it.live("lets the vendor's project settings outrank the user's own orbit.json, as the scope does", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries([
        nativeDocument(path.join(directory, "user", "orbit.json"), guard("shell", "from the user"), "user"),
        ...(yield* vendorDocuments(directory, { "settings.json": { hooks: guard("Bash", "from the project") } })),
      ])
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toContain("from the project")
    }),
  )

  it.live("still runs the guard that sits next to a hook it cannot read", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      // A model needs its provider, so this version rejects the second hook and keeps the guard.
      const result = yield* readVendor(directory, {
        "settings.json": {
          hooks: {
            ...guard("Bash", "guard fired"),
            SubagentStop: [{ hooks: [{ type: "prompt", prompt: "Did it finish?", model: "fast-model" }] }],
          },
        },
      })
      yield* setEntries(result.documents)
      yield* start

      expect(result.diagnostics.map((diagnostic) => diagnostic.path.join("."))).toEqual([
        "hooks.SubagentStop.0.hooks.0",
      ])
      expect(yield* blockedBy(ShellTool.name)).toContain("Blocked by a PreToolUse hook: guard fired")
    }),
  )

  it.live("names an MCP tool from the server and tool that registered it, not from the prefix of its name", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const files = { github: path.join(directory, "github.json"), enterprise: path.join(directory, "enterprise.json") }
      yield* setEntries([
        ...(yield* vendorDocuments(directory, {
          "settings.json": {
            hooks: {
              PreToolUse: [
                ...guard("mcp__github__.*", "github hook").PreToolUse,
                ...guard("mcp__shell__.*", "shell server hook").PreToolUse,
              ],
            },
          },
          "settings.local.json": {
            hooks: recorders(["mcp__github__.*", "mcp__github_enterprise__.*"], (index) =>
              index === 0 ? files.github : files.enterprise,
            ),
          },
        })),
      ])
      yield* start

      expect(yield* blockedBy("github_create_issue")).toContain("github hook")
      expect(yield* payload(files.github)).toMatchObject({ tool_name: "mcp__github__create_issue" })
      // The other server's name begins with this one's, and a tool of it is not a tool of this one.
      expect(yield* blockedBy("github_enterprise_create_issue")).toBe("")
      expect(yield* payload(files.enterprise)).toMatchObject({ tool_name: "mcp__github_enterprise__create_issue" })
      // Nothing splits a name that no connected MCP tool has, so it is no MCP tool's, whichever server it begins with.
      expect(yield* blockedBy("gitlab_create_issue")).toBe("")
      // Orbit's own tool that begins like the name of a server is not the server's, though a tool of it is.
      expect(yield* blockedBy("shell_output")).toBe("")
      expect(yield* blockedBy("shell_run")).toContain("shell server hook")
    }).pipe(
      Effect.provideService(
        Mcp.Service,
        Mcp.Service.of({
          ...emptyMcp,
          tools: () =>
            Effect.succeed(
              [
                { server: "github", name: "create_issue" },
                { server: "github_enterprise", name: "create_issue" },
                { server: "shell", name: "run" },
              ].map((tool) => ({ ...tool, server: Mcp.ServerName.make(tool.server), inputSchema: { type: "object" } })),
            ),
        }),
      ),
    ),
  )
})

describe("LifecycleHooksPlugin with compatibility off", () => {
  if (process.platform === "win32") return

  itWithout.live("matches only Orbit's own names for a tool, in every document", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* setEntries([
        nativeDocument(path.join(directory, "orbit.json"), guard("Bash|Edit", "foreign name")),
        nativeDocument(path.join(directory, "orbit.local.json"), guard("read|patch", "orbit name"), "local"),
      ])
      yield* start

      expect(yield* blockedBy(ShellTool.name)).toBe("")
      expect(yield* blockedBy(EditTool.name)).toBe("")
      expect(yield* blockedBy(ReadTool.name)).toContain("orbit name")
      expect(yield* blockedBy(PatchTool.name)).toContain("orbit name")
    }),
  )

  itWithout.live("leaves the vendor's variable for the project directory unset", () =>
    Effect.gen(function* () {
      const session = yield* Location.Service
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "env.txt")
      const variable = CompatNames.vendor.projectDirVariable
      const command = `printf '%s|%s' "$ORBIT_PROJECT_DIR" "$${variable}" > '${file}'`
      yield* setEntries([
        nativeDocument(path.join(directory, "orbit.json"), { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
      ])
      yield* start

      yield* withEnv({ [variable]: undefined }, () => blockedBy(ShellTool.name))

      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(`${session.directory}|`)
    }),
  )
})
