import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Environment } from "@orbit/core/environment/index"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { Shell } from "@orbit/core/shell"
import { Document, Info } from "@orbit/schema/config"
import { WorkspaceID } from "@orbit/schema/workspace-id"
import { Global } from "@orbit/util/global"
import { spellingEnv, withLookupVariable } from "../fixture/child-env"
import { hostEnvironmentLayer } from "../fixture/environment"
import { tempGlobalLayer } from "../fixture/global"
import { location } from "../fixture/location"
import { it } from "../lib/effect"

const settings = (env: Record<string, string>, scope: Document["scope"]) =>
  new Document({ type: "document", scope, info: new Info({ env }) })

// The node replacement exposes only Config.Service, so the entries live in a variable the test can reach.
let entries: Document[] = []
const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.sync(() => entries),
    compatEnabled: () => Effect.succeed(Config.defaultCompat.enabled),
    compat: () => Effect.succeed(Config.defaultCompat),
    changes: () => Stream.never,
    fingerprints: () => Effect.succeed([]),
    pluginsChanged: () => Effect.succeed(false),
  }),
)

const harness = (workspaceID?: WorkspaceID) =>
  AppNodeBuilder.build(Shell.node, [
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            Location.Ref.make({
              directory: AbsolutePath.make(process.cwd()),
              ...(workspaceID === undefined ? {} : { workspaceID }),
            }),
          ),
        ),
      ),
    ),
    Global.node.replace(tempGlobalLayer),
    Config.node.replace(configLayer),
    Environment.node.replace(hostEnvironmentLayer),
  ])

// Stops the command after the environment is decided, before anything starts.
const environmentOf = Effect.gen(function* () {
  const shell = yield* Shell.Service
  let seen: Record<string, string | undefined> = {}
  yield* shell
    .create({ shell: "sh", command: "true", timeout: 0 }, (invocation) =>
      Effect.sync(() => {
        seen = invocation.env
      }).pipe(Effect.andThen(Effect.fail("stop"))),
    )
    .pipe(Effect.flip)
  return seen
})

it.live("starts a shell command with the settings' env over the process environment and under Orbit's variables", () =>
  Effect.gen(function* () {
    entries = [
      settings({ ZZ_ENV_A: "user", ZZ_ENV_B: "user", TERM: "dumb", ORBIT_TERMINAL: "0" }, "user"),
      settings({ ZZ_ENV_B: "managed" }, "managed"),
    ]

    const env = yield* environmentOf

    expect(env.ZZ_ENV_A).toBe("user")
    expect(env.ZZ_ENV_B).toBe("managed")
    expect(env.TERM).toBe("xterm-256color")
    expect(env.ORBIT_TERMINAL).toBe("1")
    // The rest of the process environment is still there.
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path)

    // A name removed from the file stops applying to the next command, with no restart.
    entries = [settings({ ZZ_ENV_A: "user" }, "user")]
    const after = yield* environmentOf
    expect(after.ZZ_ENV_A).toBe("user")
    expect(after.ZZ_ENV_B).toBeUndefined()
  }).pipe(Effect.provide(harness())),
)

it.live("gives a workspace-bound location no settings overlay", () =>
  Effect.gen(function* () {
    entries = [settings({ ZZ_ENV_A: "user" }, "user")]

    expect((yield* environmentOf).ZZ_ENV_A).toBeUndefined()
  }).pipe(Effect.provide(harness(WorkspaceID.make("wrk_envtest")))),
)

// Windows keeps one variable per name whatever its case, so the shell's environment must too: with the inherited `Path`
// and a settings `path` side by side, programs would disagree on which one is the search path.
if (process.platform === "win32")
  it.live("gives a shell command one spelling of PATH and no lookup variable from the settings", () =>
    withLookupVariable(
      Effect.gen(function* () {
        entries = [settings(spellingEnv, "user")]

        const env = yield* environmentOf

        expect(Object.entries(env).filter(([name]) => /^path$/i.test(name))).toEqual([["path", spellingEnv.path]])
        // The settings' blank value never reached the environment: the inherited variable is still the one in it.
        expect(Object.entries(env).filter(([name]) => /^nodefaultcurrentdirectoryinexepath$/i.test(name))).toEqual([
          ["NoDefaultCurrentDirectoryInExePath", "1"],
        ])
      }).pipe(Effect.provide(harness())),
    ),
  )
