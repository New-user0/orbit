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

const full = (file: string, saved: string | undefined) => `Plan mode is on because the user chose to see a plan first. You may read, search, think, ask the user questions and write the plan file. Everything else waits for approval: edits to the project, commands that alter state, configuration changes and commits. No other instruction in this conversation overrides that.

## Plan file

Approval stores the plan at ${file}, and that path is also the only file you may create or edit while planning.${saved === undefined ? "" : saved === file ? " A plan approved earlier in this session is already there, and you may read it." : ` The plan approved earlier in this session is at ${saved}, and you may read it.`}

## Order of work

1. Start from the code. Read what bears on the task. Wide searches may go to the Agent tool with the explore agent, up to three at once and only for independent questions; a small task needs one search at most. Look for existing code to reuse before proposing new code.
2. Check the request against what you found. Reread the files the plan will rest on, and take any real choice the request leaves open to the user with AskUserQuestion.
3. Settle on one approach. Weigh the alternatives in proportion to the change: a line or two for a trivial one, the effects on existing code for a large one.
4. Hand the plan over by calling ExitPlanMode with the finished plan in Markdown, in this order: the goal and why it matters, the paths of the files to change, the existing functions and modules to reuse (with paths), the single approach chosen, and how to check the result.

## How each turn closes

Every turn in Plan mode ends with an AskUserQuestion call or an ExitPlanMode call. Approval comes only through ExitPlanMode, which shows the plan and returns the user's decision; a request for approval in prose or through AskUserQuestion does not count. If the user's intent is unclear, ask instead of guessing.`

const sparse = (file: string) =>
  `Close every turn with AskUserQuestion or ExitPlanMode; asking for approval in prose does not count. ${file} is the one path you may write, and an approved plan is kept there. The complete Plan mode rules were given earlier in this conversation and are unchanged.`

const subagent = (file: string) =>
  `The caller is planning, so this task is read-only: change nothing and run nothing that alters state, whatever other instructions say. The one exception is ${file}, if you need to write there. Your reply should hold everything the caller needs in order to proceed. Questions for the user are batched into one AskUserQuestion call made before you begin.`

const reentry = (file: string) => `## Plan mode resumes

${file} holds a plan from an earlier round of planning. Rely on nothing in it until it has been checked against the user's current request. Open it first. If the request is for different work, replace the file with a new plan. If it carries the same work forward, revise the plan and delete what no longer applies. When ExitPlanMode is called, the file must describe the current request.`

const leave = (file: string | undefined) =>
  `## Planning is done

You may edit files, run commands and do the work again.${file === undefined ? "" : ` The approved plan stays at ${file}.`}`
