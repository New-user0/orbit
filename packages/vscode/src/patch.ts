import { applyPatch } from "diff"

/**
 * The content a proposed change would leave behind, for the before/after diff view. `undefined` when the file changed
 * since the agent read it and the patch no longer applies.
 */
export function proposed(original: string, patch: string) {
  const result = applyPatch(original, patch)
  return result === false ? undefined : result
}
