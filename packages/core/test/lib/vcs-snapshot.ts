import { Layer } from "effect"
import { Instructions } from "@orbit/core/instructions/index"
import { VcsInstructions } from "@orbit/core/vcs/instructions"

/**
 * A repository snapshot that says nothing, as `noScratchpad` is for the scratchpad. A test of something else that builds
 * the session context replaces the node with it, so that the request it checks holds nothing of the repository it runs
 * in and the step does not wait on the trust and config reads that the real source makes.
 */
export const noVcsSnapshot = VcsInstructions.node.replace(
  Layer.succeed(VcsInstructions.Service, { source: () => Instructions.empty }),
)
