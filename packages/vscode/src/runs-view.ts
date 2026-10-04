import vscode from "vscode"
import { decide, nodeItem, nodes, orb, runItem, runs, type Item } from "./runs.js"

type Entry =
  | { readonly kind: "run"; readonly run: string }
  | { readonly kind: "node"; readonly run: string; readonly node: string }

// Runs of the open folder and their nodes. It refreshes when the run store changes on disk, which happens on every
// step of a run, so a running workflow updates live.
export class RunsView implements vscode.TreeDataProvider<Entry> {
  private readonly changed = new vscode.EventEmitter<Entry | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private readonly items = new Map<string, Item>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly executable: () => string,
    private readonly directory: () => string,
    private readonly log: vscode.OutputChannel,
  ) {}

  register(context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.orbit/runs.db*")
    const refresh = () => this.refresh()
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider("orbit.runs", this),
      // With the chat in an editor tab, runs are listed in the Explorer instead of the Orbit side bar.
      vscode.window.registerTreeDataProvider("orbit.runs.explorer", this),
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      vscode.commands.registerCommand("orbit.runs.refresh", refresh),
      vscode.commands.registerCommand("orbit.runs.approve", (entry: Entry) => this.decide(entry, true)),
      vscode.commands.registerCommand("orbit.runs.reject", (entry: Entry) => this.decide(entry, false)),
      vscode.commands.registerCommand("orbit.runs.resume", (entry: Entry) =>
        this.terminal(["flow", "resume", entry.run]),
      ),
      vscode.commands.registerCommand("orbit.runs.watch", (entry: Entry) =>
        this.terminal(["flow", "watch", entry.run]),
      ),
      vscode.commands.registerCommand("orbit.runs.clean", async () => {
        const output = await orb(this.executable(), this.directory(), ["flow", "clean"]).catch((error: Error) => error)
        if (output instanceof Error) return this.fail("Could not clean runs", output)
        vscode.window.showInformationMessage(output.trim())
      }),
    )
  }

  // Writes come in bursts, so refreshes are batched.
  refresh() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.changed.fire(undefined), 300)
  }

  getTreeItem(entry: Entry) {
    const key = entry.kind === "run" ? entry.run : `${entry.run}\u0000${entry.node}`
    const item = this.items.get(key)
    const tree = new vscode.TreeItem(
      item?.label ?? key,
      entry.kind === "run" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    )
    tree.id = key
    tree.description = item?.description
    tree.tooltip = item?.tooltip
    tree.contextValue = item?.context
    if (item) tree.iconPath = new vscode.ThemeIcon(item.icon)
    return tree
  }

  async getChildren(entry?: Entry): Promise<Entry[]> {
    const executable = this.executable()
    const directory = this.directory()
    if (!entry) {
      const list = await runs(executable, directory).catch((error: Error) => this.fail("Could not list runs", error))
      return (list ?? []).map((run) => {
        this.items.set(run.id, runItem(run))
        return { kind: "run" as const, run: run.id }
      })
    }
    if (entry.kind !== "run") return []
    const list = await nodes(executable, directory, entry.run).catch((error: Error) =>
      this.fail(`Could not read ${entry.run}`, error),
    )
    return (list ?? []).map((node) => {
      this.items.set(`${entry.run}\u0000${node.id}`, nodeItem(node))
      return { kind: "node" as const, run: entry.run, node: node.id }
    })
  }

  private async decide(entry: Entry, approve: boolean) {
    if (entry.kind !== "node") return
    const note = await vscode.window.showInputBox({
      title: `${approve ? "Approve" : "Reject"} ${entry.node}`,
      prompt: "An optional note the workflow receives with the decision",
      placeHolder: "Note (optional)",
    })
    if (note === undefined) return
    const result = await decide(this.executable(), this.directory(), {
      run: entry.run,
      gate: entry.node,
      approve,
      note: note || undefined,
    }).catch((error: Error) => error)
    if (result instanceof Error) return this.fail(`Could not decide ${entry.node}`, result)
    this.refresh()
    const choice = await vscode.window.showInformationMessage(
      `${approve ? "Approved" : "Rejected"} ${entry.node}. Resume ${entry.run} now?`,
      "Resume",
    )
    if (choice === "Resume") this.terminal(["flow", "resume", entry.run])
  }

  // Long-running commands get a terminal of their own, so their progress stays visible and Ctrl+C works.
  private terminal(args: string[]) {
    const terminal = vscode.window.createTerminal({
      name: `orb ${args.slice(0, 2).join(" ")}`,
      shellPath: this.executable(),
      shellArgs: args,
      cwd: this.directory(),
      env: { PWD: this.directory() },
    })
    terminal.show()
  }

  private fail(message: string, error: Error) {
    this.log.appendLine(`${message}: ${error.message}`)
    vscode.window.showErrorMessage(`${message}: ${error.message.split("\n")[0]}`)
    return undefined
  }
}
