import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { WorktreeTools } from "@orbit/core/tool/plugin/worktree"
import { Worktree } from "@orbit/core/worktree"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"
import { executeTool, expectRegistryAsks, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const moves: string[] = []
const removed: string[] = []
const node = makeLocationNode({
  name: "test/worktree-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WorktreeTools.Plugin)),
  deps: [Tool.node, Worktree.node, Session.node, Location.node],
})
const unused = () => Effect.die("unused")
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo") }))),
    ),
    Permission.node.replace(allowAllPermission),
    Worktree.node.replace(
      Layer.mock(Worktree.Service, {
        create: (input) => Effect.succeed({ directory: AbsolutePath.make(`/worktrees/${input.name ?? "auto"}`) }),
        remove: (input) => Effect.sync(() => void removed.push(input.directory)),
      }),
    ),
    Session.node.replace(
      Layer.mock(Session.Service, {
        move: (input) => Effect.sync(() => void moves.push(input.directory)),
        revert: { stage: unused, clear: unused, commit: unused },
      }),
    ),
  ]),
)
const call = (name: string, input: unknown) => ({
  ...toolIdentity,
  sessionID: Session.ID.make("ses_worktree_test"),
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

describe("worktree tools", () => {
  it.effect("move a session into a new worktree and back, removing it when asked", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* expectRegistryAsks(registry, ["EnterWorktree", "ExitWorktree"])
      for (const name of ["EnterWorktree", "ExitWorktree"])
        expect(yield* toolTraits(registry, name)).toMatchObject({
          readOnly: false,
          concurrencySafe: false,
          interruptBehavior: "block",
        })
      expect((yield* executeTool(registry, call("ExitWorktree", {}))).status).toBe("error")
      const entered = yield* executeTool(registry, call("EnterWorktree", { name: "spike" }))
      expect(entered.status).toBe("completed")
      expect((yield* executeTool(registry, call("EnterWorktree", {}))).status).toBe("error")
      yield* executeTool(registry, call("ExitWorktree", { remove: true }))
      expect(moves).toEqual(["/worktrees/spike", "/repo"])
      expect(removed).toEqual(["/worktrees/spike"])
    }),
  )
})
