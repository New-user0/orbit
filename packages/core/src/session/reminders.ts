export * as SessionReminders from "./reminders.js"

import type { Agent } from "@orbit/schema/agent"
import { plain } from "@orbit/util/plain"
import { Cause, Context, Duration, Effect, Layer, Option } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { FileChangeReminder } from "../file-change-reminder.js"
import { FileLedger } from "../file-ledger.js"
import { LspDiagnostics } from "../lsp/collector.js"
import { LspReminder } from "../lsp/reminder.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PlanReminders } from "../plan/reminders.js"
import { OutputStylePlugin } from "../plugin/output-style.js"
import { ProjectTrust } from "../project-trust.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { TodoReminders } from "../tool/todo-reminders.js"
import { ContextUsageReminder } from "./context-usage-reminder.js"
import type { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { SessionMessage } from "./message.js"
import { ReminderText, render } from "./reminder-text.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { withoutReplaced, type LoweredInsertion } from "./runner/to-llm-message.js"
import type { SessionSchema } from "./schema.js"
import { TurnReminder } from "./turn-reminder.js"
import { Verification } from "./verification.js"

export {
  render,
  neutralize,
  isReminder,
  epochStart,
  assistantStepsSince,
  humanTurnsSince,
  newestPrompt,
  runs,
  postedInRun,
} from "./reminder-text.js"
export type Anchor = ReminderText.Anchor

/**
 * Reminders: model-facing context that the harness adds beside the conversation. Two explicit, ordered lists hold the
 * producers; nothing registers a producer at run time and no plugin adds one.
 *
 * - A durable producer reports a fact that history cannot reproduce (something read outside the session). Its entries
 *   are stored as hidden `session.synthetic` rows, once per logical step, after automatic compaction settled.
 * - A derived producer is a pure function of the active history, the agent and the offered tool names. Its insertions
 *   are rendered while the request is lowered and never stored.
 *
 * The contract:
 * - Reminders appear in list order. Placement in the request comes from `toLLMMessages`.
 * - A durable entry is hidden from clients unless it sets a `description`. An entry with no text and no data is not
 *   published, but its `commit` still runs.
 * - A producer changes no state while it runs. What it would change goes in an entry's `commit`, which runs only once
 *   the collection's rows are published, so a deadline, an interruption or a failure leaves that state as it was. The
 *   one exception is the file-change producer's rebuild after a restart: it claims the session and seeds the files'
 *   records from history inside `run`, as the reference rebuilds its cache outside a collection. It fills only files
 *   that have no record in this process, so it never changes a record a collection checked, and a rebuild cut short is
 *   not tried again in that process. The same producer also notes each file whose check started in the step, whatever
 *   it found (a check, once started, finishes or uses its whole share), so the next step goes on with the others; that
 *   note counts nothing as seen.
 * - The envelope holds harness text only. Anything read from a file, a tool or an editor goes in `data`, which renders
 *   as a labelled fenced block after the envelope, and is neutralized there.
 * - Spacing (how many steps since the last one of mine) is read from history through the helpers, never from a counter
 *   in memory. A durable producer must not rely on having run before in this process: a drain that restarts between
 *   collection and the request may run it again, so it checks history for its own newest entry.
 * - A derived insertion must be reproducible from history. For a run that is no longer the newest it may depend only on
 *   history up to that run, so the bytes of an earlier request prefix never change. The current agent and tool names
 *   decide only what the newest run gets.
 * - A producer that fails, dies or runs past its time limit yields nothing and costs one log line. Interruption is
 *   never swallowed.
 */

/** What a producer reads. `messages` leaves out replaced attempts and starts at the latest checkpoint. */
export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Info
  /** The names of the tools offered to the model for this step. */
  readonly tools: ReadonlyArray<string>
  readonly model: SessionRunnerModel.Resolved
  readonly messages: ReadonlyArray<SessionMessage.Info>
  /** The logical step within the turn, from 1. */
  readonly step: number
  /** Whether no assistant message follows the newest real prompt. */
  readonly firstStep: boolean
}

export interface Entry {
  readonly kind: string
  /** Harness text. */
  readonly text: string
  readonly data?: ReminderText.Data
  /** Short text for clients; stored escaped. Without one the row is hidden. */
  readonly description?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  /** State the entry stands for, changed only after the collection's rows are published, together with them. */
  readonly commit?: Effect.Effect<void>
}

export interface Durable {
  readonly name: string
  /** `primary` skips child sessions. Default `all`. */
  readonly scope?: "all" | "primary"
  /** Longest wait for `run`; a producer that runs longer yields nothing. Default one second. */
  readonly timeout?: Duration.Input
  /** Kept by the minimal instances (`orb run --bare`, a vanilla instance); only queued-input delivery belongs here. */
  readonly minimal?: boolean
  readonly run: (input: Input) => Effect.Effect<ReadonlyArray<Entry>>
}

export interface Insertion {
  /** The run the reminder belongs to; `tail` is the newest run. */
  readonly after: Anchor
  readonly kind: string
  readonly text: string
  readonly data?: ReminderText.Data
}

export interface Derived {
  readonly name: string
  readonly scope?: "all" | "primary"
  readonly minimal?: boolean
  readonly run: (input: Input) => ReadonlyArray<Insertion>
}

export interface Lists {
  readonly durable: ReadonlyArray<Durable>
  readonly derived: ReadonlyArray<Derived>
  /** Set by `minimal`. The lowering of a prompt reads it: the minimal instance keeps only queued-input notes. */
  readonly minimal?: boolean
}

export const DEFAULT_TIMEOUT = Duration.seconds(1)

export interface Interface {
  /**
   * Runs the durable producers for one logical step, publishes one `session.synthetic` per entry, together, and then
   * runs the entries' commits. Returns whether anything was published, so the caller reloads history only then.
   */
  readonly collect: (input: { readonly loaded: SessionContext.Loaded; readonly step: number }) => Effect.Effect<boolean>
  /** Runs the derived producers; the insertions merge in list order. */
  readonly derive: (loaded: SessionContext.Loaded, step: number) => Effect.Effect<ReadonlyArray<LoweredInsertion>>
  /** True on the minimal instances (`--bare`, vanilla): a prompt's agent hints and editor notes are not rendered. */
  readonly minimal: boolean
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionReminders") {}

/** The production lists. Later tasks append their producers here, in the order their reminders appear. */
export const production: Lists = {
  durable: [],
  derived: [PlanReminders.derived(), TodoReminders.producer, Verification.producer],
}

/** The minimal instance keeps only the producers that mark themselves `minimal`. */
export const minimal = (lists: Lists): Lists => ({
  durable: lists.durable.filter((producer) => producer.minimal),
  derived: lists.derived.filter((producer) => producer.minimal),
  minimal: true,
})

/** A node over explicit lists; tests and the minimal instances replace the node with their own. */
export const configured = (lists: Lists) =>
  makeLocationNode({
    service: Service,
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        return make(bus, lists)
      }),
    ),
    deps: [Bus.node],
  })

/**
 * The production node. Most durable producers read services, and a producer's `run` has no requirements, so they are
 * built here from those services and appended to the durable list. `orb run --bare` switches instruction files off,
 * and a bare run adds nothing else to the conversation either.
 */
export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const diagnostics = yield* LspDiagnostics.Service
      const location = yield* Location.Service
      const database = yield* Database.Service
      const config = yield* Config.Service
      const ledger = yield* FileLedger.Service
      const access = yield* FileAccess.Service
      const reader = yield* ReadToolFileSystem.Service
      const permission = yield* Permission.Service
      const trust = yield* ProjectTrust.Service
      const environment = yield* Environment.Service
      // The reference's order: changed files, then the main conversation's style, diagnostics and context usage. The
      // budget report comes last.
      const lists: Lists = {
        ...production,
        durable: [
          ...production.durable,
          FileChangeReminder.durable({ ledger, access, reader, permission, trust, environment }),
          OutputStylePlugin.durable(config),
          LspReminder.durable(diagnostics, location.directory),
          ContextUsageReminder.durable,
          TurnReminder.durable(database.db),
        ],
      }
      return make(bus, process.env.ORBIT_DISABLE_INSTRUCTIONS === "1" ? minimal(lists) : lists)
    }),
  ),
  deps: [
    Bus.node,
    LspDiagnostics.node,
    Location.node,
    Database.node,
    Config.node,
    FileLedger.node,
    FileAccess.node,
    ReadToolFileSystem.node,
    Permission.node,
    ProjectTrust.node,
    Environment.node,
  ],
})

const make = (bus: Bus.Interface, lists: Lists) => {
  const input = (loaded: SessionContext.Loaded, step: number): Input => {
    const messages = withoutReplaced(loaded.messages)
    return {
      session: loaded.session,
      agent: loaded.agent.info,
      tools: loaded.tools.definitions.map((tool) => tool.name),
      model: loaded.model,
      messages,
      step,
      firstStep: ReminderText.newestPrompt(messages).first,
    }
  }
  const fits = (scope: "all" | "primary" | undefined, session: SessionSchema.Info) =>
    scope !== "primary" || session.parentID === undefined

  const collect: Interface["collect"] = Effect.fnUntraced(function* ({ loaded, step }) {
    const given = input(loaded, step)
    const results = yield* Effect.forEach(
      lists.durable.filter((producer) => fits(producer.scope, loaded.session)),
      (producer) => guarded(producer, given),
      { concurrency: "unbounded" },
    )
    const entries = results.flat()
    const events = entries
      .filter((entry) => entry.text.length > 0 || entry.data !== undefined)
      .map(
        (entry) =>
          [
            SessionEvent.Synthetic,
            {
              sessionID: loaded.session.id,
              text: render(entry),
              description: entry.description === undefined ? undefined : plain(entry.description),
              metadata: {
                ...entry.metadata,
                reminder: { kind: entry.kind, ...(entry.data ? { label: entry.data.label } : {}) },
              },
            },
          ] as const,
      )
    const commits = entries.flatMap((entry) => (entry.commit === undefined ? [] : [entry.commit]))
    // An interruption lands before the rows and their commits or after both, never between them.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const [first, ...rest] = events
        if (first !== undefined) yield* bus.publishAll([first, ...rest])
        yield* Effect.all(commits, { discard: true })
        return first !== undefined
      }),
    )
  })

  const derive: Interface["derive"] = Effect.fnUntraced(function* (loaded, step) {
    const given = input(loaded, step)
    const newest = newestRun(given.messages)
    const results = lists.derived
      .filter((producer) => fits(producer.scope, loaded.session))
      .map((producer) =>
        Effect.try({ try: () => producer.run(given), catch: (error) => error }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("A derived reminder producer failed, so it added nothing").pipe(
              Effect.annotateLogs({ producer: producer.name, sessionID: loaded.session.id, error: String(error) }),
              Effect.as([] as ReadonlyArray<Insertion>),
            ),
          ),
        ),
      )
    return (yield* Effect.all(results))
      .flat()
      .filter((insertion) => insertion.text.length > 0 || insertion.data !== undefined)
      .map((insertion) => ({
        after: insertion.after === "tail" ? newest : insertion.after,
        text: render(insertion),
      }))
  })

  // Read on use, like the lists: a test sets the lists after the node is built.
  return Service.of({
    collect,
    derive,
    get minimal() {
      return lists.minimal === true
    },
  })
}

/** The run a "tail" insertion belongs to: the one after the newest assistant message in this epoch. */
const newestRun = (messages: ReadonlyArray<SessionMessage.Info>): "start" | SessionMessage.ID => {
  const index = messages.findLastIndex((message) => message.type === "assistant")
  const last = messages[index]
  return last?.type === "assistant" && index >= ReminderText.epochStart(messages) ? last.id : "start"
}

const guarded = (producer: Durable, input: Input) =>
  producer.run(input).pipe(
    Effect.timeoutOption(producer.timeout ?? DEFAULT_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.logWarning("A reminder producer ran past its time limit, so it added nothing").pipe(
            Effect.annotateLogs({ producer: producer.name, sessionID: input.session.id }),
            Effect.as([] as ReadonlyArray<Entry>),
          ),
    ),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("A reminder producer failed, so it added nothing").pipe(
          Effect.annotateLogs({ producer: producer.name, sessionID: input.session.id, cause: Cause.pretty(cause) }),
          Effect.as([] as ReadonlyArray<Entry>),
        ),
    ),
  )
