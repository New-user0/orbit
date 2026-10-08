import { Context, Effect, FileSystem, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
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
    const server = yield* ServerConnection.resolve({
      server: serverURL,
      standalone: input.standalone,
      mismatch: "replace",
    })
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
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
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
