import { Session } from "@orbit/core/session"
import { SessionRecap } from "@orbit/core/session/recap"
import { SessionStats } from "@orbit/core/session/stats"
import { SessionTitle } from "@orbit/core/session/title"
import { SessionTransfer } from "@orbit/core/session/transfer"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { Form } from "@orbit/core/form"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@orbit/protocol/groups/session"
import {
  ConflictError,
  CommandExecutionError,
  CommandNotFoundError,
  FormAlreadySettledError,
  FormInvalidAnswerError,
  FormNotFoundError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  RewindFilesError,
  ServiceUnavailableError,
  SessionBusyError,
  SkillNotFoundError,
} from "@orbit/protocol/errors"
import { AbsolutePath } from "@orbit/core/schema"
import { Project } from "@orbit/core/project"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { failedMessageDecode, failedSnapshot, missingMessage, missingSession } from "./session-error"
import { requireTrusted, requireTrustedAt, untrustedFolder } from "./trust-error"

const DefaultSessionsLimit = 50

function missingForm(id: Form.ID) {
  return new FormNotFoundError({ id, message: `Form not found: ${id}` })
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    // What decides whether a folder is trusted, for the routes that act on a folder other than the request's own.
    const folders = { projects: yield* Project.Service, trust: yield* WorkspaceTrust.Service }
    const transfer = yield* SessionTransfer.Service
    const recap = yield* SessionRecap.Service
    const requireOwnedForm = Effect.fnUntraced(function* (sessionID: Form.Info["sessionID"], formID: Form.ID) {
      const form = yield* Form.Service
      const info = yield* form.get(formID).pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(formID)))
      if (info.sessionID !== sessionID) return yield* missingForm(formID)
      return { form, info }
    })
    const busySession = (error: Session.BusyError) =>
      new SessionBusyError({
        sessionID: error.sessionID,
        message: `Session is busy: ${error.sessionID}`,
      })
    const pendingMutation = (effect: ReturnType<typeof session.cancelInbox>, conflict: string) =>
      effect.pipe(
        Effect.catchTag("Session.NotFoundError", missingSession),
        Effect.catchTag(
          "Session.InboxConflictError",
          (error) => new ConflictError({ resource: error.inboxID, message: `${conflict}: ${error.inboxID}` }),
        ),
        Effect.as(HttpApiSchema.NoContent.make()),
      )

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const page = yield* session.list({
            ...query,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const sessions = page.data
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.updated),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.updated),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.stats",
        Effect.fn(function* (ctx) {
          const timezone = ctx.query.timezone ?? "UTC"
          yield* Effect.try({
            try: () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
            catch: () => new InvalidRequestError({ message: `Invalid time zone: ${timezone}` }),
          })
          return {
            data: yield* SessionStats.get({
              from: ctx.query.from,
              to: ctx.query.to,
              projectID: ctx.query.project,
              timezone,
              tools: ctx.query.tools,
            }).pipe(
              Effect.mapError(() => new InvalidRequestError({ message: "Stats range must end after it starts" })),
            ),
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          // A session is created where it will work: the folder the request names, or its parent's folder.
          const location =
            ctx.payload.parentID === undefined
              ? (ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) })
              : (yield* session.get(ctx.payload.parentID).pipe(Effect.catchTag("Session.NotFoundError", missingSession)))
                  .location
          yield* requireTrustedAt(folders, location.directory)
          return {
            data: yield* session
              .create({
                id: ctx.payload.id,
                title: ctx.payload.title,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                metadata: ctx.payload.metadata,
                permissions: ctx.payload.permissions,
                ...(ctx.payload.parentID === undefined
                  ? { location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) } }
                  : { parentID: ctx.payload.parentID }),
              })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        "session.import",
        Effect.fn(function* (ctx) {
          // An imported session works where it lands, as a created one does, so that folder has to be trusted (class 12).
          const location = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          yield* requireTrustedAt(folders, location.directory)
          return {
            data: yield* transfer
              .import({
                data: { info: ctx.payload.info, messages: ctx.payload.messages },
                location,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag(
                  "SessionTransfer.ImportConflictError",
                  (error) =>
                    new ConflictError({
                      message: `Session already exists: ${error.sessionID}`,
                      resource: error.sessionID,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.export",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
              .export({ sessionID: ctx.params.sessionID, sanitize: ctx.query.sanitize })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          const active = yield* session.active
          return {
            data: Object.fromEntries(Array.from(active, (sessionID) => [sessionID, { type: "running" as const }])),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .get(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        "session.view",
        Effect.fn(function* (ctx) {
          yield* session
            .view({ sessionID: ctx.params.sessionID, idle: DateTime.toEpochMillis(ctx.payload.idle) })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.remove",
        Effect.fn(function* (ctx) {
          yield* session.remove(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.environment",
        Effect.fn(function* (ctx) {
          yield* session
            .environment({ sessionID: ctx.params.sessionID, variables: ctx.payload.variables })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          return {
            data: yield* session.fork({ sessionID: ctx.params.sessionID, before: ctx.payload.before }).pipe(
              // Only exact forks can fail this way, and the payload cannot ask for one.
              Effect.catchTag("Session.ForkBoundaryError", Effect.die),
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag(
                "Session.ForkEmptyError",
                (error) => new InvalidRequestError({ message: error.message, kind: "empty_session" }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session
            .switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session
            .switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.update",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          if (ctx.payload.title !== undefined) {
            if (ctx.payload.title) {
              yield* session
                .rename({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            } else {
              // An empty title asks the model for one, with the session's folder and its instructions.
              yield* requireTrusted()
              const title = yield* SessionTitle.Service
              yield* title.generate(ctx.params.sessionID)
            }
          }
          if (ctx.payload.metadata !== undefined)
            yield* session
              .setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          if (ctx.payload.permissions !== undefined)
            yield* session
              .setPermissions({ sessionID: ctx.params.sessionID, permissions: ctx.payload.permissions })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.move",
        Effect.fn(function* (ctx) {
          // `SessionMove` reads the destination from the session's own folder and refuses one that is not trusted, the
          // same check a plugin's or the model's move meets (class 3).
          yield* session
            .move({
              sessionID: ctx.params.sessionID,
              directory: ctx.payload.directory,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("WorkspaceTrust.UntrustedError", (error) => Effect.fail(untrustedFolder(error))),
              Effect.catchTag("Session.DestinationNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory does not exist: ${error.directory}` })),
              ),
              Effect.catchTag("Session.DestinationNotDirectoryError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Not a directory: ${error.directory}` })),
              ),
              Effect.catchTag("Session.DestinationUnavailableError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory is unavailable: ${error.directory}` })),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                text: ctx.payload.text,
                files: ctx.payload.files,
                agents: ctx.payload.agents,
                skills: ctx.payload.skills,
                editor: ctx.payload.editor,
                metadata: ctx.payload.metadata,
                turn: ctx.payload.turn,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.AttachmentError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
                ),
                Effect.catchTag("Session.SkillNotFoundError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: `Skill not found: ${error.skill}`, field: "skills" })),
                ),
                Effect.catchTag("Session.OutputSchemaError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "turn.output.schema" })),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          yield* session
            .command({
              sessionID: ctx.params.sessionID,
              command: ctx.payload.name,
              text: ctx.payload.text,
              files: ctx.payload.files,
              agents: ctx.payload.agents,
              skills: ctx.payload.skills,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Command.NotFoundError", (error) =>
                Effect.fail(
                  new CommandNotFoundError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
              Effect.catchTag("Command.ExecutionError", (error) =>
                Effect.fail(
                  new CommandExecutionError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          yield* session
            .skill({
              sessionID: ctx.params.sessionID,
              skill: ctx.payload.id,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new SkillNotFoundError({ skill: error.skill, message: `Skill not found: ${error.skill}` })),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.synthetic",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          const data = yield* session
            .synthetic({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              text: ctx.payload.text,
              description: ctx.payload.description,
              metadata: ctx.payload.metadata,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.SyntheticConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                    resource: error.inputID,
                  }),
                ),
              ),
            )
          return { data }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          yield* session
            .shell({ sessionID: ctx.params.sessionID, id: ctx.payload.id, command: ctx.payload.command })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          return {
            data: yield* session
              .compact({ sessionID: ctx.params.sessionID, id: ctx.payload.id, delivery: ctx.payload.delivery })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.CompactionConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Compaction input ID conflicts with an existing durable record: ${error.inputID}`,
                      resource: error.inputID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.stage", {
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            files: ctx.payload.files,
          })
          return {
            data: yield* session.revert
              .stage({ ...ctx.params, ...ctx.payload })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageNotFoundError", missingMessage),
                Effect.catchTag("Session.BusyError", busySession),
                Effect.catchTag("Snapshot.Error", failedSnapshot("stage session revert", ctx.params.sessionID)),
              ),
          }
        }),
      )
      .handle(
        "session.revert.files",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.files", {
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            dryRun: ctx.payload.dryRun,
          })
          // The busy and trust checks live in core, so an embedded host meets the same refusals (class 12).
          return {
            data: yield* session.revert.files({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag("Session.BusyError", busySession),
              Effect.catchTag("WorkspaceTrust.UntrustedError", (error) => Effect.fail(untrustedFolder(error))),
              Effect.catchTag(
                "Session.RewindError",
                (error) =>
                  new RewindFilesError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    reason: error.reason,
                    message: error.message,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.clear", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .clear(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.BusyError", busySession),
              Effect.catchTag("Snapshot.Error", failedSnapshot("clear session revert", ctx.params.sessionID)),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.commit", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .commit(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.BusyError", busySession),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .context(ctx.params.sessionID)
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        "session.diff",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.diff({ sessionID: ctx.params.sessionID, ...ctx.query }).pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag(
                "Session.TurnRangeError",
                (error) => new InvalidRequestError({ message: error.message, field: error.field }),
              ),
              Effect.catchTag("Snapshot.Error", failedSnapshot("diff session turn", ctx.params.sessionID)),
            ),
          }
        }),
      )
      .handle(
        "session.inbox.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .inbox(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        "session.inbox.cancel",
        Effect.fn(function* (ctx) {
          yield* session.cancelInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }).pipe(
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.InboxConflictError", () => Effect.void),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.inbox.update",
        Effect.fn(function* (ctx) {
          return yield* pendingMutation(
            ctx.payload.delivery === "steer"
              ? session.steerInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID })
              : session.queueInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }),
            `Pending input cannot change to ${ctx.payload.delivery}`,
          )
        }),
      )
      .handle(
        "session.instructions.preview",
        Effect.fn(function* (ctx) {
          // The preview reads the folder's instruction files, and nothing of a folder is read before it is trusted.
          yield* requireTrusted()
          const preview = yield* session
            .instructions(ctx.params.sessionID)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "Session.NotFoundError"
                  ? missingSession(error)
                  : new ServiceUnavailableError({ message: error.message, service: "instruction preview" }),
              ),
            )
          return { data: preview }
        }),
      )
      .handle(
        "session.instructions.entry.list",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          return { data: yield* instructions.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.instructions.entry.put",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.put({ sessionID: ctx.params.sessionID, key: ctx.params.key, value: ctx.payload.value })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.instructions.entry.remove",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.remove({ sessionID: ctx.params.sessionID, key: ctx.params.key })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.generate",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          const text = yield* session
            .generate({ sessionID: ctx.params.sessionID, prompt: ctx.payload.prompt })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "Session.NotFoundError"
                  ? missingSession(error)
                  : new ServiceUnavailableError({ message: error.message, service: "session generation" }),
              ),
            )
          return { data: { text } }
        }),
      )
      .handle(
        "session.recap",
        Effect.fn(function* (ctx) {
          // The recap reads the session's history into a model call, so the folder must still be trusted.
          yield* requireTrusted()
          // A client drops the request when the person comes back, which interrupts this and records nothing.
          const recorded = yield* recap
            .generate(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { recorded: recorded !== undefined }
        }),
      )
      .handle(
        "session.log",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return session
            .log({ sessionID: ctx.params.sessionID, after: ctx.query.after, follow: ctx.query.follow })
            .pipe(Stream.orDie)
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          return { interrupted: yield* session.interrupt(ctx.params.sessionID, { resume: ctx.query.resume }) }
        }),
      )
      .handle(
        "session.background",
        Effect.fn(function* (ctx) {
          yield* session.background(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      .handle(
        "session.form.list",
        Effect.fn(function* (ctx) {
          const form = yield* Form.Service
          return { data: yield* form.list({ sessionID: ctx.params.sessionID }) }
        }),
      )
      .handle(
        "session.form.create",
        Effect.fn(function* (ctx) {
          const form = yield* Form.Service
          const created = yield* form
            .create({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              title: ctx.payload.title,
              metadata: ctx.payload.metadata,
              fields: ctx.payload.fields,
            })
            .pipe(
              Effect.catchTags({
                "Form.AlreadyExistsError": (error) => new ConflictError({ resource: error.id, message: error.message }),
                "Form.InvalidFormError": (error) =>
                  new InvalidRequestError({ message: error.message, field: "fields" }),
              }),
            )
          return { data: created }
        }),
      )
      .handle(
        "session.form.get",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          const state = yield* owned.form
            .state(ctx.params.formID)
            .pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(ctx.params.formID)))
          return { data: { ...owned.info, state } }
        }),
      )
      .handle(
        "session.form.reply",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.reply({ id: ctx.params.formID, answer: ctx.payload.answer }).pipe(
            Effect.catchTags({
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              "Form.InvalidAnswerError": (error) =>
                new FormInvalidAnswerError({ id: error.id, message: error.message }),
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.form.cancel",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.cancel(ctx.params.formID, { message: ctx.query.message }).pipe(
            Effect.catchTags({
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
