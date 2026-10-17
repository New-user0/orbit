export * as ReminderText from "./reminder-text.js"

import type { SessionMessage } from "./message.js"

/** Where a derived insertion lands: the run that follows one assistant message, the first run, or the newest run. */
export type Anchor = "start" | "tail" | SessionMessage.ID

export interface Data {
  /** Harness text naming the payload. It may hold a path or a name from the repository, so rendering flattens it. */
  readonly label: string
  /** Text that came from outside the harness: a file, a tool, an editor. Never part of the envelope. */
  readonly content: string
}

export interface Rendered {
  readonly text: string
  readonly data?: Data
}

const TAG = /<(?=\s*\/?\s*system\s*-\s*(?:reminder|update))/gi

/**
 * Rewrites every look-alike of an Orbit envelope tag (`system-reminder`, `system-update`; opening or closing, any
 * letter case, whitespace inside the brackets, attributes) by escaping its opening bracket. Every other byte is left
 * alone, and the same input always gives the same output, so lowering stays byte-stable.
 */
export const neutralize = (text: string) => text.replace(TAG, "&lt;")

/**
 * Neutralizes text parts that an adapter may join into one string. A provider joins tool-result parts with nothing or
 * with a line break, and the server chooses where the parts split, so a tag cut across parts is escaped when it would
 * read as a tag under either join. Each returned part is the input part with its `<` escaped.
 */
export const neutralizeParts = (parts: ReadonlyArray<string>) => {
  const marked = parts.map(() => new Set<number>())
  for (const separator of ["", "\n"]) {
    const starts = parts.map((_, index) =>
      parts.slice(0, index).reduce((sum, part) => sum + part.length + separator.length, 0),
    )
    for (const match of parts.join(separator).matchAll(TAG)) {
      const part = starts.findLastIndex((start) => start <= match.index)
      marked[part].add(match.index - starts[part])
    }
  }
  return parts.map((part, index) =>
    part.replace(/</g, (_, offset: number) => (marked[index].has(offset) ? "&lt;" : "<")),
  )
}

/**
 * The model-facing text of one reminder. The envelope holds harness text only. A payload follows it in the same
 * message as a labelled fenced block, because Orbit's base prompt promises that nothing inside an envelope came from a
 * file or a tool.
 */
export const render = (input: Rendered) => {
  const envelope = `<system-reminder>\n${input.text}\n</system-reminder>`
  if (!input.data) return envelope
  const longest = Math.max(0, ...(input.data.content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${envelope}\n\n${label(input.data.label)}:\n${fence}\n${neutralize(input.data.content)}\n${fence}`
}

// A label may hold a repository path or name, so line breaks and control characters go and look-alike tags are escaped.
const label = (value: string) => neutralize(value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim())

/** True for a `synthetic` message that a reminder producer stored. */
export const isReminder = (message: SessionMessage.Info) => {
  if (message.type !== "synthetic") return false
  const reminder = message.metadata?.reminder
  return typeof reminder === "object" && reminder !== null && typeof (reminder as { kind?: unknown }).kind === "string"
}

/*
 * The helpers below read history that already left out replaced attempts (`withoutReplaced`) and starts at the latest
 * checkpoint, so a threshold re-arms after a compaction.
 */

/** The index after the latest completed checkpoint, or 0 when there is none. */
export const epochStart = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed") + 1

const since = (
  messages: ReadonlyArray<SessionMessage.Info>,
  anchor: (message: SessionMessage.Info) => boolean,
  counted: (message: SessionMessage.Info) => boolean,
) => {
  const start = epochStart(messages)
  const found = messages.findLastIndex((message, index) => index >= start && anchor(message))
  return {
    anchored: found !== -1,
    count: messages.slice(found === -1 ? start : found + 1).filter(counted).length,
  }
}

/**
 * Assistant messages after the newest message that `anchor` accepts in this epoch. Without one, the count runs from
 * the epoch start and `anchored` is false, which a producer reads as "never": a first-time reminder fires at once.
 */
export const assistantStepsSince = (
  messages: ReadonlyArray<SessionMessage.Info>,
  anchor: (message: SessionMessage.Info) => boolean,
) => since(messages, anchor, (message) => message.type === "assistant")

/** User messages after the anchor; synthetic notices and reminders are not the person's turns. */
export const humanTurnsSince = (
  messages: ReadonlyArray<SessionMessage.Info>,
  anchor: (message: SessionMessage.Info) => boolean,
) => since(messages, anchor, (message) => message.type === "user")

/** The newest user message, and whether the current step is the first one since it (no assistant message follows). */
export const newestPrompt = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const index = messages.findLastIndex((message) => message.type === "user")
  const prompt = messages[index]
  return {
    prompt: prompt?.type === "user" ? prompt : undefined,
    // With no prompt in the epoch (a mid-turn compaction dropped it), no step is the first one.
    first: prompt !== undefined && !messages.slice(index + 1).some((message) => message.type === "assistant"),
  }
}
