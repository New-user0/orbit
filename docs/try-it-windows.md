# Trying Orbit on Windows

A step-by-step walkthrough, from `git pull` to running multi-agent workflows. Commands are PowerShell. The
repository is assumed to be at `D:\Project\harness`; adjust paths to yours.

## 1. Get the code

```powershell
cd D:\Project\harness
git fetch origin
git checkout claude/tender-mccarthy-67q6q9
git pull origin claude/tender-mccarthy-67q6q9
bun --version          # must be 1.4.2 or newer; if not: bun upgrade
```

## 2. Install and build

```powershell
bun install --frozen-lockfile
cd packages\cli
bun run build --single
cd ..\..
Get-ChildItem packages\cli\dist          # cli-windows-x64 (or cli-windows-x64-baseline on older CPUs)
$env:Path = "D:\Project\harness\packages\cli\dist\cli-windows-x64\bin;" + $env:Path
where.exe orb                            # the first line must be the path above
orb --version
orb flow run --help                      # lists --model, --max-cost, --max-tokens, --auto
orb service stop                         # the next command starts the new build's background service
```

## 3. Pick a model

List the models Orbit can use and copy one **exactly** as printed:

```powershell
orb models
$MODEL = "ollama/qwen3:8b"               # replace with a name from the list above
orb doctor --probe --model $MODEL        # must report the model as reachable
```

- **Ollama:** set `OLLAMA_CONTEXT_LENGTH=32768` where Ollama runs and in this terminal
  (`$env:OLLAMA_CONTEXT_LENGTH = "32768"`), then restart Ollama.
- **Tachyon:** set your `TACHYON_*` variables (see [tachyon.md](tachyon.md)); models appear as
  `tachyon/<model>`.

Workflows need a model that follows instructions and calls tools reliably. A Tachyon Claude or GPT model works best;
small local models often do not.

To see cost for Tachyon, which reports no prices, add prices to `orbit.json` (`orb debug paths` shows where it
is), in US dollars per million tokens:

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

## 4. Make a practice repository

```powershell
mkdir D:\Project\flow-demo
cd D:\Project\flow-demo
git init -b main
@'
def add(a, b):
    return a + b


def divide(a, b):
    return a / b
'@ | Set-Content -Encoding utf8 calc.py
git add -A
git -c user.name=me -c user.email=me@example.com commit -m "initial"
mkdir .orbit\workflows
```

A helper to get the newest run's id, used below (PowerShell reads `<run-id>` as a redirect, so use `$RUN`):

```powershell
function Last-Run { (orb flow ls --format json | ConvertFrom-Json)[0].id }
```

## 5. The workflow tool, inside a chat

The agent plans the split itself. Start the TUI in the practice repository, pick your model, and send:

```powershell
orb
```

> Improve calc.py. Use a workflow in three phases: in phase Build one agent adds input validation and docstrings;
> in phase Review one agent reviews the change and another looks for bugs, both without editing; in phase Fix one
> agent fixes everything they found. Show me the final result.

What you should see:

- The banner at the top: the Orbit mark, version, folder and branch, and on the right the session and model.
- A **Workflow** card: the agent count, tokens and time, then each phase (**Build**, **Review**, **Fix**) with a
  square per agent and a `done/total` count, and under it one row per agent with its model, tokens and time. A
  spinner marks a running agent, `●` a finished one, `✕` a failed one. A finished phase folds; click it to open it.
- The review and bug hunt rows run at the same time.
- By the prompt, `● 2 agents` while agents work. Click it, or type `/map`, for the **Agent map**: this session and
  every agent under it. Selecting an agent, or clicking its row in the card, opens its session. The main session only
  receives the final summary.
- If the agent keeps a plan, it is docked above the prompt as `◎ plan 2/4` with `●` done, a spinner on the current
  step and `○` to do.
- `git diff` shows the changes. Commit or discard them before step 6: `git checkout -- .`

Without the TUI:

```powershell
orb run --model $MODEL --auto "Write tests for calc.py. Use a workflow: one agent writes tests, one reviews them for missing cases, one adds the missing cases. Then run the tests."
```

## 6. `orb flow`: workflows you write and keep

These workflow files leave out `model`; `--model $MODEL` sets it for every agent, and `orb flow resume` reuses it.

### 6a. Parallel agents, worktrees and merge

```powershell
@'
export default {
  name: "improve-calc",
  async run(ctx) {
    const [docs, tests] = await ctx.parallel([
      () => ctx.agent("docs", { prompt: "Add docstrings to every function in calc.py. Change nothing else." }),
      () => ctx.agent("tests", { prompt: "Create test_calc.py with pytest tests for calc.py. Do not edit calc.py." }),
    ])
    return ctx.merge("merge", [docs, tests])
  },
}
'@ | Set-Content -Encoding utf8 .orbit\workflows\improve.ts

orb flow run .orbit\workflows\improve.ts --model $MODEL
$RUN = Last-Run
orb flow show $RUN
orb flow cost $RUN
git log --oneline --graph
```

Expected:

- `> docs` and `> tests` start together, then `✓ docs (…)`, `✓ tests (…)` and `✓ merge: merged 2 branch(es)`.
- Your checkout now has the docstrings in `calc.py` and a new `test_calc.py`, with two merge commits.
- `git status` stays clean. Run data lives in `.orbit\`, which Orbit adds to `.git\info\exclude`.

If an agent fails with `Model … is not available`, the name does not match `orb models` exactly.

### 6b. Resume after a crash

```powershell
git reset --hard (git rev-list --max-parents=0 HEAD)     # back to the initial commit
orb flow run .orbit\workflows\improve.ts --model $MODEL  # press Ctrl+C after the first ✓
$RUN = Last-Run
orb flow show $RUN                                       # one ✓, one still running
orb flow resume $RUN
```

Expected: the finished agent shows `= docs (recorded)` (or `= tests`) and is not run again. Only the other one
runs, then the merge.

### 6c. Retries and fallback models

`@"…"@` (double quotes) puts the value of `$MODEL` into the file:

```powershell
@"
export default {
  name: "fallback",
  run: (ctx) =>
    ctx.agent("explain", {
      model: "ollama/no-such-model",
      worktree: false,
      prompt: "Explain what calc.py does in two sentences.",
      retry: { maxAttempts: 1, fallbackModels: ["$MODEL"] },
    }),
}
"@ | Set-Content -Encoding utf8 .orbit\workflows\fallback.ts
orb flow run .orbit\workflows\fallback.ts
```

Expected: `! explain attempt 1: invalid: Model ollama/no-such-model is not available. …`, then
`✓ explain (<your model>)`. The output has `"attempts": 2` and your model.

### 6d. An approval gate

```powershell
@'
export default {
  name: "gated",
  async run(ctx) {
    const plan = await ctx.agent("plan", {
      worktree: false,
      prompt: "Propose, in at most 5 bullet points, how to make divide() in calc.py safe. Do not edit files.",
    })
    const decision = await ctx.gate("approve-plan", { message: "Implement this plan?\n" + plan.text })
    if (!decision.approved) return { implemented: false, reason: decision.note }
    const work = await ctx.agent("implement", {
      prompt: "Implement this plan in calc.py:\n" + plan.text + "\nReviewer note: " + (decision.note ?? "none"),
    })
    return ctx.merge("merge", [work])
  },
}
'@ | Set-Content -Encoding utf8 .orbit\workflows\gated.ts

orb flow run .orbit\workflows\gated.ts --model $MODEL
$LASTEXITCODE                    # 2: waiting for a decision
$RUN = Last-Run
orb flow show $RUN               # ? approve-plan  waiting: Implement this plan? ...
orb flow approve $RUN approve-plan --note "raise ValueError on zero"
orb flow resume $RUN
```

Expected: the resume does not run `plan` again (`= plan (recorded)`). It implements the plan with your note and
merges. Run it again and use `orb flow approve $RUN approve-plan --reject`; it ends with
`{ "implemented": false, ... }`.

### 6e. A budget

The budget is checked before each agent starts, so this workflow runs its agents one after another:

```powershell
@'
export default {
  name: "polish",
  async run(ctx) {
    const steps = {
      docstrings: "Add docstrings to every function in calc.py.",
      hints: "Add type hints to every function in calc.py.",
      header: "Add a short module docstring at the top of calc.py.",
    }
    for (const [id, prompt] of Object.entries(steps)) await ctx.agent(id, { worktree: false, prompt })
    return "polished"
  },
}
'@ | Set-Content -Encoding utf8 .orbit\workflows\polish.ts

orb flow run .orbit\workflows\polish.ts --model $MODEL --max-tokens 15000
$LASTEXITCODE                    # 2 if the budget paused it
$RUN = Last-Run
orb flow cost $RUN               # tokens and cost so far, by node and model
orb flow approve $RUN budget
orb flow resume $RUN             # continues with no budget for the rest of the run
```

Expected: once the run has used 15,000 tokens, the next agent does not start. The run shows
`budget: Budget reached: spent …` and exits with code 2. If it finishes first, lower the number; one agent step
with Orbit's prompt and tools uses about 5,000 tokens. `--max-cost 0.50` limits dollars instead; this needs a
priced model (step 3). An agent that has already started is not cut off.

### 6f. Permissions

Agents in `orb flow` run unattended. Actions that need approval, usually shell commands, are refused, and the agent
is told to continue without them. Add `--auto` to approve them, or set `permissions: "auto"` on one agent.

### 6g. A verify loop: write, check, review, fix

`ctx.verify` runs an author agent, then checks you choose, then (optionally) a reviewer. Anything that fails goes back
to the same agent until it passes. Commit a small check script first, so the agents' worktrees have it:

```powershell
git checkout -- calc.py                         # start from the committed calc.py
@'
from calc import divide

assert divide(6, 3) == 2
try:
    divide(1, 0)
except ValueError:
    print("ok")
else:
    raise SystemExit("divide(1, 0) did not raise ValueError")
'@ | Set-Content -Encoding utf8 check_divide.py
git add check_divide.py
git -c user.name=me -c user.email=me@example.com commit -m "add divide check"

@'
export default {
  name: "safe-divide",
  async run(ctx) {
    const work = await ctx.verify("divide", {
      prompt: "In calc.py, make divide(a, b) raise ValueError when b is 0. Keep other behaviour.",
      checks: ["python check_divide.py"],
      judge: { criteria: "The error message should say why the call failed." },
      maxIterations: 3,
    })
    return ctx.merge("merge", [work])
  },
}
'@ | Set-Content -Encoding utf8 .orbit\workflows\verify.ts

orb flow run .orbit\workflows\verify.ts --model $MODEL
```

Expected:

- `> divide#1`, then `✓ divide#1.check1: python check_divide.py (exit 0)` or `✗ … (exit 1)`.
- On a failure, `divide#2` gets the check's output and tries again.
- Once the check passes, `divide#N.judge` reviews the diff and must start its reply with APPROVED.
- `✓ divide verified in N iteration(s)` and the merge. After `maxIterations` without passing, the run fails instead.

`judge: { model: "tachyon/…" }` lets a different model review. If section 6d already merged a safe `divide`, the check passes on the first try; to
see a failure fed back, start from `git checkout HEAD~N -- calc.py` with an older version, or ask for something new.

### 6h. Compare models with `orb eval`

An eval suite lists tasks and the checks that decide whether each passed. Add a second check, then the suite:

```powershell
@'
from calc import multiply

assert multiply(3, 4) == 12
print("ok")
'@ | Set-Content -Encoding utf8 check_multiply.py
git add check_multiply.py
git -c user.name=me -c user.email=me@example.com commit -m "add multiply check"

mkdir .orbit\evals -ErrorAction SilentlyContinue
@'
export default {
  name: "calc",
  tasks: [
    {
      id: "safe-divide",
      prompt: "In calc.py, make divide(a, b) raise ValueError when b is 0. Keep other behaviour.",
      checks: ["python check_divide.py"],
    },
    {
      id: "multiply",
      prompt: "Add a function multiply(a, b) to calc.py that returns a * b.",
      checks: ["python check_multiply.py"],
    },
  ],
}
'@ | Set-Content -Encoding utf8 .orbit\evals\calc.ts

orb eval .orbit\evals\calc.ts --models "ollama/qwen3.8:27b,ollama/granite4.1:8b"
```

Expected: one table per model with passed tasks, pass rate, tokens, cost and time, and one row per task with ✓ or ✗
for each model. Each task runs in its own worktree from your last commit, so models never see each other's work, and
your checkout is not changed. Tasks get one try each; add `maxIterations: 3` to a task to score with feedback
instead. `--concurrency 2` runs two tasks at once (slow on one local GPU). If it stops, `orb eval
.orbit\evals\calc.ts --resume <run>` finishes only what is left.

### 6i. A team: lead, coder and reviewer

```powershell
@'
export default {
  name: "team",
  async run(ctx) {
    const result = await ctx.team("stats", {
      goal: "Add a function median(numbers) to calc.py that raises ValueError on an empty list, and a check script check_median.py that tests it.",
      members: {
        lead: { role: "Plan the work, assign it, check what comes back, and decide when it is done." },
        coder: { role: "Write the code the lead asks for." },
        reviewer: { role: "Read the changed files and report problems to the lead. Do not edit files." },
      },
      maxRounds: 6,
    })
    await ctx.merge("merge", [result])
    return { done: result.done, summary: result.summary, turns: result.turns }
  },
}
'@ | Set-Content -Encoding utf8 .orbit\workflows\team.ts

orb flow run .orbit\workflows\team.ts --model ollama/qwen3.8:27b
$RUN = Last-Run
orb flow show $RUN               # every turn, then who said what to whom
```

Expected: `> stats/lead#1`, lines such as `lead → coder: …` as members message each other, more turns, and finally
`✓ stats: <the lead's summary>` and the merge. Small local models sometimes forget the message tags; the team then
stops with `the team stopped: nobody had anything pending…` or runs out of rounds. A stronger model, or a Tachyon
model for the lead (`lead: { role: "...", model: "tachyon/..." }`), keeps it on track.

### 6j. Watch a run live, and replay it without models

In a second PowerShell window, while a run works:

```powershell
cd D:\Project\flow-demo
orb flow watch                   # the newest run, redrawn every second until it stops
```

Replay re-runs a finished run from its recording: no model calls, no worktrees, no merges, no server. It is fast
and free, so it is the way to check changes to a workflow's own logic:

```powershell
$RUN = Last-Run
orb flow replay $RUN             # "replay matches the recorded output of …"
Copy-Item .orbit\workflows\team.ts .orbit\workflows\team-edited.ts
# edit team-edited.ts, for example change the return value or a prompt
orb flow replay $RUN --file .orbit\workflows\team-edited.ts
```

A changed prompt shows `~ <node>: its inputs differ from the recording` but still uses the recorded result. A
workflow that now calls a node the recording lacks stops with `Replay diverged: …`. A different final output
exits with code 1.

### 6k. A YAML workflow

The same building blocks without code. `a` and `b` run in parallel, `c` uses `a`'s reply, a check runs in `c`'s
worktree, and a gate waits before the merge:

```powershell
@'
name: yaml-demo
nodes:
  - id: docs
    prompt: Add docstrings to every function in calc.py. Change nothing else.
  - id: notes
    prompt: Create NOTES.md with one line per function in calc.py describing it.
  - id: readme
    needs: [docs, notes]
    prompt: "Create README.md for calc.py, using these notes:\n{{notes.text}}"
  - id: compiles
    type: check
    needs: [docs]
    in: docs
    command: python -m py_compile calc.py
  - id: approve
    type: gate
    needs: [compiles, readme]
    message: Merge docs, notes and README?
  - id: merge
    type: merge
    needs: [approve]
    branches: [docs, notes, readme]
output: merge
'@ | Set-Content -Encoding utf8 .orbit\workflows\demo.yaml

orb flow run .orbit\workflows\demo.yaml --model $MODEL
$RUN = Last-Run
orb flow approve $RUN approve
orb flow resume $RUN
```

A mistake in the file, such as an unknown `needs` or a cycle, is reported before anything runs.

### 6l. Timeline and traces

```powershell
orb flow trace $RUN                     # timeline of the run, its nodes and every model attempt
orb flow trace $RUN --format otlp       # the same as OpenTelemetry JSON
```

`--otlp http://<collector>:4318` sends it to an OpenTelemetry collector. Orbit sends nothing without that flag.

### 6m. Runs and gates in the terminal UI

Start a gated run (6d) and leave it waiting. Then open `orb`, type `/runs`, pick the run, pick the `?` gate, and
choose **Approve** or **Approve with a note…**. Continue with `orb flow resume <run>`.

## 7. Clean up the practice repository

```powershell
orb flow clean                    # worktrees and branches of every finished run
orb flow clean $RUN               # or of one run
```

`.orbit\runs.db` keeps the run history; delete it to start fresh.

## 8. If something goes wrong

| Symptom                                                | Fix                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `orb models` prints `No models are available`          | Check Ollama answers: `Invoke-RestMethod http://127.0.0.1:11434/api/tags`. For Tachyon, check `orb doctor`. |
| `Model … is not available`                             | Copy the name exactly from `orb models`, and pass it with `--model`.                                        |
| `The agent produced no reply. No model was set for it` | Add `--model $MODEL`, or set `model` in the workflow or `orbit.json`.                                       |
| `orb flow` is not a command, or old behaviour          | `where.exe orb` must show the new build first; then `orb service stop`.                                     |
| `worktree agents need a git repository with a commit`  | Run inside a git repository that has at least one commit, or use `worktree: false`.                         |
| Agents write nothing, or Ollama loses the request      | `OLLAMA_CONTEXT_LENGTH=32768` for Ollama and `orb`; `orb doctor --probe` warns about small contexts.        |
| `The '<' operator is reserved`                         | Use `$RUN` instead of typing `<run-id>`.                                                                    |
| The chat never uses the workflow tool                  | Say "use a workflow" in the prompt, or use a stronger model.                                                |
| Cost shows `$0.0000`                                   | The provider reports no price; add `cost` for the model in `orbit.json`.                                    |

## 9. VS Code (optional)

```powershell
cd D:\Project\harness\packages\vscode
bun run package
code --install-extension (Get-ChildItem dist\orbit-code-*.vsix).FullName --force
```

In VS Code settings, set `orbit.executable` to the full path of the new `orb.exe`, then reload the window.

Click the Orbit icon in the activity bar, or run **Orbit: Open Orbit** from the Command Palette. The chat opens as an
editor tab with the Explorer beside it; files and proposed diffs open next to the chat, and runs are listed under
**Orbit Runs** in the Explorer. To keep the chat in the side bar instead, set `orbit.placement` to `sidebar` and
reload the window.

- The empty chat offers starters from the editor (explain the selection, fix the file's problems, review uncommitted
  changes) and shows its setup checks: `orb` found, the background service, the models.
- Select code first and it rides along as a chip in the composer; `×` drops it. `Build ▾` switches to Plan (reads
  only), and the model name picks another model.
- Edits ask in an inline card with a short diff: **Allow**, **Always allow**, **Reject**, or **Open diff ↗** to see
  it side by side. The status bar shows `Orbit · working`, or `Orbit · needs review` while a card waits.
- The prompt from step 5 shows the same **Workflow** card, and `● 2 agents` in the composer opens the agent map.
- The tab's history button (◷) continues an earlier session from this folder.

Open `D:\Project\flow-demo` in VS Code. **Orbit Runs** in the Explorer lists its runs; expand one to see its nodes.
To try gates there, run `orb flow run .orbit\workflows\gated.ts --model $MODEL` (section 6d) in the terminal. When
`approve-plan` shows a `?`, use the ✓ next to it, add a note, and choose **Resume**.
