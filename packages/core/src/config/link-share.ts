export * as LinkShare from "./link-share.js"

import path from "path"
import { Effect } from "effect"
import type { FSUtil } from "@orbit/util/fs-util"

/**
 * The share that a link on the way to a file names, when one does: opening a path through such a link connects to the
 * share, which is a request to a host that the repository chose. The links are read one part at a time, which touches no
 * share, and the share is named as the link says. Only Windows has them. This is a leaf, so that the trust decision and
 * the fingerprints ask the same question the same way.
 */
export const of = (fs: FSUtil.Interface, file: string, depth = 0): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (process.platform !== "win32" || depth >= 40) return undefined
    const parts = path.relative(path.parse(file).root, file).split(path.sep)
    for (const index of parts.keys()) {
      const named = path.join(path.parse(file).root, ...parts.slice(0, index + 1))
      const target = yield* fs.readLink(named).pipe(Effect.orElseSucceed(() => undefined))
      if (target === undefined) continue
      // A link to a device path (`\\?\Volume{…}\…`, `\\.\…`) reads back in the NT form `\??\…`, which `path.resolve`
      // would take for a folder named `??` on the current drive. It is named as the device path it is.
      if (target.startsWith("\\??\\")) return path.join(`\\\\?\\${target.slice(4)}`, ...parts.slice(index + 1))
      const leads = path.join(path.resolve(path.dirname(named), target), ...parts.slice(index + 1))
      if (leads.startsWith("\\\\")) return leads
      const deeper = yield* of(fs, leads, depth + 1)
      if (deeper !== undefined) return deeper
    }
    return undefined
  })
