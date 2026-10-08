export * as WorkflowTool from "./workflow.js"

import { ToolFailure } from "@orbit/ai"
import { CodeMode, Tool } from "@orbit/codemode"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Ref, Schema, Semaphore } from "effect"
import { Agent } from "../../agent.js"
import { CodeModeTool } from "../../codemode/tool.js"
import { Job } from "../../job.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { SubagentTool } from "./subagent.js"

// The calling agent writes a short program that delegates to subagents, each in its own child session, and only the
// program's return value comes back. Intermediate work (drafts, reviews, findings) stays in the children, so the
// caller's context holds the plan and the outcome rather than every step in between.

export const name = "workflow"

/** Subagents running at once within one workflow. */
const CONCURRENCY = 4
/** Subagents one workflow may start. */
const MAX_AGENTS = 24

export const Input = Schema.Struct({
  description: Schema.String.annotate({
    description: "A short 3-5 word label for the workflow, displayed to the user",
  }),
  script: Schema.String.annotate({
    description: "The orchestration program: JavaScript that calls `tools.agent(...)` and returns the result",
  }),
})

const AgentInput = Schema.Struct({
  description: Schema.String.annotate({ description: "A short 3-5 word label for this agent" }),
  prompt: Schema.String.annotate({ description: "The complete task; the agent starts with no other context" }),
  agent: Schema.optionalKey(Schema.String).annotate({ description: "Subagent type; default general" }),
  model: Schema.optionalKey(Schema.String).annotate({ description: "providerID/modelID; only when asked for" }),
  phase: Schema.optionalKey(Schema.String).annotate({
    description: "A one-word stage this agent belongs to, such as Discover, Build or Verify; shown to the user",
  }),
})

export const description = [
  "Run a multi-agent workflow: a short JavaScript program that delegates work to subagents and returns only the final result.",
  "Use it when a task splits into roles or independent parts, such as one agent writing code, another reviewing it, a third fixing what the review found; or several agents covering different modules in parallel. Each subagent works in its own child session, so drafts, reviews and intermediate findings stay out of your context. You see the program's return value, then verify the outcome yourself.",
  "",
  "In the program:",
  "- `await tools.agent({ description, prompt, agent?, model?, phase? })` runs one subagent to completion and returns its final reply as a string. It throws if the subagent fails; catch it to continue without that result.",
  "- Give agents a `phase` (one word, such as Discover, Build or Verify) when the workflow has stages; the user sees agents grouped by phase.",
  "- Each subagent starts fresh: put everything it needs in `prompt`, including earlier agents' output when one builds on another.",
  `- Run independent agents together with \`Promise.all\`; at most ${CONCURRENCY} run at once and a workflow may start at most ${MAX_AGENTS}.`,
  "- Loops and conditions work as usual, for example: repeat review and fix until the reviewer replies APPROVED, at most 3 rounds.",
  "- Return a value (string, object or array). Return what you need to verify the work, not every intermediate draft.",
  "- Imports, timers, the filesystem and network are unavailable in the program itself; agents do the work with their own tools.",
  "",
  "Example:",
  "```js",
  'const draft = await tools.agent({ description: "Write CSV export", prompt: "Add CSV export to src/report.ts ... Reply with a summary of your changes." })',
  "const [review, bugs] = await Promise.all([",
  '  tools.agent({ description: "Review export", prompt: `Review this change for correctness and style. Do not edit files.\\n${draft}` }),',
  '  tools.agent({ description: "Hunt export bugs", prompt: `Find bugs and missing edge cases in the CSV export in src/report.ts. Do not edit files.` }),',
  "])",
  'const fix = await tools.agent({ description: "Fix review findings", prompt: `Fix these findings in src/report.ts:\\n${review}\\n${bugs}` })',
  "return { draft, review, bugs, fix }",
  "```",
].join("\n")

type Entry = {
  sessionID: string
  description: string
  agent: string
  status: "running" | "completed" | "failed"
  phase?: string
  /** The model's ID, for display. */
  model?: string
  /** Epoch milliseconds. */
  started: number
  ended?: number
  /** Input, output and reasoning tokens the agent used, known once it settles. */
  tokens?: number
}

export const Plugin = {
  id: "orbit.tool.workflow",
  effect: Effect.fn("WorkflowTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.make
    const spawn = yield* SubagentTool.spawner()

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          // Visible wherever subagents are: an agent that may not spawn subagents may not run workflows.
          options: { codemode: false, permission: SubagentTool.name },
          traits: { concurrencySafe: false, interruptBehavior: "block" },
          description,
          input: Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              const entries = yield* Ref.make<Array<Entry>>([])
              const lock = Semaphore.makeUnsafe(1)
              const slots = Semaphore.makeUnsafe(CONCURRENCY)
              // Progress replaces the previous metadata, so every update publishes the whole list.
              const record = (sessionID: string, update: (entries: Array<Entry>) => Array<Entry>) =>
                lock.withPermit(
                  Ref.updateAndGet(entries, update).pipe(
                    Effect.tap((list) => context.progress({ agents: list, sessionID })),
                  ),
                )
              const settle = (sessionID: string, status: Entry["status"]) =>
                Effect.gen(function* () {
                  const usage = yield* sessions.get(SessionSchema.ID.make(sessionID)).pipe(
                    Effect.map((info) => info.tokens.input + info.tokens.output + info.tokens.reasoning),
                    Effect.orElseSucceed(() => undefined),
                  )
                  const ended = Date.now()
                  yield* record(sessionID, (list) =>
                    list.map((entry) =>
                      entry.sessionID === sessionID ? { ...entry, status, ended, tokens: usage } : entry,
                    ),
                  )
                })

              const agent = Tool.make({
                description: "Run one subagent to completion and return its final reply",
                input: AgentInput,
                output: Schema.String,
                execute: (call) =>
                  slots.withPermit(
                    Effect.gen(function* () {
                      const admitted = yield* spawn.admit(context, call.agent ?? "general")
                      const override = call.model === undefined ? undefined : yield* spawn.resolveModel(call.model)
                      const model = override ?? admitted.agent.model ?? admitted.parent.model
                      const child = yield* sessions
                        .create({
                          parentID: context.sessionID,
                          title: call.description,
                          agent: admitted.agent.id,
                          model,
                        })
                        .pipe(
                          Effect.mapError(
                            (error) =>
                              new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                          ),
                        )
                      yield* record(child.id, (list) => [
                        ...list,
                        {
                          sessionID: child.id,
                          description: call.description,
                          agent: admitted.agent.id,
                          status: "running",
                          ...(call.phase ? { phase: call.phase } : {}),
                          ...(model ? { model: model.id } : {}),
                          started: Date.now(),
                        },
                      ])
                      yield* sessions
                        .prompt({
                          sessionID: child.id,
                          text: ["You are a subagent spawned by a workflow in another session.", call.prompt].join(
                            "\n",
                          ),
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
                        agent: admitted.agent.name,
                        description: call.description,
                      }
                      yield* subagents.start(recovery)
                      const result = yield* jobs
                        .block({ id: child.id, sessionID: context.sessionID })
                        .pipe(
                          Effect.onInterrupt(() =>
                            Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], { discard: true }),
                          ),
                        )
                      if (result?.type === "backgrounded") {
                        yield* subagents.notify(recovery, result.info.started_at)
                        yield* settle(child.id, "failed")
                        return yield* new ToolFailure({
                          message: `Subagent moved to the background (sessionID: ${child.id}); its result will arrive separately`,
                        })
                      }
                      if (result?.info.status === "error" || result?.info.status === "cancelled") {
                        yield* settle(child.id, "failed")
                        return yield* new ToolFailure({
                          message: `Subagent ${result.info.status === "error" ? "failed" : "cancelled"} (sessionID: ${child.id}): ${result.info.error ?? ""}`,
                        })
                      }
                      yield* settle(child.id, "completed")
                      return result?.info.output ?? SubagentCompletion.NO_TEXT
                    }),
                  ),
              })

              const result = yield* CodeMode.make({
                tools: { agent },
                limits: { maxToolCalls: MAX_AGENTS },
              }).execute(input.script)
              const list = yield* Ref.get(entries)
              const summary = [
                "Agents:",
                ...list.map(
                  (entry) =>
                    `- ${entry.phase ? `[${entry.phase}] ` : ""}${entry.description} (${entry.agent}, ${entry.status}, sessionID: ${entry.sessionID})`,
                ),
              ].join("\n")
              const output = [CodeModeTool.formatResult(result), ...(list.length > 0 ? [summary] : [])].join("\n\n")
              if (!result.ok) return yield* new ToolFailure({ message: `Workflow failed: ${output}` })
              return { content: output, metadata: { agents: list } }
            }),
        }),
      )
      .pipe(Effect.orDie)

    const hook = SubagentTool.describeAgents(agents, name)
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
