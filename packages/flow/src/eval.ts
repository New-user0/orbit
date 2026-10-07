import type { OrbitClient } from "@orbit/client"
import { run, type RunResult } from "./runner.js"
import type { CheckOptions, JudgeOptions, Workflow } from "./workflow.js"

// An eval runs every task of a suite on every model, each as a verify node in its own worktree, and scores
// whether the work passed its checks. It is an ordinary run, so `orb flow show`, `cost` and `resume` work on it.

export interface EvalTask {
  readonly id: string
  readonly prompt: string
  /** Commands that must exit 0 in the agent's worktree for the task to pass. */
  readonly checks: ReadonlyArray<string | Omit<CheckOptions, "in">>
  readonly judge?: JudgeOptions | boolean
  /** Attempts with feedback from failed checks. Default 1, which scores first-try success. */
  readonly maxIterations?: number
}

export interface EvalSuite {
  readonly name: string
  readonly description?: string
  /** Models to compare when `--models` is not given. */
  readonly models?: ReadonlyArray<string>
  readonly tasks: ReadonlyArray<EvalTask>
}

export interface EvalScore {
  readonly model: string
  readonly task: string
  readonly passed: boolean
  readonly iterations: number
  readonly input: number
  readonly output: number
  readonly cost: number
  /** Wall time of this task's run; a task reused on resume reports the time of the resume, near zero. */
  readonly seconds: number
  readonly error?: string
}

export interface EvalOptions {
  readonly client: OrbitClient
  readonly suite: EvalSuite
  readonly file: string
  readonly directory: string
  readonly models?: ReadonlyArray<string>
  /** Tasks running at once across all models. Default 1, which suits local models. */
  readonly concurrency?: number
  readonly permissions?: "reject" | "auto"
  readonly resume?: string
  readonly log?: (line: string) => void
}

export async function evaluate(options: EvalOptions): Promise<RunResult & { readonly scores?: EvalScore[] }> {
  const models = options.models?.length ? options.models : (options.suite.models ?? [])
  if (models.length === 0) throw new Error("No models to evaluate: pass --models or list `models` in the suite")
  const workflow: Workflow = {
    name: `eval:${options.suite.name}`,
    run: (ctx) =>
      ctx.parallel(
        models.flatMap((model) =>
          options.suite.tasks.map((task) => async (): Promise<EvalScore> => {
            const started = Date.now()
            // `suiteCommands` and `suiteAgents` in load.ts list, before the run, what a task hands on here that runs a
            // command (its `checks`) or names one of the user's agents (the `agent` of its `judge`), so an option added
            // here that does either is added there too.
            const result = await ctx.verify(`${model}.${task.id}`, {
              model,
              prompt: task.prompt,
              checks: task.checks,
              judge: task.judge,
              maxIterations: task.maxIterations ?? 1,
              retry: { maxAttempts: 1 },
              onError: "continue",
            })
            return {
              model,
              task: task.id,
              passed: result.verified,
              iterations: result.iterations,
              input: result.usage?.input ?? 0,
              output: result.usage?.output ?? 0,
              cost: result.usage?.cost ?? 0,
              seconds: Math.round((Date.now() - started) / 100) / 10,
              ...(result.verified ? {} : { error: result.error?.message }),
            }
          }),
        ),
        { concurrency: options.concurrency ?? 1 },
      ),
  }
  const result = await run({
    client: options.client,
    workflow,
    file: options.file,
    directory: options.directory,
    input: { models },
    resume: options.resume,
    permissions: options.permissions,
    log: options.log,
  })
  return result.status === "succeeded" ? { ...result, scores: result.output as EvalScore[] } : result
}

/** Pass rate, tokens, cost and time per model, in the order the models were given. */
export function summarize(scores: ReadonlyArray<EvalScore>) {
  return [...Map.groupBy(scores, (score) => score.model).entries()].map(([model, items]) => ({
    model,
    passed: items.filter((item) => item.passed).length,
    total: items.length,
    input: items.reduce((sum, item) => sum + item.input, 0),
    output: items.reduce((sum, item) => sum + item.output, 0),
    cost: items.reduce((sum, item) => sum + item.cost, 0),
    seconds: Math.round(items.reduce((sum, item) => sum + item.seconds, 0) * 10) / 10,
  }))
}
