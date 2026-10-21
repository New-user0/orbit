import type { OrbitClient } from "@orbit/client"
import { createHash } from "node:crypto"
import path from "node:path"
import { attempt, type Attempt } from "./agent.js"
import { Git } from "./git.js"
import { plain } from "./plain.js"
import { Store, type NodeState } from "./store.js"
import { introduction, parse, update } from "./team.js"
import type {
  AgentOptions,
  AgentResult,
  Budget,
  CheckOptions,
  CheckResult,
  Context,
  ErrorClass,
  GateDecision,
  MergeResult,
  TeamMessage,
  TeamOptions,
  TeamResult,
  VerifyOptions,
  VerifyResult,
  Workflow,
} from "./workflow.js"

export interface RunOptions {
  /** The server agents run on; not needed to replay. */
  readonly client?: OrbitClient
  readonly workflow: Workflow
  /** The workflow file, recorded so `orb flow resume` can load it again. */
  readonly file: string
  readonly directory: string
  /**
   * Whether the folder is trusted. The VCS applies the config a repository ships (`core.fsmonitor`, clean filters, hooks)
   * to the commands it runs there, so in a folder that is not trusted the run starts no such process and works as it does
   * outside a repository: no worktrees, commits, merges, base commit (a base kept in the run store is ignored too, so no
   * review diff) or dirty check. The run store is found from the files. A resume there takes no folder and no session ID
   * from the store either: the checks and the reviewer of a reused verify iteration work in the run's folder, and a team
   * member whose turn is reused opens a new session for its next one. The commands refuse to resume or replay in such a
   * folder anyway; this holds for a caller that does not.
   */
  readonly trusted: boolean
  /**
   * The project of `directory` as the server resolved it, whose folders the trust decision covers. In a trusted folder git
   * looks for the repository no further up than the project's folder, and the run uses it only when its work tree, git
   * directory and common directory are all inside these folders or `directory` (`Git.root`). Without it git looks only
   * in `directory` itself.
   */
  readonly project?: Git.Project
  readonly input?: Readonly<Record<string, unknown>>
  /** Resume this run: completed nodes whose inputs are unchanged return their recorded result. */
  readonly resume?: string
  /** Replay this run as a new one from its recorded results: no model calls, worktrees or merges. */
  readonly replay?: string
  /** Default permission policy for agents that do not set one. */
  readonly permissions?: "reject" | "auto"
  /** Model (provider/model) for agents that do not set one; kept for resume. */
  readonly model?: string
  /** Overrides the workflow's budget, and on resume the budget the run was started with. */
  readonly budget?: Budget
  readonly log?: (line: string) => void
}

export interface RunResult {
  readonly id: string
  readonly status: "succeeded" | "failed" | "waiting"
  readonly output?: unknown
  readonly error?: string
  /** Gates waiting for a decision when the run paused. */
  readonly waiting?: ReadonlyArray<{ readonly gate: string; readonly message: string }>
  /** Set on a replay: whether the output matched the recording, and nodes whose inputs no longer did. */
  readonly replay?: {
    readonly source: string
    readonly identical: boolean
    readonly divergences: ReadonlyArray<string>
  }
}

export class NodeFailure extends Error {
  constructor(
    readonly node: string,
    readonly failure: { readonly class: ErrorClass; readonly message: string },
  ) {
    super(`${node} failed (${failure.class}): ${failure.message}`)
  }
}

// Unwinds the workflow when it reaches a gate without a decision; the run then waits instead of failing.
class Paused extends Error {}

const BUDGET_GATE = "budget"

// What the agent of an `auto` node is told when managed settings turned the mode off.
const MANAGED =
  "Skipping permission prompts is turned off by your organization's managed settings, so this request was rejected."

const REJECTED =
  "This workflow runs unattended and does not approve actions that need permission. Continue without this action, or explain what you would need."

export async function run(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => {})
  const found: { readonly root?: string; readonly outside?: string } = options.trusted
    ? await Git.root(options.directory, options.project)
    : {}
  // The repository git would use keeps its config or hooks in a folder that the decision does not cover: the run works as
  // it does in a folder that is not trusted.
  if (found.outside !== undefined) log(`! git is not used: ${found.outside} is outside the trusted folder`)
  const repository = found.root
  // Whether git may run here: the folder is trusted, and so is every folder of the repository that git uses.
  const versioned = options.trusted && found.outside === undefined
  const home = repository ?? Git.holder(options.directory) ?? path.resolve(options.directory)
  if (repository) await Git.exclude(repository)
  const store = Store.at(home)
  // The title stays in the user's session database and is shown by `orb session list` and the terminal UI, which set it
  // as the title of the window. The workflow's name and the node IDs are text from a file that a clone brings along.
  const title = (node: string) => plain(`${options.workflow.name} · ${node}`)
  const previous = options.resume ? store.run(options.resume) : undefined
  if (options.resume && !previous) throw new Error(`No run ${options.resume} in ${home}`)
  const source = options.replay ? store.run(options.replay) : undefined
  if (options.replay && !source) throw new Error(`No run ${options.replay} in ${home}`)
  const id =
    previous?.id ?? `run_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${crypto.randomUUID().slice(0, 6)}`
  const input = previous?.input ?? source?.input ?? options.input ?? {}
  // Worktrees branch from the commit the run started at, so a resumed node starts from the same code.
  // A replay creates no worktrees, so it has no base.
  // A stored base is used only where git may run: the store is a file that a clone ships, and the review diff would
  // start git in the folder the store names.
  const base =
    source || !repository
      ? undefined
      : previous
        ? (store.events(id).find((event) => event.type === "run.started")?.data.base as string | undefined)
        : await Git.head(repository)
  // A resume keeps the budget and default model the run was started (or last resumed) with unless it sets new ones.
  const setting = (key: "budget" | "model") =>
    store
      .events(id)
      .findLast((event) => (event.type === "run.started" || event.type === "run.resumed") && event.data[key])?.data[key]
  const budget = options.budget ?? (setting("budget") as Budget | undefined) ?? options.workflow.budget
  const defaultModel = options.model ?? (setting("model") as string | undefined)
  const settings = { ...(budget ? { budget } : {}), ...(defaultModel ? { model: defaultModel } : {}) }
  if (previous) store.status(id, "running", settings)
  else
    store.create(
      { id, workflow: options.workflow.name, file: options.file, directory: home, input },
      { base, ...settings, ...(source ? { replay: source.id } : {}) },
    )
  const recorded = previous ? store.nodes(id) : source ? store.nodes(source.id) : new Map<string, NodeState>()
  const divergences: string[] = []
  const client = () => {
    if (!options.client) throw new Error("This run needs a connection to the Orbit server")
    return options.client
  }

  // In a replay every node returns what the recording holds for it. A node the recording lacks means the workflow
  // took another path, which a replay cannot follow; changed inputs are reported, and the recorded result still used.
  const fromRecording = (node: string, key?: string) => {
    const done = recorded.get(node)
    if (!done || (done.status !== "succeeded" && done.status !== "failed"))
      throw new Error(`Replay diverged: ${node} is not in the recording of ${source?.id}`)
    if (key !== undefined && done.key !== key) {
      divergences.push(node)
      log(`~ ${node}: its inputs differ from the recording`)
    }
    store.append(id, node, done.status === "succeeded" ? "node.succeeded" : "node.failed", {
      key: done.key,
      result: done.result,
      ...(done.error ? { error: done.error } : {}),
      replay: true,
    })
    log(`= ${node} (replayed${done.status === "failed" ? ", failed" : ""})`)
    return done
  }
  const used = new Set<string>()
  const policies = new Map<string, Policy>()
  // Managed settings can turn bypass off. It is read once per run, so an `auto` policy anywhere in it (a node, a team
  // member, the run's default) is downgraded here and nowhere else.
  const bypass = options.client && !source ? await bypassAllowed(options.client, options.directory) : true
  const policy = (wanted: "reject" | "auto"): Policy => (wanted === "auto" && !bypass ? "managed" : wanted)
  const listener = new AbortController()
  if (options.client && !source) void answerPermissions(options.client, policies, listener.signal)
  log(`${source ? `replaying ${source.id} as` : previous ? "resuming" : "started"} ${id}`)
  const changed = repository && !source ? await Git.dirty(repository) : []
  if (changed.length > 0)
    log(
      `! uncommitted changes in ${changed.join(", ")}: agents in worktrees start from the last commit without them, and merging into the checkout fails until they are committed or stashed`,
    )

  const gate = async (node: string, message: string, claimed = true): Promise<GateDecision> => {
    if (claimed) claim(used, node)
    const done = recorded.get(node)
    if (source && !done) throw new Error(`Replay diverged: ${node} is not in the recording of ${source.id}`)
    if (done?.status === "succeeded") {
      store.append(id, node, "node.reused", { result: done.result })
      return done.result as unknown as GateDecision
    }
    if (done?.status !== "waiting") {
      store.append(id, node, "gate.pending", { message })
      recorded.set(node, { id: node, status: "waiting", message, attempts: 0, started: Date.now() })
    }
    log(`? ${node}: ${message}`)
    throw new Paused(node)
  }

  // Spend is read from the log, so it includes attempts from earlier executions of a resumed run.
  let lifted = false
  const checkBudget = async () => {
    if (!budget || lifted) return
    const spent = store
      .spend(id)
      .reduce((total, item) => ({ cost: total.cost + item.cost, tokens: total.tokens + item.input + item.output }), {
        cost: 0,
        tokens: 0,
      })
    const over =
      (budget.maxCost !== undefined && spent.cost >= budget.maxCost) ||
      (budget.maxTokens !== undefined && spent.tokens >= budget.maxTokens)
    if (!over) return
    // One budget gate per run: approving it lifts the budget for the rest of the run.
    const decision = await gate(
      BUDGET_GATE,
      `Budget reached: spent $${spent.cost.toFixed(4)} and ${spent.tokens} tokens of ${[
        budget.maxCost !== undefined ? `$${budget.maxCost}` : undefined,
        budget.maxTokens !== undefined ? `${budget.maxTokens} tokens` : undefined,
      ]
        .filter(Boolean)
        .join(" and ")}. Approve to continue without a budget.`,
      false,
    )
    if (!decision.approved)
      throw new Error(`Budget exceeded and continuing was rejected${decision.note ? `: ${decision.note}` : ""}`)
    lifted = true
  }

  // `within.worktree` shares another node's worktree (a verify loop's iterations); `within.directory` runs the agent in
  // a directory without committing there (a reviewer reading a worktree).
  const agent = async (
    node: string,
    requested: AgentOptions,
    within: { readonly worktree?: string; readonly directory?: string } = {},
  ): Promise<AgentResult> => {
    claim(used, node)
    const agentOptions = { ...requested, model: requested.model ?? defaultModel }
    const worktree = within.directory === undefined && (agentOptions.worktree ?? repository !== undefined)
    if (worktree && !source && (!repository || !base))
      throw new Error(
        `${node}: worktree agents need a git repository with a commit${versioned ? "" : " in a trusted folder"}`,
      )
    const key = hash({
      prompt: agentOptions.prompt,
      model: agentOptions.model,
      agent: agentOptions.agent,
      worktree,
      fallback: agentOptions.retry?.fallbackModels,
      within,
    })
    if (source) {
      const replayed = fromRecording(node, key)
      if (replayed.status === "succeeded" || agentOptions.onError === "continue")
        return { ...(replayed.result as unknown as AgentResult), reused: true }
      throw new NodeFailure(node, replayed.error as unknown as { class: ErrorClass; message: string })
    }
    const done = recorded.get(node)
    if (done?.status === "succeeded" && done.key === key) {
      store.append(id, node, "node.reused", { key, result: done.result })
      log(`= ${node} (recorded)`)
      return { ...(done.result as unknown as AgentResult), reused: true }
    }
    store.append(id, node, "node.started", { key })
    log(`> ${node}`)
    const place =
      worktree && repository && base ? await Git.worktree(repository, id, within.worktree ?? node, base) : undefined
    const directory = place?.directory ?? within.directory ?? home
    const retry = agentOptions.retry ?? {}
    const retryOn = new Set<ErrorClass>(retry.retryOn ?? ["rate-limit", "transient", "timeout"])
    const maxAttempts = Math.max(1, retry.maxAttempts ?? 2)
    const models = [agentOptions.model, ...(retry.fallbackModels ?? [])]
    const sessions: string[] = []
    const usage = { cost: 0, input: 0, output: 0 }
    let attempts = 0
    let failure: { class: ErrorClass; message: string } = { class: "unknown", message: "not run" }

    for (const model of models) {
      // A model that keeps failing for every run in this repository is skipped for a minute, in favour of fallbacks.
      if (model && store.breaker(model)) {
        failure = { class: "transient", message: `${model} failed 3 times in the last minute; skipped` }
        store.append(id, node, "attempt.skipped", { model, reason: "breaker" })
        log(`! ${node}: skipping ${model}, which failed 3 times in the last minute`)
        continue
      }
      for (let count = 1; count <= maxAttempts; count++) {
        await checkBudget()
        attempts++
        store.append(id, node, "attempt.started", { attempt: attempts, model })
        const result = await attempt(client(), {
          directory,
          title: title(node),
          prompt: agentOptions.prompt,
          model,
          agent: agentOptions.agent,
          timeout: agentOptions.timeout,
          started: (session) => {
            sessions.push(session)
            policies.set(session, policy(agentOptions.permissions ?? options.permissions ?? "reject"))
          },
        }).catch(
          (error: unknown): Attempt => ({
            session: "",
            text: "",
            usage: {},
            error: { class: "unknown" as const, message: error instanceof Error ? error.message : String(error) },
          }),
        )
        store.append(id, node, "attempt.ended", {
          attempt: attempts,
          model: model ?? "default",
          cost: result.usage.cost ?? 0,
          input: result.usage.input ?? 0,
          output: result.usage.output ?? 0,
          ...(result.error ? { error: result.error } : {}),
        })
        usage.cost += result.usage.cost ?? 0
        usage.input += result.usage.input ?? 0
        usage.output += result.usage.output ?? 0
        if (!result.error) {
          // The message of a commit is text from the file as well, and `git log` prints it as it is.
          const changed = place ? await Git.commit(place.directory, `orbit ${id}: ${plain(node)}`) : false
          const value: AgentResult = {
            id: node,
            status: "succeeded",
            text: result.text,
            model,
            ...(place ? { branch: place.branch, worktree: place.directory } : {}),
            sessions,
            attempts,
            usage,
          }
          store.append(id, node, "node.succeeded", { key, result: value, changed })
          log(`✓ ${node}${model ? ` (${model})` : ""}`)
          return value
        }
        failure = result.error
        store.append(id, node, "attempt.failed", { attempt: attempts, model, error: result.error })
        log(`! ${node} attempt ${attempts}: ${result.error.class}: ${result.error.message}`)
        if (!retryOn.has(result.error.class) || count === maxAttempts) break
        await Bun.sleep(backoff(retry.backoff, count))
      }
      // An action the user's rules refused would be refused for any model.
      if (failure.class === "permission") break
    }

    const value: AgentResult = {
      id: node,
      status: "failed",
      text: "",
      ...(place ? { branch: place.branch, worktree: place.directory } : {}),
      sessions,
      attempts,
      usage,
      error: failure,
    }
    store.append(id, node, "node.failed", { key, error: failure, result: value })
    log(`✗ ${node}: ${failure.message}`)
    if (agentOptions.onError === "continue") return value
    throw new NodeFailure(node, failure)
  }

  const check = async (node: string, checkOptions: CheckOptions): Promise<CheckResult> => {
    claim(used, node)
    if (source) return fromRecording(node).result as unknown as CheckResult
    store.append(id, node, "node.started", { command: checkOptions.command })
    // On a resume `in` can be a result reused from the run store, a file a clone ships, so its worktree is a folder the
    // store names. Only a repository in a trusted folder has worktrees; anywhere else the check runs where the run does.
    const directory = (repository ? checkOptions.in?.worktree : undefined) ?? home
    const result = await shell(checkOptions.command, directory, checkOptions.timeout)
    store.append(
      id,
      node,
      result.ok ? "node.succeeded" : "node.failed",
      result.ok ? { result } : { result, error: { class: "invalid", message: `exit ${result.code ?? "timeout"}` } },
    )
    log(
      `${result.ok ? "✓" : "✗"} ${node}: ${checkOptions.command} (${result.code === null ? "timed out" : `exit ${result.code}`})`,
    )
    return result
  }

  const verify = async (node: string, verifyOptions: VerifyOptions): Promise<VerifyResult> => {
    claim(used, node)
    const maxIterations = Math.max(1, verifyOptions.maxIterations ?? 3)
    const judge = verifyOptions.judge === true ? {} : verifyOptions.judge || undefined
    const commands = (verifyOptions.checks ?? []).map((item) => (typeof item === "string" ? { command: item } : item))
    const author = { ...verifyOptions, onError: "continue" as const }
    store.append(id, node, "node.started", {})
    const usage = { cost: 0, input: 0, output: 0 }
    const add = (result: AgentResult) => {
      usage.cost += result.usage?.cost ?? 0
      usage.input += result.usage?.input ?? 0
      usage.output += result.usage?.output ?? 0
    }

    const iterate = async (iteration: number, feedback?: string): Promise<VerifyResult> => {
      const work = await agent(
        `${node}#${iteration}`,
        {
          ...author,
          prompt: feedback
            ? `${verifyOptions.prompt}\n\nYour previous attempt did not pass verification. Your earlier changes are already in the working directory; fix these problems:\n\n${feedback}`
            : verifyOptions.prompt,
        },
        { worktree: node },
      )
      add(work)
      if (work.status === "failed")
        return { ...work, id: node, usage, verified: false, iterations: iteration, checks: [] }
      const checks: CheckResult[] = []
      for (const [index, item] of commands.entries()) {
        const result = await check(`${node}#${iteration}.check${index + 1}`, { ...item, in: work })
        checks.push(result)
        if (!result.ok) break
      }
      const failed = checks.filter((result) => !result.ok)
      const review =
        failed.length === 0 && judge
          ? await agent(
              `${node}#${iteration}.judge`,
              {
                model: judge.model ?? author.model,
                agent: judge.agent,
                permissions: "reject",
                onError: "continue",
                prompt: await reviewPrompt(verifyOptions.prompt, judge.criteria, work, base),
              },
              // As for a check: a reused iteration's worktree comes from the run store.
              { directory: (repository ? work.worktree : undefined) ?? home },
            )
          : undefined
      if (review) add(review)
      const approved = !review || (review.status === "succeeded" && /^\W*APPROVED\b/i.test(review.text.trim()))
      const passed = failed.length === 0 && approved
      const result: VerifyResult = {
        ...work,
        id: node,
        usage,
        verified: passed,
        iterations: iteration,
        checks,
        ...(review ? { review: review.text } : {}),
      }
      if (passed) return result
      const problems = [
        ...failed.map(
          (item) => `$ ${item.command} (${item.code === null ? "timed out" : `exit ${item.code}`})\n${item.output}`,
        ),
        ...(review && !approved ? [`A reviewer did not approve:\n${review.text || review.error?.message || ""}`] : []),
      ].join("\n\n")
      log(`! ${node} iteration ${iteration} not verified`)
      if (iteration >= maxIterations) return result
      return iterate(iteration + 1, problems)
    }

    const result = await iterate(1)
    if (result.verified) {
      store.append(id, node, "node.succeeded", { result })
      log(`✓ ${node} verified in ${result.iterations} iteration(s)`)
      return result
    }
    const error = result.error ?? {
      class: "invalid" as const,
      message: `not verified after ${result.iterations} iteration(s)`,
    }
    const value: VerifyResult = { ...result, status: "failed", error }
    store.append(id, node, "node.failed", { error, result: value })
    log(`✗ ${node}: ${error.message}`)
    if (verifyOptions.onError === "continue") return value
    throw new NodeFailure(node, error)
  }

  // One member's turn in a team: a prompt to the member's session (a new one on the first turn), recorded like an
  // attempt so a resumed run reuses it.
  const turn = async (
    node: string,
    input: {
      readonly prompt: string
      readonly directory: string
      readonly model?: string
      readonly agent?: string
      readonly session?: string
      readonly permissions: "reject" | "auto"
      readonly timeout?: number
    },
  ): Promise<Attempt & { readonly reused?: boolean }> => {
    claim(used, node)
    const key = hash({ ...input, permissions: undefined })
    if (source) return fromRecording(node, key).result as unknown as Attempt
    const done = recorded.get(node)
    if (done?.status === "succeeded" && done.key === key) {
      store.append(id, node, "node.reused", { key, result: done.result })
      log(`= ${node} (recorded)`)
      return { ...(done.result as unknown as Attempt), reused: true }
    }
    store.append(id, node, "node.started", { key })
    log(`> ${node}`)
    await checkBudget()
    store.append(id, node, "attempt.started", { attempt: 1, model: input.model })
    const result = await attempt(client(), {
      directory: input.directory,
      title: title(node),
      prompt: input.prompt,
      model: input.model,
      agent: input.agent,
      session: input.session,
      timeout: input.timeout,
      started: (session) => policies.set(session, policy(input.permissions)),
    }).catch(
      (error: unknown): Attempt => ({
        session: input.session ?? "",
        text: "",
        usage: {},
        error: { class: "unknown" as const, message: error instanceof Error ? error.message : String(error) },
      }),
    )
    store.append(id, node, "attempt.ended", {
      attempt: 1,
      model: input.model ?? "default",
      cost: result.usage.cost ?? 0,
      input: result.usage.input ?? 0,
      output: result.usage.output ?? 0,
      ...(result.error ? { error: result.error } : {}),
    })
    if (result.error) {
      store.append(id, node, "node.failed", { key, error: result.error, result })
      log(`✗ ${node}: ${result.error.message}`)
      return result
    }
    store.append(id, node, "node.succeeded", { key, result })
    log(`✓ ${node}`)
    return result
  }

  const team = async (node: string, teamOptions: TeamOptions): Promise<TeamResult> => {
    claim(used, node)
    const names = Object.keys(teamOptions.members)
    const lead = teamOptions.lead ?? names[0]
    if (!lead || !teamOptions.members[lead])
      throw new Error(`${node}: the team needs members, and its lead must be one`)
    const worktree = teamOptions.worktree ?? repository !== undefined
    if (worktree && !source && (!repository || !base))
      throw new Error(
        `${node}: a team in a worktree needs a git repository with a commit${versioned ? "" : " in a trusted folder"}`,
      )
    const place = worktree && repository && base && !source ? await Git.worktree(repository, id, node, base) : undefined
    const directory = place?.directory ?? home
    store.append(id, node, "node.started", { members: names, lead })
    log(`> ${node} (team: ${names.map((name) => (name === lead ? `${name} (lead)` : name)).join(", ")})`)

    const sessions = new Map<string, string>()
    const inbox = new Map(names.map((name) => [name, [] as TeamMessage[]]))
    const board: Record<string, string> = {}
    const messages: TeamMessage[] = []
    const usage = { cost: 0, input: 0, output: 0 }
    const state = {
      turns: 0,
      rounds: 0,
      summary: undefined as string | undefined,
      failure: undefined as Attempt["error"],
    }

    // A member's turn: its first turn introduces the team; later ones bring what arrived since. Returns whether the
    // lead finished.
    const take = async (name: string, nudge?: string) => {
      state.turns++
      const member = teamOptions.members[name]
      const pending = inbox.get(name) ?? []
      inbox.set(name, [])
      const session = sessions.get(name)
      const result = await turn(`${node}/${name}#${state.turns}`, {
        prompt: [
          ...(session ? [] : [introduction({ name, goal: teamOptions.goal, members: teamOptions.members, lead })]),
          ...(session || pending.length > 0 || Object.keys(board).length > 0 ? [update(pending, board)] : []),
          ...(nudge ? [nudge] : []),
        ].join("\n\n"),
        directory,
        model: session ? undefined : (member.model ?? defaultModel),
        agent: session ? undefined : member.agent,
        session,
        permissions: member.permissions ?? options.permissions ?? "reject",
        timeout: teamOptions.timeout,
      })
      usage.cost += result.usage.cost ?? 0
      usage.input += result.usage.input ?? 0
      usage.output += result.usage.output ?? 0
      if (result.error) {
        state.failure = result.error
        return false
      }
      // A reused turn's session ID comes from the run store, so in a folder that is not trusted the member's next turn
      // opens a session of its own instead of prompting the one the store names.
      if (options.trusted || !result.reused) sessions.set(name, result.session)
      const reply = parse(result.text)
      for (const note of reply.notes) {
        board[note.key] = note.text
        store.append(id, node, "team.note", { from: name, ...note })
      }
      for (const message of reply.messages) {
        const to = message.to.toLowerCase() === "all" ? "all" : names.find((item) => item === message.to)
        if (!to) {
          inbox.get(name)?.push({
            from: "orbit",
            to: name,
            text: `Your message to "${message.to}" was not delivered: there is no such member. Members: ${names.join(", ")}.`,
          })
          continue
        }
        const delivered = { from: name, to, text: message.text }
        messages.push(delivered)
        store.append(id, node, "team.message", delivered)
        log(`  ${name} → ${to}: ${message.text.replace(/\s+/g, " ").slice(0, 100)}`)
        for (const recipient of to === "all" ? names.filter((item) => item !== name) : [to])
          inbox.get(recipient)?.push(delivered)
      }
      if (name === lead && reply.done !== undefined) state.summary = reply.done
      return state.summary !== undefined
    }

    const play = async (round: number, nudged: boolean): Promise<void> => {
      if (round > (teamOptions.maxRounds ?? 8)) return
      state.rounds = round
      const waiting = names.filter((name) => (inbox.get(name)?.length ?? 0) > 0)
      // When nobody has anything to act on, the lead gets one chance to finish or hand out more work.
      if (round > 1 && waiting.length === 0 && nudged) return
      const active = round === 1 ? [lead] : waiting.length > 0 ? waiting : [lead]
      const nudge =
        round > 1 && waiting.length === 0
          ? "Nobody on the team has anything pending. If the goal is met, finish with <done>summary</done>; otherwise assign the remaining work."
          : undefined
      for (const name of active) {
        const finished = await take(name, name === lead ? nudge : undefined)
        if (finished || state.failure) return
      }
      return play(round + 1, waiting.length === 0 && round > 1)
    }
    await play(1, false)

    const changed = place && !source ? await Git.commit(place.directory, `orbit ${id}: ${plain(node)}`) : false
    const done = state.summary !== undefined
    const error =
      state.failure ??
      (done
        ? undefined
        : {
            class: "invalid" as const,
            message:
              state.rounds >= (teamOptions.maxRounds ?? 8)
                ? `the lead did not finish within ${teamOptions.maxRounds ?? 8} rounds`
                : "the team stopped: nobody had anything pending and the lead did not finish",
          })
    const value: TeamResult = {
      id: node,
      status: error ? "failed" : "succeeded",
      text: state.summary ?? "",
      model: teamOptions.members[lead].model ?? defaultModel,
      ...(place ? { branch: place.branch, worktree: place.directory } : {}),
      sessions: [...sessions.values()],
      attempts: state.turns,
      usage,
      done,
      summary: state.summary ?? "",
      rounds: state.rounds,
      turns: state.turns,
      messages,
      board,
      ...(error ? { error } : {}),
    }
    if (!error) {
      store.append(id, node, "node.succeeded", { result: value, changed })
      log(`✓ ${node}: ${value.summary.replace(/\s+/g, " ").slice(0, 100)}`)
      return value
    }
    store.append(id, node, "node.failed", { error, result: value })
    log(`✗ ${node}: ${error.message}`)
    if (teamOptions.onError === "continue") return value
    throw new NodeFailure(node, error)
  }

  const merge = async (node: string, results: ReadonlyArray<AgentResult>): Promise<MergeResult> => {
    claim(used, node)
    if (source) {
      const replayed = fromRecording(node)
      if (replayed.status === "failed") throw new Error(`${node}: ${String(replayed.error?.message ?? "failed")}`)
      return replayed.result as unknown as MergeResult
    }
    if (!repository)
      throw new Error(`${node}: merging needs a git repository${versioned ? "" : " in a trusted folder"}`)
    const branches = results.flatMap((result) =>
      result.status === "succeeded" && result.branch ? [result.branch] : [],
    )
    const key = hash({ branches })
    const done = recorded.get(node)
    if (done?.status === "succeeded" && done.key === key) {
      store.append(id, node, "node.reused", { key, result: done.result })
      return done.result as unknown as MergeResult
    }
    store.append(id, node, "node.started", { key })
    const blocking = await Git.dirty(repository)
    if (blocking.length > 0) {
      const message = `your checkout has uncommitted changes in ${blocking.join(", ")}. Commit or stash them, then run \`orb flow resume ${id}\`; finished agents are not run again.`
      store.append(id, node, "node.failed", { key, error: { class: "invalid", message } })
      throw new Error(`${node}: ${message}`)
    }
    const merged: string[] = []
    for (const name of branches) {
      const outcome = await Git.merge(repository, name, `orbit ${id}: merge ${name}`)
      if (!outcome.merged && outcome.blocked.length > 0) {
        const message = `merging ${name} would overwrite ${outcome.blocked.join(", ")} in your checkout. Move, delete or commit them, then run \`orb flow resume ${id}\`; finished agents are not run again.`
        store.append(id, node, "node.failed", { key, error: { class: "invalid", message } })
        throw new Error(`${node}: ${message}`)
      }
      if (!outcome.merged) {
        const value: MergeResult = {
          id: node,
          status: "conflict",
          merged,
          conflict: { branch: name, files: outcome.files },
        }
        store.append(id, node, "node.succeeded", { key, result: value })
        log(`! ${node}: ${name} conflicts in ${outcome.files.join(", ")}`)
        return value
      }
      merged.push(name)
    }
    const value: MergeResult = { id: node, status: "merged", merged }
    store.append(id, node, "node.succeeded", { key, result: value })
    log(`✓ ${node}: merged ${merged.length} branch(es)`)
    return value
  }

  const ctx: Context = {
    input,
    run: { id, directory: home },
    merge,
    gate: (node, gateOptions) => gate(node, gateOptions.message),
    check,
    verify,
    team,
    agent: (node, agentOptions) => agent(node, agentOptions),
    parallel: (tasks, parallelOptions) => pool(tasks, parallelOptions?.concurrency ?? 4),
    map: (items, fn, mapOptions) =>
      pool(
        items.map((item, index) => () => fn(item, index)),
        mapOptions?.concurrency ?? 4,
      ),
    log: (message) => {
      store.append(id, null, "log", { message })
      log(message)
    },
  }

  try {
    const output = await options.workflow.run(ctx)
    store.status(id, "succeeded", { output: output ?? null })
    log(`succeeded ${id}`)
    if (!source) return { id, status: "succeeded", output }
    const expected = store.events(source.id).findLast((event) => event.type === "run.succeeded")?.data.output
    const identical = JSON.stringify(output ?? null) === JSON.stringify(expected ?? null)
    log(
      identical
        ? `replay matches the recorded output of ${source.id}`
        : `replay output differs from the recorded output of ${source.id}`,
    )
    return { id, status: "succeeded", output, replay: { source: source.id, identical, divergences } }
  } catch (error) {
    if (error instanceof Paused) {
      const waiting = [...store.nodes(id).values()].flatMap((node) =>
        node.status === "waiting" ? [{ gate: node.id, message: node.message ?? "" }] : [],
      )
      store.status(id, "waiting", { waiting })
      log(`waiting ${id}: ${waiting.map((item) => item.gate).join(", ")}`)
      return { id, status: "waiting", waiting }
    }
    const message = error instanceof Error ? error.message : String(error)
    store.status(id, "failed", { error: message })
    log(`failed ${id}: ${message}`)
    return { id, status: "failed", error: message }
  } finally {
    listener.abort()
    store.close()
  }
}

/**
 * The run store for `directory`: the one at its repository root, or in the directory itself outside a repository. The
 * root is found from the files, so that reading a store starts no git in a folder that is not trusted.
 */
export async function openStore(directory: string) {
  return Store.at(Git.holder(directory) ?? path.resolve(directory))
}

// A reviewer gets the task and the diff in its prompt, so it needs no tools and cannot change the work it judges.
async function reviewPrompt(task: string, criteria: string | undefined, work: AgentResult, base: string | undefined) {
  const changes = work.worktree && base ? await Git.diff(work.worktree, base) : ""
  return [
    "Review a change another agent made for this task. Do not edit any files.",
    `Task:\n${task}`,
    ...(criteria ? [`Also check:\n${criteria}`] : []),
    changes ? `The change:\n\`\`\`diff\n${changes}\n\`\`\`` : `The agent's summary:\n${work.text}`,
    "If the change does the task correctly and completely, start your reply with APPROVED. Otherwise list each problem to fix, briefly and specifically, and do not write APPROVED.",
  ].join("\n\n")
}

/** Run a command through the platform shell; output is the last 4000 characters of stdout and stderr together. */
async function shell(command: string, directory: string, timeout = 600_000) {
  const child = Bun.spawn(process.platform === "win32" ? ["cmd", "/d", "/s", "/c", command] : ["sh", "-c", command], {
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const output = `${stdout}${stderr}`.trim()
  const stopped = child.signalCode !== null && child.killed
  return {
    command,
    ok: code === 0 && !stopped,
    code: stopped ? null : code,
    output: output.length > 4000 ? `…${output.slice(-4000)}` : output,
  }
}

function claim(used: Set<string>, node: string) {
  if (used.has(node)) throw new Error(`Node id ${node} is used twice in this run; node ids must be unique`)
  used.add(node)
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function backoff(options: { initial?: number; factor?: number; max?: number } | undefined, attempt: number) {
  const initial = options?.initial ?? 1000
  return Math.min(options?.max ?? 30_000, initial * (options?.factor ?? 2) ** (attempt - 1))
}

async function pool<T>(tasks: ReadonlyArray<() => Promise<T>>, concurrency: number) {
  const results: T[] = new Array(tasks.length)
  const errors: unknown[] = []
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++
      // Let every task settle before failing, so a failure never leaves siblings running unrecorded.
      await tasks[index]().then(
        (value) => void (results[index] = value),
        (error: unknown) => void errors.push(error),
      )
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker))
  // A real failure outranks a sibling that paused at a gate.
  if (errors.length > 0) throw errors.find((error) => !(error instanceof Paused)) ?? errors[0]
  return results
}

// `managed` is an `auto` policy that managed settings turned into a rejection with its own feedback.
type Policy = "reject" | "auto" | "managed"

// Whether the server's managed settings leave the mode that approves every ask open. A server that cannot say, or does
// not report it, counts as closed: a run then rejects what an `auto` node asks for instead of approving it.
async function bypassAllowed(client: OrbitClient, directory: string) {
  const effective = await client.config.effective({ location: { directory } }).catch(() => undefined)
  return effective?.permissions?.bypass === true
}

// The run answers permission requests for its own sessions and their subagents, by the node's policy.
async function answerPermissions(client: OrbitClient, policies: Map<string, Policy>, signal: AbortSignal) {
  const owner = async (session: string, depth = 0): Promise<Policy | undefined> => {
    const known = policies.get(session)
    if (known || depth > 8) return known
    const info = await client.session.get({ sessionID: session }).catch(() => undefined)
    return info?.parentID ? owner(info.parentID, depth + 1) : undefined
  }
  for await (const event of client.event.subscribe({ signal })) {
    if (event.type !== "permission.asked") continue
    const policy = await owner(event.data.sessionID)
    if (!policy) continue
    await client.permission
      .reply({
        sessionID: event.data.sessionID,
        requestID: event.data.id,
        decision: policy === "auto" ? "once" : "reject",
        ...(policy === "reject" ? { message: REJECTED } : policy === "managed" ? { message: MANAGED } : {}),
      })
      .catch(() => undefined)
  }
}
