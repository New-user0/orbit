import type {
  Check,
  FileChange,
  FromView,
  Item,
  Mode,
  Model,
  Todo,
  ToView,
  TrustView,
  WorkflowAgent,
  Workspace,
} from "../protocol.js"
import { agentsOf, describe, duration, excerpt, phases, segments, tokens } from "./present.js"
import { legacyToolName } from "../tool-name.js"

// Runs inside the webview. Every string from the model or the server is set as text, never parsed as HTML.
declare function acquireVsCodeApi(): { postMessage(message: FromView): void }

const vscode = acquireVsCodeApi()
const SPIN = ["◜", "◝", "◞", "◟"]

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const state = {
  busy: false,
  mode: "build" as Mode,
  models: [] as ReadonlyArray<Model>,
  model: "",
  workspace: { folder: "" } as Workspace,
  chip: true,
  checks: [] as ReadonlyArray<Check>,
  status: "",
  tick: 0,
  started: false,
}

const app = document.getElementById("app") ?? document.body
// Shown above the conversation while the folder is untrusted and holds something back.
const banner = element("div", "trust")
banner.hidden = true
const scroll = element("div", "scroll")
const column = element("div", "column")
scroll.append(column)
const empty = element("div", "empty")
const busy = element("div", "busy")
column.append(empty)

const menu = element("div", "menu")
menu.hidden = true
const map = element("div", "menu map")
map.hidden = true
const composer = element("div", "composer")
const input = element("textarea", "input")
input.rows = 2
const bar = element("div", "bar")
const chip = element("span", "chip")
const agentsChip = element("button", "pick agents")
agentsChip.type = "button"
agentsChip.title = "Agent map"
const modeButton = element("button", "pick")
modeButton.type = "button"
const modelButton = element("button", "pick")
modelButton.type = "button"
const sendButton = element("button", "round primary", "↑")
sendButton.type = "button"
sendButton.title = "Send"
const stopButton = element("button", "round", "■")
stopButton.type = "button"
stopButton.title = "Stop"
bar.append(chip, element("span", "spacer"), agentsChip, modeButton, modelButton, sendButton, stopButton)
composer.append(input, bar)
app.append(banner, scroll, menu, map, composer)

const nodes = new Map<string, HTMLElement>()
const items = new Map<string, Item>()
const open = new Set<string>()
const folded = new Set<string>()
let plan: HTMLElement | undefined

function submit() {
  const text = input.value.trim()
  if (!text) return
  vscode.postMessage({ type: "send", text, selection: chipVisible() })
  input.value = ""
  state.chip = false
  state.started = true
  paint()
}

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
})
sendButton.addEventListener("click", submit)
stopButton.addEventListener("click", () => vscode.postMessage({ type: "stop" }))
modeButton.addEventListener("click", () =>
  vscode.postMessage({ type: "mode", mode: state.mode === "build" ? "plan" : "build" }),
)
modelButton.addEventListener("click", () => {
  menu.hidden = !menu.hidden
  paintMenu()
})
agentsChip.addEventListener("click", () => {
  map.hidden = !map.hidden
  menu.hidden = true
  if (!map.hidden) paintMap()
})
document.addEventListener("click", (event) => {
  const target = event.target as Node
  if (!menu.hidden && !menu.contains(target) && target !== modelButton) menu.hidden = true
  if (!map.hidden && !map.contains(target) && !agentsChip.contains(target)) map.hidden = true
})

window.addEventListener("message", (event: MessageEvent<ToView>) => {
  const message = event.data
  switch (message.type) {
    case "reset":
      nodes.clear()
      items.clear()
      open.clear()
      folded.clear()
      map.hidden = true
      plan = undefined
      state.started = false
      state.chip = true
      column.replaceChildren(empty)
      return paint()
    case "busy":
      state.busy = message.busy
      return paint()
    case "status":
      state.status = message.text
      return paint()
    case "setup":
      state.checks = message.checks
      return paint()
    case "workspace": {
      const before = state.workspace.selection
      const after = message.workspace.selection
      // A new selection brings the chip back after it was dismissed.
      if (
        after &&
        (before?.file !== after.file || before.startLine !== after.startLine || before.endLine !== after.endLine)
      )
        state.chip = true
      state.workspace = message.workspace
      return paint()
    }
    case "mode":
      state.mode = message.mode
      return paint()
    case "trust":
      return paintTrust(message.trust)
    case "title":
      return
    case "models":
      state.models = message.models
      state.model = message.selected ?? ""
      return paint()
    case "plan":
      return renderPlan(message.todos)
    case "item":
      return render(message.item)
  }
})

setInterval(() => {
  if (!state.busy) return
  state.tick++
  // Running workflows show elapsed seconds; redraw them about once a second.
  if (state.tick % 7 === 0)
    items.forEach((item) => {
      if (item.type === "tool" && legacyToolName(item.name) === "workflow" && item.status === "running") replace(item)
    })
  if (state.tick % 7 === 0 && !map.hidden) paintMap()
  const spinner = busy.querySelector(".spin")
  if (spinner) spinner.textContent = SPIN[state.tick % SPIN.length]
  document.querySelectorAll(".tool.running .glyph, .todo.in_progress .glyph").forEach((node) => {
    node.textContent = SPIN[state.tick % SPIN.length]
  })
}, 150)

function render(item: Item) {
  state.started = true
  empty.remove()
  // The plan has its own card, kept where the first plan update appeared.
  if (item.type === "tool" && legacyToolName(item.name) === "todo") {
    if (!plan) {
      plan = element("div", "plan")
      column.append(plan)
    }
    return paint()
  }
  items.set(item.id, item)
  const next = build(item)
  const current = nodes.get(item.id)
  if (current) current.replaceWith(next)
  else column.append(next)
  nodes.set(item.id, next)
  paint()
  if (!map.hidden) paintMap()
  scroll.scrollTop = scroll.scrollHeight
}

function renderPlan(todos: ReadonlyArray<Todo>) {
  if (!plan) {
    plan = element("div", "plan")
    empty.remove()
    column.append(plan)
  }
  const done = todos.filter((todo) => todo.status === "completed").length
  const head = element("div", "plan-head")
  head.append(element("span", "grow", "To-dos"), element("span", undefined, `${done} of ${todos.length}`))
  const progress = element("div", "progress")
  const fill = element("div", "fill")
  fill.style.width = `${todos.length === 0 ? 0 : Math.round((done / todos.length) * 100)}%`
  progress.append(fill)
  plan.replaceChildren(
    head,
    progress,
    ...todos.map((todo) => {
      const row = element("div", `todo ${todo.status}`)
      const glyph = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? SPIN[state.tick % 4] : "○"
      row.append(element("span", "glyph", glyph), element("span", undefined, todo.content))
      return row
    }),
  )
}

function build(item: Item): HTMLElement {
  switch (item.type) {
    case "user":
      return element("div", "user", item.text)
    case "text":
      return markdown(item.text)
    case "note":
      return element("div", `note ${item.tone}`, item.text)
    case "reasoning": {
      const node = element("div", "think")
      const label = item.seconds === undefined ? "Thinking…" : `Thought for ${Math.max(1, item.seconds)}s`
      const toggle = element("div", "toggle", `${open.has(item.id) ? "▾" : "▸"} ${label}`)
      toggle.addEventListener("click", () => flip(item))
      node.append(toggle)
      if (open.has(item.id)) node.append(element("div", "think-body", item.text.trim()))
      return node
    }
    case "tool":
      return legacyToolName(item.name) === "workflow" ? workflow(item) : tool(item)
    case "permission":
      return permission(item)
  }
}

function replace(item: Item) {
  const current = nodes.get(item.id)
  if (!current) return
  const next = build(item)
  current.replaceWith(next)
  nodes.set(item.id, next)
}

// A workflow's agents grouped by phase, each phase with its progress and an agent table.
function workflow(item: Extract<Item, { type: "tool" }>) {
  const agents = item.agents ?? []
  const node = element("div", `workflow ${item.status}`)
  const head = element("div", "wf-head")
  const glyph = item.status === "running" ? SPIN[state.tick % 4] : item.status === "completed" ? "✓" : "✕"
  const description = typeof item.input?.description === "string" ? item.input.description : "Workflow"
  const total = tokens(agents)
  head.append(
    element("span", "glyph", glyph),
    element("span", "verb", "Workflow"),
    element("span", "target", description),
    element(
      "span",
      "meta",
      [
        `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        total > 0 ? `${compact(total)} tokens` : undefined,
        agents.length > 0 ? duration(agents, Date.now()) : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  )
  node.append(head)
  for (const phase of phases(agents)) {
    const key = `${item.id}:${phase.name}`
    const done = phase.agents.filter((agent) => agent.status === "completed").length
    const shut = folded.has(key) || (phase.agents.every((agent) => agent.status !== "running") && !open.has(key))
    if (phase.name) {
      const header = element("div", "phase")
      const dots = element("span", "dots")
      phase.agents.forEach((agent) => dots.append(element("span", `dot ${agent.status}`)))
      header.append(element("span", "grow", phase.name), element("span", "muted", `${done}/${phase.agents.length}`))
      const title = element("div", "phase-title")
      title.append(header, dots)
      title.addEventListener("click", () => {
        if (shut) {
          folded.delete(key)
          open.add(key)
        } else {
          open.delete(key)
          folded.add(key)
        }
        replace(item)
      })
      node.append(title)
    }
    if (phase.name && shut) continue
    const table = element("div", "agents")
    table.append(...["", "Agent", "Model", "Tokens", "Time"].map((label) => element("span", "th", label)))
    phase.agents.forEach((agent) => table.append(...agentRow(agent)))
    node.append(table)
  }
  return node
}

function agentRow(agent: WorkflowAgent) {
  const glyph = agent.status === "running" ? SPIN[state.tick % 4] : agent.status === "completed" ? "●" : "✕"
  return [
    element("span", `glyph ${agent.status}`, glyph),
    element("span", "name", agent.description),
    element("span", "muted", agent.model ?? agent.agent),
    element("span", "muted num", agent.tokens === undefined ? "" : compact(agent.tokens)),
    element("span", "muted num", agent.started === undefined ? "" : duration([agent], Date.now())),
  ]
}

// Every agent this chat started, from its workflows and subagent calls, as a tree under the chat.
function paintMap() {
  const list = agentsOf([...items.values()])
  const running = list.filter((agent) => agent.status === "running").length
  const head = element("div", "map-head")
  head.append(element("span", "strong grow", "Agent map"), element("span", "muted", `${list.length} agents`))
  const root = element("div", "map-root")
  root.append(element("span", `dot ${running > 0 ? "running" : "completed"}`), element("span", "strong", "This chat"))
  const rows = list.map((agent, index) => {
    const row = element("div", "map-row")
    row.append(
      element("span", "branch", index === list.length - 1 ? "└" : "├"),
      element("span", `dot ${agent.status}`),
      element("span", "grow", `${agent.phase ? `${agent.phase} · ` : ""}${agent.description}`),
      element(
        "span",
        "muted",
        [
          agent.started === undefined ? undefined : duration([agent], Date.now()),
          agent.tokens === undefined ? undefined : `${compact(agent.tokens)} tokens`,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    )
    return row
  })
  map.replaceChildren(head, root, ...rows)
}

function compact(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function tool(item: Extract<Item, { type: "tool" }>) {
  const shown = describe(item, state.workspace.folder)
  const node = element("div", `tool ${item.status}`)
  const row = element("div", "row")
  const glyph = item.status === "running" ? SPIN[state.tick % 4] : item.status === "completed" ? "✓" : "✕"
  row.append(
    element("span", "glyph", glyph),
    element("span", "verb", shown.verb),
    element("span", "target", shown.target),
  )
  if (shown.add) row.append(element("span", "add", shown.add))
  if (shown.del) row.append(element("span", "del", shown.del))
  if (shown.meta) row.append(element("span", shown.failed ? "meta failed" : "meta", shown.meta))
  row.addEventListener("click", () => flip(item))
  node.append(row)
  if (open.has(item.id)) {
    const body = item.error ?? (item.files?.length ? item.files.map((file) => file.patch).join("\n") : item.output)
    if (body) node.append(element("pre", "out", body.trim()))
  }
  return node
}

function permission(item: Extract<Item, { type: "permission" }>) {
  const files = item.files
  const title =
    files.length > 0
      ? `${verb(item.action)} ${files.map((file) => basename(file.file)).join(", ")}`
      : `${verb(item.action)} ${item.resources.join(", ")}`
  if (item.status !== "pending") {
    const label = { once: "Allowed", always: "Always allowed", reject: "Rejected" }[item.status]
    return element("div", item.status === "reject" ? "note error" : "note muted", `${label} · ${title}`)
  }
  const card = element("div", "permission")
  const head = element("div", "perm-head")
  head.append(element("span", "grow strong", title))
  const totals = sum(files)
  if (totals.additions) head.append(element("span", "add", `+${totals.additions}`))
  if (totals.deletions) head.append(element("span", "del", `−${totals.deletions}`))
  card.append(head)
  const lines = files.flatMap((file) => excerpt(file.patch, 6))
  if (lines.length > 0) {
    const diff = element("div", "mini-diff")
    lines.forEach((line) => diff.append(element("div", line.kind, `${line.kind === "add" ? "+" : "−"} ${line.text}`)))
    card.append(diff)
  }
  if (files.length === 0 && item.resources.length > 0)
    card.append(element("pre", "resources", item.resources.join("\n")))
  const actions = element("div", "actions")
  const reply = (decision: "once" | "always" | "reject") => () =>
    vscode.postMessage({ type: "permission", id: item.id, decision })
  actions.append(
    button("Allow", reply("once"), "primary"),
    button("Always allow", reply("always")),
    button("Reject", reply("reject")),
    element("span", "spacer"),
  )
  if (files.length > 0) {
    const link = element("a", "link", "Open diff ↗")
    link.addEventListener("click", () => vscode.postMessage({ type: "diff", id: item.id }))
    actions.append(link)
  }
  card.append(actions)
  return card
}

function flip(item: Item) {
  if (open.has(item.id)) open.delete(item.id)
  else open.add(item.id)
  replace(item)
}

// Paragraphs, fenced code and inline `code` and **bold**; nothing else from the model is interpreted.
function markdown(text: string) {
  const node = element("div", "text")
  text.split(/```[^\n]*\n?/).forEach((chunk, index) => {
    if (index % 2 === 1) return void node.append(element("pre", "code-block", chunk.replace(/\n$/, "")))
    chunk
      .split(/\n{2,}/)
      .filter((paragraph) => paragraph.trim())
      .forEach((paragraph) => {
        const block = element("p")
        segments(paragraph).forEach((segment) =>
          block.append(
            segment.kind === "code"
              ? element("code", undefined, segment.text)
              : segment.kind === "strong"
                ? element("strong", undefined, segment.text)
                : document.createTextNode(segment.text),
          ),
        )
        node.append(block)
      })
  })
  return node
}

function paint() {
  const thread = state.started || nodes.size > 0
  if (!thread) paintEmpty()
  const running = [...nodes.keys()].length > 0 && state.busy
  if (running) {
    busy.replaceChildren(element("span", "spin", SPIN[state.tick % 4]), element("span", undefined, "Working…"))
    column.append(busy)
  } else busy.remove()
  input.placeholder = !thread
    ? "Ask Orbit to read, change or run anything…"
    : state.busy
      ? "Queue a message"
      : "Ask a follow-up"
  const visible = chipVisible()
  chip.hidden = !visible
  if (visible && state.workspace.selection) {
    const selection = state.workspace.selection
    const close = element("span", "close", "×")
    close.addEventListener("click", () => {
      state.chip = false
      paint()
    })
    chip.replaceChildren(
      element("span", undefined, "⌗"),
      element("span", "chip-text", `${basename(selection.file)}:${selection.startLine}-${selection.endLine}`),
      close,
    )
    chip.title = `The selection in ${selection.file} goes with your next message`
  }
  const agents = agentsOf([...items.values()])
  const working = agents.filter((agent) => agent.status === "running").length
  agentsChip.hidden = agents.length === 0
  agentsChip.replaceChildren(
    element("span", working > 0 ? "dot running" : "dot completed"),
    document.createTextNode(
      ` ${working > 0 ? working : agents.length} agent${(working || agents.length) === 1 ? "" : "s"}`,
    ),
  )
  modeButton.textContent = `${state.mode === "build" ? "Build" : "Plan"} ▾`
  modeButton.title = state.mode === "build" ? "Build: edits and runs commands" : "Plan: reads only, never edits"
  const model = state.models.find((item) => `${item.providerID}/${item.id}` === state.model)
  modelButton.textContent = `${model?.name ?? "Default model"} ▾`
  sendButton.hidden = state.busy
  stopButton.hidden = !state.busy
}

// The banner is built when the answer changes and not on every repaint, so a list the person opened stays open.
let paintedTrust: string | undefined
function paintTrust(trust: TrustView | undefined) {
  const next = JSON.stringify(trust ?? null)
  if (next === paintedTrust) return
  paintedTrust = next
  banner.hidden = trust === undefined
  if (!trust) return banner.replaceChildren()
  const head = element("div", "trust-head")
  head.append(element("span", "strong", "⊙ Untrusted"), element("span", "muted grow trust-folder", trust.directory))
  const files = element("details", "trust-files")
  files.append(
    element("summary", undefined, `${trust.held.length} ${trust.held.length === 1 ? "file" : "files"} held back`),
    ...trust.held.map((item) => {
      const row = element("div", "trust-file")
      row.append(element("span", "grow", item.name), element("span", "muted", item.kinds))
      return row
    }),
  )
  banner.replaceChildren(
    head,
    element("div", undefined, `Orbit is leaving out what could run code or reach the network: ${trust.summary}.`),
    files,
    ...(trust.opened === undefined
      ? []
      : [element("div", "muted small", `VS Code opened ${trust.opened}. Trust is decided for the project's folder.`)]),
    ...(trust.above.length === 0
      ? []
      : [
          element(
            "div",
            "muted small",
            `Config in ${trust.above.join(", ")} stays off: each folder is trusted on its own.`,
          ),
        ]),
    button("Review and trust…", () => vscode.postMessage({ type: "trust" }), "primary"),
  )
}

function paintEmpty() {
  const mark = element("div", "mark")
  mark.append(element("div", "ring"), element("div", "planet"), element("div", "moon"))
  const intro = element("div", "intro")
  intro.append(
    element("div", "headline", `Ask Orbit about ${state.workspace.folder || "this workspace"}`),
    element("div", "muted", "Reads, edits and runs commands in this workspace. Asks before it changes anything."),
  )
  const starters = element("div", "starters")
  const selection = state.workspace.selection
  if (selection)
    starters.append(
      starter(
        "Explain the selected code",
        `${basename(selection.file)} · lines ${selection.startLine}–${selection.endLine}`,
        "explain",
      ),
    )
  const problems = state.workspace.problems
  if (problems)
    starters.append(
      starter(
        `Fix ${problems.count} problem${problems.count === 1 ? "" : "s"} in this file`,
        `${basename(problems.file)} · from the Problems panel`,
        "fix",
      ),
    )
  starters.append(starter("Review uncommitted changes", "reads git diff · edits nothing", "review"))
  const setup = element("div", "setup")
  setup.append(element("div", "caption", "SETUP"))
  if (state.status && state.checks.length === 0) setup.append(element("div", "check", state.status))
  state.checks.forEach((check) => {
    const row = element("div", check.ok ? "check" : "check failed")
    row.append(element("span", "glyph", check.ok ? "✓" : "✕"), element("span", undefined, check.text))
    setup.append(row)
  })
  empty.replaceChildren(mark, intro, starters, setup)
}

function paintMenu() {
  menu.replaceChildren(
    ...[{ providerID: "", id: "", name: "Default model" }, ...state.models].map((model) => {
      const value = model.id ? `${model.providerID}/${model.id}` : ""
      const row = element("div", "option")
      row.append(
        element("span", "check", value === state.model ? "✓" : ""),
        element("span", "grow", model.name),
        element("span", "muted", model.providerID),
      )
      row.addEventListener("click", () => {
        state.model = value
        menu.hidden = true
        if (value) vscode.postMessage({ type: "model", model: value })
        paint()
      })
      return row
    }),
  )
}

function starter(title: string, detail: string, kind: "explain" | "fix" | "review") {
  const node = element("button", "starter")
  node.type = "button"
  node.append(element("span", undefined, title), element("span", "muted small", detail))
  node.addEventListener("click", () => {
    state.started = true
    vscode.postMessage({ type: "starter", starter: kind })
  })
  return node
}

function chipVisible() {
  return state.chip && state.workspace.selection !== undefined
}

function button(label: string, onClick: () => void, className?: string) {
  const node = element("button", className, label)
  node.type = "button"
  node.addEventListener("click", onClick)
  return node
}

function verb(action: string) {
  return { edit: "Edit", write: "Write", shell: "Run", read: "Read", webfetch: "Fetch" }[action] ?? action
}

function basename(file: string) {
  return file.split(/[\\/]/).at(-1) ?? file
}

function sum(files: ReadonlyArray<FileChange>) {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  )
}

paint()
vscode.postMessage({ type: "ready" })
