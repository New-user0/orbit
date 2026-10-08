import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { Shell } from "@orbit/core/shell"
import { Tool } from "@orbit/core/tool"
import { ShellControlTools } from "@orbit/core/tool/plugin/shell-control"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"
import { executeTool, expectRegistryAsks, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const controlNode = makeLocationNode({
  name: "test/shell-control-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ShellControlTools.Plugin)),
  deps: [Tool.node, Shell.node],
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, Shell.node, controlNode]), [
    Location.node.replace(tempLocationLayer),
    Permission.node.replace(allowAllPermission),
  ]),
)
const sessionID = Session.ID.make("ses_shell_control_test")
const call = (name: string, input: unknown, session = sessionID) => ({
  ...toolIdentity,
  sessionID: session,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})
const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
  result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""

describe("shell control tools", () => {
  it.effect("leaves all three tools to the registry gate", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* expectRegistryAsks(registry, ["shell_output", "shell_watch", "shell_stop"])
    }),
  )

  if (process.platform === "win32") return
  it.live("watch for a line, read new output, and stop a background command", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const registry = yield* Tool.Service
      for (const name of ["shell_output", "shell_watch"])
        expect(yield* toolTraits(registry, name, { id: "x", pattern: "x" })).toMatchObject({
          readOnly: true,
          concurrencySafe: true,
          interruptBehavior: "cancel",
        })
      expect(yield* toolTraits(registry, "shell_stop", { id: "x" })).toMatchObject({
        readOnly: false,
        concurrencySafe: false,
        interruptBehavior: "block",
      })
      const info = yield* shell.create({
        command: "echo start; sleep 0.3; echo ready; sleep 30",
        shell: "/bin/sh",
        metadata: { sessionID },
      })

      const foreign = yield* executeTool(
        registry,
        call("shell_output", { shellID: info.id }, Session.ID.make("ses_other")),
      )
      expect(foreign.status).toBe("error")

      const watched = yield* executeTool(registry, call("shell_watch", { shellID: info.id, pattern: "^ready$" }))
      expect(watched.output).toMatchObject({ status: "running", matched: true })
      expect(text(watched)).toContain("start\nready")

      const output = yield* executeTool(registry, call("shell_output", { shellID: info.id }))
      expect(text(output)).toContain("(no new output)")

      const stopped = yield* executeTool(registry, call("shell_stop", { shellID: info.id }))
      expect(stopped.output).toEqual({ status: "killed" })
      expect((yield* shell.get(info.id)).status).toBe("killed")
      expect((yield* shell.output(info.id)).output).toContain("ready")
    }),
  )
})
