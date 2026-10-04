export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { PlanPlugin } from "../../plugin/plan.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import type { Tool } from "../../tool.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

/** Admission checks and model resolution shared by every tool that spawns subagents. */
export const spawner = Effect.fn("SubagentTool.spawner")(function* () {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const permission = yield* Permission.Service
  const models = yield* Model.Service

  const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
    const ref = yield* Effect.try({
      try: () => Model.Ref.parse(input),
      catch: () =>
        new ToolFailure({
          message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
        }),
    })
    const model = (yield* models.available()).find(
      (model) => model.providerID === ref.providerID && model.id === ref.id,
    )
    if (model === undefined)
      return yield* new ToolFailure({
        message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
      })
    if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
      return yield* new ToolFailure({
        message:
          model.variants.length === 0
            ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
            : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
      })
    return ref
  })

  /** Check the nesting depth and the Plan-mode limit, resolve the agent and assert the subagent permission for it. */
  const admit = Effect.fn("SubagentTool.admit")(function* (context: Tool.Context, agentID: string) {
    const parent = yield* sessions
      .get(context.sessionID)
      .pipe(
        Effect.mapError(
          (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
        ),
      )
    let current = parent
    let depth = 0
    while (current.parentID) {
      depth++
      current = yield* sessions
        .get(current.parentID)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
          ),
        )
    }
    const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
    if (depth >= limit)
      return yield* new ToolFailure({
        message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
      })
    // A read-only session may only spawn read-only children. The caller's identity decides this, not a permission
    // rule: rules are last-match, so a `* * allow` that config appends after the Plan agent's rules would reopen it.
    // Checking before resolution refuses every other agent, including unknown and primary ones.
    if (context.agent === PlanPlugin.plan && !PlanPlugin.readOnlyAgents.has(Agent.ID.make(agentID))) {
      // Name only agents that can run: `plan` is a primary agent unless config changes its mode.
      const allowed = (yield* Effect.forEach(PlanPlugin.readOnlyAgents, (id) => agents.resolve(id))).flatMap((item) =>
        item === undefined || item.mode === "primary" ? [] : [item.id],
      )
      const reason = [
        allowed.length === 0
          ? "Plan mode does not allow subagents."
          : `Plan mode only allows read-only subagents: ${allowed.join(", ")}.`,
        `Agent ${agentID} cannot be spawned until Plan mode ends.`,
      ].join(" ")
      return yield* new ToolFailure({
        message: reason,
        error: new Permission.BlockedError({ rules: [], permission: name, resources: [agentID], reason }),
      })
    }
    const agent = yield* agents.resolve(agentID)
    if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${agentID}` })
    if (agent.mode === "primary")
      return yield* new ToolFailure({ message: `Agent ${agentID} cannot run as a subagent` })
    yield* permission
      .assert({
        action: name,
        resources: [agent.id],
        save: [agent.id],
        sessionID: context.sessionID,
        agent: context.agent,
        source: {
          type: "tool",
          messageID: context.messageID,
          id: context.id,
        },
      })
      .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))
    return { parent, agent }
  })

  return { resolveModel, admit }
})

export const Plugin = {
  id: "orbit.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.make
    const spawn = yield* spawner()

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const { parent, agent } = yield* spawn.admit(context, input.agent)

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const override = input.model === undefined ? undefined : yield* spawn.resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = override ?? agent.model ?? parent.model
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: Agent.ID.make(input.agent),
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              const background = input.background === true
              yield* context.progress({ sessionID: child.id, status: "running" })

              // Standard prompt admission outside the job: Job.start joining a running child skips
              // its run effect, and the default wake starts an idle child or steers a running one.
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(background && existing === undefined ? { resume: false } : {}),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }
              yield* subagents.start(recovery)

              if (background) {
                yield* subagents.background(recovery)
                return backgroundResult(child.id)
              }

              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
                    discard: true,
                  }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* subagents.notify(recovery, result.info.started_at)
                return backgroundResult(child.id)
              }
              // Failure surfaces keep the sessionID visible so the model can continue the child.
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
              return {
                sessionID: child.id,
                status: "completed" as const,
                output: result?.info.output ?? SubagentCompletion.NO_TEXT,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = describeAgents(agents, name)
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

/** A session hook that lists the subagents the selected agent may spawn in the description of tool `tool`. */
export function describeAgents(agents: Agent.Interface, tool: string) {
  return (event: SessionHooks["context"]) =>
    Effect.gen(function* () {
      const definition = event.tools[tool]
      if (!definition) return
      const selected = yield* agents.resolve(event.agent)
      if (!selected) return
      const available = (yield* agents.list())
        .filter(
          (agent) =>
            agent.mode !== "primary" &&
            !agent.hidden &&
            Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
        )
        .toSorted((a, b) => a.id.localeCompare(b.id))
      if (available.length === 0) return
      definition.description = [
        definition.description,
        "",
        "Available subagents:",
        ...available.map(
          (agent) =>
            `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
        ),
      ].join("\n")
    })
}
