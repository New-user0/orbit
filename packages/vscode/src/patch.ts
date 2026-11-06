import { applyPatch } from "diff"

/**
 * The content a proposed change would leave behind, for the before/after diff view. `undefined` when the file changed
 * since the agent read it and the patch no longer applies, or when the patch cannot be read: jsdiff throws on a line it
 * does not know, and a terminal UI linked through the bridge sends the patch as it likes.
 */
export function proposed(original: string, patch: string) {
  const result = (() => {
    try {
      return applyPatch(original, patch)
    } catch {
      return false
    }
  })()
  return result === false ? undefined : result
}
