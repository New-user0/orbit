# Orbit Flow

Orbit has two ways to run several agents on one task:

- **The `workflow` tool**, used by the agent itself during a chat. You ask for something ("write tests for this
  repo", "add CSV export with a review"); the agent decides how to split it and writes a short orchestration
  program, for example a writer, then a reviewer and a bug hunter in parallel, then a fixer. Each subagent works in
  its own child session, and only the program's result returns to the main agent, which keeps its context for
  planning and reviewing the outcome.
- **`orb flow`**, for workflows you write and keep in the repository, run from the command line with worktrees,
  merging, a run log and resume. The rest of this page describes `orb flow`.

## The workflow tool

The main agent calls `workflow` with a `description` and a `script`. The script runs in Orbit's confined
JavaScript interpreter: no imports, timers, filesystem or network; all real work happens in the subagents.

```js
const draft = await tools.agent({ description: "Write CSV export", prompt: "Add CSV export to src/report.ts ..." })
const [review, bugs] = await Promise.all([
  tools.agent({ description: "Review export", prompt: `Review this change. Do not edit files.\n${draft}` }),
  tools.agent({
    description: "Hunt export bugs",
    prompt: "Find bugs in the CSV export in src/report.ts. Do not edit files.",
  }),
])
const fix = await tools.agent({ description: "Fix findings", prompt: `Fix these findings:\n${review}\n${bugs}` })
return { review, bugs, fix }
```

- `tools.agent({ description, prompt, agent?, model?, phase? })` runs one subagent (default `general`) and returns
  its final reply; it throws if the subagent fails. `phase` names the stage it belongs to (such as Discover, Build or
  Verify); the TUI and VS Code group agents by phase.
- At most 4 subagents run at once, and one workflow starts at most 24.
- Subagents cannot start workflows or subagents of their own, unless `experimental.subagent_depth` allows nesting.
- The tool follows the `subagent` permission: denying `subagent` for an agent also hides `workflow`, and the
  permission is checked for each subagent type the script uses.
- Interrupting the main session stops every running subagent. In the TUI and VS Code, the workflow shows a card
  with each phase's progress and a row per subagent (model, tokens, time); click one to open its session. The
  agents chip by the prompt, or `/map` in the TUI, opens the agent map of the session and every agent under it.

Orbit Flow runs workflows of several agents as one recorded, resumable run. A workflow is a plain TypeScript or
JavaScript file whose default export has a `name` and an async `run(ctx)`. It needs no imports, so it runs under the
compiled `orb` as well as from source.

```ts
// .orbit/workflows/feature.ts
export default {
  name: "feature",
  async run(ctx) {
    const plan = await ctx.agent("plan", {
      prompt: `Write a short plan for: ${ctx.input.task}`,
      agent: "plan",
      worktree: false,
    })
    const [api, ui, tests] = await ctx.parallel([
      () => ctx.agent("api", { prompt: `Implement the API part of this plan:\n${plan.text}` }),
      () => ctx.agent("ui", { prompt: `Implement the UI part of this plan:\n${plan.text}` }),
      () =>
        ctx.agent("tests", {
          prompt: `Write tests for this plan:\n${plan.text}`,
          model: "ollama/qwen3:8b",
          retry: { fallbackModels: ["tachyon/gpt-5.4"] },
          onError: "continue",
        }),
    ])
    return ctx.merge("merge", [api, ui, tests])
  },
}
```

```sh
orb flow run .orbit/workflows/feature.ts --model tachyon/claude-opus-4-5@20251101 --input task="add CSV export"
orb flow ls
orb flow show <run>
orb flow resume <run>
orb flow approve <run> <gate> [--reject] [--note "..."]
orb flow cost <run>
orb flow clean [<run>]
orb flow watch [<run>]
orb flow replay <run> [--file <workflow>]
orb flow trace <run> [--format otlp] [--otlp <collector url>]
orb eval <suite> --models a,b
```

## Writing `orb flow` workflows

## The context

| Call                                                            | Does                                                                                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.agent(id, options)`                                        | Runs one agent in a fresh session and returns `{ status, text, model, branch, sessions, attempts, usage, error }`.                                                                                              |
| `ctx.parallel(tasks, { concurrency })`                          | Runs `() => Promise` tasks concurrently (default 4 at a time); results keep the task order. Every task settles before a failure is raised.                                                                      |
| `ctx.merge(id, results)`                                        | Merges the branches of succeeded worktree agents into your checkout in order. On a conflict it aborts that merge, leaves the checkout clean, and returns `{ status: "conflict", conflict: { branch, files } }`. |
| `ctx.input`                                                     | Values from `--input key=value` (repeatable) or `--input '{"json": true}'`.                                                                                                                                     |
| `ctx.gate(id, { message })`                                     | Waits for a person; returns `{ approved, note }`. See [Gates](#gates).                                                                                                                                          |
| `ctx.verify(id, { prompt, checks, judge, maxIterations, ... })` | An agent whose work must pass checks and a reviewer, retried with feedback. See [Verify loops](#verify-loops).                                                                                                  |
| `ctx.check(id, { command, in? })`                               | Runs a shell command (in an agent's worktree with `in`) and returns `{ ok, code, output }`. See [Verify loops](#verify-loops).                                                                                  |
| `ctx.team(id, { goal, members, lead?, maxRounds? })`            | Agents that work in one worktree and talk through messages and a board until the lead finishes. See [Teams](#teams).                                                                                            |
| `ctx.map(items, fn, { concurrency })`                           | Runs `fn(item, index)` for every item, at most `concurrency` (default 4) at a time; results keep the item order.                                                                                                |
| `ctx.log(message)`                                              | Prints and records a line in the run.                                                                                                                                                                           |

Agent options: `prompt`, `model` (`provider/model`; defaults to `--model`, which a resumed run keeps), `agent`, `worktree`, `retry`, `onError`, `permissions`,
`timeout` (milliseconds per attempt).

Node ids must be unique within a run and the workflow must call them in the same way each time: same input, same
ids. That is what lets a resumed run line up with its recording.

## YAML workflows

A `.yaml` or `.yml` file describes the same nodes as a graph, with no code:

```yaml
name: feature
budget: { maxTokens: 400000 }
nodes:
  - id: plan
    prompt: "Write a short plan for: {{input.task}}"
    worktree: false
  - id: api
    needs: [plan]
    prompt: "Implement the API part of this plan:\n{{plan.text}}"
  - id: ui
    needs: [plan]
    prompt: "Implement the UI part of this plan:\n{{plan.text}}"
  - id: tests
    type: verify
    needs: [api]
    prompt: "Write tests for the API change."
    checks: ["npm test"]
  - id: approve
    type: gate
    needs: [tests, ui]
    message: "Merge the API, UI and tests?"
  - id: merge
    type: merge
    needs: [approve]
    branches: [api, ui, tests]
output: merge
```

- `type` is `agent` (the default), `verify`, `team`, `check`, `gate` or `merge`. Other keys are that node's options,
  as in TypeScript. `check` takes `command` and `in` (a node id), and `merge` takes `branches` (node ids).
- A node starts as soon as every node in `needs` has finished, so independent branches run in parallel.
- `{{input.key}}` is the run's `--input`; `{{node.field}}` is a field of an upstream node's result, such as
  `{{plan.text}}` or `{{tests.review}}`. Objects are inserted as JSON.
- A rejected gate skips every node that depends on it.
- The output is the result of the `output` node, or every node's result by id.
- The file is checked before anything runs: unique ids, known types, required options, `needs` that exist, no
  cycles, and templates, `in` and `branches` naming only upstream nodes.

Eval suites can be YAML or JSON as well.

## Worktrees

In a git repository each agent runs in its own worktree, `.orbit/worktrees/<run>/<node>`, on branch
`orbit/<run>/<node>`, created from the commit the run started at. Parallel agents never edit the same files. When
the agent succeeds, its changes are committed to that branch. `.orbit/` is added to `.git/info/exclude`, so neither
the worktrees nor the run store show up in `git status`. Pass `worktree: false` for agents that only read or plan;
they run in the checkout itself. Branches and worktrees are kept after the run for inspection; remove them with
`git worktree remove` and `git branch -D`.

## Failures, retries and fallback

Each agent node retries according to `retry`:

| Field            | Default                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `maxAttempts`    | 2 per model                                                                   |
| `retryOn`        | `rate-limit`, `transient`, `timeout`                                          |
| `backoff`        | `{ initial: 1000, factor: 2, max: 30000 }`                                    |
| `fallbackModels` | none: models tried in order once the attempts on the previous model are spent |

Error classes are `rate-limit`, `transient`, `timeout`, `auth`, `quota`, `content`, `invalid`, `permission` and
`unknown`. A `permission` failure stops the node without trying fallback models.

Across runs, a model whose last 3 attempts in this repository all failed with `rate-limit`, `transient` or `timeout`
within the last minute is skipped, and the node moves on to its fallback models. One success closes the breaker
again.

With `onError: "fail"` (the default) a failed node fails the run, after its parallel siblings finish. With
`onError: "continue"` it returns a result with `status: "failed"` and the workflow decides what to do.

## Permissions

A run is unattended. When an agent asks to do something that needs approval, the run rejects it and tells the agent
to continue without it (`permissions: "reject"`, the default). Use `permissions: "auto"` on a node, or `orb flow run
--auto`, to approve such requests once. Rules you configured as `deny` stay denied either way.

## Resume

Every run is an append-only event log in `.orbit/runs.db` at the repository root. `orb flow resume <run>` runs the
same workflow file again. A node that already succeeded with the same prompt, model, agent, worktree setting and
fallback models returns its recorded result without calling a model; everything else runs. A resumed worktree
node starts from the same base commit as the original run.

## Gates

`ctx.gate(id, { message })` pauses the run for a decision. The first time the workflow reaches it, the run records
the question, lets running siblings finish, and stops with status `waiting` (exit code 2):

```js
const plan = await ctx.agent("plan", { prompt: "...", worktree: false })
const decision = await ctx.gate("approve-plan", { message: `Implement this plan?\n${plan.text}` })
if (!decision.approved) return { stopped: decision.note }
```

```sh
orb flow show <run>                          # ? approve-plan  waiting: Implement this plan? ...
orb flow approve <run> approve-plan --note "skip the UI part"
orb flow resume <run>
```

On resume, finished nodes return their recorded results, and the gate returns the decision: `{ approved: true,
note: "skip the UI part" }`. `--reject` returns `approved: false`; the workflow decides what that means. A gate can
be decided once.

## Budgets and cost

A budget limits a whole run: `--max-cost <dollars>` and `--max-tokens <n>` on `orb flow run` or `orb flow resume`,
or a default in the workflow:

```js
export default { name: "feature", budget: { maxCost: 2, maxTokens: 500000 }, async run(ctx) { ... } }
```

Spend is checked before every agent attempt, including retries and resumed runs. When the run has reached its
budget, it pauses at the gate `budget` instead of failing: approve it to continue with no budget for the rest of
the run, or reject it to stop the run. An attempt already running is not cut off, so a run can end slightly over.

`orb flow cost <run>` lists attempts, input and output tokens and cost by node and model, with a total.

Cost is what the session reports. Providers that do not return prices, such as Tachyon, are priced from the model's
`cost` in `orbit.json`, in US dollars per million tokens:

```jsonc
{
  "providers": {
    "tachyon": {
      "models": {
        "claude-opus-4-5@20251101": { "cost": { "input": 15, "output": 75 } },
      },
    },
  },
}
```

Without a price, cost shows as $0 and only `--max-tokens` limits the run.

## Verify loops

`ctx.verify` is an agent with a definition of done:

```js
const work = await ctx.verify("export", {
  prompt: "Add CSV export to src/report.ts.",
  checks: ["npm test", "npm run lint"],
  judge: { model: "tachyon/gpt-5.4", criteria: "Quoting of commas and newlines must follow RFC 4180." },
  maxIterations: 3,
})
```

Each iteration:

1. The author agent works in the node's worktree. From the second iteration, its prompt adds what failed last time.
   Its earlier changes are still there.
2. The checks run in that worktree in order, stopping at the first failure. A check passes when it exits 0. Commands
   run through `sh -c`, or `cmd /c` on Windows, with a 10-minute default timeout.
3. If they pass and `judge` is set, a reviewer gets the task and the diff since the run started. It must start its
   reply with `APPROVED`; anything else is a list of problems for the next iteration. The reviewer makes no changes.
   It uses the author's model unless `judge.model` names another, and a different model catches different mistakes.

The result is an agent result with `verified`, `iterations`, the last `checks` and the last `review`. It merges like
any other. After `maxIterations` without passing, the node fails, or returns `status: "failed"` with
`onError: "continue"`. Agent options such as `model`, `retry` and `permissions` apply to the author.

`ctx.check(id, { command, in })` runs one command on its own, for example to gate a merge:

```js
const tests = await ctx.check("tests", { command: "npm test", in: work })
if (!tests.ok) return { failed: tests.output }
```

Checks run again on resume. Agents and reviewers whose input has not changed are reused.

## Evals

`orb eval <suite>` runs every task of a suite on every model and scores whether the work passed its checks:

```js
// .orbit/evals/api.ts
export default {
  name: "api",
  models: ["tachyon/claude-opus-4-5@20251101", "ollama/qwen3.8:27b"],
  tasks: [
    { id: "pagination", prompt: "Add cursor pagination to GET /items.", checks: ["npm test -- items"] },
    {
      id: "rate-limit",
      prompt: "Limit POST /items to 10 per minute per user.",
      checks: ["npm test -- limits"],
      maxIterations: 2,
    },
  ],
}
```

```sh
orb eval .orbit/evals/api.ts                       # the suite's models
orb eval .orbit/evals/api.ts --models ollama/a,ollama/b --format json
```

- Each task is a verify node in its own worktree from the current commit. Models never see each other's work, and
  the checkout is not changed.
- `maxIterations` defaults to 1, which scores first-try success. Tasks can set `judge` like a verify node.
- `--concurrency n` runs n tasks at once (default 1).
- The report has passed tasks, pass rate, tokens, cost and time per model, and a task-by-model grid.
- An eval is a run like any other: `orb flow show` and `orb flow cost` work on it, and `orb eval <suite> --resume
<run>` finishes an interrupted one with the same models.

## Teams

`ctx.team` puts several agents in one worktree with roles, a lead, messages and a shared board:

```js
const result = await ctx.team("csv-export", {
  goal: "Add CSV export to the report page, with tests, reviewed.",
  members: {
    lead: { role: "Plan the work, assign it, check results, and decide when it is done." },
    coder: { role: "Implement what the lead assigns." },
    tester: { role: "Write and run tests for what the coder built; report failures to the coder." },
    reviewer: { role: "Review the changes for correctness and style. Do not edit files.", model: "tachyon/gpt-5.4" },
  },
  maxRounds: 8,
})
return ctx.merge("merge", [result])
```

How it runs:

- The first member leads, unless `lead` names another. It starts alone with the goal.
- Members talk with tags in their replies, which works with any model:
  - `<message to="coder">…</message>` to one member, or `to="all"`;
  - `<note key="plan">…</note>` to write the shared board;
  - the lead finishes with `<done>summary</done>`.
- In each round, every member with new messages takes one turn, one at a time, in the order they are listed. Their
  edits never collide. Each turn brings the messages that arrived and the whole board.
- Each member keeps its own session, so it remembers its earlier turns. Members may use different models.
- The team stops when the lead finishes (`done: true`), after `maxRounds` (default 8), or when nobody has anything
  pending even after the lead is asked to finish or hand out more work. Those last two fail the node, unless
  `onError: "continue"`.
- The result has `done`, `summary`, `rounds`, `turns`, every `messages` entry and the `board`, plus `branch` and
  `usage` like an agent result. Changes are committed to the team's branch, so `ctx.merge` takes the result.
- `orb flow show <run>` lists each turn (`csv-export/coder#3`) and the conversation. On resume, turns that already
  ran are reused, and the team carries on from there in the same sessions.

## Watching, replay and VS Code

`orb flow watch [<run>]` redraws a run's nodes and team conversation every second until it stops; without a run it
watches the newest.

`orb flow replay <run>` re-runs a finished run as a new run from its recorded results: no model calls, worktrees,
merges or server connection. Every node returns what the recording holds for its id. Uses:

- **Debugging a workflow's logic:** pass an edited copy with `--file`. Nodes whose inputs changed are reported
  (`~ node: its inputs differ from the recording`) and still return the recorded result. A node the recording lacks
  stops the replay (`Replay diverged`), because the replay cannot invent a model's answer.
- **Reproducing a run exactly:** the replay compares its output with the recorded one and exits with code 1 if they
  differ.

In the terminal UI, `/runs` (or **Orbit Flow runs** in the command palette) lists the runs of the current
directory. Selecting a run lists its nodes, with gates waiting for a decision at the top. Selecting a waiting gate
approves or rejects it, with or without a note. Then continue the run with `orb flow resume <run>`.

The VS Code extension has a **Runs** view: runs of the open folder with their nodes, updated live. Gates can be
approved or rejected there with a note, and runs resumed, watched and cleaned up.

## Traces

`orb flow trace <run>` prints a timeline of the run, its nodes and every model attempt, with start times and
durations. `--format otlp` prints the same spans as OpenTelemetry (OTLP/HTTP JSON), with `gen_ai.request.model`
and `gen_ai.usage.*` attributes on attempts. `--otlp http://collector:4318` sends them to that collector. Orbit
sends traces nowhere unless you give that flag.

## Cleaning up

Worktrees and branches stay after a run for inspection. `orb flow clean` removes them for every run that is not
running or waiting; `orb flow clean <run>` for one run. The run history in `.orbit/runs.db` stays.
