export * as PlanModeTools from "./plan-mode.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Effect, Schema } from "effect"
import path from "path"
import { Agent } from "../../agent.js"
import { Form } from "../../form.js"
import { PlanMode } from "../../plan-mode.js"
import { Session } from "../../session.js"

/**
 * Lets the model move itself into Plan mode for a large or unclear task, and ask the user to approve the finished plan
 * to move back out. Agent switches take effect from the next step, as any other agent switch does.
 */

const plan = PlanMode.agent
const APPROVE = "Approve the plan and start"
const KEEP = "Keep planning"

export const EnterInput = Schema.Struct({
  reason: Schema.optionalKey(Schema.String).annotate({ description: "Why planning first will help, in one sentence." }),
})
export const ExitInput = Schema.Struct({
  plan: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The finished plan, in Markdown, for the user to review.",
  }),
})

export const Plugin = {
  id: "orbit.tool.plan-mode",
  effect: Effect.fn("PlanModeTools.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const forms = yield* Form.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "enter_plan_mode",
        options: { authorizes: true, codemode: false },
        traits: { requiresUserInteraction: true },
        description:
          "Switch to Plan mode to research and design an approach before changing any files. Use it for large tasks, tasks with several reasonable approaches, or when the user asks for a plan. In Plan mode you can read and search but not edit; finish by calling exit_plan_mode with the plan.",
        input: EnterInput,
        output: Schema.Struct({ agent: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            if (context.agent === plan)
              return { output: { agent: plan }, content: "Already in Plan mode. Call exit_plan_mode with the plan." }
            yield* sessions.switchAgent({ sessionID: context.sessionID, agent: plan })
            return {
              output: { agent: plan },
              content:
                "Switched to Plan mode. Research the task without changing files, then call exit_plan_mode with the plan for the user to approve.",
            }
          }).pipe(Effect.mapError(failure("enter Plan mode"))),
      })
      editor.add({
        name: "exit_plan_mode",
        options: { authorizes: true, codemode: false },
        traits: { requiresUserInteraction: true },
        description:
          "In Plan mode, present the finished plan to the user for approval. If they approve, Plan mode ends and you can carry out the plan; otherwise keep planning with their feedback.",
        input: ExitInput,
        output: Schema.Struct({ approved: Schema.Boolean, feedback: Schema.optionalKey(Schema.String) }),
        execute: (input, context) =>
          Effect.gen(function* () {
            if (context.agent !== plan)
              return yield* new ToolFailure({ message: "Not in Plan mode; there is no plan to approve." })
            const state = yield* forms.ask({
              sessionID: context.sessionID,
              title: "Review plan",
              metadata: { kind: "plan", tool: { messageID: context.messageID, id: context.id } },
              fields: [
                {
                  key: "decision",
                  type: "string",
                  title: "Plan",
                  description: input.plan,
                  options: [
                    { value: APPROVE, label: APPROVE },
                    { value: KEEP, label: KEEP },
                  ],
                  custom: true,
                },
              ],
            })
            if (state.status === "cancelled")
              return yield* new ToolFailure({ message: state.message ?? "The user dismissed the plan. Keep planning." })
            const answer = String(state.answer.decision ?? "")
            if (answer !== APPROVE)
              return {
                output: { approved: false, feedback: answer === KEEP ? undefined : answer },
                content:
                  answer === KEEP || answer === ""
                    ? "The user wants to keep planning. Ask what to change, or refine the plan."
                    : `The user did not approve the plan yet. Their feedback: ${answer}`,
              }
            const file = path.join(PlanMode.directory(global.home), `${context.sessionID}.md`)
            yield* fs.writeWithDirs(file, input.plan)
            // The agent the session planned from is in its durable history, so a restart does not lose it. When the
            // history names none (the session started in Plan mode, or had no agent selected), return to the agent the
            // runner picks for a session without one: the configured default.
            const previous = yield* PlanMode.previousAgent(sessions, context.sessionID)
            const target = previous ?? (yield* agents.select()).id
            // Approving a plan has to leave Plan mode, which a configured default of Plan mode itself would not do.
            yield* sessions.switchAgent({
              sessionID: context.sessionID,
              agent: target === plan ? Agent.defaultID : target,
            })
            return {
              output: { approved: true },
              content: `The user approved the plan, saved at ${file}. Plan mode has ended; carry out the plan.`,
            }
          }).pipe(Effect.mapError(failure("present the plan"))),
      })
    })
  }),
}

const failure = (action: string) => (error: unknown) =>
  error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to ${action}`, error })
