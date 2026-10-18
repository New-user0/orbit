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

- `InstructionNotes.add` (`packages/core/src/instruction-notes.ts`, served at `POST /api/location/instructions/note`)
  appends a bullet to the project or local instruction file, so it writes into the folder a repository supplied. It reads
  only the one file it is about to append to, and only after the checks. The target is the file the loader reads in that
  scope (the loader's own exclusion and `ProjectTrust.reachable` filters, in the loader's order), asked of the spelling the
  walk builds, never of a real path alone. While the project is untrusted, `ProjectTrust.escapes` and `reachable` on that
  spelling refuse a file that leads outside (a link to a file, a dangling link) as
  `outside`, before any write and again under the file's lock (a link swapped in between); the GET listing reports such a
  file, and one that `instructions_exclude` drops, as not enabled, by its spelled name. A note for a file that
  `instructions_exclude` drops is `excluded`, with no second file made beside it. A new `ORBIT.local.md` is kept out of git
  through the repository's own `info/exclude` only, and only for a Location whose project is a git one, asked at the project
  root the Location resolved and never by walking up (a Mercurial project nested in a repository gets no step, and no git
  process starts for it): `GitLayout.locate` must report `verified` (the nine forged layouts of `git-forged.ts` get no line
  and at most one log line), `info` and `exclude` must not be links, the exclude file's folder must
  stay inside the verified common directory, and no git process starts while the folder is untrusted (the "already
  ignored" question is asked of git, with fsmonitor off, only once it is trusted). A failure of that step is logged and
  keeps the note. The text is the person's own and is not filtered; an import token in it meets the import gate when the
  file loads. Proof: `test/instruction-notes.test.ts`, `server/test/instruction-note.test.ts`.
- `system_prompt_file` in `PromptConfigPlugin` (`packages/core/src/plugin/prompt-config.ts`) reads a UTF-8 file into
  `system[0]` of each request of the main thread, so `ConfigTrust` withholds the key (kind `settings`) from an untrusted
  project or local document, and the gate is the config's own, at each request. The loader also refuses, for every
  document, a target that `LinkShare.isShare` names (two separators: `\\host\share`, `//host/share`, `\\?\UNC\`; or a
  rooted `\??\` NT spelling such as `\??\UNC\`, also behind a dot segment such as `\x\..\??\UNC\`: the predicate tests
  the spelling as written and as normalized), before any file system call, and a path that reaches a share through a
  link (`LinkShare.blocked`; pinned by the link test in `test/plugin/prompt-config.test.ts`). The same predicate answers
  for the trust fingerprint, `{file:}` reach and `ConfigTrust.inside`, and `test/link-share.test.ts` pins each NT
  spelling against `of`, `ofSync`, `blocked` and `scan` with no file system call. `PromptConfigPlugin.promptKeys` reads
  `system_prompt`, `append_system_prompt` and `system_prompt_file` only from documents of scope user (or no scope), flag
  and managed, so a project, local or remote document never supplies them, trusted or not, and nothing ranks against
  the person's value. `system_prompt` and `append_system_prompt` stay `inert` in `ConfigTrust` for that reason, as
  `compatibility` does: withholding them would list `settings` in the trust prompt for keys a grant never applies. The
  core rules follow a replacement. A drive letter mapped to a share is not detected (follow-up). Proof: the scope table
  in `test/plugin/prompt-config.test.ts` ("system prompt keys by scope"), `test/config/trust.test.ts`,
  `test/config/config-trust.test.ts`.
- `hg` in `Project.resolve` (`hg log`) and in the Mercurial VCS provider (`hg branch`, `status`, `diff`, which the
  terminal UI asks for on connect): Mercurial loads the `[extensions]` and `[hooks]` of the folder's `.hg/hgrc` into
  each command, so none is started while the folder is untrusted. The provider answers an empty branch, status and
  diff and reloads on `Trust.Event.Updated`; `Project.resolve` names an untrusted folder by its path, not `global`,
  whose saved approvals every such folder would share. Proof: `test/project-hg-trust.test.ts`,
  `test/vcs-hg-trust.test.ts`.
- `git` in `Project.resolve` (`rev-parse`, `remote get-url`, `rev-list`, `worktree list`), in the Git VCS provider (`status`,
  `diff`, `reflog show`, which the terminal UI asks for on connect) and in the location watcher (`rev-parse`): git applies
  the folder's own `.git/config` (its includes, `.gitattributes` and hooks), and a clone chooses all of them. They name
  programs for git to run (`git help config`, `gitattributes`, `githooks`): `core.fsmonitor`, `core.hooksPath` and
  `.git/hooks` when git reads the index or updates a ref, the `filter.<driver>.clean` and `diff.<driver>.textconv` that
  `.gitattributes` selects when `status` or `diff` reads a file, `diff.external`, `gpg.program` when `reflog show`
  verifies a commit that carries a signature, `core.sshCommand` and `credential.helper` for a remote, `core.pager` for a
  terminal, and what an include names.
  - `Project.resolve` and the provider start no git for a folder until `WorkspaceTrust` trusts it, and the watcher starts
    none for any folder. The decision is the main checkout's for a linked worktree, as `ProjectTrust` takes it. A trusted
    folder keeps its git as before.
  - `Project.resolve` reads `.git` and the shared `config` itself (`GitLayout`, `packages/core/src/git/layout.ts`). It
    opens only what git wrote for the folder: its own `.git` directory, or the entry that its repository keeps for a linked
    worktree, which names the folder back. A `.git` that is a link, a submodule or separate git directory, and a layout
    that names another repository's directories, are named and left alone. It passes over a `.git` directory that has no
    `HEAD` and uses the repository above it, and stops at a `.git` file that is no good, as git does. A read that fails,
    is blocked (a share), is over its limit (4 KiB for a pointer, 1 MiB for the config) or does not parse is "not there",
    never an error, and each folder is judged alone (class 7). The project is named by the remote URL in that config as
    written, which `git remote get-url` gives a trusted folder too unless an include or `url.<base>.insteadOf` rewrites it,
    and by the folder's path when there is none (a trusted folder uses its first commit). The provider answers an empty
    branch, status, diff and review base, and reloads on `Trust.Event.Updated`. The watcher finds `HEAD` from the same
    files.
  - Snapshot (git in Orbit's own git directory, plus one ignore check in the project's repository) and the read-only
    calls of the `Git` service (`discover`, `remote`, `history`, `worktree.list`) still run in an untrusted folder with its
    config in effect, and reach no key of the table (`test/snapshot-trust.test.ts`, `test/git.test.ts`). The ignore check
    passes `-c core.fsmonitor=false` as well. `Worktree.create` and `Worktree.remove` run `git worktree add` and `remove`
    when a person or the model asks, which runs hooks and filters of the folder (task `agents-extensibility-28`).
  - Proof: `test/project-git-trust.test.ts` (one row for each of eleven keys, a linked worktree, and every layout of
    `test/fixture/git-forged.ts`), `test/vcs-git-trust.test.ts`, `test/filesystem/watcher.test.ts` ("finds the git
    directory without git"), `test/git-layout.test.ts`, `test/snapshot-trust.test.ts` and `test/git.test.ts`. Each row
    plants a program that the config names, which records its runs, and carries the plain git command that runs it as the
    control (all but `core.pager`, which git runs only for a terminal that no test has); git's own trace (`GIT_TRACE2`)
    says whether any git started.
- The git snapshot of a session (`VcsInstructions`, `packages/core/src/vcs/instructions.ts`): `status --short`, `log
  --oneline`, `config user.name` and the refs of `origin` run in the session's folder, and git applies that folder's
  config to them (`core.fsmonitor`, `include.path`, `gpg.program` with `log.showSignature`), with no `-c` override. The
  source asks `ProjectTrust.trusted()` first at every read, whatever else it knows, and starts no git for a folder that is
  not trusted. A snapshot that a session holds is removed at the next step when trust is taken away, and one is captured
  once when trust is granted, as a durable update. A repository is told by `Location.vcs`, which `Project.resolve` reads
  from files, never by `Git.repo.discover`, which starts `git rev-parse`. `git_status` is inert in `ConfigTrust`: it can
  only drop the snapshot. Proof: `test/session-context-vcs.test.ts` (an untrusted run with `core.fsmonitor` planted
  leaves no marker and no git in the trace, a trusted control writes the marker, and a revoke starts no git),
  `test/git-snapshot.test.ts`, `test/vcs-instructions.test.ts`.
- Project and local config documents, the compat settings files and `.mcp.json`: `ConfigTrust.stamp` cuts each down with
  `ConfigTrust.sanitize`, as `ConfigTrust.classification` says. Proof: `test/config/trust.test.ts`,
  `test/config/config-trust.test.ts`.
- The `env` setting (`Config.Info.env`): it can put `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, proxies, CA bundles or provider
  keys into every program Orbit starts, so `ConfigTrust.classification` withholds it whole (kind `env`) from an
  untrusted project or local document, compat settings files included. It is read at each spawn through
  `ConfigEnv.resolve` for the shell, terminals, hooks, the shell snippets of slash commands, MCP servers, language
  servers and formatters of a host-local
  location, under each program's own variables and Orbit's. `NoDefaultCurrentDirectoryInExePath` cannot be set from it
  in any spelling, and each program receives one spelling of `PATH` and that variable at 1 (the shell in
  `test/config/env-shell.test.ts`, terminals and hooks in `test/config/env-spelling.test.ts`, MCP in `test/mcp.test.ts`,
  language servers in `test/lsp-spawn.test.ts`, formatters in `test/formatter.test.ts`; decoy programs cannot pin this,
  because Windows stops the working-folder lookup for any value of the variable). Proof: `test/config/env.test.ts`,
  `test/config/config-trust.test.ts`.
- Hooks and stdio MCP servers that the person or the organization wrote: they start with the project's folder as their
  working folder, where `bun` reads a `bunfig.toml` preload, `npx` an `.npmrc`, `uvx` a `uv.toml` and `git` the
  repository's config, so the program the person chose loads code the clone chose. Until `ProjectTrust.trusted()` holds,
  `LifecycleHooksPlugin` runs no hook (one warning per process) and `Mcp` starts no `local` server whatever its `cwd`
  (status `failed`, saying it waits for trust); a `trust.updated` event starts the waiting servers, and hooks read the
  trust each time one fires. A guard that cannot run never reads as no guard: a `PreToolUse` hook, the one event
  here that can stop a call, that applies to a call (user, managed or any document that reaches the runner) refuses
  it with a reason naming `/trust`, `orb trust` and `--trust`, and no process starts; the other events wait. Proof:
  `test/plugin/lifecycle-hooks-untrusted.test.ts` (scope x trusted x block, allow, error, with a marker and a trusted
  control). A remote server is not a spawn and is not held. Proof: `test/plugin/lifecycle-hooks.test.ts`
  (a hook that writes a marker in its working folder, untrusted then granted, and the project and other-product hooks
  held as before) and `test/mcp.test.ts` ("a local MCP server waits for the project folder to be trusted": spawn
  recorder, three `cwd` spellings, trusted control). The interactive clients show no trust dialog for this, since no
  config file of the clone is withheld (Known gaps).
- `{env:}` and `{file:}` references in those documents: `ConfigVariable.substitute` with `within`. Proof:
  `config-trust.test.ts`. The folders it may reach come from `standing()` in `packages/core/src/config.ts`, which for
  config above the project asks `ConfigTrust.reach`: a holder that is the home directory or a filesystem root
  (`WorkspaceTrust`'s own `persistent`) reaches only the config container, and a document directly in it nothing.
  `ProjectTrust.supplies` asks the same function. Proof: the `ConfigTrust.reach` table in
  `test/config/trust-fingerprint.test.ts`; the wiring from the store's answer through `standing()` and `supplies` on every
  machine, with a store that calls one folder a root (`config-trust.test.ts`, "root-like": two rows, each with a control);
  and with a real root in "does not let a file reference … reach the drive", which needs a root the test may write to and
  returns without testing elsewhere (Linux as root). A drive made with `subst` cannot stand in for the real root on
  Windows: the runtime resolves it to the folder behind it.
- Executable config that changed after the folder was trusted (`Fingerprint`, `packages/core/src/config/fingerprint.ts`,
  `WorkspaceTrust.compare`): the folder's grant records one SHA-256 of canonical JSON (sorted keys) per kind and source,
  and a kind whose digest differs, or that cannot be read, is cut from that source only (`ConfigTrust.partial`: a document
  loses the fields, a directory lists `withheld`). Implicit trust records nothing. Each row names the digest input and the
  test that pins it; a mutation that fails each is in the pull request.
  - `hooks`, `mcp`, `plugins`, `providers`, `shell`, `formatter`, `lsp`, `env`, `sandbox` of a document: that field
    (`test/config/fingerprint.test.ts`, one row per kind; `config-trust.test.ts`, "stops <kind> after it is edited").
  - `skills` of a document: the field and the front-matter `hooks` of the skill files under its local paths
    (`fingerprint.test.ts`).
  - `plugins` of a directory: every regular file in each plugin folder (`node_modules` inside a plugin folder is named,
    not entered; a `node_modules` directly in `plugin/` or `plugins/` is never a plugin, for the digest, the server
    loaders and the TUI alike), listed by the same link-aware walk as agents/ and skills/, so nothing a folder supplies
    reaches the runtime's resolver before trust, and `reach` and `walk` call `fs.resolve` only after `LinkShare` has
    found no share link on the way; a single-file plugin and the `package.json` beside it, by content
    (`fingerprint.test.ts`, `fingerprint-tui-only.test.ts`: edits, a touch, an edit with the old time, a tui-only folder;
    `fingerprint-plugin-share.test.ts`: tui.ts, server.ts, package.json and a server/ folder linked to a share, an
    untrusted load, and a control; `fingerprint-node-modules.test.ts` and `plugin-source-bad-entry.test.ts`: nothing under
    `plugins/node_modules` is read or offered; `plugin-trust-read.test.ts` in the TUI). `scan` compares
    again when it runs, because its change feed fires before the reload (`config-trust.test.ts`: "offers no plugin planted
    after the grant"). `ProjectTrust.status` reads the plugins of a config directory from the disk when it answers, so a
    client that imports plugins on a file event (the terminal UI asks again before it does) sees one planted after the
    grant before the reload (`project-trust.test.ts`: "lists a plugin that shows up in a trusted folder at once").
  - `hooks` and `mcp` of a directory: the front matter `hooks` of its skills and agents, and `mcp_servers` of its agents
    (`fingerprint.test.ts`). Nothing runs them yet; `ProjectTrust.allows(file, kind)` is what hooks-21 and
    agents-extensibility-9 ask (`project-trust.test.ts`).
  - A digest that cannot be read: `fingerprint.test.ts`, `workspace-trust-records.test.ts`.
  - What the digests read is bounded (class 1, 4 and 6) by the folders that `ProjectTrust.supplies` holds the config to:
    the project's own folders (the Location's directory, the project's directory and its canonical root) for a source
    inside the project, and `ConfigTrust.reach` for a source above it. `Config.observe`, `ProjectTrust.allows`,
    `ProjectTrust.status` (`differences`) and `Config.pluginsChanged` pass the same folders, so a grant, a load and a later
    comparison compute the same digest, before a folder is trusted and after. A path whose real path lies inside them is
    followed through any link, wherever the link sits, and hashed at the real path: a plugins folder, a plugin file or
    folder, an agents/ or skills/ folder, or a folder nested in them, that links to another folder of the project. A path
    whose real path lies outside (an absolute one, `~/`, `..`, a link or junction that leads out, `.orbit` itself as a link
    out) is not listed, opened or hashed: its name and the links on the way to it, each as written and one hop, are, so
    pointing a link somewhere else is a change and editing what it points at is not. A network path (`\\host\share`,
    `//host/share`, `\\?\UNC\…`), or a link that names one (`LinkShare`, shared with `ProjectTrust`), is not touched at
    all, not even to look at it: nothing below such a link is handed to the file system, a link read included
    (`fingerprint-bounds.test.ts`, "never reaches below a link that names a share"). Only regular files are read, so a link to a device is named and not waited on. The walk of
    agents/ and skills/ enters a link only when its real path is inside the bound, and stops at a loop. Proof:
    `test/config/fingerprint-bounds.test.ts`, one row per spelling (agents/ and skills/ as a link out, a link out inside
    agents/, a file link in agents/ and plugins/, plugins/ and a plugin as a link out, absolute, `..`, the folder around the
    project, three network spellings, a device on Linux), each with the outside content changed between two digests and a
    recorder of every path the file system was given, and trusted controls; `test/config/fingerprint-links.test.ts`
    (plugins/ as a link to a project folder with a plugin added, a plugin file link, a plugin folder link, agents/ as a link
    into the project, a re-pointed link out, `.orbit` as a link out, and the loaders: the plugin is held back after the
    change and offered again after a new grant, and one behind a link out is never offered); and
    `test/config/fingerprint-container.test.ts` (an untrusted load with `.orbit` as a link out).
    `PluginSourceDirectory.entrypoints` loads no plugin whose server, tui or rpc entry leads out of its folder, the
    terminal UI refuses a project plugin whose tui entry leaves its folder (`plugin-trust.test.ts`), and
    `ConfigPluginSource.scan` and the terminal UI's plugin discovery (`discoverPluginTargets`, `plugin-trust-read.test.ts`)
    leave out a project plugin whose real path lies outside the project, so no plugin is loaded that the digest cannot see.
  - Records are per source, kept beside the grant and dropped with it (`workspace-trust-records.test.ts`); two locations
    under one root do not invalidate each other (`config-trust.test.ts`).
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
  check is built, and an `ORBIT_MANAGED_DIR` that a user can write is the user's own choice), and no project file can name its location (the override is the server's environment or
  `ServerOptions.managed.directory`); a config `env` cannot set `ORBIT_MANAGED_DIR` or the other `ORBIT_*` control names
  for the programs Orbit starts either (`EnvConfig.isReserved`, pinned in `env.test.ts`). A repository file cannot write the `managed` key: `ConfigNormalize` drops it
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
- What a style and a skill may say to the model (class 8, prompt form): reading is the entry above, and it lets the text
  of a folder that is not trusted reach the prompt, so two things limit what that text is taken for. An output style from
  such a folder goes last under its own heading but does not replace the prompt's opening line, which says what the agent
  is for: `OutputStylePlugin` asks `ProjectTrust.trustedSource` at each request, the question `supplies` starts from (a
  source that is not a project's or a local one is the person's own, one in the project's folders follows the decision
  just made, one above them follows its own stamp). No style removes "Harness" or "Consent", where
  the rule about who can approve an action stands before the style's text. A skill's instructions are followed for the
  task it was loaded for, and the prompt says that a skill's claim of an earlier approval does not count. Whether a
  project's styles and skills should reach the prompt before the folder is trusted is the owner's open question. Proof:
  `test/plugin/output-style.test.ts` (six places a style can come from, three spellings of the key, before a grant, after
  one and after a revoke, the clone's claim of approval as the body), `test/project-trust.test.ts` (`trustedSource`),
  `test/session-system-prompt.test.ts` and `test/plugin/optimize.test.ts` (the sentences about approval).
- A folder's `attribution` text (class 8, prompt form): `ConfigTrust` withholds it whole (kind `settings`) from an
  untrusted project or local document, because a project's field outranks the person's, `""` included; once the folder
  is trusted `resolveAttribution` ranks the scopes as before. Proof: the attribution rows of
  `test/config/config-trust.test.ts` and `test/config/trust.test.ts`. It reaches `system[0]` in the git section as an indented literal
  block, line for line, split on every line separator (`\n`, `\r\n`, `\r`, U+2028, U+2029), so no line can open a
  top-level section that an output style would cut at. Proof: `test/plugin/prompt-config.test.ts` (the separator table)
  and `test/session-system-prompt.test.ts`.
- Instruction files (`AGENTS.md`, `ORBIT.md`): `ProjectTrust.reachable`, asked by `ConfigInstructionPlugin` and
  `SessionInstructions`. Both then process every file with `ConfigInstructionFile.parse` (class 11). Its front matter is
  taken off by `ConfigMarkdown.split`, which finds the delimiter lines and parses and evaluates nothing, so a `---js`
  opener is not front matter and its text is kept as written, and a bare block is removed whatever it holds. Its comment
  blocks are found by a scanner that reads the file once, line by line, because the block lexer of a Markdown library
  takes seconds on a list item of a few thousand lines, and a clone chooses the file before anyone has trusted it.
  `instructions_exclude` names files to leave out. Exclusion only removes files, and comes before `reachable` in both
  readers. `SessionInstructions` (the files a read brings, found by `InstructionTriggers`) asks `ProjectTrust.importable`
  on the file's real path just before it reads it instead, so a nested file that a link leads out of the project's
  folders sends nothing in a trusted project as well, and a session at the home folder has no root until that folder is
  trusted. A filesystem root is treated the same way by `ProjectTrust`, but no test here pins a session started at one
  (FU-M4-44). Proof: `test/session-instructions.test.ts` ("a symlink to, trusted or not", "InstructionTriggers"). A
  project's or local file's list is withheld while the folder is not trusted (`ConfigTrust`, kind `settings`): the lists
  of every scope are added up, so a repository's would hide the user's own files from the model.
  Proof: `test/instruction-discovery.test.ts`, `test/session-instructions.test.ts`,
  `test/config/instruction-file.test.ts` (the hostile inputs run in a child process with a deadline) and
  `test/config/trust.test.ts`.
- Local variants (`ORBIT.local.md`, and the reference vendor's local name with compatibility on) are repository-supplied
  files like any shared file: they are looked up in every walked folder, with a slot of their own beside the shared names
  (`ConfigInstructionFile.pick`), and meet the same `reachable` gate, the same exclusion and the same imports. Proof: the
  "keeps a project's imports inside the project until its holder is trusted" block of
  `test/instruction-discovery.test.ts` (a local name that is a link out, and an import outside from a local file, each
  trusted and not, with the label `local` on the file and on what it imports) and the "does not inject ORBIT.local.md
  when it is a symlink out of the project" rows of `test/session-instructions.test.ts` (the lazy read).
- The managed instruction file (`ORBIT.md` in the folder the `ManagedSettings` snapshot was read from): the folder is
  the administrator's, so the file loads whatever the project's trust decision is and `instructions_exclude` never
  applies to it or to what it imports. Its imports inside the project load as a project file's do; an import outside the
  project waits for the project itself to be trusted, and a refused one is an import warning for the project root
  (class 1, 3, 7). A file that is there and cannot be read makes the source unavailable, so policy text already admitted
  stays. Proof: the "loads the managed instruction file" block of `test/instruction-discovery.test.ts`.
- Rule files (`rules` folders: `<folder>/.orbit/rules` in each folder of the walk, the vendor's `rules` folder in a root of
  another product while compatibility is on, `rules` in the config folder, and `rules` beside the managed file; read by
  `ConfigInstructionRules.scan` and loaded by `ConfigInstructionPlugin` and, for the folders a read passes through, by
  `InstructionTriggers` and `SessionInstructions`; classes 1, 4, 6, 7, 11 and 14). The scan opens nothing before the gate:
  a network spelling, or a link that leads to one, is refused without disk access (`ProjectTrust.leads`), a folder is
  entered once under its real path so a link loop ends, and a project rule's folder and every file is asked of
  `ProjectTrust.reachable` and `ProjectTrust.supplies` on its real path at start (the stricter answer wins, so a rule in
  a folder above an untrusted project waits for trust, as the instruction file there does) and, when a read passes
  through, of `ProjectTrust.importable`, or for a rule of a folder above the project (never one inside it), `reachable` and `supplies` again
  on where it leads now. So a rules folder, a subfolder or a file that is a link out of the project is skipped alone,
  trusted or not at injection, and a nested rules folder that is a link out is never listed or read.
  The person's and the administrator's rules are theirs: only the network refusal applies. The `paths` key is read only
  from the block `ConfigMarkdown.split` finds, only by `ConfigMarkdown.parseOption` (YAML, never evaluated; a block that
  does not parse makes the rule unconditional, with one debug line), and a pattern only chooses when text the folder
  already supplies is shown: it never names a file to read. Patterns match the path from the base, both real, with
  `FSUtil.contains` on the two real paths deciding containment (`ConfigInstructionFile.ruleMatches`); the number and
  the length of patterns are capped, and `ruleMatches` (class 7) matches rule paths with Bun's glob matcher, whose time grows with the path and the pattern and cannot blow up, and matches nothing for a path over 1,024 characters or 32 segments, because a repository writes both the pattern and the file name (proof: the "bounded time" row of `test/config/instruction-rules.test.ts`, a child process with a deadline, over a path whose file is named `b` so that no hostile pattern matches early; restoring the old `ignore` matcher fails the rows at seconds each, Bun.Glob passes). The file is looked at again, by where it leads now, when it is injected. Proof: the
  "loads rule files" block of `test/instruction-discovery.test.ts`, `test/config/instruction-rules.test.ts`
  and the "rules that wait for a matching read" block of `test/session-instructions.test.ts` (the swapped-link rows,
  trusted and not, and the network decoy).
- `@path` imports in instruction files (`ConfigInstructionFile.imports` and `load`, called by `ConfigInstructionPlugin`
  and `SessionInstructions`; class 1, 4, 5, 6 and 7). A token is hostile input: it is found by one linear pass over the
  lines (no Markdown library), and a token with a control character is dropped alone, never joined into a path. For each
  import, before it is statted, resolved, read or watched: a network spelling (`//host/share`, `\\host\share`) is
  refused without any disk access, in every scope; `ProjectTrust.leads` gives the real path, which names a link to a
  share as the share without opening it, and that real path is what is checked and read. A project file's import must
  really lie (real paths, whatever the trust decision) inside a project folder that can be trusted for good, or inside the folder
  the session started in when that folder can be or is trusted now; the home directory and a filesystem root can count only once a person trusts them for the session, and then only as the folder the session started in, so a session or repository at `~` that nobody trusted does not open the home
  folder to a downloaded folder's `@~/.ssh/id_rsa` (`ProjectTrust.importable`), and be accepted by
  `ProjectTrust.reachable`. An import that fails that rule is skipped with one `ImportWarning` per importer and target
  unless the folder that holds the importing file opens it (`ProjectTrust.outward`, asked only after `importable` refused,
  and kept for one pass). A file in the project's folders is held by the project, the canonical root's decision and not
  the folder the session started in, so a grant for a subfolder opens nothing and a linked worktree follows its
  repository; it opens when that is trusted now and can be trusted for good, or is the folder the session started in, so a
  session below `~` stays bounded even when the home project is trusted for the session. A file outside the project's
  folders (one above it, or one a trusted file brought in) is held by the folder that owns it (found as `trustedAt`
  finds an owner), which must be trusted now and able to be trusted for good, and the project must open as well; a home
  directory or a filesystem root never holds. A chain does not inherit: what `~/team/rules.md` imports waits for
  `~/team`. The warning carries the `directory` whose trust would lift it, unset when no grant made from this session
  could. A user-level file's import is gated by the network refusal alone, and the network refusal holds in every scope,
  trusted or not. Files the model's reads load later never import outside the project, even when it is trusted. `instructions_exclude` is asked before the file is opened, a name outside the text extensions and
  a NUL in the text are refused, and a missing target, a folder or a pipe is skipped silently. The watch set is the real
  path of each import that was read, and nothing refused is ever subscribed. Managed and local files do not exist in
  Orbit yet (prompts-context-10): when they arrive they take the project rule. Proof: the `imports` and `load` blocks of
  `test/config/instruction-file.test.ts`, the "follows @imports", "keeps a project's imports inside the project until its holder is trusted" and "lets a trusted
  holder import from outside the project" blocks of `test/instruction-discovery.test.ts`, and `test/session-instructions.test.ts`, whose "home folder" blocks pin the repository-at-home row.
- Paths that a file tool is given: `ProjectTrust.escapes`, asked by `FileAccess.resolve`. The `edit` tool's `validate`
  reads the file before any permission is asked, so it reads only when `resolve` reports no `externalDirectory`: a link
  out of an untrusted project is not read until the folder it leads to has been approved. Proof:
  `test/file-access.test.ts`, `test/tool-edit.test.ts` (that link, with a trusted project as the control),
  `test/tool-write.test.ts`.
- Language servers and formatters: `ProjectTrust.trustedAt(file)` per file in `Lsp.diagnostics`, `Lsp.request`, `Lsp.send` and
  `Formatter.file`. It needs the Location's project trusted, and a file outside the project's folders also needs the
  folder that owns it (found as `Project.root` finds one, from the real folder of the file) to be trusted. It decides the
  spelling the tool and the spawned program act on and the real path, and the real path needs a trusted owner, and so does the
  target of every link on the spelling that is not on the real path's own walk (the stricter answer wins, class 3), so a
  link in an untrusted folder, with or without a marker, that leads into a trusted one is refused, as are a link that leads out,
  a dangling link, `..` and the Windows case of a name. A refused file is skipped. Proof: `test/lsp.test.ts`, `test/lsp-trust.test.ts`,
  `test/plugin/lsp-diagnostics.test.ts` (a Write by `~`, Git Bash, Cygwin, WSL, trailing dot and space and case
  spellings), `test/formatter.test.ts`, and `test/tool-lsp.test.ts` (the `LSP` tool's new actions refused while the folder
  is untrusted, with no server started). The git ignore check of `Lsp.ignored` runs only after the request has passed
  this gate and checks the folder's trust itself (`test/lsp-ignored.test.ts`, the untrusted row), in the trusted Location's repository, through `Git.Service`'s resolved executable, with the paths on stdin.
- Executables that Orbit looks up itself (`git`, `rg`, shells, formatters, language servers, the sandbox tool, the
  Azure CLI check): `which` in `packages/util/src/which.ts` reads `PATH` and Orbit's own `bin` folder and never the
  working folder, unless `PATH` itself names it, for example with a relative entry such as `.` (see Known gaps). Proof:
  `packages/util/test/which.test.ts`, `test/ripgrep-binary.test.ts`, `test/util/git-executable.test.ts`.
- The PowerShell parser host (`packages/core/src/shell/powershell-parse.ts`): Orbit asks PowerShell's own parser what a
  command does and reads a summary of the syntax tree. The host is `pwsh`, then `powershell` on Windows, found with
  `which` (never the working folder; nothing on `PATH` is no host) and started by its full path through
  `CrossSpawnSpawner`. Only a snap launcher that `PATH` did find is swapped, on Linux, for the real binary at a fixed
  package path. The host runs in the system temp folder,
  with `-NoProfile -NonInteractive -NoLogo -EncodedCommand`, nothing on stdin and no temp file. The command text is a
  base64 string literal that the script decodes, so it cannot close a quote, and the script only parses. Every failure
  (no host, spawn, timeout, exit, empty output, bad JSON, too long, parse errors) is an invalid result that callers read
  as "ask". Proof: `test/shell-scan/powershell-parse.test.ts` (the real parser on the hiding spellings listed in its row tables, the injected
  host for each failure, and `.exe`, `.bat` and `.cmd` decoys in the working folder with a control that runs them).
- The shell guard (`packages/core/src/shell/guard.ts`) and its bare-repository probe: for a command that runs git at any
  level (by name, by path, through `xargs` or `find -exec`), the guard walks from the working folder, each folder the
  command changes to, each `git -C` and each literal `--git-dir` or `GIT_DIR` value up to the root, as git's discovery does. It
  only stats and reads small `.git` files and never runs git. Before it stats any of `.git`, `HEAD`, `objects`, `refs` or a
  worktree's `gitdir` file, it asks `LinkShare.of` about that path: a part that is a share, or leads to one through a link the
  repository ships, is never stat-ed and counts as `indicators` (or `unverified-gitdir` for `.git`), so it asks. A folder with no valid `.git` (a directory holding a regular
  file `HEAD`) that holds any one of a `HEAD` file, an `objects` folder or a `refs` folder is a finding `indicators`. A `.git`
  file is trusted only when it is one line `gitdir: <path>` of at most 4 KB that names a linked worktree whose `gitdir` file
  names this folder back, or a folder under an enclosing repository's `.git/modules`; any other is `unverified-gitdir`, and
  its text is data (class 5): it is never handed to git and never opened when it names a share. A git directory named on the
  command line other than the repository's own is `git-dir`. The probe runs in an untrusted folder too, because it is the
  protection for one: its result only adds a finding to the shell request's metadata, which shell-safety-12 turns into an
  ask. Every path the guard resolves is judged on its real place (`ProjectTrust.leads`, then `FSUtil.contains` on two real
  paths), and a share is named without being opened (the rows "the bare-repository probe and links to shares" record the stat calls). Proof: `test/shell-guard.test.ts` (the link, dangling
  link, new-file-under-link and numeric-link rows run trusted and untrusted; the probe, share, Windows spelling and finding rows run trusted;
  the rows for input over the length limit run in a project with a link that leads out and nothing trusts). Input the
  analysis cannot read is split into fragments, whose `cd` targets and plain words go through the same containment and
  `access.escaped` checks as analysed input.
- Shell commands outside the tool's own call: the `!` spans of a slash command go through the same gate
  (`ShellGuard.authorize`) as the shell tool, so a deny, a folder outside the project and input Orbit cannot read are
  judged the same way (class 12). Proof: `test/config/command-shell.test.ts`, `test/shell-guard.test.ts`.
- The sed flavor probe (`SedScript.flavor` in `packages/core/src/shell/sed.ts`): to decide whether a `sed -i` command can be
  computed by Orbit, it runs the shell the shell tool uses (a full path it was given, started through the injected
  `ChildProcessSpawner`) once with the fixed script `sed --version`, nothing on stdin, the given environment only, in the
  system temp folder (never the project, so a relative `PATH` entry cannot reach a planted `sed`), with a 3 second deadline
  and a capped read. No repository text reaches the probe. A timeout, a failed start and a non-zero exit are no output, which
  is `unknown` (no emulation) outside macOS. The emulator itself reads no file; the caller that wires it (shell-safety-15b) adds
  its own rows. Proof: `test/shell-analysis/sed.test.ts` (`SedScript.flavor`: one process per shell and `PATH`, the arguments,
  working folder and environment, the exit, failure and hang rows).
- Programs that Orbit starts by a bare name (`hg`, `node` or `uvx` as the command of an
  MCP server, the pager's `cmd /c more`): on Windows Bun's spawn, Node's, cross-spawn and `cmd.exe` look in the working
  folder before `PATH` for a bare name, unless the process that starts it has `NoDefaultCurrentDirectoryInExePath`.
  Every Orbit process sets it in its own environment first (`ProgramLookup.install()` in
  `packages/util/src/program-lookup.ts`, called at the start of each entry, see class 10). `CrossSpawnSpawner` in
  `packages/util/src/cross-spawn-spawner.ts` installs it again before every launch, gives every child the variable too,
  a `.cmd` started by its full path included, and stops a running process with the `taskkill.exe` of `System32`. Proof:
  `packages/util/src/program-lookup.test.ts`, `test/effect/cross-spawn-spawner.test.ts`, `test/project.test.ts` (a
  folder with `.hg` and an `hg.exe`) and `test/mcp.test.ts`, and the `test/program-lookup.test.ts` of `packages/cli`,
  `packages/sdk` and `packages/server`. They delete the variable from `process.env` first, and those that run a decoy
  plant real `.exe` files. The language server client starts its server through the spawner, and `test/lsp-spawn.test.ts`
  runs it against `.exe`, `.bat` and `.cmd` decoys with a copy on `PATH` as the control. `test/program-decoys.test.ts`
  does the same, on Windows only, for a configured formatter's command head, for a hook command run by each of
  PowerShell, Git Bash and `cmd` that is installed on the machine (the user's own hook, with the project's decoys in the
  Location's folder), and for the shell tool in each of those shells. It also pins that `ShellSelect.resolve` gives each
  shell as a path outside a working folder that holds decoys of it. Its mutation: with `ProgramLookup` no longer setting
  the variable, the formatter row and the `cmd` rows fail; the PowerShell and Git Bash rows pass either way, since
  neither shell searches the working folder. `pwsh` is skipped where it is not installed, and a built-in formatter is not
  covered. `git` is not started by a bare name on Windows: when `which` finds none, `gitExecutable` is a path in `System32`
  that is not there (`resolveGitExecutable` in `packages/core/src/util/git-executable.ts`), because the library under the
  spawner also resolves a name itself, with and without an extension, and starts the interpreter that the `#!` line of a
  file called `git` in the working folder names, which the variable does not stop. `test/util/git-executable.test.ts` starts
  the Git service in a process of its own, under Bun and under Node bundled for it, with git on no PATH, and plants a
  `git.exe`, a `git.bat`, a `git.cmd` and a file called `git` with a `#!` line, each alone in a folder, with a control that
  each one runs when started the way that finds it, and one that the `git` of PATH runs and the folder's does not. Its
  mutation: with the bare name back, the two rows for the file with no extension fail. Linux has a decoy row of its own.
- Provider packages: inside the compiled binary `Provider.loadPackage` loads a built-in provider or one from the npm
  cache, and never resolves a name from the folder. Proof: `test/provider-compiled.test.ts`.
- Code Mode `fetch`: `PermissionWeb.request` for every hop, then `AddressGuard.check`. Proof: `test/codemode.test.ts`,
  `packages/util/src/address-guard.test.ts`.
- The session scratchpad (`SessionScratchpad`, `packages/core/src/session/scratchpad.ts`): the folder `sessions/<key>` in
  Orbit's temporary folder, which the baseline names as the place for the model's temporary files, which a drain makes
  before its first step and which goes with its session. It reads nothing that a folder supplies. The key is the ID of the
  session that the lineage goes back to, and a client chooses that ID (`POST /api/session` takes `id` and `parentID`, and a
  fork names its source), so it names a folder only when it is `ses_` and letters, digits and underscores (class 5): any
  other ID gives no folder, no section of the baseline, no allow and no removal, and making the folder says so once, with
  the characters of the ID that act on a terminal written out (class 9). A link where the folder should be is logged and
  left alone, and a deletion removes a link as a link. The allow that lets an agent edit there without a question
  (`Agent.scratchpad`) is Orbit's own (class 4: it never decides a place that a link of an untrusted project leads out
  to), is cut to the folder of the session that asks (`Agent.narrowScratchpad`), sits before the person's rules so that
  their deny wins, and decides a call only where the real place of the call is in that folder too (`decide` in
  `Permission`), so a link inside the folder that points out is decided by the rules for the place it points to. Proof:
  `test/session-scratchpad.test.ts` (the hostile IDs as the ID, the parent and the fork source, each with a marker where the
  ID would name a folder, and a control), `test/permission-scratchpad.test.ts` (the sessions of a lineage, the hostile IDs,
  the links and the Windows spellings, with the plain file in the folder as the control),
  `test/session-scratchpad-baseline.test.ts` and the `scratchpad` rows of `test/session-runner.test.ts`.

**CLI and flow** (`packages/cli`, `packages/flow`):

- The run store (`Store.at`, which `openStore` and the runner call for `orb flow ls`, `approve`, `cost`, `clean`,
  `replay`, `resume`, `show`, `trace`, `watch` and `run`): SQLite at `.orbit/runs.db` of the repository. It is not
  code, and `flow ls` runs before a trust answer, so the gate is class 6: a store whose path leads through a link to a
  share is refused without being opened. Proof: `packages/flow/test/store-share.test.ts`.
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
- Structured output: `--json-schema` names a file (or inline JSON) on the person's own command line, not one the folder
  supplies, so it is not a loader and needs no trust gate; a workflow or agent file that later supplies a schema joins
  this inventory and the gate. Every decoder has an explicit result and none runs a turn without validation: a schema
  that is unreadable, not JSON, not an object root, has an unknown keyword, a remote or unresolved `$ref`, or is over
  256 KiB or 64 levels is refused (the CLI before any session, the server at admission as a 400); a stored schema that no
  longer compiles fails the step; a validator that throws rejects that one hand-in. The validator interprets the schema
  and never builds code (no `new Function`, no `eval`), and a `$ref` loop that reads nothing ends as a failure. Property
  names the model chooses reach the model through the rejection text with control characters escaped, and the accepted
  value reaches a person only through `jsonLine`. Proof: `packages/core/test/session-output.test.ts`,
  `packages/core/test/session-prompt.test.ts` ("refuses ... when the prompt is admitted"),
  `packages/core/test/session-runner.test.ts` ("structured output"), `packages/cli/test/print.test.ts`
  ("--json-schema") and `packages/cli/test/run/noninteractive.test.ts` ("structured output").
- The run-scoped config of `--settings`, `--mcp-config` and `--agents` (`packages/cli/src/config-overlay.ts`), which
  reads a file by name, hands its content (or, for a `--settings` file, its real path) to a private server, and can
  start programs through `--mcp-config`. `--settings` decides file or inline by the value's shape alone, `stat`s a file
  before opening it (a device, pipe or directory is refused unopened), reads it the way core does (UTF-8, not UTF-16),
  and passes the real path in a version 2 envelope, never in `ORBIT_CONFIG`, which the private server's tools inherit.
  A flag document is the person's own and is never trust-stamped; core loads a file once, by real path (a link, case and a Windows 8.3 short name included), so naming the project's own
  `orbit.json` does not load it a second time, unstamped, in the flag scope (`Config.load`). The values are the
  person's own, so they are read and checked in the folder the person typed them in, before `orb <directory>` changes
  folder (a clone at that directory may ship a file of the same name) and before any server starts. The overlay does not
  trust the folder: the private server keeps `ORBIT_TRUST_PROJECT` as it was, and `orb -p` still stops in an untrusted
  folder. The file that carries the content to the server is read only when it is a file the CLI wrote
  (`overlays/overlay-*/<id>.json` in Orbit's per-user state folder, which is in no folder an agent may write without
  asking) and holds a version 2 envelope; any other path in `ORBIT_CONFIG_CONTENT_FILE` is left untouched with one log
  line, and the background service never reads it. A relative `{file:}` reference in a value is made absolute against
  the folder of the file that holds it (the start folder for an inline value) before it is merged, because core would
  otherwise read it in the opened folder. Errors that echo the value or keys from inside it go through `plain`, and a
  refusal before a session exists goes out in the requested output format. `--continue` is checked against the session
  the run will use, resolved once in the folder the run works in (`process.cwd()` after `orb <directory>` has changed
  folder). Only the session named at start is checked: the session list,
  restored tabs and `/resume` of an overlay run can still open one the service is running, as with `--standalone`. A value is inline JSONC or a file name by its shape (`{`, a `/*` comment or a `//` comment with more lines first), never by what is on disk, so a clone cannot supply a file named after the typed text (class 1; "no spelling of an inline value"). A `{file:}` that holds an `{env:}` is anchored by what its head resolves to, with a leading `{env:NAME}` read from this process's environment, which the server inherits.
  Proof: `packages/cli/test/config-overlay.test.ts`, `packages/cli/test/config-overlay-flags.test.ts` ("names a file in
  the folder the person typed it in", "is read from the person's folder", "is not trusted", "never drains", "orb
  --agents --continue", "refused as a result object"),
  `packages/cli/test/server-process.test.ts`.

**Terminal UI** (`packages/tui`):

- The editor locks: `readLocks` and `discoverEditors` (`src/editor.ts`) read `<state>/ide/<port>.lock`, a folder that Orbit
  owns and a clone does not supply. Each file is capped (`IdeLock.lockCap`), must be a plain file named digits and
  `.lock`, and is decoded with a schema (version 1, a pid that is a positive integer, a port that equals the name, absolute
  workspace folders, a token of the shared shape, which is checked before the value goes into a header). A bad file costs
  one log line, once per file and change, never quotes the file, and never stops a good sibling; a lock whose pid is gone
  is skipped, and the terminal UI never deletes a lock. A workspace folder holds the session folder by real path
  (`FSUtil.contains` on `realpathSync.native` of both, NFC), so a link, a shared prefix or a dangling link cannot make a
  window match; a network or device spelling is compared as written and never read from disk. The editor's name goes
  through `plain`. A selection or mention frame whose file name holds a control character, a line or paragraph separator, a bidi
  control or a zero-width space is dropped whole with one log line, since a clone can name its files as it likes; a
  refused selection also clears the stored one, so the previous file's selection never goes with the next prompt. The
  joiners ZWNJ and ZWJ and the soft hyphen are ordinary in some scripts' file names, so they pass (the trade-off: the
  footer and prompt show them as written). The footer label goes through `plain` as a second guard for the Zed source,
  whose names do not pass this check; that guard is not pinned by a test yet, so it is a defence in depth and not a claim.
  A frame over `IdeLock.frameCap` is dropped.
  Proof: `test/context/editor.test.tsx` (the hostile-name and frame-cap rows) and `test/editor-bridge-app.test.tsx` (the
  drawn footer and prompt). The token goes into the `x-orbit-ide-token` header and nowhere else. Proof: `test/editor.test.ts` (the
  discovery rows), `test/context/editor.test.tsx` (a real server: header, hello, ignored frames, reconnect that reads the
  lock again, no connection without the port, `TERM_PROGRAM=vscode` or `autoConnect`).

- Custom themes (`discoverThemes`, called by the terminal UI's theme provider and by Mini when they mount): a JSON file
  per theme, read from `<folder>/.orbit/themes` of every folder above the working folder, before any trust answer. It is
  data, not code, so trust does not gate it; the class 6 rule does: a name that is, or leads through a link to, a share
  is skipped before it is listed or read, and a theme that fails costs only itself. Proof:
  `test/theme-share.test.ts`.
- Plugins that the terminal UI imports in its own process: `trustedPluginDirectories` with `trust.startup`. Proof:
  `test/plugin-trust.test.ts`, `test/plugin-discovery.test.ts`.
- The status line command (`status_line.command`, user config): it runs with the terminal UI's own working folder, the
  folder it was started in, and programs such as `bun` or `git` read a `bunfig.toml` preload or a `core.fsmonitor` from
  there. It is also handed the folder of the session in view as `cwd` and `project_dir`, which a status line commonly
  gives to `git`. `Prompt` hands the command to `StatusLine` only while both `trust.startup.trusted()` and the status of
  that folder (`trust.folder`) are true, so no command runs and no line is drawn while either is untrusted, and it runs
  again when trust is granted. Proof: `test/status-line-trust.test.tsx` (the command itself and a `bunfig.toml` preload in
  the start folder, and `core.fsmonitor` and a `bunfig.toml` preload in the folder it is handed, each with a trusted
  control run).
- The trust dialog, bound to the folder in view when it opened: `TrustProvider` and `useTrustPrompt` in
  `src/context/trust.tsx`. Proof: `test/cli/tui/dialog-trust.test.tsx`.
- Run store text in the `/runs` dialog: `DialogFlowRuns` passes every string through `plain`. Proof:
  `test/component/dialog-flow-runs.test.tsx`.
- Agent, skill and command names and descriptions that a folder supplies: the TUI agent and skill dialogs, the `@` and `/` autocomplete and every Mini menu (`RunFooterMenu` in `src/mini/footer.menu.tsx`, the single render site for the Mini `/` and `@` composer) draw them through `plain`. Proof: `test/component/dialog-listings.test.tsx`, `test/prompt/autocomplete-hostile.test.tsx`, `test/mini/footer.view.test.tsx` (hostile row beside a trusted one).
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
- The operating system notification programs (`notify-send`, `osascript`, Windows PowerShell), started when
  `attention.backend` is `"system"`: found with `which` over absolute `PATH` entries only, started through
  `CrossSpawnSpawner` (`AppProcess`) in the person's home folder with a script that is a constant of the module, and the
  title and message passed as separate arguments (Linux, macOS) or environment values (Windows), after the host removed
  control characters and the session title, the form title and the failure message went through `plain`. `cli.json` is read from the global folder only,
  so a project cannot choose the backend. Proof: `test/util/os-notify.test.ts` (a message that breaks quoting, run against
  the real Windows PowerShell with a dry-run switch; decoys in the working folder and a relative `PATH` entry, with a
  control).

**VS Code extension** (`packages/vscode`, which runs in VS Code's extension host: not an Orbit process, and shared with
every other extension):

- The IDE bridge (`src/ide-bridge.ts`): a WebSocket server on `127.0.0.1` (the literal, never a name), port 0, with a
  4 KiB frame limit, that accepts an upgrade only with the token in the `x-orbit-ide-token` header (constant-time compare,
  answer 401, one log line that never holds a token; the token is never read from the URL). The token lives in a lock file
  written with mode 0600 in a 0700 folder, by temporary file and rename (retried on EPERM, EBUSY and EACCES while a reader
  holds the lock; the temporary file is removed when it still fails), and is never put in the environment (only the
  port is). It makes no outbound connection and starts no program (`orb` included). `orbit.ideBridge.enabled` has
  machine scope and is read from the user's own settings only, and the extension stays off in an untrusted VS Code
  workspace. At start it removes only version 1 locks whose pid is gone. Proof: `test/ide-bridge.test.ts` and
  `test/manifest.test.ts` (the setting's decision row, the command's gate row, the scan of the doors).

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

**Built-in commands of the terminal UI** (`/ide`, `/terminal-setup`, `/agents` create and edit, and the route they use):

- `/ide` lists the locks in the state folder that `readLocks` accepts, so nothing is read from a project folder; the name
  and folders an editor chose reach the dialog and its toasts through `plain`. `connect` reads the chosen window's lock
  again and dials `127.0.0.1` with the token in the one header; a window that never says hello is not retried and ends
  with a timeout. `/ide open` finds the editor's program with `which` (PATH only) and starts it through cross-spawn with
  the folder as its only argument, never through a shell. Proof: `test/context/editor-ide.test.tsx`,
  `test/component/dialog-ide.test.tsx` ("without control characters"), `test/editor-program.test.ts` (a `code.cmd` and
  `code.exe` decoy in the working folder, with `NoDefaultCurrentDirectoryInExePath` removed, and the control).
- `/terminal-setup` starts no program. It reads and writes one file of the person's own editor, never of a project: the
  keybindings file of the editor's user folder. A file that does not parse as a list (errors counted, not only a wrong
  type), one that holds the binding already, and one that binds Shift+Enter in the terminal to something else are left as
  they were and leave no backup; an edit is backed up first, under a name that never replaces an earlier backup, and a
  failed backup writes nothing. Remote editors (the git helper or `PATH` lies in the folder an editor keeps its server in,
  which `CompatEditors` names) are not written. The path goes through `plain`. Proof: `test/util/terminal-setup.test.ts`.
- `/agents` create writes `<config directory>/agents/<name>.md` from the TUI process, only when the server is on this
  machine. The name passes `ConfigAgent.isName` and the 3-to-50 rule, so it is one segment; every value is written as a
  JSON string (a valid YAML scalar), so no text of the person's adds a key or ends the front matter. Before anything is
  made, for a project, the nearest existing folder of the target is resolved on disk and must lie inside the real
  project root (`FSUtil.contains` on two real paths), and again once the folder exists; the file is opened exclusive
  (`wx`), so nothing is overwritten and a link at the path is not followed. Errors block the save. Proof:
  `test/util/agent-file.test.ts` (a junction at `.orbit/agents` and at `.orbit`, the existing file, the hostile
  descriptions, every refused name), `test/component/dialog-agent-create.test.tsx`.
- `config.sources.changed` takes at most 100 paths of at most 4096 characters, keeps those that are absolute, exist and
  whose real path lies inside the real path of a user, project or local config directory entry, and passes them to
  `Config.notify`, which reports them to `changes()` and reloads nothing. A forged path costs at most one more rebuild of
  the owners that read those sources. Proof: `packages/server/test/config-sources.test.ts`,
  `packages/core/test/config/notify.test.ts`.

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
  `ProjectTrust.allows(file, kind)` first, with the kind it would run (`hooks`, `mcp`). It decides by the store now, never
  by the stamp of the last load, and for a config directory it reads the files now, so a skill whose hooks changed is
  refused before the config has reloaded (`project-trust.test.ts`, "nested config"). Nothing consumes it yet.

- In a command that loads a file from the folder, call `requireTrust` (or `trustRefusal`, when you report the refusal
  yourself) before the load. Pass `imports` for a file that the command imports and `defines` for a file whose commands,
  approvals or agents it carries out. Both refuse an untrusted folder whatever it holds back. Without them the check
  refuses only a folder whose config holds something back, which is right for `orb run` and `orb loop`, because they
  import nothing. `strict` refuses any untrusted folder, and `orb -p` passes it (`handlers/print.ts`): a clean clone's
  `AGENTS.md` still steers a model whose tool calls run unasked under the default rules. Stream input (`--input-format stream-json`,
  through `orb -p` and `orb run`) starts work as well, so `headlessInput` makes it strict for both doors and refuses before the first
  line is read (`trust.test.ts`, the `stream-json input` rows). Its input lines name request IDs, form IDs, message IDs and models,
  which `run/protocol.ts` decodes with their exact schemas before the driver uses them (class 5), and its replies reach only the
  requests the driver itself showed, so a program on a shared server cannot answer another client's ask (`run/stream.test.ts`).
  Whether `orb run` and
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
- The terminal UI's startup walk (`localPluginDirectories`) runs before any answer and stats `.git`, `.hg` and each
  `.orbit` above the working folder. It asks `LinkShare.ofSync` (`@orbit/util/link-share`, shared with Core) first: a name
  that is a link to a share is "share", present but never stat-ed, and any other failure is one log line and an absent
  entry (class 6, 7). Proof: `packages/tui/test/plugin-discovery.test.ts`.
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
- `Project.resolve` counts the main checkout only when its repository also lists this folder, so a `.git` file cannot
  borrow another repository's identity or trust. For a folder that is not trusted, `GitLayout.locate` decides from
  files: the `.git` file has to name an entry directly under the `worktrees` of the `commondir` that the entry names, and
  the entry's `gitdir` file has to name this very `.git` (the back-link's folder is resolved and `.git` joined to it, so a
  `.git` that is a link cannot stand for another's). For a trusted one it is `git worktree list`. The trust decision for a
  linked worktree is its main checkout's, and any other layout leaves the folder its own canonical folder, so a clone
  that names a trusted repository gets none of its trust (`test/git-layout.test.ts`, `test/project-git-trust.test.ts`:
  every layout of `test/fixture/git-forged.ts` with the victim trusted, and a worktree that git added as the control).
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
- A share named through a chain of links (class 6 and 7). Windows follows up to 63 links in one path, and a repository
  can ship a chain of any length that ends at a share. `LinkShare` follows up to `LinkShare.LIMIT` (80) links, one
  `readLink` at a time, and a walk that reaches the limit answers `LinkShare.unresolved(file)`, a path that starts with
  two separators on Windows (`\\?\too-many-links\…`, a rooted `/\?\…` form elsewhere), never "no share": every caller
  then refuses or skips the path, as it does for a share, instead of
  opening it. `ProjectTrust.follow`, which decides where a write through a dangling chain lands, ends the same way. The
  listing of a config directory's `plugin` and `plugins` folders in `ProjectTrust.status` asks `LinkShare` first, since a
  direct link there is a share too. Proof: `packages/core/test/link-chain.test.ts` (40, 41, 63 and 85 links, for
  `LinkShare.of` and `ofSync`, `FileAccess.resolve`, `ShellGuard.facts` for an operand and for the workdir, and
  `ShellTool.concurrent` with a Git Bash context) and `test/config/fingerprint-plugin-share.test.ts` (an untrusted Config
  load and status, for 1, 40, 41 and 63 links from `.orbit/plugins` and `.orbit/plugin`). Mutation: restoring the old
  limit of 40 with `return undefined` fails every 41, 63 and 85 row.
- The loaders that the guard table pins ask `LinkShare` before they touch a path a repository supplies (class 6, rounds
  5 and 6). It lives in `packages/util/src/link-share.ts`, so that the compatibility package and the terminal UI ask it
  too. `LinkShare.blocked` and `LinkShare.resolve` stand in front of a stat, a realpath or a read; `LinkShare.scan`
  lists a folder with `readdir`, enters only a folder that a pattern can still match below (and never `node_modules`),
  and asks about each link entry before it enters it, at any depth, where the `glob` package follows every link (a
  link one level below a checked folder still connected). `FSUtil.up` skips a marker that is a link to a share. One
  question reads each part of a path once, however many links lead back through it. The rows, one test file per process:
  - `packages/core/test/share-roots.test.ts` (the server): `CommandFile.load`, `AgentFile.load`,
    `PluginSourceDirectory.discover`, `LinkShare.scan` for the skill folders, `CompatRoots.discover`, the settings
    file, the MCP file, a `{file:}` reference and an instruction marker found by `FSUtil.up`, each with its folder and
    the folder's children linked to a share. The recorded file system sees only `readLink` on the link and no `scan`;
    a control has links that stay on the disk, and a loop of links that ends. It has no row for config discovery's own
    `.orbit` and orbit files, for `Config`'s file loading or for the compatibility plugin's `realPath`.
  - `packages/tui/test/theme-share.test.ts` (the terminal UI and Mini, which both call `discoverThemes`):
    `.orbit`, `.orbit/themes` and a theme file linked to a WebDAV share served by a local listener that records
    connections, and a bad theme that costs only itself. The listing does not depend on trust, so there is no separate
    trusted row; the control is a plain folder read by the same call.
  - `packages/flow/test/store-share.test.ts` (`orb flow`): the run store `openStore` opens for every command that
    reads it, with `.orbit` and each of `runs.db-wal`, `-shm` and `-journal` linked to the same kind of listener, and
    the workflow and suite readers (`workflowCommands`, `loadWorkflow`, `suiteCommands`, `loadSuite`, which
    `trustOptions`, `load` and `resume` use before `requireTrust`) with a file linked to it, and controls.
  - `packages/core/test/link-share-bounds.test.ts`: the work the checks do (folders listed, links read) and a child
    process with a deadline.
  Mutations: `LinkShare.scan` entering a link entry without asking fails the nested rows of `share-roots.test.ts`;
  taking the check out of `discoverThemes` or `Store.at` fails the rows of their files; reverting `LinkShare` and
  `FSUtil.up` to the walk that starts again from the root at every hop fails three rows of `link-share-bounds.test.ts`.
  Not covered, and still a gap: the terminal UI's plugin folders, the VS Code diff view (another process), the native
  watcher, and the git calls that `orb flow` makes in the folder before it opens the store.

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
- A setting that validates is enforced, or it warns once that it is not: `hooks.http`, and `hooks.disabled` and `managed_only` outside the managed file, do
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
  `fallback_model`, `output_token_cap` and `shell_tool` (its timeouts are a budget; `test/config/shell-tool.test.ts` pins it)
  are withheld the same way (`test/config/trust.test.ts` pins each of the others). Never
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
  `PermissionView.of` (`packages/schema/src/permission-view.ts`) reads a request and nothing else, and every client draws
  what it returns.
- Show a place where the tool acts, and take it from the request. The server puts the absolute place on every request
  that names one: `metadata.paths` of a Read, Edit, Write, NotebookEdit, LSP and Patch request (a moved file's source
  too), with each diff's own `place` and, for a move, its `from`; `metadata.workdir` of a shell request and
  `metadata.path` of a Grep or Glob request; `metadata.method` and `metadata.url` of a fetch; and
  `metadata.arguments` of an MCP call, so a call through Code Mode is approved with what it sends. A client draws only
  those, through `PermissionView.of`, and its own `rawInput` is the one place the model's keys appear, labelled as such.
  A path from a tool's input is used only for a call that has recorded no place and is not being replayed, through
  `FSUtil.resolveFrom` as the tools resolve it, and from the fields the tool declares. A live pending call is sent with an
  empty input and names no place (no `cwd` either, for a shell); a replayed call carries its recorded input and names
  the places its record holds and none otherwise.
  An approval for a fetch shows the URL that the rules matched and the fetch connects to (no credentials, an ASCII host),
  not the spelling the model chose, and a request for a resource or a skill lists what it names.
  `packages/cli/test/acp/tool.test.ts` holds the spelling table for ACP and `packages/tui/test/util/path-format.test.ts`
  the terminal interface's and Mini's.
- Through a link in an untrusted project, the place is where the link leads: the server resolves it
  (`FileAccess.Target.place`) and puts it on the request, and the folder question names it, so no approval shows a link
  as a folder of the project (class 4). A call that no rule asks about has no request, so the file tools, the shell, Glob
  and Grep also report the place they resolved in their progress (`places`) before they ask or act, and ACP names it in
  the updates of the call (`packages/cli/test/acp/permission-files.subprocess.test.ts`, default rules, untrusted folder,
  with a trusted control).
- An allow that Orbit adds by itself is not the person's: it never decides a place that a link leads out to, and only
  the person's own rules and saved approvals do (`Permission.AssertInput.escaped`, class 4).
- A rule keyed on one field does not cover the others. Grep and Glob ask their own rules about the pattern, so the path
  they search goes through the Read rules first (`FileAccess.authorizeRead`), and a Read deny of `*.env` covers a Grep
  of `.env`. A rule matches the name a file has on disk: on Windows `FileAccess.resolve` turns every spelling of a file
  into that name before a rule sees it (class 4).
- An agent file under `agent/` or `agents/` defines its agent: it replaces an earlier definition of the id and rebuilds
  it from a default that allows everything. Therefore an untrusted file of that kind never replaces or tunes an agent
  that exists (its prompt included), and `ProjectTrust.status` lists `permissions` for every such file, not only for
  the ids Orbit ships, because which ids exist depends on entries the status cannot see. A file under `mode/` or
  `modes/` is not covered by this rule. Proof: `core/test/config/agent-definition.test.ts` ("an untrusted folder") and
  `core/test/project-trust.test.ts` ("lists every file under agents/ as held back").

**How to test:**

- Reproduce with the real config stack: a global `edit: ask`, an agent `autopilot` with `edit: allow`, and an untrusted
  folder that names `autopilot` through each route (`default_agent`, a command's `agent`, a workflow node, a judge or a
  member, an agent file's `mode`, `hidden`). Assert that the write is rejected and that `ProjectTrust.status` lists what
  was withheld. With `--trust` or a trusted project it works as before (`packages/cli/test/trust.test.ts` has this
  config).
- Plan mode: a config of `* * allow` must not make `general` spawnable.
- Completeness: the classification table compiles only if every field of `Config.Info`, `ConfigAgent.Info` and
  `ConfigCommand.Info` is classified, and `packages/core/test/config/trust.test.ts` ("covers every field") checks it.
- What is shown is what runs. `packages/core/test/approval-values.test.ts` runs Edit, Write, NotebookEdit, Patch (with
  and without a move), Read and LSP over every path spelling the runner accepts (relative, absolute, `..`, `~`, a link
  and, on Windows, the Git Bash drive form), in an untrusted folder and a trusted one, with every key a model can add on
  the input, and asserts that the request names the place the tool really acted on. It writes the rows to
  `packages/core/test/fixture/approval-matrix.json` (`UPDATE_APPROVAL_MATRIX=1` rewrites it); the requests of Glob, Grep,
  Bash, WebFetch and an MCP call are in `approval-matrix-pinned.json`, each naming the core test that pins its request.
  Every client draws those rows and fails on any place, file, method, URL or argument other than the request's, and on
  any decoy: `packages/tui/test/approval-matrix.test.tsx` (the terminal UI's presentation, and Mini's drawn as the real
  component), `packages/cli/test/acp/approval-matrix.test.ts` (ACP over the wire, approval and later updates),
  `packages/vscode/test/approval-matrix.test.ts` (the item and card VS Code draws) and, over a real `orb acp` process in
  an untrusted folder with a trusted control, `permission-files.subprocess.test.ts`. A new tool, client or path form
  adds its row to these.

**Review questions:**

- Does this field choose which rules, agent or mode apply? Then it is a permission: where is it classified?
- Does it pick a model, a provider or a budget? Then it is withheld as `providers`, never inert.
- Whose rules come last, and can an untrusted source be last?
- Can the approver see the whole thing that is approved (full span, method, URL, folder)?
- Does any client work out what it shows from the model's raw input instead of the request's resolved values (`PermissionView.of`)? Can a
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

**The advice that names a folder** is a sink too, and a worse one, because a person pastes it: the folder names in
`orb trust <folder> --for <location>` and `orb trust --revoke <folder>` come from folders inside the clone. Every name goes
through `plain`, and a command is printed only when `shellArgument` (`packages/util/src/shell-argument.ts`) can quote the
name so that no shell expands it (POSIX single quotes; on Windows only names that neither PowerShell nor cmd would expand);
otherwise the advice says there is no command and shows the escaped name. Proof: `shell-argument.test.ts` (reads each name
back through `sh`), `packages/cli/test/trust.test.ts` ("quoted so that no shell runs the name"), and a frame row in
`dialog-trust.test.tsx`.

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
`packages/util/src/which.ts` wrapped the npm `which` package, so on Windows a committed `git.exe` ran while Orbit
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

**In M4:** the decoy test that the bare `git` fallback lacked (register FU-M1-012) found a member that no `.exe`, `.bat` or
`.cmd` decoy reaches. cross-spawn on Windows resolves a bare name with its own lookup, which starts in the working folder
of the child whatever the variable says, first with the extensions of `PATHEXT` and, when that finds nothing, with none.
For a file it finds that starts with `#!`, it starts the interpreter the line names, with the file as its argument. A folder
that held nothing but a file called `git` with `#!/usr/bin/env node` on its first line therefore ran that file, under Bun and
under Node, wherever the Git service asked git something while git was on no `PATH` (`Project.resolve`, Snapshot, the
worktree listing). A `git.exe` beside it hides the file, because the first lookup finds the `.exe` and the spawn of the
bare name then fails, which is why the decoys of the other kinds never showed it. The fallback is no longer a bare name.
The same lookup serves every other bare name that is on no `PATH` (Known gaps).

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
- Find an executable with `which` in `packages/util/src/which.ts` and with nothing else. It feeds `gitExecutable`,
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
- One member of the class stays partly open: a child that is handed a `PATH` with a relative entry still searches it (see
  Known gaps). The terminal UI's external editor used to rest on `ProgramLookup.install()` alone and now has a test of its
  own (Known gaps, "The external editor"). Another is open for a bare name that is on no `PATH`: cross-spawn resolves it in the working folder, with and without an
  extension, and starts the interpreter that the `#!` line of the file it finds names (Known gaps). Known gaps lists each
  with its task. A change must not widen one.
- Do not hand the spawner a bare name that `which` could not find. `gitExecutable` does not: on Windows a git that is on
  no `PATH` becomes a path that is not there, and the call fails as it fails for a git that is not installed.
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
  `.cmd` that `PATH` holds still starting by name (`packages/util/test/which.test.ts`,
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
  check which file is returned (`packages/util/test/which.test.ts`, `git-executable.test.ts`, `ripgrep-binary.test.ts`).
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
- An instruction file is a reader of front matter too, and it does not parse it at all. `ConfigInstructionFile.parse`
  cuts a block off with `ConfigMarkdown.split`, which looks only for delimiter lines. A reader that needs the block, such
  as the `paths` of a rule file, takes the span that `split` returns and parses that through `parseOption`, so that one
  splitter decides what front matter is. A file whose first line carries a language after the dashes is not front
  matter, and its text is kept as written: nothing evaluates it, and it is the same instruction
  text that Orbit already loads from that folder.
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
- For instruction files the same spellings are written through `ConfigInstructionFile.parse`, `ConfigInstructionPlugin`
  and `SessionInstructions` (`test/config/instruction-file.test.ts`, `test/instruction-discovery.test.ts`,
  `test/session-instructions.test.ts`). The marker is absent, the text of a tagged opener is kept as written instead of
  the file being skipped, and a bare block is removed, one with CRLF line endings through all three and one that holds
  a `!!js/function` tag through `parse`. The control is `gray-matter` without the guard, which writes the marker for the
  JavaScript spellings (`coffee` has no engine in it, so that row has no control).

**Review questions:**

- Which library parses this file, and what are its default engines and caches?
- Is a spec's claim that a file kind is "just text" verified against the parser instead of assumed?
- Do all readers, `ProjectTrust.status` included, go through one parser module?

### 12. Entry points and process boundaries each need the gate

**Rule:** List every command, subprocess and process that can start work or load a file (`run`, `loop`, `flow run`,
`resume` and `replay`, `eval`, `orb -p` and `orb run` with stream input, `acp`, `serve --stdio`, the terminal UI's plugin loader, IDE buttons, SDK hosts), and
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

The program-wide register of every follow-up, these gaps included, with each one's carrier and status, is [follow-ups.md](follow-ups.md).

- **A drive letter mapped to a share is not told from a local drive by an import.** A trusted project's `@Z:/x.md` on a
  mapped network drive is read, where it was always refused before the outside rule, and an untrusted repository's one is
  still resolved and statted before `allow` refuses it (9b order). Unmapped `\\server` and `//server` spellings are
  refused before any disk access. Carried by `permissions-3a` as FU-M3-003; see "A share named before anyone is asked" below.
- **Fingerprints stop short of three things.** The skill and agent directories of other products' roots
  are not digested, so a hook added to a skill there is not asked about, and no consumer of those hooks exists yet:
  hooks-21 must digest them before it runs one. The modules that a plugin's entry file imports are not digested
  either, only the entry files and `package.json`. And a change that lands between the config's last load and the grant
  is accepted with the grant: binding a grant to the contents a client displayed is hooks-22.
- **A filesystem root as holder, end to end.** `ConfigTrust.reach` is tabled everywhere and its wiring is pinned on every
  machine with a store that calls one folder a root ("root-like" in `config-trust.test.ts`), but the test that plants a
  config file in a real root writes outside the sandbox of the test, so it returns without testing unless the root is
  writable (Linux as root, `tools/linux-test`). Run it there before a milestone closes.
- **VS Code gives the advice for the folder above a project without a command to run.** It names the folder and says
  that each folder is trusted on its own (`packages/vscode/test/trust-text.test.ts`); the terminal UI, Mini, `orb run` and
  `orb trust` print the `orb trust <folder> --for <location>` command.
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
- **The `webfetch` tool and a proxy.** `webfetch` now asks per hop, passes `AddressGuard.check` and connects to the checked
  address, as Code Mode `fetch` does. A user-configured proxy still sees that address and not the name; the owner has yet to decide.
- **A terminal UI plugin that first appears above the folder** while the UI runs is imported with no `config.updated` or
  `trust.updated` event. The structural fix is to walk from the server's project root (the owner's call, #20 re-review).
- **A headless run with no trust check.** `runV1Bridge` in `packages/cli/src/run/v1.ts`, exported from `@orbit/cli/run`,
  starts a run without `requireTrust`. Nothing calls it except an import-boundary test, so it is dormant. Whoever wires
  it in calls `requireTrust` first. It and `runNonInteractive({ auto })` also select the mode that skips permission prompts
  without the managed-settings check that the command handlers make (`bypassRefusal`), so whoever wires them in adds it too.
- **A typed refusal that a public error flattens.** `ConfigCommandPlugin.UntrustedError` reaches a client only as what
  `Command.execute` makes of every failure, because a Protocol change was declined as out of scope (#15). A client
  cannot tell a trust refusal from any other failure of a command.
- **A bare name that is on no `PATH`.** On Windows cross-spawn resolves a bare name itself, in the working folder of the
  child first, with the extensions of `PATHEXT` and then with none, and starts the interpreter that the `#!` line of a file
  it finds names. `NoDefaultCurrentDirectoryInExePath` does not reach that lookup. `gitExecutable` no longer hands it a
  bare name (class 10; the control row of `test/util/git-executable.test.ts` shows cross-spawn running such a file),
  but `hg` does (only for a trusted folder, since `Project.resolve` and the Mercurial provider start none otherwise) and
  so does `az` (the token command of the Azure provider, started in the folder that the server runs in). The fix is in the
  spawner: find the program with `which` and fail for a name that is not found. It changes what a relative `PATH` entry
  of a child does, which is the owner's question above. Register row FU-M4-001, task `sweep`.
- **A relative `PATH` entry in a child's environment.** `which` now skips every `PATH` entry that is not absolute (`.`,
  `bin`, `node_modules/.bin`, and on Windows a drive-relative or root-relative entry), so Orbit's own lookups never find
  a program in the working folder that way (`util.which` in `packages/util/test/which.test.ts`). A child that is handed a
  `PATH` with an explicit relative entry still searches it: a hand probe with Bun 1.4.2 on Windows had `cmd.exe` run a
  project `.cmd` through a `.` entry even with `NoDefaultCurrentDirectoryInExePath` set (no test pins this). That needs the person's own `PATH` or the person's own config to name
  the entry, because an untrusted project's `env` is withheld whole (the `env` rows in `core/test/config/env.test.ts`).
- **The external editor** is fixed (FU-M1-014, task `clients-ux-14`). `openEditor` and `openFile` in
  `packages/tui/src/editor.ts` share one launcher: the editor is found with `which` on `PATH` alone, started by the path
  that was found through cross-spawn with `ProgramLookup.environment(undefined)` and no shell, so a `code.cmd`,
  `vim.bat` or `code.exe` in the folder it runs in is not the one that runs. It calls cross-spawn directly and not the
  spawner, which sets `windowsHide` on every child and so would hide an editor the person has to see. Proof:
  `test/editor.test.ts` "starts the prompt editor from PATH and never a code.cmd, code.exe or vim.bat in the folder it
  runs in" (Windows; decoys, a control that runs each decoy by its path, and `NoDefaultCurrentDirectoryInExePath` deleted
  first). A value that needs `cmd.exe` no longer starts (upgrading notes).
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
- **Build checks.** `verifyArtifact` fails the build on an import or a `require` of a `#` name in the forms Bun writes in an unsplit build (`import("#x")`, `import"#x"`, `from"#x"`, `__require("#x")` and a call through the minified `import.meta.require` alias)
  (`packages/cli/test/verify-artifact.test.ts`), and `provider-compiled.test.ts` and `pdf-compiled.test.ts` import the
  autoload options instead of copying them. The alias set covers the whole file, so a minifier that reuses the alias name for another call could fail the build wrongly, and a `splitting: true` build, where a chunk imports the alias from an earlier or later chunk, is not covered and has no test. It still does not fail the build on a stray bare name: a text scan of the
  compiled binary finds hundreds of candidates, most of them guarded optional requires in dependencies (`ajv/dist/...`,
  `node-fetch`, `@aws-sdk/signature-v4-crt`) and bytecode noise, so a reliable check needs the bundler's own list of
  unresolved imports. Two names are not replaced in `packages/cli/script/runtime-requires.ts`, because nothing loads code through either
  today. `bufferutil` is not in the bundle: the server uses the `ws` that Bun carries, and Bun carries `utf-8-validate`
  but not `bufferutil`, so nothing asks for it. The npm `ws` package asks for it when it loads, so if a change ever
  bundled that package, `bufferutil` would be left to the runtime, resolve from the working folder's `node_modules` and
  run from there. `node-gyp/bin/node-gyp.js`, which the bundle does leave to the runtime, is only a path that npm looks
  up with `require.resolve` and does not load, and Orbit installs with scripts off. Replace the first before the binary
  imports the npm `ws`, and re-check the second before Orbit installs with scripts on.
- **PDF parsing runs in the server process, bounded in time for the page tree but not in memory.** Read counts and cuts
  the pages of a PDF in process (`Pdf` in `packages/core/src/tool/pdf.ts`). Read is allowed for every path by default,
  so a PDF in a project is parsed without a prompt. Measured on the library as pinned: a page tree whose nodes list the
  same child twice made `getPageCount` block the event loop for 3.2 s at 2,636 bytes and 88 s at 3,040 bytes (2^depth
  leaves; a 100 ms timer never fired). Closed in `Pdf`: it walks the tree itself, iteratively, refuses a node reached
  twice as corrupt, and does so before the library's recursive walk (`tool-read-pdf.test.ts`, depth 40, in a child
  process with a deadline, whole and by range, with a valid deep tree as the control). Still open: the library inflates
  object streams whole at load time and follows filter arrays, so a 1,407-byte file with `[/FlateDecode /FlateDecode]`
  took the process from 79 MiB to 1,629 MiB peak RSS. The 32 MiB source cap bounds neither that nor any other time or
  memory a hostile file can take, so a crafted PDF can still exhaust the memory of the server process, which every session shares. The library also interns every distinct `n g R` reference in a module-global pool that is never cleared: a 28 MiB one-page PDF with 2.5M distinct references took heapUsed from 67 MiB to 567 MiB, and it stayed there after a full GC and further reads (RSS 1.9 GiB), until the process exits. A worker that exits after each parse would free it. The reference bounds both
  with subprocess timeouts. Parsing in a worker with a time and memory limit was deferred as a follow-up on the premise
  that the cap was enough; these numbers say it is not, so it goes back to the owner for a new decision. The parser
  evaluates nothing (`tool-read-pdf.test.ts` plants a script action and a marker).
- **A rejection with feedback inside Code Mode, and ACP.** The step stops its tool queue when a direct tool call fails
  with a permission correction (`session-runner.test.ts`, `mcp.test.ts`). A Code Mode program turns the same rejection
  into an error result, so the calls queued behind its `execute` call still start and can ask (task `tool-runtime-6`
  and `tool-runtime-7`). The ACP client does not close the permission prompt of an interrupted call yet, and no
  bundled client reads `metadata.queued`.
- **Shared approvals.** A project's ID comes from its remote URL, so a folder that names the same remote shares the
  saved "always allow" approvals.
- **Git in the folder.** Git applies the config of the folder it runs in (`.git/config`, its includes, `.gitattributes`
  and the hooks), which can name programs for git to run. `Project.resolve`, the Git VCS provider and the location
  watcher start no git in a folder that `WorkspaceTrust` does not trust, and read its files instead (`GitLayout`;
  `test/project-git-trust.test.ts`, `test/vcs-git-trust.test.ts`, `test/filesystem/watcher.test.ts`, each with a trusted
  control and with the plain git command of each key as the proof that the key is live). Snapshot (`test/snapshot-untrusted-git.test.ts`) and the worktree list (`test/worktree-untrusted-git.test.ts`) start no git in the folder's own repository while it is not trusted. The read-only calls
  of the `Git` service still run git in an untrusted folder, with its config in effect, and reach none of those keys except two: `status.short` runs `core.fsmonitor` and clean filters, and `history.recent` runs `gpg.program` when `log.showSignature` is set. Those two are called only by `VcsInstructions`, behind `ProjectTrust.trusted()`
  (`test/snapshot-trust.test.ts`, `test/git.test.ts`); that is a fact about the commands and the git versions the tests ran
  with (2.52 on Windows, the container's on Linux), not a gate. What remains: `Worktree.create` and `Worktree.remove` through a strategy other than the git one,
  and the worktree tools of the model, which run `git worktree add` and `remove` in a trusted folder and so run its hooks and filters of the
  folder (`agents-extensibility-28`); the shell sandbox's `.git/hooks` and `.git/config` (`shell-safety-18`); read-only
  git in the shell tool (`shell-safety-12`); the `orb flow` commands that open the run store (`ls`, `show`, `cost`, `trace`,
  `approve`, `watch` and `clean`), which ask git for the repository root with no trust check, and `clean` removes
  worktrees with it (register row FU-M4-002, fixed: `clean` asks `requireTrust` first and the readers find the root from the files); a repository with no config of its own, which shows no
  branch, changes or diff while it is not trusted, and no dialog or indicator says why (FU-M4-003, the owner's call, as
  for hooks and stdio MCP servers below); and fingerprints, which do not cover `.git`. A project is still named by the remote URL in the folder's config, which a
  clone can write (Shared approvals, above). Mercurial was never part of this gap: neither `Project.resolve` nor the
  Mercurial VCS provider starts an `hg` in a folder that `WorkspaceTrust` does not trust
  (`packages/core/test/project-hg-trust.test.ts` and `test/vcs-hg-trust.test.ts`, each with a trusted control that does
  start it), because `hg` loads the `[extensions]` and `[hooks]` of `.hg/hgrc` into whatever it runs there (class 1).
- **The dormant `instructions` config key** needs the same real-path guard when it is wired in (M4). The `@path` imports
  of prompts-context-9b do not wire it; it stays unread and its guard waits for whichever task wires it.
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
  Bash approval shows but no folder question names. Task `shell-safety-9` (M3) carries the shell analysis. A read
  through a wildcard is judged by its folder only: a glob spelling of a file can still read past a Read deny on that file
  (the per-match check was reverted in round 8 after it kept opening holes, and is a follow-up carried by
  `shell-safety-12`). A leading assignment or a wrapper (`FOO=1`, `timeout`, `nice`, `env`) is not looked through
  either, so it can step around a Bash deny rule (also a follow-up carried by `shell-safety-12`). The output files of `sort`, `uniq`, `find`, `tree` and `sed` are writes (`outputs` in `shell/paths.ts`,
  pinned by `paths.test.ts`). A `git` output file (`git diff --output`, `format-patch -o`, `archive -o`, with or without
  `-C`) is not checked as a write, and a word shaped like an assignment as an argument (`cat x=~/s`) has its `~` read literally, although
  bash expands it (`paths.test.ts`; `dd if=~/x of=~/y` is expanded, as bash does, and `sed` refuses such a word); both were reverted in round 9 after the placement kept opening holes, and are follow-ups carried by
  `shell-safety-12`. Other writers and interpreters are not modelled.
- **A search of a folder and Read rules.** Grep and Glob ask the Read rules about the path they search, but not about
  each file that a search of a folder finds, so a Grep of `.` reads a `.env` in it under a Read deny of `*.env` unless a
  rule covers the folder. Task `permissions-3` (M6) carries a Read check for each file a search returns.
- **A share named before anyone is asked (closed for the file tools by `permissions-23`).** `FileAccess.resolve` now
  refuses a UNC, `\\?\Volume{…}` or `\\.\` path with `file.spelling` before any disk is read, unless the path is in
  the project's folder. `ProjectTrust.escapes` reads a link's target one part at a time and names a share as the link
  says without opening it, and `FileAccess` refuses a place that a repository link leads to when it is a share, in any
  spelling (`\\localhost\C$\…` included, which names a local folder that the person's rules write as a drive path, so a
  question about it would have turned their deny into an ask), with the same `file.spelling` failure, before any
  question: for a tool's path (`resolve`, so Read, Write, Edit, Grep, Glob and a shell `workdir` when the call runs; the scheduling check on the same text, `ShellTool.concurrent`, answers false for a share workdir, or one reached through a link of the project, and never opens it: the links are read one part at a time with `readlink` only (`LinkShare.ofSync`), pinned in `tool-shell-concurrency.test.ts`; the shell gate leaves a share that only a comment or an unreadable input names unresolved and asks the disk nothing about it, pinned in `shell-guard.test.ts` and `link-share.test.ts`) and for the plain
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
  first with the person's deny and, trusted, with a control that expects one folder question naming the share (answered once and rejected, nothing opened on a reject). What remains: a share named in a shell command's text
  directly, which is asked about as the shell asks, or in a path that a loader other than the file tools reads, such
  as a `{file:path}` reference, and a mapped network drive, which is a drive letter.
  The file tools (Write, NotebookEdit, Patch) take a file's lock only after `FileAccess` has checked the path, because the lock key
  resolves the path on disk; `tool-share-lock.test.ts` pins it twice: its share rows pin the three share spellings across those tools, and its link rows (a repository link whose real place is a share, in an untrusted project) pin the lock order.
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
- **An ACP tool call's diff still comes from its input's text.** The approval and the updates after it name the places
  the server put on the request or that the tool reported in its progress, and the settled record keeps those places
  (`places` in the metadata of a completed or failed call), so a replay on `session/load` names them too and names none
  for a call recorded without them. The live pending call is sent with an empty input and names no place; a replayed one carries the recorded input. The finished call's
  own diff is still built from the input's `old_string` and `new_string` (not an approval), at the recorded place, and
  not drawn at all when the call has no place.
- **Hooks and stdio MCP servers waiting for trust are not offered a grant.** `Trust.Status` lists what a clone's files
  hold back, and the person's own hooks and servers are not in a clone's files, so a folder with nothing else withheld
  shows no trust dialog in the TUI or VS Code. The hooks log one warning and a waiting server shows as `failed` with the
  reason; `/trust` or `orb trust` grants the folder. A prompt needs a new kind on the public `Trust.Kind` list and an
  owner call on how a user-scope document shows as withheld. `orb -p` already refuses an untrusted folder; `orb run`
  without `--trust` now runs no hook and starts no stdio server. The owner has not yet said whether headless runs keep
  the reference's implicit trust for hooks.

- **Envelope look-alikes are escaped at the sinks `reminder-text.ts` is called from, and at no others.** While a request
  is lowered, `ReminderText.neutralize` escapes the opening bracket of a `<system-reminder>` or `<system-update>` tag in
  tool results and tool errors (local and MCP, including a wrapped error's response body, and a text or JSON file in a result, such as an MCP resource: its base64 data URL is decoded, escaped and encoded again, while images and PDFs stay byte for byte), text and directory
  attachments (an ACP editor's embedded text resource is sent as one) and an attached file's location, the Code Mode
  tool listing (MCP tool descriptions; baseline and updates), a tool result's text parts together (an adapter joins them
  with nothing or with a line break, so `ReminderText.neutralizeParts` escapes a tag cut across parts), the notice that a background or user shell command leaves (its output and
  command), a background subagent's reply, the instruction files `InstructionDiscovery` renders and the ones
  `SessionInstructions` loads when a file is read (baseline and updates), MCP server instructions, the git snapshot
  (branch, user, status and commit subjects), and a checkpoint's summary and recent text. The clients that send editor context as a hidden message escape it before
  they send it, with the rules in `@orbit/util/reminder-text`: the VS Code chat and the terminal UI write the path and
  the selection into a fenced block after their envelope, and ACP escapes the assistant-audience text it submits.
  Synthetic messages are
  recognized by `metadata.source` (`shell`, `subagent`) or `metadata.instruction`, except a reminder row, which holds
  Orbit's own envelope; an unmarked synthetic stays as stored. Pinned by the sink table in `session-reminders.test.ts`
  (most rows build each message through its real producer; the nested instruction file row writes the message by hand),
  `session-reminder-files.test.ts` (a text file in a tool result, 12 spellings, compiled for two provider adapters, with an image control), `session-reminder-joins.test.ts` (the request bodies of two chat-completions adapters, one joining parts with nothing and one with a line break), `codemode/instructions.test.ts`, the ACP subprocess
  row in `prompt-content.subprocess.test.ts`, the end-to-end case in `session-shell.test.ts`, `mcp-instructions.test.ts` and
  `instruction-discovery.test.ts`. Not covered (register row FU-M4-36): skill and reference listings, the text of a
  plugin-supplied system part, host-supplied instruction entries, a hosted tool's provider-format result, and the opaque
  window of a native compaction; instruction text the person chose to run (an activated skill's body, command templates, MCP prompt commands); image and PDF bytes, which cannot be escaped; Unicode spellings of the tag are FU-M4-38. A new sink that puts text from a file or a
  tool into a request needs the same call and a row in that table.

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
