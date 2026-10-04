export * as SessionCommand from "./command.js"

import type { PromptInput } from "@orbit/schema/prompt-input"
import type { Session } from "@orbit/schema/session"
import type { SessionInbox } from "@orbit/schema/session-inbox"
import { Effect } from "effect"
import { Command } from "../command.js"
import { Instance } from "../instance/service.js"
import { Permission } from "../permission.js"
import { Plugin } from "../plugin/service.js"

export const execute = Effect.fn("SessionCommand.execute")(function* (input: {
  session: Session.Info
  command: string
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  delivery?: SessionInbox.Delivery
}) {
  const instances = yield* Instance.Service
  const commands = yield* Plugin.awaitActivation.pipe(Effect.andThen(Command.Service), instances.provide(input.session))
  yield* commands
    .execute({
      name: input.command,
      invocation: {
        sessionID: input.session.id,
        prompt: {
          text: input.text,
          files: input.files,
          agents: input.agents,
          skills: input.skills,
        },
        delivery: input.delivery ?? "steer",
      },
    })
    .pipe(
      // Permission.assert reports a plain reject as a defect so a tool cannot swallow it, and the step that runs the
      // tool turns it back into a decline. Nothing does that for a command the user typed, so without this their
      // "no" would reach the client as an internal error.
      Effect.catchDefect((defect) =>
        defect instanceof Permission.DeclinedError
          ? Effect.fail(
              new Command.ExecutionError({ command: input.command, message: "Shell interpolation was declined" }),
            )
          : Effect.die(defect),
      ),
    )
})
