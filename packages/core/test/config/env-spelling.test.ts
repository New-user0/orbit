import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { ConfigEnv } from "@orbit/core/config/env"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Pty } from "@orbit/core/pty"
import { Session } from "@orbit/core/session"
import { ShellSelect } from "@orbit/core/shell/select"
import { Document, Info } from "@orbit/schema/config"
import { SessionMessage } from "@orbit/schema/session-message"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { AppProcess } from "@orbit/util/process"
import { expectOneSpelling, received, spellingEnv, withLookupVariable } from "../fixture/child-env"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const decode = Schema.decodeUnknownSync(Info)
const document = (value: unknown) => new Document({ type: "document", scope: "user", info: decode(value) })

// The terminal's environment is built by a pure function, so every platform's rules are tested wherever the suite runs.
describe("the environment of a terminal", () => {
  const inherited = { Path: "C:\\inherited", NoDefaultCurrentDirectoryInExePath: "1", Other: "kept" }
  const settings = ConfigEnv.resolve([document({ env: spellingEnv })], "win32")

  const names = (env: Record<string, string>, pattern: RegExp) => Object.keys(env).filter((name) => pattern.test(name))

  test("on Windows holds one spelling of PATH, from the settings, and the lookup variable at 1", () => {
    const env = Pty.environment(inherited, settings, {}, "win32")

    expect(names(env, /^path$/i)).toEqual(["path"])
    expect(env.path).toBe(spellingEnv.path)
    expect(Object.entries(env).filter(([name]) => /^nodefaultcurrentdirectoryinexepath$/i.test(name))).toEqual([
      ["NoDefaultCurrentDirectoryInExePath", "1"],
    ])
    expect(env.Other).toBe("kept")
  })

  test("on Windows lets the caller's spelling replace the settings' one, and Orbit's own variables win", () => {
    const env = Pty.environment(inherited, settings, { PATH: "C:\\caller", term: "dumb", lang: "x" }, "win32")

    expect(names(env, /^path$/i)).toEqual(["PATH"])
    expect(env.PATH).toBe("C:\\caller")
    expect(names(env, /^term$/i)).toEqual(["TERM"])
    expect(env.TERM).toBe("xterm-256color")
    expect(names(env, /^lang$/i)).toEqual(["LANG"])
    expect(env.LANG).toBe("C.UTF-8")
  })

  test("elsewhere keeps names exactly as given", () => {
    const env = Pty.environment({ Path: "a" }, { path: "b" }, {}, "linux")

    expect(names(env, /^path$/i).toSorted()).toEqual(["Path", "path"])
    expect(env.LANG).toBeUndefined()
  })
})

// Hooks go through a shell the Windows suite for them does not run, so the command is recorded as the plugin builds it
// and then started as given, through the real spawner, to see what a child receives.
const hooks = testEffect(
  Layer.mergeAll(
    PluginTestLayer,
    Config.testLayer(),
    AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

describe.skipIf(process.platform !== "win32")("a hook on Windows", () => {
  hooks.live("receives one spelling of PATH and the lookup variable at 1, whatever the settings say", () =>
    withLookupVariable(
      Effect.gen(function* () {
        const registry = yield* PluginHooks.Service
        const config = yield* Config.Test
        const recorded: ChildProcess.Command[] = []
        const real = yield* AppProcess.Service
        const recording = AppProcess.Service.of({
          ...real,
          run: (command) =>
            Effect.sync(() => {
              recorded.push(command)
              return {
                command: "recorded",
                exitCode: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            }),
        })
        yield* config.setEntries([
          document({ env: spellingEnv, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] } }),
        ])
        yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service)).pipe(
          Effect.provideService(AppProcess.Service, recording),
        )
        yield* registry.trigger("session", "prompt", {
          sessionID: Session.ID.make("ses_env_spelling"),
          messageID: SessionMessage.ID.make("msg_env_spelling"),
          prompt: { text: "go" },
          delivery: "steer" as const,
        })

        const command = recorded[0]
        if (!command || !ChildProcess.isStandardCommand(command)) throw new Error("Expected a hook command")
        expectOneSpelling(yield* received(command.options))
      }),
    ),
  )
})
