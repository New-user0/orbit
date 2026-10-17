import {
  ClientError,
  type OrbitClient,
  type OrbitEvent,
  type SessionMessageInfo,
  type TrustStatus,
} from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import { PermissionView } from "@orbit/schema/permission-view"
import type { FileChange, FormRequest, Item, Mode, Model, Todo, TrustView, WorkflowAgent } from "./protocol.js"
import { aboveFolders, holdsBack, readStatus, trusted, view, type TrustGrant } from "./trust.js"
import { legacyToolName } from "./tool-name.js"

export type Update =
  | { readonly type: "item"; readonly item: Item }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "plan"; readonly todos: ReadonlyArray<Todo> }
  | { readonly type: "form"; readonly form: FormRequest }
  /** The folder is untrusted and holds something back (`trust`), or is not. `unchecked`: the server cannot say. */
  | { readonly type: "trust"; readonly trust: TrustView | undefined; readonly unchecked: boolean }
  /** One line for the log: a trust read that failed and left the last answer standing. */
  | { readonly type: "log"; readonly text: string }

/** What the person answered when asked whether to trust the folder: "later" is "Not now", and so is closing the question. */
export type TrustAnswer = "trust" | "later"

/** How long the extension waits on the server for trust before it carries on without an answer. */
export const limits = { read: 2_000, grant: 10_000 }

/**
 * One chat in one workspace folder, driven entirely through the Orbit server API. It turns the server's event stream
 * into chat items and knows nothing about VS Code, so it runs the same in tests.
 *
 * Whether the folder is trusted is the server's to say. The chat asks the server before it starts any work, shows what
 * the answer holds back, and asks the person once, through `ask`, whether to trust the folder. The folder is one value
 * from the first read to the work: the server names the project's root in its answer, that root is what the question
 * shows and what a grant is made for, and the work happens in the folder VS Code opened, which the server maps to the
 * same project. `limits` is the time each wait on the server may take.
 */
export class Controller {
  private session: string | undefined
  private model: Model | undefined
  private agent: Mode = "build"
  private readonly started = new Map<string, number>()
  private readonly items = new Map<string, Item>()
  // A failed step waits here: a later step of the same run usually recovers from it, and then it is not shown.
  private held: { readonly id: string; readonly text: string } | undefined
  private readonly owned = new Map<string, Promise<boolean>>()
  private readonly abort = new AbortController()
  // The last trust answer. A read that fails leaves it as it was, because a dropped connection says nothing about trust.
  private status: TrustStatus | undefined
  // The server has no trust routes: it is older than workspace trust.
  private unchecked = false
  // Some trust read has been answered, with a status or with a 404. Until then nothing is known about the server, and a
  // slow 404 from an old server looks the same as no answer, so no call that boots the folder's location goes out.
  private answered = false
  // The number of the newest read that was applied, so that a slow answer never replaces a newer one.
  private reads = 0
  private applied = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  // Folders (the server's, by name) that the person answered "not now" for, until this chat is closed.
  private readonly dismissed = new Set<string>()
  private deciding: Promise<TrustGrant | undefined> | undefined
  // The first trust read. A call that boots the folder's location waits for it: on a server older than workspace trust
  // that boot imports the folder's plugins, so it must not go out before the server is known to be new enough.
  private readonly first: Promise<unknown>

  constructor(
    private readonly client: OrbitClient,
    private readonly directory: string,
    private readonly emit: (update: Update) => void,
    private readonly ask: (trust: TrustView) => Promise<TrustAnswer>,
    private readonly wait = limits,
  ) {
    void this.listen()
    this.first = this.read()
  }

  /** Models available in this folder, for the picker. */
  async models(): Promise<ReadonlyArray<Model>> {
    if (!(await this.usable())) return []
    const list = await this.client.model.list({ location: { directory: this.directory } })
    return list.data.map((item) => ({ providerID: item.providerID, id: item.id, name: item.name }))
  }

  /** The model for the next prompt; applied to the current session too. */
  async select(model: Model) {
    this.model = model
    if (this.session && (await this.usable()))
      await this.client.session.switchModel({
        sessionID: this.session,
        model: { providerID: model.providerID, id: model.id },
      })
  }

  /** Build edits and runs; Plan only reads. Applied to the current session too. */
  async mode(agent: Mode) {
    this.agent = agent
    if (this.session && (await this.usable())) await this.client.session.switchAgent({ sessionID: this.session, agent })
  }

  /**
   * Sets the global output style; null returns to the default. The call names no folder, so the server answers it in its
   * own working folder, which an old server would boot: it is made only once the server is known to be new enough.
   * Returns false when it was not made.
   */
  async outputStyle(style: string | null) {
    if (!(await this.usable())) return false
    await this.client.config.update({ output_style: style })
    return true
  }

  /** This folder's sessions, newest first, for the history picker. */
  async sessions() {
    const list = await this.client.session.list({ directory: this.directory, order: "desc", limit: 30 })
    return list.data.filter((session) => !session.parentID)
  }

  /** Continue an earlier session: its transcript is replayed into the chat and the next prompt goes to it. */
  async open(sessionID: string) {
    this.reset()
    this.session = sessionID
    this.owned.set(sessionID, Promise.resolve(true))
    const session = await this.client.session.get({ sessionID })
    if (session.title) this.emit({ type: "title", title: session.title })
    if (session.agent === "build" || session.agent === "plan") this.agent = session.agent
    for (const message of await this.history(sessionID)) {
      if (message.type === "user") this.update({ type: "user", id: `user:${message.id}`, text: message.text })
      if (message.type === "synthetic") {
        const notice = loopNotice(message.metadata, message.description)
        if (notice) this.update({ type: "note", id: `notice:${message.id}`, text: notice, tone: "muted" })
      }
      if (message.type !== "assistant") continue
      message.content.forEach((part, index) => {
        if (part.type === "text") this.update({ type: "text", id: `text:${message.id}:${index}`, text: part.text })
        if (part.type === "reasoning")
          this.update({
            type: "reasoning",
            id: `reasoning:${message.id}:${index}`,
            text: part.text,
            seconds: part.time?.completed ? Math.round((part.time.completed - part.time.created) / 1000) : undefined,
          })
        if (part.type !== "tool") return
        const state = part.state
        // A call still streaming its input has only the raw text so far.
        const input = typeof state.input === "string" ? undefined : state.input
        const metadata = "metadata" in state ? state.metadata : undefined
        // The task tools report the whole task list in their result metadata.
        const plan = legacyToolName(part.name) === "todo" ? todos(input?.todos) : todos(metadata?.todos)
        if (plan) this.emit({ type: "plan", todos: plan })
        this.update({
          type: "tool",
          id: `tool:${part.id}`,
          name: part.name,
          status: state.status === "completed" ? "completed" : state.status === "error" ? "error" : "running",
          input,
          output:
            "content" in state && state.content
              ? state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
              : undefined,
          error: state.status === "error" ? state.error.message : undefined,
          files: changes(metadata),
          exit: typeof metadata?.exit === "number" ? metadata.exit : undefined,
          agents: agents(metadata?.agents),
        })
      })
    }
    return this.agent
  }

  // Every message of a session, oldest first, a page at a time.
  private async history(sessionID: string, cursor?: string): Promise<SessionMessageInfo[]> {
    // A cursor already carries the order of the page it came from.
    const page = await this.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) })
    if (!page.cursor.next || page.data.length < 200) return page.data
    return [...page.data, ...(await this.history(sessionID, page.cursor.next))]
  }

  /**
   * Sends a prompt. Every command, starter and button that starts work in the chat ends here, so the question about
   * trusting the folder is asked here, before a session exists and before the model is asked anything.
   */
  async send(text: string, context?: string, shown?: string) {
    await this.gate()
    // A server older than workspace trust applies the folder's hooks and servers without asking, and one that has not
    // answered may be such a server, so nothing is sent to either.
    if (this.unchecked || !this.answered)
      return this.update({
        type: "note",
        id: `trust:${crypto.randomUUID()}`,
        text: this.unchecked
          ? "This server is older than workspace trust and cannot say whether the folder is trusted, so the message was not sent. Run `orb service restart`, then send it again: " +
            JSON.stringify(text)
          : "The server's trust could not be reached, so the message was not sent. Send it again in a moment: " +
            JSON.stringify(text),
        tone: "error",
      })
    const sessionID = this.session ?? (await this.create())
    // The editor context goes first, with no description so no client draws it, and without resuming so the prompt
    // below starts the work. One that cannot be admitted, or not soon enough, costs only itself.
    if (context !== undefined)
      await this.client.session
        .synthetic(
          { sessionID, text: context, resume: false, delivery: "steer", metadata: { context: "editor" } },
          { signal: AbortSignal.timeout(this.wait.read) },
        )
        .catch((error: unknown) =>
          this.emit({ type: "log", text: `Editor context was not sent: ${message(error)}` }),
        )
    this.update({ type: "user", id: `user:${crypto.randomUUID()}`, text, context: shown })
    this.emit({ type: "busy", busy: true })
    await this.client.session.prompt({ sessionID, text, delivery: "steer" }).catch((error: unknown) => {
      this.emit({ type: "busy", busy: false })
      this.update({ type: "note", id: `error:${crypto.randomUUID()}`, text: message(error), tone: "error" })
    })
  }

  async stop() {
    if (this.session) await this.client.session.interrupt({ sessionID: this.session }).catch(() => undefined)
  }

  async reply(id: string, decision: "once" | "always" | "reject") {
    const item = this.items.get(id)
    if (item?.type !== "permission" || item.status !== "pending") return
    await this.client.permission.reply({ sessionID: item.sessionID, requestID: item.id, decision })
    this.update({ ...item, status: decision })
  }

  /** Answers a form, or dismisses it when there is no answer. */
  async answer(form: FormRequest, answer: Record<string, string | boolean | number | string[]> | undefined) {
    const target = { sessionID: form.sessionID, formID: form.id }
    if (answer) await this.client.session.form.reply({ ...target, answer }).catch(() => undefined)
    else await this.client.session.form.cancel(target).catch(() => undefined)
  }

  permission(id: string) {
    const item = this.items.get(id)
    return item?.type === "permission" ? item : undefined
  }

  /**
   * Asks the person whether to trust the folder, even if they said "not now" before, and does what they answer. Nothing
   * is asked when the server says the folder is trusted or holds nothing back. Fails when the grant does.
   */
  review() {
    return this.decision(true)
  }

  /** Start over: the next prompt opens a new session. */
  reset() {
    this.held = undefined
    this.session = undefined
    this.items.clear()
    this.owned.clear()
    this.started.clear()
  }

  dispose() {
    clearTimeout(this.timer)
    this.abort.abort()
  }

  // Whether a call that boots the folder's location may go out: the server has answered a trust read, and it is new enough
  // to have trust routes. While nothing has answered, the read is made again.
  private async usable() {
    await this.first
    if (!this.answered) await this.read()
    return this.answered && !this.unchecked
  }

  // Asks about trust before the first work in a folder that holds something back and that the person has not said "not
  // now" to. The question is asked once however many prompts arrive meanwhile, and a grant that fails is reported in the
  // chat: the prompt is not lost, it goes on without what the folder holds back, as it does after "not now".
  private async gate() {
    const grant = await this.decision(false).catch((error: unknown) => {
      this.update({
        type: "note",
        id: `trust:${crypto.randomUUID()}`,
        text: `Could not trust the folder: ${message(error)} This chat goes on without what the folder holds back.`,
        tone: "error",
      })
      return undefined
    })
    if (grant) this.update({ type: "note", id: `trust:${crypto.randomUUID()}`, text: trusted(grant), tone: "muted" })
  }

  private decision(forced: boolean) {
    this.deciding ??= this.decide(forced).finally(() => (this.deciding = undefined))
    return this.deciding
  }

  private async decide(forced: boolean) {
    // Asked of the server now, not of the last answer: someone may have trusted the folder, or ended its trust, with
    // `orb trust` since.
    const status = await this.read()
    if (!status || !holdsBack(status) || (!forced && this.dismissed.has(status.directory))) return undefined
    if ((await this.ask(view(status, this.directory))) === "later") {
      this.dismissed.add(status.directory)
      return undefined
    }
    return this.grant(status)
  }

  // Trusts the folder that was shown, which is the project's root as the server named it. The server grants for the
  // project of the location it is given, so the location is that root, and the answer has to name the same folder.
  // Then the folder this chat works in is asked about again: both answers must say trusted, and the stricter one stands.
  private async grant(shown: TrustStatus): Promise<TrustGrant> {
    const granted = await this.client.location.trust.update(
      // A grant that is stored stays stored when it is renewed after a change; one that lasts until Orbit restarts, too.
      { location: { directory: shown.directory }, trust: true, persist: shown.trusted ? shown.source === "saved" : shown.persistent },
      { signal: AbortSignal.timeout(this.wait.grant) },
    )
    // Folder names are the repository's to choose, so they are written out wherever a person reads them.
    const confirmed = readStatus(granted)
    if (!confirmed?.trusted || confirmed.directory !== shown.directory)
      throw new Error(`The server did not trust ${plain(shown.directory)}.`)
    // Not accepted yet: the banner stays until the opened folder itself is confirmed.
    const working = await this.read(true)
    if (!working?.trusted || working.directory !== shown.directory)
      throw new Error(
        `The server trusted ${plain(shown.directory)} but does not report ${plain(this.directory)} as trusted.`,
      )
    return { directory: plain(confirmed.directory), persistent: confirmed.persistent, above: aboveFolders(confirmed) }
  }

  // Asks the server whether the folder VS Code opened is trusted, and returns the answer that stands afterwards. The
  // read is bounded, and a server that fails, answers late or sends something that is not a trust status leaves the last
  // answer in place and costs one line in the log. A server older than workspace trust has no such route, which is
  // reported apart, because it applies a folder's config without asking.
  private async read(confirm = false) {
    const attempt = ++this.reads
    const answer = await this.client.location.trust
      .get({ location: { directory: this.directory } }, { signal: AbortSignal.timeout(this.wait.read) })
      .then(
        (status: unknown) => ({ status }),
        (error: unknown) => ({ error }),
      )
    if ("error" in answer) {
      if (!unsupported(answer.error))
        return this.fail(`could not read workspace trust: ${message(answer.error)}`, confirm)
      this.answered = true
      if (attempt > this.applied) {
        this.applied = attempt
        this.unchecked = true
        this.status = undefined
        this.publish()
      }
      return this.status
    }
    const status = readStatus(answer.status)
    if (!status) return this.fail("could not read workspace trust: the answer is not a trust status", confirm)
    this.accept(status, attempt)
    return this.status
  }

  // A confirming read that fails confirms nothing, so it answers nothing instead of the last answer.
  private fail(text: string, confirm: boolean) {
    this.emit({ type: "log", text })
    return confirm ? undefined : this.status
  }

  private accept(status: TrustStatus, attempt: number) {
    this.answered = true
    if (attempt < this.applied) return
    this.applied = attempt
    this.unchecked = false
    this.status = status
    this.publish()
  }

  private publish() {
    this.emit({
      type: "trust",
      trust: this.status && holdsBack(this.status) ? view(this.status, this.directory) : undefined,
      unchecked: this.unchecked,
    })
  }

  // A grant or a revoke, a reload of the config and a reconnect all change the answer, and they send several events at
  // once, which should come to one read.
  private schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.read(), 150)
  }

  private async create() {
    const session = await this.client.session.create({
      location: { directory: this.directory },
      agent: this.agent,
      ...(this.model ? { model: { providerID: this.model.providerID, id: this.model.id } } : {}),
    })
    this.session = session.id
    this.owned.set(session.id, Promise.resolve(true))
    return session.id
  }

  // The stream carries every session on the server, including the TUI's, so keep only this chat's session and the
  // subagent sessions it spawned.
  private belongs(sessionID: string): Promise<boolean> {
    const known = this.owned.get(sessionID)
    if (known) return known
    if (!this.session) return Promise.resolve(false)
    const result = this.client.session
      .get({ sessionID })
      .then((session) => (session.parentID ? this.belongs(session.parentID) : false))
      .catch(() => false)
    this.owned.set(sessionID, result)
    return result
  }

  private async listen() {
    while (!this.abort.signal.aborted) {
      const done = await this.consume().then(
        () => true,
        () => false,
      )
      if (this.abort.signal.aborted) return
      // The stream ended or dropped, so the terminal event of the run may have fallen in the gap: a failure held for it is stale.
      this.held = undefined
      // The server restarted or the connection dropped: reconnect after a short pause.
      if (!done) {
        this.emit({ type: "busy", busy: false })
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private async consume() {
    for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
      // The answer about trust changes with a grant, here or from `orb trust`, with the files that hold things back, and
      // when the connection is made again.
      if (event.type === "trust.updated" || event.type === "config.updated" || event.type === "server.connected") {
        this.schedule()
        continue
      }
      if (!("data" in event) || typeof event.data !== "object" || event.data === null) continue
      const sessionID =
        event.type === "form.created"
          ? event.data.form.sessionID
          : "sessionID" in event.data
            ? String(event.data.sessionID)
            : undefined
      if (!sessionID || !(await this.belongs(sessionID))) continue
      // Subagents' own work stays in their sessions, as it does for the model; their permission requests and
      // questions still need an answer here.
      if (sessionID !== this.session && !event.type.startsWith("permission.") && event.type !== "form.created") continue
      this.handle(event)
    }
  }

  /** @internal Folds one event into the chat; the stream calls it, and tests do. */
  handle(event: OrbitEvent) {
    switch (event.type) {
      case "session.renamed":
        if (event.data.sessionID === this.session) this.emit({ type: "title", title: event.data.title })
        return
      case "session.reasoning.started":
        this.started.set(`${event.data.assistantMessageID}:${event.data.ordinal}`, event.created)
        return
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning"
        const id = `${kind}:${event.data.assistantMessageID}:${event.data.ordinal}`
        const current = this.items.get(id)
        this.update({ type: kind, id, text: (current && "text" in current ? current.text : "") + event.data.delta })
        return
      }
      case "session.text.ended":
        this.update({
          type: "text",
          id: `text:${event.data.assistantMessageID}:${event.data.ordinal}`,
          text: event.data.text,
        })
        return
      case "session.reasoning.ended": {
        const started = this.started.get(`${event.data.assistantMessageID}:${event.data.ordinal}`)
        this.update({
          type: "reasoning",
          id: `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`,
          text: event.data.text,
          seconds: started === undefined ? undefined : Math.round((event.created - started) / 1000),
        })
        return
      }
      case "session.tool.input.started":
        this.update({ type: "tool", id: `tool:${event.data.id}`, name: event.data.name, status: "running" })
        return
      case "session.tool.called": {
        const current = this.tool(event.data.id)
        const plan = legacyToolName(current.name) === "todo" ? todos(event.data.input.todos) : undefined
        if (plan) this.emit({ type: "plan", todos: plan })
        this.update({ ...current, input: event.data.input })
        return
      }
      case "session.tool.progress": {
        const current = this.tool(event.data.id)
        const list = agents(event.data.metadata.agents)
        if (list) this.update({ ...current, agents: list })
        return
      }
      case "session.tool.success": {
        const current = this.tool(event.data.id)
        const plan = legacyToolName(current.name).startsWith("task_") ? todos(event.data.metadata?.todos) : undefined
        if (plan) this.emit({ type: "plan", todos: plan })
        const output = event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        const exit = event.data.metadata?.exit
        this.update({
          ...current,
          status: "completed",
          output,
          files: changes(event.data.metadata),
          exit: typeof exit === "number" ? exit : undefined,
          agents: agents(event.data.metadata?.agents) ?? current.agents,
        })
        return
      }
      case "session.tool.failed": {
        const current = this.tool(event.data.id)
        this.update({ ...current, status: "error", error: event.data.error.message })
        return
      }
      case "permission.asked":
        this.update(permissionItem(event.data))
        return
      case "form.created":
        this.emit({
          type: "form",
          form: {
            id: event.data.form.id,
            sessionID: event.data.form.sessionID,
            title: event.data.form.title,
            fields: event.data.form.fields,
          },
        })
        return
      case "permission.replied": {
        const current = this.items.get(event.data.requestID)
        if (current?.type === "permission") this.update({ ...current, status: event.data.reply })
        return
      }
      case "session.step.failed":
        this.held = { id: `error:${event.id}`, text: event.data.error.message }
        return
      case "session.step.started":
        this.held = undefined
        return
      case "session.synthetic": {
        const notice = loopNotice(event.data.metadata, event.data.description)
        if (notice) this.update({ type: "note", id: `notice:${event.id}`, text: notice, tone: "muted" })
        return
      }
      case "session.execution.failed":
        if (event.data.sessionID === this.session) {
          // What ended the run replaces the failure of a step that was held back.
          this.held = undefined
          this.update({ type: "note", id: `error:${event.id}`, text: event.data.error.message, tone: "error" })
          this.emit({ type: "busy", busy: false })
        }
        return
      case "session.execution.interrupted":
        if (event.data.sessionID !== this.session) return
        // A stop the person asked for does not report the failure of the step it cut short, as `orb run` does.
        if (event.data.reason === "user") this.held = undefined
        else this.release()
        this.update({ type: "note", id: `stopped:${event.id}`, text: "Stopped.", tone: "muted" })
        this.emit({ type: "busy", busy: false })
        return
      case "session.execution.succeeded":
        if (event.data.sessionID !== this.session) return
        this.release()
        this.emit({ type: "busy", busy: false })
        return
    }
  }

  // The run ended with a step failure nothing recovered from: show it.
  private release() {
    if (!this.held) return
    this.update({ type: "note", id: this.held.id, text: this.held.text, tone: "error" })
    this.held = undefined
  }

  private tool(id: string): Extract<Item, { type: "tool" }> {
    const current = this.items.get(`tool:${id}`)
    return current?.type === "tool" ? current : { type: "tool", id: `tool:${id}`, name: "tool", status: "running" }
  }

  private update(item: Item) {
    this.items.set(item.id, item)
    this.emit({ type: "item", item })
  }
}

// What the runner says about its own loop (today the restart notice; a model fallback, a stop hook or a plan exit appear as those features land). The text comes from the runner
// and the model, so it is escaped as `plain` does before it reaches the chat; one without a description says nothing.
function loopNotice(metadata: Readonly<Record<string, unknown>> | undefined, description: string | undefined) {
  if (typeof metadata?.notice !== "string" || description === undefined) return undefined
  return plain(description) || undefined
}

/** The chat item for a permission request: every place, file, method, URL and diff it shows is the request's own. */
export function permissionItem(request: {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly save?: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>>
}): Extract<Item, { type: "permission" }> {
  return {
    type: "permission",
    id: request.id,
    sessionID: request.sessionID,
    action: request.action,
    resources: request.resources,
    view: PermissionView.of(request),
    canSave: (request.save?.length ?? 0) > 0,
    files: changes(request.metadata),
    status: "pending",
  }
}

function changes(metadata: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<FileChange> {
  const files = metadata?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((file: unknown) =>
    typeof file === "object" && file !== null && "file" in file && "patch" in file ? [file as FileChange] : [],
  )
}

// A workflow's agents from its progress metadata; malformed entries are dropped.
function agents(value: unknown): ReadonlyArray<WorkflowAgent> | undefined {
  if (!Array.isArray(value)) return undefined
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : undefined)
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = entry as Record<string, unknown>
    const status = item.status
    if (typeof item.sessionID !== "string" || typeof item.description !== "string" || typeof item.agent !== "string")
      return []
    if (status !== "running" && status !== "completed" && status !== "failed") return []
    return [
      {
        sessionID: item.sessionID,
        description: item.description,
        agent: item.agent,
        status,
        phase: typeof item.phase === "string" && item.phase ? item.phase : undefined,
        model: typeof item.model === "string" ? item.model : undefined,
        started: number(item.started),
        ended: number(item.ended),
        tokens: number(item.tokens),
      },
    ]
  })
}

// The todo tool's input as the model sent it; malformed entries are dropped.
function todos(value: unknown): ReadonlyArray<Todo> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    "content" in item &&
    typeof item.content === "string" &&
    "status" in item &&
    (item.status === "pending" || item.status === "in_progress" || item.status === "completed")
      ? [{ content: item.content, status: item.status }]
      : [],
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// A server older than workspace trust has no trust route, and answers 404.
function unsupported(error: unknown) {
  return (
    error instanceof ClientError &&
    error.reason === "UnexpectedStatus" &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "status" in error.cause &&
    error.cause.status === 404
  )
}
