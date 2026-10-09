export * as WorktreeTools from "./worktree.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Session } from "../../session.js"
import { Worktree } from "../../worktree.js"

/**
 * Lets a session move its own work into a fresh git worktree, so experimental or parallel changes stay off the
 * user's checkout, and move back when done. The move takes effect from the next step, like any session move.
 */

export const EnterInput = Schema.Struct({
  name: Schema.optionalKey(Schema.String).annotate({ description: "Short name for the worktree directory" }),
  branch: Schema.optionalKey(Schema.String).annotate({ description: "Branch to create for it" }),
})

export const ExitInput = Schema.Struct({
  remove: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Delete the worktree after moving back (default false). Fails if it has uncommitted changes.",
  }),
})

export const Plugin = {
  id: "orbit.tool.worktree",
  effect: Effect.fn("WorktreeTools.Plugin")(function* (ctx: Context) {
    const worktrees = yield* Worktree.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    // Where each session came from and the worktree it entered, so exit can return and clean up.
    const entered = new Map<string, { readonly origin: AbsolutePath; readonly worktree: AbsolutePath }>()

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "EnterWorktree",
        options: { codemode: false },
        traits: { interruptBehavior: "block" },
        description:
          "Create a new git worktree of this project and move this session into it, so changes stay off the user's checkout. Use it when the user asks to work in a worktree or on isolated, experimental changes.",
        input: EnterInput,
        execute: (input, context) =>
          Effect.gen(function* () {
            if (entered.has(context.sessionID))
              return yield* new ToolFailure({ message: "This session is already in a worktree. Exit it first." })
            const created = yield* worktrees.create({
              projectID: location.project.id,
              from: location.directory,
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.name ? { name: input.name } : {}),
            })
            yield* sessions.move({ sessionID: context.sessionID, directory: created.directory })
            entered.set(context.sessionID, { origin: location.directory, worktree: created.directory })
            return {
              content: `Created a worktree at ${created.directory}. From the next step this session works there; use ExitWorktree to return.`,
            }
          }).pipe(Effect.mapError(failure("enter a worktree"))),
      })
      editor.add({
        name: "ExitWorktree",
        options: { codemode: false },
        traits: { interruptBehavior: "block" },
        description: "Move this session back from the worktree it entered with EnterWorktree, optionally removing it.",
        input: ExitInput,
        execute: (input, context) =>
          Effect.gen(function* () {
            const state = entered.get(context.sessionID)
            if (!state) return yield* new ToolFailure({ message: "This session did not enter a worktree." })
            yield* sessions.move({ sessionID: context.sessionID, directory: state.origin })
            if (input.remove)
              yield* worktrees.remove({ projectID: location.project.id, directory: state.worktree, force: false })
            entered.delete(context.sessionID)
            return {
              content: `This session returns to ${state.origin} from the next step.${input.remove ? ` Removed ${state.worktree}.` : ` The worktree stays at ${state.worktree}.`}`,
            }
          }).pipe(Effect.mapError(failure("exit the worktree"))),
      })
    })
  }),
}

const failure = (action: string) => (error: unknown) =>
  error instanceof ToolFailure
    ? error
    : new ToolFailure({
        message: `Unable to ${action}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      })
