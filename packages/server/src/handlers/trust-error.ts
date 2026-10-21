import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-services"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { UntrustedFolderError } from "@orbit/protocol/errors"
import { plain } from "@orbit/util/plain"
import { Effect } from "effect"

/**
 * The refusal of work in a folder that is not trusted. It names the folder, through `plain` because a clone picks its
 * own name (class 9), and says how to trust it, so every client can show it as it comes (class 13).
 */
export function untrustedFolder(input: { readonly directory: string; readonly persistent: boolean }) {
  const folder = plain(input.directory)
  return new UntrustedFolderError({
    directory: AbsolutePath.make(input.directory),
    persistent: input.persistent,
    message: input.persistent
      ? `${folder} is not trusted. Trust it with \`orb trust\`, or start \`orb\` there and answer the question.`
      : `${folder} is not trusted. It is a home directory or a filesystem root, which Orbit never trusts for good: start \`orb\` there to trust it until Orbit restarts.`,
  })
}

/**
 * Fails with `UntrustedFolderError` unless this Location's project is trusted. Every route that starts work, or runs
 * something in the folder, asks it first: nothing a folder supplies loads, and no work starts there, until a person
 * trusts it (trust-first, class 12).
 */
export const requireTrusted = Effect.fnUntraced(function* () {
  const trust = yield* ProjectTrust.Service
  if (yield* trust.trusted()) return
  return yield* untrustedFolder(yield* trust.status())
})

/** `requireTrusted` for a folder other than the request's own, such as where a session is created or moved to. */
export const requireTrustedAt = (locations: LocationServiceMap.Service["Service"], ref: Location.Ref) =>
  requireTrusted().pipe(Effect.provide(locations.get(ref)))
