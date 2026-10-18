export * as SessionContext from "./context.js"

import { Config } from "../config.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import { AgentInstructions } from "../agent/instructions.js"
import { SkillTool } from "../tool/plugin/skill.js"
import { WorkflowTool } from "../tool/plugin/workflow.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { McpInstructions } from "../mcp/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { VcsInstructions } from "../vcs/instructions.js"
import { Tool } from "../tool.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionScratchpad } from "./scratchpad.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
  /** The configured `output_token_cap`, when set. */
  readonly outputTokenCap?: number
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  readonly resolveModel: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /**
   * Selects the agent and model for work beside the Session, such as titles and side queries, without instruction or
   * tool preflight. The agent's configured model comes first, then the small model of the primary provider, then the
   * primary model; all three use the variant that reasons least, so `primary` is the Session model without its own variant.
   */
  readonly selectAuxiliary: (
    session: SessionSchema.Info,
    agentID: Agent.ID,
  ) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  /**
   * Resolves the fallback model: `requested`, else the configured `fallback_model`. Undefined when neither is set,
   * the model is unavailable, or it is the session's own model (the same provider and model, whatever the variant).
   */
  readonly resolveFallback: (
    session: SessionSchema.Info,
    requested?: Model.Ref,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
  readonly request: SessionModelRequest.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@orbit/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const agentInstructions = yield* AgentInstructions.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const scratchpad = yield* SessionScratchpad.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const vcsInstructions = yield* VcsInstructions.Service
    const registry = yield* Tool.Service
    const config = yield* Config.Service

    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)

    const selectAuxiliary = Effect.fn("SessionContext.selectAuxiliary")(function* (
      session: SessionSchema.Info,
      agentID: Agent.ID,
    ) {
      const agent = yield* agents.get(agentID)
      if (!agent) return
      const sessionModel = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      // The Session's own variant is dropped for side work: a thinking variant costs more and rejects a forced tool choice.
      const leastReasoning = (info: Model.Info | undefined, pinned?: Model.VariantID) =>
        Effect.gen(function* () {
          if (!info) return
          const variant = pinned ?? MINIMAL_REASONING_VARIANTS.find((id) => info.variants.some((item) => item.id === id))
          return yield* resolveModel({
            ...session,
            model: Model.Ref.make({ providerID: info.providerID, id: info.id, ...(variant ? { variant } : {}) }),
          }).pipe(Effect.orElseSucceed(() => undefined))
        })
      const pinned = agent.model ? yield* model.get(agent.model.providerID, agent.model.id) : undefined
      const small = pinned ?? (sessionModel ? yield* model.small(sessionModel.ref.providerID) : undefined)
      const preferred = yield* leastReasoning(small, pinned ? agent.model?.variant : undefined)
      const primary = sessionModel
        ? ((yield* leastReasoning(yield* model.get(sessionModel.ref.providerID, sessionModel.ref.id))) ?? sessionModel)
        : undefined
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const resolveFallback = Effect.fn("SessionContext.resolveFallback")(function* (
      session: SessionSchema.Info,
      requested?: Model.Ref,
    ) {
      const configured = Config.latest(yield* config.entries(), "fallback_model")
      const ref =
        requested ??
        (configured &&
          Model.Ref.make({
            providerID: configured.providerID,
            id: configured.model,
            ...(configured.variant ? { variant: configured.variant } : {}),
          }))
      if (!ref) return
      // Compare identity before resolving: the session's own ref, or else what it would default to.
      const own = session.model ?? (yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.ref
      if (own?.providerID === ref.providerID && own.id === ref.id) return
      return yield* resolveModel({ ...session, model: ref }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("fallback model skipped", { providerID: ref.providerID, model: ref.id, error }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* mcpTools.flush
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      const permissions = Permission.merge(agent.info.permissions, session.permissions ?? [])
      const tools = yield* registry.snapshot(permissions)
      const offered = (name: string) => tools.definitions.some((definition) => definition.name === name)
      const loaded = yield* Effect.all(
        {
          builtins: builtins.load(),
          discovery: discovery.load(),
          skills: Effect.gen(function* () {
            // The skill listing is budgeted against the window of the model that runs this request.
            const pinned = session.model && (yield* model.get(session.model.providerID, session.model.id))
            const contextWindow = (pinned || (yield* model.default()))?.limit.context ?? DEFAULT_CONTEXT_WINDOW
            return yield* skillInstructions.load(permissions, { contextWindow, enabled: offered(SkillTool.name) })
          }),
          agents: agentInstructions.load({
            permissions,
            enabled: offered(AgentInstructions.NAME) || offered(WorkflowTool.name),
          }),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      return {
        session,
        agent: { ...agent, info: agent.info },
        // Ordered from most to least shared across sessions so the baseline stays a reusable
        // prompt-cache prefix: user-level catalog and guidance, then project instructions, then
        // the date and environment, which vary by day and directory, then the git snapshot, which
        // varies by the moment the session began, then the scratchpad, which varies by the session
        // the lineage goes back to.
        instructions: Instructions.combine([
          // `core/mcp-guidance` and `core/codemode` carry the MCP and deferred-tool deltas. The native deferred-tool
          // source that file-web-tools adds belongs in this group, before the references.
          CodeModeInstructions.make(tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.agents,
          loaded.discovery,
          loaded.builtins,
          vcsInstructions.source(session),
          scratchpad.source(session),
          loaded.entries,
        ]),
        tools,
      }
    })

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      const model = yield* resolveModel(selection.session)
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        SessionProviderContext.provenance(model) ?? "local",
      )
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        initial: history.initial,
        messages: history.entries.map((entry) => entry.message),
        tools: selection.tools,
        outputTokenCap: Config.latest(yield* config.entries(), "output_token_cap"),
      }
    })

    return Service.of({ select, load, resolveModel, selectAuxiliary, resolveFallback, request })
  }),
)

/** The window assumed when neither the session's model nor the default model reports one. */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    AgentInstructions.node,
    Config.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionScratchpad.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
    VcsInstructions.node,
  ],
})
