export * as SubagentJob from "./subagent-job.js"

import { Effect, Scope } from "effect"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

interface Runner {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

export const make: Effect.Effect<Runner, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      if (info) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  return {
    start: (recovery: Recovery) =>
      jobs.start({
        id: recovery.childSessionID,
        type: "subagent",
        title: recovery.description,
        metadata: {},
        recovery,
        run: Effect.gen(function* () {
          yield* sessions.resume(recovery.childSessionID)
          const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
          const assistant = messages.find(
            (message) =>
              message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
          )
          return SubagentCompletion.text(assistant)
        }).pipe(endsShells(sessions, recovery.childSessionID)),
      }),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
  }
})

/**
 * However a subagent's run ends, the shell commands its child left running end with it and report to no one. Every run of
 * a subagent job carries it: the one an Agent call starts and the one a restart resumes. Stopping them never changes how
 * the run ended: a child whose folder is gone cannot open its Location, and that defect is logged, not reported.
 */
export const endsShells =
  (sessions: Session.Interface, childSessionID: Recovery["childSessionID"]) =>
  <A, E, R>(run: Effect.Effect<A, E, R>) =>
    run.pipe(
      Effect.ensuring(
        sessions
          .abandonShells(childSessionID)
          .pipe(
            Effect.catchCause((cause) => Effect.logWarning("a subagent's shell commands were not stopped", { cause })),
          ),
      ),
    )

/**
 * Waits for a foreground subagent's run. With background tasks on (`movable`) the call blocks on the job, so the session's
 * move-to-background signal can move it. With them off it waits without blocking, which that signal does not reach, and
 * blocks only once the run has ended, to take the finished result.
 */
export const waitFor = (jobs: Job.Interface, input: Job.BlockInput, movable: boolean) =>
  movable ? jobs.block(input) : jobs.wait({ id: input.id }).pipe(Effect.andThen(jobs.block(input)))
