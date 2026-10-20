export * as ParsedSize from "./parsed-size.js"

// YAML keeps an alias as one more reference to the node its anchor names, so a parser hands back a graph and not a tree:
// a few hundred bytes of anchors, each a list that names the one before ten times, stand for billions of values, and a
// node may hold itself. The parse costs no more than the text, but every reader that copies, walks or serializes the
// value pays for each path through it, and that is where the time and the memory go. A value is therefore measured as
// it would be written out, every alias followed, and a reader refuses one that comes to more than its text could spell.

/** What a value read from YAML may come to beyond the length of its text, for a construct that spells more than it takes. */
export const MARGIN = 10_000

/** How deep a value may nest. A copy or a serialization that recurses runs out of stack at some depth that no file needs. */
export const DEPTH = 1_000

/**
 * Whether `value`, with every alias followed, comes to no more than `allowance` and nests no deeper than `DEPTH`. Each value
 * counts one, and each string and each object key counts its length as well, which is what a copy or a serialization of
 * it pays. A value is charged when it is found, before it is looked at, and the walk stops once the allowance is spent,
 * so the walk itself takes no more steps than the allowance, whatever the value repeats or holds of itself, and it builds
 * nothing for the values it passes, so it leaves no garbage behind either.
 */
export function within(value: unknown, allowance: number) {
  const open: unknown[] = [value]
  const depths: number[] = [0]
  let left = allowance - 1
  while (open.length > 0 && left >= 0) {
    const node = open.pop()
    const depth = depths.pop()!
    if (typeof node === "string") left -= node.length
    if (typeof node !== "object" || node === null) continue
    if (depth >= DEPTH) return false
    // The indexes of a list are not written in its text, so only its items count; the keys of an object are.
    if (Array.isArray(node)) {
      for (const item of node) {
        if (--left < 0) break
        open.push(item)
        depths.push(depth + 1)
      }
      continue
    }
    const fields = node as Readonly<Record<string, unknown>>
    for (const key in fields) {
      left -= 1 + key.length
      if (left < 0) break
      open.push(fields[key])
      depths.push(depth + 1)
    }
  }
  return left >= 0
}
