export * as SessionInstructionPreview from "./instruction-preview.js"

import { Instruction } from "@orbit/schema/instruction"
import { Effect } from "effect"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Plugin } from "../plugin/service.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import type { SessionSchema } from "./schema.js"

export type Error = AgentNotFoundError

export interface Result {
  readonly status: Instruction.Status
  /** The baseline the next request sends. Unset while `blocked` says why it cannot be built. */
  readonly initial?: string
  /** The instruction update the next step boundary would record. Empty when nothing changed. */
  readonly update?: string
  /** The instruction sources that are unavailable and keep an uninitialized session from having a baseline. */
  readonly blocked?: ReadonlyArray<string>
}

/**
 * What the instruction files are and what the next step would send of them, without mutating the Session. The preview
 * does not depend on the model, so it works with no provider configured and makes no provider call.
 */
export const preview = Effect.fn("SessionInstructionPreview.preview")(function* (session: SessionSchema.Info) {
  const instances = yield* Instance.Service
  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const discovery = yield* InstructionDiscovery.Service
    const database = yield* Database.Service
    const selection = yield* context.select(session.id)
    // An agent that leaves the instruction files out of its context sends none of them, so none are listed.
    const status = selection.agent.info.context?.instructions === false
      ? new Instruction.Status({ files: [], warnings: [], available: (yield* discovery.status()).available })
      : yield* discovery.status()
    return yield* SessionHistory.preview(database.db, session.id, selection.instructions, "local").pipe(
      Effect.map((history): Result => ({ status, initial: history.initial, update: history.instructionUpdate ?? "" })),
      Effect.catchIf(
        (error): error is Instructions.InitializationBlocked => error instanceof Instructions.InitializationBlocked,
        (error) =>
          Effect.logWarning("instruction preview blocked", { sessionID: session.id, keys: error.keys }).pipe(
            Effect.as<Result>({ status, blocked: error.keys }),
          ),
      ),
    )
  }).pipe(instances.provide(session))
})
