import { Context, Effect, FileSystem, Option } from "effect"
import { EOL } from "node:os"
import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Commands } from "../commands"
import { ConfigOverlay } from "../../config-overlay"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { Config } from "../../config"
import { resolve } from "@orbit/tui/config"
import { KeybindingsFile } from "@orbit/tui/config/keybindings-file"
import { progress } from "@orbit/flow/plain"
import { Global } from "@orbit/util/global"

export default Runtime.handler(Commands.commands.mini, (input) =>
  Effect.gen(function* () {
    const { runMini, validateMiniTerminal } = yield* Effect.promise(() => import("../../mini"))
    yield* Effect.promise(async () => validateMiniTerminal())
    const serverURL = Option.getOrUndefined(input.server)
    // A --settings file or JSON reaches a private server, so it is read here, before anything starts.
    const overlay = yield* ConfigOverlay.apply({ settings: input.settings, server: serverURL })
    const server = yield* ServerConnection.resolve({
      server: serverURL,
      standalone: input.standalone || overlay,
      mismatch: "replace",
    })
    yield* Effect.promise(() => ConfigOverlay.release())
    // A private server shares the database with the background service, so a session the service is running is not
    // driven a second time. The session that is checked is the session that opens.
    const named = Option.getOrUndefined(input.session)
    const checked = overlay
      ? yield* ConfigOverlay.refuseActive({
          client: Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }),
          session: named,
          continue: input.continue,
          fork: input.fork,
          directory: process.cwd(),
        })
      : named
    const session = checked ?? named
    const config = yield* Config.Service
    const global = yield* Global.Service
    const file = KeybindingsFile.locate(config.path)
    const keybindings = yield* Effect.promise(() => KeybindingsFile.load(file))
    // Mini has no toast, so what is wrong with the keybindings file is said once here, before the footer takes the screen.
    if (keybindings.diagnostics.length)
      process.stderr.write(
        [`Keybindings file ${file}:`, ...keybindings.diagnostics.map((note) => `  ${note.message}`)]
          .map((line) => progress(line))
          .join(EOL) + EOL,
      )
    const resolved = resolve(yield* config.get(), { terminalSuspend: process.platform !== "win32", keybindings })
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const service = server.service
    yield* Effect.promise(() =>
      runMini({
        server: {
          endpoint: server.endpoint,
          reconnect: service ? (signal) => runServicePromise(service.reconnect(), { signal }) : undefined,
        },
        continue: input.continue && !(overlay && session !== undefined),
        session,
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        prompt: Option.getOrUndefined(input.prompt),
        replay: Option.getOrUndefined(input.replay) ?? resolved.mini?.replay ?? true,
        replayLimit: Option.getOrUndefined(input.replayLimit) ?? resolved.mini?.replay_limit,
        demo: input.demo,
        tuiConfig: resolved,
        config: {
          update: (update) => runServicePromise(config.update(update)),
        },
        paths: { home: global.home, state: global.state, log: global.log },
      }),
    )
  }),
)
