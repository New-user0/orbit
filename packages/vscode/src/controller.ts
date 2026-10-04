import type { OrbitClient, OrbitEvent, SessionMessageInfo } from "@orbit/client"
import type { FileChange, FormRequest, Item, Mode, Model, Todo, WorkflowAgent } from "./protocol.js"

export type Update =
  | { readonly type: "item"; readonly item: Item }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "plan"; readonly todos: ReadonlyArray<Todo> }
  | { readonly type: "form"; readonly form: FormRequest }

/**
 * One chat in one workspace folder, driven entirely through the Orbit server API. It turns the server's event stream
 * into chat items and knows nothing about VS Code, so it runs the same in tests.
 */
export class Controller {
  private session: string | undefined
  private model: Model | undefined
  private agent: Mode = "build"
  private readonly started = new Map<string, number>()
  private readonly items = new Map<string, Item>()
  private readonly owned = new Map<string, Promise<boolean>>()
  private readonly abort = new AbortController()

  constructor(
    private readonly client: OrbitClient,
    private readonly directory: string,
    private readonly emit: (update: Update) => void,
  ) {
    void this.listen()
  }

  /** Models available in this folder, for the picker. */
  async models(): Promise<ReadonlyArray<Model>> {
    const list = await this.client.model.list({ location: { directory: this.directory } })
    return list.data.map((item) => ({ providerID: item.providerID, id: item.id, name: item.name }))
  }

  /** The model for the next prompt; applied to the current session too. */
  async select(model: Model) {
    this.model = model
    if (this.session)
      await this.client.session.switchModel({
        sessionID: this.session,
        model: { providerID: model.providerID, id: model.id },
      })
  }

  /** Build edits and runs; Plan only reads. Applied to the current session too. */
  async mode(agent: Mode) {
    this.agent = agent
    if (this.session) await this.client.session.switchAgent({ sessionID: this.session, agent })
  }

  /** Sets the global output style; null returns to the default. */
  async outputStyle(style: string | null) {
    await this.client.config.update({ output_style: style })
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
        const plan = part.name === "todo" ? todos(input?.todos) : todos(metadata?.todos)
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

  async send(text: string) {
    const sessionID = this.session ?? (await this.create())
    this.update({ type: "user", id: `user:${crypto.randomUUID()}`, text })
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

  /** Start over: the next prompt opens a new session. */
  reset() {
    this.session = undefined
    this.items.clear()
    this.owned.clear()
    this.started.clear()
  }

  dispose() {
    this.abort.abort()
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
      // The server restarted or the connection dropped: reconnect after a short pause.
      if (!done) this.emit({ type: "busy", busy: false })
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private async consume() {
    for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
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

  private handle(event: OrbitEvent) {
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
        const plan = current.name === "todo" ? todos(event.data.input.todos) : undefined
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
        const plan = current.name.startsWith("task_") ? todos(event.data.metadata?.todos) : undefined
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
        this.update({
          type: "permission",
          id: event.data.id,
          sessionID: event.data.sessionID,
          action: event.data.action,
          resources: event.data.resources,
          files: changes(event.data.metadata),
          status: "pending",
        })
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
        this.update({ type: "note", id: `error:${event.id}`, text: event.data.error.message, tone: "error" })
        return
      case "session.execution.failed":
        if (event.data.sessionID === this.session) {
          this.update({ type: "note", id: `error:${event.id}`, text: event.data.error.message, tone: "error" })
          this.emit({ type: "busy", busy: false })
        }
        return
      case "session.execution.interrupted":
        if (event.data.sessionID !== this.session) return
        this.update({ type: "note", id: `stopped:${event.id}`, text: "Stopped.", tone: "muted" })
        this.emit({ type: "busy", busy: false })
        return
      case "session.execution.succeeded":
        if (event.data.sessionID === this.session) this.emit({ type: "busy", busy: false })
        return
    }
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
