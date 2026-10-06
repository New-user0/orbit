# Untrusted repositories

Orbit starts in whatever folder it is pointed at, and a cloned repository chooses every file in that folder: its config,
its `.orbit` directory, its links, its workflow and suite files, its run store and the names of all of them. This page
is the checklist for any change that reads such files, runs commands, makes network requests, prints text that came from
a file or changes how the `orb` binary is built. The one-line rules are in [AGENTS.md](../AGENTS.md) under "Untrusted
Repositories". This page holds the reasons, the helpers, the tests and the review questions behind them.

It comes from the first milestone (M1), which made project config, plugins, commands, workflows and the compiled binary
safe to open in a folder that is not trusted yet. Its reviews and audits had found 160 distinct defects by the time the
compiled binary was last fixed: one blocker, 36 majors, 114 minors and nine holes that no review had caught first. The
review of that fix then found a second blocker. 131 of the 160 fall into the fifteen classes below, including the first
blocker and most of the majors, and most classes came back in a new place after their first fix. Writing the rule once
for the whole class costs less than finding the next instance in review.

**The promise.** Until a person trusts a folder, no file that the folder supplies may run code, spend their money, reach
the network, carry a file of theirs to a model provider or change which of their rules apply. A change that breaks one
of these on a default path is a defect, whatever else it adds. What users see of this is in [upgrading](upgrading.md),
under "A project's config waits for its folder to be trusted".

Words used here:

- **Surface:** a place where Orbit reads, imports, runs or prints something that a repository supplied.
- **Gate:** the check that stops a surface until its folder is trusted.
- **Trusted:** decided for one folder, by a stored grant (`orb trust`, the terminal UI), by a grant that lasts until the
  server restarts, or because the server trusts every folder without a grant (`ORBIT_TRUST_PROJECT=1` on a private or
  foreground server, `trust: { implicit: true }` in an SDK host). `WorkspaceTrust` keeps the decisions and
  `ProjectTrust` answers for a Location's project.
- **Held back:** what an untrusted folder's files would have contributed. `ProjectTrust.status` lists it per file with
  its kinds (`Trust.Kind`).
- **Holder:** the folder whose decision covers a file (`ConfigTrust.holder`): the project's root for a file in the
  project, and the folder itself for config in a folder above the project.

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
- Plugins in `.orbit/plugins`: `ConfigPluginSource.scan` skips untrusted directories. Proof:
  `test/project-trust.test.ts`, `packages/cli/test/trust.test.ts`.
- Shell snippets in commands: `ConfigCommandPlugin` refuses them with `UntrustedError`. Proof:
  `test/config/command-shell.test.ts`.
- Agent, command, skill, compat skill and output style files: `ProjectTrust.supplies` for the path, `ConfigMarkdown` for
  the text, `ConfigTrust.sanitize` and `sanitizeCommands` for what they may say. Proof: `project-trust.test.ts`,
  `test/config/markdown.test.ts`, `test/plugin/output-style.test.ts`.
- Instruction files (`AGENTS.md`, `ORBIT.md`): `ProjectTrust.reachable`, asked by `ConfigInstructionPlugin` and
  `SessionInstructions`. Proof: `test/instruction-discovery.test.ts`, `test/session-instructions.test.ts`.
- Paths that a file tool is given: `ProjectTrust.escapes`, asked by `FileAccess.resolve`. Proof:
  `test/file-access.test.ts`, `test/tool-edit.test.ts`, `test/tool-write.test.ts`.
- Language servers and formatters: `ProjectTrust.trusted()` in `Lsp` and `Formatter`. Proof: `test/lsp.test.ts`,
  `test/formatter.test.ts`.
- Executables that Orbit spawns by name (`git`, `rg`, shells, formatters, language servers, the sandbox tool): found
  through `which` in `packages/core/src/util/which.ts`. No gate yet: on Windows that lookup searches the working folder
  first (see Known gaps).
- Provider packages: inside the compiled binary `Provider.loadPackage` loads a built-in provider or one from the npm
  cache, and never resolves a name from the folder. Proof: `test/provider-compiled.test.ts`.
- Code Mode `fetch`: `PermissionWeb.request` for every hop, then `AddressGuard.check`. Proof: `test/codemode.test.ts`,
  `packages/util/src/address-guard.test.ts`.

**CLI and flow** (`packages/cli`, `packages/flow`):

- Workflow and suite modules, which are imported: `trustRefusal` with `imports`. Proof:
  `packages/cli/test/trust.test.ts`.
- Workflow and suite data files that carry commands, approvals or agents: `trustRefusal` with `defines`, listed by
  `workflowCommands`, `workflowApprovals`, `workflowAgents`, `suiteCommands` and `suiteAgents`. Proof:
  `packages/cli/test/trust.test.ts`, `packages/flow/test/load.test.ts`, `packages/flow/test/agents.test.ts`.
- Every command that starts work: `requireTrust`, `trustRefusal` and `warnUntrusted`. `orb acp` only warns, because the
  editor chooses its folders. Proof: `packages/cli/test/trust.test.ts`.
- The run store, `.orbit/runs.db`, and the worktree paths built from it: `Store.run`, `Store.runs`, `Git.clean` and
  `Git.worktree` accept one plain name only. Proof: `packages/flow/test/store.test.ts`,
  `packages/flow/test/git.test.ts`, `packages/cli/test/flow.test.ts`.
- Text printed to a terminal or stored in a title or a commit: `plain`, `progress` and `json` from `@orbit/flow/plain`.
  Proof: `packages/flow/test/plain.test.ts`, `packages/cli/test/flow.test.ts`.

**Terminal UI** (`packages/tui`):

- Plugins that the terminal UI imports in its own process: `trustedPluginDirectories` with `trust.startup`. Proof:
  `test/plugin-trust.test.ts`, `test/plugin-discovery.test.ts`.
- The trust dialog, bound to the folder in view when it opened: `TrustProvider` and `useTrustPrompt` in
  `src/context/trust.tsx`. Proof: `test/cli/tui/dialog-trust.test.tsx`.
- Run store text in the `/runs` dialog: `DialogFlowRuns` passes every string through `plain`. Proof:
  `test/component/dialog-flow-runs.test.tsx`.
- Window titles, the exit summary and the Mini splash: `terminalTitle`, `sessionEpilogue` and the splash's own filter.
  Proof: `test/util/renderer.test.ts`, `test/util/presentation.test.ts`, `test/mini/splash.test.ts`.

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
3. **Assert the refusal.** The refusal text, exit status 1, the marker absent and the scripted model never asked.
4. **Add the control.** The same file in the same test with `--trust` or a granted folder, and the marker present. That
   proves the file is live, so the test cannot pass because the file was never executable.
5. **Record the mutation.** Remove the gate and watch the test fail, then write that mutation in the PR. The review runs
   it again.
6. **Lift the skips.** Tests that skip on your platform (real symlinks need `canLinkFile`, hook execution skips on
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
  `ProjectTrust.allows(file)` first. Nothing consumes `allows` yet, because those hooks do not exist.

- In a command that loads a file from the folder, call `requireTrust` (or `trustRefusal`, when you report the refusal
  yourself) before the load. Pass `imports` for a file that the command imports and `defines` for a file whose commands,
  approvals or agents it carries out. Both refuse an untrusted folder whatever it holds back. Without them the check
  refuses only a folder whose config holds something back, which is right for `orb run` and `orb loop`, because they
  import nothing. This is `execute` in `packages/cli/src/commands/handlers/flow/execute.ts`:

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
  `workflowAgents`, `suiteAgents`, and `importsModule` for a module, which is code and not data.
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
dangling links and not-yet-existing targets, and allow for UNC paths and Windows case and spelling. Use
`FSUtil.contains` or `path.relative`, never string comparison. Every reader of a file that the repository supplies asks
`ProjectTrust` and is in the reader list.

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

- Config references go through `ConfigVariable.substitute` with `within`, which expands no `{env:}`, refuses
  `{file://host/share}` before the disk is touched, and checks the real path of a file.
- Compare with `FSUtil.contains(parent, child)`, which uses `path.relative` and so ignores case on win32, and resolve
  with `FSUtil.resolve` or `fs.resolve`, which keep the lexical path for a part that is not there. Never `===`,
  `startsWith` or `!==` on two paths.
- A name that becomes a file name is one plain name (the output style rule in
  `packages/core/src/plugin/output-style.ts`, and the `Name` pattern of the memory tool in
  `packages/core/src/tool/plugin/memory.ts`).
- Check at the moment of reading, not once when the file is discovered.

**How to test:**

- Build the link as a directory junction on Windows, which needs no privilege, and as a real symlink where `canLinkFile`
  allows it (`packages/core/test/fixture/symlink.ts`). For every reader in the list cover a link to a file, a link to a
  folder, a dangling link, a loop, a not-yet-existing target through a link, a `..` name and a UNC path. For UNC, assert
  that no disk access happens: a share test that waits 5 seconds means the check came too late.
- Untrusted: the file is not read and `config file skipped` is logged once. After a grant the file appears without a
  restart. The trusted control follows links as before.
- Mutation: make `reachable`, `supplies` and `escapes` answer true and watch the tests fail. The real-symlink tests skip
  on accounts without the privilege, so run them on Linux before closing a milestone.

**Review questions:**

- Which new reader of repository-supplied bytes does this add, and is it in the reader list?
- Is containment checked on the real path, for a target that does not exist yet and for a dangling link?
- Is any path compared as a string (`===`, `startsWith`, `!==`)? On Windows too?
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

**Rule:** Every request that a repository or a script can influence asks permission per hop, as `webfetch` does, then
passes `AddressGuard.check`, then connects to the address that was checked, with the name kept only in `Host` and SNI. A
name that resolves to nothing, fails to resolve or answers with names is refused.

**Why:** Code Mode `fetch` lets a script choose the method and the headers of its request. One approval of an origin
then reached other hosts by redirect, loopback, the LAN or a cloud metadata endpoint (credentials), in spellings that a
URL parser accepts and a string check does not.

**In M1:** a `fetch` to `127.0.0.1` approved once followed a 302 to `localhost` with no second ask (verification round
1), because #9 had merged with "redirects are not re-authorized" as a known limit. Then one spelling or endpoint per
round: `*` and trailing dots in host rules (#3), IPv6 forms of IPv4 such as mapped, NAT64, 6to4, Teredo and ISATAP
(raised in the review of #21), six IPv6 metadata endpoints that were only "private" (#22), DNS rebinding, and a lookup
error that counted as "no addresses" (verification round 4). Six commits for one class.

**Ask early:** at the spec for `fetch`, the gate, the per-hop redirect asks and an address guard belong together, and
one table covers every spelling.

**How to comply:**

- Build the permission request with `PermissionWeb.request` (`packages/core/src/permission/web.ts`). It rejects wildcard
  hosts, strips trailing dots, validates the method, and returns the resources, the aliases and what "always" saves.
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
- Mutations: native redirects (11 tests fail), the guard before the ask, the guard removed.

**Review questions:**

- Which URLs or hosts can a script or a repository influence, and does each hop (redirect, import, proxy) ask
  separately?
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

**Ask early:** at the classification table. The first-wave reviews of #2 and #4 had already shown that "which agent
runs" is a permission.

**How to comply:**

- Classify each new field in `ConfigTrust.classification` (`info`, `agent` and `command`). Ask of every field: does it
  choose which rules, agent, mode, model or provider apply? Then it is a permission, `withhold("permissions")`, and a
  permission list keeps deny rules only (`denyRules`). `sanitizeCommands` withholds a command's `agent`, and `warming`
  keeps only `false`.
- Ask whose rules come last, and make sure that an untrusted source cannot be last. When a switch that guards gets
  enforced, as `hooks.disabled` has yet to be, read it in policy-authority order and not by value precedence, or a
  repository could switch off the user's guard hooks (#7).
- Name agents by configuration, never by constant. `Agent.select()` is the fallback
  (`packages/core/src/tool/plugin/plan-mode.ts`), and Plan mode's subagent set is `PlanMode.allowedSubagents`, built
  from `readOnlyAgents` and enforced in `packages/core/src/tool/plugin/subagent.ts`.
- Show the whole thing that is approved: the full span and not just the commands that the scanner found
  (`ConfigCommandPlugin` asks about the span as written when its commands alone would mislead), the method and the URL
  (`PermissionWeb.request` metadata), the folder.

**How to test:**

- Reproduce with the real config stack: a global `edit: ask`, an agent `autopilot` with `edit: allow`, and an untrusted
  folder that names `autopilot` through each route (`default_agent`, a command's `agent`, a workflow node, a judge or a
  member, an agent file's `mode`, `hidden`). Assert that the write is rejected and that `ProjectTrust.status` lists what
  was withheld. With `--trust` or a trusted project it works as before (`packages/cli/test/trust.test.ts` has this
  config).
- Plan mode: a config of `* * allow` must not make `general` spawnable.
- Completeness: the classification table compiles only if every field of `Config.Info`, `ConfigAgent.Info` and
  `ConfigCommand.Info` is classified, and `packages/core/test/config/trust.test.ts` ("covers every field") checks it.

**Review questions:**

- Does this field choose which rules, agent, mode, model or provider apply? Then it is a permission: where is it
  classified?
- Whose rules come last, and can an untrusted source be last?
- Can the approver see the whole thing that is approved (full span, method, URL, folder)?
- Does a default or fallback name an agent or a mode by constant instead of by configuration?

### 9. Terminal control characters in printed or stored text

**Rule:** Every string that came from a file, a run store, a workflow or a session and reaches a person (stdout, stderr,
JSON, a terminal UI frame, a toast, a session title, a commit subject, an exit summary, a splash) passes through
`plain`, `progress`, `json` or `terminalTitle` at the sink. Keep a sink inventory per command.

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

- `plain(text)`, `progress(line)` and `json(value)` come from `@orbit/flow/plain` (`packages/flow/src/plain.ts`, which
  loads no other module). `plain` trims, writes control and format characters out and puts a line break on one line.
  `progress` keeps indentation and takes any value. `json` writes every character of Unicode category C as `\uXXXX`, so
  `JSON.parse` returns the original value. Never `JSON.stringify` a string from a file for a terminal.

  ```ts
  process.stderr.write(`${progress(line)}\n`)
  process.stdout.write(`${json(result.output)}\n`)
  renderer.setTerminalTitle(terminalTitle(title))
  ```

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
- Tests: `packages/flow/test/plain.test.ts`, `packages/flow/test/agents.test.ts` (titles and commit subjects),
  `packages/cli/test/flow.test.ts`, `packages/tui/test/component/dialog-flow-runs.test.tsx`,
  `packages/tui/test/util/renderer.test.ts`, `packages/tui/test/util/presentation.test.ts` and
  `packages/tui/test/mini/splash.test.ts`. Mutation: revert each sink one at a time.

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
package that is not built in by name from inside the binary, replace every bundled dependency lookup that the bundler
leaves to the runtime, and look executables up on `PATH` only, never in the working folder.

**Why:** Bun applies the `paths` of a `tsconfig.json` in the start folder to the binary's own imports, resolves any bare
name that the bundle leaves open from the folder's `node_modules`, and loads a native library from an npm package that
its lookup finds. A committed file then runs in the server process before the trust gate is asked. Executables are found
the same way: on Windows a lookup that searches the working folder before `PATH`, as the npm `which` package does, finds
a `git.exe` or `rg.exe` that the repository ships.

**In M1:** a repository's `tsconfig.json` `paths` ran at the start of `orb trust --list` (verification round 5), and
`Provider.loadPackage` resolved a provider by name from the repository's `node_modules` (#22 round 8). The prescribed
`autoloadPackageJson: false` then broke packages that name their entry by `main` or `exports`, so it is back on. The
next hole was js-yaml's lazy `var _require = require; _require('esprima')`, which ran a committed
`node_modules/esprima/index.js`. A dynamic probe found it, and a scan for names would not have, because the require is
aliased. The same probe closed Babel's browserslist lookup and fff's native-library lookup (on Windows the embedded path
says `~BUN`, not `$bunfs`). Then the review of that fix found one more kind of name: `which` in
`packages/core/src/util/which.ts` wraps the npm `which` package, so on Windows a committed `git.exe` ran while Orbit
gathered version control info, and a committed `rg.exe` ran during file search, before any trust. A blocker, and still
open when this was written (see Known gaps). The earlier holes took four fix commits in three rounds.

**Ask early:** when the single binary was first compiled (M0), and when `orb trust --standalone` and `serve --stdio`
first started the server inside the repository, audit what the process resolves from its start folder before any trust
check: modules, packages, native libraries and executables. No earlier audit had looked, and M1's rounds found each kind
in turn.

**How to comply:**

- `autoload` in `packages/cli/script/autoload.ts` is spread into the compile options by `packages/cli/script/build.ts`.
  `autoloadBunfig`, `autoloadDotenv` and `autoloadTsconfig` are false, and `autoloadPackageJson` is true. Change none of
  them without a control build that changes only that option.
- `runtimeRequires(replaced)` and `verifyRuntimeRequires(replaced)` in `packages/cli/script/runtime-requires.ts` are
  three `onLoad` replacements (js-yaml's `js/function` type, Babel's `resolve-targets`, fff-bun's download module), and
  the build fails when a replacement matched no module. Add one when a dependency leaves a name to the runtime.
- `Provider.loadPackage` (`packages/core/src/provider.ts`) fails with `LoadError` inside a compiled binary
  (`Bun.isStandaloneExecutable`) for a package that is not built in. Otherwise it installs with `npm.add` and resolves
  from the npm cache with `resolveModule`. A plain file path no longer loads: write a `file:` URL.
- Look executables up on `PATH` only, with `Bun.which(command, { PATH })` or a resolver that you have checked does not
  search the working folder: the npm `which` package searches it first on Windows. `which` in
  `packages/core/src/util/which.ts` wraps that package, and it feeds `gitExecutable`, `RipgrepBinary`, `ShellSelect`,
  the built-in formatters and language servers, the sandbox tool and the Azure CLI check.
- When a dependency or a dynamic import changes, look in the unminified bundle for `__require(`, a `require` that is
  assigned, `createRequire`, `import.meta.resolve`, `new Function`, `eval`, `dlopen` and imports of `#` names. The
  binary imports no `#name` at runtime, and a `package.json` `imports` field would map one to a file of the repository.
  When the set of dependencies changes, probe the build rather than reading it: put a marker-writing decoy in
  `node_modules` for each package name in `bun.lock` and see which ones run.
- Finish with the real binary, built with `bun run build --single --skip-install` in `packages/cli` and started with an
  isolated home, on Windows and on Linux.

**How to test:**

- Compile a tiny program with the release autoload options, imported from `packages/cli/script/autoload.ts`, and with
  the runtime-requires plugin. Start the binary in a folder that holds marker-writing decoys: `tsconfig.json` `paths`,
  `baseUrl` and `extends`, `jsconfig.json`, `package.json` `imports`, a bunfig `preload`, a `.env` with `BUN_OPTIONS`, a
  `node_modules` decoy for every bare name that the bundle leaves open, and a fake native-library package. Assert exit
  0, no marker, and that fff finds no library.
- A control built with each option on, or the plugin off, must write the marker, so the test cannot pass because the
  folder never had a way to run.
- Executables, on Windows: put a marker-writing `git.exe` and `rg.exe` in the folder and run a command that spawns each,
  as the review did with `orb session list --standalone` for git and a file search for ripgrep. Assert no marker, with
  the real executable still found on `PATH`.
- The build fails if a replacement matched nothing (`packages/cli/test/compile-autoload.test.ts`,
  `packages/cli/test/compile-runtime-requires.test.ts`, `packages/core/test/provider-compiled.test.ts`).

**Review questions:**

- Does this change add a dependency or a dynamic import whose name the bundler cannot see (an aliased `require`,
  `import.meta.resolve`, `createRequire`)?
- Does the binary start in a folder that the user chose, before the trust check, and what does the runtime read from it?
- Was it tested on the real built binary on Windows and on Linux?
- Is a package ever loaded by name from the working folder instead of from the npm cache?
- Does it spawn an executable that it finds by name, and does that lookup skip the working folder? Some resolvers search
  it first on Windows.

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
`resume` and `replay`, `eval`, `acp`, `serve --stdio`, the terminal UI's plugin loader, IDE buttons, SDK hosts), and
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
  `loop`, `flow run`, `flow resume`, `flow replay` and `eval` call them before any load. `orb acp` cannot stop, because
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
developer's platform gets a local run with the skip lifted before the PR.

**Why:** Mutations survived, allowlists hid more than their reason, a generated-file check reported a current file as
stale on Windows, and the real-symlink and POSIX hook tests never ran anywhere, because the developer's account could
not create symlinks and CI could not run.

**In M1:** a mutation that strips `status_message`, `if`, `once`, `shell` and `headers` from every hook passed all the
hook tests (#7), and `$ARGUMENTS` inside a span passed 52 tests (#6). In the vendor gate (#13) an allowlist entry hid a
stale name, and the exemption that a review suggested then let `.x-plugin/` through. Hook-executing tests skip on win32
and the real-symlink tests skip without the privilege, so they ran nowhere, and the known-failures baseline absorbed
flaky tests although the milestone plan names the idle-egress test as an M1 gate.

**Ask early:** at authoring time, with a revert of the fix. The first-wave reviews named the practice, and it was not
applied to gates, allowlists and platform skips.

**How to comply:**

- List the mutation that makes each new test fail in the PR, one per behavior. The review runs it again.
- The vendor gate is the model for an allowlist: one list, a reason on every entry (`tools/rebrand/vendor.ts`, with
  `files.ts` and `tokens.ts`). Add planted positives and negatives (an allowed spelling, a forbidden one, a lookalike),
  an audit that removes each entry and shows its hits, and a run on an export without `.git`.
- A build guard fails loudly: `verifyRuntimeRequires` fails the build when a replacement matched nothing.
- Platform skips: `canLinkFile` skips the real-symlink tests with a reason. Lift the skip on Linux or in Git Bash before
  the PR, in a container or WSL, or mark the test unverified.
- Generated files carry `eol=lf` in `.gitattributes` (`packages/protocol/openapi.json` and the generated client
  directories).
- A flaky test is named in the baseline or fixed in the PR that meets it. A test that the milestone plan names as a gate
  must pass, not be "known".

**How to test:** run each new test against the sources from before the fix (check out the old file) and record that it
fails. Test an allowlist with the planted cases above. In M1 the gate suites are
`packages/core/test/config/trust.test.ts` (completeness of the classification table) and
`packages/flow/test/agents.test.ts` (gate versus runner).

**Review questions:**

- Revert the fix: does the new test fail? Which mutation did you try?
- Is any negative assertion ("nothing ran") on a platform, or under a default, where it would pass vacuously?
- Is this allowlist entry as narrow as its reason? What else does it hide?
- Which tests skipped on this machine, and who ran them?
- Is a flaky test named in the baseline, or does it need fixing now?

### 15. Docs, comments and PR text that outrun the code

**Rule:** Write the docs, the schema descriptions, the code comments and the PR body last, from the final tree and the
commit list. Each claim names the test that proves it, and the PR body is regenerated after every fix push.

**Why:** The docs said that the terminal UI loads no plugins from an untrusted folder when it did, that imports from
`node_modules` "resolve as before" when they did not, and that a rule "never allows a write" when a leading wildcard
did. The owner merges from the PR body, and it was stale in about a dozen reviews.

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

**How to test:** for each sentence of the upgrade note and each comment that makes a promise, name the test that fails
when the sentence becomes false, or rewrite the sentence.

**Review questions:**

- Does every claim in the docs and the PR body name a behavior that the tests pin?
- Does the PR body list every commit, the test counts and the gate results of the head commit?
- Does the upgrade note say what a user must do, including for hooks that now fire or files that now vanish?
- Does a comment describe enforcement that the code does not do yet?

## Working practices

These come from how M1 was run, and they apply to any change in this area.

- **Fix the class, not the instance.** When a finding lands, list the members of its class from this page (surfaces,
  sinks, spellings, entry points) and close them all in one commit with a table-driven test. In M1 each round closed
  only the reported instance and the next round found the next one: from the merge of #20 to the esprima fix there were
  five audit and verification rounds, nine review rounds on #22 and 26 commits, about 24 hours, and the review of that
  fix found another member of the class (an executable found in the working folder, class 10). An audit may report "no
  holes" only with a table of the surfaces it checked and the evidence for each row. The round-1 audit found nothing
  where rounds 2 to 4 found five.
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
- **Land a stack in order.** Merge bottom-up, and only after the review of the head commit approves. Retarget a child to
  `main` (`gh pr edit <n> --base main`) before its parent's branch is deleted, because GitHub closes a child whose base
  is deleted (#17 was closed that way and reopened as #18). #14 merged before #15, so #15's commits never reached `main`
  and were re-landed as #16. If a PR merged before its review fixes, open the follow-up the same hour (#19 and #20).
- **A switch ships with its way back.** A PR that turns a feature off ships with the PR that lets the person turn it
  back on, or the stack lands as one. #14 alone would have switched off project config for every background-service user
  with no way to trust a folder.
- **Keep the baseline honest.** A flaky test is fixed, or named in a list in the repository, in the PR that meets it. A
  test that the milestone plan names as a gate must pass. Before a milestone closes, run the tests that skip on the
  developer's platform somewhere that runs them, or fix the CI that should.

## Known gaps

Not fixed in M1. Carry each into a task, and do not claim otherwise in docs or in a PR.

- **Executables found in the working folder.** On Windows the npm `which` package searches the working folder before
  `PATH`, so `which` in `packages/core/src/util/which.ts` finds a committed `git.exe` or `rg.exe`, and runs it, before
  the folder is trusted. The review of the last fix in #22 found it and called it a blocker. Look executables up on
  `PATH` only, as class 10 says, and drop this entry when that lands.
- **A holder that is a filesystem root.** `standing()` in `packages/core/src/config.ts` still lets `{file:}` in
  untrusted config read across the drive when the holder of the file is a filesystem root (#14 re-review, N1).
- **A stale-stamp window.** `ProjectTrust.allows` mixes the live decision with stale stamps for about 100 ms after a
  grant or a revoke (N2).
- **The formatter gate keys on the Location's project**, not on the folder of an externally edited file (N3).
- **Advice that cannot be followed.** `Trust.Withheld.directory` can name a folder, such as the middle one of outer,
  middle and inner repositories, that `orb trust` cannot lift, because a grant always goes to `project.canonical`. There
  is no revoke-by-directory route for a deleted folder.
- **Text that the person did not write.** A node's prompt is stored raw as a user message, and model-written text
  reaches the terminal the same way. Only a sanitizer at the renderer closes it (#22 round 7).
- **The `webfetch` tool.** It still follows redirects through `HttpClient` with no per-hop ask and no address guard, and
  a proxy sees the address and not the name (task `file-web-tools-19`, M10).
- **A terminal UI plugin that first appears above the folder** while the UI runs is imported with no `config.updated` or
  `trust.updated` event. The structural fix is to walk from the server's project root (the owner's call, #20 re-review).
- **Build checks.** `verifyArtifact` does not fail the build on an import or a `require` of a `#` name or of a stray
  bare name, and `packages/core/test/provider-compiled.test.ts` copies the autoload options instead of importing them.
- **Shared approvals.** A project's ID comes from its remote URL, so a folder that names the same remote shares the
  saved "always allow" approvals.
- **Git in the folder.** Orbit runs git in a folder to resolve its project, and git applies that folder's own
  `.git/config`, which can name programs for git to run (tasks `foundations-18` and `shell-safety-18`).
- **The dormant `instructions` config key** needs the same real-path guard when it is wired in (M4).
- **Tests that skip.** The hook-executing tests skip on win32 and the real-symlink tests skip without the privilege, and
  CI could not run in M1, so neither kind has run yet. Run them on Linux and in Git Bash before a milestone closes.
- **Lint noise.** `bun run lint:effect-patterns` carries 27 standing diagnostics, so a new violation of the AGENTS.md
  style rules (nested service yields, `else`, import aliases) hides among them. Bring it to zero or make it fail on the
  files that a change touches.

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

- [ ] Every reader of repository-supplied bytes asks `ProjectTrust` (`reachable`, `supplies` or `escapes`) and judges
      containment on the real path, at read time, with `FSUtil.contains` and never by string comparison. Dangling links,
      targets that do not exist yet, UNC paths and Windows case are covered (4).
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
      chooses the rules, agent, mode, model or provider is a permission, and untrusted sources get deny rules only (8).

**It runs commands** (spawns, shell, hooks, plugins, workflow nodes, git)

- [ ] Every command, button, subprocess and API that reaches the loader is listed and tested, and none runs the code
      before the gate (1, 12).
- [ ] Whatever the folder can make this code spawn, approve or choose is listed, whether it is a path, an agent, a model
      or a provider (2, 8).
- [ ] An executable that is spawned by name is looked up on `PATH` only, and the resolver does not search the working
      folder first, as the npm `which` package does on Windows (10).
- [ ] The approver sees the whole thing that is approved: the full span, the method, the URL, the folder (8).
- [ ] No default or fallback names an agent or a mode by constant instead of by configuration, and whose rules come last
      has been asked (8).
- [ ] A decline or a refusal stops the whole execution, siblings included, and does not surface as an internal error
      (13).

**It makes network requests** (fetch, redirects, proxies, integrations)

- [ ] Every URL or host that a script or a repository can influence asks permission per hop, redirects included (6).
- [ ] The address that was checked is the address that is connected to, and the name is kept only in `Host` and SNI (6).
- [ ] A lookup that throws, returns nothing or returns a name is refused (6, 7).
- [ ] The private and metadata lists are tables matched exactly, IPv6 forms and embedded IPv4 included, and no
      dev-server setting opens metadata or link-local addresses (6).
- [ ] The change makes no network call to anything but a configured model provider, MCP server or integration
      (AGENTS.md).

**It prints or stores text** (CLI, terminal UI, titles, commit subjects, logs, JSON)

- [ ] Every place where a string from a file, a store, a workflow or a session can reach a person is listed, and the
      function that escapes it at that sink is named (9).
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
- [ ] No negative assertion passes vacuously, whether on a platform that skips it or under the default trust of core
      tests (14).
- [ ] Every allowlist entry is as narrow as its reason, and has a planted positive and a planted negative (14).
- [ ] The tests that skip on the author's machine ran somewhere else, or the PR says they are unverified, and any flaky
      test is fixed or named (14).
- [ ] The upgrade note says what a user must do, every promise in the docs, comments and PR body names a test or says
      what is true, and the PR body matches the head commit (15).
