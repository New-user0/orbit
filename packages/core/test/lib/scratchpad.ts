import { Effect, Layer } from "effect"
import { Instructions } from "@orbit/core/instructions/index"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"

/**
 * A scratchpad that names no folder, says nothing in the baseline and makes nothing. A test of something else that
 * builds the session context replaces the node with it, as it replaces each other producer of the baseline, so that
 * the request it checks does not hold a path of the machine it runs on.
 */
export const noScratchpad = SessionScratchpad.node.replace(
  Layer.mock(SessionScratchpad.Service, {
    path: () => undefined,
    source: () => Instructions.empty,
    ensure: () => Effect.void,
  }),
)
