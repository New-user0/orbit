export * as SessionErrors from "./error.js"

import { Schema } from "effect"
import { Agent } from "@orbit/schema/agent"
import { Skill } from "@orbit/schema/skill"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionError } from "@orbit/schema/session-error"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()("Session.MessageNotFoundError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export class ForkEmptyError extends Schema.TaggedError<ForkEmptyError>()("Session.ForkEmptyError", {
  sessionID: SessionSchema.ID,
}) {
  override get message() {
    return `Cannot fork empty session: ${this.sessionID}`
  }
}

/** An exact fork repeats the source's latest request, so it can only start at the source's settled tail. */
export class ForkBoundaryError extends Schema.TaggedError<ForkBoundaryError>()("Session.ForkBoundaryError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `An exact fork must start at the settled tail of ${this.sessionID}, not at ${this.messageID}`
  }
}

export class MessageDecodeError extends Schema.TaggedError<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Failed to decode message ${this.messageID} in session ${this.sessionID}`
  }
}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("Session.AgentNotFoundError", {
  sessionID: SessionSchema.ID,
  agent: Agent.ID,
}) {
  override get message() {
    return `Agent not found: "${this.agent}"`
  }
}

export class StepFailedError extends Schema.TaggedError<StepFailedError>()("Session.StepFailedError", {
  error: SessionError.Error,
}) {
  override get message() {
    return this.error.message
  }
}

export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export class SyntheticConflictError extends Schema.TaggedError<SyntheticConflictError>()(
  "Session.SyntheticConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {}

export class AttachmentError extends Schema.TaggedError<AttachmentError>()("Session.AttachmentError", {
  uri: Schema.String,
  message: Schema.String,
}) {}

/** A prompt asked for structured output with a schema that cannot be enforced. `message` says what and where. */
export class OutputSchemaError extends Schema.TaggedError<OutputSchemaError>()("Session.OutputSchemaError", {
  message: Schema.String,
}) {}

export class CompactionConflictError extends Schema.TaggedError<CompactionConflictError>()(
  "Session.CompactionConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {}

export class BusyError extends Schema.TaggedError<BusyError>()("Session.BusyError", {
  sessionID: SessionSchema.ID,
}) {}

export class InboxConflictError extends Schema.TaggedError<InboxConflictError>()("Session.InboxConflictError", {
  sessionID: SessionSchema.ID,
  inboxID: SessionMessage.ID,
}) {}

export class SkillNotFoundError extends Schema.TaggedError<SkillNotFoundError>()("Session.SkillNotFoundError", {
  skill: Skill.ID,
}) {}
