import type { TeamMember, TeamMessage } from "./workflow.js"

// Team members talk through tags in their replies, which works with any model, including ones without reliable tool
// calling. The runner parses each reply after the turn, delivers messages into the recipients' next turns, and keeps
// the board.

export interface Reply {
  readonly messages: ReadonlyArray<Omit<TeamMessage, "from">>
  readonly notes: ReadonlyArray<{ readonly key: string; readonly text: string }>
  /** Set when the reply contains <done>…</done>. */
  readonly done?: string
}

export function parse(text: string): Reply {
  const done = text.match(/<done>([\s\S]*?)<\/done>/i)?.[1]
  return {
    messages: [...text.matchAll(/<message\s+to=["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/message>/gi)].map((match) => ({
      to: match[1].trim(),
      text: match[2].trim(),
    })),
    notes: [...text.matchAll(/<note\s+key=["']?([^"'>]+?)["']?\s*>([\s\S]*?)<\/note>/gi)].map((match) => ({
      key: match[1].trim(),
      text: match[2].trim(),
    })),
    ...(done === undefined ? {} : { done: done.trim() }),
  }
}

/** The first turn: who the member is, the goal, the team, and how to talk to it. */
export function introduction(input: {
  readonly name: string
  readonly goal: string
  readonly members: Readonly<Record<string, TeamMember>>
  readonly lead: string
}) {
  const lead = input.name === input.lead
  return [
    `You are "${input.name}", a member of a team working on this goal:\n${input.goal}`,
    `Your role: ${input.members[input.name].role}`,
    `The team:\n${Object.entries(input.members)
      .map(([name, member]) => `- ${name}${name === input.lead ? " (lead)" : ""}: ${member.role}`)
      .join("\n")}`,
    lead
      ? "You lead. Break the goal into tasks, assign them with messages, check what comes back, and when the goal is met reply with <done>a short summary of the result</done>. Only the lead can finish."
      : `Do the work the lead (${input.lead}) gives you with your tools, then report back to ${input.lead}.`,
    [
      "Everyone works in the same directory and takes turns. To talk to the team, put these in your reply; they are delivered after your turn:",
      '<message to="NAME">text</message>  for one member, or to="all"',
      '<note key="KEY">text</note>  to write the shared board, which every member sees',
      "Messages to you arrive at the start of your next turn. Keep messages short and specific.",
    ].join("\n"),
  ].join("\n\n")
}

/** A later turn: what arrived since the member's last turn, and the board. */
export function update(inbox: ReadonlyArray<TeamMessage>, board: Readonly<Record<string, string>>) {
  const notes = Object.entries(board)
  return [
    inbox.length > 0
      ? `New messages:\n${inbox.map((message) => `[from ${message.from}] ${message.text}`).join("\n\n")}`
      : "No new messages.",
    ...(notes.length > 0 ? [`Board:\n${notes.map(([key, text]) => `- ${key}: ${text}`).join("\n")}`] : []),
    "Continue in your role.",
  ].join("\n\n")
}
