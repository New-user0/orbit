export * as ProjectTrust from "./project-trust.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import type { Document } from "@orbit/schema/config"
import type { Trust } from "@orbit/schema/trust"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Config } from "./config.js"
import { ConfigTrust } from "./config/trust.js"
import { Location } from "./location.js"
import { WorkspaceTrust } from "./workspace-trust.js"

export interface Interface {
  /** Whether this Location's project is trusted now. It reads at most one stored grant, so ask it freely. */
  readonly trusted: () => Effect.Effect<boolean>
  /**
   * Whether this Location's project is trusted, and which config files hold something back now. While the project is
   * untrusted those are its own files. A file in a folder above the project is listed too, until the folder that holds
   * it is trusted, which trusting the project does not do.
   */
  readonly status: () => Effect.Effect<Trust.Status>
  /** Trusts this Location's project; see `WorkspaceTrust.grant`. Config applies what it held back once it reloads. */
  readonly grant: (input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<Trust.Status>
  /** Ends the grants for this Location's project; see `WorkspaceTrust.revoke`. */
  readonly revoke: () => Effect.Effect<Trust.Status>
  /**
   * Whether a file may run the code it carries, such as the hooks in a skill's or an agent's front matter. Callers
   * must ask this before running any such code; see `ConfigTrust.allows`.
   */
  readonly allows: (file: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ProjectTrust") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    // Trust is decided for the project's canonical root, so its linked worktrees share the decision.
    const root = location.project.canonical
    // The folders that decision covers.
    const folders = [...new Set([location.directory, location.project.directory, location.project.canonical])]

    // What a project or local document holds back now. The entries are stamped by the last config load, which can
    // trail a decision by a moment, so for the project's own files the decision just made counts: a trusted project
    // holds nothing back, and a file that is not stamped yet is read for what it would lose. A file above the project
    // follows the decision for its own folder, which only its stamp knows.
    const heldBack = (document: Document, file: string, trusted: boolean) => {
      if (!folders.some((folder) => FSUtil.contains(folder, file))) return document.withheld ?? []
      if (trusted) return []
      if (document.trusted === false) return document.withheld ?? []
      return ConfigTrust.sanitize(document.info, { roots: folders, directory: path.dirname(file) }).withheld
    }

    const report = Effect.fnUntraced(function* (state: WorkspaceTrust.State) {
      const entries = yield* config.entries()
      return {
        ...state,
        withheld: entries.flatMap((entry) => {
          if (entry.type !== "document" || entry.path === undefined) return []
          if (entry.scope !== "project" && entry.scope !== "local") return []
          const kinds = heldBack(entry, entry.path, state.trusted)
          return kinds.length === 0 ? [] : [{ path: entry.path, kinds }]
        }),
      } satisfies Trust.Status
    })

    return Service.of({
      trusted: Effect.fn("ProjectTrust.trusted")(() => trust.status(root).pipe(Effect.map((state) => state.trusted))),
      status: Effect.fn("ProjectTrust.status")(() => trust.status(root).pipe(Effect.flatMap(report))),
      grant: Effect.fn("ProjectTrust.grant")((input) => trust.grant(root, input).pipe(Effect.flatMap(report))),
      revoke: Effect.fn("ProjectTrust.revoke")(() => trust.revoke(root).pipe(Effect.flatMap(report))),
      allows: Effect.fn("ProjectTrust.allows")(function* (file) {
        const state = yield* trust.status(root)
        const compat = yield* config.compat()
        return ConfigTrust.allows(yield* config.entries(), file, {
          roots: folders,
          trusted: state.trusted,
          compat: compat.roots,
        })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [WorkspaceTrust.node, Config.node, Location.node],
})
