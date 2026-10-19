export * as ConfigNormalize from "./normalize.js"

import { isDeepStrictEqual } from "node:util"
import { isRecord } from "@orbit/ai/utils/record"
import { Option, Schema } from "effect"
import { Info } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigCommand } from "@orbit/schema/config/command"
import { ConfigCompaction } from "@orbit/schema/config/compaction"
import { ConfigFormatter } from "@orbit/schema/config/formatter"
import { EnvConfig } from "@orbit/schema/config/env-config"
import { HookConfig } from "@orbit/schema/config/hook-config"
import { ConfigLSP } from "@orbit/schema/config/lsp"
import { ConfigMedia } from "@orbit/schema/config/media"
import { ConfigMCP } from "@orbit/schema/config/mcp"
import { ConfigPlugin } from "@orbit/schema/config/plugin"
import { ConfigPolicy } from "@orbit/schema/config/policy"
import { ConfigProvider } from "@orbit/schema/config/provider"
import { ConfigReference } from "@orbit/schema/config/reference"
import { ConfigExperimental } from "@orbit/schema/config/experimental"
import { Permission } from "@orbit/schema/permission"
import { ConfigAgentV1 } from "../v1/config/agent.js"
import { LegacyAgent } from "./legacy-agent.js"
import { ConfigAttachmentV1 } from "../v1/config/attachment.js"
import { ConfigCommandV1 } from "../v1/config/command.js"
import { ConfigMCPV1 } from "../v1/config/mcp.js"
import { ConfigPermissionV1 } from "../v1/config/permission.js"
import { ConfigPluginV1 } from "../v1/config/plugin.js"
import { ConfigProviderV1 } from "../v1/config/provider.js"
import { ConfigV1 } from "../v1/config/config.js"
import { ConfigMigrateV1 } from "../v1/config/migrate.js"
import { PositiveInt } from "../schema.js"

export interface Diagnostic {
  readonly kind: "conflict" | "invalid" | "unsupported"
  readonly path: readonly string[]
  readonly message: string
}

export type Result =
  | {
      readonly type: "normalized"
      readonly encoded: Readonly<Record<string, unknown>>
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly type: "rejected"; readonly diagnostics: readonly Diagnostic[] }

const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const unsupportedTopLevel = ["logLevel", "server", "subagent_depth", "layout"] as const
const unsupportedExperimental = [
  "disable_paste_summary",
  "batch_tool",
  "openTelemetry",
  "primary_tools",
  "continue_loop_on_deny",
] as const
const unsupportedProvider = ["id", "whitelist", "blacklist"] as const
const unsupportedModel = ["release_date", "attachment", "reasoning", "temperature", "experimental"] as const

export function normalize(input: unknown): Result {
  if (!isRecord(input))
    return {
      type: "rejected",
      diagnostics: [
        { kind: "invalid", path: ["$"], message: "rejected configuration because its root is not an object" },
      ],
    }

  const diagnostics: Diagnostic[] = []
  const encoded: Record<string, unknown> = {}
  unsupportedTopLevel.forEach((key) => unsupportedIfPresent(input, key, [key], diagnostics))
  // Restrictions are read from managed settings files, which split `managed` off before they get here. In any other
  // document the key never takes effect.
  if (own(input, "managed"))
    diagnostics.push({
      kind: "unsupported",
      path: ["managed"],
      message: "ignored managed restrictions outside the managed settings files",
    })

  const legacySnapshots = own(input, "snapshot")
    ? decodeEncoded(Schema.Boolean, input.snapshot, ["snapshot"], diagnostics)
    : undefined
  const legacyUpdate = own(input, "autoupdate")
    ? decodeValue(ConfigV1.Info.fields.autoupdate, input.autoupdate, ["autoupdate"], diagnostics)
    : undefined
  const nativeUpdate = own(input, "update")
    ? decodeEncoded(Info.fields.update, input.update, ["update"], diagnostics)
    : undefined
  const legacyShare = own(input, "autoshare")
    ? decodeValue(Schema.Boolean, input.autoshare, ["autoshare"], diagnostics) === true
      ? "auto"
      : undefined
    : undefined
  const legacyMedia = own(input, "attachment")
    ? decodeValue(ConfigAttachmentV1.Info, input.attachment, ["attachment"], diagnostics)
    : undefined
  if (legacyMedia !== undefined) {
    const migrated = ConfigMigrateV1.migrate({ attachment: legacyMedia }).media
    if (migrated !== undefined) encoded.media = canonical(ConfigMedia.Info, migrated)
  }
  if (legacySnapshots !== undefined) encoded.snapshots = legacySnapshots
  const migratedUpdate =
    legacyUpdate === undefined ? undefined : ConfigMigrateV1.migrate({ autoupdate: legacyUpdate }).update
  const update = prefer(migratedUpdate, nativeUpdate, ["update"], diagnostics)
  if (update !== undefined) encoded.update = update
  if (legacyShare !== undefined) encoded.share = legacyShare

  const legacyReferences = decodeMap(input.reference, ConfigReference.Entry, ["reference"], diagnostics, decodeEncoded)
  const nativeReferences = decodeMap(
    input.references,
    ConfigReference.Entry,
    ["references"],
    diagnostics,
    decodeEncoded,
  )
  mergeMap(
    encoded,
    "references",
    legacyReferences,
    nativeReferences,
    isRecord(input.reference) || isRecord(input.references),
    diagnostics,
  )

  const legacyCommands = decodeMap(input.command, ConfigCommandV1.Info, ["command"], diagnostics, decodeValue)
  diagnoseSelectionMap(input.command, ["command"], diagnostics)
  const migratedCommands = mapValues(legacyCommands, (value) => {
    const migrated = ConfigMigrateV1.commands({ value })?.value
    return migrated === undefined ? undefined : canonical(ConfigCommand.Info, migrated)
  })
  const nativeCommands = decodeMap(input.commands, ConfigCommand.Info, ["commands"], diagnostics, decodeEncoded)
  mergeMap(
    encoded,
    "commands",
    migratedCommands,
    nativeCommands,
    isRecord(input.command) || isRecord(input.commands),
    diagnostics,
  )

  const legacyAgents = mapValues(
    decodeMap(
      preparedEntries(plainNames(input.agent, ["agent"], diagnostics), ["agent"], diagnostics, true),
      ConfigAgentV1.Info,
      ["agent"],
      diagnostics,
      (schema, value, at, found) => decodeFields(schema, value, at, found),
    ),
    (value) => canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent(value as ConfigAgentV1.Info)),
  )
  const legacySmallModel = own(input, "small_model")
    ? decodeValue(Schema.String, input.small_model, ["small_model"], diagnostics)
    : undefined
  const migratedSmallModel = legacySmallModel
    ? ConfigMigrateV1.migrate({ small_model: legacySmallModel }).agents?.title?.model
    : undefined
  if (legacySmallModel && !migratedSmallModel)
    diagnostics.push({
      kind: "unsupported",
      path: ["small_model"],
      message: "omitted unsupported legacy model reference",
    })
  if (migratedSmallModel)
    legacyAgents.title = {
      model: migratedSmallModel,
      ...legacyAgents.title,
    }
  const modeAgents = mapValues(
    decodeMap(
      preparedEntries(plainNames(input.mode, ["mode"], diagnostics), ["mode"], diagnostics, true),
      ConfigAgentV1.Info,
      ["mode"],
      diagnostics,
      (schema, value, at, found) => decodeFields(schema, value, at, found),
    ),
    (value) => canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent({ ...(value as ConfigAgentV1.Info), mode: "primary" })),
  )
  const migratedAgents = mergeMaps(legacyAgents, modeAgents, ["agents"], diagnostics)
  // An entry whose tools is a map of tool names to booleans is written in the legacy v1 style: its legacy fields migrate
  // and its native fields decode on their own, then the two halves join; a string or a list of tools is native.
  const named = plainNames(input.agents, ["agents"], diagnostics)
  // Keys written for another product are set aside with one diagnostic each, in every entry, so none of them reaches the
  // provider as a request option; a variant beside a model is settled the way the Markdown door settles it.
  const agentEntries = isRecord(named)
    ? Object.fromEntries(
        Object.entries(named).map(([id, entry]) => {
          if (!isRecord(entry)) return [id, entry]
          const prepared = LegacyAgent.prepare(entry)
          prepared.notes.forEach((note) =>
            diagnostics.push({ kind: "unsupported", path: ["agents", id, note.key], message: note.message }),
          )
          return [id, prepared.entry]
        }),
      )
    : named
  const isLegacyEntry = (entry: unknown): entry is Record<string, unknown> =>
    isRecord(entry) && isPlainRecord(entry.tools)
  const entries = isRecord(agentEntries) ? Object.entries(agentEntries) : []
  // Its legacy half (the map and the keys only that format has) is decoded field by field and migrated; its native half
  // is decoded on its own and put over the result, so a bad field on either side costs only itself and the deny rules
  // written beside the map stay.
  const splits = Object.fromEntries(
    entries.flatMap(([id, entry]) => (isLegacyEntry(entry) ? [[id, LegacyAgent.split(entry)] as const] : [])),
  )
  const legacyNative = decodeMap(
    Object.fromEntries(
      Object.entries(splits)
        .filter(([, parts]) => Object.keys(parts.native).length > 0)
        .map(([id, parts]) => [id, parts.native]),
    ),
    ConfigAgent.Info,
    ["agents"],
    diagnostics,
    (schema, value, at, found) => decodeFields(schema, value, at, found, "permissions"),
  )
  const legacyDecoded = decodeMap(
    Object.fromEntries(
      Object.entries(splits)
        .filter(([, parts]) => Object.keys(parts.legacy).length > 0)
        .map(([id, parts]) => [id, parts.legacy]),
    ),
    ConfigAgentV1.Info,
    ["agents"],
    diagnostics,
    (schema, value, at, found) => decodeFields(schema, value, at, found),
  )
  const nativeAgents = {
    ...decodeMap(
      isRecord(agentEntries) ? Object.fromEntries(entries.filter(([, entry]) => !isLegacyEntry(entry))) : agentEntries,
      ConfigAgent.Info,
      ["agents"],
      diagnostics,
      (schema, value, at, found) => decodeFields(schema, value, at, found, "permissions"),
    ),
    ...Object.fromEntries(
      Object.keys(splits).map((id) => {
        const legacy = legacyDecoded[id]
        return [
          id,
          canonical(
            ConfigAgent.Info,
            LegacyAgent.merge(
              legacy === undefined
                ? {}
                : (ConfigMigrateV1.migrateAgent(legacy as ConfigAgentV1.Info) as Record<string, unknown>),
              (legacyNative[id] ?? {}) as Record<string, unknown>,
            ),
          ),
        ]
      }),
    ),
  }
  diagnoseAgentUnsupported(input.agent, ["agent"], diagnostics)
  diagnoseAgentUnsupported(input.mode, ["mode"], diagnostics)
  mergeMap(
    encoded,
    "agents",
    migratedAgents,
    nativeAgents,
    migratedSmallModel !== undefined || isRecord(input.agent) || isRecord(input.mode) || isRecord(input.agents),
    diagnostics,
  )

  const legacyProviders = migrateProviders(input.provider, diagnostics)
  const nativeProviders = decodeMap(input.providers, ConfigProvider.Info, ["providers"], diagnostics, decodeEncoded)
  mergeMap(
    encoded,
    "providers",
    legacyProviders,
    nativeProviders,
    isRecord(input.provider) || isRecord(input.providers),
    diagnostics,
  )

  const toolRules = migrateTools(input.tools, diagnostics)
  const permissionRules = migratePermissions(input.permission, diagnostics)
  const nativePermissions = decodeList(input.permissions, Permission.Rule, ["permissions"], diagnostics, decodeEncoded)
  const permissions = [...toolRules, ...permissionRules, ...nativePermissions]
  if (permissions.length || Array.isArray(input.permissions)) encoded.permissions = permissions

  const legacyPlugins = decodeList(input.plugin, ConfigPluginV1.Spec, ["plugin"], diagnostics, decodeValue).map(
    (plugin) => (typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] }),
  )
  const nativePlugins = decodeList(input.plugins, ConfigPlugin.Plugin, ["plugins"], diagnostics, decodeEncoded)
  if (legacyPlugins.length || nativePlugins.length || Array.isArray(input.plugin) || Array.isArray(input.plugins))
    encoded.plugins = [...legacyPlugins, ...nativePlugins]

  normalizeSkills(input, encoded, diagnostics)
  normalizeMcp(input, encoded, diagnostics)
  normalizeCompaction(input, encoded, diagnostics)
  normalizeExperimental(input, encoded, diagnostics)
  normalizeWatcher(input, encoded, diagnostics)
  normalizeFormatter(input, encoded, diagnostics)
  normalizeLsp(input, encoded, diagnostics)
  normalizeHooks(input, encoded, diagnostics)
  normalizeEnv(input, encoded, diagnostics)

  const nativeAtomic = {
    $schema: Info.fields.$schema,
    shell: Info.fields.shell,
    model: Info.fields.model,
    fallback_model: Info.fields.fallback_model,
    model_aliases: Info.fields.model_aliases,
    output_token_cap: Info.fields.output_token_cap,
    git_status: Info.fields.git_status,
    default_agent: Info.fields.default_agent,
    output_style: Info.fields.output_style,
    language: Info.fields.language,
    system_prompt: Info.fields.system_prompt,
    system_prompt_file: Info.fields.system_prompt_file,
    append_system_prompt: Info.fields.append_system_prompt,
    attribution: Info.fields.attribution,
    sandbox: Info.fields.sandbox,
    share: Info.fields.share,
    enterprise: Info.fields.enterprise,
    username: Info.fields.username,
    snapshots: Info.fields.snapshots,
    compatibility: Info.fields.compatibility,
    media: Info.fields.media,
    shell_tool: Info.fields.shell_tool,
    tool_output: Info.fields.tool_output,
    tool_execution: Info.fields.tool_execution,
    websearch: Info.fields.websearch,
    webfetch: Info.fields.webfetch,
    worktree: Info.fields.worktree,
    warming: Info.fields.warming,
  }
  // Objects whose fields are independent settings: a bad field costs only itself, so `sandbox.enabled` survives a bad
  // `sandbox.write` (class 7).
  const independent = [
    "attribution",
    "sandbox",
    "shell_tool",
    "tool_execution",
    "websearch",
    "webfetch",
    "worktree",
    "warming",
    "model_aliases",
  ]
  Object.entries(nativeAtomic).forEach(([key, schema]) => {
    if (!own(input, key)) return
    const value = independent.includes(key)
      ? decodeFields(schema, input[key], [key], diagnostics)
      : decodeEncoded(schema, input[key], [key], diagnostics)
    if (value === undefined) return
    overlay(encoded, key, value, [key], diagnostics)
  })

  // One document gives one replacement: the text wins over the file, as the schema descriptions say. An empty string is
  // unset, so it conflicts with nothing.
  if (
    typeof encoded.system_prompt === "string" &&
    encoded.system_prompt !== "" &&
    typeof encoded.system_prompt_file === "string" &&
    encoded.system_prompt_file !== ""
  ) {
    diagnostics.push({
      kind: "conflict",
      path: ["system_prompt_file"],
      message: "retained system_prompt over system_prompt_file",
    })
    delete encoded.system_prompt_file
  }

  const instructionLists = ["instructions", "instructions_exclude"] as const
  instructionLists.forEach((key) => {
    const items = decodeList(input[key], Schema.String, [key], diagnostics, decodeEncoded)
    if (items.length || Array.isArray(input[key])) encoded[key] = items
  })

  return { type: "normalized", encoded, diagnostics }
}

function normalizeSkills(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "skills")) return
  if (Array.isArray(input.skills)) {
    encoded.skills = decodeList(input.skills, Schema.String, ["skills"], diagnostics, decodeEncoded)
    return
  }
  if (!isRecord(input.skills)) {
    invalid(["skills"], diagnostics)
    return
  }
  encoded.skills = [
    ...decodeList(input.skills.paths, Schema.String, ["skills", "paths"], diagnostics, decodeEncoded),
    ...decodeList(input.skills.urls, Schema.String, ["skills", "urls"], diagnostics, decodeEncoded),
  ]
}

function normalizeMcp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  const legacyServers: Record<string, unknown> = {}
  const nativeServers: Record<string, unknown> = {}
  const timeout: Record<string, unknown> = {}
  if (isRecord(input.experimental) && own(input.experimental, "mcp_timeout")) {
    const value = decodeEncoded(
      PositiveInt,
      input.experimental.mcp_timeout,
      ["experimental", "mcp_timeout"],
      diagnostics,
    )
    if (value !== undefined) {
      timeout.catalog = value
      timeout.execution = value
    }
  }
  if (own(input, "mcp")) {
    if (!isRecord(input.mcp)) invalid(["mcp"], diagnostics)
    if (isRecord(input.mcp)) {
      Object.entries(input.mcp).forEach(([name, value]) => {
        const path = ["mcp", name]
        if (isEnabledOnlyMcp(value)) {
          diagnostics.push({ kind: "unsupported", path, message: "omitted enabled-only legacy MCP entry" })
          return
        }
        if (name === "servers" && !isDirectLegacyMcp(value)) {
          Object.entries(decodeMap(value, ConfigMCP.Server, path, diagnostics, decodeEncoded)).forEach(
            ([key, server]) => setOwn(nativeServers, key, server),
          )
          return
        }
        if (name === "timeout" && !isDirectLegacyMcp(value)) {
          normalizeMcpTimeout(value, timeout, path, diagnostics)
          return
        }
        const server = decodeValue(ConfigMCPV1.Info, value, path, diagnostics)
        if (server !== undefined)
          setOwn(legacyServers, name, canonical(ConfigMCP.Server, ConfigMigrateV1.migrateMcp(server)))
      })
    }
  }
  const servers = mergeMaps(legacyServers, nativeServers, ["mcp", "servers"], diagnostics)
  if (!Object.keys(servers).length && !Object.keys(timeout).length) {
    if (isRecord(input.mcp) && !Object.keys(input.mcp).length) encoded.mcp = {}
    return
  }
  encoded.mcp = {
    ...(Object.keys(timeout).length ? { timeout } : {}),
    ...(Object.keys(servers).length ? { servers } : {}),
  }
}

function normalizeMcpTimeout(
  value: unknown,
  timeout: Record<string, unknown>,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return
  }
  const recognized = Object.entries(ConfigMCP.Timeout.fields).filter(([key]) => own(value, key))
  if (Object.keys(value).length && !recognized.length) {
    invalid(path, diagnostics)
    return
  }
  recognized.forEach(([key, field]) => {
    const leaf = decodeEncoded(field, value[key], [...path, key], diagnostics)
    if (leaf === undefined) return
    overlay(timeout, key, leaf, [...path, key], diagnostics)
  })
}

function normalizeCompaction(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  if (!own(input, "compaction")) return
  if (!isRecord(input.compaction)) {
    invalid(["compaction"], diagnostics)
    return
  }
  unsupportedIfPresent(input.compaction, "tail_turns", ["compaction", "tail_turns"], diagnostics)
  unsupportedIfPresent(input.compaction, "prune", ["compaction", "prune"], diagnostics)
  const result: Record<string, unknown> = {}
  if (own(input.compaction, "auto")) {
    const value = decodeEncoded(
      ConfigCompaction.Info.fields.auto,
      input.compaction.auto,
      ["compaction", "auto"],
      diagnostics,
    )
    if (value !== undefined) result.auto = value
  }
  const legacyTokens = own(input.compaction, "preserve_recent_tokens")
    ? decodeEncoded(
        ConfigCompaction.Keep.fields.tokens,
        input.compaction.preserve_recent_tokens,
        ["compaction", "preserve_recent_tokens"],
        diagnostics,
      )
    : undefined
  const nativeKeep = isRecord(input.compaction.keep) ? input.compaction.keep : undefined
  if (own(input.compaction, "keep") && !nativeKeep) invalid(["compaction", "keep"], diagnostics)
  const nativeTokens =
    nativeKeep && own(nativeKeep, "tokens")
      ? decodeEncoded(
          ConfigCompaction.Keep.fields.tokens,
          nativeKeep.tokens,
          ["compaction", "keep", "tokens"],
          diagnostics,
        )
      : undefined
  const tokens = prefer(legacyTokens, nativeTokens, ["compaction", "keep", "tokens"], diagnostics)
  if (tokens !== undefined) result.keep = { tokens }
  const legacyBuffer = own(input.compaction, "reserved")
    ? decodeEncoded(
        ConfigCompaction.Info.fields.buffer,
        input.compaction.reserved,
        ["compaction", "reserved"],
        diagnostics,
      )
    : undefined
  const nativeBuffer = own(input.compaction, "buffer")
    ? decodeEncoded(ConfigCompaction.Info.fields.buffer, input.compaction.buffer, ["compaction", "buffer"], diagnostics)
    : undefined
  const buffer = prefer(legacyBuffer, nativeBuffer, ["compaction", "buffer"], diagnostics)
  if (buffer !== undefined) result.buffer = buffer
  if (Object.keys(result).length || !Object.keys(input.compaction).length) encoded.compaction = result
}

function normalizeExperimental(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  const result: Record<string, unknown> = {}
  const generated: unknown[] = []
  const enabled = decodeProviderList(input, "enabled_providers", diagnostics)
  if (enabled.present && (!enabled.nonEmpty || enabled.values.length)) {
    generated.push({ action: "provider.use", resource: "*", effect: "deny" })
    generated.push(
      ...enabled.values.map((resource) => ({
        action: "provider.use",
        resource: ConfigMigrateV1.providerID(resource),
        effect: "allow",
      })),
    )
  }
  const disabled = decodeProviderList(input, "disabled_providers", diagnostics)
  generated.push(
    ...disabled.values.map((resource) => ({
      action: "provider.use",
      resource: ConfigMigrateV1.providerID(resource),
      effect: "deny",
    })),
  )
  const native: unknown[] = []
  if (own(input, "experimental")) {
    if (!isRecord(input.experimental)) invalid(["experimental"], diagnostics)
    if (isRecord(input.experimental)) {
      const experimental = input.experimental
      unsupportedExperimental.forEach((key) =>
        unsupportedIfPresent(experimental, key, ["experimental", key], diagnostics),
      )
      if (own(experimental, "portable_shell_scanner")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.portable_shell_scanner,
          experimental.portable_shell_scanner,
          ["experimental", "portable_shell_scanner"],
          diagnostics,
        )
        if (value !== undefined) result.portable_shell_scanner = value
      }
      if (own(experimental, "subagent_depth")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.subagent_depth,
          experimental.subagent_depth,
          ["experimental", "subagent_depth"],
          diagnostics,
        )
        if (value !== undefined) result.subagent_depth = value
      }
      if (own(experimental, "allow_local_fetch")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.allow_local_fetch,
          experimental.allow_local_fetch,
          ["experimental", "allow_local_fetch"],
          diagnostics,
        )
        if (value !== undefined) result.allow_local_fetch = value
      }
      native.push(
        ...decodeList(
          experimental.policies,
          ConfigPolicy.Info,
          ["experimental", "policies"],
          diagnostics,
          decodeEncoded,
        ),
      )
    }
  }
  if (generated.length || native.length || (isRecord(input.experimental) && Array.isArray(input.experimental.policies)))
    result.policies = [...generated, ...native]
  if (Object.keys(result).length || (isRecord(input.experimental) && !Object.keys(input.experimental).length))
    encoded.experimental = result
}

function normalizeWatcher(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "watcher")) return
  if (!isRecord(input.watcher)) {
    invalid(["watcher"], diagnostics)
    return
  }
  const ignore = decodeList(input.watcher.ignore, Schema.String, ["watcher", "ignore"], diagnostics, decodeEncoded)
  encoded.watcher = ignore.length || Array.isArray(input.watcher.ignore) ? { ignore } : {}
}

function normalizeFormatter(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  if (!own(input, "formatter")) return
  if (typeof input.formatter === "boolean") {
    const value = decodeEncoded(ConfigFormatter.Info, input.formatter, ["formatter"], diagnostics)
    if (value !== undefined) encoded.formatter = value
    return
  }
  const entries = decodeMap(input.formatter, ConfigFormatter.Entry, ["formatter"], diagnostics, decodeEncoded)
  if (isRecord(input.formatter) && (!Object.keys(input.formatter).length || Object.keys(entries).length))
    encoded.formatter = entries
}

function normalizeLsp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "lsp")) return
  if (typeof input.lsp === "boolean") {
    const value = decodeEncoded(ConfigLSP.Info, input.lsp, ["lsp"], diagnostics)
    if (value !== undefined) encoded.lsp = value
    return
  }
  const entries = decodeMap(input.lsp, ConfigLSP.Entry, ["lsp"], diagnostics, decodeEncoded)
  if (isRecord(input.lsp) && (!Object.keys(input.lsp).length || Object.keys(entries).length)) encoded.lsp = entries
}

function normalizeEnv(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "env")) return
  const result = EnvConfig.decode(input.env)
  diagnostics.push(...result.diagnostics)
  if (result.env !== undefined) encoded.env = result.env
}

function normalizeHooks(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "hooks")) return
  const result = HookConfig.decode(input.hooks)
  diagnostics.push(...result.diagnostics)
  if (result.hooks !== undefined) encoded.hooks = result.hooks
}

function migrateTools(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (!isRecord(value)) {
    invalid(["tools"], diagnostics)
    return []
  }
  return Object.entries(value).flatMap(([action, raw]) => {
    const enabled = decodeValue(Schema.Boolean, raw, ["tools", action], diagnostics)
    if (enabled === undefined) return []
    return [{ action: ConfigMigrateV1.normalizeAction(action), resource: "*", effect: enabled ? "allow" : "deny" }]
  })
}

function migratePermissions(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (typeof value === "string") {
    const effect = decodeValue(ConfigPermissionV1.Action, value, ["permission"], diagnostics)
    return effect === undefined ? [] : [{ action: "*", resource: "*", effect }]
  }
  if (!isRecord(value)) {
    invalid(["permission"], diagnostics)
    return []
  }
  return Object.entries(value).flatMap(([action, raw]) => {
    if (typeof raw === "string") {
      const effect = decodeValue(ConfigPermissionV1.Action, raw, ["permission", action], diagnostics)
      return effect === undefined ? [] : [{ action: ConfigMigrateV1.normalizeAction(action), resource: "*", effect }]
    }
    if (!isRecord(raw)) {
      invalid(["permission", action], diagnostics)
      return []
    }
    return Object.entries(raw).flatMap(([resource, effect], index) => {
      const decoded = decodeValue(ConfigPermissionV1.Action, effect, ["permission", action, String(index)], diagnostics)
      return decoded === undefined
        ? []
        : [{ action: ConfigMigrateV1.normalizeAction(action), resource, effect: decoded }]
    })
  })
}

function migrateProviders(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    invalid(["provider"], diagnostics)
    return {}
  }
  const candidates = Object.entries(value).flatMap(([name, raw]) => {
    const path = ["provider", name]
    diagnoseProviderUnsupported(raw, path, diagnostics)
    if (invalidProviderOverlays(raw, path, diagnostics)) return []
    const provider = decodeValue(ConfigProviderV1.Info, raw, path, diagnostics)
    if (provider === undefined) return []
    const destination = ConfigMigrateV1.providerID(name)
    return [
      {
        name,
        destination,
        provider: canonical(ConfigProvider.Info, ConfigMigrateV1.migrateProvider(name, provider)),
      },
    ]
  })
  const current = new Set(candidates.filter((item) => item.name === item.destination).map((item) => item.destination))
  const result: Record<string, unknown> = {}
  candidates.forEach((item) => {
    if (item.name !== item.destination && current.has(item.destination)) return
    setOwn(result, item.destination, item.provider)
  })
  return result
}

function invalidProviderOverlays(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value) || !isRecord(value.options)) return false
  const headersInvalid =
    own(value.options, "headers") &&
    (!isPlainRecord(value.options.headers) ||
      Object.values(value.options.headers).some((item) => typeof item !== "string"))
  const bodyInvalid = own(value.options, "body") && !isPlainRecord(value.options.body)
  if (headersInvalid) invalid([...path, "options", "headers"], diagnostics)
  if (bodyInvalid) invalid([...path, "options", "body"], diagnostics)
  return headersInvalid || bodyInvalid
}

function diagnoseProviderUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  unsupportedProvider.forEach((key) => unsupportedIfPresent(value, key, [...path, key], diagnostics))
  if (!isRecord(value.models)) return
  Object.entries(value.models).forEach(([name, model]) => {
    if (!isRecord(model)) return
    unsupportedModel.forEach((key) => unsupportedIfPresent(model, key, [...path, "models", name, key], diagnostics))
    if (own(model, "status") && model.status !== "deprecated")
      unsupportedIfPresent(model, "status", [...path, "models", name, "status"], diagnostics)
    if (own(model, "interleaved") && typeof model.interleaved === "boolean")
      unsupportedIfPresent(model, "interleaved", [...path, "models", name, "interleaved"], diagnostics)
  })
}

// An agent name becomes a folder, a file name and a title, so a key that is not a plain name defines no agent and costs
// only itself.
// Each entry of a legacy `agent` or `mode` map goes through the same preparation as the entries of `agents`, so a bad
// tools or permission entry costs only itself and the denies beside it hold.
// Entries of the legacy agent and mode maps go to the V1 decoder, which reads a model and its variant itself: the variant
// stays a field beside the model instead of being joined into the model string, and a tier (which holds no variant)
// loses it rather than turning it into a request option.
function preparedEntries(value: unknown, path: string[], diagnostics: Diagnostic[], legacy = false) {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([id, entry]) => {
      if (!isRecord(entry)) return [id, entry]
      const { variant, ...bare } = entry
      const prepared = LegacyAgent.prepare(legacy ? bare : entry)
      prepared.notes.forEach((note) =>
        diagnostics.push({ kind: "unsupported", path: [...path, id, note.key], message: note.message }),
      )
      if (!legacy || !("variant" in entry)) return [id, prepared.entry]
      if (!LegacyAgent.isTier(entry.model)) return [id, { ...prepared.entry, variant }]
      diagnostics.push({
        kind: "unsupported",
        path: [...path, id, "variant"],
        message: "a model tier takes no variant; ignored it",
      })
      return [id, prepared.entry]
    }),
  )
}

function plainNames(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => {
      if (ConfigAgent.isName(name)) return true
      invalid([...path, name], diagnostics)
      return false
    }),
  )
}

function diagnoseAgentUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  Object.entries(value).forEach(([name, agent]) => {
    if (!isRecord(agent)) return
    unsupportedIfPresent(agent, "name", [...path, name, "name"], diagnostics)
    diagnoseSelection(agent, [...path, name], diagnostics)
  })
}

function diagnoseSelectionMap(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  Object.entries(value).forEach(([name, entry]) => {
    if (isRecord(entry)) diagnoseSelection(entry, [...path, name], diagnostics)
  })
}

function diagnoseSelection(value: Record<string, unknown>, path: string[], diagnostics: Diagnostic[]) {
  const modelValid = typeof value.model === "string" && /^[^/#]+\/[^#]+$/.test(value.model)
  if (own(value, "model") && typeof value.model === "string" && !modelValid)
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "model"],
      message: "omitted unsupported legacy model reference",
    })
  if (
    own(value, "variant") &&
    typeof value.variant === "string" &&
    (!modelValid || value.variant.length === 0 || value.variant.includes("#"))
  )
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "variant"],
      message: "omitted unsupported legacy model variant",
    })
}

function decodeProviderList(
  input: Record<string, unknown>,
  key: "enabled_providers" | "disabled_providers",
  diagnostics: Diagnostic[],
) {
  if (!own(input, key)) return { present: false, nonEmpty: false, values: [] as string[] }
  if (!Array.isArray(input[key])) {
    invalid([key], diagnostics)
    return { present: true, nonEmpty: true, values: [] as string[] }
  }
  return {
    present: true,
    nonEmpty: input[key].length > 0,
    values: decodeList(input[key], Schema.String, [key], diagnostics, decodeValue),
  }
}

function decodeMap<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): Record<string, A> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, raw]): [string, A][] => {
      const decoded = decode(schema, raw, [...path, name], diagnostics)
      return decoded === undefined ? [] : [[name, decoded]]
    }),
  )
}

function decodeList<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): A[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    invalid(path, diagnostics)
    return []
  }
  return value.flatMap((item, index) => {
    const decoded = decode(schema, item, [...path, String(index)], diagnostics)
    return decoded === undefined ? [] : [decoded]
  })
}

function decodeValue<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const decoded = Schema.decodeUnknownOption(schema, options)(value)
  if (Option.isSome(decoded)) return decoded.value
  invalid(path, diagnostics)
  return undefined
}

function decodeEncoded<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const decoded = decodeQuiet(schema, value)
  if (decoded === undefined) invalid(path, diagnostics)
  return decoded
}

function decodeQuiet<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, options)(value)
  if (Option.isNone(decoded)) return undefined
  const encoded = Schema.encodeUnknownOption(schema, options)(decoded.value)
  return Option.isSome(encoded) ? plain(encoded.value) : undefined
}

/**
 * Decodes an object whose fields are independent, one field at a time when the whole does not decode, so a bad field
 * costs only itself. A field is judged by decoding it alone; an object that fails because a required field is missing
 * has no field to drop and is reported as a whole. `rules` names a list of permission rules that is kept rule by rule, since one bad rule must not take the
 * valid denies beside it. Each loss is reported at its own path, and an object of which nothing survives is dropped.
 */
function decodeFields<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
  rules?: string,
) {
  const whole = decodeQuiet(schema, value)
  if (whole !== undefined) return whole
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return undefined
  }
  const reported = diagnostics.length
  const input =
    rules !== undefined && Array.isArray(value[rules])
      ? { ...value, [rules]: decodeList(value[rules], Permission.Rule, [...path, rules], diagnostics, decodeEncoded) }
      : value
  const kept = Object.fromEntries(
    Object.entries(input).filter(([key, item]) => {
      if (decodeQuiet(schema, { [key]: item }) !== undefined) return true
      invalid([...path, key], diagnostics)
      return false
    }),
  )
  const result = Object.keys(kept).length === 0 ? undefined : decodeQuiet(schema, kept)
  // An object that fails only because a required field is missing (an empty one, or one with only unknown keys) has no
  // field to drop, so report the object itself rather than losing it silently.
  if (result === undefined && (Object.keys(kept).length > 0 || diagnostics.length === reported))
    invalid(path, diagnostics)
  return result
}

function canonical<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) {
  return plain(
    Option.getOrThrow(
      Schema.decodeUnknownOption(
        schema,
        options,
      )(plain(value)).pipe(Option.flatMap((decoded) => Schema.encodeUnknownOption(schema, options)(decoded))),
    ),
  )
}

function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, plain(item)]])),
  )
}

function mergeMap(
  target: Record<string, unknown>,
  key: string,
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  present: boolean,
  diagnostics: Diagnostic[],
) {
  const merged = mergeMaps(legacy, native, [key], diagnostics)
  if (present) target[key] = merged
}

function mergeMaps(
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const result = Object.fromEntries(Object.entries(legacy))
  Object.entries(native).forEach(([name, value]) => {
    if (own(result, name) && !isDeepStrictEqual(result[name], value)) conflict([...path, name], diagnostics)
    setOwn(result, name, value)
  })
  return result
}

function mapValues<A>(input: Readonly<Record<string, A>>, map: (value: A) => unknown) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const mapped = map(value)
      return mapped === undefined ? [] : [[key, mapped]]
    }),
  )
}

function overlay(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (own(target, key) && !isDeepStrictEqual(target[key], value)) conflict(path, diagnostics)
  target[key] = value
}

function prefer(legacy: unknown, native: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (native === undefined) return legacy
  if (legacy !== undefined && !isDeepStrictEqual(legacy, native)) conflict(path, diagnostics)
  return native
}

function unsupportedIfPresent(value: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  if (!own(value, key)) return
  diagnostics.push({ kind: "unsupported", path, message: "omitted unsupported legacy setting" })
}

function invalid(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "invalid", path, message: "skipped malformed recognized value" })
}

function conflict(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "conflict", path, message: "retained native value over legacy value" })
}

function isDirectLegacyMcp(value: unknown) {
  return isRecord(value) && (value.type === "local" || value.type === "remote")
}

function isEnabledOnlyMcp(value: unknown) {
  return isRecord(value) && !own(value, "type") && typeof value.enabled === "boolean"
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key)
}

function setOwn(value: Record<string, unknown>, key: string, item: unknown) {
  Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true })
}
