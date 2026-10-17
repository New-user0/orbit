import { describe, expect } from "bun:test"
import { ToolFailure } from "@orbit/ai"
import { Effect, Option, Stream, Types } from "effect"
import type { ToolHooks } from "@orbit/plugin/effect/tool"
import { Agent } from "@orbit/core/agent"
import { Environment } from "@orbit/core/environment/index"
import { PlanPlugin } from "@orbit/core/plugin/plan"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { Tool } from "@orbit/schema/tool"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { it } from "../lib/effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { host } from "./host"

const sessionID = Session.ID.make("ses_plan_test")
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const home = "/home/plan-test"
const planDirectory = path.join(home, ".orbit", "plan")

/** Runs the plan plugin against stubbed domains, capturing the tool hook. The host has no session or event stubs, so a plugin that persists or subscribes would die. */
const run = Effect.fnUntraced(function* (planHome = home) {
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  const planAgent = {
    id: plan,
    name: Agent.Name.make("Plan"),
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ],
  } satisfies Types.DeepMutable<Agent.Info>
  const driver = Environment.makeMemoryDriver()
  yield* PlanPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({
            list: () => [planAgent],
            get: (id) => (id === plan ? planAgent : undefined),
            default: () => {},
            update: (id, update) => {
              if (id === plan) update(planAgent)
            },
            remove: () => {},
          })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      event: { subscribe: () => Stream.die("unused event.subscribe") },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name, callback) => {
          if (name === "execute.after") {
            // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            toolHook = callback as unknown as (input: ToolHooks["execute.after"]) => Effect.Effect<void>
          }
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  ).pipe(
    Effect.provide(AppNodeBuilder.build(LayerNode.group([FSUtil.node]))),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: planHome })),
    Effect.provideService(
      Environment.Service,
      Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner }),
    ),
  )
  if (!toolHook) return yield* Effect.die("plan plugin did not register a tool hook")
  return { toolHook, files: Environment.makeFiles(driver), planAgent }
})

type ToolErrorEvent = Extract<ToolHooks["execute.after"], { readonly status: "error" }>

const toolError = (tool: "Edit" | "Write" | "Patch", error: Tool.Error): ToolErrorEvent => ({
  tool,
  input: {},
  sessionID,
  agent: plan,
  messageID: SessionMessage.ID.make("msg_plan_tool"),
  id: Tool.CallID.make("call_plan_tool"),
  status: "error",
  error,
})

describe("plan plugin mutations", () => {
  it.effect("does not create the Plan directory during activation", () =>
    Effect.gen(function* () {
      const { files } = yield* run()
      expect(Option.isNone(yield* files.stat(planDirectory).pipe(Effect.option))).toBe(true)
    }),
  )

  it.effect("allows edits only inside the Plan directory", () =>
    Effect.gen(function* () {
      const { planAgent } = yield* run()
      expect(Permission.evaluate("edit", path.join(planDirectory, "work.md"), planAgent.permissions).effect).toBe(
        "allow",
      )
      expect(Permission.evaluate("edit", "/workspace/source.ts", planAgent.permissions).effect).toBe("deny")
      expect(Permission.evaluate("edit", "source.ts", planAgent.permissions).effect).toBe("deny")
      expect(Permission.evaluate("shell", "git status", planAgent.permissions).effect).toBe("ask")
    }),
  )

  // Deny and ask rules are decided on the real place, so the allow for the folder is also written for it when a link is
  // part of the folder's path (a linked home, or a linked ~/.orbit) and not otherwise.
  for (const linkAt of ["home", "orbit", "none"] as const)
    it.live(`also allows the real path of the Plan directory, link at: ${linkAt}`, () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const realHome = path.join(tmp, "real")
        const linked = path.join(tmp, "linked")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(realHome, ".orbit"), { recursive: true })
          if (linkAt === "home") await fs.symlink(realHome, linked, "junction")
          if (linkAt === "orbit") {
            await fs.mkdir(path.join(tmp, "dotfiles"))
            await fs.rmdir(path.join(realHome, ".orbit"))
            await fs.symlink(path.join(tmp, "dotfiles"), path.join(realHome, ".orbit"), "junction")
          }
        })
        const where = linkAt === "home" ? linked : realHome
        const { planAgent } = yield* run(where)
        const real = yield* Effect.promise(() => fs.realpath(path.join(where, ".orbit")))
        const folders = new Set(
          planAgent.permissions.filter((rule) => rule.action === "Edit" && rule.effect === "allow").map((rule) => rule.resource),
        )
        expect(folders.has(path.join(where, ".orbit", "plan", "*"))).toBe(true)
        expect(folders.has(path.join(real, "plan", "*"))).toBe(true)
        expect(folders.size).toBe(linkAt === "none" ? 1 : 2)
      }),
    )

  it.effect("marks only its own deny of edits as the mode's, which shell probes skip", () =>
    Effect.gen(function* () {
      const { planAgent } = yield* run()
      expect(
        planAgent.permissions.filter(Agent.isModeRule).map((rule) => [rule.action, rule.resource, rule.effect]),
      ).toEqual([["Edit", "*", "deny"]])
    }),
  )

  it.effect("allows the Plan directory external boundary", () =>
    Effect.gen(function* () {
      const { planAgent } = yield* run()
      expect(
        Permission.evaluate("external_directory", path.join(planDirectory, "*"), planAgent.permissions).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(planDirectory, "nested", "*"), planAgent.permissions)
          .effect,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", "/outside/*", planAgent.permissions).effect).toBe("ask")
    }),
  )

  it.effect("rewrites blocked mutation failures with the Plan directory", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      for (const tool of ["Edit", "Write", "Patch"] as const) {
        const event = toolError(
          tool,
          new ToolFailure({
            message: "Unable to modify file",
            error: new Permission.BlockedError({
              rules: [],
              permission: "edit",
              resources: ["source.ts"],
            }),
          }),
        )
        yield* toolHook(event)
        expect(event.error.message).toContain("outside the Plan directory")
        expect(event.error.message).toContain(planDirectory)
      }
    }),
  )

  it.effect("preserves mutation failures unrelated to permissions", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      const error = new ToolFailure({ message: "oldString was not found" })
      const event = toolError("Edit", error)
      yield* toolHook(event)
      expect(event.error).toBe(error)
    }),
  )
})
