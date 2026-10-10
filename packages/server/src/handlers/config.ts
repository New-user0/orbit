import { Config } from "@orbit/core/config"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ShellSelect } from "@orbit/core/shell/select"
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
        return {
          compatibility: yield* config.compatEnabled(),
          permissions: {
            bypass: restrictions.disable_bypass_permissions !== true,
            always: restrictions.managed_permissions_only !== true,
          },
          // The marketplaces list stays in ManagedPolicy for the extensibility work.
          plugins: {
            ...(restrictions.plugins?.allow === undefined ? {} : { allow: restrictions.plugins.allow }),
            ...(restrictions.plugins?.block === undefined ? {} : { block: restrictions.plugins.block }),
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
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    ),
)
