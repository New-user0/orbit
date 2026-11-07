export * as EmbeddedHost from "./host"

import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { SessionRestart } from "@orbit/core/session/execution/restart"
import { Project } from "@orbit/core/project"
import { Session } from "@orbit/core/session"
import { Workspace } from "@orbit/core/workspace"
import { WorkspaceDriver } from "@orbit/core/workspace/driver"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { createEmbeddedRoutes } from "@orbit/server/routes"
import type { ServerOptions } from "@orbit/server/options"
import type { LayerNode } from "@orbit/util/effect/layer-node"
import { ProgramLookup } from "@orbit/util/program-lookup"
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { context, layer, type LogOptions } from "../logging"
import { OwnedFetch } from "./fetch"
import { SdkInstances } from "./instances"

export interface CreateOptions<R = never> extends Omit<ServerOptions, "hostname" | "port" | "password"> {
  readonly log?: LogOptions
  readonly workspaceProviders?: Readonly<Record<string, WorkspaceDriver.Interface>>
  readonly instances?: SdkInstances.Options<R>
}

/** Host hooks for embedding orbit on a non-default runtime profile. */
export interface EmbedOptions {
  readonly overrides?: LayerNode.Replacements
}

export const create = Effect.fn("EmbeddedHost.create")(function* <R = never>(
  options: CreateOptions<R> = {},
  embed: EmbedOptions = {},
) {
  // The host runs in the process of whoever embeds it and starts programs by name in the folders it is pointed at.
  ProgramLookup.install()
  const { log, workspaceProviders, instances, ...server } = options
  const selector = instances ? SdkInstances.provide(instances, yield* Effect.context<R>()) : undefined
  const runtime = ManagedRuntime.make(
    createEmbeddedRoutes(
      {
        ...server,
        app: { ...server.app, name: server.app?.name ?? "sdk" },
        database: { path: ":memory:", ...server.database },
      },
      workspaceProviders
        ? [...(embed.overrides ?? []), WorkspaceDriver.node.replace(WorkspaceDriver.registryNode(workspaceProviders))]
        : embed.overrides,
      selector ? (replacements) => SdkInstances.node(selector, replacements) : undefined,
    ).pipe(Layer.provide(HttpServer.layerServices), Layer.provideMerge(layer(log))),
  )

  return yield* Effect.gen(function* () {
    const services = yield* runtime.contextEffect
    // The sweep is a no-op when nothing is suspended. ManagedRuntime owns the
    // fiber so recovery never delays startup but still stops with the host.
    runtime.runFork(Context.get(services, SessionRestart.Service).resumeSuspendedSessions)
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
      context(services),
    )(Context.get(services, HttpRouter.HttpRouter).asHttpEffect())
    const transport = OwnedFetch.make(handler, runtime.dispose)
    const sessions = Context.get(services, Session.Service)
    const projects = Context.get(services, Project.Service)
    const trust = Context.get(services, WorkspaceTrust.Service)
    // The Effect SDK creates a session through core, past the `session.create` route and its check, so it asks what the
    // route asks: whether the folder the session will work in (the one named, or the parent's) is trusted, decided by its
    // project's canonical folder (trust-first, class 12). A move is checked in core `SessionMove` itself.
    const create = Effect.fn("EmbeddedHost.sessions.create")(function* (
      input: Parameters<Session.Interface["create"]>[0],
    ) {
      const directory =
        input.parentID === undefined
          ? input.location.directory
          : (yield* sessions.get(input.parentID)).location.directory
      const state = yield* trust.status((yield* projects.resolve(directory)).canonical)
      if (!state.trusted)
        return yield* new WorkspaceTrust.UntrustedError({ directory: state.directory, persistent: state.persistent })
      return yield* sessions.create(input)
    })

    return {
      runtime,
      fetch: transport.fetch,
      plugins: Context.get(services, SdkPlugins.Service),
      sessions: { ...sessions, create },
      workspace: Context.get(services, Workspace.Service),
      close: transport.close,
    }
  }).pipe(Effect.onError(() => runtime.disposeEffect))
})

export type Interface = Effect.Success<ReturnType<typeof create>>
