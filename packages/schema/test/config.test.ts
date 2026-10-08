import { describe, expect, test } from "bun:test"
import path from "path"
import { Schema } from "effect"
import { Config } from "../src/config.js"
import { ConfigAgent } from "../src/config/agent.js"
import { ConfigHooks } from "../src/config/hooks.js"
import { ConfigMCP } from "../src/config/mcp.js"
import { ConfigProvider } from "../src/config/provider.js"
import { Mcp } from "../src/mcp.js"
import { Provider } from "../src/provider.js"
import { AbsolutePath } from "../src/schema.js"
import { WebSearch } from "../src/websearch.js"

describe("Config.Entry", () => {
  test("accepts directory-only worktree config and omits it when absent", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const input = { worktree: { directory: "../worktrees" } }
    expect(Schema.encodeSync(Config.Info)(decode(input))).toEqual(input)
    expect(Schema.encodeSync(Config.Info)(new Config.Info({ worktree: undefined }))).not.toHaveProperty("worktree")
    expect(() => decode({ worktree: {} })).toThrow()
    expect(() => decode({ worktree: { directory: " " } })).toThrow()
    expect(() => decode({ worktree: { directory: false } })).toThrow()
  })
  test("accepts a positive whole tool concurrency cap and refuses any other", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const encode = Schema.encodeSync(Config.Info)
    for (const input of [{ tool_execution: { max_concurrency: 3 } }, { tool_execution: {} }])
      expect(encode(decode(input))).toEqual(input)
    expect(encode(new Config.Info({ tool_execution: undefined }))).not.toHaveProperty("tool_execution")
    for (const cap of [0, -1, 1.5, "2", null])
      expect(() => decode({ tool_execution: { max_concurrency: cap } })).toThrow()
  })
  test("decodes fallback_model in the short and the explicit form", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const explicit = { providerID: "acme", model: "backup", variant: "high" }
    expect(decode({ fallback_model: "acme/backup#high" }).fallback_model).toEqual<unknown>(explicit)
    expect(decode({ fallback_model: explicit }).fallback_model).toEqual<unknown>(explicit)
    expect(() => decode({ fallback_model: "backup" })).toThrow()
    expect(Schema.encodeSync(Config.Info)(new Config.Info({ fallback_model: undefined }))).not.toHaveProperty(
      "fallback_model",
    )
  })
  test("round-trips the compatibility switch and omits it when absent", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const encode = Schema.encodeSync(Config.Info)
    for (const input of [
      { compatibility: { enabled: false } },
      { compatibility: { enabled: true } },
      { compatibility: {} },
    ])
      expect(encode(decode(input))).toEqual(input)
    expect(encode(new Config.Info({}))).not.toHaveProperty("compatibility")
    expect(() => decode({ compatibility: { enabled: "no" } })).toThrow()
    expect(() => decode({ compatibility: false })).toThrow()
  })
  test("round-trips canonical provider IDs without changing config keys", () => {
    const input = { providers: { "console-anthropic": { canonical: "anthropic" } } }
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(decoded.providers?.["console-anthropic"]?.canonical).toBe(Provider.ID.anthropic)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(() => Schema.decodeUnknownSync(Config.Info)({ providers: { custom: { canonical: 1 } } })).toThrow()
  })

  test("round-trips disabled and numeric provider HTTP timeouts", () => {
    const input = {
      providers: { custom: { settings: { timeout: 900_000, headerTimeout: 600_000, chunkTimeout: false } } },
    } as const
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(Schema.decodeUnknownSync(Provider.Settings)(decoded.providers?.custom?.settings)).toMatchObject({
      timeout: 900_000,
      headerTimeout: 600_000,
      chunkTimeout: false,
    })
    expect(Schema.decodeUnknownSync(Provider.Settings)({ headerTimeout: false, chunkTimeout: 600_000 })).toMatchObject({
      headerTimeout: false,
      chunkTimeout: 600_000,
    })
  })

  test("accepts disabled, fixed, and random web search selection", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)

    expect(decode({ websearch: false }).websearch).toBe(false)
    expect(decode({ websearch: { provider: "exa" } }).websearch).toEqual({ provider: WebSearch.ID.make("exa") })
    expect(decode({ websearch: { provider: "random" } }).websearch).toEqual({ provider: "random" })
  })

  test("round-trips every configuration entry type", () => {
    const entries = [
      new Config.Document({
        type: "document",
        path: AbsolutePath.make("/project/orbit.json"),
        info: new Config.Info({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
        }),
      }),
      new Config.Document({ type: "document", info: new Config.Info({ shell: "/bin/zsh" }) }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("/project/.orbit") }),
    ]

    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(entries)
    const decoded = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(encoded)

    expect(decoded).toEqual(entries)
    expect(decoded[0]).toBeInstanceOf(Config.Document)
    expect(decoded[1]).not.toHaveProperty("path")
    expect(decoded.map((entry) => entry.type)).toEqual(["document", "document", "directory"])
    expect(decoded[0]?.type === "document" ? decoded[0].info.permissions : undefined).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
  })

  test("round-trips the scope of every entry", () => {
    const scopes = ["remote", "user", "project", "local", "flag", "managed"] as const
    const entries = [
      ...scopes.map(
        (scope) => new Config.Document({ type: "document", scope, info: new Config.Info({ shell: "/bin/zsh" }) }),
      ),
      ...scopes.map(
        (scope) => new Config.Directory({ type: "directory", scope, path: AbsolutePath.make("/project/.orbit") }),
      ),
    ]

    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(entries)
    const decoded = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(encoded)

    expect(encoded.map((entry) => entry.scope)).toEqual([...scopes, ...scopes])
    expect(decoded).toEqual(entries)
    expect(decoded[0]).toBeInstanceOf(Config.Document)
    expect(decoded.map((entry) => entry.scope)).toEqual([...scopes, ...scopes])
  })

  test("accepts entries without a scope and encodes them without one", () => {
    const decode = Schema.decodeUnknownSync(Schema.Array(Config.Entry))
    const decoded = decode([
      { type: "document", info: { shell: "/bin/zsh" } },
      { type: "directory", path: "/project/.orbit" },
    ])

    expect(decoded.map((entry) => entry.scope)).toEqual([undefined, undefined])
    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(decoded)
    expect(encoded[0]).not.toHaveProperty("scope")
    expect(encoded[1]).not.toHaveProperty("scope")
    expect(
      Schema.encodeSync(Config.Entry)(
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/x"), scope: undefined }),
      ),
    ).not.toHaveProperty("scope")
  })

  test("rejects an unknown scope", () => {
    const decode = Schema.decodeUnknownSync(Config.Entry)
    expect(() => decode({ type: "directory", path: "/project/.orbit", scope: "global" })).toThrow()
    expect(() => decode({ type: "document", scope: 1, info: {} })).toThrow()
  })

  test("has a stable public identifier", () => {
    expect(Config.Entry.ast.annotations?.identifier).toBe("Config.Entry")
    expect(Config.Scope.ast.annotations?.identifier).toBe("Config.Scope")
  })

  test("omits undefined optional properties while encoding", () => {
    const entry = new Config.Document({
      type: "document",
      path: undefined,
      info: new Config.Info({
        default_agent: undefined,
        agents: { reviewer: new ConfigAgent.Info({ description: undefined }) },
        mcp: new ConfigMCP.Info({
          timeout: undefined,
          servers: {
            docs: new Mcp.RemoteConfig({
              type: "remote",
              url: "https://example.com/mcp",
              headers: undefined,
              oauth: new Mcp.OAuthConfig({ client_id: undefined }),
            }),
          },
        }),
        providers: { custom: new ConfigProvider.Info({ canonical: undefined, headers: undefined }) },
      }),
    })
    const encoded = Schema.encodeSync(Config.Entry)(entry)
    if (encoded.type !== "document") throw new Error("Expected a config document")

    expect(encoded).not.toHaveProperty("path")
    expect(encoded.info).not.toHaveProperty("default_agent")
    expect(encoded.info.agents?.reviewer).not.toHaveProperty("description")
    expect(encoded.info.mcp).not.toHaveProperty("timeout")
    const docs = encoded.info.mcp?.servers?.docs
    if (docs?.type !== "remote" || docs.oauth === false) throw new Error("Expected a remote MCP server")
    expect(docs).not.toHaveProperty("headers")
    expect(docs.oauth).not.toHaveProperty("client_id")
    expect(encoded.info.providers?.custom).not.toHaveProperty("headers")
    expect(encoded.info.providers?.custom).not.toHaveProperty("canonical")
  })
})

describe("Config.Effective", () => {
  test("round-trips the compatibility switch the server resolved", () => {
    const decode = Schema.decodeUnknownSync(Config.Effective)
    for (const compatibility of [true, false])
      expect(Schema.encodeSync(Config.Effective)(decode({ compatibility }))).toEqual({ compatibility })
  })

  test("requires the switch to be present and a boolean", () => {
    const decode = Schema.decodeUnknownSync(Config.Effective)
    expect(() => decode({})).toThrow()
    expect(() => decode({ compatibility: "yes" })).toThrow()
    expect(() => decode({ compatibility: undefined })).toThrow()
    expect(() => decode(undefined)).toThrow()
  })

  test("has a stable public identifier", () => {
    expect(Config.Effective.ast.annotations?.identifier).toBe("Config.Effective")
  })
})

describe("ConfigHooks", () => {
  const decode = Schema.decodeUnknownSync(Config.Info)
  const model = { providerID: "acme", model: "fast-model" }
  const hookOfEachType = [
    { type: "command", command: "./check.sh" },
    { type: "prompt", prompt: "Is this safe?" },
    { type: "agent", prompt: "Verify the change" },
    { type: "http", url: "https://hooks.example.com/event" },
  ]

  test("round-trips every hook type with snake_case fields", () => {
    const input = {
      hooks: {
        PreToolUse: [
          {
            matcher: "shell|edit",
            hooks: [
              {
                type: "command",
                command: "./check.sh",
                shell: "bash",
                async: true,
                async_rewake: false,
                timeout: 30,
                status_message: "Checking the command",
                once: true,
                if: "shell(git *)",
              },
              { type: "prompt", prompt: "Is this safe?", model, timeout: 20 },
              { type: "agent", prompt: "Verify the change", model, timeout: 90 },
              {
                type: "http",
                url: "https://hooks.example.com/pre",
                headers: { Authorization: "Bearer $TOKEN" },
                allowed_env_vars: ["TOKEN"],
                timeout: 10,
              },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "echo ready" }] }],
        disabled: false,
        managed_only: true,
        http: { allowed_urls: ["https://hooks.example.com/*"], allowed_env_vars: ["TOKEN"] },
      },
    }
    expect<unknown>(Schema.encodeSync(Config.Info)(decode(input))).toEqual(input)
  })

  test("accepts the provider/model short form on prompt and agent hooks", () => {
    const decoded = Schema.decodeUnknownSync(ConfigHooks.Info)({
      Stop: [
        {
          hooks: [
            { type: "prompt", prompt: "Done?", model: "acme/fast-model" },
            { type: "agent", prompt: "Check", model: "acme/fast-model" },
          ],
        },
      ],
    })
    expect<unknown>(
      decoded.Stop?.[0]?.hooks.flatMap((hook) => (hook.type === "prompt" || hook.type === "agent" ? [hook.model] : [])),
    ).toEqual([model, model])
  })

  test("rejects a non-positive or fractional timeout on every hook type", () => {
    hookOfEachType.forEach((hook) => {
      const withTimeout = (timeout: number) => decode({ hooks: { Stop: [{ hooks: [{ ...hook, timeout }] }] } })
      expect(() => withTimeout(1)).not.toThrow()
      expect(() => withTimeout(0)).toThrow()
      expect(() => withTimeout(-5)).toThrow()
      expect(() => withTimeout(1.5)).toThrow()
    })
  })

  test("rejects unknown hook types, unknown shells and hooks missing their required field", () => {
    const attempt = (hook: unknown) => () => decode({ hooks: { Stop: [{ hooks: [hook] }] } })
    expect(attempt({ type: "script", command: "x" })).toThrow()
    expect(attempt({ type: "command", command: "x", shell: "zsh" })).toThrow()
    expect(attempt({ type: "command" })).toThrow()
    expect(attempt({ type: "prompt" })).toThrow()
    expect(attempt({ type: "agent" })).toThrow()
    expect(attempt({ type: "http" })).toThrow()
  })

  test("names 27 events once each and shares them between definitions and settings", () => {
    const events = [...ConfigHooks.Events].toSorted()
    expect(new Set(events).size).toBe(27)
    expect(Object.keys(ConfigHooks.MatcherTargets).toSorted()).toEqual(events)
    expect(Object.keys(ConfigHooks.Definitions.fields).toSorted()).toEqual(events)
    expect(Object.keys(ConfigHooks.Info.fields).toSorted()).toEqual(
      [...events, "disabled", "http", "managed_only"].toSorted(),
    )
    expect([...ConfigHooks.DecisionEvents].toSorted()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "Stop",
      "SubagentStop",
      "TaskCompleted",
      "TaskCreated",
      "TeammateIdle",
      "UserPromptSubmit",
    ])
  })

  test("describes every event's matcher target and closed values", () => {
    const vocabularies: Partial<Record<ConfigHooks.Event, readonly string[]>> = {
      SessionStart: ConfigHooks.SessionStartSources,
      SessionEnd: ConfigHooks.SessionEndReasons,
      Setup: ConfigHooks.SetupTriggers,
      Notification: ConfigHooks.NotificationKinds,
      PreCompact: ConfigHooks.CompactionTriggers,
      PostCompact: ConfigHooks.CompactionTriggers,
    }
    ConfigHooks.Events.forEach((event) => {
      const description = ConfigHooks.Definitions.fields[event].ast.annotations?.description
      if (typeof description !== "string") throw new Error(`${event} has no description`)
      expect(description).toContain(
        ConfigHooks.MatcherTargets[event] === "none" ? "no matcher target" : "matcher is compared with",
      )
      vocabularies[event]?.forEach((value) => expect(description).toContain(`"${value}"`))
    })
  })

  test("keeps vendor product names out of annotations and the module", async () => {
    // Assembled from parts so this file never spells the names it forbids.
    const vendor = new RegExp(
      [
        ["cla", "ude"],
        ["anthro", "pic"],
      ]
        .map((parts) => parts.join(""))
        .join("|"),
      "i",
    )
    // Descriptions on optional fields never reach the generated JSON Schema, so the module text is checked as well.
    const source = await Bun.file(path.join(import.meta.dir, "../src/config/hooks.ts")).text()
    expect(source).not.toMatch(vendor)
    expect(JSON.stringify(Schema.toJsonSchemaDocument(ConfigHooks.Info))).not.toMatch(vendor)
  })
})
