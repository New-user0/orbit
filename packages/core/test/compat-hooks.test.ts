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
import { tempLocationLayer } from "./fixture/location"
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

// What the compatibility reader makes of vendor settings files written in a project directory.
const readVendor = (directory: string, files: Record<string, unknown>) =>
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
      { path: AbsolutePath.make(path.join(directory, vendor)), kind: "vendor", scope: "project" },
    ])
  })

// The documents of vendor settings files that are all readable, as the configuration loader reports them.
const vendorDocuments = (directory: string, files: Record<string, unknown>) =>
  Effect.gen(function* () {
    const result = yield* readVendor(directory, files)
    expect(result.diagnostics).toEqual([])
    return result.documents
  })

// A document of the project's own orbit.json, or of the user's.
const nativeDocument = (file: string, hooks: unknown, scope: Scope = "project") =>
  new Document({ type: "document", path: AbsolutePath.make(file), scope, info: decode({ hooks }) })

const start = Effect.gen(function* () {
  yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
})

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
  ]

  test("names only tools that Orbit has", () => {
    for (const names of Object.values(CompatNames.tools)) for (const name of names) expect(builtIn).toContain(name)
  })

  test("reaches patch from every editing name, as it takes the place of the editing tools on some models", () => {
    for (const foreign of ["Edit", "MultiEdit", "Write"]) {
      expect(CompatAliases.toOrbit(foreign)).toContain(PatchTool.name)
      expect(CompatAliases.toOrbit(foreign)).toContain(foreign === "Write" ? WriteTool.name : EditTool.name)
    }
    expect(CompatAliases.toForeign(PatchTool.name)).toEqual(["Edit", "MultiEdit", "Write"])
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

  it.live(
    "reports the first of the vendor's names for a tool that has several, and keeps the name of one without",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const files = { patch: path.join(directory, "patch.json"), memory: path.join(directory, "memory.json") }
        yield* setEntries([
          ...(yield* vendorDocuments(directory, {
            "settings.json": { hooks: recorder("Write", files.patch) },
            "settings.local.json": { hooks: recorder("memory", files.memory) },
          })),
        ])
        yield* start

        yield* blockedBy(PatchTool.name)
        yield* blockedBy("memory")

        // The Write hook ran for patch, and is told about the tool by the first name it answers to.
        expect(yield* payload(files.patch)).toMatchObject({ tool_name: "Edit" })
        // A tool the vendor has no name for is named as Orbit names it.
        expect(yield* payload(files.memory)).toMatchObject({ tool_name: "memory" })
      }),
  )

  it.live("sets the vendor's variable for the project directory beside Orbit's, for every hook", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
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
        location.directory,
        location.directory,
      ])
      expect(CompatAliases.hookEnv(location.directory)).toEqual({ [variable]: location.directory })
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

  it.live("matches the foreign name of an MCP tool, from the servers that could own it", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "mcp.json")
      yield* setEntries([
        ...(yield* vendorDocuments(directory, {
          "settings.json": { hooks: guard("mcp__github__.*", "github hook") },
          "settings.local.json": { hooks: recorder("mcp__github__.*", file) },
        })),
      ])
      yield* start

      expect(yield* blockedBy("github_create_issue")).toContain("github hook")
      expect(yield* payload(file)).toMatchObject({ tool_name: "mcp__github__create_issue" })
      // The same name under a server that is not configured has nothing to split it by, and is not a match.
      expect(yield* blockedBy("gitlab_create_issue")).toBe("")
    }).pipe(
      Effect.provideService(
        Mcp.Service,
        Mcp.Service.of({
          ...emptyMcp,
          servers: () => Effect.succeed([{ name: "github", status: { status: "connected" } }]),
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
      const location = yield* Location.Service
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "env.txt")
      const variable = CompatNames.vendor.projectDirVariable
      const command = `printf '%s|%s' "$ORBIT_PROJECT_DIR" "$${variable}" > '${file}'`
      yield* setEntries([
        nativeDocument(path.join(directory, "orbit.json"), { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
      ])
      yield* start

      yield* withEnv({ [variable]: undefined }, () => blockedBy(ShellTool.name))

      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(`${location.directory}|`)
    }),
  )
})
