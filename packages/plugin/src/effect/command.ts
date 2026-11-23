import type { CommandApi } from "@orbit/client/effect/api"
import type { PromptCommand } from "@orbit/schema/prompt"
import type { PromptInput } from "@orbit/schema/prompt-input"
import type { Session } from "@orbit/schema/session"
import type { SessionInbox } from "@orbit/schema/session-inbox"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  /**
   * The text typed after the command, with the prompt's attachments, and `command`, the record of what was run. A
   * command that admits a prompt passes them on (`...input.prompt`), so the prompt is shown as the command.
   */
  readonly prompt: PromptInput.Prompt & { readonly command?: PromptCommand }
  readonly delivery: SessionInbox.Delivery
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Effect.Effect<void>
}
