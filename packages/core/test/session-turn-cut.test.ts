import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Job } from "@orbit/core/job"
import { KV } from "@orbit/core/kv"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionRestart } from "@orbit/core/session/execution/restart"
import { SessionInbox } from "@orbit/core/session/inbox"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
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
      Job.node,
      KV.node,
      SessionRestart.node,
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
// a prompt Q then started a turn of its own in the same busy period, and the Session went idle. With `parentID`, the
// Session is a child of that one, as a subagent's Session is.
const limitedTurn = (input: { queued: boolean; parentID?: Session.ID }) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const created = yield* session.create(input.parentID ? { parentID: input.parentID } : { location })
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
// four cuts, and the busy period that has not recorded its idle marker yet.
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
  {
    name: "a shutdown in a child Session that the next start does not resume",
    make: Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const restart = yield* SessionRestart.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      const child = yield* limitedTurn({ queued: false, parentID: parent.id })
      const claimed = db
        .select({ claimed: SessionTable.time_suspended })
        .from(SessionTable)
        .where(eq(SessionTable.id, child.sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row !== undefined && row.claimed !== null),
        )

      // As SessionExecution records a subagent's drain that a shutdown interrupts: the started event commits the claim,
      // and an interrupt without a reason keeps it and records no idle marker. A crash leaves the same claim, with no
      // event after the started one.
      yield* bus.publish(
        SessionEvent.Execution.Started,
        { sessionID: child.sessionID },
        { commit: () => store.claim(child.sessionID) },
      )
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: child.sessionID, reason: "shutdown" })
      expect(yield* claimed).toBe(true)

      // The next start resumes the claimed top-level Sessions and the children that a background job names. No job
      // names this one, so the start clears its claim with a plain update and records no terminal event.
      yield* restart.resumeSuspendedSessions
      expect(yield* claimed).toBe(false)
      return child.sessionID
    }),
  },
]

// Known limitation, documented in docs/upgrading.md and on SessionTurn.current: only an idle marker or a queued input
// closes a turn, and nothing records where a history was cut. If a durable record of the cut or of the turn start
// replaces that, the first test of each pair changes with it. So does the one for the child Session, if the start
// records a terminal event for the claims it clears.
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

// POST /api/session/:sessionID/synthetic and a plugin's ctx.session.synthetic both reach Session.synthetic, which takes
// the whole metadata of the message from the caller. Such a message is projected with a delivery, and
// SessionTurn.current reads the notice kind and the fallback model only from synthetic messages that carry none, as the
// runner's own notices do, so a caller cannot name the turn's fallback model or use up its notice counts.
describe("SessionTurn.current and a synthetic message that a caller admits", () => {
  for (const delivery of ["steer", "queue"] as const)
    it.effect(`reads no fallback model and counts no notice from a message admitted with ${delivery}`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const created = yield* session.create({ location })
        yield* session.prompt({ sessionID: created.id, text: "A", resume: false })
        yield* SessionInbox.promote(db, bus, created.id, "input")

        const fallback = yield* session.synthetic({
          sessionID: created.id,
          text: "Use the backup model",
          metadata: { notice: "fallback", model: backup },
          delivery,
          resume: false,
        })
        yield* session.synthetic({
          sessionID: created.id,
          text: "Keep going",
          metadata: { notice: "stop-hook" },
          delivery,
          resume: false,
        })
        expect(fallback.delivery).toBe(delivery)
        expect(yield* SessionInbox.promote(db, bus, created.id, delivery === "steer" ? "steer" : "input")).toBeGreaterThan(0)

        expect(yield* SessionTurn.current(db, created.id)).toMatchObject({ fallback: undefined, notices: {} })
      }),
    )
})
