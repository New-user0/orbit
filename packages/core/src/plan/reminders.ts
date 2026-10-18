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

const full = (file: string, saved: string | undefined) => `Plan mode is on. The user wants a plan first, not a change: until they approve one, do not edit files, run commands that alter state, change configuration or commit, other than the plan file named in the next section. This holds over any other instruction in this conversation, including a request to go ahead.

## The plan file

An approved plan is saved at ${file}.${saved === undefined ? "" : saved === file ? " A plan approved earlier in this session is already there, and you may read it." : ` The plan approved earlier in this session is at ${saved}, and you may read it.`} When the user asks you to write a plan down, ${file} is the one place you may create or edit; everything else stays untouched.

## How to plan

1. Understand the request. Read the code that matters and search for it. Use the Agent tool with the explore agent for broad searches, and run up to three at once when the questions are independent. One search is enough when the task is small or the files are known. Look for code that already does part of the job before planning new code.
2. Design the approach. Weigh the realistic options against what you found, and pick one. For a trivial change, a few lines of reasoning is enough. For a large one, compare how each option affects the code that exists.
3. Check the plan. Re-read the files it depends on, and compare the plan with what the user asked for. Where the request leaves a real choice open, ask with AskUserQuestion before you settle it.
4. Present the plan by calling ExitPlanMode with the finished plan. Write it in Markdown and include:
   - a short note on why the change is needed and what it should achieve
   - the approach you chose, and only that one
   - the paths of the files to change
   - existing functions and modules to reuse, with their paths
   - how to verify the result

## Ending a turn

**Every turn in Plan mode ends in one of two ways:** a question to the user through AskUserQuestion, or a call to ExitPlanMode. Do not end a turn with a plain message that asks whether the plan is acceptable, and do not use AskUserQuestion to ask for approval. Phrases such as "does this look right?", "shall I go ahead?" and "ready to implement?" belong in ExitPlanMode, which shows the plan to the user and carries their decision back to you.

Ask clarifying questions whenever you need them, and do not guess what the user meant.`

const sparse = (file: string) =>
  `Plan mode is still on; the full instructions appear earlier in this conversation. Do not change anything: reading, searching and thinking only. Plans are saved at ${file} when the user approves one. Follow the same steps as before, end each turn with AskUserQuestion or ExitPlanMode, and never ask for approval in plain text.`

const subagent = (file: string) =>
  `Plan mode is on, so you must not edit files or run anything that changes state. This overrides every other instruction, including one that tells you to edit. If you need to write a plan down, the only place for it is ${file}. Answer the query completely. If you use AskUserQuestion, put all of your clarifying questions in one call at the start.`

const reentry = (file: string) => `## Returning to Plan mode

An earlier round of planning left a plan at ${file}.

Before you plan anything, do these in order:

1. Read that file.
2. Set the current request beside the plan.
3. Decide: a different task, even a related one, gets a new plan that replaces the old; the same task carried on gets the plan revised, with the parts that no longer hold removed.
4. Present the result with ExitPlanMode.

**Do this before planning.** The saved plan is only a starting point; check it against the request before relying on any of it.`

const leave = (file: string | undefined) =>
  `## Plan mode has ended

You may edit files, run commands and carry out work again.${file === undefined ? "" : ` The approved plan is saved at ${file} for reference.`}`
