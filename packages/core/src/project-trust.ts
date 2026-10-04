export * as ProjectTrust from "./project-trust.js"

import { Context, Effect, Layer } from "effect"
import type { Trust } from "@orbit/schema/trust"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Config } from "./config.js"
import { Location } from "./location.js"
import { WorkspaceTrust } from "./workspace-trust.js"

export interface Interface {
  /** Whether this Location's project is trusted, and while it is not, which config files hold something back. */
  readonly status: () => Effect.Effect<Trust.Status>
  /** Trusts this Location's project; see `WorkspaceTrust.grant`. Config applies what it held back once it reloads. */
  readonly grant: (input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<Trust.Status>
  /** Ends the grants for this Location's project; see `WorkspaceTrust.revoke`. */
  readonly revoke: () => Effect.Effect<Trust.Status>
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

    const report = Effect.fnUntraced(function* (state: WorkspaceTrust.State) {
      // Entries are stamped by the last config load, which can trail a grant by a moment; a trusted project has
      // nothing held back whatever they say.
      if (state.trusted) return { ...state, withheld: [] }
      const entries = yield* config.entries()
      return {
        ...state,
        withheld: entries.flatMap((entry) =>
          entry.type === "document" && entry.trusted === false && entry.path !== undefined && entry.withheld?.length
            ? [{ path: entry.path, kinds: entry.withheld }]
            : [],
        ),
      } satisfies Trust.Status
    })

    return Service.of({
      status: Effect.fn("ProjectTrust.status")(() => trust.status(root).pipe(Effect.flatMap(report))),
      grant: Effect.fn("ProjectTrust.grant")((input) => trust.grant(root, input).pipe(Effect.flatMap(report))),
      revoke: Effect.fn("ProjectTrust.revoke")(() => trust.revoke(root).pipe(Effect.flatMap(report))),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [WorkspaceTrust.node, Config.node, Location.node],
})
