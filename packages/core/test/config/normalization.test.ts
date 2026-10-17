import { describe, expect, test } from "bun:test"
import { Duration, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { Info } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigHooks } from "@orbit/schema/config/hooks"

const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

function normalized(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result
}

function decoded(input: unknown) {
  return Schema.decodeUnknownSync(Info, options)(normalized(input).encoded)
}

type EncodedHooks = (typeof ConfigHooks.Info)["Encoded"]

/**
 * The hooks that must come through normalization untouched: all but the ones it reported as skipped. The reported
 * paths are the decoder's own, so this restates none of its rules.
 */
function withoutReportedHooks(hooks: EncodedHooks, diagnostics: ReturnType<typeof normalized>["diagnostics"]) {
  const reported = new Set(diagnostics.map((item) => item.path.join(".")))
  return {
    ...hooks,
    ...Object.fromEntries(
      ConfigHooks.Events.flatMap((event) => {
        const groups = hooks[event]
        if (groups === undefined) return []
        const kept = groups.map((group, groupIndex) => ({
          ...group,
          hooks: group.hooks.filter((_, index) => !reported.has(`hooks.${event}.${groupIndex}.hooks.${index}`)),
        }))
        return [[event, kept]]
      }),
    ),
  }
}

function countHooks(hooks: EncodedHooks) {
  return ConfigHooks.Events.flatMap((event) => hooks[event]?.flatMap((group) => group.hooks) ?? []).length
}

function withoutEmptyCompatibilityContainers(input: Record<string, unknown>) {
  const result = structuredClone(input)
  if (typeof result.mcp === "object" && result.mcp !== null && !Array.isArray(result.mcp)) {
    const mcp = result.mcp as Record<string, unknown>
    const originallyEmpty = !Object.keys(mcp).length
    for (const key of ["servers", "timeout"]) {
      if (
        typeof mcp[key] === "object" &&
        mcp[key] !== null &&
        !Array.isArray(mcp[key]) &&
        !Object.keys(mcp[key]).length
      )
        delete mcp[key]
    }
    if (!originallyEmpty && !Object.keys(mcp).length) delete result.mcp
  }
  if (typeof result.compaction === "object" && result.compaction !== null && !Array.isArray(result.compaction)) {
    const compaction = result.compaction as Record<string, unknown>
    const originallyEmpty = !Object.keys(compaction).length
    if (
      typeof compaction.keep === "object" &&
      compaction.keep !== null &&
      !Array.isArray(compaction.keep) &&
      !Object.keys(compaction.keep).length
    )
      delete compaction.keep
    if (!originallyEmpty && !Object.keys(compaction).length) delete result.compaction
  }
  return result
}

describe("ConfigNormalize", () => {
  test("rejects every non-object root with one root diagnostic", () => {
    for (const input of [null, [], "config", true, 1]) {
      expect(ConfigNormalize.normalize(input)).toEqual({
        type: "rejected",
        diagnostics: [
          {
            kind: "invalid",
            path: ["$"],
            message: "rejected configuration because its root is not an object",
          },
        ],
      })
    }
  })

  test("keeps unrelated native fields when a legacy field is present", () => {
    const result = decoded({ snapshot: false, agents: { reviewer: { system: "Use V2" } } })
    expect(result.snapshots).toBe(false)
    expect(result.agents?.reviewer?.system).toBe("Use V2")
  })

  test("canonicalizes transformed native values through decode then encode", () => {
    const result = normalized({ warming: { interval: "4 minutes", duration: "30 minutes" } })
    expect(result.encoded.warming).toEqual({ interval: "240000 millis", duration: "1800000 millis" })
    const info = Schema.decodeUnknownSync(Info)(result.encoded)
    if (typeof info.warming === "boolean" || info.warming === undefined) throw new Error("expected warming info")
    expect(Duration.toMillis(info.warming.interval ?? Duration.zero)).toBe(240_000)
    expect(Duration.toMillis(info.warming.duration ?? Duration.zero)).toBe(1_800_000)
  })

  test("keeps fallback_model and reports a malformed one", () => {
    expect(normalized({ fallback_model: "acme/backup#high" }).encoded.fallback_model).toEqual({
      providerID: "acme",
      model: "backup",
      variant: "high",
    })
    const invalid = normalized({ fallback_model: 7, share: "auto" })
    expect(invalid.encoded.fallback_model).toBeUndefined()
    expect(invalid.encoded.share).toBe("auto")
    expect(invalid.diagnostics.map((item) => item.kind)).toContain("invalid")
  })

  test("keeps webfetch verbatim hosts and reports a malformed value without touching its siblings", () => {
    expect(decoded({ webfetch: { verbatim_hosts: ["a.example", "*.b.example"] } }).webfetch?.verbatim_hosts).toEqual([
      "a.example",
      "*.b.example",
    ])
    const invalid = normalized({ webfetch: 7, share: "auto" })
    expect(invalid.encoded.webfetch).toBeUndefined()
    expect(invalid.encoded.share).toBe("auto")
    expect(invalid.diagnostics.map((item) => item.path)).toContainEqual(["webfetch"])
  })

  test("keeps output_token_cap", () => {
    expect(normalized({ output_token_cap: 8000 }).encoded.output_token_cap).toBe(8000)
  })

  for (const cap of [0, -1, 1.5]) {
    test(`reports an output_token_cap of ${cap} and keeps its siblings`, () => {
      const invalid = normalized({ output_token_cap: cap, share: "auto" })
      expect(invalid.encoded.output_token_cap).toBeUndefined()
      expect(invalid.encoded.share).toBe("auto")
      expect(invalid.diagnostics.map((item) => item.kind)).toContain("invalid")
    })
  }

  test("keeps the compatibility switch as one native value", () => {
    expect(normalized({ compatibility: { enabled: false } }).encoded.compatibility).toEqual({ enabled: false })
    expect(decoded({ compatibility: { enabled: true } }).compatibility?.enabled).toBe(true)
    // The legacy shape of every other key is untouched by it.
    expect(decoded({ snapshot: false, compatibility: { enabled: false } })).toMatchObject({
      snapshots: false,
      compatibility: { enabled: false },
    })
    // A value that is not a switch is reported and dropped, so it never reaches the decoded config.
    const invalid = normalized({ compatibility: { enabled: "no" } })
    expect(invalid.encoded.compatibility).toBeUndefined()
    expect(invalid.diagnostics.map((item) => item.kind)).toContain("invalid")
  })

  test("keeps a positive tool concurrency cap and reports any other value", () => {
    expect(normalized({ tool_execution: { max_concurrency: 3 } }).encoded.tool_execution).toEqual({
      max_concurrency: 3,
    })
    for (const cap of [0, -2, 1.5, "3"]) {
      const invalid = normalized({ tool_execution: { max_concurrency: cap } })
      expect(invalid.encoded.tool_execution).toBeUndefined()
      expect(invalid.diagnostics.map((item) => item.kind)).toContain("invalid")
    }
  })

  test("preserves arbitrary JSON-round-tripped native configuration", () => {
    FastCheck.assert(
      FastCheck.property(Schema.toArbitrary(Info)(FastCheck), (info) => {
        const generated = JSON.parse(JSON.stringify(Schema.encodeSync(Info)(info)))
        // An agent whose name is not a plain one defines nothing, so it is not expected to come through.
        const source =
          generated.agents === undefined
            ? generated
            : {
                ...generated,
                agents: Object.fromEntries(Object.entries(generated.agents).filter(([name]) => ConfigAgent.isName(name))),
              }
        const result = normalized(source)
        // Normalizing hooks drops the entries their event or hook type cannot honor, and reports each one.
        const expected =
          source.hooks === undefined
            ? source
            : { ...source, hooks: withoutReportedHooks(source.hooks, result.diagnostics) }
        expect(Schema.decodeUnknownSync(Info)(result.encoded)).toEqual(
          Schema.decodeUnknownSync(Info)(withoutEmptyCompatibilityContainers(expected)),
        )
      }),
      { numRuns: 100 },
    )
  })

  test("merges named maps by entry and gives valid native entries precedence", () => {
    const result = normalized({
      reference: { legacy: { path: "../legacy" }, duplicate: { path: "../old" } },
      references: { native: { path: "../native" }, duplicate: { path: "../new" } },
      command: { legacy: { template: "legacy" }, duplicate: { template: "old" } },
      commands: { native: { template: "native" }, duplicate: { template: "new" } },
    })
    expect(result.encoded.references).toEqual({
      legacy: { path: "../legacy" },
      native: { path: "../native" },
      duplicate: { path: "../new" },
    })
    expect(result.encoded.commands).toEqual({
      legacy: { template: "legacy" },
      native: { template: "native" },
      duplicate: { template: "new" },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict").map((item) => item.path)).toEqual([
      ["references", "duplicate"],
      ["commands", "duplicate"],
    ])
  })

  test("does not report canonical-equal duplicates as conflicts", () => {
    const result = normalized({
      snapshot: false,
      snapshots: false,
      reference: { docs: { path: "../docs" } },
      references: { docs: { path: "../docs" } },
      agent: { reviewer: { prompt: "same" } },
      agents: { reviewer: { system: "same" } },
      provider: { custom: { name: "same" } },
      providers: { custom: { name: "same" } },
      compaction: { preserve_recent_tokens: 1000, keep: { tokens: 1000 } },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict")).toEqual([])
  })

  test("uses agent then mode then native agent precedence", () => {
    const result = normalized({
      agent: { reviewer: { prompt: "agent" }, agentOnly: { prompt: "agent-only" } },
      mode: { reviewer: { prompt: "mode" }, modeOnly: { prompt: "mode-only" } },
      agents: { reviewer: { system: "native" }, nativeOnly: { system: "native-only" } },
    })
    expect(result.encoded.agents).toEqual({
      reviewer: { system: "native" },
      agentOnly: { system: "agent-only" },
      modeOnly: { system: "mode-only", mode: "primary" },
      nativeOnly: { system: "native-only" },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict").map((item) => item.path)).toEqual([
      ["agents", "reviewer"],
      ["agents", "reviewer"],
    ])
    expect(() => Schema.decodeUnknownSync(Info)(result.encoded)).not.toThrow()
  })

  test("migrates the legacy small model to the title agent", () => {
    const result = normalized({ small_model: "anthropic/claude-haiku-4-5" })
    expect(result.encoded.agents).toEqual({
      title: {
        model: { providerID: "anthropic", model: "claude-haiku-4-5" },
      },
    })
    expect(result.diagnostics).toEqual([])
  })

  test("merges the legacy small model with the title agent", () => {
    const result = normalized({
      small_model: "anthropic/claude-haiku-4-5",
      agent: { title: { prompt: "Custom title prompt" } },
    })
    expect(result.encoded.agents).toEqual({
      title: {
        model: { providerID: "anthropic", model: "claude-haiku-4-5" },
        system: "Custom title prompt",
      },
    })
    expect(result.diagnostics).toEqual([])
  })

  test("omits an invalid legacy small model without exposing its value", () => {
    const secret = "do-not-log-this-value"
    const result = normalized({ small_model: secret })
    expect(result.encoded.agents).toBeUndefined()
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([["unsupported", ["small_model"]]])
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("recovers malformed named entries and retains a valid legacy collision", () => {
    const result = normalized({
      command: { fallback: { template: "legacy" } },
      commands: {
        fallback: { template: 1 },
        valid: { template: "native" },
        invalid: { template: false },
      },
      providers: {
        valid: { name: "Valid" },
        invalid: { env: [1] },
      },
    })
    expect(result.encoded.commands).toEqual({ fallback: { template: "legacy" }, valid: { template: "native" } })
    expect(result.encoded.providers).toEqual({ valid: { name: "Valid" } })
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["commands", "fallback"],
      ["commands", "invalid"],
      ["providers", "invalid"],
    ])
  })

  test("accepts partial model capabilities without reporting a diagnostic", () => {
    const result = normalized({
      providers: {
        demo: { name: "Demo", models: { demo: { name: "Demo", capabilities: { input: ["text"], output: ["text"] } } } },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(result.encoded.providers).toEqual({
      demo: { name: "Demo", models: { demo: { name: "Demo", capabilities: { input: ["text"], output: ["text"] } } } },
    })
  })

  test("uses a valid retired provider alias when the canonical legacy entry is malformed", () => {
    const result = normalized({
      provider: {
        "azure-cognitive-services": { models: { deployment: {} } },
        azure: { env: [1] },
      },
    })
    expect(result.encoded.providers).toHaveProperty("azure.models.deployment")
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toContainEqual([
      "provider",
      "azure",
    ])
  })

  test("preserves permission source order and appends native rules", () => {
    expect(
      normalized({
        tools: { bash: true, write: false },
        permission: { read: "allow", custom: { first: "deny", second: "ask" }, task: "allow" },
        permissions: [{ action: "native", resource: "*", effect: "deny" }],
      }).encoded.permissions,
    ).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "custom", resource: "first", effect: "deny" },
      { action: "custom", resource: "second", effect: "ask" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "native", resource: "*", effect: "deny" },
    ])
  })

  test("redacts permission resource keys from invalid diagnostics", () => {
    const result = normalized({
      permission: { bash: { "curl -H Authorization:Bearer TOPSECRET *": "bogus" } },
    })
    expect(result.diagnostics).toEqual([
      {
        kind: "invalid",
        path: ["permission", "bash", "0"],
        message: "skipped malformed recognized value",
      },
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain("TOPSECRET")
  })

  test("recovers list items for skills, instructions, and permissions", () => {
    const result = normalized({
      skills: { paths: ["./skills", 1], urls: [false, "https://example.com/skills"] },
      instructions: ["one", 2, "three"],
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "invalid" },
      ],
    })
    expect(result.encoded.skills).toEqual(["./skills", "https://example.com/skills"])
    expect(result.encoded.instructions).toEqual(["one", "three"])
    expect(result.encoded.permissions).toEqual([{ action: "read", resource: "*", effect: "allow" }])
    expect(result.diagnostics.filter((item) => item.kind === "invalid")).toHaveLength(4)
  })

  test("recovers list items for instructions_exclude, and reports each one that is not text", () => {
    const result = normalized({ instructions_exclude: ["**/a/**", 2, null, "/b/AGENTS.md", { x: 1 }] })
    expect(result.encoded.instructions_exclude).toEqual(["**/a/**", "/b/AGENTS.md"])
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["instructions_exclude", "1"],
      ["instructions_exclude", "2"],
      ["instructions_exclude", "4"],
    ])
  })

  test("omits an instructions_exclude that is not a list, and keeps the empty list it was given", () => {
    const bad = normalized({ instructions_exclude: "**/AGENTS.md", instructions: ["one"] })
    expect(bad.encoded).not.toHaveProperty("instructions_exclude")
    expect(bad.encoded.instructions).toEqual(["one"])
    expect(bad.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["instructions_exclude"],
    ])
    expect(normalized({ instructions_exclude: [] }).encoded.instructions_exclude).toEqual([])
    expect(normalized({}).encoded).not.toHaveProperty("instructions_exclude")
  })

  test("omits malformed collection roots instead of synthesizing empty values", () => {
    const result = normalized({
      commands: [],
      providers: "invalid",
      references: false,
      agents: 1,
      permissions: {},
      instructions: {},
    })
    expect(result.encoded).toEqual({})
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["references"],
      ["commands"],
      ["agents"],
      ["providers"],
      ["permissions"],
      ["instructions"],
    ])
  })

  test("omits all-invalid formatter and LSP maps while preserving explicit empty maps", () => {
    const invalid = normalized({
      formatter: { prettier: { command: [1] } },
      lsp: { typescript: { command: [1] } },
    })
    expect(invalid.encoded).not.toHaveProperty("formatter")
    expect(invalid.encoded).not.toHaveProperty("lsp")
    expect(invalid.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["formatter", "prettier"],
      ["lsp", "typescript"],
    ])

    expect(normalized({ formatter: {}, lsp: {} }).encoded).toMatchObject({ formatter: {}, lsp: {} })
  })

  test("combines legacy and native MCP servers and merges timeout leaves", () => {
    const result = normalized({
      experimental: { mcp_timeout: 5000 },
      mcp: {
        legacy: { type: "local", command: ["legacy"] },
        duplicate: { type: "remote", url: "https://legacy.example.com" },
        servers: {
          native: { type: "local", command: ["native"] },
          duplicate: { type: "remote", url: "https://native.example.com" },
          invalid: { type: "local", command: [1] },
        },
        timeout: { startup: 1000, catalog: 6000 },
      },
    })
    expect(result.encoded.mcp).toEqual({
      timeout: { catalog: 6000, execution: 5000, startup: 1000 },
      servers: {
        legacy: { type: "local", command: ["legacy"], disabled: undefined, timeout: undefined },
        duplicate: { type: "remote", url: "https://native.example.com" },
        native: { type: "local", command: ["native"] },
      },
    })
    expect(
      result.diagnostics.some((item) => item.kind === "conflict" && item.path.join(".") === "mcp.servers.duplicate"),
    ).toBe(true)
    expect(
      result.diagnostics.some((item) => item.kind === "conflict" && item.path.join(".") === "mcp.timeout.catalog"),
    ).toBe(true)
    expect(
      result.diagnostics.some((item) => item.kind === "invalid" && item.path.join(".") === "mcp.servers.invalid"),
    ).toBe(true)
  })

  test("uses raw MCP discriminators for reserved server names", () => {
    const result = normalized({
      mcp: {
        servers: { type: "local", command: ["reserved-servers"] },
        timeout: { type: "remote", url: "https://reserved.example.com" },
      },
    })
    expect((result.encoded.mcp as { servers: Record<string, unknown> }).servers).toEqual({
      servers: { type: "local", command: ["reserved-servers"], disabled: undefined, timeout: undefined },
      timeout: { type: "remote", url: "https://reserved.example.com", disabled: undefined, timeout: undefined },
    })

    const enabledOnly = normalized({ mcp: { servers: { enabled: true }, timeout: { enabled: false } } })
    expect(enabledOnly.encoded.mcp).toBeUndefined()
    expect(enabledOnly.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["unsupported", ["mcp", "servers"]],
      ["unsupported", ["mcp", "timeout"]],
    ])
  })

  test("normalizes MCP timeout fields in schema order with per-leaf recovery", () => {
    const result = normalized({ mcp: { timeout: { execution: 3000, startup: "invalid", catalog: 2000 } } })

    expect(result.encoded.mcp).toEqual({ timeout: { catalog: 2000, execution: 3000 } })
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["invalid", ["mcp", "timeout", "startup"]],
    ])
    expect(normalized({ mcp: { timeout: {} } }).encoded.mcp).toBeUndefined()

    const unknown = normalized({ mcp: { timeout: { unknown: 1000 } } })
    expect(unknown.encoded.mcp).toBeUndefined()
    expect(unknown.diagnostics.map((item) => [item.kind, item.path])).toEqual([["invalid", ["mcp", "timeout"]]])
  })

  test("merges bounded compaction leaves and omits unsupported leaves", () => {
    const result = normalized({
      compaction: {
        auto: false,
        preserve_recent_tokens: 1000,
        keep: { tokens: 2000 },
        reserved: 3000,
        buffer: 4000,
        tail_turns: 2,
        prune: true,
      },
    })
    expect(result.encoded.compaction).toEqual({ auto: false, keep: { tokens: 2000 }, buffer: 4000 })
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["unsupported", ["compaction", "tail_turns"]],
      ["unsupported", ["compaction", "prune"]],
      ["conflict", ["compaction", "keep", "tokens"]],
      ["conflict", ["compaction", "buffer"]],
    ])
  })

  test("distinguishes empty, mixed, and wholly malformed enabled provider lists", () => {
    expect(normalized({ enabled_providers: [] }).encoded.experimental).toEqual({
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
    })
    expect(normalized({ enabled_providers: [1, "anthropic", false] }).encoded.experimental).toEqual({
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "anthropic", effect: "allow" },
      ],
    })
    expect(normalized({ enabled_providers: [1, false] }).encoded.experimental).toBeUndefined()
    expect(normalized({ enabled_providers: "anthropic" }).encoded.experimental).toBeUndefined()
  })

  test("appends native policies after migrated provider policies", () => {
    expect(
      normalized({
        enabled_providers: ["anthropic"],
        disabled_providers: ["openai"],
        experimental: {
          portable_shell_scanner: true,
          subagent_depth: 0,
          policies: [{ action: "provider.use", resource: "custom", effect: "allow" }],
        },
      }).encoded.experimental,
    ).toEqual({
      portable_shell_scanner: true,
      subagent_depth: 0,
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "anthropic", effect: "allow" },
        { action: "provider.use", resource: "openai", effect: "deny" },
        { action: "provider.use", resource: "custom", effect: "allow" },
      ],
    })
  })

  test("keeps the setting that lets Code Mode fetch reach local servers, and drops a value that is not a boolean", () => {
    expect(normalized({ experimental: { allow_local_fetch: true } }).encoded.experimental).toEqual({
      allow_local_fetch: true,
    })
    expect(normalized({ experimental: { allow_local_fetch: false } }).encoded.experimental).toEqual({
      allow_local_fetch: false,
    })

    const invalid = normalized({ experimental: { allow_local_fetch: "yes" } })
    expect(invalid.encoded.experimental).toBeUndefined()
    expect(invalid.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["invalid", ["experimental", "allow_local_fetch"]],
    ])
  })

  test("reports unsupported legacy settings without including their values", () => {
    const secret = "do-not-log-this-value"
    const result = normalized({
      logLevel: "DEBUG",
      agent: { reviewer: { name: secret, prompt: "review" } },
      provider: {
        custom: {
          id: secret,
          whitelist: ["model"],
          models: {
            model: {
              release_date: secret,
              status: "active",
              interleaved: true,
            },
          },
        },
      },
      experimental: { openTelemetry: true },
    })
    expect(result.diagnostics.filter((item) => item.kind === "unsupported").map((item) => item.path)).toEqual([
      ["logLevel"],
      ["agent", "reviewer", "name"],
      ["provider", "custom", "id"],
      ["provider", "custom", "whitelist"],
      ["provider", "custom", "models", "model", "release_date"],
      ["provider", "custom", "models", "model", "status"],
      ["provider", "custom", "models", "model", "interleaved"],
      ["experimental", "openTelemetry"],
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("diagnoses unsupported legacy model selections without dropping their entries", () => {
    const result = normalized({
      command: {
        invalidModel: { template: "one", model: "invalid" },
        invalidVariant: { template: "two", model: "anthropic/model", variant: "bad#variant" },
        missingModel: { template: "three", variant: "high" },
      },
      agent: { invalid: { prompt: "agent", model: "invalid", variant: "" } },
    })
    expect(Object.keys(result.encoded.commands as Record<string, unknown>)).toEqual([
      "invalidModel",
      "invalidVariant",
      "missingModel",
    ])
    expect(Object.keys(result.encoded.agents as Record<string, unknown>)).toEqual(["invalid"])
    expect(result.diagnostics.filter((item) => item.kind === "unsupported").map((item) => item.path)).toEqual([
      ["command", "invalidModel", "model"],
      ["command", "invalidVariant", "variant"],
      ["command", "missingModel", "variant"],
      ["agent", "invalid", "model"],
      ["agent", "invalid", "variant"],
    ])
  })

  test("invalid legacy provider overlays skip only that provider", () => {
    const result = normalized({
      provider: {
        headers: { options: { headers: { valid: "yes", invalid: 1 } } },
        body: { options: { body: "not-an-object" } },
        valid: { options: { headers: { valid: "yes" }, body: { trace: true } } },
      },
    })
    expect(result.encoded.providers).toEqual({
      valid: { settings: {}, headers: { valid: "yes" }, body: { trace: true } },
    })
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["provider", "headers", "options", "headers"],
      ["provider", "body", "options", "body"],
    ])
  })

  test("preserves explicit false, zero, empty list, and empty map presence", () => {
    const result = normalized({
      snapshot: false,
      autoshare: false,
      references: {},
      commands: {},
      agents: {},
      providers: {},
      instructions: [],
      experimental: { subagent_depth: 0 },
    })
    expect(result.encoded).toMatchObject({
      snapshots: false,
      references: {},
      commands: {},
      agents: {},
      providers: {},
      instructions: [],
      experimental: { subagent_depth: 0 },
    })
    expect(result.encoded.share).toBeUndefined()
  })

  describe("hooks", () => {
    const command = (text: string) => ({ type: "command", command: text })
    const reported = (result: ReturnType<typeof normalized>) =>
      result.diagnostics.map((item) => [item.kind, item.path.join(".")])

    test("keeps hooks written for the original six events unchanged", () => {
      const hooks = {
        PreToolUse: [{ matcher: "edit|write", hooks: [{ type: "command", command: "./lint.sh", timeout: 30 }] }],
        PostToolUse: [{ matcher: "read", hooks: [command("./audit.sh")] }],
        UserPromptSubmit: [{ hooks: [command("./context.sh")] }],
        SessionStart: [{ hooks: [command("./warm.sh")] }],
        Stop: [{ hooks: [command("./notify.sh")] }],
        PreCompact: [{ hooks: [command("./save.sh")] }],
      }
      const result = normalized({ hooks })
      expect(result.encoded.hooks).toEqual(hooks)
      expect(result.diagnostics).toEqual([])
    })

    test("keeps a valid command next to a malformed http entry and reports the exact path", () => {
      const secret = "do-not-log-this-value"
      const result = normalized({
        hooks: {
          PreToolUse: [{ matcher: "shell", hooks: [command("./guard.sh"), { type: "http", url: { secret } }] }],
        },
      })
      expect(result.encoded.hooks).toEqual({ PreToolUse: [{ matcher: "shell", hooks: [command("./guard.sh")] }] })
      expect(result.diagnostics).toEqual([
        {
          kind: "invalid",
          path: ["hooks", "PreToolUse", "0", "hooks", "1"],
          message: "skipped malformed recognized value",
        },
      ])
      expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
      expect<unknown>(decoded({ hooks: result.encoded.hooks }).hooks?.PreToolUse?.[0]?.hooks).toEqual([
        command("./guard.sh"),
      ])
    })

    test("reports an unknown event as unsupported and keeps the known ones", () => {
      const result = normalized({
        hooks: { SessionStart: [{ hooks: [command("echo ready")] }], BeforeEverything: [{ hooks: [command("x")] }] },
      })
      expect(result.encoded.hooks).toEqual({ SessionStart: [{ hooks: [command("echo ready")] }] })
      expect(reported(result)).toEqual([["unsupported", "hooks.BeforeEverything"]])
    })

    test("reports a prompt or agent hook on an event that cannot judge as unsupported", () => {
      const prompt = { type: "prompt", prompt: "Is this safe?" }
      const agent = { type: "agent", prompt: "Verify the change" }
      const result = normalized({
        hooks: {
          SessionStart: [{ hooks: [prompt, agent, command("echo ready")] }],
          PreToolUse: [{ hooks: [prompt, agent] }],
        },
      })
      expect(result.encoded.hooks).toEqual({
        SessionStart: [{ hooks: [command("echo ready")] }],
        PreToolUse: [{ hooks: [prompt, agent] }],
      })
      expect(reported(result)).toEqual([
        ["unsupported", "hooks.SessionStart.0.hooks.0"],
        ["unsupported", "hooks.SessionStart.0.hooks.1"],
      ])
    })

    test("reports async on a hook that is not a command, or on WorktreeCreate, as unsupported", () => {
      const http = { type: "http", url: "https://hooks.example.com/event" }
      const result = normalized({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { ...http, async: true },
                { type: "agent", prompt: "Verify the change", async_rewake: true },
                // Anything but an explicit false asks for a background hook, so it is not quietly run in the foreground.
                { ...http, async: "yes" },
                { ...command("./background.sh"), async: true },
                { ...http, async: false },
              ],
            },
          ],
          WorktreeCreate: [
            {
              hooks: [
                { ...command("./create.sh"), async: true },
                { ...command("./rewake.sh"), async_rewake: true },
              ],
            },
            { hooks: [command("./create.sh")] },
          ],
        },
      })
      // An http hook that asks not to be async is still a plain http hook. The schema has no field for the setting, so
      // only the setting is reported, like any other key without a field.
      expect(result.encoded.hooks).toEqual({
        PreToolUse: [{ hooks: [{ ...command("./background.sh"), async: true }, http] }],
        WorktreeCreate: [{ hooks: [] }, { hooks: [command("./create.sh")] }],
      })
      expect(reported(result)).toEqual([
        ["unsupported", "hooks.PreToolUse.0.hooks.0"],
        ["unsupported", "hooks.PreToolUse.0.hooks.1"],
        ["unsupported", "hooks.PreToolUse.0.hooks.2"],
        ["unsupported", "hooks.PreToolUse.0.hooks.4.async"],
        ["unsupported", "hooks.WorktreeCreate.0.hooks.0"],
        ["unsupported", "hooks.WorktreeCreate.0.hooks.1"],
      ])
    })

    test("reports keys that no field names and keeps the entries that carried them", () => {
      const result = normalized({
        hooks: {
          PreToolUse: [
            // A misspelled matcher leaves a group that matches everything, so the author is told.
            { matchers: "shell", hooks: [command("./guard.sh")] },
            {
              hooks: [
                // Fields written in camelCase, as other tools spell them, have no field here either.
                { ...command("./audit.sh"), statusMessage: "Auditing", asyncRewake: true },
                { type: "http", url: "https://hooks.example.com/event", allowedEnvVars: ["TOKEN"] },
                // A field that only another hook type has is unknown on this one.
                { type: "prompt", prompt: "Is this safe?", command: "./nope.sh" },
              ],
            },
          ],
          http: { allowed_url: ["https://hooks.example.com/*"], allowed_env_vars: ["TOKEN"] },
        },
      })
      expect(result.encoded.hooks).toEqual({
        PreToolUse: [
          { hooks: [command("./guard.sh")] },
          {
            hooks: [
              command("./audit.sh"),
              { type: "http", url: "https://hooks.example.com/event" },
              { type: "prompt", prompt: "Is this safe?" },
            ],
          },
        ],
        http: { allowed_env_vars: ["TOKEN"] },
      })
      expect(reported(result)).toEqual([
        ["unsupported", "hooks.PreToolUse.0.matchers"],
        ["unsupported", "hooks.PreToolUse.1.hooks.0.statusMessage"],
        ["unsupported", "hooks.PreToolUse.1.hooks.0.asyncRewake"],
        ["unsupported", "hooks.PreToolUse.1.hooks.1.allowedEnvVars"],
        ["unsupported", "hooks.PreToolUse.1.hooks.2.command"],
        ["unsupported", "hooks.http.allowed_url"],
      ])
    })

    test("keeps every field of every hook type", () => {
      const model = { providerID: "acme", model: "fast-model", variant: "high" }
      const shared = { timeout: 45, status_message: "Checking the change", once: true, if: "shell(git *)" }
      const written = [
        {
          type: "command",
          command: "./check.sh",
          shell: "powershell",
          async: true,
          async_rewake: false,
          ...shared,
        },
        { type: "prompt", prompt: "Is this safe?", model, ...shared },
        { type: "agent", prompt: "Verify the change", model, ...shared },
        {
          type: "http",
          url: "https://hooks.example.com/pre",
          headers: { Authorization: "Bearer $TOKEN" },
          allowed_env_vars: ["TOKEN"],
          ...shared,
        },
      ]
      // The example has to keep naming every field, including the ones that later changes add.
      ConfigHooks.Hook.members.forEach((member) => {
        const hook = written.find((item) => item.type === member.fields.type.literal)
        expect(Object.keys(hook ?? {}).toSorted()).toEqual(Object.keys(member.fields).toSorted())
      })
      const hooks = {
        PreToolUse: [{ matcher: "shell|edit", hooks: written }],
        disabled: false,
        managed_only: true,
        http: { allowed_urls: ["https://hooks.example.com/*"], allowed_env_vars: ["TOKEN"] },
      }
      const result = normalized({ hooks })
      expect(result.diagnostics).toEqual([])
      expect(result.encoded.hooks).toEqual(hooks)
      expect(decoded({ hooks }).hooks).toMatchObject(hooks)
    })

    test("round-trips disabled, managed_only and http limits", () => {
      const hooks = {
        disabled: true,
        managed_only: false,
        http: { allowed_urls: ["https://hooks.example.com/*"], allowed_env_vars: ["TOKEN"] },
      }
      const result = normalized({ hooks })
      expect(result.encoded.hooks).toEqual(hooks)
      expect(result.diagnostics).toEqual([])
      expect(decoded({ hooks }).hooks).toMatchObject(hooks)
    })

    test("recovers each malformed policy value on its own", () => {
      const result = normalized({
        hooks: {
          disabled: "yes",
          managed_only: true,
          http: { allowed_urls: "https://hooks.example.com/*", allowed_env_vars: ["TOKEN"] },
        },
      })
      expect(result.encoded.hooks).toEqual({ managed_only: true, http: { allowed_env_vars: ["TOKEN"] } })
      expect(reported(result)).toEqual([
        ["invalid", "hooks.disabled"],
        ["invalid", "hooks.http.allowed_urls"],
      ])
    })

    test("skips malformed containers without touching their siblings", () => {
      const result = normalized({
        hooks: {
          PreToolUse: "oops",
          PostToolUse: [
            "oops",
            // A group with a malformed matcher is dropped whole, never widened into one that matches everything.
            { matcher: 7, hooks: [command("dropped")] },
            { hooks: "oops" },
            { matcher: "read", hooks: [command("kept")] },
          ],
        },
      })
      expect(result.encoded.hooks).toEqual({ PostToolUse: [{ matcher: "read", hooks: [command("kept")] }] })
      expect(reported(result)).toEqual([
        ["invalid", "hooks.PreToolUse"],
        ["invalid", "hooks.PostToolUse.0"],
        ["invalid", "hooks.PostToolUse.1"],
        ["invalid", "hooks.PostToolUse.2"],
      ])
    })

    test("omits a hooks value that is not an object and keeps explicit empty ones", () => {
      const invalid = normalized({ hooks: [] })
      expect(invalid.encoded).not.toHaveProperty("hooks")
      expect(reported(invalid)).toEqual([["invalid", "hooks"]])

      const empty = normalized({ hooks: { Stop: [], PreToolUse: [{ hooks: [] }] } })
      expect(empty.encoded.hooks).toEqual({ Stop: [], PreToolUse: [{ hooks: [] }] })
      expect(empty.diagnostics).toEqual([])
      expect(normalized({ hooks: {} }).encoded.hooks).toEqual({})
    })

    test("canonicalizes the model of prompt and agent hooks and skips a malformed one", () => {
      const result = normalized({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "prompt", prompt: "Done?", model: "acme/fast-model" },
                { type: "agent", prompt: "Check", model: "no-provider" },
              ],
            },
          ],
        },
      })
      expect(result.encoded.hooks).toEqual({
        Stop: [{ hooks: [{ type: "prompt", prompt: "Done?", model: { providerID: "acme", model: "fast-model" } }] }],
      })
      expect(reported(result)).toEqual([["invalid", "hooks.Stop.0.hooks.1"]])
    })

    test("keeps every hook it does not report, field for field, in arbitrary schema-valid hooks", () => {
      FastCheck.assert(
        FastCheck.property(Schema.toArbitrary(ConfigHooks.Info)(FastCheck), (hooks) => {
          const encoded = Schema.encodeSync(ConfigHooks.Info)(hooks)
          const result = normalized({ hooks: encoded })
          // Valid hooks are never malformed, so a skipped one is one that its event or type cannot honor.
          expect(result.diagnostics.every((item) => item.kind === "unsupported")).toBe(true)
          // Everything else comes through unchanged, and every report names a hook that was there.
          const kept = withoutReportedHooks(encoded, result.diagnostics)
          expect(result.encoded.hooks).toEqual(kept)
          expect(countHooks(kept) + result.diagnostics.length).toBe(countHooks(encoded))
        }),
        { numRuns: 100 },
      )
    })
  })
})

describe("ConfigNormalize agent definitions", () => {
  test("migrates an orbit.json agent whose tools is a map of booleans, and keeps the entry", () => {
    const result = normalized({ agents: { reviewer: { description: "Reviews", tools: { edit: false } } } })
    expect(result.encoded.agents).toEqual({
      reviewer: { description: "Reviews", permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
    })
  })

  test("reads a string or a list of tools as the native allow list", () => {
    const input = { agents: { a: { tools: "read, grep" }, b: { tools: ["read"] } } }
    expect(decoded(input).agents?.a?.tools).toEqual(["read", "grep"])
    expect(normalized(input).diagnostics).toEqual([])
  })

  test.each(["fast", "default", "sonnet", "not a model", 3])("drops the model %p with a diagnostic and keeps the agent", (model) => {
    const result = normalized({ agents: { a: { description: "Kept", model } } })
    expect(result.encoded.agents).toEqual({ a: { description: "Kept" } })
    expect(result.diagnostics.map((item) => [item.kind, item.path.join(".")])).toEqual([["invalid", "agents.a.model"]])
  })

  test.each([
    [" Inherit ", "inherit"],
    ["SMALL", "small"],
    ["large", "large"],
  ])("reads the model alias %p", (model, tier) => {
    expect<unknown>(decoded({ agents: { a: { model } } }).agents?.a?.model).toBe(tier)
  })

  test("keeps the fields of an agent that decode and drops each bad one on its own", () => {
    const result = normalized({
      agents: {
        a: { description: "Kept", max_turns: 0, memory: "global", isolation: "remote", background: "yes", effort: "a#b" },
      },
    })
    expect(result.encoded.agents).toEqual({ a: { description: "Kept" } })
    expect(result.diagnostics.map((item) => item.path.join(".")).toSorted()).toEqual([
      "agents.a.background",
      "agents.a.effort",
      "agents.a.isolation",
      "agents.a.max_turns",
      "agents.a.memory",
    ])
  })

  test("keeps the good items of mcp_servers and drops the others", () => {
    const local = { type: "local", command: ["x"] }
    const parsed = decoded({ agents: { a: { mcp_servers: ["docs", 42, { one: local }, { one: local, two: local }] } } })
    expect<unknown>(parsed.agents?.a?.mcp_servers).toEqual(["docs", { one: local }])
  })

  test.each(["../x", "a\\b", "a:b", "a b", "", ".hidden", "nul", "con.txt", "a/../b", "a//b", "x".repeat(65)])(
    "defines no agent for the name %p, in agents, agent and mode, and the sibling loads",
    (name) => {
      const result = normalized({
        agents: { [name]: { description: "bad" }, ok: { description: "ok" } },
        agent: { [name]: { description: "bad" }, legacy: { description: "ok" } },
        mode: { [name]: { description: "bad" }, modal: { description: "ok" } },
      })
      expect(Object.keys(result.encoded.agents as object).toSorted()).toEqual(["legacy", "modal", "ok"])
      expect(result.diagnostics.map((item) => item.path.join("."))).toEqual(
        ["agent", "mode", "agents"].map((key) => [key, name].join(".")),
      )
    },
  )

  test("keeps a nested agent name", () => {
    expect(Object.keys(normalized({ agents: { "team/helper": { description: "ok" } } }).encoded.agents as object)).toEqual([
      "team/helper",
    ])
  })

  test("normalizes model_aliases field by field", () => {
    const result = normalized({ model_aliases: { small: "acme/cheap", large: "no-provider" } })
    expect(result.encoded.model_aliases).toEqual({ small: { providerID: "acme", model: "cheap" } })
    expect(result.diagnostics.map((item) => item.path.join("."))).toEqual(["model_aliases.large"])
  })
})
