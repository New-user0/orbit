export * as Plugin from "./service.js"

// The service tag lives apart from the layer so Session entry points can wait on activation without
// importing the plugin host, which itself depends on Session.
import { Plugin } from "@orbit/schema/plugin"
import type { Plugin as PluginDefinition } from "@orbit/plugin/effect/plugin"
import { Context, type Effect, type Exit } from "effect"

export interface Interface {
  readonly activate: (plugins: readonly Generation[], failures?: readonly Failure[]) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Plugin.Info[]>
  readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
  /** Wait for announced updates and activation to settle; failures remain in the inventory. */
  readonly awaitActivation: Effect.Effect<void>
  /** Keep readiness pending while preparing an update. Run the returned Effect to release it. */
  readonly hold: () => Effect.Effect<Effect.Effect<void>>
  /**
   * Activate again now, as when a source of the plugins changes, and wait until that activation has applied every
   * plugin that is available locally. A change reaches the supervisor through an event it reads later, so a caller that
   * has just changed what the plugins read (a trust grant or revoke that reloaded the config) asks here, and what it
   * reads next is the new activation's. It does not wait for packages that still have to be installed: those apply
   * later, as they do at startup. Without a supervisor it waits as `awaitActivation` does.
   */
  readonly refresh: () => Effect.Effect<void>
  /** Set by the supervisor: what `refresh` runs to request an activation and wait for its local plugins. */
  readonly supervise: (request: Effect.Effect<void>) => Effect.Effect<void>
}

export type Failure = Plugin.Info & { readonly state: Extract<Plugin.State, { readonly status: "failed" }> }

export type Generation = PluginDefinition & {
  readonly revision: string
  readonly source?: Plugin.Source
  readonly features?: Plugin.Features
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Plugin") {}

/**
 * Session entry points wait here before reading plugin-provided state such as commands, skills, hooks,
 * and the model catalog. A cold Location activates its plugins asynchronously, so without the wait an
 * early request observes an empty registry and admits or fails work the plugins would have shaped.
 */
export const awaitActivation = Service.use((plugins) => plugins.awaitActivation)
