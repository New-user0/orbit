export * as AgentInstructions from "./instructions.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { Permission } from "../permission.js"
import { PlanMode } from "../plan-mode.js"
import { Instructions } from "../instructions/index.js"
import { ReminderText } from "../session/reminder-text.js"

/** The permission action of the Agent and Workflow tools; `SubagentTool.name` must equal it (pinned by a test). */
export const NAME = "Agent"

const Summary = Schema.Struct({
  id: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tools: Schema.String,
})
type Summary = typeof Summary.Type

// The stored summary is the text the model reads, so a change that does not alter that text makes no delta.
// Tool names come from config, even from a folder that is not trusted, so they are cleaned before they are stored.
const toolSummary = (tools: Agent.Info["tools"]) => {
  const deny = (tools?.deny ?? []).map(ReminderText.oneLine)
  if (tools?.allow === undefined) return deny.length === 0 ? "all tools" : `all tools except ${deny.join(", ")}`
  const left = tools.allow.map(ReminderText.oneLine).filter((tool) => !deny.includes(tool))
  return left.length === 0 ? "no tools" : left.join(", ")
}

// Every field is cleaned once, where the summary is built, so what is measured, stored and shown is the same text.
const line = (agent: Summary) =>
  `- ${agent.id}: ${agent.description ?? "Start this agent only when the user asks for it."} (${agent.tools})`

const render = (agents: ReadonlyArray<Summary>) =>
  [
    "These are the agent types the Agent and Workflow tools can start:",
    ...agents.map(line),
    "",
    "Agents whose work does not depend on each other are started in the same response.",
  ].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (agent) => agent.id,
    (before, after) => before.description !== after.description || before.tools !== after.tools,
  )
  // Added, then removed, then changed, as separate blocks.
  return [
    diff.added.length === 0 ? [] : ["Additional agents you can delegate to, added since the last listing:", ...diff.added.map(line)],
    diff.removed.length === 0
      ? []
      : ["Withdrawn since the last listing, so do not start them:", ...diff.removed.map((agent) => `- ${agent.id}`)],
    diff.changed.length === 0
      ? []
      : [
          "These agent types now have a different description or tool set:",
          ...diff.changed.map((item) => line(item.current)),
        ],
  ]
    .filter((block) => block.length > 0)
    .map((block) => block.join("\n"))
    .join("\n\n")
}

export interface Interface {
  /**
   * Lists the agents the given ruleset lets the Agent tool start. Callers pass the merged agent and Session
   * permissions, and `enabled` when the request offers `Agent` or `Workflow`.
   *
   * Note for agents-extensibility: an agent that requires MCP servers must be listed only when each required name
   * is a case-insensitive substring of some connected server name; Agent.Info has no such field yet.
   */
  readonly load: (input: {
    readonly permissions: Permission.Ruleset
    readonly enabled: boolean
    /** The running agent. A Plan-mode session may start only what Plan mode allows, so the listing leaves out the rest. */
    readonly agent?: string
  }) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/AgentInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service

    return Service.of({
      load: Effect.fn("AgentInstructions.load")(function* (input) {
        const available: ReadonlyArray<Summary> = !input.enabled
          ? []
          : (yield* agents.list())
              .filter(
                (agent) =>
                  agent.mode !== "primary" &&
                  !agent.hidden &&
                  (input.agent !== PlanMode.agent || PlanMode.allowedSubagents.has(agent.id)) &&
                  Permission.evaluate(NAME, agent.id, input.permissions).effect !== "deny",
              )
              .toSorted((a, b) => a.id.localeCompare(b.id))
              .map((agent) => ({
                id: ReminderText.oneLine(agent.id),
                ...(agent.description === undefined ? {} : { description: ReminderText.oneLine(agent.description) }),
                tools: toolSummary(agent.tools),
              }))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/agent-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: (previous) =>
              `No agents can be started any more. These agent types were listed before: ${previous.map((agent) => agent.id).join(", ")}.`,
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Agent.node] })
