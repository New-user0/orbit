import { Effect, Layer } from "effect"
import { Instructions } from "@orbit/core/instructions/index"
import { MemoryInstructions } from "@orbit/core/memory/instructions"

/**
 * Memory sources that say nothing in the baseline and make no folder. A test of something else that builds the session
 * context replaces the node with it, as it does the scratchpad (`noScratchpad`), so that the request it checks does not
 * hold the memory folder's path on the machine it runs on.
 */
export const noMemory = MemoryInstructions.node.replace(
  Layer.mock(MemoryInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
)
