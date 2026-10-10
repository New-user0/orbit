// The file tools take a file's lock only after FileAccess has checked the path. The lock key resolves the path on disk,
// and resolving a share connects to its host (about 21 seconds for an unreachable one), so a lock taken first would
// open a share the model named before FileAccess refused it and before anyone was asked (class 6, class 10). A fresh
// TEST-NET-1 host per row makes a connection attempt show as time. Windows only: elsewhere these are ordinary names.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { filesystem } from "@orbit/util/effect/app-node-platform"
import { Database } from "@orbit/core/database/database"
import { Bus } from "@orbit/core/bus"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Job } from "@orbit/core/job"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { Permission } from "@orbit/core/permission"
import { Plugin } from "@orbit/core/plugin"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { Tool } from "@orbit/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_share_lock_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const asked: Permission.AssertInput[] = []
const permission = permissionLayer({ assert: (input) => Effect.sync(() => void asked.push(input)) })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
      filesystem,
      FSUtil.node,
      Global.node,
      SdkPlugins.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Permission.node.replace(permission),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
    ],
  ),
)

const withTools = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "share lock test", location, model: sessionModel })
    const locations = yield* LocationServiceMap.Service
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locations.get(location)), Effect.ensuring(locations.invalidate(location)))
  })

const patch = (text: string) => ({ patchText: `*** Begin Patch\n${text}\n*** End Patch` })

const calls = (share: string) => [
  { tool: "Write", input: { file_path: share, content: "x" } },
  {
    tool: "NotebookEdit",
    input: { notebook_path: `${share}.ipynb`, mode: "insert", index: 0, cell_type: "code", source: "1" },
  },
  { tool: "Patch", input: patch(`*** Add File: ${share}\n+x`) },
  { tool: "Patch", input: patch(`*** Update File: ${share}\n@@\n-a\n+b`) },
  { tool: "Patch", input: patch(`*** Delete File: ${share}`) },
  { tool: "Patch", input: patch(`*** Update File: a.txt\n*** Move to: ${share}\n@@\n-a\n+b`) },
]

const spellings = [
  (host: string) => `\\\\${host}\\share\\a.txt`,
  (host: string) => `//${host}/share/a.txt`,
  (host: string) => `\\\\?\\UNC\\${host}\\share\\a.txt`,
]

describe.skipIf(process.platform !== "win32")("file tools lock a file only after FileAccess checked its path", () => {
  it.live(
    "Write, NotebookEdit and Patch refuse a share at once, ask nobody and wait for no host",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.txt"), "a\n"))
              let row = 0
              for (const spell of spellings)
                for (const entry of calls("SHARE")) {
                  row++
                  const share = spell(`192.0.2.${row}`)
                  const input = JSON.parse(
                    JSON.stringify(entry.input).replaceAll("SHARE", JSON.stringify(share).slice(1, -1)),
                  )
                  asked.length = 0
                  const started = Date.now()
                  const result = yield* executeTool(registry, {
                    sessionID,
                    ...toolIdentity,
                    call: { type: "tool-call", id: `call-share-${row}`, name: entry.tool, input },
                  })
                  const elapsed = Date.now() - started
                  expect([entry.tool, share, result]).toMatchObject([
                    entry.tool,
                    share,
                    { status: "error", error: { type: "file.spelling" } },
                  ])
                  expect([entry.tool, share, asked]).toEqual([entry.tool, share, []])
                  // An unreachable host takes about 21 seconds to give up on.
                  expect([entry.tool, share, elapsed < 5000]).toEqual([entry.tool, share, true])
                }
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 120_000 },
  )
})
