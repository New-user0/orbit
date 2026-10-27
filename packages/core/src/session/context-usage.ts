export * as SessionContextUsage from "./context-usage.js"
export { CategoryKind, Info } from "@orbit/schema/session-context-usage"

import type { Breakdown, Category } from "@orbit/schema/session-context-usage"
import { Effect, Option, Schema } from "effect"
import { Agent } from "../agent.js"
import { AgentInstructions } from "../agent/instructions.js"
import { CodeModeCatalog } from "../codemode/catalog.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Mcp } from "../mcp/index.js"
import { Plugin } from "../plugin/service.js"
import { SkillInstructions } from "../skill/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { ToolOutput } from "../tool-output.js"
import { Token } from "../util/token.js"
import { SessionCompaction } from "./compaction.js"
import { SessionContextWindow } from "./context-window.js"
import { SessionContext } from "./context.js"
import { MainSessionOnlyError, NotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { InstructionState } from "./instruction-state.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionProviderContext } from "./provider-context.js"
import { ReminderText } from "./reminder-text.js"
import { SessionReminders } from "./reminders.js"
import { lowerEach, withoutReplaced } from "./runner/to-llm-message.js"
import type { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

// The stored shapes the details are read from. The sources decode and render the same values, so a value that does not
// decode here was not rendered into the baseline either.
const Files = Schema.toCodecJson(Schema.Array(InstructionDiscovery.File))
const Index = Schema.Struct({ path: Schema.String, content: Schema.String })
const Skills = Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.optionalKey(Schema.String) }))
const Agents = Schema.Array(
  Schema.Struct({ id: Schema.String, description: Schema.optionalKey(Schema.String), tools: Schema.String }),
)

const INDEXES = { "core/memory-index": "memory", "core/team-memory-index": "team-memory" } as const
const FILES = "core/instructions"
const SKILLS = "core/skill-guidance"
const AGENTS = "core/agent-guidance"
// The catalog of deferred tools is tool information; the rest of the baseline that is not listed here is system prompt.
const TOOLS = "core/codemode"

/**
 * What the next request would carry, by category, counted with the runner's own estimators over the request it would
 * build (its `context` hooks and its lowering included). Nothing is recorded and nothing is sent: the instruction values
 * come from the session's stored baseline, or for a session that has none yet from what the step's own sources observe,
 * under their own trust gates (class 1). The session must be a main session of this Location.
 */
export const analyze = Effect.fn("SessionContextUsage.analyze")(function* (sessionID: SessionSchema.ID) {
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const session = yield* store.get(sessionID)
  if (!session) return yield* new NotFoundError({ sessionID })
  if (session.parentID !== undefined) return yield* new MainSessionOnlyError({ sessionID, parentID: session.parentID })

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const contexts = yield* SessionContext.Service
    const compaction = yield* SessionCompaction.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* Mcp.Service
    const reminders = yield* SessionReminders.Service
    const toolOutput = yield* ToolOutput.Service

    const selection = yield* contexts.select(session.id)
    const model = yield* contexts.resolveModel(session)
    const values = yield* InstructionState.baseline(database.db, session.id, selection.instructions)
    const parts = Instructions.renderEach(selection.instructions, values)
    const initial = parts.map((part) => part.text).join(Instructions.SEPARATOR)
    const history = yield* SessionHistory.load(
      database.db,
      session.id,
      SessionProviderContext.provenance(model) ?? "local",
    )
    const loaded: SessionContext.Loaded = {
      session,
      agent: selection.agent,
      model,
      initial,
      messages: history,
      tools: selection.tools,
      outputTokenCap: Config.latest(yield* config.entries(), "output_token_cap"),
    }

    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial,
      messages: history,
      minimal: reminders.minimal,
      toolOutput: toolOutput.root,
    })
    const request = (yield* contexts.request.primary({
      session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: transcript.messages,
      inputTokens: SessionCompaction.estimatePrompt(loaded, reminders.minimal, toolOutput.root),
      outputTokenCap: loaded.outputTokenCap,
    })).request

    const totals = { system: 0, tools: 0, mcp: 0, agents: 0, instructions: 0, skills: 0, messages: 0 }
    const sections: Array<{ name: string; tokens: number }> = []
    const files: Array<{ path: string; type: string; tokens: number }> = []
    const skills: Array<{ id: string; tokens: number }> = []
    const customAgents: Array<{ id: string; scope: string; tokens: number }> = []

    // The baseline is one system part, so its keys share that part's estimate by their place in it. A share is the
    // difference of two cumulative estimates, which keeps every share whole and their sum the part's own estimate.
    const share = (start: number, end: number) => Token.estimateLength(end) - Token.estimateLength(start)
    const known = yield* agents.list()
    const scopes = new Map(
      known.flatMap((agent) => (agent.source === undefined ? [] : ([[agent.id, agent.source.scope]] as const))),
    )
    const baseline = initial.length === 0 ? -1 : request.system.findIndex((part) => part.text === initial)
    request.system.forEach((part, index) => {
      if (index !== baseline) {
        totals.system += Token.estimate(part.text)
        sections.push({ name: sectionName(part.text), tokens: Token.estimate(part.text) })
        return
      }
      let start = 0
      let shared = 0
      parts.forEach((entry) => {
        const end = start + entry.text.length
        const tokens = share(start, end)
        shared += tokens
        const value = values[entry.key]
        if (entry.key === FILES) {
          totals.instructions += tokens
          Option.getOrElse(Schema.decodeUnknownOption(Files)(value), () => []).forEach((file) =>
            files.push({
              path: file.path,
              type: file.kind ?? "file",
              tokens: Token.estimate(InstructionDiscovery.entryText(file)),
            }),
          )
        } else if (entry.key in INDEXES) {
          totals.instructions += tokens
          Option.map(Schema.decodeUnknownOption(Index)(value), (found) =>
            files.push({ path: found.path, type: INDEXES[entry.key as keyof typeof INDEXES], tokens }),
          )
        } else if (entry.key === SKILLS) {
          totals.skills += tokens
          Option.getOrElse(Schema.decodeUnknownOption(Skills)(value), () => []).forEach((skill) =>
            skills.push({ id: skill.id, tokens: Token.estimate(SkillInstructions.line(skill)) }),
          )
        } else if (entry.key === AGENTS) {
          // Only the lines of the agents that someone defined are the Custom agents row; the lead, the agents Orbit
          // ships and the closing sentence belong to the Agent tool's own guidance.
          let cursor = 0
          const lines = Option.getOrElse(Schema.decodeUnknownOption(Agents)(value), () => []).flatMap((agent) => {
            const scope = scopes.get(agent.id as Agent.ID)
            const line = AgentInstructions.line(agent)
            const at = entry.text.indexOf(line, cursor)
            if (scope === undefined || at < 0) return []
            cursor = at + line.length
            customAgents.push({ id: agent.id, scope, tokens: Token.estimate(line) })
            return [share(start + at, start + cursor)]
          })
          const own = lines.reduce((sum, lineTokens) => sum + lineTokens, 0)
          totals.agents += own
          totals.tools += tokens - own
        } else if (entry.key === TOOLS) totals.tools += tokens
        else {
          totals.system += tokens
          sections.push({ name: entry.key, tokens })
        }
        start = end + Instructions.SEPARATOR.length
      })
      // What the keys do not own is the separators between them.
      totals.system += Token.estimate(part.text) - shared
    })

    // Tools: an MCP tool is one the cached discovery lists under its registry name; every other advertised tool,
    // Execute included, is a System tool. The deferred inventory is listed and counted in no sum.
    const discovered = yield* mcp.tools()
    const direct = new Map(discovered.map((found) => [McpTool.name(found.server, found.name), found] as const))
    const systemTools: Array<{ name: string; tokens: number }> = []
    const mcpTools: Array<{ name: string; server: string; tokens: number; deferred: boolean }> = []
    request.tools.forEach((entry) => {
      const tokens = SessionCompaction.estimateTool(entry)
      const found = direct.get(entry.name)
      if (found === undefined) {
        totals.tools += tokens
        systemTools.push({ name: entry.name, tokens })
        return
      }
      totals.mcp += tokens
      mcpTools.push({ name: entry.name, server: found.server, tokens, deferred: false })
    })
    const callable = new Map<string, Mcp.Tool>(
      discovered
        .filter((found) => found.codemode !== false)
        .map((found) => {
          const registered = McpTool.name(found.server, found.name)
          return [
            `${McpTool.namespace(found.server)}.${registered.slice(McpTool.namespace(found.server).length + 1)}`,
            found,
          ] as const
        }),
    )
    const deferredTools: Array<{ name: string; tokens: number }> = []
    const deferred = { mcp: 0, tools: 0 }
    deferredEntries(selection.tools.codeModeCatalog?.tools ?? []).forEach((entry) => {
      const tokens = Token.estimate(entry.path + entry.description + entry.signature)
      const found = callable.get(entry.path)
      if (found === undefined) {
        deferred.tools += tokens
        deferredTools.push({ name: entry.path, tokens })
        return
      }
      deferred.mcp += tokens
      mcpTools.push({ name: McpTool.name(found.server, found.name), server: found.server, tokens, deferred: true })
    })

    totals.messages = request.messages.reduce((sum, message) => sum + SessionCompaction.estimateMessage(message), 0)
    const estimate = Object.values(totals).reduce((sum, tokens) => sum + tokens, 0)

    // The measurement is the response the estimate anchors on, as the prompt the provider counted without its output.
    const active = withoutReplaced(history)
    const anchor = active[SessionCompaction.measuredAnchor(active, model.ref)]
    const usage = anchor?.type === "assistant" ? anchor.tokens : undefined
    const total = usage === undefined ? estimate : usage.input + usage.cache.read + usage.cache.write

    const settings = compaction.thresholds(loaded)
    const window = settings.thresholds?.window
    const reserve =
      settings.thresholds === undefined
        ? undefined
        : settings.auto
          ? { kind: "auto-buffer" as const, tokens: settings.thresholds.window - settings.thresholds.threshold }
          : { kind: "compact-buffer" as const, tokens: SessionContextWindow.BLOCKING_BUFFER }
    const rows: ReadonlyArray<Category> = [
      { kind: "system", tokens: totals.system },
      { kind: "tools", tokens: totals.tools },
      { kind: "mcp", tokens: totals.mcp },
      { kind: "mcp-deferred", tokens: deferred.mcp },
      { kind: "tools-deferred", tokens: deferred.tools },
      { kind: "agents", tokens: totals.agents },
      { kind: "instructions", tokens: totals.instructions },
      { kind: "skills", tokens: totals.skills },
      { kind: "messages", tokens: totals.messages },
      ...(reserve === undefined ? [] : [reserve]),
      ...(window === undefined || reserve === undefined
        ? []
        : [{ kind: "free" as const, tokens: Math.max(0, window - estimate - reserve.tokens) }]),
    ]

    return {
      model: model.ref,
      ...(window === undefined ? {} : { window, percentage: Math.round((total / window) * 100) }),
      total,
      measured: usage !== undefined,
      auto: settings.auto,
      ...(settings.thresholds === undefined ? {} : { threshold: settings.thresholds.threshold }),
      categories: rows.filter((row) => row.tokens > 0),
      files,
      mcp: mcpTools,
      agents: customAgents,
      skills,
      systemTools,
      deferredTools,
      sections,
      messages: breakdown(
        lowerEach(history, model.ref, model.model.route.providerMetadataKey ?? model.model.provider, {
          minimal: reminders.minimal,
          toolOutput: toolOutput.root,
        }),
      ),
    }
  }).pipe(instances.provide(session))
})

/** A part is named by its first Markdown heading, else by its first line cut to 40 characters. */
function sectionName(text: string) {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1]
  if (heading !== undefined) return heading
  const line =
    text
      .split("\n")
      .find((item) => item.trim() !== "")
      ?.trim() ?? ""
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/** The tools of a Code Mode inventory with the dotted path a program calls them by. */
function deferredEntries(
  entries: ReadonlyArray<CodeModeCatalog.Tool | CodeModeCatalog.Namespace>,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<{ readonly path: string; readonly description: string; readonly signature: string }> {
  return entries.flatMap((entry) =>
    entry.type === "tool"
      ? [{ path: [...prefix, entry.name].join("."), description: entry.description, signature: entry.signature }]
      : deferredEntries(entry.tools, [...prefix, entry.name]),
  )
}

/**
 * Splits what history lowers to by what each part is. It is a local estimate over each row on its own, and need not
 * equal the Messages row, which counts the request after the hooks.
 */
function breakdown(rows: ReturnType<typeof lowerEach>): Breakdown {
  const sums = { toolCalls: 0, toolResults: 0, attachments: 0, assistant: 0, user: 0 }
  const tools = new Map<string, { calls: number; results: number }>()
  const kinds = new Map<string, number>()
  rows.forEach(({ message, lowered }) => {
    const parts = lowered.flatMap((item) => item.content)
    if (message.type === "assistant") {
      parts.forEach((part) => {
        const tokens = SessionCompaction.estimatePart(part)
        if (part.type !== "tool-call" && part.type !== "tool-result") {
          sums.assistant += tokens
          return
        }
        const entry = tools.get(part.name) ?? { calls: 0, results: 0 }
        if (part.type === "tool-call") entry.calls += tokens
        else entry.results += tokens
        tools.set(part.name, entry)
        if (part.type === "tool-call") sums.toolCalls += tokens
        else sums.toolResults += tokens
      })
      return
    }
    const tokens = parts.reduce((sum, part) => sum + SessionCompaction.estimatePart(part), 0)
    if (message.type === "user") {
      sums.user += tokens
      return
    }
    sums.attachments += tokens
    const kind = attachmentKind(message)
    kinds.set(kind, (kinds.get(kind) ?? 0) + tokens)
  })
  return {
    ...sums,
    tools: [...tools]
      .map(([name, entry]) => ({ name, ...entry }))
      .toSorted((a, b) => b.calls + b.results - (a.calls + a.results)),
    attachmentKinds: [...kinds].map(([name, tokens]) => ({ name, tokens })).toSorted((a, b) => b.tokens - a.tokens),
  }
}

const attachmentKind = (message: SessionMessage.Info) => {
  if (ReminderText.isReminder(message)) return (message.metadata?.reminder as { kind: string }).kind
  if (message.type === "system") return "instructions"
  if (message.type === "compaction") return "checkpoint"
  return message.type
}
