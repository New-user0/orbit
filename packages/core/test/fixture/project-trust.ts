import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "./global"
import { location } from "./location"

/**
 * A project that is trusted, as the core tests run it: every file may be read and no path leads out of the project. For
 * the tests of the plugins that ask `ProjectTrust` about a file but have nothing to say about trust themselves; the
 * tests that do use `untrustedProject`.
 */
export const trustedProject = Layer.mock(ProjectTrust.Service, {
  trusted: () => Effect.succeed(true),
  trustedAt: () => Effect.succeed(true),
  allows: () => Effect.succeed(true),
  reachable: () => Effect.succeed(true),
  escapes: () => Effect.succeed(undefined),
  leads: (file) => Effect.succeed(file),
  supplies: () => Effect.succeed(true),
  trustedSource: () => Effect.succeed(true),
  git: () => Effect.succeed(true),
})

/**
 * What makes the project of a graph that builds `ProjectTrust` itself untrusted, where the core tests would otherwise
 * trust every folder: no implicit trust, over a config with nothing in it.
 */
export const untrustedProjectNodes = [
  Config.node.replace(Config.testLayer()),
  WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
  Global.node.replace(tempGlobalLayer),
] satisfies LayerNode.Replacements

/**
 * The real `ProjectTrust` for a project in a folder that nothing trusts, until the service it provides grants it. It
 * provides the `Bus` that announces the decision as well, so that a plugin which listens for it hears the grant.
 */
export const untrustedProject = (input: { readonly directory: string; readonly projectDirectory?: string }) =>
  AppNodeBuilder.build(LayerNode.group([ProjectTrust.node, Bus.node]), [
    ...untrustedProjectNodes,
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(input.directory) },
            input.projectDirectory === undefined ? {} : { projectDirectory: AbsolutePath.make(input.projectDirectory) },
          ),
        ),
      ),
    ),
  ])
