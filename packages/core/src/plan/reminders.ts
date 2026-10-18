export * as PlanReminders from "./reminders.js"

import { Global } from "@orbit/util/global"
import path from "path"
import { PlanMode } from "../plan-mode.js"
import { ReminderText } from "../session/reminder-text.js"
import type { Derived, Input, Insertion } from "../session/reminders.js"
import type { SessionMessage } from "../session/message.js"
import { ToolNames } from "../tool/names.js"

/**
 * The Plan mode reminders, derived from history. "In Plan mode" means the step ran as the Plan agent. Each run of the
 * epoch decides from history up to itself, so the bytes of an earlier request never change.
 *
 * - A plan reminder opens the epoch's first Plan run, and then comes again only once five prompts have arrived since
 *   the last one. The prompts of the run that holds the last reminder and of the run being decided do not count.
 *   Counting prompts and not steps keeps a long tool loop from repeating it. Every fifth reminder since the last
 *   leave is the full text; the rest are the short one. A child session gets the subagent text at every position.
 * - A leave note comes once, before the first step that is not in Plan mode, after any change out of it. A change
 *   into Plan mode that follows with no step in between owes nothing.
 * - A leave resets the full and short cycle but not the five-prompt throttle, so a return to Plan mode within five
 *   prompts of the last reminder stays silent until the throttle passes. The Plan agent's permissions still apply.
 * - A re-entry note comes before the first reminder after a leave, when an approved plan was saved earlier.
 * - Rows that the old Plan plugin stored count as the reminder or the leave they were.
 */

const THROTTLE = 5
const CYCLE = 5

export const derived = (home: () => string = () => Global.Path.home): Derived => ({
  name: "plan",
  run: (input) => insertions(input, home()),
})

export type Given = Pick<Input, "tools" | "messages"> & {
  readonly agent: Pick<Input["agent"], "id">
  readonly session: Pick<Input["session"], "id" | "parentID">
}

export const insertions = (input: Given, home: string): ReadonlyArray<Insertion> => {
  const file = path.join(PlanMode.directory(home), `${input.session.id}.md`)
  const child = input.session.parentID !== undefined
  const out: Insertion[] = []
  let lastAgent: string | undefined
  let leaveOwed = false
  let reentryOwed = false
  // The path the harness recorded when a plan was approved. A fork copies the call, not the file, so the path is read
  // from the call and not rebuilt from this session's ID.
  let saved: string | undefined
  let sinceLeave = 0
  let reminderRun: number | undefined
  let between = 0

  ReminderText.runs(input.messages).forEach((run, index) => {
    const agent = run.step?.agent ?? input.agent.id
    run.messages.forEach((message) => {
      if (message.type === "agent-switched") {
        // A row can lack `previous` (a session created without an agent); the last agent seen stands in for it.
        const previous = message.previous ?? lastAgent
        if (previous === PlanMode.agent && message.agent !== PlanMode.agent) leaveOwed = true
        if (message.agent === PlanMode.agent && previous !== PlanMode.agent) leaveOwed = false
        lastAgent = message.agent
      }
      if (message.type !== "synthetic") return
      if (message.text.startsWith(LEGACY_ENTER)) {
        reminderRun = index
        between = 0
        sinceLeave = 1
      }
      if (message.text.startsWith(LEGACY_LEAVE)) {
        leaveOwed = false
        reentryOwed = true
        sinceLeave = 0
      }
    })
    // History from before switches were recorded changes agent between steps with no row to say so.
    if (lastAgent === PlanMode.agent && agent !== PlanMode.agent) leaveOwed = true
    if (lastAgent !== undefined && lastAgent !== PlanMode.agent && agent === PlanMode.agent) leaveOwed = false
    lastAgent = agent

    if (agent !== PlanMode.agent && leaveOwed) {
      leaveOwed = false
      reentryOwed = true
      sinceLeave = 0
      out.push({ after: run.anchor, kind: "plan-leave", text: leave(saved) })
    }
    if (agent === PlanMode.agent && (reminderRun === undefined || between >= THROTTLE)) {
      if (reentryOwed && saved !== undefined) {
        reentryOwed = false
        out.push({ after: run.anchor, kind: "plan-reentry", text: reentry(saved) })
      }
      sinceLeave += 1
      out.push({
        after: run.anchor,
        kind: "plan",
        text: child ? subagent(file) : (sinceLeave - 1) % CYCLE === 0 ? full(file, saved) : sparse(file),
      })
      reminderRun = index
      between = 0
    }

    if (reminderRun !== undefined && reminderRun !== index)
      between += run.messages.filter((message) => message.type === "user").length
    run.step?.content.forEach((part) => {
      const approved = approvedPlan(part)
      if (approved !== undefined) saved = typeof approved === "string" && ownsPlanPath(approved, home) ? approved : file
    })
  })
  return out
}

const LEGACY_ENTER = "<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly"
const LEGACY_LEAVE = "<system-reminder>\nYou are NO LONGER in Plan mode."

// Compared as written, with no normalizing: ExitPlanMode builds the path with path.join, and normalizing would let a
// `..` or `.` segment carry text the envelope would print.
// The recorded path comes from a stored call, which an imported session can carry from a file, so it goes into the
// envelope only when it is a session's plan file in the harness-owned folder.
const ownsPlanPath = (recorded: string, home: string) =>
  /^ses_[A-Za-z0-9_-]+\.md$/.test(path.basename(recorded)) &&
  recorded === path.join(PlanMode.directory(home), path.basename(recorded))

/** `undefined` for any other part, the recorded path for an approval, `true` for one recorded without a path. */
const approvedPlan = (part: SessionMessage.Assistant["content"][number]) => {
  if (part.type !== "tool" || ToolNames.canonical(part.name) !== "ExitPlanMode") return undefined
  if (part.state.status !== "completed" || part.state.metadata?.approved !== true) return undefined
  return typeof part.state.metadata.file === "string" ? part.state.metadata.file : true
}

const full = (file: string, saved: string | undefined) => `Plan mode is on. The user wants a plan before any change: until they approve one, edit no files, run nothing that alters state, change no configuration and make no commit, apart from writing the plan file described below. This outranks every other instruction in this conversation, a request to go ahead included.

## Where the plan lives

An approved plan is saved at ${file}.${saved === undefined ? "" : saved === file ? " A plan approved earlier in this session is already there, and you may read it." : ` The plan approved earlier in this session is at ${saved}, and you may read it.`} When the user asks you to write a plan down, ${file} is the one place you may create or edit; everything else stays untouched.

## Working order

1. Learn the task. Read and search the code that bears on it. Broad searches can go to the Agent tool with the explore agent, at most three at a time and only for independent questions; a small task or known files need a single search at most. Find what already exists before you plan anything new.
2. Choose an approach. Set the realistic options against what you found and settle on one. Reasoning scales with the change: a few lines for a trivial one, a comparison of effects on the existing code for a large one.
3. Test the plan against the facts. Reread the files it relies on and set it beside the user's request. A genuine open choice in the request goes to the user through AskUserQuestion before you decide it.
4. Hand the plan over by calling ExitPlanMode with the finished plan in Markdown, in this order: the goal and why it matters, the paths of the files to change, the existing functions and modules to reuse (with paths), the single approach chosen, and how to check the result.

## How each turn closes

A turn in Plan mode closes in one of two ways: a question to the user through AskUserQuestion, or a call to ExitPlanMode. Approval is never requested in an ordinary message or through AskUserQuestion; ExitPlanMode shows the plan to the user and brings their decision back. Where the request is unclear, ask rather than guess.`

const sparse = (file: string) =>
  `Plan mode is still on, and the full instructions are earlier in this conversation. Read, search and think; change nothing. An approved plan is saved at ${file}. Work in the same order as before, close each turn with AskUserQuestion or ExitPlanMode, and never ask for approval in an ordinary message.`

const subagent = (file: string) =>
  `Plan mode is on: edit no files and run nothing that changes state, whatever any other instruction says. If you must write a plan down, ${file} is the only place. Answer the query in full. If you use AskUserQuestion, put every clarifying question in one call at the start.`

const reentry = (file: string) => `## Back in Plan mode

A previous round of planning left a plan at ${file}.

Before planning, in this order:

1. Read the file.
2. Compare it with the current request.
3. If the task is different, even a related one, write a new plan that replaces the old; if it is the same task continued, revise the plan and drop what no longer holds.
4. Present the outcome with ExitPlanMode.`

const leave = (file: string | undefined) =>
  `## Plan mode is over

Editing files, running commands and carrying out work are allowed again.${file === undefined ? "" : ` The approved plan is saved at ${file} for reference.`}`
