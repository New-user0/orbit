// The contract a workflow file is written against. A workflow is a plain object, so a file needs no imports and runs
// under the compiled `orb` as well as from source:
//
//   export default {
//     name: "fix-and-test",
//     async run(ctx) {
//       const plan = await ctx.agent("plan", { prompt: `Plan: ${ctx.input.task}`, worktree: false })
//       const [api, ui] = await ctx.parallel([
//         () => ctx.agent("api", { prompt: `Do the API part of:\n${plan.text}` }),
//         () => ctx.agent("ui", { prompt: `Do the UI part of:\n${plan.text}` }),
//       ])
//       return ctx.merge("merge", [api, ui])
//     },
//   }
//
// The workflow function must be deterministic: same input, same node ids, same order of calls. Every model call happens
// inside ctx.agent and is recorded, which is what makes resume and replay possible.

/** How a failure is classified for retry decisions. */
export type ErrorClass =
  | "rate-limit"
  | "transient"
  | "timeout"
  | "auth"
  | "quota"
  | "content"
  | "invalid"
  | "permission"
  | "unknown"

export interface Retry {
  /** Attempts per model, including the first. Default 2. */
  readonly maxAttempts?: number
  /** Backoff between attempts in milliseconds. Default 1000 doubling up to 30000. */
  readonly backoff?: { readonly initial?: number; readonly factor?: number; readonly max?: number }
  /** Error classes worth another attempt. Default rate-limit, transient and timeout. */
  readonly retryOn?: ReadonlyArray<ErrorClass>
  /** Models (provider/model) tried in order once the attempts on the previous model are spent. */
  readonly fallbackModels?: ReadonlyArray<string>
}

export interface AgentOptions {
  readonly prompt: string
  /** provider/model; the server's default model when omitted. */
  readonly model?: string
  /** Agent name, such as build or plan; the server's default agent when omitted. */
  readonly agent?: string
  /** Run in a git worktree on its own branch so parallel agents never edit the same files. Default true in a git repository. */
  readonly worktree?: boolean
  readonly retry?: Retry
  /** `fail` (default) fails the run; `continue` returns a failed result and lets the workflow decide. */
  readonly onError?: "fail" | "continue"
  /** `reject` (default) refuses actions that need approval, with feedback; `auto` approves them once. */
  readonly permissions?: "reject" | "auto"
  /** Milliseconds before an attempt is interrupted and counted as a timeout. */
  readonly timeout?: number
}

/** Limits on a whole run. Checked before each agent attempt; going over pauses the run at the `budget` gate. */
export interface Budget {
  /** US dollars, as reported by providers or priced from the model's configured `cost`. */
  readonly maxCost?: number
  /** Input plus output tokens. */
  readonly maxTokens?: number
}

export interface GateOptions {
  /** What the approver is deciding, shown by `orb flow show` and `orb flow approve`. */
  readonly message: string
}

export interface GateDecision {
  readonly approved: boolean
  readonly note?: string
}

export interface Usage {
  readonly cost?: number
  readonly input?: number
  readonly output?: number
}

export interface AgentResult {
  readonly id: string
  readonly status: "succeeded" | "failed"
  /** The agent's final reply. */
  readonly text: string
  readonly model?: string
  /** The branch holding the agent's changes, when it ran in a worktree. */
  readonly branch?: string
  readonly worktree?: string
  readonly sessions: ReadonlyArray<string>
  readonly attempts: number
  readonly usage?: Usage
  readonly error?: { readonly class: ErrorClass; readonly message: string }
  /** True when resume or replay returned the recorded result instead of running the agent. */
  readonly reused?: boolean
}

export interface CheckOptions {
  /** A shell command (`sh -c` on macOS and Linux, `cmd /c` on Windows), such as `pytest -q` or `npm test`. */
  readonly command: string
  /** Run it in this agent's worktree; the run's checkout by default. */
  readonly in?: AgentResult
  /** Milliseconds before the command is stopped and counted as failed. Default 10 minutes. */
  readonly timeout?: number
}

export interface CheckResult {
  readonly command: string
  readonly ok: boolean
  /** Exit code; null when the command was stopped by the timeout. */
  readonly code: number | null
  /** The end of the combined stdout and stderr. */
  readonly output: string
}

export interface JudgeOptions {
  /** provider/model for the reviewer; the author's model by default. A different model catches different mistakes. */
  readonly model?: string
  readonly agent?: string
  /** What the reviewer should look for, in addition to correctness and completeness. */
  readonly criteria?: string
}

export interface VerifyOptions extends AgentOptions {
  /** Commands that must exit 0 in the author's worktree, run in order after each attempt. */
  readonly checks?: ReadonlyArray<string | Omit<CheckOptions, "in">>
  /** An LLM reviewer that reads the diff once the checks pass, and must reply APPROVED. */
  readonly judge?: JudgeOptions | boolean
  /** Author attempts, each fed the previous failures. Default 3. */
  readonly maxIterations?: number
}

export interface VerifyResult extends AgentResult {
  /** True when the checks passed and the reviewer, if any, approved. `status` is `failed` otherwise. */
  readonly verified: boolean
  readonly iterations: number
  /** The checks of the last iteration. */
  readonly checks: ReadonlyArray<CheckResult>
  /** The reviewer's last reply. */
  readonly review?: string
}

export interface TeamMember {
  /** What this member does, in a sentence or two. */
  readonly role: string
  /** provider/model; the run's `--model` by default. */
  readonly model?: string
  readonly agent?: string
  /** `reject` (default) or `auto`, as for agents. */
  readonly permissions?: "reject" | "auto"
}

export interface TeamOptions {
  /** What the team must achieve. */
  readonly goal: string
  /** Members by name. The first one leads unless `lead` names another. */
  readonly members: Readonly<Record<string, TeamMember>>
  readonly lead?: string
  /** Rounds before the team stops unfinished. In a round, every member with new messages takes one turn. Default 8. */
  readonly maxRounds?: number
  /** Work in a shared worktree on its own branch (default in a git repository), or in the checkout. */
  readonly worktree?: boolean
  readonly onError?: "fail" | "continue"
  /** Milliseconds per turn before it is interrupted. */
  readonly timeout?: number
}

export interface TeamMessage {
  readonly from: string
  /** A member name, or `all`. */
  readonly to: string
  readonly text: string
}

export interface TeamResult extends AgentResult {
  /** True when the lead finished with <done>; `status` is `failed` otherwise. */
  readonly done: boolean
  /** The lead's closing summary. */
  readonly summary: string
  readonly rounds: number
  readonly turns: number
  readonly messages: ReadonlyArray<TeamMessage>
  /** The shared board: the latest note under each key. */
  readonly board: Readonly<Record<string, string>>
}

export interface MergeResult {
  readonly id: string
  readonly status: "merged" | "conflict"
  readonly merged: ReadonlyArray<string>
  /** Set on conflict: the branch that did not merge and the files it conflicted on. */
  readonly conflict?: { readonly branch: string; readonly files: ReadonlyArray<string> }
}

export interface Context {
  readonly input: Readonly<Record<string, unknown>>
  readonly run: { readonly id: string; readonly directory: string }
  agent(id: string, options: AgentOptions): Promise<AgentResult>
  /** Run `fn` for every item, at most `concurrency` (default 4) at a time; results keep the item order. */
  map<T, R>(
    items: ReadonlyArray<T>,
    fn: (item: T, index: number) => Promise<R>,
    options?: { readonly concurrency?: number },
  ): Promise<R[]>
  /** Run tasks concurrently, at most `concurrency` (default 4) at a time; results keep the task order. */
  parallel<T>(tasks: ReadonlyArray<() => Promise<T>>, options?: { readonly concurrency?: number }): Promise<T[]>
  /** Merge the branches of worktree agents into the run's checkout, in order, stopping at the first conflict. */
  merge(id: string, results: ReadonlyArray<AgentResult>): Promise<MergeResult>
  /**
   * Wait for a person. The first time, the run records the question and pauses with status `waiting`; after
   * `orb flow approve <run> <id>` (or `--reject`), `orb flow resume` replays to this point and returns the decision.
   */
  gate(id: string, options: GateOptions): Promise<GateDecision>
  /** Run a command, such as the tests, and record whether it passed. Checks always run again on resume. */
  check(id: string, options: CheckOptions): Promise<CheckResult>
  /**
   * An agent whose work must pass `checks` and, optionally, a reviewer. Failures go back to the same agent, in the
   * same worktree, until it passes or `maxIterations` is reached. The result merges like any agent result.
   */
  verify(id: string, options: VerifyOptions): Promise<VerifyResult>
  /**
   * Agents that work together in one worktree and talk through messages and a shared board, coordinated by a lead,
   * until the lead says the goal is met. The result merges like any agent result.
   */
  team(id: string, options: TeamOptions): Promise<TeamResult>
  log(message: string): void
}

export interface Workflow {
  readonly name: string
  readonly description?: string
  /** Default budget for runs of this workflow; `--max-cost` and `--max-tokens` override it. */
  readonly budget?: Budget
  run(ctx: Context): Promise<unknown>
}
