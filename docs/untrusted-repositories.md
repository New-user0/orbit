# Untrusted repositories

Orbit starts in whatever folder it is pointed at, and a cloned repository chooses every file in that folder: its config,
its `.orbit` directory, its links, its workflow and suite files, its run store and the names of all of them. This page
is the checklist for any change that reads such files, runs commands, makes network requests, prints text that came from
a file or changes how the `orb` binary is built. The one-line rules are in [AGENTS.md](../AGENTS.md) under "Untrusted
Repositories". This page holds the reasons, the helpers, the tests and the review questions behind them.

It comes from the first milestone (M1), which made project config, plugins, commands, workflows and the compiled binary
hold back what a folder supplies until the folder is trusted. It did not close every hole, and [Known gaps](#known-gaps)
lists the ones that are left. Its reviews and audits had found 160 distinct defects by the time the compiled binary's
dependency lookups were last fixed (the esprima fix): one blocker, 36 majors, 114 minors and nine holes that no review
had caught first. The review of that fix then found a second blocker, an executable looked up in the working folder,
and closing it turned up two more members of the same class (class 10). The review of this page then found a third
blocker in that class, a bare name's `.exe` that Bun's own spawn finds in the working folder, which no test had planted.
Those four are not in the counts. 131 of the 160 fall into the fifteen classes below, including the first blocker and
most of the majors, and most classes came back in a new place after their first fix. Writing the rule once for the whole
class costs less than finding the next instance in review.

**The promise.** Until a person trusts a folder, no file that the folder supplies may run code, spend their money, reach
the network, carry a file of theirs to a model provider or change which of their rules apply. A change that breaks one
of these on a default path is a defect, whatever else it adds. M1 did not keep the promise everywhere: each place where
it does not hold yet is in [Known gaps](#known-gaps), and a change must not widen one. What users see of this is in
[upgrading](upgrading.md), under "A project's config waits for its folder to be trusted".

Words used here:

- **Surface:** a place where Orbit reads, imports, runs or prints something that a repository supplied.
- **Gate:** the check that stops a surface until its folder is trusted.
- **Trusted:** decided for one folder, by a stored grant (`orb trust`, the terminal UI), by a grant that lasts until the
  server restarts, or because the server trusts every folder without a grant (`ORBIT_TRUST_PROJECT=1` on a private or
  foreground server, `trust: { implicit: true }` in an SDK host). `WorkspaceTrust` keeps the decisions and
  `ProjectTrust` answers for a Location's project.
- **Held back:** what an untrusted folder's files would have contributed. `ProjectTrust.status` lists it per file with
  its kinds (`Trust.Kind`).
- **Holder:** the folder whose decision covers a file. For config inside the project's folders it is the project's
  canonical root, wherever the file sits (`standing()` in `packages/core/src/config.ts`). For config in a folder above
  the project it is the folder around the file's `.orbit` directory, or the file's own folder (`ConfigTrust.holder`),
  and a grant for the project does not reach it. Do not use `ConfigTrust.holder` for a file inside the project: for
  `repo/sub/.orbit` it answers `repo/sub`, a folder whose grant changes nothing.

How to use the page:

- **Implementing.** Find which of the five triggers your change touches: it reads project files, runs commands, makes
  network requests, prints text from a file, or changes the build. Add each new surface to the inventory below, apply
  the rules of every class it touches, and walk the [Review checklist](#review-checklist) before you open the PR.
- **Reviewing.** Walk the Review checklist. A finding in a class that this page already names is a finding against the
  page too: with the fix, add the question that would have caught it.
- **Planning.** Copy each "Ask early" line into the spec of the task it fits. A decision in the milestone plan that says
  "build now" goes into the checklist of the task that owns it.

The classes, by the number that the checklist cites:

1. [Code runs from the project folder before, or without, a trust check](#1-code-runs-from-the-project-folder-before-or-without-a-trust-check)
2. [Data files that carry commands, approvals or agent choices](#2-data-files-that-carry-commands-approvals-or-agent-choices)
3. [Trust is bound to the wrong folder or identity](#3-trust-is-bound-to-the-wrong-folder-or-identity)
4. [Containment is judged by name instead of real path](#4-containment-is-judged-by-name-instead-of-real-path)
5. [Names and IDs from untrusted stores become paths, refs or titles](#5-names-and-ids-from-untrusted-stores-become-paths-refs-or-titles)
6. [Network egress: URL forms, redirects, address spellings, rebinding and lookup failures](#6-network-egress-url-forms-redirects-address-spellings-rebinding-and-lookup-failures)
7. [Failing open, and dropping silently](#7-failing-open-and-dropping-silently)
8. [Permission widening through agent, mode, default, scope-order and approval-display choices](#8-permission-widening-through-agent-mode-default-scope-order-and-approval-display-choices)
9. [Terminal control characters in printed or stored text](#9-terminal-control-characters-in-printed-or-stored-text)
10. [The process resolves names from the folder it starts in](#10-the-process-resolves-names-from-the-folder-it-starts-in)
11. [Parsers whose engines evaluate content](#11-parsers-whose-engines-evaluate-content)
12. [Entry points and process boundaries each need the gate](#12-entry-points-and-process-boundaries-each-need-the-gate)
13. [Failure and decline paths are not carried end to end](#13-failure-and-decline-paths-are-not-carried-end-to-end)
14. [Tests, gates and allowlists that do not check what they claim](#14-tests-gates-and-allowlists-that-do-not-check-what-they-claim)
15. [Docs, comments and PR text that outrun the code](#15-docs-comments-and-pr-text-that-outrun-the-code)

PR numbers are this repository's: #14 is workspace trust, #15 and #16 the trust gates for project files (#15's commits
were re-landed as #16), #18 the trust API and `orb trust`, #19 and #20 the terminal UI's trust dialog and plugin gate,
#21 and #22 the M1 verification fixes, #13 the vendor gate, and #1 to #12 the first wave of tasks (CI, permissions, Code
Mode, hooks, compat).

## Where each surface is gated

Every place that Orbit reads, imports, runs or prints something a repository supplied, and what stops it while the
folder is untrusted. A change that adds a surface adds an entry here, and a line to the reader list in the header of
`packages/core/src/config/trust.ts`, which is the same inventory seen from the file readers.

**Server** (`packages/core`):

- Project and local config documents, the compat settings files and `.mcp.json`: `ConfigTrust.stamp` cuts each down with
  `ConfigTrust.sanitize`, as `ConfigTrust.classification` says. Proof: `test/config/trust.test.ts`,
  `test/config/config-trust.test.ts`.
- `{env:}` and `{file:}` references in those documents: `ConfigVariable.substitute` with `within`. Proof:
  `config-trust.test.ts`.
- An MCP server's tool title: `McpTool.traits` (`packages/core/src/tool/mcp.ts`) stores it as the tool's `displayName`
  with control and format characters written out. A plugin or a simulated tool supplies its `displayName` raw, but the
  publisher writes every declared name through `plain` (`@orbit/util/plain`) onto the durable `session.tool.input.started`
  event, and `SessionTransfer.import` (`orb session import`, `POST /api/experimental/session/import`) writes an imported tool part's `displayName` through it too, so the stored and projected `displayName` is always escaped; a client that draws it still passes it through
  `plain` (escaping text that is already escaped changes nothing) and never unescapes it. Proof:
  `session-runner-tool-events.test.ts` ("tool input started carries the declared display name") and `server/test/session-import-display-name.test.ts`. The hints beside it (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) drive scheduling and display only and never declare `readOnly`. Proof: `MCP tool traits` and
  `MCP hints and permissions` in `core/test/mcp.test.ts`.
- A tool call, whichever door it came through: every call that Orbit makes runs through `Tool.Snapshot.execute`, so a
  model call, a session runner step (which is also how an SDK host or a flow node, both of which run sessions, reach
  a tool), a Code Mode inner call, an MCP tool, a Promise plugin's tool and a desktop browser tool all pass the registry
  gate in `executeTool` (`packages/core/src/tool.ts`). Plugin code is trusted and can still call a listed tool's
  `execute` directly, which skips hooks, validation and the gate. A tool asks about a call itself only when
  `options.authorizes` is `true` or a predicate answers `true`; a tool that leaves it out, or whose predicate throws, fails,
  dies or answers with anything else, is asked about on its permission action or its name. MCP annotations never set it.
  Proof: `core/test/tool-gate.test.ts` (`every door into tool execution`, including the Promise adapter's add and
  update, and `MCP tools`), `core/test/session-runner.test.ts` (`does not authorize itself`, `registry gate is declined`),
  `plugin-browser/test/tools.test.ts` (the browser tools ask on `browser`), and the `expectRegistryAsks` line in the suite
  of each built-in the registry asks about.
- Managed settings (`/etc/orbit`, `/Library/Application Support/Orbit`, `%ProgramFiles%\Orbit`, or `ORBIT_MANAGED_DIR`):
  `ManagedSettings.read` reads a fixed folder, never one a repository supplies, so it has no trust gate. The default
  folders are ones only an administrator (root, or on Windows a member of Administrators) can create or add a file to;
  Windows uses Program Files, not ProgramData, because a standard user can create and write under ProgramData and
  what they put there would run as every other user (owner decision 2026-10-10, "Program Files (Recommended)"; no ACL
  check is built, and an `ORBIT_MANAGED_DIR` that a user can write is the user's own choice), and nothing in a project can name its location (the override is the server's environment or
  `ServerOptions.managed.directory`). A repository file cannot write the `managed` key: `ConfigNormalize` drops it
  with a diagnostic. An empty or relative override is refused with one log line and the per-OS default applies
  (`ManagedPath.directory` and `ManagedSettings`), so the working folder is never read. Each file and each entry decodes
  on its own (class 7): a file or folder that exists but cannot be read or listed, an unknown key in `managed` or its
  sections, an unknown key at any depth of the other settings (one walk of the config schema: struct fields, record
  values, union members and list items; the legacy top-level spellings are not walked, and a key that a sibling union
  member knows is not reported), a listed file that is a link
  to nothing (the base file in any case on Windows and macOS), an unresolvable variable and a drop-in named `*.jsonc`
  or with `.json` in another case are reported, never dropped silently (other names such as `10.yaml` or
  `10.json.bak` and sub-folders are ignored), and a later file's model, its `command` or `cost` list, or its
  entry of `mcp.servers`, `lsp`, `formatter`, `references` or `commands` replaces an earlier one as a whole, so a later
  `url` never keeps an earlier `headers` or `oauth` and an LSP `env` never reaches another server (`providers` and
  `agents` merge by key; a later agent entry without `disabled` is enabled again). A relative `ProgramFiles` falls back to `C:\Program Files`. Proof: `core/test/managed-settings.test.ts`,
  `cli/test/doctor-managed.test.ts`, `util/test/managed-path.test.ts`.
- Plugins in `.orbit/plugins`: `ConfigPluginSource.scan` skips untrusted directories. Proof:
  `test/project-trust.test.ts`, `packages/cli/test/trust.test.ts`.
- Shell snippets in commands: `ConfigCommandPlugin` refuses them with `UntrustedError`. Proof:
  `test/config/command-shell.test.ts`.
- Agent, command, skill, compat skill and output style files: `ProjectTrust.supplies` for the path, `ConfigMarkdown` for
  the text, `ConfigTrust.sanitize` and `sanitizeCommands` for what they may say. Proof: `project-trust.test.ts`,
  `test/config/markdown.test.ts`, `test/plugin/output-style.test.ts`.
- Instruction files (`AGENTS.md`, `ORBIT.md`): `ProjectTrust.reachable`, asked by `ConfigInstructionPlugin` and
  `SessionInstructions`. Proof: `test/instruction-discovery.test.ts`, `test/session-instructions.test.ts`.
- Paths that a file tool is given: `ProjectTrust.escapes`, asked by `FileAccess.resolve`. The `edit` tool's `validate`
  reads the file before any permission is asked, so it reads only when `resolve` reports no `externalDirectory`: a link
  out of an untrusted project is not read until the folder it leads to has been approved. Proof:
  `test/file-access.test.ts`, `test/tool-edit.test.ts` (that link, with a trusted project as the control),
  `test/tool-write.test.ts`.
- Language servers and formatters: `ProjectTrust.trusted()` in `Lsp` and `Formatter`. Proof: `test/lsp.test.ts`,
  `test/formatter.test.ts`.
- Executables that Orbit looks up itself (`git`, `rg`, shells, formatters, language servers, the sandbox tool, the
  Azure CLI check): `which` in `packages/core/src/util/which.ts` reads `PATH` and Orbit's own `bin` folder and never the
  working folder, unless `PATH` itself names it, for example with a relative entry such as `.` (see Known gaps). Proof:
  `test/util/which.test.ts`, `test/ripgrep-binary.test.ts`, `test/util/git-executable.test.ts`.
- Programs that Orbit starts by a bare name (`hg`, `git` when `which` finds none, `node` or `uvx` as the command of an
  MCP server, the pager's `cmd /c more`): on Windows Bun's spawn, Node's, cross-spawn and `cmd.exe` look in the working
  folder before `PATH` for a bare name, unless the process that starts it has `NoDefaultCurrentDirectoryInExePath`.
  Every Orbit process sets it in its own environment first (`ProgramLookup.install()` in
  `packages/util/src/program-lookup.ts`, called at the start of each entry, see class 10). `CrossSpawnSpawner` in
  `packages/util/src/cross-spawn-spawner.ts` installs it again before every launch, gives every child the variable too,
  a `.cmd` started by its full path included, and stops a running process with the `taskkill.exe` of `System32`. Proof:
  `packages/util/src/program-lookup.test.ts`, `test/effect/cross-spawn-spawner.test.ts`, `test/project.test.ts` (a
  folder with `.hg` and an `hg.exe`) and `test/mcp.test.ts`, and the `test/program-lookup.test.ts` of `packages/cli`,
  `packages/sdk` and `packages/server`. They delete the variable from `process.env` first, and those that run a decoy
  plant real `.exe` files. No test of its own covers the language server client, which starts a server through
  `cross-spawn` directly, or the bare `git` fallback (see Known gaps).
- Provider packages: inside the compiled binary `Provider.loadPackage` loads a built-in provider or one from the npm
  cache, and never resolves a name from the folder. Proof: `test/provider-compiled.test.ts`.
- Code Mode `fetch`: `PermissionWeb.request` for every hop, then `AddressGuard.check`. Proof: `test/codemode.test.ts`,
  `packages/util/src/address-guard.test.ts`.

**CLI and flow** (`packages/cli`, `packages/flow`):

- Workflow and suite modules, which are imported: `trustRefusal` with `imports`. Proof:
  `packages/cli/test/trust.test.ts`.
- Workflow and suite data files that carry commands, approvals or agents: `trustRefusal` with `defines`, listed by
  `workflowCommands`, `workflowApprovals`, `workflowAgents`, `workflowModels`, `suiteCommands`, `suiteAgents` and
  `suiteModels`. The models list is the fields that pick a model or add attempts (`model`, `retry.fallbackModels`,
  `retry.maxAttempts`, `maxIterations`, `maxRounds`, a judge's `model`, a suite's `models`): a node's `model` replaces the
  person's `--model` (`runner.ts`), so an untrusted clone would choose what the person pays for. Proof:
  `packages/cli/test/trust.test.ts`, `packages/flow/test/load.test.ts`, `packages/flow/test/models.test.ts`,
  `packages/flow/test/agents.test.ts`.
- Every command that starts work: `requireTrust`, `trustRefusal` and `warnUntrusted`. `orb acp` only warns, because the
  editor chooses its folders. Proof: `packages/cli/test/trust.test.ts`.
- The run store, `.orbit/runs.db`, and the worktree paths built from it: `Store.run`, `Store.runs`, `Git.clean` and
  `Git.worktree` accept one plain name only. Proof: `packages/flow/test/store.test.ts`,
  `packages/flow/test/git.test.ts`, `packages/cli/test/flow.test.ts`.
- Text printed to a terminal or stored in a title or a commit: `plain`, `progress` and `json` from `@orbit/flow/plain`.
  Proof: `packages/util/src/plain.test.ts`, `packages/cli/test/flow.test.ts`.
- What `orb run` prints (`packages/cli/src/run`): every line of JSON, which is each event of `json` and `stream-json`,
  the `result` object and the error that `reportRunError` prints, goes through `jsonLine` from `@orbit/flow/plain`.
  Every error line goes through `UI.error`, which writes it out line by line with `progress`, and so do the label of a
  step, the request for permission and the note about a tool call that the output limit cut off. The answer and the
  thinking lines of the default format are message content and still open (see Known gaps). The tool lines that
  `renderTool` and `renderToolError` draw in `run.ts` are closed: the title and the description of an inline tool, the
  title of a block, and the failed line go through `progress`, and a block body and the `--verbose` tool output go
  through `body`. So do the init, result and delta lines (`jsonLine`), the usage line and the summary of auto-rejected
  requests (`progress`), and the schema text output (`jsonLine`). Proof:
  `packages/cli/test/print.test.ts` ("a hostile $name input reaches no terminal through the $sink",
  "a hostile tool name", "--verbose tool output"),
  `packages/cli/test/run/noninteractive.test.ts` ("output channels"), `packages/util/src/plain.test.ts`.

**Terminal UI** (`packages/tui`):

- Plugins that the terminal UI imports in its own process: `trustedPluginDirectories` with `trust.startup`. Proof:
  `test/plugin-trust.test.ts`, `test/plugin-discovery.test.ts`.
- The trust dialog, bound to the folder in view when it opened: `TrustProvider` and `useTrustPrompt` in
  `src/context/trust.tsx`. Proof: `test/cli/tui/dialog-trust.test.tsx`.
- Run store text in the `/runs` dialog: `DialogFlowRuns` passes every string through `plain`. Proof:
  `test/component/dialog-flow-runs.test.tsx`.
- Message bodies on the session screen and in Mini: `bodyText` and `outputText` (`src/util/renderer.ts`),
  `entryBody` (`src/mini/entry.body.ts`) and `permissionPresentation` (`src/util/permission.ts`). Proof: one
  table-driven `captureCharFrame` test on the real components, each with a hostile row and a trusted control row that
  draws ordinary text unchanged. `test/body-sinks.test.tsx` holds the session screen: the user message, assistant
  text, reasoning, compaction, the assistant error and retry lines, the shell message and the shell, `execute`,
  generic, write, edit, patch and question tools (output, command, diff, path, error and diagnostic), plan, notices,
  skill names, loaded paths, workflow cards, the queued-prompt dock and its dialog, and the "Session failed" toast.
  `test/component/dialog-shell-output.test.tsx` holds the background shell views (the composer tab, the dialog header
  and the dialog body), `test/component/dialog-error-details.test.tsx` the error text of the details dialog, and
  `test/mini/footer.view.test.tsx` Mini's queued-prompt picker and its form rows. Also `test/util/renderer.test.ts`
  (the escaping), `test/cli/tui/form.test.tsx`, `test/mini/entry.body.test.ts` and
  `test/util/permission-body.test.ts`. Sinks that are routed through `bodyText` but have no frame test, and the
  places that are still open, are listed in Known gaps.
- Session titles in the session list (`dialog-session-list.tsx`) and the open dialog (`dialog-open.tsx`): both pass the
  title through `plain`. Proof: the hostile-title tests in `test/cli/tui/dialog-session-list.test.tsx` and
  `test/cli/tui/dialog-open.test.tsx`. The tab rail (`session-tabs.tsx`: both rails, the tooltip and the closed-tab menu),
  the sidebar (`sidebar.tsx`), the banner (`banner.tsx`), Home's recent list (`routes/home.tsx`), the agent-map dialog
  (`dialog-agent-map.tsx`) and the rename prompt (`dialog-session-rename.tsx`) pass it through `plain` too. Proof: one
  row each in `test/resume-title.test.tsx`, captured from the real app at 100 and 160 columns with a trusted control
  row. The tab rail's four title sites are pinned together, not one by one, because the rail is on screen in every row.
  The session-deleted toast, the `plugin/api.tsx` toast and the notification title (`notifications.ts`) pass `plain`
  and have no frame test (Known gaps).
- Window titles, the exit summary and the Mini splash: `terminalTitle`, `sessionEpilogue` and the splash's own filter.
  Proof: `test/util/renderer.test.ts`, `test/util/presentation.test.ts`, `test/mini/splash.test.ts`.
- The keybindings file: `Config.read` reads `keybindings.json` from the folder that holds `cli.json`, the person's own
  config folder, and from nowhere else, so a project folder cannot supply one. An entry only chooses keys for commands
  that exist, so nothing in it starts a program. A name or key that it holds reaches the screen only through `plain`, and
  a file that cannot be read, parsed or checked costs only itself (`KeybindingsFile.load` never rejects). The
  `/keybindings` command starts `$VISUAL` or `$EDITOR` through `openFile`, which finds it on `PATH` alone and starts it by
  the path it found, in the folder of the file. Proof: `test/config-v2.test.tsx` (the file is read from beside cli.json
  only, with a control), `test/keybindings-file.test.ts` (the hostile names and keys), `test/editor.test.ts` (the Windows
  decoy test, with a control).

**VS Code extension** (`packages/vscode`, which runs in VS Code's extension host: not an Orbit process, and shared with
every other extension):

- Whether the folder is trusted, and the question before work starts: `Controller` asks the server for the folder's
  trust, with a two-second limit, when it starts, on every trust, config and connection event, and in `send`, which every
  command, starter and button that sends a prompt ends in. `send` asks the person, once per folder, before a session
  exists. The server decides and enforces; what the extension adds is the question, and it never trusts a folder on its
  own account. So once some read has been answered, a later read that fails or is late leaves the chat going and costs
  a log line, as it does in the terminal UI. A server older than workspace trust has no such route and applies a
  folder's config unasked, and so does the first request that names the folder, because it boots the folder's location
  and imports its plugins. A 404 that comes after the limit looks like no answer, so until some read has been answered,
  with a status or with a 404, nothing that names a location goes out (`usable` in `Controller`): `models` returns
  nothing, choosing a model or a mode on a session changes only the local choice, `outputStyle` is not written (it
  names no folder, so the server would boot its own working folder), and `send` posts an error and creates no
  session; while nothing has answered each of them reads again first. When the server answered 404, `send` names
  `orb service restart`. In both states the only requests the server sees are the trust read, the event stream, the
  session list of the history picker and the reads of a session opened from history, which name no folder. After a grant, the folder
  VS Code opened is read again and must itself answer trusted: a re-read that fails or is late confirms nothing, the
  banner stays and the chat says it could not trust the folder. `orb run` stops on the same failures because it cannot
  ask. A withheld entry in the answer that does not fit is dropped alone (`readStatus`), so the banner and the question
  stay. Proof: `test/trust.test.ts` ("too late", "older than workspace trust", "only fails", "costs only itself"), and
  the table of commands and the scan of the doors in `test/manifest.test.ts`.
- The Runs view: what `orb flow ls` and `orb flow show` print from the clone's run store is decoded once in `runs` and
  `nodes` (`decodeRuns`, `decodeNodes`), keeping strings and finite numbers, and every string is written out with `plain`
  before the tree shows it. Proof: `test/runs.test.ts` (the usage with control characters and a cost that is not a
  number).
- The runner's loop notices: `loopNotice` writes the description of a synthetic message, which a model, a hook or a
  stored session can supply, out with `plain` before the chat shows it, live and when a session is opened from history.
  Proof: `test/recovery.test.ts` (the escaped notice, and the replay on open).
- The folder: the question shows the project's folder that the server names, the grant is made for that folder, and it
  counts only when the answer names it and the folder VS Code opened reads as trusted too. Proof: `test/trust.test.ts`
  ("trusts the folder the server named", "takes the stricter answer", "does not call a folder trusted").
- Folder names, file names and kinds that the server sends: `view` and `Controller.grant` write them out with `plain`
  before the banner, the dialog, the status bar tooltip or a chat note shows them. Proof: `test/trust-text.test.ts`,
  `test/trust.test.ts` ("writes out the control characters of a folder's name").
- The program the extension starts: `find` and `launch` in `src/program.ts` look on PATH only, skip empty and relative
  entries and a relative path, and start the program by its full path. `orbit.executable` is read from the user's own
  setting only (`configured`), has machine scope, and the extension is declared off in a workspace that VS Code does not
  trust. The terminals start the program that `find` returned as their own process, and type nothing into a shell. Proof:
  `test/program.test.ts` (planted `orb.exe` decoys, with the variable deleted, under Bun and under a real Node process)
  and `test/manifest.test.ts`.
- Config above the project: named, with no command, because a grant goes to the project's folder and not always to the
  one that holds it. Proof: `test/trust-text.test.ts`, `test/trust.test.ts` ("names config above the project").

**Build** (`packages/cli/script`):

- What the compiled binary reads from the folder it starts in: `autoload` and `runtimeRequires`. Proof:
  `packages/cli/test/compile-autoload.test.ts`, `packages/cli/test/compile-runtime-requires.test.ts`.

## Adding a surface

1. Add it to the inventory above and, if it reads a file that the repository supplies, to the reader list in the header
   of `packages/core/src/config/trust.ts`.
2. Say what it can make Orbit do: read a file, import code, spawn, approve, choose an agent, a mode, a model or a
   provider, reach the network, print text. Each of those is a class below.
3. If it is a config key, an agent field or a command field, classify it in `ConfigTrust.classification`. The tables are
   checked at compile time (`satisfies Table<Info>`, `Table<ConfigAgent.Info>`, `Table<ConfigCommand.Info>`), so a new
   field does not compile until it has a treatment: `inert`, `withhold(kind)`, `flag(kind, when)` or `filter(apply)`.
4. Pick the gate: `ProjectTrust.trusted()`, `reachable`, `supplies` or `escapes` in the server, `requireTrust` with
   `imports` or `defines` in a command, `trust.startup` in the terminal UI. A surface that `ProjectTrust.status` can
   list is covered by the held-back check that `orb run` makes. One that it cannot list, such as a module that a command
   imports, needs its own option on `trustRefusal`.
5. Write the marker test with its control (see the test recipe) and the failure matrix of class 7, and record the
   mutation in the PR.
6. Add a note to [upgrading](upgrading.md) if a person can see the change.

## The test recipe

Every class below is tested the same way, and each class adds only what is particular to it.

1. **Write the attack as a marker file.** A hostile plugin, module, command snippet, agent file or config that writes
   `ran` to disk when it executes. Put it where a clone would: in an untrusted folder that holds nothing else back. A
   hooked repository hides the bug, and the clean clone is what the round-2 audit found.
2. **Run the real thing.** The real `orb` against a real private server and a scripted model
   (`packages/cli/test/trust.test.ts`, which runs without `ORBIT_TRUST_PROJECT`, as the shared background service does),
   the real app fixture for the terminal UI (`createAppFixture` in `packages/tui/test/fixture/app.ts`), the real config
   stack for core. Core tests trust every folder by default (`packages/core/test/preload.ts` sets
   `ORBIT_TRUST_PROJECT`), so a test of a gate builds `WorkspaceTrust.configured({ implicit: false })`, as
   `untrustedProject` in `packages/core/test/fixture/project-trust.ts` does. Otherwise "nothing ran" passes vacuously.
3. **Rule out the other vacuous pass.** "Nothing ran" also passes when the environment hides the attack. Some shells
   set `NoDefaultCurrentDirectoryInExePath=1`, and the shell that agents run in is one of them. It makes Windows skip
   the working folder when it looks up a program, so no decoy runs, neither a `.bat` or `.cmd` that `cmd.exe` finds nor
   an `.exe` that Bun's spawn finds. A test of a program lookup deletes the variable from `process.env` of the test
   process first and restores it afterwards (`currentDirectoryOnPath`, and `withCurrentDirectoryOnPath` for an effect,
   in `packages/core/test/fixture/decoy.ts`). It also plants a real `.exe` decoy (`plant` in the same file) next to the
   `.bat`: `cmd.exe` reads the variable from the environment of the child, and a spawn reads it from the process that
   starts the program, so a `.bat` decoy says nothing about an `.exe`.
4. **Assert the refusal.** The refusal text, exit status 1, the marker absent and the scripted model never asked.
5. **Add the control.** The same file in the same test with `--trust` or a granted folder, and the marker present. That
   proves the file is live, so the test cannot pass because the file was never executable. For a program lookup the
   control is the same decoy started by its full path (an `.exe`) or as a shell would start it, by a `cmd.exe` that does
   search the folder (a `.bat`), so that the test fails loudly when the decoy cannot run. The `.exe` control is "starts
   a planted program when it is given the path of the program" in
   `packages/core/test/effect/cross-spawn-spawner.test.ts`.
6. **Record the mutation.** Remove the gate and watch the test fail, then write that mutation in the PR. The review runs
   it again.
7. **Lift the skips.** Tests that skip on your platform (real symlinks need `canLinkFile`, hook execution skips on
   win32) run in Git Bash, a Linux container or WSL before the PR, or the PR says they are unverified.

## The classes

### 1. Code runs from the project folder before, or without, a trust check

**Rule:** Before writing a loader, add its surface to the inventory and gate it on "this folder is trusted" in the
process that does the work, before the first read, import or spawn. Never gate on "something is held back".

**Why:** A cloned repository chooses what is in its folder, so any reader that imports, evaluates or spawns what it
finds there runs the repository's code with the person's rights before they have decided anything. M1 found more than
ten such surfaces one at a time: plugins, command snippets, agent files, language servers and formatters, the terminal
UI's own plugin import, workflow modules, replay and eval, and the server process itself.

**In M1:** the first gate for `orb flow run` was "untrusted and something is held back", so a clean clone had its
`workflow.ts` imported, and its top-level code run, by `flow run`, `resume` and `eval` (round-2 audit), and
`flow replay` imported it with no check at all. Language servers, formatters and the terminal UI's own plugin import
were found the same way, one at a time (#14, #15). Seven fix commits over three days.

**Ask early:** at the spec, write the one-page inventory above, every loader of repository content with its process and
its gate, before the first trust task. It names every surface that M1 found over the next three days.

**How to comply:**

- Put the surface in the inventory and the reader list.
- In the server, ask before the first read or spawn. `ProjectTrust.trusted()` reads at most one stored grant, so ask it
  freely:

  ```ts
  Effect.gen(function* () {
    const trust = yield* ProjectTrust.Service
    if (!(yield* trust.trusted())) return []
    // Read, import or spawn only from here on.
  })
  ```

  `Lsp` and `Formatter` do this, `ConfigPluginSource.scan` skips untrusted directories, and `ConfigCommandPlugin` throws
  `UntrustedError` for a command with a shell snippet (`ConfigTrust.shellSnippet`, `hasShellSnippet`) before it scans,
  asks about or runs a span. A file that carries code, such as hooks in front matter, must ask
  `ProjectTrust.allows(file)` first. Nothing consumes `allows` yet, because those hooks do not exist, and it still mixes
  the live decision with stale stamps for about 100 ms after a grant or a revoke. Fix that (N2 in Known gaps) before
  the first consumer is written.

- In a command that loads a file from the folder, call `requireTrust` (or `trustRefusal`, when you report the refusal
  yourself) before the load. Pass `imports` for a file that the command imports and `defines` for a file whose commands,
  approvals or agents it carries out. Both refuse an untrusted folder whatever it holds back. Without them the check
  refuses only a folder whose config holds something back, which is right for `orb run` and `orb loop`, because they
  import nothing. `strict` refuses any untrusted folder, and `orb -p` passes it (`handlers/print.ts`): a clean clone's
  `AGENTS.md` still steers a model whose tool calls run unasked under the default rules. Whether `orb run` and
  `orb loop` should be strict too is an open owner question. This is `execute` in `packages/cli/src/commands/handlers/flow/execute.ts`:

  ```ts
  Effect.gen(function* () {
    const trust = yield* trustOptions(file, "workflow")
    yield* requireTrust(client, directory(), { grant: input.trust, ...trust })
    const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
  })
  ```

- The terminal UI imports plugins itself, so the server's gate does not apply. Filter the directories with
  `trustedPluginDirectories(directories, trust.startup.trusted(), trust.startup.above())`
  (`packages/tui/src/plugin/discovery.ts`) and import nothing before the first answer.
- Look at what the libraries you call do by themselves: parsers, YAML tags, resolvers (classes 10 and 11).

**How to test:** the recipe above. In M1 the marker tests are `packages/cli/test/trust.test.ts`,
`packages/core/test/config/command-shell.test.ts` and `packages/core/test/project-trust.test.ts`. Cover every command
that can load the file, not only the one you changed (class 12).

**Review questions:**

- Which loaders, spawners and importers does this change add or touch, and where is each one in the reader list and the
  inventory?
- What does the gate return for a repository that holds nothing else back (no `orbit.json`, no `.orbit`)?
- Does the gate sit in the process that does the work, before the first read or import, and not after?
- Does a library that this code calls evaluate, require or resolve names by itself (parsers, YAML tags, resolvers)?
- Does a trusted control run prove in the test that the hostile file is live?

### 2. Data files that carry commands, approvals or agent choices

**Rule:** Treat any repository data file that reaches a shell, a permission decision or an agent choice as code. List
what it carries with a structural reader that uses the runner's own validator, gate on that list, and test that gate and
runner agree.

**Why:** A YAML workflow or JSON suite needs no import, yet `check` nodes run shell commands with no permission step,
`permissions: auto` approves everything its agents ask, and the `agent` of a node picks whichever of the user's agents
has the widest rules, because an agent's own rules come after the global ones and the last match wins. A fresh clone
that holds only `workflow.yaml` could therefore act as the user.

**In M1:** modules, commands, approvals and agent choice were closed one at a time, in four commits over six hours, for
what is one question: what does this file carry? The round-2 fix agent had declined to gate YAML commands because
widening a gate needed the owner. Earlier, argument text was scanned for shell snippets after `$ARGUMENTS` was
substituted, so text that a model supplied could run (#6).

**Ask early:** at the spec, ask "which files do these commands read, and what does each carry?". It covers the module
and its data twins (commands, approvals, agents) at once.

**How to comply:**

- For each file kind, list what it can make the code do: spawn, approve, choose an agent, a path, a model or a provider.
  The lists live in `packages/flow/src/load.ts`: `workflowCommands`, `suiteCommands`, `workflowApprovals`,
  `workflowAgents`, `workflowModels`, `suiteAgents`, `suiteModels`, and `importsModule` for a module, which is code and
  not data. A field that picks a model or a budget in a data file belongs in the models list as it does in
  `ConfigTrust.classification`, and a test in `models.test.ts` compares the list with what the runner is handed.
- Read the file as the runner does. A workflow is read through `validate`, the function `compile` calls, so the gate
  scans what the runner executes and fails as the loader fails. Do not write a second parser that can drift.
- Count a template. `{{plan.text}}` is filled in when the node starts, and a reply can say `auto` or name an agent.
- When you add a node type or an option that starts a command, approves or chooses an agent, add it to the list. The
  comment on `execute` in `packages/flow/src/yaml.ts` and the one in `evaluate` (`packages/flow/src/eval.ts`) name the
  lists.
- Hand the lists to the gate with `trustOptions(file, kind)`, which `flow run`, `flow resume` and `eval` share. Replay
  answers from the recording, so it is held only for a module and contacts no server for a YAML file.
- Print the file's text with its control characters written out (class 9).

**How to test:**

- A marker command in a `check` node, in the `checks` of a `verify` node and in the `checks` of a suite task, in an
  untrusted folder that holds nothing else back. Assert refused, marker absent and the model never asked. The `--trust`
  control writes the marker, and a replay is not held up and contacts no server.
- A gate-versus-runner test. Run the real runner and `evaluate` against a client that records every agent, approval and
  command it is asked to use, and require each one to be in the gate's list (`packages/flow/test/agents.test.ts`). Feed
  awkward shapes through both: anchors, merge keys, `__proto__`, duplicate keys, tags, flow style, quoted keys,
  `type: null`, templates and non-text values (`packages/flow/test/load.test.ts`).
- Mutations: drop judges, team members, the author agent or falsy values from a lister and watch the tests fail.

**Review questions:**

- What can a data file in the repository make this code do: spawn, approve, choose an agent, a path, a model or a
  provider?
- Is each of those listed by a reader that shares the runner's validator, or by a second parser that can drift?
- Does a template placeholder, filled in at run time, count?
- What does the gate do for replay, resume and eval of the same file?
- Does the refusal show the file's text with control characters written out?

### 3. Trust is bound to the wrong folder or identity

**Rule:** Decide trust for one resolved folder identity and carry that same value through ask, display, grant and act.
Where two components resolve a root differently (server and terminal UI, cwd and file, project and holder, link and real
path, `.git` file and worktree list), the stricter answer wins.

**Why:** Trust is per folder. Whenever the folder asked about, shown, granted or acted on differed, a grant went to the
wrong place, advice did nothing, or code ran from a folder that nobody had decided. A folder can also claim another
folder's identity through files that it controls.

**In M1:** config above the project shared the repository's grant (#14), `orb run --session` checked the folder it
started in and not the session's (#18), the trust dialog granted the folder in view at the choice and not the one it
showed (#19), and `orb flow` asked about the working directory and not the folder that holds the workflow file
(verification round 5). A `.git` file that names a git directory whose `commondir` is a trusted repository's made git
report that repository as the main checkout, so a never-trusted folder shared its grant and ran its hook (#22 round 3).
Eight fix commits in all.

**Ask early:** at the design, write down what a trust decision is keyed to and thread one folder value through every
consumer, including the terminal UI and the CLI, which resolve roots themselves.

**How to comply:**

- Grants are keyed by the real path of the project's canonical root (`WorkspaceTrust.key`, lower-cased on win32). The
  home directory and filesystem roots are never stored and never implied. `ProjectTrust.status`, `grant` and `revoke`
  answer for the Location's project, so do not key trust by a path you did not resolve.
- Config above the project follows the decision for its holder (`ConfigTrust.holder`, `ConfigTrust.covered`).
  `Trust.Withheld.directory` is the folder whose trust lifts an entry, and the refusal advice must name it.
- `Project.resolve` counts the main checkout only when `git worktree list` also lists this folder, so a `.git` file
  cannot borrow another repository's identity.
- In a command, `trustRefusal` looks up an existing `--session` and checks that session's folder, and asks about the
  folder that holds the workflow file as well (`holderRefusal` words that refusal). A server's trust mode comes from
  `ServerProcess.trustOptions(mode, env)` in `packages/cli/src/server-process.ts` (the background service never follows
  `ORBIT_TRUST_PROJECT`) and from `trust.implicit ?? false` in `packages/server/src/routes.ts`.
- In the terminal UI, the dialog is bound to the folder in view when it opened, and it closes without counting as "Not
  now" when another folder comes into view. The plugin gate asks about the folder the UI was started in
  (`TrustProvider directory={cwd}` in `packages/tui/src/app.tsx`), and `trust.startup.above` carries the folders above
  the project that the server holds back.
- When the components disagree, take the stricter answer and log it.

**How to test:**

- Record the folder on every trust request and grant, and assert that asked, shown, granted and acted on are one folder.
  The terminal UI harness records `location[directory]` of every request
  (`packages/tui/test/cli/tui/dialog-trust.test.tsx`).
- Run both directions (a session in a hooked repository continued from a clean folder, and the reverse) and nested
  layouts: parent and child, outer, middle and inner, a linked worktree, a junction, a broken `.git`, a crafted `.git`
  with `commondir`, differently cased Windows spellings, and a workflow file in another folder than the cwd.
- Use real servers and the real app fixture. The control is that the folder that is trusted does run.
- Test the advice: run the command that a refusal gives and check that what it listed is lifted.

**Review questions:**

- Which folder is asked about, which is shown to the person, which is granted and which does the work? Name the single
  variable.
- What happens when the terminal UI or the CLI and the server resolve the project root differently?
- Can a folder make a file, a link or a `.git` entry that changes which identity it has?
- Does the advice in a refusal actually lift what it lists?
- Is there a stricter-wins rule for a disagreement, and is it logged?

### 4. Containment is judged by name instead of real path

**Rule:** Decide whether a path is inside a trusted folder from its real path, at the moment of reading: follow links,
dangling links and not-yet-existing targets, and allow for UNC paths and Windows case and spelling. Ask `ProjectTrust`,
which follows links down from the nearest ancestor that exists, and use `FSUtil.contains` or `path.relative` only on
two paths that are already real, never string comparison and never `FSUtil.resolve` or `fs.resolve`. Every reader of a
file that the repository supplies asks `ProjectTrust` and is in the reader list.

**Why:** A repository ships its links and a clone recreates them. A link named `AGENTS.md` or `.orbit/agents` can point
at an SSH key whose text then goes to the model provider with the first request, and a write can land outside the
project.

**In M1:** instruction files (round-3 audit), then output styles, agent files, commands, skills and the file tools (#22
review) followed a link out of an untrusted project, so a link to a credentials file would have reached the model
provider with the first request. The round-1 audit had passed instruction files as "read verbatim, no code execution"
and checked the wrong property. Three fix commits for a rule that had already been written once, privately, for
`{file:}` in `config/variable.ts`. Earlier, `{file://host/share/x}` made Windows connect to a network share just by
opening a folder (#14), and a differently cased path loaded `~/orbit.json` twice (#8).

**Ask early:** when you write the rule for the first reader, start the inventory of every reader of repository files.
The reader list in the `ConfigTrust` header arrived only after the third round.

**How to comply:**

- Ask `ProjectTrust.reachable(file)` before the text of a file goes into the prompt,
  `ProjectTrust.supplies(source, file)` for the files of a config directory or another product's root (it logs
  `config file skipped` once), and `ProjectTrust.escapes(file)` for a path that a tool is given:

  ```ts
  Effect.gen(function* () {
    const prompt = yield* trust.reachable(file) // may the text of this file go into the prompt?
    const readable = yield* trust.supplies(source, file) // may this file of a config directory be read?
    const leads = yield* trust.escapes(absolute) // where does a link out of the project lead, if one does?
  })
  ```

  All three follow links, count a file that is not there yet by where a link in its path would put it, and answer for a
  link that points nowhere by where it points. `FileAccess.resolve` asks `escapes` and treats such a path as external.

- A place that a link leads out to is the person's to allow, never Orbit's. Orbit gives every agent allows for folders
  of its own (`Agent.folders`: the global config folder, the temporary folder, shell and tool output), and a link that a
  repository ships into one of them took that allow: a read, a write, a search or a command through it asked no folder
  question, and the shell, Grep and Glob approvals named the link. `FileAccess` marks the external folder of such a target `escaped`, `authorizeExternal`
  passes those resources to `Permission.assert` as `escaped`, and Permission decides them without Orbit's allows
  (compared by value, so an agent's copy of them is still Orbit's). The target's `place` is the real place, which the
  shell (`metadata.workdir`), Grep and Glob (`metadata.path`) and Patch (`metadata.filepath`) put on the request. A path
  that a shell command names in its text is checked the same way when it is a plain word or a redirect target
  (`ShellParse.operands`, `FileAccess.escaped`); a path the command builds as it runs is not (Known gaps).
- Windows has several spellings of one file, and a check made with one spelling misses the others. `FileAccess.resolve`
  refuses a `:` after the drive or share (`name::$DATA`, `name:stream`, and `HKLM:` or `FileSystem::C:\x`, which a shell
  reads as a drive) with the error type `file.spelling`, and names each part with `~` by the long name its 8.3 short name
  stands for, matched by file ID, refusing one it cannot tell. `FSUtil.resolveFrom`, which the tools and the displays
  share, drops a `\\?\` or `\\.\` prefix and trims trailing periods and spaces as Windows does: one period off an inner
  part, every period and space off the last. Bun's own file calls keep `cfg.`, while a shell, ripgrep and `Bun.write`
  drop it, so a link checked with Bun's `stat` alone was not seen while a program started in `cfg.` ran through it.

- Config references go through `ConfigVariable.substitute` with `within`, which expands no `{env:}`, refuses
  `{file://host/share}` before the disk is touched, and checks the real path of a file.
- Never decide containment with `FSUtil.resolve` or `fs.resolve`. Both return the lexical path for a part that is not
  there, so a new file under a link is judged to be inside while a write lands outside. With `repo\link` a junction to a
  folder outside, `FSUtil.resolve("repo\link\new.txt")` returns that same path and `FSUtil.contains` of `repo` and that
  path is true. Once the file exists, `resolve` follows the link and `contains` is false, which is too late. This was
  the file-tool hole of #22 round 3. Ask `ProjectTrust` (`escapes`, `reachable` or `supplies`) instead: it follows links
  down from the nearest ancestor that exists (`lead` in `packages/core/src/project-trust.ts`, private to its layer, so
  a caller asks through those three), and a link that points nowhere leads where it points.
- Compare with `FSUtil.contains(parent, child)`, which uses `path.relative` and so ignores case on win32, only on two
  paths that are already real: a path that `fs.resolve` returned for something that exists, or a folder that you
  resolved first. Never `===`, `startsWith` or `!==` on two paths.
- A name that becomes a file name is one plain name (the output style rule in
  `packages/core/src/plugin/output-style.ts`, and the `Name` pattern of the memory tool in
  `packages/core/src/tool/plugin/memory.ts`).
- Check at the moment of reading, not once when the file is discovered.

**How to test:**

- Build the link as a directory junction on Windows, which needs no privilege, and as a real symlink where `canLinkFile`
  allows it (`packages/core/test/fixture/symlink.ts`). For every reader in the list cover a link to a file, a link to a
  folder, a dangling link, a loop, a not-yet-existing target through a link, a `..` name and a UNC path. For UNC, assert
  that no disk access happens: record the paths the file system is called with (`packages/core/test/fixture/recorded-fs.ts`)
  and assert that none names the share, rather than a time limit, which a fast failing host meets either way. A link's own path is a drive path, so a listing
  of the share it leads to shows under the link's path: the recorder also keeps each call as `method path` (`calls`), and
  the share-link rows and the deny row of `file-access-spelling.test.ts` assert that every recorded call naming the link
  or a path below it is a `readLink`, because any other call follows the link and opens the share. Two mutations fail
  them: a `fs.stat(absolute)` before `trust.escapes(absolute)`, and `refuseShare` replaced by `Effect.void`.
- Untrusted: the file is not read and `config file skipped` is logged once. After a grant the file appears without a
  restart. The trusted control follows links as before.
- For a tool, point the link at a folder that Orbit allows by itself, such as the global config folder, so that only the
  `escaped` mark stands between it and a silent read: `permission.test.ts` ("Permission for a place a link leads out
  to"), `tool-shell.test.ts`, `tool-search.test.ts`, `tool-patch.test.ts`, and the rows over a real `orb acp` in
  `packages/cli/test/acp/permission-files.subprocess.test.ts` (a junction and a relative symlink, answered once and
  rejected, with a trusted control).
- On Windows, one table per level for the spellings, under a deny and an ask rule, with the plain name as the control:
  `file-access-path.test.ts` (resolve), `tool-windows-spelling.test.ts` (each file tool, Grep, Glob and the shell over
  the production plugins), `file-access.test.ts` (a link seen through a trailing period or space, its 8.3 name, `\\?\`
  and case),
  `packages/util/test/fs-util.test.ts` and the `orb acp` rows. A row that Bun would pass anyway, because Bun opens
  `new.sh.` by its literal name, also checks that the rule decided.
- Mutation: make `reachable`, `supplies` and `escapes` answer true and watch the tests fail. The real-symlink tests skip
  on accounts without the privilege, so run them on Linux before closing a milestone.

**Review questions:**

- Which new reader of repository-supplied bytes does this add, and is it in the reader list?
- Is containment checked on the real path, for a target that does not exist yet and for a dangling link?
- Is any path compared as a string (`===`, `startsWith`, `!==`)? On Windows too?
- Does a link into a folder that Orbit allows by itself (`Agent.folders`) still ask, and does the approval name the real
  place?
- On Windows, which spellings reach the check: a stream, an 8.3 name, trailing periods and spaces, a `\\?\` prefix?
- Is containment decided by `FSUtil.resolve` or `fs.resolve` followed by `FSUtil.contains`? Both keep the lexical path
  for a part that is not there, so a new file under a link passes.
- Does the text go to the model provider, a tool write or the terminal, and what is the worst file a link could point
  at?
- Is the check made at read time and not once at discovery?

### 5. Names and IDs from untrusted stores become paths, refs or titles

**Rule:** A name, ID or ref read from a file that the clone ships (run store, config, workflow) is hostile data.
Validate its exact shape where it enters, with an SQL `GLOB` or as one plain segment, and never join it into a path, a
git ref, a glob or a session title before that.

**Why:** `.orbit/runs.db` is a file in the repository. `orb flow clean` removed `.orbit/worktrees/<id>` for every
finished run in it, so an ID of `../../../victim` deleted a folder beside the repository, `..` its `.orbit` and `../..`
the repository itself, with no trust check and no server contact. The VS Code **Clean runs** button runs it.

**In M1:** found by the round-4 audit, after the review of the previous fixes had flagged it only as a pre-existing
"follow-up". `output_style` was not checked as a name either, so `../..` climbed out of `output-styles` (#22 round 3).

**Ask early:** when a command first reads a store that a clone ships, every column is hostile. Put the shape filter in
the store.

**How to comply:**

- `Store.run` and `Store.runs` return only rows whose ID matches `RUN_ID_GLOB` (`run_<14 digits>_<6 hex>`), in SQL, so
  `LIMIT` counts runs (`packages/flow/src/store.ts`).
- `Git.clean` and `Git.worktree` refuse anything that is not one plain name (`PLAIN_NAME`, `runFolder`) before
  `git worktree remove` or `add`, `rm` or `branch -D`, and `Git.worktree` refuses a node named `.`, `..` or empty
  (`packages/flow/src/git.ts`). A `*` in an ID would otherwise become a ref pattern that matches other runs' branches.
  Take the shape check as the model and not the rest of `Git.clean`, which keeps the entries of `git worktree list` with
  `directory.startsWith(prefix + path.sep)`, the string comparison that class 4 forbids. It compares paths that git
  printed with a folder that `runFolder` has already made safe, so it is harmless today, but do not copy it.
  `@orbit/flow` does not depend on `@orbit/util`, so its follow-up is a `path.relative` check, not `FSUtil.contains`
  (Known gaps).
- For every identifier in a change, say where it comes from: the runner, the person, or a file that a clone can ship.
  Validate the last at the boundary and pass typed values inward.
- A command that reads such a store and then acts destructively (`rm`, `git branch -D`, `worktree remove`) needs a trust
  step, or a shape check that makes the action safe whatever the store says.

**How to test:**

- Plant a store row (or a config value) for each hostile shape: `../../../victim`, `..`, `../..`, an absolute path, glob
  and ref characters, NUL, empty, and a name that is another run's prefix. Run the real command in a clone that has a
  sibling folder. Assert that the sibling folder, the repository, `.orbit` and `runs.db` are intact and that the command
  says "no such run" (`packages/cli/test/flow.test.ts`, `packages/flow/test/store.test.ts`,
  `packages/flow/test/git.test.ts`).
- Run it again after trusting the folder: the containment must hold when the folder is trusted too.
- Mutation: remove the shape check and watch the clone test delete the repository.

**Review questions:**

- Where does each identifier in this change come from: the runner, the person, or a file that a clone can ship?
- Is it validated where it enters (SQL, schema) rather than where it is used?
- Does any command that reads the store act destructively (`rm`, `git branch -D`, `worktree remove`) without a trust
  step?
- Does the identifier also reach a title, a commit subject or a log line?

### 6. Network egress: URL forms, redirects, address spellings, rebinding and lookup failures

**Rule:** Only `http:` and `https:` URLs reach `fetch`. Every request that a repository or a script can influence asks
permission per hop, as `webfetch` does, then passes `AddressGuard.check`, then connects to the address that was checked,
with the name kept only in `Host` and SNI. A name that resolves to nothing, fails to resolve or answers with names is
refused.

**Why:** Code Mode `fetch` lets a script choose the method and the headers of its request. One approval of an origin
then reached other hosts by redirect, loopback, the LAN or a cloud metadata endpoint (credentials), in spellings that a
URL parser accepts and a string check does not.

**In M1:** Code Mode `fetch` shipped with no permission check, and Bun's `fetch` also reads `file:`, `data:` and `s3:`
URLs, so a script could read local files. #9 added `PermissionWeb.request`, which refuses every scheme but `http:` and
`https:` before anything is asked or sent. A `fetch` to `127.0.0.1` approved once still followed a 302 to `localhost`
with no second ask (verification round 1), because #9 had merged with "redirects are not re-authorized" as a known
limit. Then one spelling or endpoint per round: `*` and trailing dots in host rules (#3), IPv6 forms of IPv4 such as
mapped, NAT64, 6to4, Teredo and ISATAP (raised in the review of #21), six IPv6 metadata endpoints that were only
"private" (#22), DNS rebinding, and a lookup error that counted as "no addresses" (verification round 4). Six commits
for one class.

**Ask early:** at the spec for `fetch`, the gate, the per-hop redirect asks and an address guard belong together, and
one table covers every spelling.

**How to comply:**

- Build the permission request with `PermissionWeb.request` (`packages/core/src/permission/web.ts`). It throws for a URL
  that is not `http:` or `https:`, rejects wildcard hosts, strips trailing dots, validates the method, and returns the
  resources, the aliases and what "always" saves. Code Mode `fetch` calls it before any ask or I/O, so a `file:`,
  `data:` or `s3:` URL never reaches Bun's `fetch`, which would read it.
- `CodeModeWeb.request` (`packages/core/src/codemode/web.ts`) reads the call with the function that authorizes it, so
  what is authorized is what is sent. `fetch` does not let the runtime follow a redirect: it sends with
  `redirect: "manual"`, follows at most 10 hops, and asks about each one like a call of the script's own.
- Then check the host, and connect to the address that was checked. Resolving a name is itself a request, so ask
  permission for the host first:

  ```ts
  const checked = await AddressGuard.check(host, { allow: allowLocal ? ["loopback", "private"] : [] })
  if (!checked.allowed) throw new Error(`${host} is ${checked.refusal.kind}`)
  // Connect to checked.connect; keep the name only in Host and the TLS serverName.
  ```

  `AddressGuard.classify(address)` classifies one address, and holds an IPv6 address that stands for an IPv4 one to the
  IPv4 rules as well.

- The only way to local servers is `experimental.allow_local_fetch`, set in the user's own config (the config of an
  untrusted folder ignores it). `orbit.config.web` hands it to `Tool.Editor.web({ allowLocal, lookup })`. It opens
  loopback and private networks and no others: link-local and metadata addresses stay blocked whatever it says.
- Keep the private and metadata lists as tables matched exactly, never as a substring or a prefix test. Do not add a
  network call to anything but a configured model provider, MCP server or integration (AGENTS.md).

**How to test:**

- Table-driven in `packages/util/src/address-guard.test.ts`: every spelling (decimal, hex, octal, shortened, fullwidth
  digits, ideographic full stops, IPv6 compressed and long, zone ids, brackets, an embedded dotted quad, and the mapped,
  compatible, translated, NAT64, 6to4, Teredo and ISATAP forms) against every kind, with `allow` set to loopback and
  private to prove that metadata and link-local stay closed and the neighbours stay private.
- End to end with an injected `lookup` (`packages/core/test/codemode.test.ts`): a first answer that is public and a
  later one that is metadata (the later answer must never be used), a failing lookup, an empty answer, names as answers;
  each redirect hop asks and connects by its own answer; method and credential rewriting; the 10-hop cap; TLS with a
  name-only certificate.
- The scheme: `file:`, `data:`, `s3:`, `javascript:`, `ftp:`, `blob:` and `ws:` URLs fail with "URL must use http:// or
  https://" before any ask or I/O (`packages/core/test/permission/web.test.ts`, "rejects a scheme other than http and
  https", and `packages/core/test/codemode.test.ts`, "fails a URL that is not http(s) before any permission ask or
  I/O").
- Mutations: native redirects (11 tests fail), the guard before the ask, the guard removed.

**Review questions:**

- Which URLs or hosts can a script or a repository influence, and does each hop (redirect, import, proxy) ask
  separately?
- Can a URL with another scheme (`file:`, `data:`, `s3:`) reach `fetch`? Bun's `fetch` reads all three.
- Is the address that was checked the address that is connected to?
- What does the code do when the lookup throws, returns nothing or returns a name?
- Is every private or metadata list a table matched exactly, IPv6 forms and embedded IPv4 included?
- Can a setting meant for dev servers open metadata or link-local addresses? It must not.

### 7. Failing open, and dropping silently

**Rule:** Give every gate and decoder an explicit result for error, unknown input, an old server, a timeout and a
malformed sibling. The default is to refuse with one log line, and one bad entry never silently disables the guards next
to it.

**Why:** A gate that answers "nothing held back" on a 404, a decoder that drops a whole file for one bad hook, or a
policy key that validates and does nothing lets the dangerous path run with no sign: a guard hook stops blocking, or a
clone's module runs against an old service.

**In M1:** a shared settings file was decoded all or nothing, so one unreadable `SubagentStop` hook dropped the
`PreToolUse` guard beside it, with nothing logged (#7), and exit status 127 from a guard script that was not found read
as "no block" (#12). An older server's 404 on the trust route meant "nothing held back", so the gates failed open
against a service that was started before the upgrade (#18, #22). The pattern recurred with every new gate.

**Ask early:** at the design step of each gate, write its failure matrix.

**How to comply:**

- Decode entry by entry, and report what is skipped at its path: `HookConfig.decode` in
  `packages/schema/src/config/hook-config.ts`, called by `normalizeHooks` in `packages/core/src/config/normalize.ts`.
- Write the matrix before the gate: 404, 401, 5xx, a timeout, an undecodable answer, a server older than the feature,
  and a malformed entry beside a guard. Each row gets a result, and the result is to refuse or stay off.
- For a command that checks trust, the older-server row is explicit. A command that only checks held-back config goes
  ahead with a warning on stderr. One that would import a file or run what a file defines stops with `unanswered(...)`,
  which names `orb service restart`, `--standalone` and `--trust` (`packages/cli/src/util/trust.ts`).
- A setting that validates is enforced, or it warns once that it is not: `hooks.disabled`, `managed_only` and `http` do
  (`UNENFORCED_POLICIES` in `packages/core/src/config/plugin/lifecycle-hooks.ts`).
- Parse a switch as its siblings are parsed (`1` and `true`, case-insensitive; `ORBIT_DISABLE_COMPAT` once took only
  `1`).
- Put a time limit on every check that a UI waits for. The terminal UI's trust reads time out after two seconds and keep
  the last answer (`packages/tui/src/context/trust.tsx`).
- `ConfigTrust.classification` is exhaustive at compile time, and a field it does not know is held back.

**How to test:**

- A failure matrix per gate, one test per row. Use the reviewer's exact file for a malformed sibling: a `PreToolUse`
  shell guard that exits 2 beside a `SubagentStop` prompt hook whose model has no provider.
- A stub server that answers 404 for the route: assert that nothing was imported or run, that no model was asked and
  that the stub saw only the expected paths.
- A status read right after a revoke must equal the status after the reload, and a policy key set to something that the
  code does not enforce yet must produce a one-line warning.

**Review questions:**

- What does this code return or do on error, on unknown input and on an older peer? Is that "allow"?
- If one entry in a list or a file is invalid, which neighbours stop working, and is it logged?
- Is every setting that validates actually enforced, or does it warn once that it is not?
- Is a switch parsed the way its siblings are (`1` and `true`)?
- Is there a time limit on every check that a UI waits for?

### 8. Permission widening through agent, mode, default, scope-order and approval-display choices

**Rule:** Anything that selects which rules apply is a permission: the agent, the mode, `hidden`, the default agent,
approvals, scope order, aliases and wildcard host patterns. Classify it in the `ConfigTrust` table, give untrusted
sources deny-only authority, and show approvers what they are approving.

**Why:** An agent's own rules are appended after the user's global rules and the last match wins. Naming the user's most
permissive agent, hiding built-in agents, widening a subagent set or approving `auto` therefore gets actions done with
no question, while the user's `ask` rules look intact.

**In M1:** Plan mode let a session spawn any agent, and a `* * allow` rule after Plan's rules let a general child edit
and run shell (#2). `default_agent`, `agents.*.disabled` and `warming` were classified inert (#14), and then a command's
`agent` and an agent's `mode` and `hidden` followed one field at a time (#22 round 3). Approvers saw only `cat id_rsa`
for `cd ~/.ssh && cat id_rsa` (#6).

**In M2:** approvals showed something other than what the tool acted on, and verification found the members one at a
time:

- an old field name `path` beside the field the tool runs (`file_path`, or NotebookEdit's `notebook_path`) in the
  terminal UI, Mini and VS Code (round 4);
- the calling Code Mode (`Execute`), Workflow or Patch call's own input in place of the request, in the terminal UI and
  Mini (round 5), and in ACP (round 6);
- only the first file of a multi-file patch (round 5), a moved file without its old name, and a Code Mode `POST`, `PUT`
  or `DELETE` titled as a `GET` (round 6);
- in ACP, keys the model added to its own input: a `files` array drawn as diffs and a `cwd` drawn as the folder a shell
  command runs in (round 6 re-checks);
- in ACP, `~` and drive spellings drawn inside the project while the tool acted in the home folder (the final check,
  past the round cap).

Each client worked out what to show from the model's raw input, so each fix closed one member and left the next.

**Ask early:** at the classification table. The first-wave reviews of #2 and #4 had already shown that "which agent
runs" is a permission.

**How to comply:**

- Classify each new field in `ConfigTrust.classification` (`info`, `agent` and `command`). Ask of every field: does it
  choose which rules, agent or mode apply? Then it is a permission, `withhold("permissions")`, and a permission list
  keeps deny rules only (`denyRules`). `sanitizeCommands` withholds a command's `agent`, and `warming` keeps only
  `false`. `tool_execution` keeps a `max_concurrency` at or below the default of 10 (`toolExecution`): the user's own
  value is not visible to the filter, so a repository cannot raise the cap above 10. It can still set a higher value
  than a user's own lower one, up to 10.
- A field that picks a model, a provider or a budget is withheld too, as `providers`, so that an untrusted folder
  cannot choose the most expensive of the models that you configured, another provider that you configured, or a larger
  step allowance. The owner decided this: `model` (top-level, in every agent, so also `title`, which
  receives a migrated `small_model`, and `side`, and in every command) and an agent's `steps` are
  `withhold("providers")`.
  `fallback_model` and `output_token_cap` are withheld the same way (`test/config/trust.test.ts` pins each row). Never
  classify such a field as inert.
- Ask whose rules come last, and make sure that an untrusted source cannot be last. When a switch that guards gets
  enforced, as `hooks.disabled` has yet to be, read it in policy-authority order and not by value precedence, or a
  repository could switch off the user's guard hooks (#7).
- Name agents by configuration, never by constant. `Agent.select()` is the fallback
  (`packages/core/src/tool/plugin/plan-mode.ts`), and Plan mode's subagent set is `PlanMode.allowedSubagents`, built
  from `readOnlyAgents` and enforced in `packages/core/src/tool/plugin/subagent.ts`.
- Show the whole thing that is approved: the full span and not just the commands that the scanner found
  (`ConfigCommandPlugin` asks about the span as written when its commands alone would mislead), the method and the URL
  (`PermissionWeb.request` metadata), the folder.
- Build the approval from the permission request, never from the model's raw tool input. The server must put on the
  request everything the approval shows: the resolved file or folder, with every spelling `FileAccess.resolvePath`
  accepts (`~`, `~/` and `~\`, the Git Bash, Cygwin and WSL drive forms, relative paths and `..`) resolved as it
  resolves them for the runner; the method and URL; the diff of each file. The terminal UI, Mini, ACP and VS Code take
  the place, file, method and diff only from those values; the raw input may appear only in a view labelled as raw
  input. A recorded call keeps the keys its schema drops at decode, so the raw input can carry a `cwd`, a `files` array
  or an old field name that the runner never uses. When the request lacks a value, add it on the server in the same PR.
  New and changed approval code follows this now; `clients-ux-61` (M3) moves the existing clients onto it (Known gaps).
- Show a place where the tool acts. A client prefers what the request carries: the resources of a request about files,
  `metadata.workdir` of a shell request and `metadata.path` of a Grep or Glob request, all resolved by the server. A
  path it takes from a tool's input goes through `FSUtil.resolveFrom`, which the tools use too, so `~` is the home
  folder and `/c/...` the Windows drive. `packages/cli/test/acp/tool.test.ts` holds the spelling table for ACP,
  `permission-files.subprocess.test.ts` the rows over a real `orb acp`, and `packages/tui/test/util/path-format.test.ts`
  the terminal interface's and Mini's.
- Through a link in an untrusted project, the place is where the link leads: the server resolves it
  (`FileAccess.Target.place`) and puts it on the request, and the folder question names it, so no approval shows a link
  as a folder of the project (class 4).
- An allow that Orbit adds by itself is not the person's: it never decides a place that a link leads out to, and only
  the person's own rules and saved approvals do (`Permission.AssertInput.escaped`, class 4).
- A rule keyed on one field does not cover the others. Grep and Glob ask their own rules about the pattern, so the path
  they search goes through the Read rules first (`FileAccess.authorizeRead`), and a Read deny of `*.env` covers a Grep
  of `.env`. A rule matches the name a file has on disk: on Windows `FileAccess.resolve` turns every spelling of a file
  into that name before a rule sees it (class 4).

**How to test:**

- Reproduce with the real config stack: a global `edit: ask`, an agent `autopilot` with `edit: allow`, and an untrusted
  folder that names `autopilot` through each route (`default_agent`, a command's `agent`, a workflow node, a judge or a
  member, an agent file's `mode`, `hidden`). Assert that the write is rejected and that `ProjectTrust.status` lists what
  was withheld. With `--trust` or a trusted project it works as before (`packages/cli/test/trust.test.ts` has this
  config).
- Plan mode: a config of `* * allow` must not make `general` spawnable.
- Completeness: the classification table compiles only if every field of `Config.Info`, `ConfigAgent.Info` and
  `ConfigCommand.Info` is classified, and `packages/core/test/config/trust.test.ts` ("covers every field") checks it.
- What is shown is what runs: `clients-ux-61` adds a matrix test (not on `main` yet) over every tool, every path
  spelling the runner accepts, every key a model can add to its input and every client. It must fail if any client
  shows a place, file, method or diff other than the one the runner uses, and it includes an `orb acp` subprocess row in
  an untrusted folder with a trusted control. After it lands, a new tool, client or path form adds its row; before then,
  a PR adds a table-driven test of the same shape for what it changes.

**Review questions:**

- Does this field choose which rules, agent or mode apply? Then it is a permission: where is it classified?
- Does it pick a model, a provider or a budget? Then it is withheld as `providers`, never inert.
- Whose rules come last, and can an untrusted source be last?
- Can the approver see the whole thing that is approved (full span, method, URL, folder)?
- Does any client work out what it shows from the model's raw input instead of the request's resolved values? Can a
  key the model adds, or a `~`, Git Bash or relative spelling, make it show another place than the runner uses?
- Does an allow that Orbit adds by itself decide something a repository can steer, such as a place a link leads to?
- Which fields of the call do its rules key on, and is a path among the fields that no rule sees?
- Does a default or fallback name an agent or a mode by constant instead of by configuration?

### 9. Terminal control characters in printed or stored text

**Rule:** Every string that came from a file, a run store or a workflow, and every session title, that reaches a person
(stdout, stderr, JSON, a terminal UI frame, a toast, a session title, a commit subject, an exit summary, a splash)
passes through `plain`, `progress`, `json` or `terminalTitle` at the sink. Keep a sink inventory per command. The text
of a session's messages is not `plain`'s: it trims and writes line breaks out, so it cannot be the sink for a message
body. A body passes `bodyText` at the renderer instead (see "How to comply").

**Why:** A clone can name its files and workflows with escape sequences. Printed raw, an OSC sequence sets the window
title, an erase-line or a carriage return hides the command that a refusal asks the person to look over, and a
right-to-left override reorders text. A title written to the user's own database outlives the clone.

**In M1:** the sinks were found one at a time: the trust refusal (#22 round 1), run-store text in `orb flow` (round 4),
task IDs in `orb eval` (round 5), then failures printed through `Cause.pretty`, the `/runs` dialog, session titles,
commit subjects, the exit summary and the Mini splash (round 6). `JSON.stringify` leaves DEL, C1 controls (U+009B starts
a CSI and U+009D an OSC) and format characters raw, and a BEL ends the window-title sequence early. Seven commits and
five review rounds for one defect.

**Ask early:** when the escaping is first written, for the refusal, start a sink inventory for every command that prints
repository text.

**How to comply:**

- `plain(text)`, `progress(line)` and `json(value)` live in `@orbit/util/plain` (`packages/util/src/plain.ts`, which
  loads no other module, so core reaches it too) and `@orbit/flow/plain` re-exports them. `plain` trims, writes control and format characters out and puts a line break on one line.
  `progress` keeps indentation and takes any value. `json` writes every character of Unicode category C as `\uXXXX`, so
  `JSON.parse` returns the original value. Never `JSON.stringify` a string from a file for a terminal. `jsonLine` is
  `json` on one line, and it writes U+2028 and U+2029 out as well, for output that a program reads line by line, as it
  reads `orb run --format stream-json`.

  ```ts
  process.stderr.write(`${progress(line)}\n`)
  process.stdout.write(`${json(result.output)}\n`)
  process.stdout.write(`${jsonLine(event)}\n`)
  renderer.setTerminalTitle(terminalTitle(title))
  ```

- A message body, which is model text, tool output, a question or its answer, a plan, a notice, a skill or file name from a
  tool, or a tool error, passes `bodyText` (`packages/tui/src/util/renderer.ts`) where the terminal UI and Mini draw
  it. It is `body` in `packages/flow/src/plain.ts`, so the escaping is the one `plain` uses: line breaks and tabs stay,
  a carriage return alone, C0 controls, DEL, C1 controls and the bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E
  and U+2066 to U+2069) are written out as `\x1b` or `\u{202e}`, where the person can see them. Other format characters
  stay, since a zero-width joiner holds an emoji sequence together. Program output (shell, `execute` and generic tool
  output) passes `outputText` instead, which first turns a lone carriage return into a line break, as Mini's
  `cleanRunText` does, because progress meters redraw a line with one; commands and approval prompts use `bodyText`,
  where a carriage return is an ordinary character for the shell. Mini passes every body through `entryBody`
  (`packages/tui/src/mini/entry.body.ts`); the session screen passes its sinks through `bodyText` or `outputText`
  one by one, and the approval prompt goes through `permissionPresentation` and `permissionAlwaysLines`
  (`packages/tui/src/util/permission.ts`), which serve both clients. In `routes/session/index.tsx`, `stringValue` only
  parses (IDs, lookup keys and comparisons read the value as it came) and `displayValue` is the parsed value for
  drawing, so a path with a control character still finds its diagnostics. A parser stays raw and the drawing site
  writes out (`parseApplyPatchFiles` returns paths and patches as they came), and a name that is title-cased is
  title-cased first and written out after, because `Locale.titlecase` would otherwise turn `\x1b` into `\X1b`.
  Each value is written out once, at the place that draws it. Shell output goes through `stripAnsi` first, so whole
  sequences are removed, and `outputText` writes out what it leaves, such as a lone ESC, BEL and backspace. A new place
  that draws such text calls `bodyText` or `outputText`, and a new row goes into the test of the component that draws
  it, with a trusted control row.
- The output of the status line command passes `printable` (`@orbit/util/plain`, used by `ansiSpans` in
  `packages/tui/src/util/ansi-spans.ts`). It writes out control characters as control pictures, lone surrogates and
  every format character, and keeps two things that `plain` would write out: the Private Use Area (Co glyphs,
  where Powerline and Nerd Font put theirs) and U+200D (an emoji sequence). Neither reorders or hides text, and the
  command is the person's own setting. `ansi-spans.test.ts` and `prompt-status-line.test.tsx` pin both exceptions, next
  to the U+202E, U+200B and U+2066 rows.
- The CLI writes every failure line by line through `progress` (`packages/cli/src/index.ts`). The terminal UI uses
  `terminalTitle` (`packages/tui/src/util/renderer.ts`), `sessionEpilogue` (`packages/tui/src/util/presentation.ts`) and
  the Mini splash (`packages/tui/src/mini/splash.ts`), and `DialogFlowRuns` passes every store string through `plain`
  and reads token counts with `Number`.
- The runner writes session titles and commit subjects through `plain` (`packages/flow/src/runner.ts`). Text that is
  stored outlives the clone, so escape it at write time.
- For the command or the screen that you touch, list every place where a string from a file, a store or a workflow can
  reach a person, and name the function that escapes it there.

**How to test:**

- Hostile text, `ESC ] 0 ; pwned BEL`, `ESC [ 2 K`, the C1 CSI and OSC characters, DEL, CR, a right-to-left override and
  a zero-width space, placed in every field that the command prints: names, IDs, gate messages, error messages, file
  names and usage numbers.
- For every command and every channel (stdout, stderr, `--format json` and `otlp`, a terminal UI frame and toast, the
  session title in the server's database, a git log subject, the exit summary), assert that no character of Unicode
  category C remains on any line apart from real line breaks, that the written-out text is present, and that
  `JSON.parse` of printed JSON equals the original value. In terminal UI tests poll `renderOnce` and `captureCharFrame`.
- Tests: `packages/util/src/plain.test.ts`, `packages/flow/test/agents.test.ts` (titles and commit subjects),
  `packages/cli/test/flow.test.ts`, `packages/cli/test/run/noninteractive.test.ts` (`orb run`),
  `packages/tui/test/component/dialog-flow-runs.test.tsx`, `packages/tui/test/util/renderer.test.ts` (bodies drawn
  with `captureCharFrame`), `packages/tui/test/mini/entry.body.test.ts`,
  `packages/tui/test/util/presentation.test.ts` and `packages/tui/test/mini/splash.test.ts`. Mutation: revert each sink
  one at a time.

**Review questions:**

- List every place where a string from a file, a store or a workflow can reach a person: which function escapes it at
  that sink?
- Does it also reach a title, a commit message, a log line, a toast or a failure message that is built before any trust
  check?
- Is JSON printed with `json()` and not `JSON.stringify`?
- Does a numeric column come from the store? Read it with `Number()`.
- Is the text stored, so that it outlives the clone? Escape it at write time.

### 10. The process resolves names from the folder it starts in

**Rule:** Assume that the single binary starts in an untrusted repository before any trust check
(`orb trust --standalone`, `serve --stdio`). Keep the autoload options off except `package.json`, never resolve a
package that is not built in by name from inside the binary, and replace each lookup that a bundled dependency leaves to
the runtime and that can load code. Hold programs to the same rule. On Windows a program that is started by a bare name
is looked up in the working folder before `PATH`, by Bun, Node, cross-spawn and every `cmd.exe`, unless the process that
starts it has `NoDefaultCurrentDirectoryInExePath` in its own environment. So call `ProgramLookup.install()`
(`packages/util/src/program-lookup.ts`) first in every process entry, find an executable with `which` (`PATH` only,
unless `PATH` itself names the folder), and start it through `CrossSpawnSpawner`, which gives every child the variable
too, a `.cmd` started by its full path included. Never hand a bare name to `exec`, `cmd /c` or another way of starting a
`cmd.exe` yourself outside the spawner.

**Why:** Bun applies the `paths` of a `tsconfig.json` in the start folder to the binary's own imports, resolves any bare
name that the bundle leaves open from the folder's `node_modules`, and loads a native library from an npm package that
its lookup finds. A committed file then runs in the server process before the trust gate is asked. Programs are found
by three lookups on Windows, and the working folder is in all of them. A library lookup that searches it before `PATH`,
as the npm `which` package does with no option to skip it, finds a `git.exe` or `rg.exe` that the repository ships.
Bun's spawn, `node:child_process` under Bun, the lookup that cross-spawn makes and Node's `execFile` look in the working
folder of the child before `PATH` for a bare name's `.exe` or `.com`, so a clone that commits an `hg.exe` ran it while
`Project.resolve` identified a folder with a `.hg`, and one that commits a `cmd.exe` ran it as the pager of
`orb session list`. And `cmd.exe` looks in the current folder before `PATH` for a program, a `.bat` and a `.cmd` alike:
cross-spawn runs every `.bat` and `.cmd`, and every name that it cannot resolve, through `cmd.exe /d /s /c`, and `exec`
and `cmd /c` start one by design. That `cmd.exe` also looks in the folder for each name that a script starts by name,
and not only for the one that Orbit passes: the command wrappers that npm installs globally start `node` by name unless
a `node.exe` sits beside them, which it usually does not, so a `node.bat` in the working folder runs in its place even
when the wrapper itself was started by its full path.

One variable stops the last two lookups, and it has to be in two places. The lookup of a spawn reads
`NoDefaultCurrentDirectoryInExePath` from the environment of the process that starts the program, and never from the
environment that it hands to the child. A variable that only the child has stops the `.bat` that a `cmd.exe` would find
and lets the `.exe` run. A `cmd.exe` that the child is or runs reads its own environment, so the child needs the
variable too. So the class is every lookup of every program that Orbit starts, and not one library.

**In M1:** a repository's `tsconfig.json` `paths` ran at the start of `orb trust --list` (verification round 5), and
`Provider.loadPackage` resolved a provider by name from the repository's `node_modules` (#22 round 8). The prescribed
`autoloadPackageJson: false` then broke packages that name their entry by `main` or `exports`, so it is back on. The
next hole was js-yaml's lazy `var _require = require; _require('esprima')`, which ran a committed
`node_modules/esprima/index.js`. A dynamic probe found it, and a scan for names would not have, because the require is
aliased. The same probe closed Babel's browserslist lookup and fff's native-library lookup (on Windows the embedded path
says `~BUN`, not `$bunfs`). Then the review of that fix found one more kind of name: `which` in
`packages/core/src/util/which.ts` wrapped the npm `which` package, so on Windows a committed `git.exe` ran while Orbit
gathered version control info (`orb session list --standalone` ran it seven times) and a committed `rg.exe` ran during a
file search, before any trust. That was the second blocker, and its fix made the lookup read `PATH` only. Closing it
turned up two more members of the class, both in `CrossSpawnSpawner`. Cross-spawn handed a bare `hg` to `cmd.exe`, so a
folder with a `.hg` directory and an `hg.bat` ran that file while `Project.resolve` identified the project, before any
trust check (the pager `cmd /c more`, `git` when it is not on `PATH` and the command of an MCP server are started by
name as well). And stopping a process ran `taskkill` by name through `exec`, so a `taskkill.exe` or `taskkill.bat` in
the folder ran instead of the system one. The shell that agents run in sets `NoDefaultCurrentDirectoryInExePath`, which
makes `cmd.exe` skip the folder, so a decoy test run there passes without testing anything. The fix for `hg.bat` gave
the child the variable, and the review of this page found that this was half of the answer: a bare name's `.exe` still
ran through Bun's spawn, which reads the variable from the process that starts the program and ignores the child's copy.
`Project.resolve` ran an `hg.exe` of the folder, and `orb session list` ran its `cmd.exe` as the pager. The spawner's
tests had planted `.bat` decoys only, which `cmd.exe` finds through the child's environment, so they said nothing about
an `.exe`. The fix is `ProgramLookup` (#22, `9b79fd1`): every Orbit process installs the variable in its own environment
first, and the spawner installs it again and gives it to every child. It is half of the answer again for a plain
`Bun.spawn`, which hands its child the environment that the process started with, so the terminal UI's status line
starts `cmd.exe` by its full path and passes `ProgramLookup.environment(undefined)`, and a test plants a decoy for it,
with a control run. The earlier holes took four fix commits in three rounds, and the executables three more.

**Ask early:** when the single binary was first compiled (M0), and when `orb trust --standalone` and `serve --stdio`
first started the server inside the repository, audit what the process resolves from its start folder before any trust
check: modules, packages, native libraries, executables, and what each lookup that finds a program does (a library's,
the spawn of Bun and Node, and every `cmd.exe` that it starts). No earlier audit had looked, and M1's rounds found each
kind in turn.

**How to comply:**

- `autoload` in `packages/cli/script/autoload.ts` is spread into the compile options by `packages/cli/script/build.ts`.
  `autoloadBunfig`, `autoloadDotenv` and `autoloadTsconfig` are false, and `autoloadPackageJson` is true. Change none of
  them without a control build that changes only that option.
- `runtimeRequires(replaced)` and `verifyRuntimeRequires(replaced)` in `packages/cli/script/runtime-requires.ts` are
  three `onLoad` replacements (js-yaml's `js/function` type, Babel's `resolve-targets`, fff-bun's download module), and
  the build fails when a replacement matched no module. Add one when a dependency leaves a name to the runtime and the
  lookup can load code. Two names are not replaced, because nothing loads code through either today (Known gaps, under
  "Build checks"): `node-gyp`, which the bundle leaves to the runtime and npm only looks up, and `bufferutil`, which is
  not in the bundle today and would be left to the runtime, and resolve from the working folder, if a change ever
  bundled the npm `ws`.
- `Provider.loadPackage` (`packages/core/src/provider.ts`) fails with `LoadError` inside a compiled binary
  (`Bun.isStandaloneExecutable`) for a package that is not built in. Otherwise it installs with `npm.add` and resolves
  from the npm cache with `resolveModule`. A plain file path no longer loads: write a `file:` URL.
- Find an executable with `which` in `packages/core/src/util/which.ts` and with nothing else. It feeds `gitExecutable`,
  `RipgrepBinary`, `ShellSelect`, the built-in formatters and language servers, the sandbox tool and the Azure CLI
  check. It reads `PATH`, then Orbit's own `bin` folder, and never the working folder, unless `PATH` itself names it,
  for example with a relative entry such as `.`, which resolves against it (Known gaps). It looks at each `PATH` entry
  by its full name, because the npm `which` package that it wraps searches `process.cwd()` first on Windows and has no
  option to skip it. An empty `PATH` entry, which a shell reads as the current folder, is skipped on every platform, a
  quoted entry is read without its quotes, `PATHEXT` and the executable bit apply as before, and a name that already has
  a directory is checked as given. Do not call the npm package yourself or write a second lookup, and do not swap in
  `Bun.which`: it returns `null` for a quoted `PATH` entry, takes no `PATHEXT`, and the core also runs under Node and
  workerd, where there is no `Bun`.
- Call `ProgramLookup.install()` (`@orbit/util/program-lookup`, `packages/util/src/program-lookup.ts`) first in every
  process entry, before anything starts a program. It sets `NoDefaultCurrentDirectoryInExePath=1` in the process's own
  environment on Windows, and does nothing elsewhere. Bun's spawn, `node:child_process`, cross-spawn's lookup and Node's
  `execFile` read the variable from the process that starts the program and ignore the one in the child's environment,
  so a variable that only the child has stops `.bat` decoys and lets an `.exe` run. The entries that call it are the
  `orb` CLI (`packages/cli/src/index.ts`, which also runs the server, the terminal UI, the services and the flow
  runner), `ServerProcess.start` (`packages/server/src/process.ts`), `EmbeddedHost.create`
  (`packages/sdk/src/internal/host.ts`) and the npm launcher `packages/cli/bin/orb.cjs`, which has the line inline
  because the file ships alone. A new entry (a binary, a worker host, an embedding) adds its own call. A process that is
  not one of these does not have the variable. The VS Code extension host is one, and the extension does not call it
  there, because the host is shared with every other extension: it finds `orb` on PATH itself and starts it by its full
  path, so there is no bare name to look up (`find` and `launch` in `packages/vscode/src/program.ts`). An application
  that embeds `@orbit/client` and starts its default service command, a bare `orb`, has to do one of the two, as the SDK
  host and the extension do. And the `.cmd` shim that npm writes for a global install starts `node` by name in a
  `cmd.exe` before `orb.cjs` runs: it is npm's file, and no Orbit code reaches it.
- Start a program through `CrossSpawnSpawner` (`packages/util/src/cross-spawn-spawner.ts`). It calls
  `ProgramLookup.install()` before every launch, so nothing that goes through it depends on an entry having run, and on
  Windows it gives every child `NoDefaultCurrentDirectoryInExePath` in its environment (`ProgramLookup.environment()`):
  a program started by a bare name, by its path or as a command line run with `shell`, whatever environment it is
  handed. So every `cmd.exe` in that process tree skips the working folder: the one that cross-spawn starts for a `.bat`
  or `.cmd` or for a name that it cannot resolve, the one that Orbit starts by name for what it runs, such as the
  pager's `cmd /c more`, and the one that runs a `.cmd` started by its full path, a `which` result included, which looks
  up by name whatever its script starts, as npm's global command wrappers start `node`. A `.cmd` that `PATH` holds still
  starts by name. A bare name in a command line that the spawner runs with `shell` no longer finds a file that only the
  working folder holds, and `.\build.cmd` still works ([upgrading](upgrading.md)).
- Never hand a bare name to `exec`, `execSync`, a `shell` option or `cmd /c` outside the spawner: each one starts a
  `cmd.exe`, and only the spawner makes sure that the program gets the variable whatever environment it is handed. Give
  a system tool its full path. Stopping a process on Windows runs the `taskkill.exe` of `%SystemRoot%\System32` with
  `execFile`, where it used to run `taskkill` by name through `exec`.
- A `Bun.spawn` without an `env` hands its child the environment that the process started with, and not a variable that
  `install()` set after that. `ProgramLookup.install()` stops Bun from finding a `cmd.exe` of the working folder, but
  the `cmd.exe` that it starts has no variable and looks in the folder for what it runs by name (measured with Bun 1.4.2
  on Windows, where `node:child_process` and `cross-spawn` do pass the live `process.env`). A `Bun.spawn` that starts a
  `cmd.exe`, as the terminal UI's status line and the flow runner's shell step do, passes
  `env: ProgramLookup.environment(undefined)` or goes through the spawner.
- One member of the class is still open: a relative `PATH` entry. Three more rest on `ProgramLookup.install()` alone,
  with no test of their own: the language server client, the bare `git` fallback and the terminal UI's external editor.
  Known gaps lists each with its task. A change must not widen one.
- When a dependency or a dynamic import changes, look in the unminified bundle for `__require(`, a `require` that is
  assigned, `createRequire`, `import.meta.resolve`, `new Function`, `eval`, `dlopen` and imports of `#` names. The
  binary imports no `#name` at runtime, and a `package.json` `imports` field would map one to a file of the repository.
  When the set of dependencies changes, probe the build rather than reading it: put a marker-writing decoy in
  `node_modules` for each package name in `bun.lock` and see which ones run.
- Finish with the real binary, built with `bun run build --single --skip-install` in `packages/cli` and started with an
  isolated home, on Windows (from a shell where `NoDefaultCurrentDirectoryInExePath` is deleted, in a folder that holds
  decoys) and on Linux.

**How to test:**

- Compile a tiny program with the release autoload options, imported from `packages/cli/script/autoload.ts`, and with
  the runtime-requires plugin. Start the binary in a folder that holds marker-writing decoys: `tsconfig.json` `paths`,
  `baseUrl` and `extends`, `jsconfig.json`, `package.json` `imports`, a bunfig `preload`, a `.env` with `BUN_OPTIONS`, a
  `node_modules` decoy for every bare name that the bundle leaves open, and a fake native-library package. Assert exit
  0, no marker, and that fff finds no library.
- A control built with each option on, or the plugin off, must write the marker, so the test cannot pass because the
  folder never had a way to run.
- Executables, on Windows: put marker-writing decoys in the folder that the process starts in, named after programs
  that Orbit starts by name and that `PATH` also holds: real `.exe` files (`hg.exe`, `cmd.exe`, `node.exe`, `git.exe`,
  `rg.exe`), a `.bat` and a `.cmd` (`hg.bat`, `hg.cmd`, `npx.cmd`), and a `taskkill.exe` and a `taskkill.bat` in the
  folder of the Orbit process. `plant` in `packages/core/test/fixture/decoy.ts` compiles each `.exe` with `Bun.build`, no
  compiler needed, and the program writes `ran.txt` with its own file name and arguments, so a failure names what ran.
  For a script that Orbit starts by its full path, start a `.cmd` by its full path that runs a name which only a `.bat`
  of the working folder holds, or a copy of a global npm command wrapper, which starts `node` by name, with a `node.bat`
  in the folder, as a user-configured MCP server does. Run the real thing: `orb session list --standalone` starts git,
  its pager starts `cmd /c more`, a file search starts ripgrep, `Project.resolve` on a folder with `.hg` starts `hg`, an
  MCP server starts its command, `orb flow clean` starts git outside the spawner, the npm launcher starts `powershell`,
  and stopping a running child runs `taskkill`. Assert no marker, with the real program still found on `PATH`, and a
  `.cmd` that `PATH` holds still starting by name (`packages/core/test/util/which.test.ts`,
  `packages/core/test/ripgrep-binary.test.ts`, `packages/core/test/util/git-executable.test.ts`,
  `packages/core/test/effect/cross-spawn-spawner.test.ts`, `packages/core/test/project.test.ts`,
  `packages/core/test/mcp.test.ts` and `packages/cli/test/program-lookup.test.ts`). The ones that run a decoy return
  early off win32, so they have to be run on Windows.
- Test each entry that sets the variable: start it with the variable removed and check that it is set before anything
  starts a program (`packages/sdk/test/program-lookup.test.ts` for `EmbeddedHost.create`,
  `packages/server/test/program-lookup.test.ts` for `ServerProcess.start`), or that a decoy of the working folder does
  not run (`packages/cli/test/program-lookup.test.ts`, for the `orb` CLI through `orb flow clean` and for the launcher
  `orb.cjs` under Node). `packages/util/src/program-lookup.test.ts` covers `ProgramLookup` itself.
- Delete `NoDefaultCurrentDirectoryInExePath` from `process.env` of the test process before the run and restore it
  afterwards (`currentDirectoryOnPath`, and `withCurrentDirectoryOnPath` for an effect, in
  `packages/core/test/fixture/decoy.ts`). Some shells set it, and the shell that agents run in is one: Windows then
  skips the folder, no decoy runs, and the test passes whether or not the code is right. Giving the child an `env`
  without it changes nothing for an `.exe`, because a spawn reads the variable from the process that starts the program.
  Add the control from the test recipe, the same decoy started by its full path, so that the test fails loudly when the
  decoy cannot run. When you touch a test of a lookup, plant the kinds it does not: the tests that run a decoy plant
  `.exe` files (`cross-spawn-spawner.test.ts`, `project.test.ts`, `mcp.test.ts`, the CLI's `program-lookup.test.ts`) and
  `.bat` files (`cross-spawn-spawner.test.ts`, `project.test.ts`), and the lookup tests plant `.cmd` and `.exe` files and
  check which file is returned (`which.test.ts`, `git-executable.test.ts`, `ripgrep-binary.test.ts`).
- Mutation: go back to the npm package's own lookup in `which`, take `ProgramLookup.install()` out of an entry or the
  spawner, take the variable out of the spawner's child environment, or run `taskkill` by name through `exec` again, and
  watch the tests fail on Windows.
- The build fails if a replacement matched nothing (`packages/cli/test/compile-autoload.test.ts`,
  `packages/cli/test/compile-runtime-requires.test.ts`, `packages/core/test/provider-compiled.test.ts`).

**Review questions:**

- Does this change add a dependency or a dynamic import whose name the bundler cannot see (an aliased `require`,
  `import.meta.resolve`, `createRequire`)?
- Does the binary start in a folder that the user chose, before the trust check, and what does the runtime read from it?
- Was it tested on the real built binary on Windows and on Linux?
- Is a package ever loaded by name from the working folder instead of from the npm cache?
- Does it find an executable by name with `which` and start a program through `CrossSpawnSpawner`? Bun's spawn, Node's,
  some resolvers and every `cmd.exe` search the working folder first on Windows. `which` keeps it out unless `PATH`
  itself names it, and the spawner keeps it out for every program that it starts, a bare name and a full path alike.
- Does the code run in a process whose entry called `ProgramLookup.install()` first? A new entry (a binary, a worker
  host, an embedding) adds the call, and a program that a process without it starts looks in the working folder.
- Does it start a `cmd.exe`, or hand a bare name to something that does (`exec`, `cmd /c`, a `.bat` or `.cmd`, a name
  that cross-spawn cannot resolve) outside the spawner?
- Does the test delete `NoDefaultCurrentDirectoryInExePath` from `process.env`, plant `.exe` decoys (`hg.exe`,
  `cmd.exe`, `node.exe`) as well as `.bat` and `.cmd` ones, start a `.cmd` by its full path, and carry a control that
  proves the decoy runs where the variable is not set?

### 11. Parsers whose engines evaluate content

**Rule:** No reader may evaluate content. Parse Markdown front matter only through `ConfigMarkdown`, whose evaluating
engines are disabled. Never call a parser library directly, and test every spelling with a marker-writing file.

**Why:** gray-matter evaluates front matter that opens with `---js` or `---javascript`, so any Markdown file that a
clone ships (a command, an agent, a skill, an output style) ran code as soon as the location loaded, before any gate was
asked.

**In M1:** the first blocker of the milestone, in the review of #15. It was reproduced with `---js`, `---javascript`,
`---JS`, `---JavaScript` and `--- js`, and it contradicted the spec's premise that skills and output styles are text.
Passing options to gray-matter also bypasses its cache, which is keyed by content and had kept a failed parse as a
success. The same class at build level: js-yaml's `!!js/function` type loads esprima when js-yaml loads (class 10).

**Ask early:** at the spec. "Skills and output styles are text" was a premise that nobody had tested. One look at
gray-matter's default engines, or a marker test per reader written with the spec, finds it.

**How to comply:**

- `ConfigMarkdown.parse` and `ConfigMarkdown.parseOption` (`packages/core/src/config/markdown.ts`) are the only callers
  of gray-matter. Its `engines.javascript` throws "JavaScript front matter is not supported", and `parseOption` returns
  `undefined` so that the reader skips the file:

  ```ts
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  ```

- The readers behind it are `CommandFile.load`, `AgentFile.load` and `skill-file.ts` in
  `packages/core/src/config/plugin/`, `OutputStylePlugin` (`packages/core/src/plugin/output-style.ts`) and
  `ProjectTrust.status`, which reads through the first two. JavaScript front matter is refused in every config
  directory, the user's own included.
- For a new parser or file format, read its default engines, tags, caches and what it loads on its own. A spec's claim
  that a file kind is "just text" is a claim to verify against the parser, not to assume. Workflow YAML is read with
  `Bun.YAML.parse` and JSON with `Bun.file().json()`, and neither evaluates anything.

**How to test:**

- A marker file written by front matter in each spelling (`js`, `javascript`, `JS`, `JavaScript`, ` js`, and for a new
  reader CRLF line endings, `coffee` and `!!js/function`), through each reader: the parser refuses (`parseOption` is
  `undefined`), the reader skips the file and the marker is absent. `scriptedMarkdown` in
  `packages/core/test/fixture/front-matter.ts` writes it, and the tests are in
  `packages/core/test/config/markdown.test.ts`.
- The control: the unprotected parser runs the file. Parse the same content three times and compare, to catch the cache
  bug.

**Review questions:**

- Which library parses this file, and what are its default engines and caches?
- Is a spec's claim that a file kind is "just text" verified against the parser instead of assumed?
- Do all readers, `ProjectTrust.status` included, go through one parser module?

### 12. Entry points and process boundaries each need the gate

**Rule:** List every command, subprocess and process that can start work or load a file (`run`, `loop`, `flow run`,
`resume` and `replay`, `eval`, `orb -p`, `acp`, `serve --stdio`, the terminal UI's plugin loader, IDE buttons, SDK hosts), and
route each one through the one gate. A gate in the server does not reach the CLI or the terminal UI process.

**Why:** The same loader had several doors. A check on `orb flow run` did not cover replay or resume, the server's
plugin gate did not cover the plugins that the terminal UI imports in its own process, and `orb acp` cannot stop at all.

**In M1:** `orb flow replay` imported the workflow module with no check, and `resume` runs the file that the
repository's run store names. The terminal UI imports plugins in its own process (#15 review). The `/runs` dialog opens
the clone's run store with no trust step, and the VS Code **Clean runs** button runs `orb flow clean` in an untrusted
clone (rounds 4 and 6). Embedded SDK hosts followed `ORBIT_TRUST_PROJECT` unless `trust.implicit` was set (#14).

**Ask early:** at the specs, list every door to each loader. Each later round was another door into a room that was
already guarded elsewhere.

**How to comply:**

- `requireTrust`, `trustRefusal` and `warnUntrusted` in `packages/cli/src/util/trust.ts`. The handlers for `run`,
  `loop`, `flow run`, `flow resume`, `flow replay`, `eval` and `orb -p` (`handlers/print.ts`, through the `headlessInput`
  that `run` shares, with `strict`; `trust.test.ts` pins a clean folder, `--bare`, `--continue` and the 404 stub) call them
  before any load. `orb acp` cannot stop, because
  the editor chooses the folders, so it warns on stderr and keeps stdout for the protocol.
- `--trust` forces a private server and trusts for its lifetime without storing the grant (it rejects `--server`).
  `orb trust [folder] [--revoke] [--list]` refuses home and filesystem roots.
- The routes are `GET` and `POST /api/location/trust` and `GET /api/trust` (`client.location.trust.get`, `update` and
  `list`, in `packages/protocol` and `packages/server`).
- Find the doors by searching for `loadWorkflow`, `loadSuite`, `import(`, `Bun.spawn` and `createRequire`, and put each
  one in the inventory.
- Ask which process runs the code: the server, the CLI, the terminal UI or an extension host. The gate belongs in that
  process.

**How to test:**

- A table test per entry point: for each command that can load or run a file from the folder, an untrusted folder that
  holds nothing else back, and expect exit 1, no marker and no model request. Add variants with `--server` and a stub
  that answers 404 for the route. For `acp`, assert that stdout carries only protocol frames.
- Make the test fail when a new loader appears that the table does not list, by searching for the calls above.
- Use the real app fixture for the terminal UI, where a plugin's `setup()` must not run
  (`packages/tui/test/plugin-trust.test.ts`).

**Review questions:**

- List every command, button, subprocess or API that reaches this loader. Which one did I not test?
- Which process runs the code (server, CLI, terminal UI, extension host), and does the gate live there?
- What does the entry point do when the server cannot answer?
- Does anything read the clone's `.orbit` data store without a trust step?

### 13. Failure and decline paths are not carried end to end

**Rule:** Trace every new refusal, decline and failure through every client surface (terminal UI, headless JSON, ACP,
SDK), and give it a typed error, a bounded time and a test per surface.

**Why:** A decline that never settles hangs the step, a plain reject surfaces as an internal error, a typed refusal is
flattened by a public error type, and a failed trust request that prints a stack trace and nothing on stdout breaks the
scripts that parse JSON.

**In M1:** a decline hung the step when the program finished through `.then` or `.finally` handlers (#5), and a plain
reject died as `Permission.DeclinedError` and reached clients as an internal error (#6). A failed trust request printed
a stack trace and left stdout empty (#18), and an unresponsive server held the terminal UI on its loading screen (#19).
`ConfigCommandPlugin.UntrustedError` never reaches a caller, because `Command.execute` flattens every failure, and a
Protocol change was declined as out of scope (#15).

**Ask early:** at the design step of each refusal, draw the path to every client.

**How to comply:**

- The decline `Deferred` and the `Effect.raceFirst` in `packages/core/src/codemode/tool.ts` stop the execution on a
  decline, and extension functions are invoked with `Effect.try` in `packages/codemode/src/interpreter/extensions.ts`.
- `SessionCommand.execute` maps `Permission.DeclinedError` to `Command.ExecutionError`
  (`packages/core/src/session/command.ts`).
- `trustRefusal` returns text, and `orb run` passes it to `reportRunError`, which prints a JSON error object for `json`,
  `stream-json` and `result` (`packages/cli/src/commands/handlers/run.ts`). Failures are written through `progress`
  (`packages/cli/src/index.ts`).
- The terminal UI's trust reads use `AbortSignal.timeout(2_000)` and keep the last answer.

**How to test:**

- One assertion per surface for each new refusal or decline: `orb run --format json`, `stream-json` and `result` put an
  error object on stdout, the terminal UI shows a toast, the ACP turn ends cleanly, and no stack trace appears anywhere.
- For hangs, add a real-clock bound of 2 seconds over program shapes that settle through handlers (a new `Promise`
  wrapper, `Promise.withResolvers` resolved in `finally`, a callback countdown, a halted later call, a handled decline
  with an awaited sibling), so that a regression fails instead of hanging. A server that never answers must not stop the
  UI from settling.

**Review questions:**

- Which clients see this error, and what does each one print?
- Is there a time limit on every wait that a person can see?
- Is the error typed all the way out, or flattened by a public error type?
- Does a decline stop the whole execution, siblings included?

### 14. Tests, gates and allowlists that do not check what they claim

**Rule:** A test counts only if it fails on the code from before the fix, so record the mutation in the PR. A heuristic
or an allowlist ships with planted positives and negatives and an audit of each entry. A test that skips on the
developer's platform gets a local run with the skip lifted before the PR. A negative test also has to see the attack in
its own environment: a program-lookup test deletes `NoDefaultCurrentDirectoryInExePath` from `process.env` and plants an
`.exe` decoy, or it passes vacuously.

**Why:** Mutations survived, allowlists hid more than their reason, a generated-file check reported a current file as
stale on Windows, a decoy test could not see the lookup that it was written for, and the real-symlink and POSIX hook
tests never ran anywhere, because the developer's account could not create symlinks and CI could not run.

**In M1:** a mutation that strips `status_message`, `if`, `once`, `shell` and `headers` from every hook passed all the
hook tests (#7), and `$ARGUMENTS` inside a span passed 52 tests (#6). In the vendor gate (#13) an allowlist entry hid a
stale name, and the exemption that a review suggested then let `.x-plugin/` through. Hook-executing tests skip on win32
and the real-symlink tests skip without the privilege, so they ran nowhere, and a known-failures baseline that the
repository does not hold absorbed flaky tests although the milestone plan names the idle-egress test as an M1 gate. The
spawner's program-lookup tests planted `.bat` decoys only, which `cmd.exe` finds through the child's environment, so they
said nothing about an `.exe`, and a bare name's `.exe` in the working folder ran through Bun's spawn until the review of
this page planted one (class 10).

**Ask early:** at authoring time, with a revert of the fix. The first-wave reviews named the practice, and it was not
applied to gates, allowlists and platform skips.

**How to comply:**

- List the mutation that makes each new test fail in the PR, one per behavior. The review runs it again.
- The vendor gate is the model for an allowlist: one list, a reason on every entry (`tools/rebrand/vendor.ts`, with
  `files.ts` and `tokens.ts`). Add planted positives and negatives (an allowed spelling, a forbidden one, a lookalike),
  an audit that removes each entry and shows its hits, and a run on an export without `.git`.
- A build guard fails loudly: `verifyRuntimeRequires` fails the build when a replacement matched nothing.
- A program-lookup test deletes `NoDefaultCurrentDirectoryInExePath` from `process.env` first (`currentDirectoryOnPath` in
  `packages/core/test/fixture/decoy.ts`), because a shell that sets it hides the search and the test then passes whether
  or not the code is right. It plants a real `.exe` decoy (`plant`: `hg.exe`, `cmd.exe`, `node.exe`) as well as a `.bat`,
  because each kind is found by a different lookup, and it carries a control that starts the decoy by its path (class
  10).
- Platform skips: `canLinkFile` skips the real-symlink tests with a reason. Lift the skip on Linux or in Git Bash before
  the PR, in a container or WSL, or mark the test unverified.
- Generated files carry `eol=lf` in `.gitattributes` (`packages/protocol/openapi.json` and the generated client
  directories).
- A flaky test is fixed in the PR that meets it, or that PR names it and says why it stays: the repository has no list
  of known failures to put it in yet (Known gaps). A test that the milestone plan names as a gate must pass, not be
  "known".

**How to test:** run each new test against the sources from before the fix (check out the old file) and record that it
fails. Test an allowlist with the planted cases above. In M1 the gate suites are
`packages/core/test/config/trust.test.ts` (completeness of the classification table) and
`packages/flow/test/agents.test.ts` (gate versus runner).

**Review questions:**

- Revert the fix: does the new test fail? Which mutation did you try?
- Is any negative assertion ("nothing ran") on a platform, or under a default, where it would pass vacuously?
- Does a program-lookup test delete `NoDefaultCurrentDirectoryInExePath` from `process.env` and plant an `.exe` decoy as
  well as a `.bat`? Without the delete, or with `.bat` decoys only, it passes whether or not the code is right.
- Is this allowlist entry as narrow as its reason? What else does it hide?
- Which tests skipped on this machine, and who ran them?
- Is a flaky test fixed, or named in the PR with the reason it stays? There is no baseline list in the repository to hide
  it in.

### 15. Docs, comments and PR text that outrun the code

**Rule:** Write the docs, the schema descriptions, the code comments and the PR body last, from the final tree and the
commit list. Each claim names the test that proves it, and the PR body is regenerated after every fix push.

**Why:** The docs said that the terminal UI loads no plugins from an untrusted folder when it did, that imports from
`node_modules` "resolve as before" when they did not, and that a rule "never allows a write" when a leading wildcard
did (Known gaps). The owner merges from the PR body, and it was stale in about a dozen reviews.

**In M1:** #15's docs promised that the terminal UI held plugins back, the `ConfigTrust` header said that every reader
asks `reachable` (#22 round 3), and the upgrade note said that imports from `node_modules` resolve as before (#22 round
8). PR descriptions were stale on #2, #7, #13, #15, #18 (twice), #19, #20 and #22 (four rounds), and the upgrade note
was missing from several PRs and had to be checked by the reviewer.

**Ask early:** at the end of each fix push, regenerate the PR body and re-read every sentence of the note against the
final diff.

**How to comply:**

- Add a note to [upgrading](upgrading.md) for every visible behavior change: a short heading, what changed and what it
  did before, **Affects** and **What to do**, at the end of its section.
- A schema description reaches OpenAPI and the generated clients. After changing one (`packages/schema/src/trust.ts` for
  example), run `bun run generate` in `packages/protocol` and then in `packages/client`, and do not edit the generated
  files.
- Search the docs and the comments for "not loaded", "never", "always" and "nothing runs" before you open the PR. Each
  promise names the test that fails when it becomes false, or is rewritten to what is true.
- After every push, regenerate the PR body from the commit list, the test counts and the last gate run. It lists every
  commit and the mutation of every test, and it says: merge only after the review approves the head commit.
- When the docs or the note name helpers that only another open PR provides, say `depends on #<n>` in the title and the
  body, check every name against that PR's final head each time it moves, and check them once more on the merge commit.
  This page's own class 10 went stale that way when #22 changed after the page was written.

**How to test:** for each sentence of the upgrade note and each comment that makes a promise, name the test that fails
when the sentence becomes false, or rewrite the sentence.

**Review questions:**

- Does every claim in the docs and the PR body name a behavior that the tests pin?
- Does the PR body list every commit, the test counts and the gate results of the head commit?
- Does the upgrade note say what a user must do, including for hooks that now fire or files that now vanish?
- Does a comment describe enforcement that the code does not do yet?

## Working practices

These come from how M1 and M2 were run, and they apply to any change in this area.

- **Fix the class, not the instance.** When a finding lands, list the members of its class from this page (surfaces,
  sinks, spellings, entry points) and close them all in one commit with a table-driven test. In M1 each round closed
  only the reported instance and the next round found the next one: from the merge of #20 to the esprima fix there were
  five audit and verification rounds, nine review rounds on #22 and 26 commits, about 24 hours. The review of that fix
  then found another member of the class (an executable found in the working folder, class 10), and fixing that turned
  up two more (a `cmd.exe` that searches the folder, and `taskkill` run by name). The review of this page found a
  fourth, because the fix for the `cmd.exe` search had closed one lookup of the class and not the others: Bun's spawn,
  Node's and cross-spawn still found a bare name's `.exe` in the folder. Before you call a class closed, list every
  lookup that can find what it names and plant a decoy for each. An audit may report "no holes" only with a table of the
  surfaces it checked and the evidence for each row. The round-1 audit found nothing where rounds 2 to 4 found five.
- **Write the class matrix before the code.** When a finding lands, write its class as a matrix before you write the
  fix, and put it in the PR body: for approval display, the clients (terminal UI, Mini, ACP, VS Code) × the tools × the
  path spellings × the keys a model can add. Pin every cell with a test, and the review checks that every cell has one.
  M2 had the "fix the class" rule, but no fix wrote its list down where a review could check it: the approval-display
  class took rounds 4 to 6 and a check past the round cap across four clients, and is still open (Known gaps).
- **Every claimed rule has a test that breaks with it.** A fix that says "only declared fields are shown" or "the prompt
  shows every file" needs a test that fails when that rule is broken. In M2 the tests for a multi-file prompt checked
  strings and never drew it, so a fix that hung the terminal UI and Mini prompts was committed, and only round 6 found
  it. ACP's declared-fields filter was keyed by the permission action instead of the asking tool, and no test failed,
  because no row added a key the tool does not declare.
- **What blocks.** A finding blocks only if it breaks the promise at the top of this page on a default or demonstrated
  path. A hole that a clone can demonstrate is not a speculative edge case: fix it in the PR that finds it, and record
  the failure mode, the likelihood and the cost in the PR. Speculative hardening goes on a follow-up list. Waiting for
  the owner's word on gate-widening fixes cost M1 a round.
- **A suggested fix is a change.** Run planted negatives, or a control build that changes only that option, before you
  accept it. A suggested exemption let `.x-plugin/` through the vendor gate (#13), and the prescribed
  `autoloadPackageJson: false` broke package resolution in the binary (#22).
- **Build-now decisions go into the task.** A decision in the milestone plan marked "build now" is copied into the
  checklist of each task it names, and the review checks it. A decision with no owning task blocks the start. M1's
  decision for language servers, formatters, `{file:}` and `{env:}`, and config above the project had no owner after two
  specs and was found as a major in the review of #14.
- **Land a stack in order.** Agents never merge a pull request or delete a remote branch: the owner merges, bottom-up,
  and only after the review of the head commit approves. Retarget a child to `main` (`gh pr edit <n> --base main`)
  before its parent's branch is deleted, because GitHub closes a child whose base is deleted (#17 was closed that way
  and reopened as #18). #14 merged before #15, so #15's commits never reached `main` and were re-landed as #16. If a PR
  merged before its review fixes, open the follow-up the same hour (#19 and #20).
- **A dependent PR says so.** A PR that names helpers which only another open PR provides has `depends on #<n>` in its
  title, or stays a draft, because nothing else stops it from merging first. Once the other PR lands, check its names,
  paths and tests again on the merge commit. This page was written against the head of #22 and is such a PR.
- **A switch ships with its way back.** A PR that turns a feature off ships with the PR that lets the person turn it
  back on, or the stack lands as one. #14 alone would have switched off project config for every background-service user
  with no way to trust a folder.
- **Keep the baseline honest.** A flaky test is fixed in the PR that meets it, or that PR names it and says why it
  stays. The repository keeps no list of known failures yet (Known gaps), so a new flake is easy to take for an old one.
  A test that the milestone plan names as a gate must pass. Before a milestone closes, run the tests that skip on the
  developer's platform somewhere that runs them, or fix the CI that should.

## Known gaps

Not fixed in M1. Each entry is a place where the promise at the top of this page does not hold yet, or rests on a
decision that is still open. Do not claim otherwise in docs or in a PR, and do not widen one. An entry that names a task
is carried by it, and one that names none has no task yet: give it one. An entry reads `Accepted by the owner until
<task>` once the owner has said so in writing. None does yet, so until one does, a change that touches that surface
fixes it or asks.

- **A holder that is a filesystem root.** `standing()` in `packages/core/src/config.ts` still lets `{file:}` in
  untrusted config read across the drive when the holder of the file is a filesystem root (#14 re-review, N1).
- **A stale-stamp window.** `ProjectTrust.allows` mixes the live decision with stale stamps for about 100 ms after a
  grant or a revoke (N2). Nothing consumes `allows` yet, so fix this before its first consumer, which class 1 prescribes
  for a file that carries code.
- **The formatter gate keys on the Location's project**, not on the folder of an externally edited file (N3).
- **Advice that cannot be followed.** `Trust.Withheld.directory` can name a folder, such as the middle one of outer,
  middle and inner repositories, that `orb trust` cannot lift, because a grant always goes to `project.canonical`. There
  is no revoke-by-directory route for a deleted folder. The VS Code extension names such a folder and gives no command
  for it (`packages/vscode/test/trust-text.test.ts`), which leaves the terminal UI, `orb run` and `orb trust` with the
  advice.
- **Decided: `model`, a provider and a budget are withheld.** The owner decided on 2026-10-08, choosing "Withhold
  all, now": "Every field that picks a model, provider or budget (top-level model, agent model and steps, side/title
  models, fallback_model, output_token_cap) is withheld in untrusted folders; Orbit uses your own settings until you
  trust the folder." `ConfigTrust.classification` therefore withholds, as `providers`, the top-level `model`, the
  `model` and `steps` of every agent (so also `agents.title.model` and `agents.side.model`) and the `model` of
  every command, from the config and from agent and command files (`test/config/trust.test.ts`,
  `test/config/agent.test.ts`), and `fallback_model` and `output_token_cap` the same way (the
  `output_token_cap` row in `test/config/trust.test.ts`). No command-file test pins the `model` of a command: `sanitizeCommands` is tested
  on a command record only.
- **Text that the person did not write: sinks without a frame test, and what is still open.** The terminal UI and
  Mini write control characters out of message bodies with `bodyText` or `outputText` (task `clients-ux-60`), and the
  inventory lists the rows that pin that. Routed through the sanitizer but pinned by no frame test: the tool list of the
  token-usage view (`TurnTokenToolCalls`), the details dialog of `execute` (`dialog-execute.tsx`), the timeline and
  fork lists (`dialog-timeline.tsx`, `dialog-fork.tsx`), the `/btw` answer (`btw.tsx`), the attachment names of a user
  message, the terminal and subagent rows of the composer (`terminals-tab.tsx`, `subagents-tab.tsx`, whose titles are
  session titles), the Mini subagent picker and footer (`footer.subagent.tsx`), and the width checks of Mini form
  rows. Open, with no sanitizer: `orb run`, whose default format writes the answer and the thinking lines as the model
  made them (its JSON formats write the same text out with `jsonLine`, and its tool lines are escaped); the text of
  the desktop notification that `notifications.ts` sends through `context.attention.notify`, which carries the
  "Session failed" message (its title passes `plain`, below); the markdown export of a session; the prompt history search and the
  stash list, which draw text that the person typed or pasted. Session titles that pass `plain` but have no frame test:
  the session-deleted toast (`app.tsx`), the toast of `plugin/api.tsx` and the notification title (`notifications.ts`).
  The window title passes `terminalTitle` (`test/util/renderer.test.ts`). Recaps are not drawn anywhere yet; they pass `bodyText`
  when `clients-ux-27` lands.
- **A leading wildcard in a host allow.** A rule whose pattern starts with a wildcard, such as `*example.com/*` or
  `*://example.com/*`, also matches the `METHOD url` resource of a write, so it allows `POST https://example.com/x`. The
  upgrade note for Code Mode `fetch` says that a rule written for a URL, an origin or a host never allows a write, which
  holds only without a leading wildcard. The review of #3 left it to the owner: change what such a pattern matches, or
  say so in the note.
- **The `webfetch` tool.** It still follows redirects through `HttpClient` with no per-hop ask and no address guard, and
  a proxy sees the address and not the name (task `file-web-tools-19`, M3).
- **A terminal UI plugin that first appears above the folder** while the UI runs is imported with no `config.updated` or
  `trust.updated` event. The structural fix is to walk from the server's project root (the owner's call, #20 re-review).
- **A headless run with no trust check.** `runV1Bridge` in `packages/cli/src/run/v1.ts`, exported from `@orbit/cli/run`,
  starts a run without `requireTrust`. Nothing calls it except an import-boundary test, so it is dormant. Whoever wires
  it in calls `requireTrust` first.
- **A typed refusal that a public error flattens.** `ConfigCommandPlugin.UntrustedError` reaches a client only as what
  `Command.execute` makes of every failure, because a Protocol change was declined as out of scope (#15). A client
  cannot tell a trust refusal from any other failure of a command.
- **The language server client and the bare `git` fallback.** The language server client
  (`packages/core/src/lsp/client.ts`) starts a server through `cross-spawn` directly. It hands `process.env` to the
  server, so the variable that each entry sets reaches it, but it has neither the spawner's `ProgramLookup.install()`
  before the launch nor `ProgramLookup.environment()`, and no test starts it against a decoy. It starts one only for a
  trusted folder (class 1), so keep that gate and move the call to `CrossSpawnSpawner` (task `file-web-tools-7`). And
  when `which` finds no git on Windows, `gitExecutable` falls back to the bare name `git`. That goes through the
  spawner, which sets the variable before it launches. The spawner's tests run under Bun, and the core also runs under
  Node, where only the launcher's test shows that Node's own spawn honors the variable, so a test that plants a
  `git.exe` and starts the fallback under each host is still missing (task `prompts-context-4`).
- **A relative `PATH` entry.** `which` skips an empty `PATH` entry but resolves a relative one, such as `.` or `bin`,
  against the working folder with `path.resolve`, so it still finds the `git.exe` or `rg.exe` that a repository ships.
  It needs the person's own `PATH` to name a relative folder, which is rare, so it is a follow-up and not a blocker
  (task `foundations-17`).
- **The external editor.** `openEditor` in `packages/tui/src/editor.ts` starts `$VISUAL` or `$EDITOR` with `shell: true`
  on Windows, in the folder of the session's project, so a `cmd.exe` runs it. It runs inside the `orb` process, and
  `node:child_process` passes the live environment, so the `cmd.exe` has `NoDefaultCurrentDirectoryInExePath` and a
  `vim.bat` that a repository ships is not found before `PATH` (measured with Bun 1.4.2 on Windows), but no test starts
  the editor against a decoy (task `clients-ux-14`). `openFile` in the same file, which the `/keybindings` command uses,
  does not share this: it finds the editor with `which`, starts it by the path it found through cross-spawn, and a
  Windows test plants a decoy of the same name in the working folder (`test/editor.test.ts`). `openEditor` can take the
  same route.
- **VS Code, more than one folder.** The chat works in one folder, the one in view when it first connected, and its
  trust question and banner are about that folder. The Runs view and the terminals follow the editor in view, so in a
  workspace of several folders they can act in another one. What they start gates itself in its own process
  (`orb flow resume` refuses an untrusted folder, `packages/cli/test/trust.test.ts`), but the extension does not ask
  about that folder. No task yet.
- **VS Code, the part that loads `vscode`.** `extension.ts`, `runs-view.ts` and the webview import `vscode` or the DOM,
  so no test loads them. What they do with trust (the banner, the status bar item, the dialog, the command and the
  terminals) is not exercised by any test or by a recorded manual run. The logic behind it is in `Controller`,
  `trust.ts` and `program.ts`, which are tested. That includes the refetch of the model list when the trust check starts
  to answer after a restart of an old service. No task yet.
- **A string comparison in `Git.clean`.** It keeps the entries of `git worktree list` with
  `directory.startsWith(prefix + path.sep)`, which class 4 forbids. It is harmless today, because the prefix is a folder
  that `runFolder` has already checked, but it is the model that a reader would copy. Replace it with a `path.relative`
  check: `@orbit/flow` does not depend on `@orbit/util`, so it cannot use `FSUtil.contains` without a new dependency.
- **Build checks.** `verifyArtifact` does not fail the build on an import or a `require` of a `#` name or of a stray
  bare name, and `packages/core/test/provider-compiled.test.ts` copies the autoload options instead of importing them.
  Two names are not replaced in `packages/cli/script/runtime-requires.ts`, because nothing loads code through either
  today. `bufferutil` is not in the bundle: the server uses the `ws` that Bun carries, and Bun carries `utf-8-validate`
  but not `bufferutil`, so nothing asks for it. The npm `ws` package asks for it when it loads, so if a change ever
  bundled that package, `bufferutil` would be left to the runtime, resolve from the working folder's `node_modules` and
  run from there. `node-gyp/bin/node-gyp.js`, which the bundle does leave to the runtime, is only a path that npm looks
  up with `require.resolve` and does not load, and Orbit installs with scripts off. Replace the first before the binary
  imports the npm `ws`, and re-check the second before Orbit installs with scripts on.
- **A rejection with feedback inside Code Mode, and ACP.** The step stops its tool queue when a direct tool call fails
  with a permission correction (`session-runner.test.ts`, `mcp.test.ts`). A Code Mode program turns the same rejection
  into an error result, so the calls queued behind its `execute` call still start and can ask (task `tool-runtime-6`
  and `tool-runtime-7`). The ACP client does not close the permission prompt of an interrupted call yet, and no
  bundled client reads `metadata.queued`.
- **Shared approvals.** A project's ID comes from its remote URL, so a folder that names the same remote shares the
  saved "always allow" approvals.
- **Git in the folder.** Orbit runs git in a folder to resolve its project, and git applies that folder's own
  `.git/config`, which can name programs for git to run (tasks `foundations-18` and `shell-safety-18`).
- **The dormant `instructions` config key** needs the same real-path guard when it is wired in (M4).
- **Tests that skip.** The hook-executing tests skip on win32 and the real-symlink tests skip without the privilege, and
  CI could not run in M1, so neither kind has run yet. Run them on Linux and in Git Bash before a milestone closes.
- **No list of known failures.** The repository holds no list of the tests that are known to fail or to be flaky. M1's
  baseline of them lived outside it, so a new flake looked like an old one. Put the list in the repository, one line per
  test with its reason, before the next milestone starts.
- **Lint noise.** `bun run lint:effect-patterns` carries 27 standing diagnostics, so a new violation of the AGENTS.md
  style rules (nested service yields, `else`, import aliases) hides among them. Bring it to zero or make it fail on the
  files that a change touches.
- **Paths in shell command text.** The shell asks about its workdir, the folders of `cd`, `pushd` and `Set-Location`,
  and the plain words and redirect targets of a command that a link in an untrusted project leads out of it
  (`ShellParse.operands`, `FileAccess.escaped`). It does not ask about a path the command builds as it runs (a variable,
  a substitution, a glob before the link's name, quoting that the scan does not undo), one a script or program opens by
  itself, or a path in the text that names a place outside the project directly, such as `cat ~/.ssh/id_rsa`, which the
  Bash approval shows but no folder question names. Task `shell-safety-9` (M3) carries the shell analysis.
- **A search of a folder and Read rules.** Grep and Glob ask the Read rules about the path they search, but not about
  each file that a search of a folder finds, so a Grep of `.` reads a `.env` in it under a Read deny of `*.env` unless a
  rule covers the folder. Task `permissions-3` (M6) carries a Read check for each file a search returns.
- **A share named before anyone is asked (closed for the file tools by `permissions-23`).** `FileAccess.resolve` now
  refuses a UNC, `\\?\Volume{…}` or `\\.\` path with `file.spelling` before any disk is read, unless the path is in
  the project's folder. `ProjectTrust.escapes` reads a link's target one part at a time and names a share as the link
  says without opening it, and `FileAccess` refuses a place that a repository link leads to when it is a share, in any
  spelling (`\\localhost\C$\…` included, which names a local folder that the person's rules write as a drive path, so a
  question about it would have turned their deny into an ask), with the same `file.spelling` failure, before any
  question: for a tool's path (`resolve`, so Read, Write, Edit, Grep, Glob and a shell `workdir`) and for the plain
  words of a shell command (`escaped`). A part with `~` below such a link is refused the same way, because looking up
  its long name would read the folder the link leads to. A link to a device path (`\\?\Volume{…}`, `\\.\…`) reads
  back in the NT form `\??\…`, which `ProjectTrust.escapes` names as the device path it is (the `orb acp` rows found
  that a first version took it for a folder named `??` and asked). The first review found the `~` case (6 seconds to connect to
  the host), the third the admin-share target. `file-access-spelling.test.ts` wraps `FSUtil.Service` in the test layer,
  records every path it is called with, and asserts that none starts with `\\` or `//` in the rows for a share given
  directly (nine spellings, trusted and not, `resolve` and `escaped`), for a link to a share in six spellings
  (every kind of path a tool resolves, `~` parts, a shell word), and for the person's deny row beside the junction
  control (the link rows and the deny row also assert that only `readLink` names the link or a path below it, which the
  recorded drive path would otherwise hide from the share check); the link rows need Developer Mode and fail instead of passing without it. The `orb acp` table in
  `permission-files.subprocess.test.ts` crosses every row of `linkRows` with the six link targets untrusted, and the
  first with the person's deny and with a trusted control. What remains: a share named in a shell command's text
  directly, which is asked about as the shell asks, or in a path that a loader other than the file tools reads, such
  as a `{file:path}` reference, and a mapped network drive, which is a drive letter.
- **Other spellings of the project folder (closed for the file tools by `permissions-23`).** A path that named the
  project through another spelling of its own folder (`C:\Documents and Settings\…`, `C:\Users\<me>\Local Settings\…`,
  or a link to the project) was decided as outside the project by its spelling, so a repository link inside it was not
  followed (shown over a real `orb acp` in M2's final check: the global config folder's files moved aside, and its
  provider key sent to the model). `FileAccess.resolve` now resolves each part of such a path from its root, takes the
  first part that is really inside the project as the start, and decides the rest under the project's own folder, so
  `ProjectTrust.escapes` follows the repository's links and `Target.place` and `escaped` are set as for the plain
  spelling, and the rules see the project-relative name. `\\localhost\C$\…`, `\\?\Volume{…}\…` and `\\.\Volume{…}\…`
  are refused (see the entry above). Pinned by the table in `file-access-spelling.test.ts` (deny, ask and trusted rows
  for each spelling) and by the `orb acp` table in `permission-files.subprocess.test.ts`, which fail on the code before
  the change. The paths a shell command names in its text (`FileAccess.escaped`) are anchored the same way before
  `ProjectTrust.escapes` follows them (`cat "<spelling>/cfg/orbit.json"` meets the folder question of the plain
  spelling), and the `orb acp` table crosses every row of `linkRows` (Bash workdir, `cd`, path words, `cat` and
  redirect, PowerShell, Grep, Glob, Read, Write) with every real spelling, untrusted with `once` and `reject`, trusted,
  and under a person's deny of the config folder, and the refused spellings with Bash workdir, Grep and Write. A drive
  that is made from the project's folder (`subst Q: <project>`) is anchored too, because the root is the first part
  asked about. An 8.3 short name of the project's folder, or of a folder above it, is expanded to the long name first, and the anchor, not a difference from the long name, says the path is in the project (the review found that the first version decided such a spelling as outside it, because the expansion gave the project's own name). The core table and the `orb acp` table have these rows, and fail on a Windows volume that makes no 8.3 names rather than pass without them. What remains: a path that goes through a link that is not in the project and that leads into it by a
  route this walk cannot read (a mapped network drive); a word of a command that a shell builds as it runs.
- **A rule of the person's with the value of one of Orbit's own allows (closed by `permissions-23`).** A place a link
  leads to is decided without Orbit's own allows (`Agent.folders`). They are now marked where they are made (the rule
  objects are kept in a `WeakSet`, so the mark is not a field that a config file, stored rule or decoded value can
  carry), and `Permission` leaves out the marked rules instead of comparing values, so a rule of the person's with the
  same action, folder and effect decides that place, as an allow, an ask or a deny (`permission.test.ts`, "lets the
  person's rule with the value of one of Orbit's own allows decide a folder a link leads to"; `agent.test.ts` pins the
  mark on a new agent). What remains: the mark follows the object, so a copy of a rule (a spread, a structured clone, a
  JSON round trip or a schema decode) counts as the person's, which is the looser reading. The production plugin host
  hands the agent editor over without copying, so Explore's rules keep the mark by reference; `agent.test.ts` ("keeps
  the mark of Orbit's own folder allows in every built-in agent, Explore among them") builds the agents through the
  real `orbit.agent` plugin with an editor that does not copy and fails when Explore copies its rules. The copying
  `agentHost` of the test fixtures does not keep the mark.
- **Approvals not yet built only from the request.** Since M2 the server puts the resolved file or folder on file,
  shell, Grep and Glob requests, and the terminal UI, Mini and ACP prefer it. Parts of an approval still come from the
  call's recorded input, or are missing: the terminal UI, Mini and VS Code name no folder on a shell, Grep or Glob
  approval; an MCP call through Code Mode is approved without its arguments; VS Code and ACP read NotebookEdit's fields
  from the input; and ACP's ordinary tool call shows a link's own path. Task `clients-ux-61` (M3) moves every client
  onto the request and adds the "what is shown is what runs" matrix test.

## Review checklist

Walk this list for any change that reads project files, runs commands, makes network requests, prints text or changes
the build. The number after an item is the class with the detail. A "no" is a finding: cite the class in it, and say
which other members of that class you checked. A finding blocks only if it breaks the promise at the top of this page on
a default or demonstrated path, and anything else goes on a follow-up list with its failure mode, likelihood and cost.

**For every change**

- [ ] The change adds or touches a surface, and each one is in the inventory and, for a reader of repository files, in
      the reader list in the header of `packages/core/src/config/trust.ts` (1, 4).
- [ ] The gate is in the process that does the work and runs before the first read, import or spawn (1, 12).
- [ ] A repository that holds nothing else back (no `orbit.json`, no `.orbit`) gets the right answer from the gate (1,
      2).
- [ ] One folder is asked about, shown, granted and acted on, and the server, the CLI and the terminal UI agree on it.
      When they disagree, the stricter answer wins and is logged (3).
- [ ] Every error, unknown input, old server, timeout and malformed sibling has a defined result, and the default is to
      refuse (7).
- [ ] The refusal reaches every client as a typed error with a time limit, and its advice lifts what it lists (3, 13).

**It reads project files** (loaders, readers, parsers, links, stores)

- [ ] Every reader of repository-supplied bytes asks `ProjectTrust` (`reachable`, `supplies` or `escapes`), which judges
      containment on the real path at read time. `FSUtil.resolve` and `fs.resolve` keep the lexical path for a part that
      is not there, so they never decide it; `FSUtil.contains` is used only on two paths that are already real, and
      nothing compares paths as strings. Dangling links, targets that do not exist yet, UNC paths and Windows case are
      covered (4).
- [ ] The text goes to the model provider, a tool write or the terminal, and the worst file that a link could point at
      has been considered (4).
- [ ] Markdown, YAML and JSON go through `ConfigMarkdown` or a parser that cannot evaluate. No library evaluates,
      requires or resolves names by itself, and "just text" was checked against the parser (10, 11).
- [ ] A name, ID or ref that comes from a file that a clone can ship is validated where it enters and never joined into
      a path, a ref, a glob or a title. A destructive command that reads such a store has a trust step or a shape check
      (5).
- [ ] A data file that reaches a shell, an approval or an agent choice is listed by a reader that shares the runner's
      validator, templates count, and a gate-versus-runner test covers replay, resume and eval (2).
- [ ] Every config key, agent field and command field is classified in `ConfigTrust.classification`. A field that
      chooses which rules, agent or mode apply is a permission, and untrusted sources get deny rules only. A field that
      picks a model, a provider or a budget is withheld as `providers`, never inert (8).

**It runs commands** (spawns, shell, hooks, plugins, workflow nodes, git)

- [ ] Every command, button, subprocess and API that reaches the loader is listed and tested, and none runs the code
      before the gate (1, 12).
- [ ] Whatever the folder can make this code spawn, approve or choose is listed, whether it is a path, an agent, a model
      or a provider (2, 8).
- [ ] An executable is found with `which` (`PATH` only, unless `PATH` itself names the folder) and a program is
      started through `CrossSpawnSpawner`, in a process whose entry called `ProgramLookup.install()` first. No bare name
      goes through `exec`, `cmd /c` or another `cmd.exe` of its own outside the spawner: Bun, Node and `cmd.exe` all look
      in the working folder first on Windows. The test deletes `NoDefaultCurrentDirectoryInExePath` from `process.env`
      and plants `.exe` (`hg.exe`, `cmd.exe`, `node.exe`), `.bat` and `.cmd` decoys, and starts a `.cmd` by its full
      path, with a control (10).
- [ ] The approver sees the whole thing that is approved: the full span, the method, the URL, the folder (8).
- [ ] A new or changed approval takes its place, file, method and diff from the permission request's resolved values,
      never from the model's raw input, and a value the request lacks was added on the server. Its rows are in the "what
      is shown is what runs" matrix, or, before `clients-ux-61` lands, in a table-driven test of the same shape (8).
- [ ] No default or fallback names an agent or a mode by constant instead of by configuration, and whose rules come last
      has been asked (8).
- [ ] A decline or a refusal stops the whole execution, siblings included, and does not surface as an internal error
      (13).

**It makes network requests** (fetch, redirects, proxies, integrations)

- [ ] Only `http:` and `https:` URLs reach `fetch`: `PermissionWeb.request` throws for any other scheme, and Bun's
      `fetch` would read `file:`, `data:` and `s3:` (6).
- [ ] Every URL or host that a script or a repository can influence asks permission per hop, redirects included (6).
- [ ] The address that was checked is the address that is connected to, and the name is kept only in `Host` and SNI (6).
- [ ] A lookup that throws, returns nothing or returns a name is refused (6, 7).
- [ ] The private and metadata lists are tables matched exactly, IPv6 forms and embedded IPv4 included, and no
      dev-server setting opens metadata or link-local addresses (6).
- [ ] The change makes no network call to anything but a configured model provider, MCP server or integration
      (AGENTS.md).

**It prints or stores text** (CLI, terminal UI, titles, commit subjects, logs, JSON)

- [ ] Every place where a string from a file, a store or a workflow, or a session title, can reach a person is listed,
      and the function that escapes it at that sink is named. A message body passes `bodyText` in the terminal UI and
      Mini (9).
- [ ] The text also reaches no title, commit message, log line, toast or failure message that is built before the trust
      check without being escaped (9).
- [ ] JSON is printed with `json()` and not `JSON.stringify`, numeric columns from a store are read with `Number()`, and
      stored text is escaped at write time (9).
- [ ] A refusal shows the file's text with its control characters written out (2, 9).

**It changes the build** (dependencies, dynamic imports, compile options, bundler plugins)

- [ ] No new dependency or dynamic import has a name that the bundler cannot see (an aliased `require`,
      `import.meta.resolve`, `createRequire`), and no `#name` is imported at runtime (10).
- [ ] The binary starts in a folder that the user chose before the trust check, and what the runtime reads from that
      folder has been looked at. The autoload options are unchanged, or a control build shows the change (10).
- [ ] No package is loaded by name from the working folder instead of the npm cache (10).
- [ ] The real binary was built and run on Windows and on Linux (10).

**Tests and claims**

- [ ] The new tests fail on the code from before the fix, the mutation is in the PR, and a trusted control run proves
      that the hostile file is live (1, 14).
- [ ] No negative assertion passes vacuously, whether on a platform that skips it, under the default trust of core
      tests, or in a shell that sets `NoDefaultCurrentDirectoryInExePath` (the test deletes it from `process.env` and
      plants an `.exe` decoy as well as a `.bat`) (14).
- [ ] Every allowlist entry is as narrow as its reason, and has a planted positive and a planted negative (14).
- [ ] The tests that skip on the author's machine ran somewhere else, or the PR says they are unverified, and any flaky
      test is fixed or named (14).
- [ ] The upgrade note says what a user must do, every promise in the docs, comments and PR body names a test or says
      what is true, the PR body matches the head commit, and a PR that needs another open PR says `depends on #<n>` in
      its title (15).
