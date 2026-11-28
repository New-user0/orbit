import { FileAccess } from "@orbit/core/file-access"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { InvalidRequestError, UntrustedFolderError } from "@orbit/protocol/errors"
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

/**
 * `requireTrusted` for a folder other than the request's own, such as where a session is created or moved to. It decides
 * for the same folder `ProjectTrust` does, the project's canonical root, without building that folder's Location: a
 * session that is created is not started yet.
 */
export const requireTrustedAt = Effect.fnUntraced(function* (
  services: { readonly projects: Project.Interface; readonly trust: WorkspaceTrust.Interface },
  directory: AbsolutePath,
) {
  const project = yield* services.projects.resolve(directory)
  const state = yield* services.trust.status(project.canonical)
  if (!state.trusted) return yield* untrustedFolder(state)
})

/**
 * A folder or file that the request names besides its Location, read once from `base`, a folder the route names (the
 * Location's, or the session's), never the server process's own (`FileAccess.resolveNamed`). The route checks this value
 * and then acts on the same value (class 3). A name with a null byte, which no file system takes, is refused.
 */
export function resolveNamed(base: string, input: string, home: string, field: string) {
  const resolved = FileAccess.resolveNamed(base, input, home)
  if (resolved === undefined)
    return Effect.fail(new InvalidRequestError({ message: `${field} is not a name a file system takes`, field }))
  return Effect.succeed(resolved)
}
