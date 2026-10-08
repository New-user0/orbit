# Orbit for VS Code

Chat with the Orbit coding agent from the VS Code sidebar, using whichever models Orbit is configured for: Tachyon,
Ollama and other local models, Anthropic, or any OpenAI-compatible API.

The extension is a thin client. It starts or reuses the same local `orb` background service the terminal UI uses, so
providers, models, permissions and `orbit.json` all work exactly as they do in `orb`. It sends nothing anywhere else.

## Requirements

The `orb` executable. If it is not on `PATH`, set **Orbit: Executable** (`orbit.executable`) to its full path, for
example `D:\Project\harness\packages\cli\dist\cli-windows-x64\bin\orb.exe`.

Only your **user** settings count for that setting: a workspace's `.vscode/settings.json` cannot set it, because it
chooses the program the extension runs. The extension finds `orb` on `PATH` itself, skipping empty and relative entries,
and starts it by its full path, so an `orb` in the folder you opened is never the one that runs. On Windows it starts a
`.exe` or a `.com`.

## Use

- **Chat:** open the Orbit icon in the activity bar. Pick a model at the top, type, and press Enter. **Stop** interrupts
  the agent.
- **Permissions:** when Orbit asks before an action, the chat shows a card. For file edits, **Show diff** opens the
  proposed change in VS Code's diff view before you choose **Allow once**, **Always allow** or **Reject**. Which actions
  ask is set by Orbit's `permissions` rules, the same as in the terminal.
- **From the editor** (right-click, or the Command Palette):
  - **Orbit: Ask About Selection** (`Ctrl+Esc` / `Cmd+Esc`) sends the selection with a question.
  - **Orbit: Explain Selection**.
  - **Orbit: Fix Problems in This File** sends the file's errors and warnings.
- **Runs:** the **Runs** view under the chat lists the Orbit Flow runs of the open folder, newest first. Expand a run
  to see its nodes with status, tokens, cost and time; it updates live while a run works. On a gate waiting for a
  decision, **Approve** or **Reject** (with an optional note), then **Resume** the run. **Watch** opens
  `orb flow watch` in a terminal; **Clean Up** removes finished runs' worktrees and branches.
- **Trust:** Orbit leaves out what a folder's own config could use to run code or reach the network, such as hooks, MCP
  servers and plugins, until you trust the folder. In such a folder a banner above the chat lists what is left out and
  which files hold it, and the status bar shows **Orbit · untrusted**. **Review and trust…** on the banner, the status
  bar item and **Orbit: Trust This Folder…** open a dialog with **Trust this folder** and **Not now**. The first message
  asks too, once per folder, before anything is sent; **Not now** sends it without the folder's config. Trust belongs to
  the project's folder, which the dialog names, and is the same decision that `orb trust` and the terminal UI make. The
  extension also stays off until you trust the workspace in VS Code, which is a separate decision.
- **Orbit: New Session** starts a fresh chat. **Orbit: Open orb in Terminal** opens the full terminal UI.

## Build and install

```sh
cd packages/vscode
bun run package          # writes dist/orbit-code-<version>.vsix
code --install-extension dist/orbit-code-0.1.0.vsix
```

On Windows, install the `.vsix` from VS Code with **Extensions: Install from VSIX…** if `code` is not on `PATH`.

## Development

`bun run build` bundles into `dist/`. `bun test` runs the controller against a real `orb serve` with a scripted model.
The chat logic lives in `src/controller.ts` and has no dependency on VS Code; `src/extension.ts` is the VS Code glue.
