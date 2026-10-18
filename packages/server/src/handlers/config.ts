import { Config } from "@orbit/core/config"
import { HookSources } from "@orbit/core/config/hook-sources"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ShellSelect } from "@orbit/core/shell/select"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.effective",
      Effect.fn(function* () {
        const config = yield* Config.Service
        const managed = yield* ManagedPolicy.Service
        const restrictions = managed.current().restrictions
        const organization = managed.current().organization
        return {
          compatibility: yield* config.compatEnabled(),
          permissions: {
            bypass: restrictions.disable_bypass_permissions !== true,
            always: restrictions.managed_permissions_only !== true,
          },
          hooks: HookSources.limit(yield* config.entries(), restrictions),
          mcp: { managed_only: restrictions.mcp?.managed_only === true },
          // The marketplaces list stays in ManagedPolicy for the extensibility work.
          plugins: {
            ...(restrictions.plugins?.allow === undefined ? {} : { allow: restrictions.plugins.allow }),
            ...(restrictions.plugins?.block === undefined ? {} : { block: restrictions.plugins.block }),
            ...(organization === undefined ? {} : { organization }),
          },
        }
      }),
    )
    .handle(
      "config.update",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
        return yield* config.update(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.sources.changed",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        // Only a user, project or local configuration directory counts, compared by real path. The paths are never read
        // here: an owner reloads from the entries it already has, so a forged path costs at most one more reload.
        const roots = yield* Effect.promise(() =>
          Promise.all(
            entries
              .flatMap((entry) => (entry.type === "directory" && entry.scope && ["user", "project", "local"].includes(entry.scope) ? [entry.path] : []))
              .map(realPath),
          ),
        )
        const accepted = yield* Effect.promise(() =>
          Promise.all(
            ctx.payload.paths
              .filter((file) => path.isAbsolute(file))
              .map(async (file) => {
                const real = await realPath(file)
                if (real === undefined) return undefined
                return roots.some((root) => root !== undefined && FSUtil.contains(root, real))
                  ? file
                  : undefined
              }),
          ),
        )
        yield* config.notify(accepted.filter((file): file is string => file !== undefined))
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    ),
)

/** The real path, or nothing when the file is not there: a path that does not exist cannot have been written. */
const realPath = (file: string) => realpath(file).then((real) => real, () => undefined)
