import { Orbit } from "@orbit/client"
import path from "node:path"
import vscode from "vscode"
import { plain } from "@orbit/flow/plain"
import {
  ask,
  context as editorContext,
  explain,
  fix,
  lines,
  place,
  review,
  type Diagnostic,
  type EditorFile,
  type Selection,
} from "./context.js"
import { Controller, type TrustAnswer, type Update } from "./controller.js"
import { askForm } from "./forms.js"
import { headers, start, version } from "./endpoint.js"
import { createNoticeTracker, notice } from "./notify.js"
import { proposed } from "./patch.js"
import { configured, find, missing } from "./program.js"
import type { Check, FromView, Item, Mode, Model, ToView, TrustView, Workspace } from "./protocol.js"
import { RunsView } from "./runs-view.js"
import { prompt, trusted } from "./trust.js"

const scheme = "orbit-proposed"

export function activate(context: vscode.ExtensionContext) {
  const editor = new EditorState()
  const chat = new Chat(context, editor)
  new RunsView(executable, () => directory(editor), chat.log).register(context)
  const proposals = new Map<string, string>()
  context.subscriptions.push(
    editor,
    vscode.window.registerWebviewViewProvider("orbit.chat", chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // The Orbit activity bar icon opens the chat tab and leaves the Explorer beside it, as the side bar holds no chat.
    vscode.window.registerWebviewViewProvider("orbit.start", {
      resolveWebviewView: (view) => {
        view.webview.html = "<!doctype html><html><body></body></html>"
        const open = () => {
          if (!view.visible) return
          void chat.reveal()
          void vscode.commands.executeCommand("workbench.view.explorer")
        }
        open()
        view.onDidChangeVisibility(open)
      },
    }),
    vscode.window.registerWebviewPanelSerializer("orbit.chat", {
      deserializeWebviewPanel: async (panel) => chat.adopt(panel),
    }),
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: (uri) => proposals.get(uri.toString()) ?? "",
    }),
    vscode.commands.registerCommand("orbit.open", () => chat.reveal()),
    vscode.commands.registerCommand("orbit.newSession", () => chat.reset()),
    vscode.commands.registerCommand("orbit.history", () => chat.history()),
    vscode.commands.registerCommand("orbit.outputStyle", () => chat.outputStyle()),
    vscode.commands.registerCommand("orbit.askSelection", async () => {
      const selection = editor.selection()
      if (!selection) return
      const question = await vscode.window.showInputBox({ prompt: "Ask Orbit about the selection" })
      if (question) await chat.send(ask(selection, question))
    }),
    vscode.commands.registerCommand("orbit.explainSelection", async () => {
      const selection = editor.selection()
      if (selection) await chat.send(explain(selection))
    }),
    vscode.commands.registerCommand("orbit.fixDiagnostics", async () => {
      const problems = editor.problems()
      if (!problems) return void vscode.window.showInformationMessage("Orbit: no problems in this file")
      await chat.send(fix(problems.file, problems.diagnostics))
    }),
    vscode.commands.registerCommand("orbit.trust", async () => {
      await chat.reveal()
      await chat.review()
    }),
    // orb is the terminal's own program and not text typed into a shell: `cmd.exe` would look in this folder first for
    // `orb`, and the folder is the workspace. The terminal UI asks about trusting the folder itself.
    vscode.commands.registerCommand("orbit.openTerminal", () => {
      const program = find(executable())
      if (!program) return void vscode.window.showErrorMessage(`Orbit: ${missing(executable())}`)
      const folder = directory(editor)
      vscode.window
        .createTerminal({
          name: "Orbit",
          shellPath: program,
          cwd: folder,
          // orb takes the working directory from PWD, which VS Code's own environment would otherwise supply.
          env: { PWD: folder },
          location: vscode.TerminalLocation.Editor,
        })
        .show()
    }),
  )
  chat.onDiff = async (item) => {
    const root = directory(editor)
    for (const change of item.files) {
      // The place is the one the server resolved, else the name it gave the file. A moved file is read from where it came
      // from, as its destination does not exist yet, and proposed at the destination.
      const named = change.place ?? change.file
      const file = path.isAbsolute(named) ? named : path.join(root, named)
      const source = change.from ?? named
      const original = vscode.Uri.file(path.isAbsolute(source) ? source : path.join(root, source))
      const before = await vscode.workspace.fs.readFile(original).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => "",
      )
      const after = proposed(before, change.patch)
      if (after === undefined) {
        void vscode.window.showWarningMessage(`Orbit: ${change.file} changed since the agent read it`)
        continue
      }
      const target = vscode.Uri.from({ scheme, path: file, query: item.id })
      proposals.set(target.toString(), after)
      // Next to the chat, so the conversation and the proposal are side by side.
      await vscode.commands.executeCommand(
        "vscode.diff",
        change.status === "added" ? vscode.Uri.from({ scheme, path: `${file}.empty` }) : original,
        target,
        `${path.basename(file)} ↔ Orbit proposal`,
        { viewColumn: vscode.ViewColumn.Beside, preview: true },
      )
    }
  }
}

export function deactivate() {}

/**
 * The file editor the user last worked in. While the chat tab is focused VS Code reports no active text editor, and a
 * chat that opens over the editor hides it, so the file, selection, problems and folder the chat offers come from
 * here. It keeps that editor while its document is open, visible or not. Only documents of the `file` scheme count:
 * not an untitled buffer, an output pane, a `git:` view or the chat's own proposal diffs.
 */
class EditorState implements vscode.Disposable {
  private last: vscode.TextEditor | undefined = counts(vscode.window.activeTextEditor)
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  private readonly subscriptions = [
    this.changed,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const next = counts(editor)
      if (!next) return
      this.last = next
      this.changed.fire()
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== this.last) return
      this.changed.fire()
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (this.last?.document !== document) return
      this.last = undefined
      this.changed.fire()
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      if (this.last && event.uris.some((uri) => uri.toString() === this.last?.document.uri.toString()))
        this.changed.fire()
    }),
  ]

  editor() {
    if (this.last && vscode.workspace.textDocuments.includes(this.last.document)) return this.last
    return undefined
  }

  /** The file as the agent resolves it from the chat's folder. */
  private place(editor: vscode.TextEditor) {
    return place(directory(this), editor.document.uri.fsPath)
  }

  selection(): Selection | undefined {
    const editor = this.editor()
    if (!editor) return undefined
    const range = lines(editor.selection.start, editor.selection.end)
    if (!range) return undefined
    return {
      file: this.place(editor),
      language: editor.document.languageId,
      ...range,
      text: editor.document.getText(editor.selection),
    }
  }

  /** The open file for the model: its path, and the selection when there is one. */
  file(): EditorFile | undefined {
    const editor = this.editor()
    if (!editor) return undefined
    const selection = this.selection()
    return {
      file: this.place(editor),
      language: editor.document.languageId,
      selection: selection && { startLine: selection.startLine, endLine: selection.endLine, text: selection.text },
    }
  }

  problems() {
    const editor = this.editor()
    if (!editor) return undefined
    const diagnostics = vscode.languages
      .getDiagnostics(editor.document.uri)
      .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
      .map(
        (item): Diagnostic => ({
          line: item.range.start.line + 1,
          column: item.range.start.character + 1,
          code: code(item.code),
          severity: (["error", "warning", "information", "hint"] as const)[item.severity],
          message: item.message,
          source: item.source,
        }),
      )
    if (diagnostics.length === 0) return undefined
    return { file: this.place(editor), diagnostics }
  }

  /**
   * What the chat draws. Every string came from the repository, so each is written on one line by `plain` before the
   * webview gets it.
   */
  workspace(): Workspace {
    const editor = this.editor()
    const selection = this.selection()
    const problems = this.problems()
    return {
      folder: plain(path.basename(directory(this))),
      file: editor ? plain(this.place(editor)) : undefined,
      selection: selection && {
        file: plain(selection.file),
        startLine: selection.startLine,
        endLine: selection.endLine,
      },
      problems: problems && { file: plain(problems.file), count: problems.diagnostics.length },
      includeFile: includeOpenFile(),
    }
  }

  dispose() {
    this.subscriptions.forEach((item) => item.dispose())
  }
}

function counts(editor: vscode.TextEditor | undefined) {
  return editor?.document.uri.scheme === "file" ? editor : undefined
}

// VS Code gives a diagnostic's code as a string, a number, or an object that holds the value.
function code(value: vscode.Diagnostic["code"]) {
  const inner = typeof value === "object" ? value.value : value
  return inner === undefined || inner === "" ? undefined : String(inner)
}

/**
 * The chat: owns the connection, the controller and everything the webview shows. It opens as an editor tab by
 * default (`orbit.placement`), or lives in the Orbit side bar.
 */
class Chat implements vscode.WebviewViewProvider {
  onDiff: (item: Extract<Item, { type: "permission" }>) => Promise<void> = async () => {}
  private view: vscode.WebviewView | undefined
  private panel: vscode.WebviewPanel | undefined
  private controller: Promise<Controller> | undefined
  private readonly items: Item[] = []
  private busy = false
  private readonly notices = createNoticeTracker()
  private models: ReadonlyArray<Model> = []
  private selected: string | undefined
  private mode: Mode = "build"
  private title = ""
  private plan: ToView | undefined
  private checks: ReadonlyArray<Check> = []
  // The folder is untrusted and holds something back, or undefined. The indicator beside the status item and the banner in
  // the chat show it, and the commands and the status item open the question.
  private trust: TrustView | undefined
  private uncheckedShown = false
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  private readonly untrusted = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101)

  readonly log = vscode.window.createOutputChannel("Orbit")

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly editor: EditorState,
  ) {
    this.status.command = "orbit.open"
    this.status.name = "Orbit"
    this.untrusted.command = "orbit.trust"
    this.untrusted.name = "Orbit trust"
    this.untrusted.text = "$(workspace-untrusted) Orbit · untrusted"
    this.paint()
    this.status.show()
    context.subscriptions.push(
      this.log,
      this.status,
      this.untrusted,
      editor.onDidChange(() => this.post({ type: "workspace", workspace: editor.workspace() })),
    )
  }

  /** Sidebar placement. */
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    this.attach(view.webview)
    view.onDidDispose(() => (this.view = undefined))
  }

  /** Editor placement, including a tab VS Code restores after a reload. */
  adopt(panel: vscode.WebviewPanel) {
    this.panel = panel
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "images", "orbit-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "images", "orbit-dark.svg"),
    }
    this.retitle()
    this.attach(panel.webview)
    panel.onDidDispose(() => (this.panel = undefined))
  }

  async reveal() {
    if (placement() === "sidebar") return void (await vscode.commands.executeCommand("orbit.chat.focus"))
    if (this.panel) return this.panel.reveal()
    this.adopt(
      vscode.window.createWebviewPanel("orbit.chat", "Orbit", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
      }),
    )
  }

  async send(text: string, context?: string, shown?: string) {
    await this.reveal()
    const controller = await this.connect()
    if (controller) await controller.send(text, context, shown)
  }

  async reset() {
    const controller = await this.controller
    controller?.reset()
    this.items.length = 0
    this.title = ""
    this.plan = undefined
    this.retitle()
    this.post({ type: "reset" })
  }

  /** Lets the user pick how the agent communicates; saved to the global Orbit config like the TUI's /output-style. */
  async outputStyle() {
    const controller = await this.connect()
    if (!controller) return
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Default", description: "Concise answers focused on the task", value: "default" },
        {
          label: "Explanatory",
          description: "Adds short insights about the codebase and choices",
          value: "explanatory",
        },
        { label: "Learning", description: "Leaves small TODO(human) pieces for you to write", value: "learning" },
      ],
      { title: "Orbit output style" },
    )
    if (!picked) return
    const done = await controller.outputStyle(picked.value === "default" ? null : picked.value)
    if (!done)
      void vscode.window.showWarningMessage(
        "Orbit: the output style was not changed, because the server cannot say whether the folder is trusted. Run `orb service restart` if it is old, or try again.",
      )
  }

  async history() {
    const controller = await this.connect()
    if (!controller) return
    const sessions = await controller.sessions()
    if (sessions.length === 0) return void vscode.window.showInformationMessage("Orbit: no sessions in this folder yet")
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.title || "Untitled session",
        description: ago(session.time.updated),
        id: session.id,
      })),
      { placeHolder: "Continue a session from this folder" },
    )
    if (!picked) return
    await this.reset()
    await this.reveal()
    this.mode = await controller.open(picked.id)
    this.post({ type: "mode", mode: this.mode })
  }

  private attach(webview: vscode.Webview) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "dist")
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    webview.html = page(webview, media)
    webview.onDidReceiveMessage((message: FromView) => void this.receive(message))
  }

  private async receive(message: FromView) {
    switch (message.type) {
      case "ready": {
        this.post({ type: "reset" })
        this.post({ type: "workspace", workspace: this.editor.workspace() })
        this.post({ type: "trust", trust: this.trust })
        this.post({ type: "mode", mode: this.mode })
        if (this.title) this.post({ type: "title", title: this.title })
        if (this.plan) this.post(this.plan)
        this.items.forEach((item) => this.post({ type: "item", item }))
        this.post({ type: "busy", busy: this.busy })
        if (this.checks.length > 0) this.post({ type: "setup", checks: this.checks })
        if (this.models.length > 0) this.post({ type: "models", models: this.models, selected: this.selected })
        const controller = await this.connect()
        if (!controller || this.models.length > 0) return
        return this.loadModels(controller)
      }
      case "send": {
        // The editor is read now, as the message goes, and the person's words stay exactly as typed.
        const file = message.file ? this.editor.file() : undefined
        const problems = message.problems ? this.editor.problems() : undefined
        const shown = [
          file?.selection &&
            `${file.selection.endLine - file.selection.startLine + 1} line${file.selection.endLine === file.selection.startLine ? "" : "s"} selected in ${plain(file.file)}`,
          problems && `${problems.diagnostics.length} problem${problems.diagnostics.length === 1 ? "" : "s"} in ${plain(problems.file)}`,
        ]
          .filter((line) => line !== undefined)
          .join(" · ")
        return this.send(message.text, editorContext({ file, problems }), shown || undefined)
      }
      case "starter": {
        if (message.starter === "explain") return vscode.commands.executeCommand("orbit.explainSelection")
        if (message.starter === "fix") return vscode.commands.executeCommand("orbit.fixDiagnostics")
        return this.send(review())
      }
      case "stop":
        return (await this.controller)?.stop()
      case "permission":
        return (await this.controller)?.reply(message.id, message.decision)
      case "diff": {
        const item = (await this.controller)?.permission(message.id)
        if (item) await this.onDiff(item)
        return
      }
      case "model": {
        const model = this.models.find((item) => `${item.providerID}/${item.id}` === message.model)
        if (!model) return
        this.selected = message.model
        this.paint()
        await (await this.controller)?.select(model)
        return
      }
      case "mode": {
        this.mode = message.mode
        this.post({ type: "mode", mode: this.mode })
        await (await this.controller)?.mode(message.mode)
        return
      }
      case "trust":
        return this.review()
    }
  }

  /**
   * Asks whether to trust the folder, from the banner, the status bar or the command. A click on the banner only opens
   * the question: trusting a folder is decided in the dialog, which lists what the folder holds back.
   */
  async review() {
    const controller = await this.connect()
    if (!controller) return
    const grant = await controller.review().catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        `Orbit: could not trust the folder: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    if (grant) return void vscode.window.showInformationMessage(`Orbit: ${trusted(grant)}`)
    if (!this.trust) void vscode.window.showInformationMessage("Orbit: nothing in this folder needs a decision.")
  }

  // The question before the first message in a folder that holds something back, and every other time the person opens
  // it. Closing the dialog, with Esc or the button, is "Not now".
  private async askTrust(trust: TrustView): Promise<TrustAnswer> {
    const question = prompt(trust)
    const accept: vscode.MessageItem = { title: question.accept }
    const later: vscode.MessageItem = { title: "Not now", isCloseAffordance: true }
    const choice = await vscode.window.showWarningMessage(
      question.message,
      { modal: true, detail: question.detail },
      accept,
      later,
    )
    return choice?.title === accept.title ? "trust" : "later"
  }

  private trusting(update: Extract<Update, { type: "trust" }>) {
    this.trust = update.trust
    this.paintTrust()
    this.post({ type: "trust", trust: update.trust })
    if (update.unchecked)
      this.check({
        ok: false,
        text: "Trust not checked: this Orbit service is older than workspace trust, so it applies a folder's project config without asking. Run orb service restart.",
      })
    else if (this.uncheckedShown) {
      this.check({ ok: true, text: "Trust checked" })
      // No models were asked for while the server could not say; now they are, without a reload of the chat.
      if (this.models.length === 0 && this.controller)
        void this.controller.then((controller) => controller && this.loadModels(controller))
    }
    this.uncheckedShown = update.unchecked
  }

  private async loadModels(controller: Controller) {
    this.models = await settledModels(controller)
    this.post({ type: "models", models: this.models, selected: this.selected })
    // On a server that cannot say whether the folder is trusted, no models are asked for, and the setup line
    // about trust already says why.
    if (this.uncheckedShown) return
    this.check({
      ok: this.models.length > 0,
      text:
        this.models.length > 0
          ? `${this.models.length} model${this.models.length === 1 ? "" : "s"} available`
          : "No models available: run orb doctor in a terminal",
    })
  }

  // One background service per machine, shared with the terminal UI; started on first use.
  private connect() {
    this.controller ??= (async () => {
      this.post({ type: "status", text: "Starting Orbit…" })
      this.log.appendLine(`starting: ${find(executable()) ?? executable()} service start --json`)
      const found = await version(executable()).then(
        (value) => ({ ok: true, text: `orb ${value} found` }),
        (error: unknown) => ({ ok: false, text: `orb not found: ${error instanceof Error ? error.message : error}` }),
      )
      this.check(found)
      const endpoint = await start(executable())
      this.log.appendLine(`connected: ${endpoint.url}`)
      this.check({ ok: true, text: `Background service · ${new URL(endpoint.url).host}` })
      const client = Orbit.make({ baseUrl: endpoint.url, headers: headers(endpoint) })
      this.post({ type: "status", text: "" })
      const apply = (update: Update) => {
        if (update.type === "log") return this.log.appendLine(update.text)
        if (update.type === "trust") return this.trusting(update)
        if (update.type === "busy") {
          const done = this.notices.busy(update.busy)
          if (done) this.notice(done)
          this.busy = update.busy
          this.paint()
          return this.post(update)
        }
        if (update.type === "title") {
          this.title = update.title
          this.retitle()
          return this.post(update)
        }
        if (update.type === "plan") {
          this.plan = update
          return this.post(update)
        }
        if (update.type === "form") {
          const form = update.form
          void Promise.all([this.controller, askForm(form)]).then(([controller, answer]) =>
            controller?.answer(form, answer),
          )
          return
        }
        if (update.item.type === "permission") {
          const asked = this.notices.permission(update.item)
          if (asked) this.notice(asked)
        }
        const index = this.items.findIndex((item) => item.id === update.item.id)
        if (index === -1) this.items.push(update.item)
        else this.items[index] = update.item
        this.paint()
        this.post(update)
      }
      return new Controller(client, directory(this.editor), apply, (trust) => this.askTrust(trust))
    })()
    return this.controller.catch((error: unknown) => {
      this.controller = undefined
      const text = error instanceof Error ? error.message : String(error)
      this.log.appendLine(`failed: ${text}`)
      this.check({ ok: false, text: `Could not start orb: ${text}` })
      this.post({ type: "status", text: `Could not start orb: ${text}. Check the orbit.executable setting.` })
      return undefined
    })
  }

  private notice(event: "permission" | "done") {
    const next = notice({
      event,
      enabled: vscode.workspace.getConfiguration("orbit").get<boolean>("notifications") ?? true,
      panelVisible: (placement() === "sidebar" ? this.view?.visible : this.panel?.visible) ?? false,
      windowFocused: vscode.window.state.focused,
    })
    if (!next) return
    const show = next.level === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
    void show(next.text, "Open").then((choice) => (choice === "Open" ? this.reveal() : undefined))
  }

  private check(next: Check) {
    // One line per subject: a later result replaces an earlier one about the same thing.
    const subject = next.text.split(/[ :·]/)[0]
    this.checks = [...this.checks.filter((item) => item.text.split(/[ :·]/)[0] !== subject), next]
    this.post({ type: "setup", checks: this.checks })
  }

  private retitle() {
    const title = this.title ? `Orbit · ${this.title}` : "Orbit · New session"
    if (this.panel) this.panel.title = title
    if (this.view) this.view.description = this.title
  }

  // The status bar mirrors the chat: what needs the user first, then whether Orbit is working.
  private paint() {
    const waiting = this.items.some((item) => item.type === "permission" && item.status === "pending")
    const model = this.models.find((item) => `${item.providerID}/${item.id}` === this.selected)
    this.status.text = waiting
      ? "$(warning) Orbit · needs review"
      : this.busy
        ? "$(loading~spin) Orbit · working"
        : `$(circle-filled) Orbit${model ? ` · ${model.name}` : ""}`
    this.status.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
    this.status.tooltip = waiting ? "Orbit is waiting for your review" : "Open Orbit"
  }

  // The indicator shows while the folder is untrusted and holds something back, and the command is offered then only.
  private paintTrust() {
    void vscode.commands.executeCommand("setContext", "orbit.untrusted", this.trust !== undefined)
    if (!this.trust) return this.untrusted.hide()
    this.untrusted.tooltip = `Orbit is leaving out ${this.trust.summary} of ${this.trust.directory} until you trust it. Select to review.`
    this.untrusted.show()
  }

  private post(message: ToView) {
    void this.panel?.webview.postMessage(message)
    void this.view?.webview.postMessage(message)
  }
}

function page(webview: vscode.Webview, media: vscode.Uri) {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"))
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"))
  const layout = placement() === "sidebar" ? "sidebar" : "editor"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Orbit</title>
</head>
<body class="${layout}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
}

// Right after the service starts, the model list can precede provider discovery (Ollama, Tachyon): retry briefly.
async function settledModels(controller: Controller, attempts = 15): Promise<ReadonlyArray<Model>> {
  const models = await controller.models().catch(() => [])
  if (models.length > 0 || attempts <= 1) return models
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return settledModels(controller, attempts - 1)
}

function directory(editor: EditorState) {
  const current = editor.editor()
  const folder =
    (current && vscode.workspace.getWorkspaceFolder(current.document.uri)) ?? vscode.workspace.workspaceFolders?.[0]
  // VS Code reports Windows drive letters in lower case; the terminal and the rest of Orbit see `D:\…`.
  return (folder?.uri.fsPath ?? process.cwd()).replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

// The person's own setting. A workspace's value is never read: it would choose the program the extension runs.
function executable() {
  return configured(vscode.workspace.getConfiguration("orbit").inspect<string>("executable"))
}

// The person's own setting, like `executable`: a repository's .vscode/settings.json must not decide how much of the
// person's editor goes to the model.
function includeOpenFile() {
  const setting = vscode.workspace.getConfiguration("orbit").inspect<boolean>("context.includeOpenFile")
  return setting?.globalValue ?? setting?.defaultValue ?? true
}

function placement() {
  return vscode.workspace.getConfiguration("orbit").get<"editor" | "sidebar">("placement") ?? "editor"
}

function ago(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
