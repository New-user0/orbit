// m5-quality, FU-M5-002: a slash command the person runs is recorded on the prompt it admits, with its name and the
// arguments as typed, so a client can show `/name args` where the reference shows it (the rewind picker's row, its quote
// and the input it puts back) while the model still gets the expansion. The record is the server's own: it comes from
// the command it ran, and a prompt sent through the public prompt input cannot carry one (class 8: what is shown is
// what ran). A plain prompt has none. Through a real Location boot with a command from the project's config.
import { describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Schema } from "effect"
import path from "path"
import { PromptInput } from "@orbit/schema/prompt-input"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionProjector } from "@orbit/core/session/projector"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// A real Location boot with config discovery.
setDefaultTimeout(15_000)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
    [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const project = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  yield* Effect.promise(() =>
    Bun.write(
      path.join(tmp.path, ".orbit", "orbit.json"),
      JSON.stringify({
        commands: {
          review: { template: "Review $ARGUMENTS carefully." },
          survey: { template: "Survey $ARGUMENTS in a child.", subtask: true },
        },
      }),
    ),
  )
  return tmp
})

describe("a slash command's prompt", () => {
  it.live("records the command's name and its arguments as typed beside the expansion", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.command({ sessionID: session.id, command: "review", text: "src/a.ts --deep" })
      const [item] = yield* sessions.inbox(session.id)
      expect(item).toMatchObject({
        type: "user",
        payload: {
          text: "Review src/a.ts --deep carefully.",
          command: { name: "review", arguments: "src/a.ts --deep" },
        },
      })
    }),
  )

  it.live("records the arguments as empty for a command run without any", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.command({ sessionID: session.id, command: "review", text: "" })
      const [item] = yield* sessions.inbox(session.id)
      expect(item).toMatchObject({ type: "user", payload: { command: { name: "review", arguments: "" } } })
    }),
  )

  // The message the prompt becomes on delivery carries the record, so a client reads it from the conversation.
  it.live("carries the record onto the message the prompt becomes", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.command({ sessionID: session.id, command: "review", text: "src/a.ts" })
      yield* SessionInbox.promote(db, bus, session.id, "steer")
      const [message] = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(message).toMatchObject({
        type: "user",
        text: "Review src/a.ts carefully.",
        command: { name: "review", arguments: "src/a.ts" },
      })
    }),
  )

  // A command that runs in a subagent prompts the child with what the harness built, which is no command the person
  // ran in that child.
  it.live("records no command on the prompt a subagent command gives its child", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.command({ sessionID: session.id, command: "survey", text: "src" })
      const [child] = (yield* sessions.list({ parentID: session.id })).data
      expect(child?.parentID).toBe(session.id)
      const [item] = yield* sessions.inbox(child!.id)
      expect(item).toMatchObject({ type: "user", payload: { text: "Survey src in a child." } })
      expect(item?.type === "user" && "command" in item.payload).toBe(false)
    }),
  )

  // The control: a prompt the person typed is no command.
  it.live("records no command on a plain prompt", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.prompt({ sessionID: session.id, text: "/review src/a.ts", resume: false })
      const [item] = yield* sessions.inbox(session.id)
      expect(item?.type === "user" && "command" in item.payload).toBe(false)
    }),
  )

  // What a client sends as a prompt is decoded with the public prompt input, which has no command to claim.
  it.live("takes no command from the public prompt input", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownSync(PromptInput.Prompt)({
        text: "rm -rf build",
        command: { name: "review", arguments: "src/a.ts" },
      })
      expect(decoded).toEqual({ text: "rm -rf build" })
    }),
  )
})
