import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInbox } from "@orbit/core/session/inbox"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionMessageTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SessionTransfer } from "@orbit/core/session/transfer"
import { SessionTurn } from "@orbit/core/session/turn"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      InstructionEntry.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const backup = { id: Model.ID.make("backup"), providerID: Provider.ID.make("provider") }

// A Session that ran a limited turn: prompt A with options, then a fallback note and a stop-hook note. With `queued`,
// a prompt Q then started a turn of its own in the same busy period, and the Session went idle.
const limitedTurn = (input: { queued: boolean }) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const created = yield* session.create({ location })
    yield* session.prompt({ sessionID: created.id, text: "A", turn: { maxSteps: 1 }, resume: false })
    yield* SessionInbox.promote(db, bus, created.id, "input")
    yield* bus.publish(SessionEvent.Synthetic, {
      sessionID: created.id,
      text: "Switched to the backup model",
      metadata: { notice: "fallback", model: backup },
    })
    yield* bus.publish(SessionEvent.Synthetic, {
      sessionID: created.id,
      text: "A stop hook asked for more work",
      metadata: { notice: "stop-hook" },
    })
    if (!input.queued) return { sessionID: created.id, queued: undefined }
    const queued = yield* session.prompt({ sessionID: created.id, text: "Q", delivery: "queue", resume: false })
    yield* SessionInbox.promote(db, bus, created.id, "input")
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
    // At Q the turn that A began was closed: nothing carries over to Q's own turn.
    expect(yield* SessionTurn.current(db, created.id)).toMatchObject({
      options: undefined,
      fallback: undefined,
      notices: {},
    })
    return { sessionID: created.id, queued }
  })

// Each way to reach the end of a history that holds prompt A's turn, with its options and notices, and no idle marker:
// three cuts, and the busy period that has not recorded its idle marker yet.
const cuts = [
  {
    name: "the last response of a busy period that has not gone idle",
    make: limitedTurn({ queued: false }).pipe(Effect.map((turn) => turn.sessionID)),
  },
  {
    name: "a fork before a queued prompt",
    make: Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* limitedTurn({ queued: true })
      return (yield* session.fork({ sessionID: parent.sessionID, before: parent.queued?.id })).id
    }),
  },
  {
    name: "a revert to a queued prompt",
    make: Effect.gen(function* () {
      const bus = yield* Bus.Service
      const parent = yield* limitedTurn({ queued: true })
      // Staged as SessionRevert.stage records it. The next prompt commits the revert before it admits new work.
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: parent.sessionID,
        revert: { messageID: parent.queued!.id },
      })
      return parent.sessionID
    }),
  },
  {
    name: "an import of a session exported in the middle of a turn",
    make: Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const parent = yield* limitedTurn({ queued: false })
      const exported = yield* transfer.export({ sessionID: parent.sessionID })
      // Message IDs are unique across the database, and this import lands in the one that holds the exporting Session.
      return (yield* transfer.import({
        data: {
          info: { ...exported.info, id: Session.ID.create() },
          messages: exported.messages.map((message) => ({ ...message, id: SessionMessage.ID.create() })),
        },
        location,
      })).id
    }),
  },
]

// Known limitation, documented in docs/upgrading.md and on SessionTurn.current: only an idle marker or a queued input
// closes a turn, and nothing records where a history was cut. If a durable record of the cut or of the turn start
// replaces that, the first test of each pair changes with it.
describe("SessionTurn.current after a history was cut short of an idle marker", () => {
  for (const cut of cuts) {
    it.effect(`lets the first steer after ${cut.name} join the turn before it`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const sessionID = yield* cut.make

        const steer = yield* session.prompt({ sessionID, text: "P", resume: false })
        expect(steer.delivery).toBe("steer")
        expect(yield* SessionInbox.promote(db, bus, sessionID, "input")).toBe(1)

        expect(yield* SessionTurn.current(db, sessionID)).toMatchObject({
          boundary: undefined,
          options: { maxSteps: 1 },
          fallback: backup,
          notices: { fallback: 1, "stop-hook": 1 },
        })
      }),
    )

    // The way to start a fresh turn there is the delivery that waits for the previous work to end.
    it.effect(`starts a new turn at the first queued prompt after ${cut.name}`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const sessionID = yield* cut.make

        const queued = yield* session.prompt({ sessionID, text: "P", delivery: "queue", resume: false })
        expect(yield* SessionInbox.promote(db, bus, sessionID, "input")).toBe(1)
        const row = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, queued.id))
          .get()
          .pipe(Effect.orDie)

        expect(yield* SessionTurn.current(db, sessionID)).toEqual({
          boundary: row?.seq,
          options: undefined,
          fallback: undefined,
          notices: {},
        })
      }),
    )
  }
})
