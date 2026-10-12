import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { SessionMessage } from "@orbit/schema/session-message"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { Formatter } from "@orbit/core/formatter"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-services"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Shell } from "@orbit/core/shell"
import { ShellSelect } from "@orbit/core/shell/select"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { plant, withCurrentDirectoryOnPath } from "./fixture/decoy"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location, tempLocationLayer } from "./fixture/location"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// Class 10, for the surfaces that start a program by a name the user or a project chose: a configured formatter, a hook
// command run by the shell that ShellSelect resolves for hooks, and the shell tool. Windows looks in the working folder
// before PATH for a program started by its name, so each surface is run in a folder that holds decoys of every kind
// Windows runs (.exe, .bat, .cmd) named like the program, with NoDefaultCurrentDirectoryInExePath removed from this
// process. The real program, a compiled .exe in a folder of its own, is the control: when it is put on PATH it starts
// exactly once, which also shows that a decoy of the same kind can run, and the decoys of the folder still do not.
const name = "orbit-fake-prog"

// Decoys of every kind Windows runs, in the folder, with a mark that each leaves when run. `plant` also records the
// arguments, so a decoy that ran shows up as a line.
const decoys = (directory: string) =>
  Effect.gen(function* () {
    const ran = yield* Effect.promise(() => plant(directory, name))
    const marks = path.join(directory, "batch-ran.txt")
    yield* Effect.promise(() =>
      Promise.all(
        [".bat", ".cmd"].map((extension) =>
          fs.writeFile(path.join(directory, `${name}${extension}`), `@echo off\r\necho ran> "${marks}"\r\n`),
        ),
      ),
    )
    return async () => [...(await ran()), ...((await Bun.file(marks).exists()) ? ["batch"] : [])]
  })

// A folder first on PATH while `body` runs.
const onPath = <A, E, R>(bin: string, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = process.env.PATH
      process.env.PATH = `${bin}${path.delimiter}${before}`
      return before
    }),
    () => body,
    (before) =>
      Effect.sync(() => {
        process.env.PATH = before
      }),
  )

/**
 * One row: `start` runs the surface in `directory` with the program's name as its command. First with the real program
 * nowhere on PATH, where only a decoy could start; then with it on PATH, where only the real one may.
 */
const row = <E, R, S>(directory: Effect.Effect<string, unknown, R>, start: (directory: string) => Effect.Effect<unknown, E, S>) =>
  Effect.gen(function* () {
    const project = yield* directory
    const bin = (yield* tmpdirScoped()).path
    const projectRan = yield* decoys(project)
    const binRan = yield* Effect.promise(() => plant(bin, name))
    yield* withCurrentDirectoryOnPath(
      Effect.gen(function* () {
        yield* start(project)
        expect(yield* Effect.promise(projectRan)).toEqual([])
        expect(yield* Effect.promise(binRan)).toEqual([])

        yield* onPath(bin, start(project))
        expect(yield* Effect.promise(binRan)).toHaveLength(1)
        expect(yield* Effect.promise(projectRan)).toEqual([])
      }),
    )
  })

// Every shell Windows can offer, as ShellSelect resolves each; one that is not installed here is left out.
const shells = ["pwsh", "powershell", "bash", "cmd"].filter(
  (shell) => process.platform === "win32" && ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, shell)) === shell,
)

// The test compiles its decoy program, which takes longer on a slow disk.
const SLOW = 60_000

describe.skipIf(process.platform !== "win32")("a program started by name, with decoys in the working folder", () => {
  describe("ShellSelect", () => {
    const it = testEffect(Layer.empty)
    it.live(
      "resolves each shell to a path outside a working folder that holds decoys of it",
      () =>
        Effect.gen(function* () {
          const folder = (yield* tmpdirScoped()).path
          yield* Effect.promise(() => plant(folder, "pwsh", "powershell", "bash", "cmd"))
          // The program that spawns looks in its own working folder first, so Orbit's own lookup runs from there too.
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const before = process.cwd()
              process.chdir(folder)
              ShellSelect.resolve.reset()
              return before
            }),
            () =>
              withCurrentDirectoryOnPath(
                Effect.sync(() => {
                  expect(shells.length).toBeGreaterThan(0)
                  for (const shell of shells) {
                    const resolved = ShellSelect.resolve({ priority: "compat" }, shell)
                    expect(path.isAbsolute(resolved)).toBe(true)
                    expect(path.dirname(resolved).toLowerCase()).not.toBe(folder.toLowerCase())
                  }
                }),
              ),
            (before) =>
              Effect.sync(() => {
                process.chdir(before)
                ShellSelect.resolve.reset()
              }),
          )
        }),
      SLOW,
    )
  })

  describe("a configured formatter", () => {
    const it = testEffect(
      AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
      ]),
    )
    it.live(
      "starts the program of PATH for the command head, and never one of the project's folder",
      () =>
        row(
          tmpdirScoped().pipe(Effect.map((tmp) => tmp.path)),
          (directory) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                fs.writeFile(
                  path.join(directory, "orbit.json"),
                  JSON.stringify({ formatter: { probe: { command: [name, "$FILE"], extensions: [".decoy"] } } }),
                ),
              )
              const file = path.join(directory, "test.decoy")
              yield* Effect.promise(() => fs.writeFile(file, "x"))
              yield* Effect.gen(function* () {
                yield* (yield* Plugin.Service).awaitActivation
                return yield* (yield* Formatter.Service).file(file)
              }).pipe(
                Effect.scoped,
                Effect.provide(
                  LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
                ),
              )
            }),
        ),
      SLOW,
    )
  })

  describe("a hook command", () => {
    // The shared plugin fixture has no shell selection; hooks need it to pick the shell their commands run in.
    const it = testEffect(
      Layer.mergeAll(
        PluginTestLayer,
        Config.testLayer(),
        AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
      ),
    )
    const base = {
      sessionID: Session.ID.make("ses_decoy_test"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_decoy_test"),
      id: Tool.CallID.make("call_decoy_test"),
    }
    const document = new Document({
      type: "document",
      scope: "user",
      info: Schema.decodeUnknownSync(Info)({
        hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: `${name} x.js` }] }] },
      }),
    })

    for (const shell of shells)
      it.live(
        `run by ${shell} starts the program of PATH, and never one of the project's folder`,
        () =>
          Effect.gen(function* () {
            const config = yield* Config.Test
            const registry = yield* PluginHooks.Service
            const selection = yield* ShellSelect.Service
            yield* config.setEntries([document])
            yield* selection.transform((editor) => editor.configure(shell))
            yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
            yield* row(
              Location.Service.use((place) => Effect.succeed(place.directory)),
              () =>
                registry
                  .trigger("tool", "execute.before", { ...base, tool: "Bash", input: { command: "ls" } })
                  .pipe(Effect.ignore),
            )
          }),
        SLOW,
      )
  })

  describe("the shell tool", () => {
    const it = testEffect(Layer.empty)
    const harness = (directory: string) =>
      AppNodeBuilder.build(Shell.node, [
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
          ),
        ),
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(Config.testLayer()),
        Environment.node.replace(hostEnvironmentLayer),
      ])

    for (const shell of shells)
      it.live(
        `run in ${shell} starts the program of PATH, and never one of the project's folder`,
        () =>
          row(
            tmpdirScoped().pipe(Effect.map((tmp) => tmp.path)),
            (directory) =>
              Effect.gen(function* () {
                const service = yield* Shell.Service
                const started = yield* service.create({ shell, command: name, timeout: 0 })
                return yield* service.wait(started.id)
              }).pipe(Effect.scoped, Effect.provide(harness(directory))),
          ),
        SLOW,
      )
  })
})
