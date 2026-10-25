# Upgrading

What changes for people moving to a newer Orbit build: behavior that is different, who notices and what to do about it.

Orbit does not use Changesets, so a pull request that changes behavior someone can see adds its note to this file in the
same pull request, under the section for the area it touches. If no section fits, add a `##` section named after the
area. Refactors, and fixes that only restore documented behavior, need no note.

Add a note at the end of its section. Each note is a short heading and three parts:

```md
### Short title of the change

What changed, and what it did before.

**Affects:** who notices, for example scripts that call `orb run`, VS Code users or SDK callers.

**What to do:** the step to take, or "Nothing" when existing setups keep working.
```

## Configuration

Changes to `orbit.json` keys, environment variables and how Orbit finds its settings.

### One switch for reading other agent products' files

Orbit has long read the skills, output styles, hook settings and instruction files that other agent products keep,
such as `.agents/skills`, a vendor's own dot-directory and its instruction file. Those readers now share one switch,
`compatibility.enabled`, which is on by default, so what loads does not change until you turn it off. Set
`"compatibility": { "enabled": false }` in your own config, in the file `ORBIT_CONFIG` points at or in
`ORBIT_CONFIG_CONTENT`, or start the Orbit server with `ORBIT_DISABLE_COMPAT=1` (or `true`) in its environment. A
project's `orbit.json` or `orbit.local.json` cannot set it in either direction.

With the switch off, Orbit no longer loads skills from `.agents/skills` or another product's directory, reads that
product's output styles and hook settings, or loads its instruction file, and `/init` stops asking the agent to read
other products' rule files. The system prompt then named only `ORBIT.md` and `AGENTS.md` as instruction files; it
now names none (see "The base system prompt is rewritten, with a fixed list of sections").

**Affects:** people who turn the switch off while still relying on skills, output styles or hooks kept only in those
places, and code built on `@orbit/core`: the config service's `compatibility()` method is now `compat()`, which
returns `{ enabled, roots }`, and `compatEnabled()` returns only the switch without looking at the disk. A config
service you implement must provide both.

**What to do:** Nothing unless you turn it off. Before you do, move skills you keep only in `.agents/skills` or another
product's directory into `.orbit/skills`, or list their path under `skills`.

### Other products' hook settings and `.mcp.json` are config documents

The `settings.json` and `settings.local.json` files in another product's dot-directory used to be read on the side, on
every hook event. They now load as config documents, with the other config files, and so does the `.mcp.json` file in
the project directory. Both follow the compatibility switch, so nothing below applies with it off.

- **Settings files.** Only the `hooks` of each file are used. In your home directory both files rank as user config.
  In a project the shared file ranks as project config and the local file as local config. Scopes rank as they do for
  any other config, so within one scope Orbit's own documents outrank these files: an `orbit.json` outranks the
  project's shared settings file, and an `orbit.local.json` its local one. A higher scope still outranks a lower one,
  so a project's settings file outranks the `orbit.json` in your own config directory. When several hooks block a
  tool call, the model is told the reason from the highest-ranked document. A hook that cannot be read is reported in
  the log, with its file and its place in it, and costs only itself, and a file that is not JSON costs only that file.
- **Hook matchers and names.** A hook matcher in any document also accepts the names other products give a tool:
  `Bash` for `shell`; `Edit` and `MultiEdit` for `edit`, and `Write` for `write`, and all three also for `patch`,
  which takes the place of `edit` and `write` on some models; `NotebookEdit`, `Glob`, `Grep`, `WebFetch` and
  `WebSearch` for the tool of the same name; `Agent`, and `Task` as its older name, for `subagent`; `TodoWrite` for
  `todo`; and `mcp__<server>__<tool>` for an MCP tool. A hook from another product's settings file is told that name
  as `tool_name`: the first of the tool's names that its own matcher accepts, so a `Write` hook that runs for `patch`
  is told `Write`. Hooks in Orbit's own files still get Orbit's names for the tool.
- **Hooks that never ran now do.** A hook whose matcher names another product's tools, such as `Bash`, `Edit|Write` or
  `mcp__github__.*`, never matched an Orbit tool, so it never ran, whether it sat in a settings file or in your own
  config. With compatibility on, which is the default, these hooks run. They receive Orbit's tool input, not the other
  product's: `tool_input` keeps Orbit's field names, so the file of an `edit` or `write` call is `path` where the other
  product says `file_path`, and a `patch` call carries only `patchText`. A hook that reads the other product's field
  names will not find them. Hooks with no matcher, or `*`, ran before and still do.
- **Project directory.** Every hook also gets that product's project-directory variable. For a hook in the settings
  folder of a project it is the directory that holds the folder, which can be above the directory Orbit runs in, so a
  hook that runs a script kept in the folder finds it. For a hook in your home directory's settings or in Orbit's own
  files it is the directory Orbit runs in, which `ORBIT_PROJECT_DIR` always is.
- **`.mcp.json`.** Its `mcpServers` become project config: servers that run a command become local servers, and those
  with `"type": "http"` or `"type": "sse"` become remote servers. `${NAME}` and `${NAME:-fallback}` expand from the
  environment of the Orbit server in commands, arguments, variables, directories, URLs and headers. A server with no
  command or URL, of another type, or that names a variable that is unset and has no fallback is skipped, with a
  warning, and the others still load. A server of the same name in `orbit.json` wins.
- **When edits apply.** Orbit now picks up a change to a settings file or to `.mcp.json` when the config reloads, a
  moment after the file is saved, and no longer reads the settings files again on every hook event.

**Affects:** people whose hooks name another product's tools, in its settings files or in their own config: those hooks
now run for tool calls they never ran for, and read Orbit's tool input; other people with hooks in another product's
settings files, who may see a different block reason or tool name than before; repositories that keep a `.mcp.json`,
whose servers now start when the project is opened, as those in a project's `orbit.json` already do; and code built on
`@orbit/core`, where `HookConfig` moved from `@orbit/core/hook/config` to `@orbit/schema/config/hook-config` and
`McpTool.namespace` and `McpTool.name` are now defined in `@orbit/schema/mcp` and re-exported.

**What to do:** Look through the hooks that name another product's tools. Make each read Orbit's field names, such as
`path`, `oldString` and `patchText`, or accept both, or remove it. To go back to hooks that match only Orbit's own tool
names, and to stop Orbit reading that product's settings files and `.mcp.json`, turn compatibility off as described
above, which also stops it loading that product's skills, output styles and instruction files. If a repository's
`.mcp.json` should not start servers for you, turn compatibility off, or move the servers you want into `orbit.json`.

### Snapshots, worktree lists and `orb flow` start no git in a folder that is not trusted

A repository's own config can name programs for git to run and files or network shares for it to open, so Orbit starts
git in a repository only once its folder is trusted. Until then a session takes no undo snapshot: the steps it runs
before you trust the folder cannot be undone, as in a folder without git, comparing or restoring a snapshot from a time
when the folder was trusted fails with "The folder is not trusted", and Orbit's log says once why there is no snapshot.
The first step after you trust the folder takes a snapshot again, without a restart (`snapshot-untrusted-git.test.ts`,
`snapshot-trust.test.ts`, `snapshot-trust-transition.test.ts`). A snapshot needs git, and git applies the config of
the folder and of any repository nested in it, so there is no partial snapshot either. Meanwhile the list of worktrees
shows only the folder's main checkout, and adding or removing a worktree is refused. `orb flow clean` now stops in a
folder that is not trusted, and takes `--trust` (for that run only) and `--server` like `orb flow run`. `orb flow run`
and `orb eval` start no git in a folder that is not trusted either: they work as they do outside a repository, with no
worktrees, no commits, no merges, no base commit, no check for uncommitted changes and no diff for a reviewer, so a
node that asks for a worktree, a team in a worktree, or a `merge`, fails and says that the folder is not trusted. Add
`--trust` (for that run only) to `flow run` or `eval`, or trust the folder, to get them back. `orb flow resume`,
`orb eval --resume` and `orb flow replay` do not run in such a folder at all (see "`orb flow resume`, `orb eval --resume`
and `orb flow replay` need a trusted folder" under Clients). The other `orb flow` commands find the repository root
from its files (`packages/cli/test/trust.test.ts`, the rows for `core.fsmonitor`, `filter.<driver>.clean` and
`hooks/post-checkout`, and the rows for a run store that a clone ships; `packages/flow/test/runner-untrusted.test.ts`
for the failures). A repository with no remote is named by its path until it is
trusted and by its first commit afterwards; the sessions made before trust move to that project (`project-trust-id.test.ts`,
`project-trust-previous.test.ts`, which also covers Mercurial folders and `.git/orbit`). Memory notes saved under the
path-named ID are moved to the new one when the folder is opened (`memory-instructions.test.ts`), and snapshots taken after a
grant, before the folder was opened again, can be restored (`snapshot-trust-restart.test.ts`). Saved "always allow"
answers stay with the old ID, so Orbit asks again.

### Orbit's git stays inside the folder you trusted

Git takes a `.git` directory for a repository only when it holds `objects` and `refs` and a `HEAD` that names a branch
or a commit; it goes on past any other `.git` directory to the repository in a folder above, and uses that repository's
config. Orbit used to take such a folder for a repository of its own and ask whether to trust it, and once you did, the
git snapshot, the Git provider and the ignore check of language server results ran git in the repository above, which
nobody had trusted. Orbit now names the repository above as the project, as git does, so the trust question is about the
folder git will work in, and every git that Orbit starts for a session looks for a repository no further up than the
project's folder. A `.git` directory whose `HEAD` is a link is passed over too. On a computer where the folder above a
project has `;` (Windows) or `:` (elsewhere) in its path, git cannot be told to stop there, so Orbit starts no git for that
project (`git-passed-over.test.ts`, `git-layout.test.ts`).

### Orbit's git does not follow a `.git` into a repository you have not trusted

A folder's `.git` can send git to another repository: a `.git` file that names another git directory, as a submodule's
does, a `.git` directory whose `commondir` names one, or a `.git` that is a link or a junction. Git then applies that
repository's config and hooks. Orbit used to treat such a folder as a project of its own and, once you trusted it, ran
git there with the other repository's config, so a program that repository named ran although nobody had trusted it.
Now, once you trust the folder, Orbit first asks git which work tree, git directory and common directory it would use,
and runs nothing more unless each of them lies in a folder that is trusted. Until then the folder gets no git snapshot,
no branch, changes or diff from the Git provider, no undo snapshot, no ignore check of language server results, no
worktree list and no new worktree, and a line in Orbit's log names the folder to trust. A linked worktree that its
repository lists works once its main checkout is trusted, and a submodule once the repository around it is. `orb flow
run` and `orb eval` use no git there, as in a folder outside a repository, and say so once; `orb flow clean` stops and
says why (`git-passed-over.test.ts`, `packages/flow/test/git-passed-over.test.ts`, `packages/cli/test/flow.test.ts`).
In a folder inside a repository, the runs of `orb flow run` and `orb eval` still take their worktrees from the repository,
whose folder the server names as the project. A `.git` directory whose `HEAD` starts with a byte order mark, or whose
`objects` or `refs` folder cannot be searched, is passed over now, as git passes over it (`git-layout.test.ts`).

**Affects:** people who open a submodule, or a folder whose `.git` leads into another repository, without trusting that
repository.

**What to do:** Trust the repository that the folder's `.git` leads to as well, or open that repository instead.

### Orbit's git no longer looks inside submodules

To find out whether a submodule changed, git starts a second git in the submodule's folder, and that git applies the
config of whatever repository the folder's `.git` names. In a repository you trusted, a submodule folder whose `.git`
named a repository you had not trusted, such as the clone around it, let that repository's file system monitor or clean
filter run when Orbit took the git snapshot or asked the Git provider for changes, and when `orb flow` checked the
checkout for uncommitted changes, committed an agent's work, merged it or gave a reviewer its diff. Now no git that Orbit
starts looks inside a submodule. The git snapshot, the Git provider and `orb flow`'s check for uncommitted changes and
review diff no longer report a submodule as changed, and the commit that `orb flow` makes of an agent's work does not
stage submodules (`git-gitlink.test.ts`, `packages/flow/test/git-gitlink.test.ts`).

**Affects:** people whose repositories have submodules and who relied on the git snapshot, the Git provider or
`orb flow` to show or commit a change in one.

**What to do:** Check submodules with git itself, for example `git status` or `git submodule status` in the shell, and
commit a submodule's new commit yourself.

### A repository that git or Mercurial cannot name keeps its project once trusted

Orbit names a project by what git or Mercurial says about it once you trust the folder, and some repositories get no
answer. A git repository with no commit and no remote, and a Mercurial folder with no changeset or with no `hg`
installed, used to move into the shared `global` project at the grant, taking along the sessions and memory notes made
before it; they now keep the project named by their folder. A trusted git repository that git cannot read at all (git not
on PATH, a config line git rejects, or a folder that git refuses because another account owns it) used to become a plain
folder named by the subfolder you started in, so the sessions made before the grant were left behind and the next start
asked about that subfolder again; it is now named from its `.git` files as it was before the grant, with the same folders
and the same trust decision (`project-git-trust.test.ts`, "Project.resolve keeps a folder's project across the grant when
git or Mercurial cannot name it"; `project.test.ts`).

### A project's config waits for its folder to be trusted

The settings in a project's `orbit.json` and `orbit.local.json`, and in the hook settings and `.mcp.json` that other
agent products keep there, used to apply the moment Orbit opened the folder. They now apply in full only once the
folder is trusted. Until then Orbit keeps what cannot run code, spend money or reach the network, and leaves out the
rest:

- **Left out whole:** `language`, `output_style`, `model`, an agent's `model` and `steps`, a command's `model`, `hooks`, `mcp`, `plugins`, `shell`,
  `providers`, `env`, `sandbox`, `formatter`, `lsp`, `skills`, `references`, `worktree`, `experimental`, `share`,
  `enterprise`, `update`, `fallback_model`, `output_token_cap` and `default_agent`, the budgets `media`, `tool_output`, `compaction` and `shell_tool`,
  `attribution`, `system_prompt_file`, `instructions_exclude` and `model_aliases`, and `disabled` on an agent, whose
  entry goes with it. So are an agent's `effort`, `max_turns`, `tools`, `permission_mode`, `mcp_servers`, `hooks`,
  `skills`, `memory` and `isolation`. So are `mode` and `hidden` on an agent and `agent` on a command, because an agent's own rules
  come after yours and win: which agent a session starts as, which agent runs a command, and which agents the model
  may spawn as subagents choose between sets of rules, as `default_agent` does. A command from the project runs as the
  session's current agent, and an agent keeps the mode and visibility it has, or the ones a new agent gets. A key that
  is set but empty, such as `sandbox: {}` or `formatter: true`, is left out too: a project's value outranks yours, so
  it would otherwise replace the one in your own config.
- **Cut down:** `permissions`, and the `permissions` of each agent, keep only their `deny` rules, so a repository can
  add a block but never an approval. An agent's `request` is dropped, and so is every URL in `instructions` and every
  instruction path that leaves the project's folder. `websearch` and `warming` keep only `false`: a repository can
  switch web search or keep-alive requests off, but cannot pick a provider, so it cannot send your queries to the
  keyless search pool, and it cannot start generations that you pay for. `tool_execution` keeps a `max_concurrency` of
  10 or less, so a repository cannot raise the limit above 10. `webfetch` is left out when its `verbatim_hosts` list is
  not empty (an empty list is kept). `git_status` keeps only `false`, and an agent's `context` loses `instructions` in
  both directions and keeps only `git_status: false`, so a repository can turn the snapshot off but never back on over
  your own choice. An agent's `initial_prompt` is dropped when it starts with `/`.
- **Kept as written:** everything else, such as `username`, `snapshots` and `watcher`, and the fields of an agent that
  only describe it, except that a folder that is not trusted cannot rewrite the description or initial prompt of an agent that already exists.

What these files refer to is held to the folder too. Their `{env:VAR}` references are not expanded, and a
`{file:path}` reference is read only when it names a file inside the project's folder, not through a link that leaves
it and never on a network share, so a repository cannot pull a secret or another file into a value that is sent to a
model provider. A reference that is not expanded stays in the text as it was written, and expands once the folder is
trusted.

Instruction files are held to the folder in the same way. While the project is untrusted, `ORBIT.md`, `AGENTS.md` and
another product's instruction file load only when the file, and the file it links to, are inside the project's folders.
A repository that ships `AGENTS.md` as a symlink to an SSH key or a credentials file used to have it read into the
first request to your model provider; the link is now skipped. So is an instruction file in a folder above the project,
because the project does not vouch for what surrounds it, and one that the model's reads find in a folder of the
project, whose link leads out of it. Each file that is skipped is logged once, as a warning that says `instruction file
skipped` and names the file, and it loads when the project is trusted, without a restart, and goes again when the trust
is taken away. Instruction files in your own config directory are never held back, and nothing changes once the project
is trusted, so a symlinked `AGENTS.md` that you rely on works as before.

Everything else that a repository can point at is held to its folder in the same way, because each of these goes to the
model provider as well. Until the project is trusted, an agent file, a command file, a skill and an output style that a
link in the project leads out of the project's folders is not read, whether the link is the file or a folder above it:
`.orbit/agents` pointing at a folder of yours, or a `build.md` that links to a key, no longer replaces the system prompt
of every session. The same goes for the skills and output styles in another product's root. A config directory in a
folder above the project is held to that folder, whose own decision applies. Each file that is skipped is logged once,
as a warning that says `config file skipped` and names the file, and it is read once the folder is trusted, without a
restart. Your own config directory is never held back. An `output_style` also names one file in an `output-styles`
directory and nothing else: a name with a path separator or `..` is not found, in any directory, yours included, so a
config can no longer climb out of the directory to read another file.

The file tools hold a link to the folder in the same way. Until the project is trusted, `read`, `edit`, `write`,
`patch`, `grep`, `glob`, the shell's working directory and the other tools that take a path count a path that a link in
the project leads out of the project as outside it, and ask about the folder it leads to (`external_directory`) as for
any other path outside the project, which a run with nobody to ask rejects. A file that does not exist yet counts by
where the nearest folder of its path that does exist leads, so a `write` through a link is asked about too. A trusted
project follows its links, and asks about the folder they lead to in the same way (see "A link inside a trusted project
that leads out is asked about like the folder it leads to").

Orbit starts no language server and runs no formatter in a folder that is not trusted, the built-in ones and the ones
in your own config alike, because they read the folder's own code and config and several of them run it. Both start
working as soon as the folder is trusted.

The files in a project's `.orbit` directory are held to the same decision, because some of them run code:

- **Plugins:** the server does not load the plugins in `.orbit/plugins` (or `.orbit/plugin`), and does not report them
  as failed. They start when the folder is trusted, without a restart, and stop again when the trust is taken away. The
  terminal UI finds the plugins in `.orbit/plugins` on its own and imports their `tui` entrypoints, so it waits for the
  folder to be trusted as well: it imports none of them until the server has answered and the folder is trusted, and
  drops them when the trust is taken away. The ones in a folder around the project, which the server holds back until
  that folder is trusted too, stay off in the terminal UI as well.
- **Commands:** a command from `.orbit/commands`, or from a `commands` setting of the project, is still listed, and one
  whose template has no shell snippet works as before. One that runs a shell snippet (an exclamation mark and a command
  in backticks) fails with a message that names the command and the folder to trust, which is the folder around the
  `.orbit` directory or config file that defines it. Nothing is asked about or started first. A command that names an
  `agent` runs as the session's current agent instead, as a subtask as well.
- **Agents:** an agent defined in `.orbit/agents` or `.orbit/modes` keeps its prompt and description, and loses
  what the same entry in `orbit.json` would lose: its `model`, `steps`, `request`, its `allow` and `ask` rules, `disabled`, `mode` and
  `hidden`, so a file cannot remove or hide one of the agents that are already there, or make one of them spawnable by
  the model.

Skills and output styles in a project are text, so they stay available, except through a link that leaves the project
(see above). No Markdown file that Orbit reads from a config directory is ever run: front matter written in JavaScript
(a file that opens with `---js` or `---javascript`) is refused, and the file is skipped. The list of what a folder holds
back also names each `.orbit` directory with the plugins, commands with shell snippets or an agent, and agents with
requests, approvals, a mode or `hidden` that it holds.

A folder that is a linked worktree of a git repository shares the decision of that repository's main checkout, but only
when the repository lists the folder as one of its worktrees, which `git worktree add` does. A `.git` file in a folder
can name any git directory, and that directory can name another repository's as its common directory, which used to
make that repository the folder's main checkout: a folder from an archive or a download that knew where a repository
you trust lives took on the decision you made for it, and its config applied in full. Such a folder now has a decision
of its own.

Your own config, `ORBIT_CONFIG`, `ORBIT_CONFIG_CONTENT` and the server's remote sources are never held back, and neither
are the Orbit files in your home directory. Trust belongs to the project's root folder, so a repository and its linked
git worktrees share it. Config that Orbit finds in the folders above the project, such as an `orbit.json` in a folder
that holds several repositories, follows the decision for the folder that holds it: trusting a repository does not
trust what surrounds it, and until that folder is trusted too, those files stay in the list of what is held back. A
grant is kept in Orbit's database, and granting or revoking it reloads the config of every open project it concerns,
which turns hooks, MCP servers and plugins on or off without a restart. The home directory and filesystem roots can be
trusted only until the server restarts.

A server can instead trust every folder except the home directory and filesystem roots, without a grant. A private
server (`--standalone`, and `orb acp`) or a foreground `orb serve` does so when it starts with `ORBIT_TRUST_PROJECT=1`
or `true` in its environment. An SDK host or `@orbit/server` host does so with `trust: { implicit: true }` in its
options, and when that is not set, it trusts nothing on its own, whatever its environment says. The background service
ignores the variable, because it serves every client and project.

**Affects:** anyone who opens a repository whose config sets `hooks`, `mcp`, `plugins`, `providers`, `sandbox`,
`formatter`, `default_agent`, `warming` or `allow` and `ask` permission rules, through the background service (the
terminal UI, VS Code and the desktop app): those settings now stay off. So do the server's plugins from
`.orbit/plugins`, the shell snippets in the commands of `.orbit/commands`, the `agent` of a command, the `request`
overrides, `mode`, `hidden` and `allow` rules of agents in `.orbit/agents`, and language servers and formatters, in
every folder that is not trusted, until it is trusted in the terminal UI or with `orb trust` (or, for one run of a
headless command, `--trust`). The same goes for SDK hosts and servers that leave `trust.implicit` unset, and for tests
that write project config and start a server. So do the plugins that the terminal UI loads from `.orbit/plugins`
itself. Code built on `@orbit/core`: `Config.Document` and `Config.Directory` gain `trusted`, `Config.Document` gains
`withheld`, the roots that `Config.compat` lists can carry `trusted`, `Config` now needs `WorkspaceTrust`, `Lsp` and
`Formatter` now need `ProjectTrust`, `ProjectTrust` now needs `FSUtil`, `ProjectTrust.status` also lists `.orbit`
directories and gives each file or directory above the project the folder to trust for it, as `directory`,
`ProjectTrust.allows` says whether a file may run the code it carries (ask it before running anything a file carries,
such as the hooks in a skill's or an agent's front matter), and three more ask what a link in the project may reach,
which each reader of a file that a repository points at must ask (the readers that do are the instruction plugin and
`SessionInstructions`, which ask `ProjectTrust.reachable`, the agent, command, skill, compatibility and output style
plugins, which ask `ProjectTrust.supplies` about the files of a config directory or another product's root, and
`FileAccess`, which asks `ProjectTrust.escapes` where a path really leads). `FileAccess` and the plugins that read those
files now need `ProjectTrust`, `SessionInstructions` needs it as well, `AgentFile.load` and `CommandFile.load` take the
check as an optional argument, and a global `trust.updated` event reports each change. Files that are a link out of an
untrusted project, and the ones in the folders above it, stay unread until it is trusted, and a path through such a link
is asked about by the file tools. `ConfigTrust.classification` withholds the `agent` of a command and the `mode` and
`hidden` of an agent, and `ConfigTrust.sanitizeCommands` cuts the commands of a directory down as it does those of a
document.

**What to do:** nothing for config you keep in your own files. For a repository you trust, run `orb trust` in it, or
run with `--standalone` and `ORBIT_TRUST_PROJECT=1`, or pass `trust: { implicit: true }` to the host you embed, which
also suit CI and tests. See "The headless commands stop in an untrusted folder, and `orb trust` trusts one" and "The
terminal UI asks whether to trust a folder" under Clients.

### Nothing in a folder loads or runs until you trust it

The note above describes a folder that loads with parts left out. That is gone: as the reference does, Orbit now reads
nothing a folder supplies, and starts no work there, until you trust the folder. Its `orbit.json`, `orbit.local.json`
and `.orbit` directory, and the files other agent products keep there, are not read at all while it is untrusted, so
its agents, commands, skills, output styles and plugins do not appear either. Your own config, managed settings and
`--settings` load as before.

What changed:

- The terminal UI asks about the folder it starts in whenever that folder is not trusted, whatever the folder holds.
  The question lists nothing from the folder, because nothing was read; it offers "Trust this folder" (or "Trust until
  Orbit restarts" for a home directory or a filesystem root) and "Exit", and starts on "Trust this folder", as the
  reference's does. Exit and Escape end the terminal UI with exit status 1, and `n` with status 0. A session in another
  untrusted folder is asked about with "Trust this folder" and "Not now"; "Not now" keeps the terminal UI open, and the
  server refuses that session's work. When the trust read fails, times out or answers with something that is not a
  trust status, the question opens anyway.
- The prompt on Home and in a session takes no keys, and shows no placeholder, until the trust of the folder in view
  has been read and, when it is the folder the terminal UI started in and is not trusted, until you trust it. Whatever
  you type before then, Enter included, goes nowhere: nothing is sent, and it cannot answer the question. A `--prompt`
  is sent once the prompt opens. Once open, the prompt stays open for the run; a question about the start folder that
  opens after that, such as after `orb trust --revoke` in another terminal, starts on "Exit", so an Enter meant for the
  prompt does not trust the folder.
- Every headless door refuses an untrusted folder, even one with no config at all: `orb run` (with or without `--bare`),
  `orb -p`, stream-json input, `orb loop`, `orb flow run`, `orb eval`, `orb doctor --probe`, `orb session import`
  (for the folder the session lands in), `orb mini`, an ACP `session/new`,
  `session/load` or `session/resume` (a JSON-RPC error whose `data.type` is `untrusted_folder`), and an SDK host that
  does not set `trust: { implicit: true }`. The server refuses a session, an imported session, a prompt, a command, a
  skill, a synthetic message, a shell command (in a session or through `POST /api/shell`), a compaction, a fork, a move
  into the folder, text generated from a session (`session.generate`, and the title Orbit writes when you clear one),
  the instruction preview, an instruction note (whatever its scope), a terminal (`pty.create` and a session's
  terminal), a worktree (create, remove and refresh), an MCP connection and a file write there with `UntrustedFolderError` (HTTP 403), which names the folder. A server older
  than workspace trust cannot say, so the CLI stops there too.
- A grant for a folder now covers every folder below it, as the reference's walk up the parents does, and a trust
  status names the folder whose grant applies as `granted`. The walk starts from where the folder really is: a folder
  that does not exist yet is placed by the part of its path that does, and one below a link that leads nowhere is
  covered by no folder above it. Revoking a folder that a parent's grant covers leaves it trusted, and `orb trust
  --revoke` names the folder whose grant to end; `orb trust` on such a folder gives it a grant of its own. A grant for
  the home directory or a filesystem root still lasts only until Orbit restarts, and covers that folder alone.
- `orb flow ls`, `show`, `cost`, `trace`, `watch` and `approve` need the folder trusted before they open its run store,
  and take `--trust`, `--standalone` and `--server` like `orb flow run`. `orb doctor` and `orb session import` take
  `--trust` too, and `orb doctor --probe` lists the models of the folder it asks about and probes (the one your shell
  names in `PWD`), not of the folder the process runs in.
- A terminal or a shell command (`POST /api/shell`) checks the folder it is asked to start in as well as the Location's
  or the session's folder, and is refused when either is untrusted. A file write (`fs.write`) is refused when the folder
  it really lands in, once every link in its path is followed, is not trusted, unless that folder is Orbit's temporary
  folder. A worktree is not made in a `directory` that is not trusted.
- A folder that a request, a plugin, the model or a config names besides its Location is read once, from a folder of
  its own, and the folder checked is the folder acted in. Each reads `~` and `~/...` as your home folder, a Git Bash,
  Cygwin or WSL drive spelling as that Windows drive, a relative path from its own folder, and the name in Unicode's
  composed form; a name with a null byte is refused (HTTP 400). What each reads from, where it used to be the server's
  working folder or the spelling as it came:
  - A session's move (`POST /api/session/:id/move`, a plugin's `session.move`, the model's `session_move` tool, and the
    worktree tools' moves): the session's own folder. A move into a folder that is not trusted is refused by each of
    them, the route with `UntrustedFolderError` and the others with `WorkspaceTrust.UntrustedError`, both naming the
    folder as it really is.
  - `pty.create`, `shell.create` and `fs.write`: the Location's folder. `~` is now your home folder, where it used to be
    a folder named `~` there.
  - A session's terminal (`persistentPty.create`): the session's folder. For a session Orbit does not know, only an
    absolute `cwd` is taken (HTTP 400 otherwise).
  - `worktree.create`: the project's folder, for its `directory` and `from`.
  - A local MCP server's `cwd`, whether a config, a plugin or `PUT /api/experimental/mcp/:server` names it: the
    Location's folder. The server waits until that folder's project is trusted as well as the Location's, and its status
    names the folder it waits for; `PUT /api/experimental/mcp/:server` answers `UntrustedFolderError` (HTTP 403) at once
    instead of adding it.
- The Effect SDK's `sessions.create` refuses a folder that is not trusted (the one named, or the parent's) with
  `WorkspaceTrust.UntrustedError`, as `sessions.move` does for its destination; it used to create the session.
- ACP `session/new`, `session/load`, `session/resume` and `session/fork` refuse an additional directory that is not
  trusted, with the same `untrusted_folder` error as for the session's own folder, and grant nothing.
- A resumed `orb flow` or `orb eval` run uses a worktree that its run store names only when it lies below the
  repository's `.orbit/worktrees`; any other folder, or a link there that leads out, is not used (one log line), and the
  check or reviewer runs where the run does.
- `orb flow ls`, `show`, `cost`, `trace`, `watch`, `approve`, `resume`, `replay`, `clean`, `orb eval` and the terminal
  UI's runs dialog look for the run store no higher than the project's folder, starting from where the folder really
  is, so a store in a repository above it is not opened. The runs dialog shows and decides nothing in a folder that is
  not trusted.
- A plugin can no longer create a session in a folder that is not trusted, move one there, or send a session there a prompt,
  a command, a synthetic message or a compaction, or generate text from it: those calls fail with `WorkspaceTrust.UntrustedError`, which names the
  folder.
- A session that began in a folder that is still untrusted, under an earlier release, takes no more work until the
  folder is trusted, and is not resumed after a restart until then. The same holds for a background subagent whose
  folder is no longer trusted when the server restarts: it is not resumed, its parent is not told that it failed, and
  the next start after the folder is trusted resumes it and tells the parent then.

**Affects:** scripts, CI jobs and SDK hosts that ran in folders nobody trusted, and anyone who answered "Not now" in the
terminal UI and kept working.

**What to do:** trust the folder with `orb trust`, pass `--trust` for one run, or pass `trust: { implicit: true }` to
the host you embed. In the terminal UI, answer the question with "Trust this folder".

### A folder's model, provider and budget settings wait for it to be trusted

An untrusted folder can no longer pick a model, a provider or a budget, because every one of them is paid for by you.
While a folder is untrusted, `ConfigTrust` takes these out of its config documents and out of its agent and command
files, keeps the rest of each entry, and reports the `providers` kind as withheld: the top-level `model`, the `model`
and `steps` of every agent (so also `agents.title.model`, which `small_model` migrates to, and `agents.side.model`,
which pins the model of side queries), and the `model` of every command. Orbit uses your own settings instead.
Trusting the folder restores them. The top-level `fallback_model`, `output_token_cap`, `shell_tool`, `media`,
`tool_output` and `compaction` are withheld the same way: the last three set how much each paid request carries (image
size, the length of tool output, and when and how a conversation is compacted), so a repository no longer sets them
until its folder is trusted. Your own values for them stand meanwhile.

A workflow or suite file in an untrusted folder can no longer pick a model either. `orb flow run`, `flow resume` and
`eval` stop, with the usual untrusted-folder message and exit 1, before any model is asked, when a YAML or JSON file sets
a `model` on a node, a team member or a `judge`, lists `retry.fallbackModels`, sets `retry.maxAttempts`, `maxIterations`
or `maxRounds`, or is a suite with `models`, even in a folder that holds nothing back. The message lists each field as
written under "lets the file choose which of your models run its nodes". Before, such a file ran at once and its `model`
replaced the `--model` you passed. `--trust` runs it once, `orb trust` trusts the folder for good, and a file that sets
none of these keeps running without a grant. In a trusted folder nothing changes: the file's model still wins over
`--model`. The file's own `budget` is not held, because it only lowers what a run may spend.

A folder whose only config is one of these now counts as holding config back. The headless commands (`orb run` and
the others) stop in it with the usual untrusted-folder message and exit 1, and the terminal UI and VS Code show the
trust prompt, which lists the `providers` kind.

**Affects:** a repository that sets `model`, an agent's `model` or `steps`, a command's `model`, `media`, `tool_output` or `compaction` in its own
`orbit.json` or in a file of its `.orbit` directory, until its folder is trusted.

**What to do:** Nothing for your own config. To use a repository's model settings, run `orb trust` in it, or set them in
your user config.

### Managed settings files

An organization can now put settings in a folder that only an administrator can write. Orbit reads
`managed-settings.json`, then the `managed-settings.d/*.json` drop-ins in filename order, from `/etc/orbit` on Linux,
`/Library/Application Support/Orbit` on macOS and `%ProgramFiles%\Orbit` on Windows (`C:\Program Files\Orbit` when that
variable is unset). Windows does not use `%ProgramData%`, because a standard user can create and write under it.
In a run from source, `ORBIT_MANAGED_DIR` points the server at another folder (Orbit does not check who can write it).
The released `orb` binary ignores that variable: its build replaces the one place that reads it, so no environment
can move an organization's policy folder (pinned by `packages/cli/test/managed-define.test.ts`); an application that
embeds the server picks the folder with `ServerOptions.managed.directory`. `orb debug paths managed` prints the one in
use. Objects merge by key, lists of independent entries (permissions,
policies, instructions, plugins, restriction lists) concatenate and lose their repeats, and any other value takes the
later file's: a `command` argument list, a tiered `cost`, a model, and a whole entry of `mcp.servers`, `lsp`,
`formatter`, `references` and `commands` (each entry is one definition, so a later `url` never keeps an earlier
`headers` or `oauth`, an LSP `env` never reaches another server, and a `disabled` entry is replaced, not kept). `providers`
and `agents` merge by key, as across documents, except that a later agent entry that leaves out `disabled` is enabled again. A relative `plugins` path in a drop-in
resolves against the managed folder, not `managed-settings.d`; a `{file:}` variable resolves against the file that
holds it. The merged settings load as a `managed` scope document that outranks every other scope, and the file watcher reloads them
while the server runs. A `managed` block in these files holds restrictions (`organization`, `mcp`, `plugins`,
`network` and the hook and permission switches); the key is ignored with a diagnostic in any other config file. Orbit
never creates the folder, and a folder created after the server starts is read on the next start.

A file or an entry that does not decode is skipped on its own and never drops what its siblings say, and a key that
Orbit does not know, at any depth of the native settings (`sandbox.enabeld`, a server's `disable`, an agent's `permisions`), is
reported instead of ignored. The legacy top-level spellings (`agent`, `provider`, `permission` and the rest) are not
checked, and neither is a key that another variant of the same value knows (`headers` on a local server). `orb doctor` lists
the managed files by name and each problem it found. The permission rules and restrictions go to the policy service,
which enforces them (see "Managed permission rules, hook limits and the bypass switch are enforced").

**Affects:** machines that already have a file at one of those paths, and people who run a server from source with
`ORBIT_MANAGED_DIR` set. A released `orb` no longer honours the variable.

**What to do:** Nothing unless your organization manages Orbit.

### Managed permission rules, hook limits and the bypass switch are enforced

Managed settings now take effect. Permission checks end in a managed layer that runs in core after the plugin hooks, so
no plugin can override it. In order of precedence: a configured deny (agent rules, session rules and every non-managed
config) first, then the last managed rule that matches each resource, then plugin hooks, then grants and config rules,
then the default ask. A managed deny blocks with "Blocked by <organization>'s managed settings" (without the name when
`managed.organization` is unset); a managed `ask` downgrades a config allow, a grant or a hook allow; a managed `allow`
upgrades only the default asks: the one no rule spoke to and every agent's built-in `external_directory` ask for a place outside the project, also when it reaches a link's folder through the real place the link leads to and your own allow or an "Always" covers that folder (`external-leads.test.ts`). It never lifts an ask that your own rule (an `external_directory` one included), an agent's built-in `.env` ask, Plan's `Bash` ask or a plugin hook gave, and never lifts a deny (a hook's included, also against a managed `ask`) or a place that a link in an untrusted folder leads out to. Managed `Read`, `Edit` and `external_directory` rules expand `~` and `$HOME` (and `~\` on Windows), and a `Read` or `Edit` rule, managed or your own (agent, user, project or session), also decides a file inside the session's folder by its absolute place, so a deny or an ask on `~/.ssh/*` holds when Orbit runs in the home folder (the rows "under the person's ... rule" in `permission.test.ts`). The same expansion now applies to user and project config rules: `~\` works on Windows, and a rule whose action is a pattern such as `*` or `Read*` gets one expanded copy for each of `Read`, `Edit` and `external_directory` that it names (Bash text is still matched as written). The rules that a
managed `agents.<name>.permissions` gives an agent now apply to that agent too; they took effect nowhere before.

- `managed_permissions_only` ignores the permission rules of every non-managed document and the saved "always"
  approvals, drops allow rules from a session's own permissions, offers no "always" on a request, and treats an
  "always" reply as "once". The built-in rules of the agents stay.
- `disable_hooks` runs no declarative hook, and `managed_hooks_only` runs only the hooks of managed settings. The managed file's own `hooks.disabled` and `hooks.managed_only` mean the same.
- `disable_bypass_permissions` makes `orb`, `orb run`, `orb -p`, `orb loop`, `orb flow run`, `orb flow resume` and
  `orb eval` ignore `--auto`, `--yolo` and `--dangerously-skip-permissions`: the command prints one notice and goes on
  without the mode, so it keeps asking, and a question that nothing can answer is declined (headless runs reject it).
  Managed asks and denies still apply. The notice goes to stderr, except under `--format json` and `stream-json`, which
  print it as a `{"type":"warning",...}` line on stdout. A workflow or suite node whose
  `permissions` is `auto` (including a team member's) has its requests rejected, with the managed message as feedback.
  The terminal interface keeps asking for permission and shows a notice when auto-accept was requested. A server that
  cannot say whether bypass is allowed gets the same treatment: the mode is ignored, with a notice. (An earlier build
  stopped these commands with an error; the rows of `test/managed-bypass.test.ts` pin the new behaviour.)
- `GET /api/config/effective` also reports `permissions: { bypass, always }`, so clients can read these switches.

Bypass is refused by the clients until a durable permission mode in the server reads the managed settings itself.

**Affects:** organizations that ship managed settings, and people on their machines who use `--auto` or workflows with
`permissions: auto`.

**What to do:** nothing unless your organization manages Orbit.

### A foreground shell command that outlives its timeout moves to the background

A foreground shell command that is still running at its timeout is no longer killed. It keeps running as a background
shell job, the call returns its shell ID and output file, and one notification follows when it finishes. A command made
only of sleeps (`sleep 60`, `Start-Sleep 60`) is still stopped at its timeout. Anything else is moved, including a
command Orbit cannot read, and a sleep followed by other work.
A command that exits before the call has seen it move is returned inline, as if nothing had happened, with no
notification.

Agent, verify, team and eval nodes of `orb flow run` and `orb eval` wait for such a command too: a node reports its
reply only after the session's background commands have ended and their notices have been answered, within the node's
own timeout.

A foreground `timeout` of `0` no longer means "never time out": it means the default, like leaving it out. A timeout
above the maximum is lowered to the maximum in every shell, and for a background command too, whose kill deadline is
still only set when a timeout is given.

Two new settings in `orbit.json` choose the numbers: `shell_tool.timeout` (milliseconds, default 120000) and
`shell_tool.max_timeout` (default 600000). The maximum is never below the default, so setting only a longer `timeout`
raises the maximum to match. The tool description shows the model both numbers. A project's `shell_tool` waits for the
folder to be trusted, like the other budget settings; yours applies everywhere.

**Affects:** scripts and agents that relied on a long command being killed at its timeout, or on `timeout: 0` to wait
without limit, and SDK callers that read `shell_tool` from the config schema.

**What to do:** Stop a command you no longer want with `TaskStop`.
Raise `shell_tool.timeout` and `shell_tool.max_timeout` if a command should be waited
for longer before it moves.

### Managed MCP, plugin and network-domain restrictions are enforced

The `mcp`, `plugins` and `network` lists of a managed `managed` block now take effect. Only managed settings can set them; a repository, user or flag file cannot.

- **MCP.** `mcp.deny` and `mcp.allow` hold selectors: a server name, `command:<pattern>` (a local server's command joined with single spaces) and `url:<pattern>` (a remote server's URL, tried both as written and as the URL parser serializes it). In a pattern `*` matches any run of characters and everything else is literal, case counts and nothing depends on the operating system. Joining a command with spaces cannot tell `["node", "a b"]` from `["node", "a", "b"]`; write commands without spaces inside an argument when that matters. Deny wins. No `allow` allows everything and `allow: []` allows nothing. With an `allow`, a local server must match a `command:` selector when the list has any (a name alone no longer admits it) and a name otherwise; a remote server likewise with `url:`. The lists apply to servers from every document, **the managed document's own servers included**, and to plugins, Code Mode defaults and `Mcp.add`. A blocked server does not exist: it is not listed, never starts, and the server logs one line (name and reason, never the command or URL) when its state changes. `PUT /api/experimental/mcp/:server` answers a blocked server with 403 `ForbiddenError` and stores nothing; an ACP session skips only that server, and `orb mcp add` refuses a blocked server with the denied or not-on-the-allow-list wording and writes nothing. A new or lifted restriction takes effect on the running server.
- **Plugins.** `plugins.block` and `plugins.allow` hold `*`, `prefix.*`, `@scope/*` or exact selectors; any other `*` is reported as an invalid entry and dropped, because it would match nothing. An absolute path selector matches the whole path and holds no `*` (`/opt/plugins/*` and `C:/plugins/*` are reported as invalid and dropped); it is made real once per activation, so one written through a link meets the real path of a target. `block` wins. `allow: []` allows no external plugin, and a plugin that the managed document names is held to `allow` too. A registry package is matched by its name without the version (`@corp/x@^1` is `@corp/x`), a local plugin by its real absolute path (exact; separators are normalized and case folds on Windows only; Windows 8.3 short names are expanded, but a UNC admin-share spelling such as `//localhost/C$/...` or a copy of the folder is a different path, so a path block matches the real path only and only an allow list holds against another spelling), and a spec whose package cannot be named (git, alias, tarball) is not allowed while `allow` is set. Built-in, SDK and instance plugins are never held back. A blocked or unlisted target is never installed or imported (the server's source scan still lists its folder before the check); `orb plugin add` refuses it before the registry is contacted, `POST /api/plugin/update` answers 403 for it without a registry request, a path that cannot be resolved (a target under a file, a link loop, an unreachable network share) is one unverified entry that is refused under an allow list and never stops the other plugins, and a plugin that was running when its ID was blocked is not kept running by a failed reload. It shows as failed with "Blocked by managed settings". A plugin ID is known only after import, so `block` by ID stops the plugin's setup but **its top-level module code has already run**; to stop code from running at all, block the target. The terminal UI applies the same lists in its own process to the plugins only it loads, and loads no external plugin when the server does not report them (`GET /api/config/effective` has a new `plugins` field). `plugins.marketplaces` is read and kept for a later release.
- **Network.** `network.denied_domains` denies every URL-bearing tool (WebFetch and Code Mode `fetch`, for the first URL and for every redirect hop) whose host matches: an exact host, or `*.domain` for subdomains at any depth but never the domain itself or an IP address. Hosts are compared in canonical form, so `127.1` and `2130706433` are `127.0.0.1`. A URL action whose resource cannot be read as an http(s) URL is denied while the list is not empty. Each entry is checked when the file is read: a scheme, path, port, `*`, `*.com`, a stray `*` or whitespace is reported and dropped, and a one-label name such as `intranet` is accepted. `network.allowed_domains` and the new `network.allow_managed_domains_only` do not limit WebFetch or Code Mode `fetch`; use managed permission rules for that. They bind shell commands in the sandbox, which can only allow all of the network or none of it, so until a per-host proxy exists **any of `denied_domains`, `allowed_domains` or `allow_managed_domains_only` launches a sandboxed command with the network off**. Commands outside the sandbox (including every command on native Windows, which has no sandbox), remote MCP servers and language servers are not bound; set `sandbox.enabled` in the managed settings, and the server logs once when domain lists exist but a command ran unsandboxed.

**Affects:** organizations that ship managed settings, and people on their machines who run MCP servers, plugins or sandboxed shell commands.

**What to do:** nothing unless your organization manages Orbit.

### Managed settings can run only the MCP servers they define

Set `managed.mcp.managed_only` to `true` in the managed settings (only managed files can set it) and Orbit runs only the servers in the managed document's own `mcp.servers`. Servers from every other source are ignored: user, project, local, flag (`--mcp-config`, `--settings`, `ORBIT_CONFIG_CONTENT`) and well-known config, plugins and their transforms, and `.mcp.json`. A server that the flag drops is not listed and never starts, and the server logs one line (name and reason, never the command or URL) when that state changes. The organization's `mcp.allow` and `mcp.deny` still apply to the managed servers, and a later drop-in's value wins over an earlier file's, as for the other managed flags. A value that is not a boolean is ignored with a diagnostic and costs only itself.

- A managed server runs as the managed files write it. Its `timeout` defaults come from the managed `mcp.timeout` alone, so a person's `mcp.timeout` and Orbit's Code Mode defaults do not shape it; write `codemode` in the managed definition if you want it.
- `PUT /api/experimental/mcp/:server` (`Mcp.add`) answers 403 `ForbiddenError` for every server, including a replacement of a managed server's name, and stores nothing. The refusal is given before the deny and allow lists, so it names the real cause. `orb mcp add` refuses and writes no file, and an ACP session attaches without each server it names and adds it on a later attach once the flag is off.
- `orb`, `orb -p` and `orb run` with `--mcp-config`, or `--settings` (inline or a file) with `mcp.servers`, that names at least one server stop with exit code 1 before the first request. An empty `{"servers":{}}` runs. A server that does not report `config.effective.mcp` (an older one) stops the run too.
- `Mcp.remove` works on a managed server, and a removed one stays out until restart.
- The change takes effect live: turning the flag on stops the other servers on the running server, a managed server whose definition did not change keeps its process, and turning it off starts the others again.
- `GET /api/config/effective` reports `mcp.managed_only`; it is absent from a server that predates it, which clients read as unknown.

**Affects:** organizations that ship managed settings, and people on their machines who add MCP servers by any route, plus SDK callers of `Config.Effective`, which gains an optional `mcp` field.

**What to do:** nothing unless your organization manages Orbit. To use it, define the servers in the managed `mcp.servers` and set `managed.mcp.managed_only` to `true`.

### A background shell command that stops at a prompt is reported once

Orbit now watches every shell command that runs in the background (asked for, moved at its deadline, or moved by a
client). It looks at the size of the command's output every 5 seconds. After 45 to 50 seconds without new output, it reads
the last 1024 bytes. If the last line looks like a question the model could answer (`(y/n)`, `[Y/n]`, `(yes/no)`, "Do you
...?", "Are you sure ...?", "Press any key", "Press Enter", "Continue?", "Overwrite?"), the session gets one notice with
state `waiting`, the end of its output, and advice to stop the command with `TaskStop` and run it again with the answer supplied.
Password, passphrase and token prompts are not matched. A command that is only slow or quiet gets no notice. There is at
most one notice per command, it does not end the job, and the completion notice still follows. Commands still run with no
input, and a foreground command is not watched until its deadline moves it to the background.

**Affects:** clients and scripts that read the synthetic shell notices of a session: `metadata.state` can now be
`waiting`, which is not an end of the job.

**What to do:** Treat `waiting` as progress. Take the end of a job from the job and shell events.

### An `env` setting for the programs Orbit starts

`orbit.json` and the managed settings now take a top-level `env`: variable names and values that are added to the
environment of the shell, terminals, hooks, the shell snippets of slash commands, MCP servers, language servers and
formatters that Orbit starts for a location. It works in every scope and folds name by name, with the organization's managed value last, so it wins. A
program's own variables (an MCP server's `environment`, a formatter's `environment`, an LSP server's `env`, a terminal's
caller) and Orbit's (`ORBIT_PROJECT_DIR`, `TERM`, `ORBIT_TERMINAL`) win over it. A number or boolean is kept as its text.
An entry with an empty name, a name holding `=` or a NUL, or a value that is not text is skipped on its own, and
`NoDefaultCurrentDirectoryInExePath` cannot be set from `env`. On Windows names are one variable whatever their case,
so a later `PATH` replaces an earlier `Path`.

`env` is read each time a program starts, so a name removed from a file stops applying to the next program, which is
stricter than adding variables until a restart. A project's or local file's `env` waits until the folder is trusted,
with the other settings that reach programs; `orb trust` lists it as `env`, and the terminal interface and VS Code
name it "environment variables". Workspace-bound locations and the persistent terminal
panes of the interface get no overlay. The managed `env` is also put into the environment of a server that `orb`
starts, once at boot, so a change to it needs a restart there; the server's own network requests take proxy and CA
settings from that environment or from the one the server was started with, not from user or project `env`.

With compatibility on (the default), an `env` in another product's settings files now reaches those programs the same
way, which can carry provider keys into every child; turn it off with `compatibility.enabled = false`. The managed
settings' `managed.env` is ignored and reported: use the top-level `env`.

`which` now skips every `PATH` entry that is not absolute (`.`, `bin`, `node_modules/.bin`, and on Windows a
drive-relative or root-relative one), as it already skipped empty ones, so Orbit's own lookups never find a `git` or `rg`
in the working folder through such an entry.

**Affects:** people who set `env` in any settings file, organizations that manage settings, and people whose `PATH`
holds a relative entry that Orbit's own lookups used to honor.

**What to do:** Move variables you want in Orbit's child processes into `env`. Replace a relative `PATH` entry with an
absolute one.

### Config `env` cannot set Orbit's own control variables

`env` in any settings document now skips `ORBIT_MANAGED_DIR`, `ORBIT_TRUST_PROJECT`, `ORBIT_CONFIG`, `ORBIT_CONFIG_DIR`, `ORBIT_CONFIG_CONTENT`, `ORBIT_CONFIG_CONTENT_FILE` and `ORBIT_PASSWORD`, in any spelling, with one "unsupported" diagnostic at the entry's own path. Before, a trusted project's or your own `env` could hand them to every program Orbit starts, so an `orb` started from a hook or an approved command could read another managed folder or trust its folder implicitly. A nested `orb` now inherits these names exactly as the parent process has them.

**Affects:** setups that set one of these names from `env` on purpose.

**What to do:** Export the variable in the environment you start Orbit from instead.

### Instruction files lose their comments and front matter, and `instructions_exclude` skips files

Every instruction file (`ORBIT.md`, `AGENTS.md`, and the file of another product that compatibility reads) now goes
through one step before the model reads it, whether a session loads it when it starts or a read of a file in its folder
finds it later:

- **Comments.** An HTML comment that stands at the top level of the file, on a line of its own and indented by at most
  three spaces, is removed, a comment that runs over several lines included. A comment inside fenced or indented code,
  inside a sentence or an inline code span, or inside a list item, a quote or another HTML block is text and stays. Text
  after the closing marker on its line stays, and so does a comment that is never closed. A file with a comment loses
  its CRLF line endings in what the model reads.
- **Front matter.** A block at the top of the file is removed whatever it says and is never read as code: the first line
  is exactly three dashes, spaces after them allowed, and the block ends at the next such line. A first line with
  anything after the dashes, such as `---js`, or with more dashes is not front matter, and the text stays as written.
- **Empty files.** A file with nothing left (empty, only comments, only front matter) adds nothing. It used to load as a
  heading with no text. In a folder with several instruction names the first one present still wins, so an empty
  `ORBIT.md` does not hand its place to `AGENTS.md`.
- **Size.** A file of more than 40,000 characters, counted after the two steps above, is recorded as a warning and is
  still sent whole. The warning never reaches the model, and no client shows it yet.
- **`instructions_exclude`.** A new list of glob patterns or absolute paths of instruction files that Orbit does not
  load. A pattern is matched against the whole absolute path of the file, written with forward slashes, and `*` also
  matches names that start with a dot. The match is case-sensitive, except for a drive letter. A pattern with no folder in
  it, such as `AGENTS.md`, matches nothing, and neither does one that starts with `~`, which is not expanded, so write
  `**/third_party/**/AGENTS.md` to skip a folder's file wherever the project lives. The lists of your settings, the
  project's, the local file's, the flag's and the organization's are added up. An excluded file is not read at all, and
  the next name in its folder takes its place. A project's or local file's list is ignored until its folder is trusted,
  because it would otherwise let a repository hide your own instruction files from the model.

A session that already has instruction files with comments or front matter gets one instruction update at its next
boundary, because what is stored for it is now the text that is left. Changing only a comment, or only the front
matter, of a loaded file starts no update.

**Affects:** anyone whose instruction files hold comments or front matter, including a file that opens with a rule line,
some text and another rule line (the text between them is now front matter and goes); sessions that were running
during the upgrade; and code that implements `InstructionDiscovery`, which has a new `warnings()` method and a `warn`
method on its editor.

**What to do:** Nothing for most setups. Keep a note for the model out of a comment, and start a file that needs a
leading rule line with a heading. Add `instructions_exclude` to your own config to skip instruction files that you do
not want the model to read.

### An agent file defines its agent, and an agent definition has more keys

A Markdown file under `agent/` or `agents/` in a config directory used to be merged field by field into an agent of
the same name, so a file named `explore.md` kept the rules of the built-in explore agent. It now defines the agent: it
replaces whatever an earlier entry made of that name, built-ins included, and nothing of the earlier definition
survives, its permission rules included. To tune a built-in, put the changes under `agents.<id>` in `orbit.json`, which
still merges field by field, in entry order. Files under `mode/` and `modes/` still tune, and so does a file named
`plan`, so Plan mode keeps its read-only limits. Replacing a hidden system agent (`title`, `compaction`, `summary`,
`side`) gives exactly what the file says: the agent is not hidden and has no small model unless the file says so. A file
under `agent/` or `agents/` that names no `mode` now gets `all`, so the model may start it as a subagent and a person
may run it as the main agent; a file under `mode/` or `modes/` stays `primary`.

An agent file or `agents.<id>` entry can set `model` (also `inherit`, `small` or `large`, which `model_aliases` and the
default model resolve later), `effort`, `tools` and `disallowed_tools` (a string or a list; a `*` in `tools` means every
tool, and a `*` in `disallowed_tools` denies every tool), `permission_mode`, `mcp_servers`, `hooks`, `max_turns` (an
alias of `steps`), `skills`, `initial_prompt`, `memory` (`user`, `project` or `local`), `background`, `isolation`
(`worktree`) and `context` (`instructions` and `git_status`; a folder that is not trusted can only turn the git snapshot off). `orbit.json` also accepts
`model_aliases` with `small` and `large`. These keys are stored and shown by `agent.list` and `agent.get`; what they do
when an agent runs lands with later changes. A field with a bad value is dropped with a log line or a diagnostic and
the agent still loads. An agent whose `tools` is a map of tool names to booleans is still read in the legacy v1
style: the map and the keys only that style has (`temperature`, `top_p`, `prompt` (in a Markdown file the body stays the prompt and a front matter `prompt` is ignored), `options`, `maxSteps`, `permission`)
are read as before, while every key Orbit's own schema has, `model`, `steps` and `permissions` included, is read
natively beside it. A field with a bad value on either side is dropped with a diagnostic (or a log line, in a Markdown
file) at its own path, and the rest of the agent, its deny rules included, still loads, and so does the rest of a tools map, a `permission` object or a `permissions` list when one entry in it is bad (that entry alone is dropped, named at `tools.<name>`, `permission.<key>` or `permissions.<n>`). A pattern object under `question`, `websearch` or `doom_loop`, which take one action only, is such an entry too, and the same per-entry handling applies to the top-level `agent` and `mode` maps of `orbit.json`: the keys the v1 format owns (`model`, `variant`, `steps`, `permission`, a `tools` map and the like) are read in that style, and every other key Orbit's schema has, `permissions` and `disallowed_tools` included, is read natively and never forwarded to the provider as a request option, so a tools map there no longer drops the denies of `build`, `plan` or `explore`. A folder that is not trusted adds its `disallowed_tools` to the list that is there instead of replacing it. A `variant` beside a model is
joined to it, and beside a model tier it becomes the effort, in `orbit.json` and Markdown alike. A `name` key in a file is
ignored (the path names the agent). The camelCase spellings of these keys (`disallowedTools`, `permissionMode`,
`mcpServers`, `maxTurns`, `initialPrompt`) are not read in Orbit's own folders; each one is reported once, naming the
snake_case key to use.

An agent name must be plain: segments separated by `/`, each starting with a letter or digit and holding only letters,
digits, `.`, `_` and `-`, not ending with `.`, and not a Windows device name such as `nul` or `con`. A file or an
`agents`, `agent` or `mode` key with another name defines no agent and is reported.

In a folder that is not trusted, a file under `agent/` or `agents/` no longer changes an agent that exists, or one that
a trusted config names in any scope, a flag or managed one included: it is held back whole, and the folder is listed as holding back permissions for every such file, because which names exist depends on the entries before it, the person's own agents included.
Trusting the folder applies it. The file may still define a new agent, cut down to the keys that are safe: `context`,
`background`, `disallowed_tools`, `system`, `description`, `color` and an `initial_prompt` that is plain text. The keys
that choose a model, a budget, tools, a mode, a memory scope, servers, hooks, skills or isolation, and an
`initial_prompt` that starts with a slash command, wait for trust, and so does `model_aliases` in `orbit.json`.

**Affects:** people who keep an agent file named after a built-in or after an agent in another entry, relying on it
to add to that agent; repositories that ship such a file; clients that read `agent.list` or `agent.get`, whose agents
gain optional fields.

**What to do:** Move the changes to a built-in into `agents.<id>` in `orbit.json`, or keep the file and copy the rules
you still want into it. Rename an agent whose name is not plain.

### Subagents get a task-worker prompt, and Explore leaves out the instruction files and the git snapshot

A session that runs as a subagent (it has a parent and is not a fork of the main conversation) used to start from the
main conversation's prompt when its agent had no prompt of its own, and was sent a fixed "you are a subagent" line
before the task. It now starts from a shorter task-worker prompt that tells it to finish the brief, state its
assumptions because nobody can answer, and end with a report. Every subagent, one with a prompt of its own included,
also gets a few reporting notes (absolute paths, no emojis, no colon before a tool call). The model overlays, the output
style, `system_prompt` and `append_system_prompt` do not apply to a subagent; the git section still does. A prompt of
your own for an agent can now hold the `${ORBIT_TOOL_GUIDANCE}` placeholder, which is filled with the guidance for the
tools the agent has. The task text is the child's first message, with nothing in front of it.

The `agents.<id>.context` keys now work. Explore ships with `instructions: false` and `git_status: false`, so it no
longer sees the project instruction files, the memory index or the git snapshot taken when the session began. Explore
has no shell tool, so it cannot ask git for the branch or the status either. Files in a subfolder that it reads still
bring their instruction file. A session that switches to such an agent is told once that the earlier instructions no
longer apply.

**Affects:** people whose Explore searches relied on conventions in `AGENTS.md` or on the branch name, and agents in `all`
mode that run as children, which now get the task-worker prompt.

**What to do:** Set `"agents": { "explore": { "context": { "instructions": true } } }` (or `"git_status": true`) in
`orbit.json` to bring either back. Setting one key leaves the other at the built-in value.

A folder that is not trusted cannot switch the instruction files off: `"instructions": false` in its `orbit.json` or
agent files is dropped, because it would hide your own instruction files and memory index from the agent, as the
withheld `instructions_exclude` does. `"instructions": true` is dropped too: a later document wins, so it would switch
the files back on over your own `false` (and over Explore's default). `"git_status": true` is dropped for the same reason,
and `"git_status": false` is kept. Trust the folder to use the switches.

A prompt of your own for an agent has its `${ORBIT_TOOL_GUIDANCE}` placeholder filled from the tools the model is
actually offered: on a PowerShell session the line reads PowerShell, and a model that loses Edit and Write gets no line
for them. Your own words around the placeholder stay as written. Workflow subagents also get the brief alone as their
first message.

### A trusted folder's config loads as it is, and nothing above the project is read

As the reference does, a folder you trust now loads its config as it is whenever Orbit reads it, and Orbit reads a
project's config only from the project itself. What changed:

- A trusted folder's config is no longer held back when it changes after the grant, and nothing asks about it again.
  The hooks, MCP servers, plugins, providers and other executable config that a `git pull`, a branch switch or an edit
  brings load as they stand; a plugin added to `.orbit/plugins` is loaded too. `orb run` and the other headless commands
  no longer stop with "changed since the folder was trusted", `orb trust` on a folder with a saved grant of its own says
  it is already trusted, and the terminal UI and VS Code no longer ask "Trust the changes?". This ends the re-ask that
  an earlier version added, which recorded a digest of each source's executable config at the grant and held back a
  kind that differed. A project that a grant for a folder above it covers now uses its own hooks as well; they used to
  read as changed since that grant.
- `orbit.json`, `orbit.local.json`, `.orbit` and other products' project folders are read from the folder Orbit starts
  in and its parents up to the project's root (the nearest folder with `.git` or `.hg`, or the start folder outside a
  repository), and never from a folder above it, even when you trust that folder and its grant covers the project. The
  walk starts from where the start folder really is, so a folder reached through a link is walked from its target.
  Instruction files keep their own walk up the folders, with one change: in a trusted project, a rule in a `.orbit/rules`
  folder above it is now read wherever its links lead, as the `AGENTS.md` beside it already was. It used to be kept
  inside the folder it sits in. Nothing above a project that is not trusted loads, as before.
- A project's custom themes in `.orbit/themes` wait for the folder to be trusted, as everything else it supplies does,
  and come only from the project's root down to the start folder. Your own themes load as before. Mini reads the same
  folders, and where its own walk would take a `.git` file that the server does not accept as a repository, it starts
  no higher than the folder the server decided trust for, as the terminal UI does.
- VS Code's banner for a folder that is not trusted says that nothing there loads, and no work starts there, until you
  trust it. It used to list what the folder held back, which was empty once nothing of the folder was read.
- `orb trust <folder> --for <location>` is gone, and so are the `holder` field of `POST /api/location/trust`,
  `Trust.Status.changed`, and the `directory` and `persistent` fields of `Trust.Withheld`. `Trust.Status.withheld` is
  always empty and goes in a later release. A client older than this version reads a status without `changed` as
  nothing changed; a server older than this version that still sends it is not asked about by a newer client.
- The records that earlier versions kept of what each grant approved (`trust-fingerprint/` in Orbit's key-value store)
  are left where they are and never read.

**Affects:** people with config in a folder that holds several repositories, anyone who relied on being asked about
changed config, and SDK hosts that read `changed` or send `holder`.

**What to do:** move config from a folder above your projects into each project, or into your own config (the global
config folder, or `.orbit` in your home folder). Look over what a pull brings into a folder you trust, or end the trust
with `orb trust --revoke`.

### Idle sessions are removed after 30 days (`cleanup_period_days`)

The Orbit server now removes a session, with its subagents, its forks and their saved tool results and scratchpads,
once none of them has changed for `cleanup_period_days` days (default 30). A session that is shared, has queued input
or was running when the server stopped is kept. The first pass runs 10 minutes after the server starts, later ones every
24 hours, and a pass waits while a session was active in the last minute. Sessions from before this version count their
idle time from the first start of this version, so nothing is removed until 30 days after the upgrade. `orb stats`
keeps counting removed sessions. `0` removes every session that can be removed at the next pass; sessions are still
saved while they are used. A value that is not a whole number of 0 or more, a config file with errors while the key is
set, a config file that does not parse, a config file that cannot be read, or an organization's remote config that cannot be fetched (for example while offline) skips the cleanup; this includes the managed settings files and a file the server reads again after it changes. A file that sets one value twice and keeps one of them has no error. A bare run
(`orb run --bare`, `orb -p --bare`) removes nothing. The flat `tool_*` files of earlier versions in the saved-results folder follow the same period instead of a
fixed 7 days. A pass removes the saved-result and scratchpad folders only of sessions removed from the same database
from this version on, so the folders of sessions removed earlier, and those of another channel's or `ORBIT_DB`'s
sessions, stay where they are; delete them by hand if you no longer need them.

**Affects:** everyone who keeps sessions for longer than 30 days without changing them.

**What to do:** set `cleanup_period_days` to a larger number in your own config to keep sessions longer.

## Clients

Changes to the terminal UI, the `orb` command line, the client libraries and SDK, and the VS Code extension.

### `orb doctor` prints a `sandbox` line, and the TUI says a stalled command waits for input

`orb doctor` now has a `sandbox` line. It asks the same code the shell runner uses, so it names the program a sandboxed
command would run through (`bwrap` on Linux and WSL2, `sandbox-exec` on macOS) and says when it is missing, when WSL1
cannot sandbox (convert the distribution to WSL2), or when the platform (Windows and others) has no OS sandbox. The line
turns red, with exit code 1, only when managed settings turn the sandbox on and it cannot work. The offline doctor reads
managed settings only, so with no managed `sandbox` setting the line is informational and says what would happen if the
sandbox were turned on. Every label and detail it prints is now written out through the same escaping as other untrusted
text, so a `PATH` folder, a model ID or a provider error cannot send control characters to the terminal.

In the TUI, the row for a background command that stopped at a prompt now reads `! Shell waiting for input · <command>`
in the informational colour, never as finished or failed. It still shows only the command, not the end of its output.

**Affects:** anyone who parses `orb doctor` output, and the TUI session view.

**What to do:** Nothing; a blank `sandbox` line is informational, and a new `!!` line appears only where managed settings enable the sandbox.

### The TUI no longer finds another product's IDE extension, and reads Zed only with compatibility on

The TUI used to look for the lock files that another agent product's IDE extension writes under the home directory, and
to read the port of that product's editor server from that product's environment variable. It connected to the editor
it found and showed the editor's selection and `@` mentions in the prompt. Orbit no longer reads those lock files or
that variable, and no longer sends that extension's authorization header. Until Orbit has an IDE bridge of its own, the
only way to connect the TUI to an editor's local WebSocket server is `ORBIT_EDITOR_SSE_PORT`.

Inside a Zed terminal the TUI still reads the selection of Zed's focused editor from Zed's own database, which
`ORBIT_ZED_DB` can point at, but now only while compatibility is enabled (see "One switch for reading other agent
products' files" above). With `compatibility.enabled` set to `false`, or `ORBIT_DISABLE_COMPAT` set in the TUI's or the
server's environment, Zed's database is not opened. The TUI asks the server whether compatibility is on, when it starts,
after it reconnects and whenever the configuration changes, through the new `GET /api/config/effective`
(`client.config.effective()`), which returns `{ compatibility: boolean }`. Until the server answers, or when it cannot,
as an older server cannot, Zed is not read.

**Affects:** TUI users who relied on an IDE extension of another agent product for selection context and `@` mentions,
who lose them until Orbit's IDE bridge ships, and people who turn compatibility off and use Zed.

**What to do:** set `ORBIT_EDITOR_SSE_PORT` to the editor's port if you still want that connection, or nothing if you do
not. Leave compatibility on if you want Zed's selection in the TUI.

### The TUI finds VS Code through Orbit's own bridge

The Orbit extension for VS Code now starts a bridge when the window opens (it needs a trusted workspace). The bridge
listens on `127.0.0.1` on a random port, writes a lock file with that port and a token into the `ide` folder of Orbit's
state folder (`~/.local/state/orbit/ide`, or under `XDG_STATE_HOME`), and sets `ORBIT_EDITOR_SSE_PORT` in the
terminals of the window. The terminal UI reads the lock, connects with the token in an `x-orbit-ide-token` header and shows
the file and selection you are working in. The new command **Orbit: Mention Selection in Terminal** puts an `@` reference
to the file, with the selected lines, into the prompt of a connected terminal UI. The setting `orbit.ideBridge.enabled`
(on by default, user settings only) turns the bridge off.

Two things stop working. `ORBIT_EDITOR_SSE_PORT` alone no longer connects the TUI to a WebSocket server: there must be a
lock under `ide` that names that port and holds a token, and the messages are Orbit's own (`hello`, `selection` and
`mention`), so a custom editor server that spoke the old JSON-RPC message names is not understood. Outside the terminal of
VS Code (no `ORBIT_EDITOR_SSE_PORT`, and `TERM_PROGRAM` not `vscode`) the TUI no longer looks for an editor on its own.
`Env.session()` also withholds every `ORBIT_EDITOR_*` variable from the managed server and from session shells.

**Affects:** TUI users who point `ORBIT_EDITOR_SSE_PORT` at their own editor server, and VS Code users, who get the
connection without setting anything.

**What to do:** use the Orbit extension for VS Code; set `orbit.ideBridge.enabled` to `false` if you do not want the
listener. An editor plugin of your own writes a version 1 lock to `ide/<port>.lock` and speaks the message set.

### The prompt editor is started without a shell

`$VISUAL` and `$EDITOR` for the prompt editor (the editor command of the prompt and Mini) are now found on `PATH` and started by the path
that was found, with no shell, as `/keybindings` already did. On Windows a program of the same name in the folder you work
in (`code.cmd`, `vim.bat`, `code.exe`) is no longer run in place of your editor. An editor value that relied on `cmd.exe`
no longer starts: a builtin such as `start /wait notepad`, `%VAR%` expansion, or a program found only in the current
folder. A value of exactly `code` or `subl` now gets `--wait`, so the prompt waits until the file is closed. A missing
editor is reported as "Cannot find the editor ... on PATH".

**Affects:** Windows users whose `VISUAL` or `EDITOR` is a shell builtin, uses `%VAR%`, or names a program that is not on
`PATH`.

**What to do:** give the full path of the editor, quoted if it has spaces, or put it on `PATH`.

### `orb -p` sends a message and prints the answer

`orb -p <message>` (or `--print`) runs one message the way `orb run` does and exits. The words after the flags are the
message, so `orb -p run the tests` sends "run the tests" and never starts `orb run`; the flag may come anywhere before
a literal `--`, except that when the first word is a subcommand `-p` must come before it: `orb debug this -p` goes to
the `debug` subcommand and `orb run -p` is still a `run` command line (a usage error). A word right after a flag that takes a value is that
flag's value, as in `orb -p --agent plan fix it`. Boolean flags never take the next word into the message, so `orb -p yes do it` sends
"yes do it" and `orb -p --thinking false positives` sends "false positives" with thinking on; write `--no-thinking` or
`--thinking=false` to turn a flag off. The flags that grant trust or approve every ask (`--trust`, `--auto`, `--yolo`,
`--dangerously-skip-permissions`) are stricter: a yes/no/true/false word right after one of them on a print line is a usage error
(exit 1, nothing starts), because `orb -p --trust false fix it` would otherwise send "false fix it" with the folder trusted
where `orb run --trust false` refuses it; write `--trust=false` or `--no-trust`. Only to find the subcommand does `orb` treat a yes/no/true/false word after a
boolean flag as its value, so `orb --standalone yes serve -p` is still a `serve` command line. `--output-format text` (the default) prints the answer, and `--output-format json` prints one JSON result
object. `--bare`, `--json-schema`, `--file`, `--title` and `--thinking` work as they do for `orb run`, and `orb run` now
takes the same flags from one shared definition. The flags that `orb` takes only with `-p` (`--output-format`,
`--bare`, `--json-schema`, `--file`, `--title`, `--thinking`) are an error on `orb` without `-p` (`--model` and `--agent` are not: see "Session flags on `orb`" below);
`orb run` takes the others too, and keeps its own `--format` in place of `--output-format`. `orb -p --help` lists every flag a printed run accepts,
including `--trust` and `--fork`.

Unlike `orb run`, `orb -p` stops in any untrusted folder, before anything is sent, also one whose project config holds
nothing back (a fresh clone with only an `AGENTS.md`), because the folder's instructions steer the model and the default
rules let its tool calls run without asking. It reports the refusal as a JSON result object under `--output-format json`
and exits 1, `--bare` included; `--trust` runs it once, and `orb trust` trusts the folder for good. Against a server
older than workspace trust, which cannot say whether the folder is trusted, it stops as well. `orb run` and `orb loop`
still go ahead in a folder that holds nothing back.

`orb run a -- b` used to send the operands after `--` twice ("a b b"). It now sends them once.

**Affects:** scripts that passed operands after `--` to `orb run` and relied on the repeat.

**What to do:** nothing for `-p`; to send a message that starts with a dash, put it after `--`.

### `orb -p` prints an init line, an enriched result and, on request, streamed fragments

`orb -p --output-format stream-json` prints one JSON line per event, beginning with an init line
`{"type":"init","protocol":1,"sessionID","cwd","agent","model","version"}` that is written before the message is sent
(`agent` is `null` until the session has chosen one), and ending with exactly one result line. A run that fails
before its prompt is sent (the trust refusal, a `--resume` that names no session, no message, a variant that does not exist, a title that cannot be set) prints only the
result line, with an empty `sessionID`. `--output-format json` prints only that result object. It also carries `subtype`
(`success`, `error`, `interrupted`, or `error_max_steps`, `error_max_tokens` or `error_max_cost` when a limit ended the
run) and `truncated`. Besides `sessionID`, `is_error`, `result`, `structured_output` and `error`, it now has
`outcome` (`succeeded`, `failed` or `interrupted`), `reason` when the run did not succeed (`error`, `invalid_output`,
`form_cancelled` (a form such as an MCP elicitation was cancelled), `incomplete`, `interrupted` for Ctrl-C, or the reason the runner stopped it,
such as `shutdown`, which is an `interrupted` outcome), `steps`, `duration_ms`,
`cost`, `tokens` and `rejected` (the requests that were rejected because nobody could approve them). The steps, cost and
tokens include failed steps and the steps of subagents the run started. `--include-partial-messages` (stream-json only)
adds `text_delta`, `reasoning_delta` (with `--thinking`) and `tool_input_delta` lines. `--verbose` (text format only; a usage error otherwise) implies `--thinking`,
prints what the tools returned and writes one usage line per step to stderr. With the text format, a run that
auto-rejected requests ends with one summary line on stderr; its exit code does not change.

`orb -p --json-schema` with the text format now prints only the parsed JSON answer (it used to print the result object,
which `--output-format json` still does); an answer that is not JSON is an error on stderr and exits 1. `orb run
--format` is hidden from `--help` and prints what it printed before, without the new fields or lines. The one visible
change is that its text output now writes out control characters in tool titles, descriptions, block bodies and the
failed line, so a line break in a title or description shows as `\n` and an escape as `\x1b`, while a block body keeps
its line breaks and tabs.

**Affects:** scripts that read the output of `orb -p --json-schema` as a result object.

**What to do:** add `--output-format json` to keep reading the result object; ignore the new fields otherwise.

### The sidebar's getting-started text no longer lists model families

The getting-started panel in the TUI sidebar used to end its second line with a list of three model families. It now says
only that you can connect from 75+ providers to use other models. When the panel shows and what it does are unchanged.

**Affects:** people who see the panel, which shows until a provider is connected or the panel is dismissed.

**What to do:** Nothing.

### The headless commands stop in an untrusted folder, and `orb trust` trusts one

`orb run`, `orb loop`, `orb flow run`, `orb flow resume` and `orb eval` now ask the server, before they do any work,
whether the folder they run in is trusted (see "A project's config waits for its folder to be trusted" above). That is
the folder they start in, or, for `orb run` and `orb loop` with `--session` naming a session that exists, the folder of
that session. When it is not trusted, and its project config holds something back, they print what is held back and how
to trust the folder, and exit with status 1. `orb run --format json`, `stream-json` or `result` reports it as the JSON
error that any failure before a session exists produces, instead of text, and does the same when the request itself
fails. They used to carry on without those settings, which for a script meant a run without the repository's hooks and
plugins and nothing to say so. A folder that holds nothing back runs as before, trusted or not, and so does one on a
server that trusts it without a grant (`--standalone` with `ORBIT_TRUST_PROJECT=1`), except that a workflow or suite
that is a TypeScript or JavaScript module, that defines shell commands, that names an agent, or, for a workflow, that
sets `permissions: auto`, needs a trusted folder either way (see "`orb flow` and `orb eval` need a trusted folder to run
a workflow or suite's code, commands, approvals or agents" under Clients), and so do `orb flow resume`,
`orb eval --resume` and `orb flow replay` (see "`orb flow resume`, `orb eval --resume` and `orb flow replay` need a
trusted folder" under Clients).
`orb flow` and `orb eval` import a workflow or suite module only after the check, because importing it runs its code.
`orb acp` cannot stop, because the editor chooses the folders, so it writes a warning to stderr about the folder it
started in.

Config in a folder above the project, such as an `orbit.json` in a folder that holds several repositories, follows the
decision for the folder that holds it, so trusting a repository does not apply it. The refusal lists those files apart
from the project's own and gives the command for their folder, `orb trust <folder>`, and `orb trust` says which files
it applied and which are still held back, with the folder to trust for each. Only a project that is not trusted is
refused, so a command that goes ahead in a trusted project whose config above it is still held back says so on stderr
(a line that starts with `Warning:`, which a script that reads JSON from stdout does not see) and runs without those
files.

- **`orb trust [folder]`** trusts the folder, or the current one, for good: the grant is stored, so it outlasts the
  server and is seen by every client of it. `--revoke` takes it back, and `--list` shows the folders that are trusted
  for good. Trust belongs to the project's root folder, so a subfolder, and the linked worktrees of a repository, share
  it. A home directory or a filesystem root is refused, because a grant for it would trust every folder below it; use
  the next flag, or the terminal UI, which offers to trust it until Orbit restarts. The server finds a grant through the
  project of its folder, so `--revoke` for a folder that has been deleted says so: create the folder again, revoke, and
  remove it.
- **`--trust`** on those five commands, and on `orb flow replay`, trusts the folder for that run alone. It starts a
  private server for the run, as `--standalone` does, and the grant lives only in that server, so it ends with the run
  and never reaches the background service. Because it is explicit it also works in a home directory. It cannot be
  combined with `--server`, because the grant would stay with a server that other runs share; use
  `orb trust --server <url>` there.

The grants are made through new routes: `GET /api/location/trust` (`client.location.trust.get`) reports whether a
location's project is trusted and what it holds back, `POST /api/location/trust` (`client.location.trust.update`) with
`{ trust, persist? }` trusts it or, with `trust: false`, ends every grant for it, and `GET /api/trust`
(`client.location.trust.list`) lists the grants that are stored. A grant is stored unless `persist` is false.

**Affects:** scripts and CI that call these commands in a clone whose `orbit.json`, `.mcp.json` or `.orbit` directory
holds something back (hooks, MCP servers, plugins, providers and the other kinds listed above), through the background
service, which is the default: they now exit with status 1. Commands run with `--standalone` or `--server` against a
server that trusts the folder are not affected. A background service that was not restarted after the upgrade does not
have the new routes: `orb trust` fails against it until it is restarted, while `orb run` and `orb loop` carry on without
the check and say so on stderr. So do `orb flow` and `orb eval`, unless they would import a module, run shell commands,
approve actions or run a node as an agent that a file names: they stop then, because that server cannot say whether the
folder is trusted (see "`orb flow` and `orb eval` need a trusted folder to run a workflow or suite's code, commands,
approvals or agents" under Clients). Code that implements the server API gains three routes.

**What to do:** run `orb trust` once in each repository you trust, or pass `--trust` to a single run, or set
`ORBIT_TRUST_PROJECT=1` and `--standalone` in CI. Restart the background service after upgrading (`orb service
restart`), so that it knows the new routes.

### The terminal UI asks whether to trust a folder

The terminal UI could not trust a folder, and it imported the `tui` entrypoint of every plugin in the project's
`.orbit/plugins` whether or not the folder was trusted. It now asks the server about the folder it started in, and
about the folder of the session in view, when it starts, whenever the location, the configuration or a grant changes,
and after it reconnects.

- **The question:** when the folder in view, on Home or in a session, is untrusted and holds something of its own back,
  a dialog lists the files and directories that hold it, by path from the folder, with what each holds, and offers
  "Trust this folder" or "Not now". Enter on its own is "Not now", so a key typed ahead of the dialog never trusts a
  folder, and closing the dialog with Esc counts as "Not now". (Since trust-first the question about the folder the
  terminal UI starts in offers Exit, starts on "Trust this folder", and comes while the prompt takes no keys; see
  "Nothing in a folder loads or runs until you trust it".) Either one keeps it from opening by itself again for that
  folder until the terminal UI restarts. A dialog is about one folder: if another comes into view while it is open,
  such as when a session in another clone opens, it closes without counting as "Not now", and the terminal UI asks
  about the folder now in view once it has the answer for it. A home directory or a filesystem root is offered "Trust
  until Orbit restarts" instead, which on the background service lasts until the service restarts; `orb trust --revoke`
  ends it sooner.
- **Config above the folder:** a file or directory in a folder above the project follows the decision for the folder
  that holds it, so trusting the project does not turn it on. The dialog lists it after the folder's own files, and
  says which folder to trust for it, as the command `orb trust <folder>`. When a grant leaves such config off, the
  confirmation says so and names the same folder.
- **The reminder:** an "Untrusted" indicator in the prompt's footer, and the `/trust` command ("Trust this folder"),
  open the dialog again. Both show only while the folder is untrusted and holds something of its own back, so a
  repository with no project config of its own never shows them, and neither does one whose only held-back config is
  above it, because trusting it would turn nothing on.
- **Plugins:** the plugins in a project's `.orbit/plugins` are imported only while the folder is trusted, and are
  dropped when the trust is taken away. The question for them is about the folder they are found from, which is the one
  the terminal UI was started in, whatever folder the server calls its default. The terminal UI finds its project's
  root without asking the server, so when that is a folder above the server's project, as when git cannot open the
  repository or the terminal UI was started through a link, it can find the plugins of a folder around the project.
  Those follow the decision for the folder that holds them, as the rest of its config does: they stay off while the
  server lists that folder's config as held back, and load once the folder is trusted. The terminal UI imports no
  plugin until the first answer has come, so the start takes one request longer, and waits at most two seconds for it.
  A server that cannot answer in that time, such as one older than workspace trust, counts as not trusting the folder,
  so the project's plugins stay off and the terminal UI starts as usual; the next change, or a reconnect, asks again.
  The plugins in your own config directory, in `.orbit` in your home directory and in the `plugins` of your terminal UI
  settings load either way.
- **`orb mini`:** it prints one line before the session starts when its folder is untrusted and holds something of its
  own back, which points to `orb trust`. Config in a folder above the project is named in the same line, with the
  `orb trust <folder>` command for the folder that holds it, whether or not the project is trusted, as `orb run` says
  on stderr.

**Affects:** people who start the terminal UI in a clone that has plugins in `.orbit/plugins`, which stop loading until
the folder is trusted, and everyone who now sees the dialog. Code that calls `localPluginDirectories` from
`@orbit/tui/plugin/discovery` passes the global config and home directories instead of the config directory, and gets
`{ global, project }` back instead of one list.

**What to do:** choose "Trust this folder" for each repository you trust, or run `orb trust` in it. In a home directory
choose "Trust until Orbit restarts", or pass `--trust` to a headless command. For config in a folder above a repository,
run `orb trust <folder>` for the folder that holds it.

### `orb flow` and `orb eval` need a trusted folder to run a workflow or suite's code, commands, approvals or agents

A workflow or eval suite can act on what the folder brings in four ways. One written in TypeScript or JavaScript is
loaded by importing it, which runs the code at the top of the file. A YAML workflow or a YAML or JSON suite can define
shell commands: a `check` node, a `verify` node's `checks`, and a suite task's `checks`. A run executes those through
the platform shell, in the CLI process, and no permission rule is asked about them. A YAML workflow can set
`permissions: auto` on an agent or verify node, or on a member of a team, which makes the run approve, once, every
action that the node's agents ask permission for. A run rejects those by default, so a node that is set to `auto`
answers the `ask` rules of the user's own config with a yes, as `--auto` does when the user passes it, while the file
writes the node's prompt.

And a YAML workflow or a YAML or JSON suite can name the agent that runs a node: the `agent` of an agent or verify node,
of a team member and of a `judge`, which in a suite is the `judge` of a task. That picks one of the user's agents, and an
agent's own rules are added after the user's global rules, with the last match winning. A user who gave one agent wider
rules than the rest, say `edit: allow` on one agent where the global rules say `ask`, therefore has a file that names
it get those actions done without a question, and the run's rejection of them never comes into play. With the default
rules every agent allows the same and nothing changes.

`orb flow run`, `orb flow resume` and `orb eval` stopped for an untrusted folder only when its project config held
something back (see "The headless commands stop in an untrusted folder, and `orb trust` trusts one" above), so a fresh
clone that brought nothing but a `workflow.ts`, a `workflow.yaml` with a check node, with `permissions: auto` or with
an `agent`, or a `suite.json` with checks or with a `judge` that names an agent, ran its own code, commands, approvals
or choice of agents without ever being trusted. For `orb flow resume`, the file is the one that the repository's own
run store names.

They now stop for an untrusted folder, whether or not it holds anything back, when the file is a module, when the YAML
or JSON file defines any such command, when the YAML workflow sets a node's `permissions` to `auto`, or when the file
names an agent. A `permissions` that is a template, such as `{{plan.text}}`, counts as well, because it is filled in
when the node starts and the reply of an agent can say `auto`; any other value is a rejection to the runner and does
not count. An `agent` that is a template counts for the same reason. A suite cannot set `permissions`, and a suite
task's own `agent` chooses nothing, because `orb eval` runs each task as a verify node and passes on only the task's
`judge`. `--auto`, which is the user's own flag, is not held up.

The command stops before it imports or runs anything. It says that it runs code, shell commands, approvals or agents
from the folder, names the file, lists the commands it found by node or task, the nodes that approve with their
`permissions` as written, and the nodes that name an agent with it as written (a team member as `team/member`, a
`judge` as `node/judge` or, in a suite, `task/judge`), and gives `orb trust` and `--trust` as the ways to go on, as for
held-back config. A workflow or suite that defines none of these, such as one whose `checks` are empty and that names
no agent, is only read, so it keeps the check it had: an untrusted folder stops it when the folder's config holds
something back, and not otherwise.

`orb flow replay` loads the same files, from the run store or with `--file`, and used to check nothing, because a replay
calls no model and connects to no server. It now makes the check for a module. To ask, it connects to a server, which
for the background service starts it when it is not running, and it takes `--standalone`, `--server` and `--trust` as
the other `orb flow` commands do. A replay answers every node from the recording, runs no command, asks no model and
opens no session, so a YAML workflow is not stopped for the commands, approvals or agents it defines. A replay of one
still connects to a server, because it reads the run store, which needs the folder trusted (see "`orb flow resume`,
`orb eval --resume` and `orb flow replay` need a trusted folder" below).

These commands ask the background service as it is, without replacing one that is older than the client, so a service
that was started before an upgrade and not restarted can lack the trust routes. They used to go ahead with a warning on
stderr when the server answered that it had none, because such a server applies a folder's config without asking. They
still do where only the config that is held back is at stake, as `orb run` and `orb loop` do. But when they would import
a module, run shell commands, approve actions or run a node as an agent that a file names, which this process does
itself, they now stop: the text says that the server is older than workspace trust and cannot say whether the folder is
trusted, names the file and what it brings, and gives `orb service restart`, `--standalone` and `--trust` as the ways to
get an answer. The last two start a current private server for the run, and `--trust` also trusts the folder for it.

**Affects:** scripts and CI that run `orb flow run`, `orb flow resume`, `orb flow replay` or `orb eval` on a TypeScript
or JavaScript file, or `orb flow run`, `orb flow resume` or `orb eval` on a YAML workflow that sets `permissions: auto`,
on a YAML workflow or a YAML or JSON suite that defines shell commands, or on one that names an agent, in a folder that
is not trusted, through the background service, which is the default: they now exit with status 1 even where the folder
holds no project config.
That is nearly every eval, because nearly every suite has checks. The same commands against a server that is older than
workspace trust, such as a background service that was not restarted after the upgrade, now exit with status 1 whether
or not the folder is trusted. A replay now connects to a server, and starts the background service if that is the
server it uses and it is not running. Commands run with `--standalone` and `ORBIT_TRUST_PROJECT=1`, or against a server
that trusts the folder, are not affected.

**What to do:** run `orb trust` once in each repository you trust, or pass `--trust` to a single run, or set
`ORBIT_TRUST_PROJECT=1` and `--standalone` in CI. Restart the background service after upgrading (`orb service
restart`). Look over a workflow or suite that you did not write, and the commands, nodes and agents that the refusal
lists, before you trust the folder that holds it, because trusting the folder lets it run.

### `orb flow resume`, `orb eval --resume` and `orb flow replay` need a trusted folder

The run store, `.orbit/runs.db`, is a file in the repository, so a clone can ship one with any run in it, and a
resumed run goes on from what the store records for it: the worktree that a verify node's reviewer and checks work in,
the session that a team member continues, and the base commit of the review diff. A store in an untrusted clone could
point a reviewer at any folder on the computer, `C:\` or `/` included, and the reviewer could read a file there and send
it to your model provider.

`orb flow resume`, `orb eval --resume` and `orb flow replay` now stop in a folder that is not trusted, whatever the
folder holds back and whatever the workflow or suite defines, before they open the run store. They say that the folder
is not trusted and that the command goes on from a run that the folder's run store records, give `orb trust` and
`--trust` as the ways to go on, and exit with status 1. `orb eval --resume --format json` prints the refusal on stdout
as the JSON error that `orb run --format json` prints. A server that cannot say whether the folder is trusted, because
it is older than workspace trust, stops them as well. To ask, `orb flow replay` now always connects to a server, for a
YAML workflow too, and one it cannot reach stops it. `orb flow run` and `orb eval` without `--resume` are not affected.
The flow runner, for a caller that resumes in such a folder anyway, takes no worktree, no session ID and no base commit
from the store: the checks and the reviewer of a reused verify iteration work in the folder of the run, no review diff
runs git in a folder the store names, and a team member whose turn is reused opens a new session for its next one.
(`packages/cli/test/trust.test.ts`: the rows for a run store that the clone ships, each with a `--trust` control, the
rows that refuse before the store is opened, and the rows for a server older than workspace trust;
`packages/flow/test/runner-resume-untrusted.test.ts`, which has a row for the review diff.)

**Affects:** scripts and CI that resume or replay a run in a folder that is not trusted, including a run they started
there themselves: they now exit with status 1.

**What to do:** trust the folder with `orb trust`, or pass `--trust` to the one command, or set
`ORBIT_TRUST_PROJECT=1` and `--standalone` in CI.

### `orb flow` treats the run store of a repository as untrusted text

The run store is `.orbit/runs.db`, a file in the repository, so a clone can bring one of its own. `orb flow clean` took
the ID of every finished run in it and removed `.orbit/worktrees/<run>` and the branches under `orbit/<run>/`, and
resumed runs made their worktrees the same way, so a row whose ID was a path, such as `../../../x` or `../..`, led them
out of the repository: a clone could have the command delete a folder beside the repository or the repository itself,
without being trusted. `orb flow ls`, `show`, `watch`, `cost` and `trace` also printed the names, messages and files
that the store holds as they were, so an escape sequence in a workflow's name could set the title of the terminal or
erase the lines above it.

The store now lists and returns only runs whose ID has the shape that Orbit makes, `run_` and 14 digits of timestamp,
`_` and 6 hexadecimal digits, and ignores any other row. `orb flow clean` and the worktrees of a run refuse an ID that is
not one plain name, and a node named `.` or `..`. The five commands print what the store says through the same
escaping as the trust refusal: control characters and format characters, such as a right-to-left override, are written
out as `\x1b` or `\u{202e}`, and a line break as `\n`. The `/runs` dialog of the terminal UI shows what the store says
in the same way, because the terminal UI writes text to the terminal as it is. In `--format json` and `--format otlp`
every character stays, but `JSON.stringify` writes only U+0000 to U+001F as escapes and leaves DEL, the C1 controls
(U+009B and U+009D start escape sequences on a terminal that takes 8-bit controls) and format characters as they are, so
the commands write those as `\u009b` or `\u202e` too, which `JSON.parse` turns back into the same text.

A workflow or a suite is a file in the repository too, and `orb flow run`, `resume`, `replay` and `orb eval` printed
what it says as it was: the node and task IDs in the progress on standard error, the gate that a run waits at, the
failure of an eval or a replay and the task table of an eval, and, on standard output, the JSON of the result of a run
or an eval, which is keyed by node ID. A JSON or YAML file that defines no command, approval or agent needs no trust, so
a suite whose task ID held an escape sequence could set the title of the terminal or erase lines of a person who ran it
in a folder that is not trusted. These commands now write it out in the same way.

The failure of a command can name such text as well: an invalid workflow lists its node IDs and types, and a run that
is resumed or replayed loads the file that its row in the run store names. These fail before any trust check, so a
clone only had to ship an invalid workflow. Every error that `orb` prints now has its control and format characters
written out, and keeps the line breaks of the message and its stack. The title of a session that a workflow opens is
`<workflow name> · <node>`, and it stays in your session database. The message of the commit that records the work of a
node, `orbit <run>: <node>`, stays in your repository, where `git log` prints it as it is. The runner writes out the
control characters of both. `orb session list` also writes out a title that holds any (a model can make one). The
terminal UI and Mini leave them out of the title of the window, and the summary that the terminal UI prints when you
leave writes them out, while the one of Mini leaves them out.

**Affects:** a repository whose `.orbit/runs.db` holds a run with another ID: it no longer shows up in `orb flow ls`, the
terminal UI or the VS Code Runs view, and `orb flow show`, `resume` and `clean` report that there is no such run. Orbit's
own runs have always had an ID of this shape, so nothing that Orbit made is affected. Scripts that parse the text output
of `orb flow` and `orb eval`, the progress they print on standard error or the error text of an `orb` command, see a
control character in a name as an escape. So does a line that a workflow passes to `ctx.log` with one in it, such as a
colour, and a message that spans lines, such as a failure that git reports, is written on one line with `\n` where it
breaks (an error keeps its lines). Scripts that parse JSON see the same values, as only the spelling of the characters
above changes. A session or a commit that an earlier release made for a workflow keeps the title or message it was given.

**What to do:** nothing.

### The `orb` binary no longer reads the `tsconfig.json` of the folder it starts in

The single-file `orb` was built to load the `tsconfig.json` of the folder it runs in, and Bun applied its `paths` to the
module resolution of the binary itself. A repository that was not trusted yet could commit a `tsconfig.json` whose
`paths` map every import to a file of its own, and that file ran when the binary started in the repository's folder,
before any trust check: `orb trust --standalone --list` did it, in the server process that it starts there, and so would
any other `orb` process that starts in the folder. The binary now loads no `tsconfig.json`, so no `paths` apply in any
folder. It still loads no `bunfig.toml` and no `.env`, as before, and it still reads `package.json` files, which it
needs to find the entry of a package that names it with `main` or `exports`.

Imports by a relative path and from `node_modules` resolve as before, and so do the `imports` entries (`#name`) of a
`package.json`. A module that the binary imports from your project, such as a workflow or suite file, and that imports
through a `paths` alias of the project's `tsconfig.json`, no longer resolves and fails with `Cannot find package`.
Running Orbit from its source is not affected.

**Affects:** people who run `orb` from a release build on a workflow or suite module, or another module that the binary
imports from their project, that imports through a `paths` alias.

**What to do:** import those files by a relative path. Nothing for anyone else.

### `orb flow` and `orb eval` ask about the folder that holds the file as well

`orb flow run`, `orb flow resume`, `orb flow replay` and `orb eval` asked whether the folder they run in is trusted,
and that was the whole check, even when the workflow or suite lay in another folder. Run from a trusted folder,
`orb flow run ../examples/evil.ts`, `orb flow replay <run> --file <path>` and `orb eval <path>` imported the module, ran
the shell commands, approved the actions and ran the nodes as the agents of a file from a folder that no one had
trusted, such as a clone beside the repository, a download or a submodule. So did `orb flow resume` for a run whose row
in the run store names such a file.

They now ask about the folder that holds the file as well, after the folder they run in, when the file brings what needs
trust: a TypeScript or JavaScript module, or a YAML or JSON file that defines shell commands, approvals or agents, as
described in "`orb flow` and `orb eval` need a trusted folder to run a workflow or suite's code, commands, approvals or
agents" above. A replay is asked only for a module, as before. The question is the one asked for any folder: it is about
the project that holds the file, so the folders of one git repository and its linked worktrees share a decision, and a
workflow in a folder of the repository you run in needs nothing new, while a folder outside a git repository is a
project of its own, as are the folders inside it. The config of that project is not part of it, because the run applies
none of it: the file is all the run takes from it. The refusal names the folder, lists what the file brings as it does
for the folder you run in, and gives `orb trust <folder>` for it, because a plain `orb trust` would trust the folder you
ran in. `--trust` trusts both folders for the run alone. A home directory or a filesystem root is never trusted for
good, so a file that sits in one needs `--trust` on every run.

**Affects:** scripts and CI that run a workflow or suite file from a folder other than the project they run in, such as
`orb flow run ~/flows/review.ts` or `orb eval ../evals/suite.json`, when the file is a module or defines commands,
approvals or agents: they now exit with status 1 until that project is trusted. That includes a file kept directly in a
home directory, even with `--standalone` and `ORBIT_TRUST_PROJECT=1`, which never trust a home directory. Runs of a file
in the project they run in, and of a file that only defines nodes that use your own agents and rules, are not affected.

**What to do:** look the file over, then run `orb trust <folder>` once for the folder that holds the files you rely on,
or pass `--trust` to a single run, or keep the files in the repository you run in. Move files out of a home directory.

### The `orb` binary does not look for a provider package in the folder it starts in

A provider's `package` names the code that talks to its API. For a name that Orbit does not include, the single-file
`orb` first looked it up in the `node_modules` of the folder it started in, and installed it from npm into Orbit's own
cache only when it was not there. A name under `@orbit/ai/` that Orbit does not include was imported from that folder
too. That folder can be a repository that is not trusted yet, so when your own config named such a package, a
`node_modules/<package>/index.js` committed there ran in the server process that `orb` starts in the folder, which is
the case with `--standalone`, with `--bare` and with the background service off. The binary now installs such a package
from npm and loads it from Orbit's cache, whatever folder it starts in, as it already did for `aisdk:` packages, and
never looks for one in the folder. A name under `@orbit/ai/` that Orbit does not include fails with "is not built in".
A plain file path, which an earlier build loaded too, no longer loads: write it as a `file://` URL. The providers that
Orbit includes and `file://` URLs load as before, and so does running Orbit from its source.

**Affects:** people who run `orb` from a release build with a provider `package` that is a bare npm name that they keep
in the `node_modules` of their project, or that is a plain file path: Orbit now installs the first from npm, which needs
the registry, and loads the latest version, and no longer loads the second.

**What to do:** nothing for the providers that Orbit includes. To use a copy that you keep yourself, point `package` at
its entry file with a `file://` URL.

### The `orb` binary does not look for what its dependencies ask for in the folder it starts in

The single-file `orb` carries its dependencies, but three of them looked up a name while they ran, in a way that the
bundler cannot follow, and Bun resolves such a name from the folder the binary starts in. That folder can be a
repository that is not trusted yet. js-yaml, which reads the front matter of every Markdown file, looked for `esprima`
for its `!!js/function` type as soon as it loaded, so a `node_modules/esprima/index.js` committed to a repository ran
when `orb` started there, before any trust check: `orb trust --standalone --list` did it, in the server process that it
starts in the folder, and so did `orb models`, `orb run` and the other commands that start one. Babel, which transforms
the source of a terminal UI plugin, handed the browserslist config of the folder to browserslist, so a `package.json`
with `"browserslist": ["extends browserslist-config-x"]` ran `node_modules/browserslist-config-x` when the terminal UI
loaded a plugin source file. On Windows, where fff is off unless `ORBIT_DISABLE_FFF=0` turns it on, the file finder
looked for its native library in an npm package before it used the embedded one, and found
`node_modules/@ff-labs/fff-bin-win32-x64` of the folder, so a library committed there was loaded as native code. The
build now replaces the `!!js/function` type with one that matches nothing, Babel's lookup with its browser build, which
reads no config, and the lookup of fff with one that finds nothing, so the embedded library is the one that loads. A
build that cannot do any of these fails. Nothing that worked changes: front matter is read with the safe YAML schema,
which never had that type, nothing that Orbit transforms reads browserslist targets, and the library of fff is always
embedded.

**Affects:** nobody who works in a folder of their own. A repository that commits those files no longer gets them run.

**What to do:** nothing.

### On Windows, `orb` finds git, ripgrep and its other programs on PATH and never in the folder it starts in

`orb` looks for git, ripgrep, the shell that runs its commands, the formatters and a few other programs by name down
PATH. On Windows the library that did it searched the current folder before PATH, as `cmd.exe` does, and that folder
can be a repository that is not trusted yet. A `git.exe` committed to it ran as native code whenever Orbit used git
there, `orb session list --standalone` among them, and an `rg.exe` ran when the file search of a server that started in
the folder looked for files, before any trust check. The lookup now reads PATH and Orbit's own `bin` folder and nothing
else, so what a repository commits is never a candidate. On every platform a PATH entry that is empty, which a shell
reads as the current folder, is skipped as well. When the program is on PATH the result is the same file as before.

**Affects:** Windows users who keep git, ripgrep or another of these programs in the project folder and not on PATH:
Orbit no longer finds it there. A repository that commits such a file no longer has it run.

**What to do:** nothing when the program is on PATH. Otherwise put it on PATH. For ripgrep, copying `rg.exe` to Orbit's
`bin` folder works as well.

### On Windows, `orb` starts a program it only has a name for without looking in the folder first

Orbit starts some programs by name and not by path: Mercurial's `hg`, `git` when it is not on PATH, `node` or `uvx` for an
MCP server, a language server, your editor, the pager of `orb session list`, which is `cmd /c more`, and the command of a
status line, for example. On Windows such a name is looked for in the working folder before PATH, by Bun and Node as well
as by `cmd.exe`, and that folder can be a repository that is not trusted yet. A folder with a `.hg` directory and an
`hg.exe` or an `hg.bat` ran that file while Orbit identified the project, before any trust check, and a `cmd.exe` in the
folder ran as the pager.

Every Orbit process now sets `NoDefaultCurrentDirectoryInExePath` in its own environment before it starts anything:
`orb`, the launcher that npm installs as `orb`, a server that is started without `orb`, and the SDK's embedded host.
Orbit's own process spawner sets it before every program it starts as well. The lookup of a program reads the variable
from the process that starts it, not from the program, so it has to be set there. The program gets the variable too, so
a `cmd.exe` that it is or runs skips the working folder as well. The launcher that npm installs asked PowerShell by name
which processor features it has, so a `powershell.exe` in the folder ran when `orb` was typed there. Orbit also stops a
process with the `taskkill.exe` of the Windows folder. It used to run `taskkill` by name through `cmd.exe`, so a
`taskkill.exe` in the folder it started in ran instead. A path to a program is used as written, as before.

**Affects:** Windows users whose project starts a program by a bare name that exists only in the working folder, such as
an MCP server whose `command` is `server.exe` or `server.bat`: it is no longer found there. The same goes for what runs
through `cmd.exe` in the working folder, such as a project's start command, a workflow `command` node or a status line
command: `build.cmd` no longer finds a file of the folder. Everything Orbit starts inherits the variable. An application
that embeds the SDK has it set in its own process once it creates the host, so its own programs that it starts by name
skip the working folder too.

**What to do:** nothing for programs on PATH. For one that you keep in the folder, write `.\server.bat` or its full
path.

### `orb run` holds a failed step back until the run is over, and joins text that the output limit cut

A run can get past a step that fails: it continues after a stream that ended early, or switches to a fallback model, and
starts another step. `orb run` used to print the error of a failed step, and set exit status 1, as soon as it saw the
step fail, so a run that went on to answer still ended in an error. It now holds the failure back, and the next step to
start drops it. When the execution fails, its error is printed in its place, once. A failure that is still held when the
execution succeeds or is interrupted by someone else, or when the event stream ends, is printed then, with exit status 1.
When `orb run` reads the stored messages at the end of a run, only the error of the last assistant message counts, so a
failure that a later step followed is not reported. `--format json` and `stream-json` print no `error` line for a
failure that was recovered.

A step can stop at the output limit, which its `step_finish` line reports as reason `length`, and the next step can carry
on in the middle of a word. In the default format, and with `--format result` (and so with `--json-schema`), the text of
the next step is now joined as it is to the text that was cut, before it is written or parsed, so a word or a JSON
string that the limit cut in two is whole again and the text is one line. It is joined only when nothing else was
written between the two: no tool call, and no thinking line, which `--thinking` shows. A step that failed after some of
its text is not joined to the step that continues it. `--format json` and `stream-json` still print one `text` line for
each part: a program joins the parts of a message whose `step_finish` has reason `length` to the parts of the message
that follows it.

A session can hold an `output-escalation` notice: a hidden `session.synthetic` message whose metadata has
`notice: "output-escalation"` and `replaces`, the ID of the assistant message that the notice replaces. `orb run` leaves
the replaced message out of the answer, of what `--json-schema` parses and of the notes it prints. With `--format json`
and `stream-json` it prints one line for the notice, `{"type":"notice","timestamp":…,"sessionID":"…","notice":
"output-escalation","replaces":"msg_…"}`, and a program drops the parts whose `messageID` is the `replaces` value. A
notice that does not name a message replaces nothing.

A tool call that the model began and the output limit cut off (error type `tool.input-truncated`) prints one dim line on
stderr, `Tool call cut off by the output limit: <tool>`, in place of the error lines. `--format json` and `stream-json`
still print the `tool_use` line with the error.

Every line of JSON that `orb run` prints (the events of `json` and `stream-json`, the `result` object, and the error
object that it prints for a failure that is not one of the session's events) now writes DEL, the C1 controls, format
characters such as a right-to-left override, and U+2028 and U+2029 as `\uXXXX`, and `JSON.parse` returns the same text.
The error lines on stderr, the label of a step, the request for permission and the note about a cut-off tool call write
control characters out as text, such as `\x1b`, as `orb flow` does. The answer and the thinking lines in the default
format, and the tool blocks that `orb run` draws, are still written as the model and the tools made them.

**Affects:** scripts and CI that read the exit status or the `error` lines of `orb run`: a run that recovered now exits 0
and prints no error. Programs that read `--format json` or `stream-json`: there is a new `notice` line, and control
characters in text arrive as escapes, which parse back to the same text. People who read a long answer in the terminal:
text that the output limit cut is one line.

**What to do:** nothing for most setups. A program that reads `json` or `stream-json` joins the parts of steps whose
`step_finish` has reason `length`, and drops the parts of the message that a `notice` line replaces.

### A failed tool call has an error type that names what went wrong

A tool call that failed used to be reported with the error type `tool.execution` whatever the reason, so a client could
only tell failures apart by reading the message. These now have a type of their own:

- `tool.input-invalid`: the input does not match the tool's schema.
- `tool.unknown`: the model named a tool that does not exist. The same type was already used when the provider reported
  an unknown tool.
- `tool.unavailable`: the tool exists but was not offered for the request.
- `tool.disabled`: tools are switched off for the rest of the run, after the maximum agent steps.
- `tool.validation`: the tool refused the call before running it, without naming a reason of its own.
- `file.unread` and `file.stale`: `edit`, `write`, `patch` and `notebook_edit` refuse a file that the session has not
  read, or that changed since it did.
- `file.not-found`, `file.is-directory`, `edit.no-change`, `edit.empty-old-string`, `edit.no-match` and
  `edit.ambiguous`: the `edit` tool's other refusals.

The messages are the same as before. `tool.cancelled` is also reserved for a call that is ended before it finishes;
nothing reports it yet. Every other failure, and a failure of a plugin tool that names no code, is still
`tool.execution`. The type is the `error.type` of a `session.tool.failed` event and of the error state of a tool part in
a message.

**Affects:** code that reads a failed tool call's `error.type` from those events or messages, such as an SDK client or a
plugin that matches on `tool.execution`, and dashboards that count failures by type. Anything that only shows the
message is not affected.

**What to do:** Nothing for code that does not read the type. If you match on `tool.execution`, also match the types
above, or match the type of the failure you care about.

### Messages say how they were delivered, and a prompt can carry turn options

A `user` message and a `synthetic` message now carry a `delivery` field, `steer` or `queue`: the delivery that the input
left the inbox with. A queued input waits until the previous work ended and then starts a new turn, while a steer joins
the turn in progress, so the field tells where a turn begins. A message that Orbit records directly, such as a note
from the agent loop, has no `delivery` and never starts a turn, and neither does a message stored before this change,
which counts as a steer. The `session.prompt` request also takes a `turn` object, with `maxSteps`, `maxCost` (in US
dollars), `maxTokens` and `fallbackModel`, all optional. A step or token count that is not a whole number above zero, a
cost that is not above zero, a `fallbackModel` that is not a model reference, or a key that `turn` does not define
(`max_steps`, say, or a misspelled `maxCost`) is refused with a 400, because a dropped key would leave the prompt with
fewer limits than it asked for. Orbit stores the options with the prompt and returns them as `turn` on the `user`
message, and the latest options in a turn are the ones that apply to it. Orbit acts on them: a limit ends the
turn (see the note on enforced limits), and the fallback model is used after repeated overloads (see the note on the
fallback switch).

A turn is closed only by an idle mark, or by a queued input that starts the next one, and Orbit records nothing where it
cuts a history short. So a steer joins the last turn in front of it, with that turn's options, fallback model and
notices, whenever the history in front of it does not end in an idle mark. That is so for:

- the first prompt after a fork that stops before an idle mark, such as a fork before a queued prompt;
- the first prompt after a revert, which removes the idle mark that followed the history it keeps, such as a revert to a
  queued prompt;
- the first prompt after an import of a session that was exported in the middle of a turn;
- the first prompt to a subagent's session that a crash cut off, or that a shutdown interrupted without recording an idle
  mark. The next start resumes only top-level sessions and background subagents, and it forgets that any other session
  was in the middle of work, again without an idle mark. The prompt can come from a client or from the parent agent
  continuing the subagent with its `sessionID`;
- a steer that arrives after the agent loop has finished its last response but before the idle mark;
- a steer that arrives while a manual compaction (sent with either delivery, and the TUI's `/compact` sends none), a
  move or a location reload runs after the turn's last response. It holds the idle mark back until it ends, and the
  steer is promoted in the same run.

A prompt sent with `queue` delivery starts a new turn in each of these cases.

**Affects:** programs that read messages through the HTTP API, the client libraries or an exported session, and code
that checks them against the old shape: `user` messages gain optional `turn` and `delivery`, `synthetic` messages gain
optional `delivery`, and the `session.inbox.enqueued` event carries `turn` on a prompt that had it. The generated client
types add `SessionTurnOptions` and the new fields.

**What to do:** nothing. Every new field is optional, and a prompt without `turn` behaves as before. A client that sets
`turn` and wants the first prompt after a fork, a revert, an import or a cut-off subagent session to start a new turn
sends it with `delivery: "queue"`.

### Keys can be set in `keybindings.json`, per place, and as two-step chords

The terminal UI and `orb mini` now read an optional `keybindings.json` from the folder that holds `cli.json`. It takes
comments and trailing commas and has three settings: `leader`, `bindings` and `contexts`.

- `bindings` gives a command other keys wherever it is bound, and `null` takes its keys away. `contexts` does the same in
  one place only: `global`, `prompt`, `session`, `permission`, `composer`, `dialog`, `session-list`, `diff`, `which-key`
  (which has no commands yet) or `mini`. So `dialog.session.rename` can have one key in the session list while `session.rename`
  has another in a session. A command's keys come from its context first, then `bindings`, then `keybinds` in `cli.json`, then the
  defaults. `keybinds` in `cli.json` works as before.
- A key can be a chord, two or more strokes separated by a space, such as `ctrl+k ctrl+s`. `<leader>` sequences, lists
  separated by commas and `enter` or `esc` work beside it, and Escape cancels a chord that is waiting for its next stroke.
  A chord takes its first key from every other binding of that key: while `ctrl+k ctrl+s` exists, `ctrl+k` waits for a
  second stroke everywhere, and no longer deletes to the end of the line in the prompt.
- Orbit leaves out an entry that names no command, no place or no key it can read, says so in one toast, and applies the
  rest. It also warns when two entries of one place use the same keys, or when one starts the other. It never compares
  the file with its own default keys. A file that cannot be parsed is ignored whole, with one note, and the settings in
  `cli.json` are not touched. In the terminal UI, saving the file applies it at once, including the leader key and the
  editing keys of the prompt, which were read only once at start-up before. `orb mini` reads the file when it starts and
  prints what it left out to the terminal before the footer takes the screen.
- `/keybindings`, or "Edit keybindings" in the command palette of the terminal UI, writes a template that lists every
  place with its commands, all commented out, where there is no file, and opens the file in `$VISUAL` or `$EDITOR`. With
  neither set it opens the file with the program your system uses for that kind of file, and when that fails it shows
  the path. Orbit looks for the editor on PATH only and starts it from the folder of the file, so a program of the same
  name in the project folder is never the one that runs.
- A plugin's keymap layer can name its place with the new `context` field of `KeymapLayer`. A layer that names none, or
  one that is not in the list above, gets only the keys set in `bindings`.

**Affects:** anyone who wants other keys, and plugin authors. Nothing changes until the file exists, except that a change
to `leader` or to an `input.*` key in `cli.json` now also applies while the terminal UI runs. `cli.json` also accepts
`keybindings.open`, the command behind `/keybindings`, which has no key by default.

**What to do:** nothing. Run `/keybindings` to start from the template.

### VS Code hides recovered step failures and shows loop notices

The VS Code chat used to show an error note the moment a step failed, even when the next step went on to finish the
run. It now holds the failure back: a later step of the same run drops it. It shows when the run ends, or when the
run is stopped for a reason other than a Stop. A Stop from any client drops the failure of the step it cut short (`orb run`
drops it only for a Stop it made itself). A failure held when the event stream ends or drops is dropped too, so a stale
one does not show above a later stop. A run that fails keeps just
its own error. The chat also shows the runner's own notices that carry a description, such as "Continuing after
restart", as a muted note, with control and format characters in the text written out as escapes. Other notices, such
as a model fallback, appear in the same way once those features land.

**Affects:** VS Code users.

**What to do:** Nothing.

### Ctrl+R in the prompt searches earlier prompts, and prompt history keeps 500 entries

`ctrl+r` in the prompt of the terminal UI now opens a search over the prompts you sent before. The list narrows as you
type, shows prompts sent from the current directory first, then the closest match, then the newest, and Enter loads the choice into the
prompt with its mode and mentions. With `prompt.vim` on, `ctrl+r` opens it in normal mode too (normal mode has no
redo key; the `input.redo` binding still redoes). The command is `prompt.history.search`.

Renaming a session no longer has a key of its own in a session: `session.rename` now has no default key, and the
session list's rename action is the new `dialog.session.rename`, still `ctrl+r`, in the `session-list` place. `/rename`
and the command palette still rename a session. A `session.rename` key that you set in `keybinds` or `bindings` still
works for a session, but no longer reaches the session list. An entry for it in the `session-list` place of
`keybindings.json` now does nothing: move it to `dialog.session.rename`.

Prompt history is also kept differently. It holds up to `prompt.history_limit` entries (500 by default, 50 before), and
the file in Orbit's state folder is trimmed from its oldest end to stay under 1 MiB. Each entry now records the
directory and time it was sent from. A pasted image, which was saved in the file as base64, and a pasted body over
4 KiB are no longer saved: after a restart the image is gone from a recalled prompt (its `[Image 1]` mark stays as
text) and a large paste keeps its `[Pasted ~N lines]` label but is sent as the words "Pasted text was too large to keep
in prompt history"; selecting such an entry in the history search shows a warning. Both stay in the history of the
running session. Lines written by earlier builds are read as before.

**Affects:** anyone who used `ctrl+r` to rename a session from inside a session, who set `session.rename` in
`keybindings.json`, or who recalled a pasted image from history after restarting.

**What to do:** nothing, unless you want another key: set `prompt.history.search` or `dialog.session.rename`. Set
`prompt.history_limit` to keep more or fewer prompts.

### Session flags on `orb`: `--model`, `--agent`, `--fork` and `-r`/`--resume`

`orb` (the terminal UI) now takes `-m`/`--model`, `--agent` and `--fork`; they used to be an error without `-p`. `--model`
is your own choice on the command line, so it applies in any folder; a model that a project file names is still held
back until the folder is trusted. `--fork` needs `--continue`, `--session` or `--resume` with a session ID.

`-r`/`--resume [ID or words]` is new on `orb`, `orb run` and `orb -p`. In the terminal UI an ID that names a session
opens it, as `--session` does; an empty value, or anything else, opens the session list with the words typed into its
search. In `orb run` and `orb -p` it needs a session that exists: the ID, or the newest session of the working folder
that matches the words, and a miss fails with "Session not found" (as one failed result under `--output-format json`)
instead of creating a session, as `--session` does. The session's own folder is the one checked for trust, wherever the
command starts. `--resume` cannot be combined with `--continue` or `--session`.

`--prompt` cannot be combined with a `-r` that opens the session list, because the prompt would go to a new session and
not to the one you pick. `--model provider/model#variant` applies the variant to that model. Your `--model` wins over
the selected agent's own model and over the model a resumed session has stored (`--session`, `-r <ID>` and `--continue`)
until you pick another model with the model picker or the cycle keys; picking a variant keeps the model.

The TUI now writes the title of a session out wherever it draws one: the tab rail, the sidebar, the banner, Home's recent
list, the session list, the open dialog, the agent map, the rename prompt, the session-deleted notice and the
notification text of a session. Control and format characters in a title appear as `\x1b` or `\u{202e}` instead of acting
on the terminal. The rename prompt shows a title written out the same way, so renaming a title that held such a
character saves the written-out form unless you retype it.

`-r` takes the next word as its value, so `orb -p -r fix it` resumes the session matching "fix" and sends "it". Quote the
message, or put it after `--`, as in `orb -p -r ses_abc -- fix it`. A `-r` that ends the line, or is followed by another
flag, has an empty value.

**Affects:** anyone who wrote `-r` in a command line, which `orb` did not take before.

**What to do:** nothing; quote a message that follows `-r`.

### Control characters in messages are written out on screen

The terminal UI and Mini used to draw model text, tool output, tool errors, approval prompts, shell commands and the
labels of tools as they were. A body that carried an escape sequence or a right-to-left override could set the window
title, erase a line or reorder text. Those characters are now drawn written out, such as `\x1b` for an escape and
`\u{202e}` for an override, so you can see that they were there. The places include the text of questions and their
answers, the plan, the notices that a background shell or subagent finished, skill names, the paths that a read loaded,
the queued-prompt line, the cards of a workflow, the call lines of `execute`, the external link and the review rows of
a form. Line breaks, tabs, emoji and other Unicode are unchanged, and so is Markdown formatting. Text that the model
meant to color with escape sequences shows the written-out form instead.

A carriage return is handled by where it is drawn. In program output (shell, `execute` and the output of other tools)
a lone carriage return, which progress meters use to redraw a line, is drawn as a line break, as Mini already did, and
the color sequences of shell output are removed rather than written out. In a command line, an approval prompt or any
other text, a carriage return is written out as `\x0d`, because a shell treats it as an ordinary character.

The background shell views follow the same rule: the command in the shell tab of the composer, and the command and the
output in the output dialog, show `\x1b` and `\x07` where a program wrote them. So do toasts, the error text of the
details dialog, the queued-prompt dialog and Mini's queued-prompt picker.

A few places also write controls out but have no frame test of their own yet: the tool list of the token-usage view, the
details dialog of `execute`, the timeline and fork lists, the `/btw` answer, the Mini subagent picker and the
composer's terminal and subagent rows. Three places do not write them out yet: the desktop notification text, the
markdown export, and the prompt history and stash lists. Known gaps in
[untrusted-repositories.md](untrusted-repositories.md) names all of them, and `orb run` is unchanged.

**Affects:** anyone who reads tool output or model text in the terminal UI or Mini that holds raw control characters.
`orb run` and the stored messages are unchanged.

**What to do:** nothing.

### Footers for continued and truncated replies

The line under an assistant reply in the terminal UI now ends with a muted label when the reply was not the end of the
run. "continued" marks a step that hit an error or the output limit and was followed by another step, and its error
line is no longer shown, since the run recovered. "truncated at output limit" marks a final reply that was cut off and
that the run did not resume; while the next step is still starting it has no label. A prompt that is queued but not yet
delivered does not end the turn. The terminal UI can also show "retried" for an attempt that a retry with a larger
output limit replaced, which appears once Orbit makes such retries in a later change. Before, a recovered error stayed on
screen and a cut-off reply had no marker.

**Affects:** people who use the terminal UI.

**What to do:** Nothing.

### An approval prompt shows what the request asks for, and every file a patch changes

The terminal UI and Mini used to fill an approval prompt from the input of the tool call that was running. A Code Mode
`execute` call that fetches a URL, a `workflow` call that starts an agent and a patch all ask under that running call,
whose own input can name a different URL, agent or file from the one asked about. The prompt now uses the call's input
only when that call is the tool that asks, and otherwise shows the request's own URL, agent or file. A patch that
changes several files used to be shown as an edit of its first file, with only that file's diff. Its prompt now names
every file in the title, the old name of a moved file included, and shows each file's diff under its path.

**Affects:** people who approve edits made with the Patch tool, which some models get in place of Edit and Write, and
approvals for Code Mode fetches and workflow agents, in the terminal UI and Mini.

**What to do:** Nothing.

### `--mcp-config` and `--agents` add MCP servers and agents for one run

`orb`, `orb run` and `orb -p` take `--mcp-config` (repeatable) and `--agents`. Each value is a JSON file or the JSON
itself (comments and trailing commas are allowed). `--mcp-config` takes `{"servers": {"<name>": {"type": "local",
"command": ["<program>"]}}}`, the shape of the `mcp` key, and `--agents` takes a map from agent name to the same fields as
the `agents` key. A relative program or `cwd` in a file means the folder of that file. Another product's `mcpServers` map
is refused with a hint. The values are checked before anything starts, an error names the flag and the path inside the
value, and the merged document may not pass 4 MiB. They layer over `ORBIT_CONFIG_CONTENT`, then `--mcp-config` in order,
then `--agents`. A later value that names a server another value already named replaces it whole (so a new `url` keeps no earlier `headers`, and a new `command` no earlier `environment`), as it does for `lsp`, `formatter`, `references` and `commands` entries; agents still merge by key. An empty or blank `--mcp-config` or `--agents` value is skipped, so a script that passes an unset variable runs.

A run with either flag uses a private server, as `--bare` does, so it starts a little slower and does not run anything on the
background service. The config reaches that server in a file in Orbit's state folder that only your user can open,
which the server deletes when it has read it, and `orb` removes the variable and the folder as soon as the server is up. The environment that `orb` hands to a session no longer carries
`ORBIT_CONFIG_CONTENT` or `ORBIT_CONFIG_CONTENT_FILE`. The flags cannot be combined with `--server`. With `--continue`, `--session` or `--resume`,
the run stops, before the interface starts, when the background service reports that session as running, or when a service is registered and alive
but cannot be asked, because two servers would run it at once; `--fork` is not checked, since a fork never runs the
session it copies, and an `orb` that opens the session list cannot tell, and does not check. A value that starts, after whitespace, with `{`, a `/*` comment, or a `//` comment followed by another line is read as inline JSONC and anything else is a file name (so a one-line `//server/share/mcp.json` is a path); the disk never decides, so a folder that ships a file named after the text you typed cannot replace it (a file whose name starts with `{` is reached as `./{...}`). This replaces the earlier rule that a value was a file whenever a file of that name existed. A relative file name is
taken from the folder you typed it in, also with `orb <directory>`; a relative `{file:...}` inside the value is taken from the folder of the file that holds it, or the folder you typed an inline value in, also when it holds an `{env:NAME}` (a reference that starts with `{env:NAME}` is anchored when NAME holds a relative path, and left to Orbit when it holds an absolute one). Only the session named at start is checked: the session list, restored tabs and `/resume` can still open one the service runs, as with `--standalone`. Rules that `--agents` gives an agent add to the rules
the same agent already has from `ORBIT_CONFIG_CONTENT`. A `ORBIT_CONFIG_CONTENT_FILE` that you set yourself is ignored (a server logs one line)
and never deleted.

**Affects:** scripts and people who want a different set of MCP servers or agents for a single run.

**What to do:** Nothing.

### `--settings` loads a config file or inline JSON for one run

`orb`, `orb -p`, `orb run`, `orb mini`, `orb loop` and `orb debug config` take `--settings <file-or-json>`: a config in
the `orbit.json` shape (comments and trailing commas allowed) that applies to this run only. It ranks in the flag scope,
above project and local config and below managed settings. Within that scope an `ORBIT_CONFIG` file or a `--settings`
file comes first (a `--settings` file takes the place of `ORBIT_CONFIG` for the run), then `ORBIT_CONFIG_CONTENT`, then an
inline `--settings`, then `--mcp-config` and `--agents`. The value is inline JSON when it starts, after whitespace, with
`{` or a comment, and a file name otherwise; the disk never decides. A relative file name is taken from the folder you
typed the command in, and a relative `{file:...}` inside a file is taken from beside that file. The value is checked before
anything starts: a missing file, a folder, a device, a file over 4 MiB, JSON that does not parse, an empty value and a
repeated flag are each refused before anything starts; `-p` and `run` print one line, and the interface, `loop`, `mini`
and `debug config` print the error with a stack trace. A file saved as UTF-16 (Windows PowerShell 5.1 does this for `>`) is refused
with a request to save it as UTF-8; an empty file is accepted, and an inherited `ORBIT_CONFIG` then still applies. Fields that do not fit the config schema are judged by the
server, which logs them and leaves them out (the whole document is dropped only when final validation fails); `orb debug config --settings ...` shows whether it arrived.

A run with `--settings` uses a private server, like `--mcp-config`, so it starts a little slower, runs nothing on the
background service, and cannot be combined with `--server`. With `--continue`, `--session` or `--resume` it stops when the
background service is running that session (pinned for `orb`, `-p` and `loop`). The settings never trust the folder: `--trust` is still what grants that.

A config file that discovery already loaded (the project's own `orbit.json`, a local file or your user config) now loads
once, at its own scope and under its own trust, by real path (a link, a different case and, on Windows, an 8.3 short name count as the same
file), including through `ORBIT_CONFIG` or a `--settings`
that names it. Before, `ORBIT_CONFIG` pointing at a project's file loaded it a second time in the flag scope without the
trust restrictions of an untrusted folder.

**Affects:** people who want settings for a single run, and anyone who set `ORBIT_CONFIG` to a file inside a project.

**What to do:** Nothing. Pass a file or JSON to `--settings`; to give an untrusted project's file full effect, trust the
folder rather than naming its file.

### Terminal bell, idle reminder and a status in the window title

`attention.bell` in the terminal UI's `cli.json` (default off) rings the terminal bell for an attention event while the
terminal is blurred or its focus is unknown, between frames (right after the next frame while an animation keeps the
renderer running). A subagent's permission or form rings it too, since a person must answer; a subagent finishing does
not. `attention.idle_reminder` is a number of seconds (default 60, larger values are capped at 86400, 0 turns it off): once a top-level
session has finished, the reminder "The session has stopped and the next step is yours" comes after that many seconds with no key
pressed, no new run started and no permission or form pending. It is sent only while the terminal reports that it is
blurred (never for a terminal whose focus is unknown), only when notifications, sound or the bell are on, and once per
idle period. The window title was
`OC | <title>`; it is now `Orbit · <title>`, with ` · working` while a session runs and ` · needs input` while a
permission or form waits, including those of its subagents (in Mini, on Linux, as before).

**Affects:** people who match the window title in a terminal multiplexer, window manager rule or script, and people who
have notifications, sound or the bell on, who get the reminder.

**What to do:** Match `Orbit · ` instead of `OC | `. Set `attention.idle_reminder` to 0 to turn the reminder off.

### System notifications for the TUI and Mini, and notices in VS Code

`attention.backend` in `cli.json` chooses where a notification appears. `"terminal"`, the default, asks the terminal
to show it, as before. `"system"` uses the operating system's own notifications (`notify-send` on Linux, Notification
Center on macOS, a toast from Windows PowerShell on Windows) and falls back to the terminal when the program is missing,
exits with an error or runs longer than 10 seconds. `attention.notifications` is still the master switch and still off by
default, and a notification still shows only while the terminal is blurred. The title and the message reach the program
as data, never as part of a script. Mini now honours `attention.notifications`, `attention.backend`, `attention.bell` and
`attention.idle_reminder` exactly as the TUI does, including the reminder after a finished session.

A subagent's permission request or form now notifies like a root session's does. It used to send a sound and a bell
only. A subagent finishing stays silent.

The VS Code extension has a new setting, `orbit.notifications` (on by default). While the Orbit chat is hidden or the
window is in the background, it shows a notice when a permission needs review ("Orbit needs your review") and when a
working period ends ("Orbit finished"), each with an Open button. These are notices inside VS Code, not operating
system notifications.

**Affects:** TUI and Mini users who turn notifications on, people who use subagents with notifications on, and VS Code
users, who get the new notices unless they turn `orbit.notifications` off.

**What to do:** Nothing. Set `"attention": { "backend": "system" }` to use the operating system's notifications, and
`orbit.notifications` to `false` to silence the VS Code notices.

### `orb trust` can trust the folder above a project, and revoke a folder that was deleted

When a file in a folder above the project holds config back, the advice used to be `orb trust <folder>`. That command
opens a location of its own for the folder, and the grant goes to that location's project, which can be another one
(an outer repository, a plain folder in it, and an inner repository: trusting the middle folder trusted the outer
repository and left the middle folder's config off). The refusal, the terminal UI, Mini and `orb trust` now print
`orb trust <folder> --for <location>`, which names both and works from any folder. `--for` trusts the folder only
when the location holds config back for it; for any other folder nothing is trusted. A home directory or a filesystem
root is never offered a command, because it is trusted only for one run (`--trust`) or until Orbit restarts.

`orb trust --revoke <folder>` now ends the stored grant, and what it recorded, of a folder that no longer exists. It
matches the name given or listed by `orb trust --list`, ignoring case on Windows, and says "is not trusted" when none
matches; before, it asked you to create the folder again. The server has a new `POST /api/trust/revoke` route for this.

**Affects:** scripts that parse the advice of `orb trust` or the refusal text, and anyone who revokes a folder they
deleted.

**What to do:** Copy the printed command as it is. Nothing otherwise.

The printed command quotes the folder names: a name with a space, a quote, `$(` or a backtick is wrapped so that no
shell runs it, and a name that no quoting makes safe (a control character, a line break, or on Windows anything PowerShell
or cmd would expand) gets no command, only its escaped name and the way to type it yourself. `orb trust --revoke <folder>`
now ends a folder that is a stored grant by its own name, wherever it is a location: after `orb trust M --for I`, the
revoke it prints removes M and leaves the grant of the repository around it.

### The status line stays blank until the folder is trusted

The status line command used to run as soon as the terminal UI opened, in the folder it was started in, which for a clone can make the command's own programs (`bun`, `git`, `npx`) run code the clone chose. It now runs no command and draws no line while that folder is untrusted, and starts as soon as it is trusted (`/trust` in the terminal UI, or `orb trust`). The command is also given the folder of the session in view as `cwd` and `project_dir`, and runs only while that folder is trusted as well, because a status line that runs `git` there would run the folder's own `core.fsmonitor`.

**Affects:** people with a `status_line` command who open `orb` in a folder they have not trusted.

**What to do:** Trust the folder; nothing changes in folders that are already trusted.

### The status line follows managed hook settings, shows every line, runs quoted commands on Windows and stops with the terminal UI

- Managed `disable_hooks` or `managed_hooks_only` (or the managed file's `hooks.disabled` or `hooks.managed_only`) now stop the status line command, because it stands in for a hook and Orbit has no managed status line. One muted line says why. `GET /api/config/effective` reports `hooks.disabled` and `hooks.managed_only`; a server that does not report them counts as unknown, and the terminal UI does not run the command until it knows.
- The status line draws every non-empty line the command prints, up to ten, one row each. It used to draw the first line only, and nothing when the output began with a blank line.
- On Windows a command that contains a double quote, such as a quoted script path or `echo "a b"`, now runs as typed. It used to fail without a message.
- On Linux and macOS a command still running when the terminal UI exits is stopped with what it started; it used to be left running in its own session.

**Affects:** people with a `status_line` command, in particular under organization-managed hook restrictions and on Windows.

**What to do:** Nothing, unless your script printed several lines and relied on only the first showing.

### The VS Code chat sends the file you have open, and any selected text, as hidden context

Each message you type in the Orbit chat now carries the path of the file you last worked in (a file on disk, not an
untitled buffer or a diff) and, when you have text selected there, the selected lines and up to 2000 characters of the
text. It reaches the model as a hidden message right before yours, marked as editor context and not as an instruction; the
chat shows only a muted line under your message when a selection went with it. A chip above the prompt names the file and
the selected lines before you send; click it to leave them out of that message. A second chip appears when the file has
errors or warnings; it starts off, and clicking it sends a short summary of them (at most 4000 characters) with that
message. After you send, the file chip hides until you open another file or change the selection, and the problems chip
goes off again. The selection is no longer pasted into the text of your message. The Ask, Explain and Fix commands and
starters work as before.

New setting `orbit.context.includeOpenFile` (default `true`) sets whether the file chip starts on. Only your user
settings count; a workspace cannot set it. Nothing checks your read permission rules for the file before its path or
selected text is sent (see FU-M4-35 in the follow-up register).

**Affects:** VS Code users.

**What to do:** Nothing, or set `orbit.context.includeOpenFile` to `false` in your user settings to start with the chip
off.

### Vim keys in the prompt: counts, operators, text objects, registers and an insert label

With `prompt.vim` on, normal mode now understands counts (`3w`, `2dd`, `5x`, up to 10000), the operators `d`, `c` and
`y` with the motions `h j k l w b e W B E 0 ^ $ gg G` (and `gj`, `gk` for display rows), the text objects `iw aw iW aW`
and the inner and around forms of quotes, backticks, `()`, `[]`, `{}` and `<>`, and the commands `dd cc yy D C Y s S x X
r ~ J p P o O i I a A >> <<` and `u`. There is one unnamed register that lives as long as the prompt does and is never
written to disk; `"+` before a yank, delete or paste goes through the system clipboard (`"+p` pastes only a text
clipboard, and CRLF becomes LF). Prompt parts (file and agent mentions, pasted-text summaries, images) are never cut in
half by a motion or an operator. One `u` undoes one whole command, such as `3dd`.

In insert mode a muted `-- INSERT --` label starts the row under the prompt; normal mode shows no label and uses the
block cursor. Escape in insert mode no longer moves the cursor left when it is at the start of a line. Escape in normal
mode clears a half-typed command and still reaches the interrupt of a running session; Enter submits from either mode;
the arrow keys act as `h j k l` while a count or operator is pending. If you set no `cursor` and use `prompt.vim`, the
insert cursor is a line (before, switching back to insert mode failed). The status line command is run again when the
vim mode or the configured output style changes.

In a few places Orbit follows Vim's documented behaviour: `d$`/`D`/`C` (they stop at the line break), the linewise
operators (`dj`, `dk`, `dG`, `dgg` take whole lines), `d0`, counted `x`, `r` and `~` (they stay on the line), `dw` at the
end of a line, `cw` on the last letter of a word, and `a` at the end of a line.

**Affects:** people who set `prompt.vim` to `true`, and status line commands that show the vim mode or output style.

**What to do:** Nothing.

### Vim keys in the prompt: visual mode, `.`, finds and `%`

With `prompt.vim` on, normal mode gains four things.

- **Visual mode.** `v` starts a characterwise selection and `V` a linewise one; the same letter leaves, the other letter
  switches. Move the head with the normal motions, the finds, `%`, the arrow keys (also with Shift) and Backspace, which
  moves the head left and deletes nothing; Delete, Home and End do nothing. `o` swaps the ends. `d`, `c` and `y` act on
  the selection, and `>` and `<` shift every line it touches (a count before them is the number of levels). `"+` before
  an operator uses the system clipboard. Escape leaves and is not passed on, so it does not interrupt a running session;
  the next Escape does. Enter submits and ends the selection. Other keys (`p x s r ~ J u i a`, `gv`) do nothing in
  visual mode yet, so `viw` ignores the `i` and moves the head one word. A Ctrl, Alt or Super chord (Ctrl+D,
  Ctrl+W, Ctrl+Z, Alt+F and so on) ends the selection and then does what it does elsewhere, from a plain cursor, so
  Ctrl+V ends it and pastes. The row under the prompt shows `-- VISUAL --` or `-- VISUAL LINE --`. The selection is
  drawn with the editor's own selection colour.
- **Finds.** `f`, `F`, `t` and `T` take the next key as the character to look for (a digit, a space and an emoji
  included), with a count for the Nth one; `;` repeats the last find and `,` runs it the other way. `df-`, `ct,` and `yF.`
  work as operators. Parts such as file mentions never match and are never split.
- **`%`** jumps to the partner of the first `( ) [ ] { }` from the cursor to the end of its line, and `d%`, `c%` and
  `y%` act on the span. A count before `%` does nothing.
- **`.`** repeats the last change: an operator with a motion, object or find, `dd`, `x`, `r`, `~`, `>>`, `J`, `o`, a
  visual operator, or the text you typed in insert mode. It is kept in memory only. `2dd` then `.` deletes two more lines.

In these places Orbit departs from Vim: text typed after `cw` or `o` replaces
that command for `.` (so `.` inserts the text and does not change a word), a yank is repeated too, a count typed before
`.` is dropped, `;` after a `t` whose target is next to the cursor stays put, `dF-` and `dT-` include the character under
the cursor, and finds cross line breaks. The record of typed text starts again when a prompt is sent or its text is
replaced, so `.` never re-types a sent prompt.

The status line command's `vim_mode` is now also `visual` and `visual_line`.

**Affects:** people who set `prompt.vim` to `true`, and status line commands that read `vim_mode`.

**What to do:** Nothing. A status line script that expects only `insert` and `normal` should accept the two new values.

### `orb flow clean` finds a run by the repository's real path and leaves a linked run folder alone

`orb flow clean` used to match the worktrees that git lists against the run's folder as you spelled the repository's
path, so on Windows a path with other case, or with the 8.3 short name of one of its folders (a temporary folder under
`C:\Users\RUNNER~1`, say), found nothing: the run's worktree stayed and deleting its branch failed. It now takes the
repository by its real path. The run's folder is named under that path and is not itself resolved, and when
`.orbit`, `.orbit/worktrees` or the run's folder is a link or a junction, the command removes nothing for that run, not
even its branches, and prints one line naming the link. Before, such a link could lead clean to a folder outside
`.orbit/worktrees` and have it remove a worktree of yours there, with work you had not committed.

**Affects:** people who run `orb flow clean` from a path spelled with other case or a short name, and repositories in
which one of those folders is a link.

**What to do:** nothing. If clean names a link, remove the link and run it again.

### Opt-in tool labels and prompt suggestions for stream-json runs

`orb -p` and `orb run` take two new flags, both off unless given and both only with `--input-format stream-json` and
stream-json output. `--tool-labels` asks the side model for a short label after each finished batch of tool calls and
writes it as a `tool_label` line (`messageID`, `toolIDs`, `label`) before the result of that batch's message; a batch
that was interrupted gets none. `--prompt-suggestions` asks the session's own model, with the conversation, what you
might type next after each result that was not interrupted, and writes a `prompt_suggestion` line (`suggestion`). A new
`user`, `interrupt` or `end` line drops a suggestion still being written, and when standard input closes the run waits up
to five seconds for one. Each label and each suggestion is a model call that spends tokens. Without the flags nothing is asked.

The server has two new routes for this, `POST /api/session/:sessionID/assist/label` and
`POST /api/session/:sessionID/assist/suggestion`. They store nothing and send nothing to the session; they answer with
the text, or with `null` and the reason there is none (for a suggestion: a conversation with fewer than two replies, a
failed last reply, a last reply that wrote more than 10,000 uncached tokens, a pending approval or form, Plan mode, a
running session, a subagent's session, or a filter that dropped the text). Both refuse a session whose folder is not
trusted with `UntrustedFolderError`.

**Affects:** programs that drive `orb -p` or `orb run` with stream-json, and SDK callers.

**What to do:** Nothing. Pass the flags to get the lines; escape the text before you print it, as for any model text.

## Permissions

Changes to what Orbit asks about before it acts, and to how rules and saved approvals apply.

### Code Mode `fetch` asks for webfetch permission

The `fetch` that Code Mode scripts call used to run without any permission check. It now asks for `webfetch` permission,
per URL, the same way the `webfetch` tool does, and a policy or rule that denies `webfetch` blocks it too. A request with
a method other than GET or HEAD also asks about `METHOD url`, for example `POST https://example.com/x`. A rule or
approval written for a URL, an origin or a host never allows such a write; a deny written for them still blocks it. Only
`http:` and `https:` URLs work, so `file:` and `data:` URLs now fail before anything is sent, and the URL must be a
string or a `URL` and the method a string. A redirect is asked about too, as the last note in this section describes.

**Affects:** agents that run Code Mode scripts calling `fetch` while `webfetch` is set to ask or deny. With the default
allow-all rules nothing changes, apart from the new limits on what `fetch` accepts and the refusals that the last note
in this section describes.

**What to do:** approve the prompts, or add `webfetch` allow rules for the origins the scripts use, such as
`https://api.example.com/*`. Add a method rule such as `POST https://api.example.com/*` for scripts that write, or allow
`webfetch *` to cover reads and writes alike.

### "Always allow" for a fetch saves the origin

Choosing "Always allow" for a fetch now saves the origin, for example `https://example.com/*`, instead of the bare host
(`example.com`). The origin includes the scheme and the port, so approving `https://example.com` does not approve
`http://example.com` or `https://example.com:8443`. For a write it also saves the method pattern, such as
`POST https://example.com/*`. Rules written for a bare host (`webfetch example.com allow`) and approvals saved that way
earlier keep allowing reads of that host on any scheme and port.

**Affects:** people who approve fetches with "Always allow", and plugins with a `permission.evaluate` hook that read
`aliases`, which is now an object keyed by resource instead of a list.

**What to do:** nothing for saved approvals. Approve an origin again if you need it on another scheme or port, and read
`event.aliases?.[resource]` in plugin hooks.

### Code Mode `fetch` asks again for each redirect and refuses local addresses

`fetch` in a Code Mode script used to follow redirects on its own, so a request to an approved origin could be sent on to
any other host without a second question. Now every redirect is a request of its own. It asks for `webfetch` permission
for the address it names, like the first request, and a decline or a deny stops the chain there. A script follows at most
10 redirects. "Always allow" for an origin covers the redirects inside it, and a "once" approval covers only the request
it was given for.

`fetch` also refuses addresses that are not public, after the permission step and whatever the rules say:

- **Loopback:** 127.0.0.0/8, all of 0.0.0.0/8, which reaches this machine too, and `::` and `::1`.
- **Private networks:** 10/8, 172.16/12, 192.168/16, the shared address space 100.64/10, the benchmarking range
  198.18/15, the IETF protocol assignments 192.0.0.0/24, `fc00::/7`, the deprecated site-local `fec0::/10`, and the
  NAT64 prefix for local use `64:ff9b:1::/48`.
- **Link-local addresses:** 169.254/16 and `fe80::/10`.
- **Cloud metadata addresses:** 169.254.169.254, 100.100.100.200, 168.63.129.16 and 192.0.0.192, and the IPv6 endpoints
  that sit in the unique local range `fc00::/7`: `fd00:ec2::254` (AWS instance metadata), `fd00:ec2::23` (the EKS Pod
  Identity Agent's credentials), `fd20:ce::254` (Compute Engine), `fd00:c1::a9fe:a9fe` (Oracle Cloud Infrastructure),
  `fd00:a9fe:a9fe::1` (the Akamai, formerly Linode, Metadata service) and `fd00:42::42` (the Scaleway metadata API).
  Only these exact addresses are metadata; the rest of `fc00::/7` is a private network.

An IPv6 address that stands for an IPv4 one is refused when that IPv4 address is any of these. The forms that carry one
are the IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible and IPv4-translated addresses, NAT64 (`64:ff9b::/96` and
`64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`, whose client address is stored inverted) and ISATAP, so
`[64:ff9b::a9fe:a9fe]` and `[2002:a9fe:a9fe::]` are refused as the metadata address they lead to. An address that a
network translates to IPv4 with a prefix of its own is not recognised. A host name is resolved first, and it is refused
when any address it stands for is one of those; `localhost` and the names under it count as loopback. The script gets an
error that names the address.

The request then goes to the addresses that were checked, and not to the name. Whatever connects to a name resolves it
again, and a name with a time to live of 0 can answer with a public address for the check and with `169.254.169.254`
for the connection (DNS rebinding). A script chooses the method and the headers of its request, so that would reach the
credentials that a cloud serves from its metadata address, such as those of IMDSv2, Compute Engine and Azure. So `fetch`
resolves a name once per request, the program's own and each redirect, and connects to an address from that answer. It
tries the others, in the order they came, only when no connection could be made to the one before, so a name with
several addresses, such as `localhost`, still reaches a server that listens on one of them. The name stays what the
request is for: it is sent in the `Host` header, unless the script sets its own, and with `https:` in the TLS handshake,
where the certificate is checked against the name and not against the address, and it is the name that `response.url`
reports. A host that is an address is connected to as it is. A name that resolves to no address is refused as well, and
so is one whose lookup fails, because there is nothing to check and the connection would resolve the name by itself.
Behind a proxy that `HTTP_PROXY` or `HTTPS_PROXY` names, the proxy is asked to connect to the address and not to the
name, and an entry of `NO_PROXY`, which matches by name, no longer applies to a request for a name.

**Affects:** Code Mode scripts that call `fetch`. One that follows a redirect while `webfetch` is set to ask or deny gets
another prompt. One that calls a server on `localhost`, on a private network or at a link-local address now fails, even
with allow-all rules. One that calls a name that this machine cannot resolve by itself now gets an error that says so,
where it used to send the request on to a proxy that resolved the name, if there was one.

**What to do:** approve the extra prompts, or add `webfetch` allow rules for the origins the redirects lead to. To let
scripts reach local dev servers, set `experimental.allow_local_fetch` to `true` in your own config. It lets `fetch` reach
loopback and private-network addresses and no others, and like the rest of `experimental` it is ignored in the config of
a folder that is not trusted.

### An edit that cannot work fails before it asks you to approve it

The `edit` tool used to ask for your approval before it checked that the text to replace was in the file exactly once,
and that the file existed and was not a directory, so you could approve an edit that then failed. Those checks now come
first. The refusals for identical or empty text and for a file that was not read or changed already came before the
approval; they now carry a stable code too. An edit that cannot work fails without asking:

- the old and new text are the same, or the old text is empty;
- the file does not exist or is a directory;
- the session has not read the file, or it changed since the session did;
- the old text is not in the file, or is in it more than once and `replaceAll` is not set.

The checks run again just before the `edit` approval would be asked, on the file as it is then, so an edit that stopped
working in between is not put to you either. A file outside the project is not read until you have approved its
directory, as before, and the checks then run before the `edit` approval. One more difference follows from the order:
when a rule denies `edit` for a file that the session has read, a call whose old text is not in the file now fails with
`edit.no-match` instead of with the denial. The session has read the file, so it learns nothing it did not have.

**Affects:** people who approve edits, who now see fewer prompts that end in an error, and agents in plan mode or under a
rule that denies `edit`, whose bad edits get the specific failure first. The failures have their own error types, which
the note on error types describes.

**What to do:** Nothing.

### Tools that do not ask for themselves are now asked about

Ask and deny rules now govern a tool that does not take care of its own permission question, and nothing changes under the default rules (`* * allow`). Tools that plugins and the SDK add used to run unasked unless they asked for themselves; they now ask on their permission action (or their name), on every resource, once per call, and "always" saves `*` for that action. The same goes for Code Mode: a program that calls such a tool is asked for each call. A tool opts out by setting `options.authorizes` to `true`, or to a function of the decoded input that answers `true` (a Promise plugin's function may answer with a Promise); a function that throws, fails, rejects or answers with anything else counts as not opting out. The desktop browser tools pass the same gate on `browser`, and the browser plugin's own rules (`browser * deny` for every agent, `browser * allow` for a session it is attached to) decide, so they never prompt. Orbit's own tools that check each file, command or address (`read`, `edit`, `shell`, `webfetch`, the MCP tools and the like) and MCP tools are unchanged, and annotations from an MCP server never relax anything. Orbit's tools that never asked are now governed by rules on their own name, and ask once per call when a rule says `ask`: `memory`, `enter_worktree`, `exit_worktree`, `orbit_session_rename`, `orbit_session_move`, `orbit_models`, `task_create`, `task_update`, `task_list`, `todo`, `shell_output`, `shell_watch`, `shell_stop`, `enter_plan_mode` and `exit_plan_mode`. Under the default rules (`* * allow`) none of them asks, but an `ask` or `deny` rule, or an agent whose rules deny everything it does not name, now reaches them. The tool's name is also its action, so a tool that names a shared action, such as `edit`, `read` or `shell`, asks for the whole action, and "always" saves `<action> *`; saved rules are evaluated after the configured ones, so that saved rule outranks a configured narrower `ask` such as `read *.env ask`. Answer "once" for these tools if you want the narrower rule to keep applying.

**Affects:** plugin and SDK authors whose tools did not ask, and people whose rules ask or deny for these tools: an `ask` rule now prompts, and a `deny` rule now applies. A refusal reaches clients as a `permission.rejected` error, as it does for the built-in tools.

**What to do:** approve the prompt, or add an allow rule for the tool's action. Authors of a tool that asks in `execute` set `options.authorizes: true` to avoid the second question.

### Built-in tools take the reference names and input fields

The built-in tools are renamed, and several of their input fields with them: `shell` is `Bash`, `read` is `Read`, `edit` is `Edit`, `write` is `Write`, `patch` is `Patch`, `glob` is `Glob`, `grep` is `Grep`, `webfetch` is `WebFetch`, `websearch` is `WebSearch`, `question` is `AskUserQuestion`, `todo` is `TodoWrite`, `task_create`, `task_update` and `task_list` are `TaskCreate`, `TaskUpdate` and `TaskList`, `subagent` is `Agent`, `skill` is `Skill`, `notebook_edit` is `NotebookEdit`, `lsp` is `LSP`, `enter_plan_mode` and `exit_plan_mode` are `EnterPlanMode` and `ExitPlanMode`, `enter_worktree` and `exit_worktree` are `EnterWorktree` and `ExitWorktree`, `shell_output`, `shell_watch` and `shell_stop` are `TaskOutput`, `TaskWatch` and `TaskStop`, `workflow` is `Workflow`, `memory` is `Memory` and Code Mode's `execute` is `Execute`. `Edit` takes `file_path`, `old_string`, `new_string` and `replace_all`, `Read` and `Write` take `file_path`, `NotebookEdit` takes `notebook_path`, and `Bash` takes `run_in_background` where it took `background`. The model is now told the new names, and the permission action of a tool is its new name (`Edit` for `Edit`, `Write`, `Patch` and `NotebookEdit`).

One table, `ToolNames` (`packages/schema/src/tool-names.ts`, re-exported from `packages/core/src/tool/names.ts`), keeps every old spelling working. Permission rules, saved approvals, policies of the form `<action>:<resource>`, hook matchers and the clients that draw a call all accept either spelling, and an old spelling stands for the same tool as the new one and for no other: an `allow` for `read` never covers `Bash`. A config hook of your own (in an Orbit settings file) is told the old name in `tool_name` whenever its matcher accepts it, which includes a matcher that is absent, `*` or `.*`, and its `tool_input` always carries the old field names beside the current ones, so a guard that checks `tool_name == "read"`, `path` or `oldString` keeps blocking whatever its matcher says. A matcher that names only the new spelling, such as `Read`, is told `Read`. A hook from another product's settings file is told that product's name, as before. A session recorded before the change replays under the new names: history is lowered with the new tool name and fields, while the recorded events keep what they were written with and nothing is migrated. A code plugin (an SDK plugin, a plugin package or a local plugin) that does not say otherwise keeps being told the old names: the `tool` of a `tool.execute.before` or `tool.execute.after` hook and the `action` of a `permission.evaluate` hook are `shell`, `edit` and `write`, so a guard such as `event.tool === "shell"` keeps matching and blocking, and a name such as `shell` that the hook writes to `event.tool` is read as the tool it names. A plugin opts in to the new names by declaring `toolNames: "reference"` beside its `id` (in the `define` call, or in the object a promise plugin exports); its hooks are then told `Bash`, `Edit` and `Write`, and it must compare with those. The built-in plugins use the new names. The input a plugin hook is shown answers to the old field names too: `input.path` reads `file_path`, and a write to `input.path` changes `file_path`, and `delete input.path` withdraws `file_path`, while `Object.keys`, `structuredClone` and copies of the input carry the current names only; a hook that replaces `event.input` with a copy or an object of its own that uses an old field name (`background`, `oldString`) changes the call all the same. The `tools` record that `session.context` and compaction hooks receive is keyed by the new names, but reads, writes and `delete` with an old name act on the new entry, so `delete event.tools.write` still hides `Write`. The editor of `tool.transform` answers to the old names as well: `get`, `update` and `remove` with `shell` or `write` act on `Bash` or `Write`, unless a tool is registered under that exact id. When the session shell is PowerShell the model is offered the shell tool as `PowerShell` and its prompts say so, but only after every plugin's context, compaction and generate hook has run and every execute hook has been told the tool by its registry name: a hook written for `shell` or `Bash` sees, hides and blocks the tool whichever shell the session has. The PowerShell name is written into Orbit's own base prompt only; an output style you add keeps its text, so "Git Bash" in a style stays as written. Every execute hook, a config `PreToolUse` hook included, is now told the registry name of any tool that a `session.context` hook renamed, not only the shell; before, it was told the name the model called. `PowerShell`, `Bash` and `shell` are spellings of one action, so a rule, saved approval or hook matcher written for any of them covers the tool whichever name the model is given, and an ACP client shows the command of a `PowerShell` call as it does for `Bash`. A plugin that registers a tool under an old built-in name (`shell`, `write`) now replaces that built-in, as it did before the rename, and a `session.context` hook that reads or deletes `tools.write` while also adding its own tool called `write` reaches its own entry, not `Write`. A model that still sends an old tool name or field is not understood, because the old names are no longer in its tool list. `Read` does not take `pages` yet.

**Affects:** plugin authors whose hooks or tools match on a built-in tool's name or input field, SDK callers that read tool names from events of new sessions, and tests or scripts that call the tools by name. Permission rules, hook matchers and old sessions keep working.

**What to do:** nothing for rules, hook matchers and existing code plugins that match on a name or field they are given. A plugin that lists tools and picks one by its old name (`editor.list().filter((t) => t.id === "shell")`, or iterating `event.tools`) now finds `Bash`: `list()` and iteration report the current names, while `get`, `update`, `remove` and keyed reads accept either spelling. Every legacy hook is given the old field names as the input stands when it runs, including after the input repair or an earlier plugin replaced `event.input`, and a current field written after a `delete input.path` is a write, not a withdrawal. When you update a plugin to the new names, declare `toolNames: "reference"` and compare with `Bash`, `Edit` and `Write` in the same change, and prefer the new names in rules you write.

### A link that an untrusted folder ships into Orbit's own folders is asked about

Orbit lets every agent reach a few folders of its own outside the project without a question: your global config
folder, Orbit's temporary folder, and its shell and tool output. In a folder that you have not trusted, a link that the
repository ships (a symlink or a junction) into one of those folders was covered by that allow too. A read, a write, a
search or a command through the link asked no folder question, and the shell, Grep and Glob approvals named the link as
a folder of the project, so a command approved as `mv AGENTS.md AGENTS.md.bak` in `<project>\cfg` moved your own
instructions aside, and a Read or Grep of `cfg/orbit.json` sent your provider key to the model.

Now a place that such a link leads to asks "Access external directory" about the real folder, and only your own rules
and the approvals you saved can allow it; Orbit's own allows no longer answer it. This covers a Read and a Write through
the link, a Patch, a Grep or Glob `path`, a shell `workdir`, a folder that `cd` changes to, and a plain word of a shell
command or a file it redirects to, such as `cat cfg/orbit.json` or `echo text > cfg/AGENTS.md`. The shell approval's `metadata.workdir`, the `metadata.path` of a Grep or Glob approval
and the `metadata.filepath` of a patch's folder question name the real place. On Windows a link is seen through
`cfg.` and `cfg ` too, which a program started there treats as `cfg`. A path that a command builds as it runs, from a
variable or a substitution, is not checked yet. A trusted folder's links are its own, as before, and a folder of Orbit's
own that a tool names directly, such as `~/.config/orbit`, is still allowed without a question.

**Affects:** people who open folders they have not trusted that ship links into those folders, who now see the
question. Code built on `@orbit/core` that builds a `FileAccess.Target` must give it `place`, and an implementation of
`FileAccess.Service` must provide `escaped`.

**What to do:** answer the question. To let such links through without one, trust the folder, or add your own
`external_directory` allow rule for that folder, such as `~/.config/orbit/*`.

### On Windows, every spelling of a file meets the rules written for it

On Windows one file has spellings that a rule written for its name did not see. `.env::$DATA` opens `.env`, `new.sh:x`
writes a stream of `new.sh`, the 8.3 short name `ENV~1` opens `.env`, and a shell or ripgrep opens `.env.` or `.env ` as
`.env`. A Read deny or ask of `*.env`, such as the default ask, or an Edit deny of `*.sh` let these through.

Now a path with a `:` after its drive or share is refused with the error type `file.spelling` before anything is asked:
a data stream, and also a drive that is not a disk, such as `HKLM:\Software` or `FileSystem::C:\x`, which a shell would
read as a drive. Read, Write, Edit, NotebookEdit, Patch and LSP refuse it, and so do a Grep or Glob path, a shell
`workdir` and the folder of a `cd`. A part of a path that is an 8.3 short name is named by its long name, trailing
periods and spaces are dropped as Windows drops them, and a `\\?\` or `\\.\` prefix is read as the plain path, so your
rules see `.env` and `new.sh`, and an approval names the file by its own name. An 8.3 name whose long name cannot be
told is refused with `file.spelling` as well, and so is a part of that form that exists in a folder Orbit cannot list
(a part that is not there stays as it is; pinned by `test/tool-windows-spelling.test.ts`).

**Affects:** Windows users with rules for file names, and shell commands that change their location to a PowerShell
drive such as `HKLM:`, which now fail. Code that matches on a failed tool call's `error.type` can see `file.spelling`.

**What to do:** use the plain path of a file or folder. A shell command can still name a registry key as an argument;
only a change of location to it is refused.

### Another spelling of the project's folder is decided where it really is, and share paths are refused

A path that named the project through another spelling of its own folder was counted as outside the project by that
spelling: on Windows `C:\Documents and Settings\…` and `C:\Users\<you>\Local Settings\…` (system junctions), and anywhere
a link that leads to the project. In a folder that is not trusted, a link the repository ships below such a path was not
followed, so the folder question named the link's path while the tool acted where the link leads, and your deny rules
for the project's own names turned into questions.

Now the file tools (Read, Write, Edit, NotebookEdit, Patch, LSP, and the paths of Grep, Glob and a shell `workdir`) find
which part of the path is really inside the project, and decide the rest under the project's own folder: the rules see
the project-relative name, a repository link below it is followed and asked about as for the plain spelling, and an
approval names the place the tool acts on. An 8.3 short name of the project's folder, or of a folder above it, is decided as the project, too. A share or device path (`\\server\share\…`, `\\localhost\C$\…`,
`\\?\Volume{…}\…`, `\\.\…`) is refused with the error type `file.spelling` before any disk is read, unless the path
is in the project's folder. A repository link whose target is a share, in any of these spellings (a local
`\\localhost\C$\…` included), is refused the same way, with no question, for a tool's path and for the plain words of a
shell command, and is never opened; a part with `~` (an 8.3 short name) below such a link is refused too, as its long
name could only be found by opening the share. `file-access-spelling.test.ts` pins that only `readLink` touches such a link or a path below it. The words a shell command names are followed through a repository link in these
spellings as well, and a drive made from the project's folder (`subst`) is the project. The lock that serializes edits of one file now takes the long name without the periods and spaces
Windows drops, so `new.txt.` and `new.txt` wait for each other.

Your own rule with exactly the value of one of Orbit's folder allows (such as `external_directory` for the global config
folder) now decides a place a link leads to; before, it was taken for Orbit's own allow and the question was asked.

**Affects:** Windows users who name a project through `Documents and Settings`, `Local Settings` or a share path, and
anyone whose path goes through a link to the project; code that matches on a failed tool call's `error.type` can see
`file.spelling`.

**What to do:** use the plain path of a file or folder on a local drive. Nothing else.

### Grep and Glob ask your Read rules about the path they search

Grep and Glob asked their own rules about the pattern only, so a Read deny of `*.env` did not cover a Grep of `.env`,
which sent the file's lines to the model. Both now ask your Read rules about the path they search, as a Read of that
path would, before they ask about the pattern: a Read deny of `*.env` refuses a Grep of `.env`, a Read deny of a folder
refuses a Glob of it, and a Read ask asks about the path. A search of a folder does not yet hold each file it finds to
your Read rules, so a Grep of `.` still reads a `.env` in it unless a rule covers the folder. A Glob does hold them: it
leaves out of its list every file that a Read deny of yours matches, decided without asking (a Read ask does not remove
a file), and the files left out do not count against the limit.

A Glob also lists differently now. It lists hidden files unless the call says `hidden: false`, lists files that
`.gitignore` names, sorts the files by modification time with the oldest first (it was the newest first), and stops at
100 files unless `limit` says otherwise. The tool description and the system prompt no longer say "most recently modified
first". Pinned by `test/tool-search.test.ts`.

**Affects:** people with Read rules that ask or deny, and prompts or plugins that relied on the order or on the omission
of hidden and ignored files. With a Read ask that covers the searched path, a search now asks
about the path as well as about the pattern, and an agent whose rules allow Grep or Glob but deny Read can no longer
search.

**What to do:** answer the question, or allow the path for Read in your own rules or the agent's.

### Every approval is drawn from the request, and names the folder, the method and the arguments

The terminal interface, Mini, ACP and the VS Code card used to work out parts of an approval from the model's own tool
input. They now draw only what the server put on the permission request. The request carries the absolute place of every
file a Read, Edit, Write, NotebookEdit, LSP or Patch asks about (a moved file's source too), the folder a shell command
runs in and a Grep or Glob searches, the method and URL of a fetch, the diff of each file with the place it is written to,
and the arguments of an MCP tool. So the terminal interface, Mini and VS Code now say which folder a shell, Grep or Glob
approval is for; an MCP call made through Code Mode shows its arguments, where it used to be approved by name alone; VS
Code and ACP take a NotebookEdit's file from the request; and an ACP approval and the updates of the call after it show the
place the tool acts on, where an ordinary tool call showed the path as the model spelled it, a link's own path included. A
key the model adds to its input, such as a `cwd`, a `files` array or an old field name, changes nothing that is shown.
An approval over ACP shows the server's diffs only. The finished call's own update of an Edit still builds its diff from the `old_string`
and `new_string` of the input, now at the place the tool reported. A file tool, a shell command, a Glob or a Grep reports the place
it resolved before it asks or acts (a `places` entry in its progress), so over ACP the updates of a call name the real place
even when no rule asks about it. An ACP tool call's `rawInput` is still the call's input, as before. The argument text of an MCP
call is shown whole, where it was cut at 2000 characters: in the terminal interface the prompt scrolls as a whole and the fullscreen view shows more, and the VS Code card writes out control characters, in the changed lines of a diff too, and keeps the command of a shell approval beside its folder. A fetch approval shows the URL the rules matched and the fetch connects to, without credentials and with an ASCII host, where it showed the spelling the model chose. The terminal interface and Mini list the resource of an MCP resource call and the id of a skill. The live pending call over ACP is sent with an empty input and names no place; when a session is loaded, each replayed call carries its recorded input (so its title and `rawInput` are as before) and names the places its record holds (a completed or failed call records them) and none for a call recorded without them. A shell call's `rawInput` keeps its declared `workdir` and gets a `cwd` only when it declared none.

**Affects:** people who approve calls in the terminal interface, Mini, VS Code or an ACP client, ACP clients that read the
locations, title or content of a tool call or an approval, and plugins or SDK callers that read the metadata of a
permission request. The request gains `metadata.paths` (and, per file, `place` and `from`) on file requests,
`metadata.method` on a WebFetch request and `metadata.arguments` on an MCP request, and `metadata.url` of a WebFetch request is
now the normalized URL; the metadata of a completed or failed tool call gains `places`. Nothing is removed.

**What to do:** nothing.

### Shell strings written as $'...' are read the way bash reads them

The command scanner decoded some `$'...'` escapes differently from bash, so a command could hide behind one. It now
ends `$'\c'` at its quote, keeps the character after `\c\` (`$'\c\/'` is 0x1c then `/`), keeps one byte of an octal
escape (`\456` is `.`), and refuses a heredoc delimiter written with an escape it cannot decode (`\x{..}`, a NUL, a
byte or code point of 0x80 or more written with `\x`, `\u`, `\U` or octal, a `\c` before a non-ASCII character, a
code point above U+10FFFF). Bash writes a raw byte for the `\x`, octal and `\c` forms, and bytes that depend on the locale for `\u` and `\U`, so
the scanner treats the word as dynamic. Such a command is now seen as two commands, or is refused.

**Affects:** people whose shell commands use these escapes; an approval may ask where it did not before.

**What to do:** Nothing; write the character itself instead of the escape if a command is refused.

### A file that changes while its edit waits for approval is not overwritten

`edit`, `write`, `patch` and `notebook_edit` used to write the bytes they had prepared even when the file changed while
the person was deciding. They now read every file they will write once more after approval, and write nothing if any of
them differs from what was shown: the call fails with the error type `edit.stale`. The file keeps the other writer's
content, and a file that appeared or vanished in the meantime counts as changed. For `patch` this covers every path, the
destination of a move included, and no path is written when one is stale. Only content counts: a file that was touched
or rewritten with the same bytes is not stale, but a change of line endings alone or of a leading byte-order mark is.

`write` now also waits for another `write` to the same file. A file that cannot be read
after approval counts as changed. `edit.stale` differs from `file.stale`: the first means the file changed during the
approval, the second that it changed since the session last read it. After either, read the file again and retry.

`patch` now shows what it replaces. An `Add File` hunk on a file that already exists is listed as `modified` with the
old lines as removed, not as `added`, and a move onto an existing file lists the destination as a second entry in
`metadata.files` (and in the result) with its current text as removed. A move destination that already exists must now
have been read by the session and unchanged since, as an `Add File` target must: otherwise the call fails with
`file.unread` or `file.stale` and nothing is written.

`patch` now also refuses, before anything is asked, a patch that reaches one file under two names: a `Move to` that
names its own source (the same path, another letter case on any case-insensitive file system, or a link or hard link to it), or two
hunks that name one existing file by different spellings (for a new file, letter case is compared on Windows and macOS). Such a patch used to delete the file. Rename a file's letter case with
the shell instead. An `Add File` over an existing file now keeps that file's byte-order mark, as `write` does.

**Affects:** code that reads a failed tool call's `error.type`, and anyone whose editor, formatter or script writes a file
while a change to it is waiting for approval: the change now fails instead of overwriting.

**What to do:** Read the file again and repeat the change. Nothing for code that does not read the type.

### Shell commands are judged by what they do: files outside the project, commands with no resource, and input Orbit cannot read

The shell tool and the `!` spans of slash commands now go through one gate. It analyses the command once, resolves every file
the command names to where it really is, and builds the requests from that. Before, the request held the commands the
scanner found, and the folder question held the folders the scanner found.

- For input Orbit can analyse, a file the command reads, writes, copies from or removes outside the project (a redirect
  target, a `cp` source, a `cat`) asks `external_directory` for its folder, judged where links really lead, in a trusted
  project too. Input that Orbit cannot analyse (see below), or that is over 10,000 characters, is read less closely: it asks for
  the folders that a `cd`, `pushd`, `Set-Location` or `Push-Location` fragment names (every word that is not a parameter and comes before a comment; for bash only the first operand,
  the value of `-Path`, `-LiteralPath` and `-PSPath`, and `$HOME`, `$env:NAME`, `${env:NAME}`, `$PWD` and `$PSHOME`
  expanded), and, in a project that is not trusted, for the folder that a link leads to when a plain word of a fragment
  names it. A target built as the command runs asks for the nearest folder before the built part. A file that such input
  names in other ways is not asked about. A new file under a link,
  a dangling link and a numeric link are judged where the write would land. A write under `os.tmpdir()` is outside like any
  other, unless the call runs in the sandbox, where the sandbox's writable folders count as inside for writes.
- A statement with no command, such as `> file`, and a PowerShell statement that is not a pipeline of commands (an
  assignment, an expression such as `[IO.File]::WriteAllText(...)`, an `if`, a loop, a function) is asked about by its own
  text. Before, its resources were empty and it ran under any `shell *` ask rule. A saved grant for the commands inside it does not cover it.
- For input Orbit can analyse, a person's `Read` and `Edit` deny rules now stop a shell command that names the file as a
  literal operand or target: `cat secret.txt` and `cp secret.txt copy.txt` for a `Read` deny, and a redirect target
  (`> out`), `tee out` and the output file of a read-class command (`sort -o out`, `uniq f out`, `find . -fprint out`,
  `tree -o out`, `sed -n 'w out'`) for an `Edit` deny, in both scanner modes (`test/tool-shell.test.ts`,
  `test/shell-guard.test.ts`). A file that a command reaches in another way is not covered yet: see the caveat under
  "What to do". A deny anywhere in a call (the shell request, the folder question, a path rule) blocks it before any question is shown. A
  `!` span of a slash command counts with the others: a deny on any span of the template blocks it before a question about
  the first. Plan mode's own deny of every edit is not such a rule: a command in Plan mode is still asked about, as it always
  was, and only an `Edit` deny of your own stops it. `New-PSDrive` is an ordinary PowerShell command that is asked about
  by its text (it can map a network share), not a change of location.
- Input Orbit cannot analyse, a syntax error or an unterminated quote included, is asked about as the whole text plus its
  fragments, with no "always allow", in both scanner modes. Before, the portable scanner refused it with an error and the
  default scanner asked about the commands it could find. A deny rule still blocks it, on the whole text or on a fragment, and a fragment answers to the cmdlet's aliases and its module-qualified spelling as parsed input does (`rm *` and `Remove-Item *` meet each other, however long the input is). Bash
  that uses an unknown variable, an unquoted heredoc, a function body or an array subscript is in this group, so it asks each time.
- PowerShell approvals come from PowerShell's own parser: the "always allow" pattern is the cmdlet's name (a program's name
  plus its subcommand words, and nothing for a shell, an interpreter, `Invoke-Expression` or a name that is a path), and a
  rule written with an alias meets the cmdlet and the reverse (`rm *` meets `Remove-Item x`) on Windows, where rules ignore case.

**Affects:** anyone who relied on a broad allow rule to run commands that read or write outside the project, a `> file`
statement or a PowerShell expression without a question, and plugin authors who read the shell request's `metadata`, which
now also carries `findings`.

**What to do:** Approve the folder once, or add an `external_directory` allow for it. Write an allow rule for the commands you
mean, such as `Bash printf *`. Until the follow-up that makes these asks unliftable (shell-safety-12), a broad allow rule
(the default `* *` allow included) still lifts a statement with no command and input Orbit cannot read, because it matches
every resource of the request. It also still lifts a target that is built when the command runs
(`Remove-Item (Join-Path ...)`) and a read through a glob, a .NET call or a nested shell, even when a `Read` deny names
the file: the deny meets only the files that Orbit can name before the command runs.

### A PowerShell command spelled as a path to a location cmdlet is asked about

`scripts\Set-Location .`, `& 'scripts\Push-Location'` and `Some.Module\Pop-Location` name a program or script of the
folder, not the cmdlet, yet the shell guard used to treat them as the location cmdlet and made no request, so a
`Bash * deny` rule (yours, a managed one or the Plan agent's ask) never saw them. The same happened to a location
cmdlet whose argument runs code, such as `Set-Location ([IO.File]::WriteAllText(...))` or `Set-Location -Path { ... }`
next to another command. Now only a plain `Set-Location`, `Push-Location` or `Pop-Location` (or an alias) with
constant, variable or parameter arguments is left out of the request; every other spelling is asked about as written
and is covered by deny rules, and a saved grant for another command does not lift it.

**Affects:** people on Windows PowerShell or PowerShell 7 whose rules deny or ask for `Bash`, and repositories that ship
scripts named like a location cmdlet.

**What to do:** Nothing. Ordinary `cd`, `Set-Location` and `Push-Location` calls still run without a question.

### Hooks and stdio MCP servers wait for the project folder to be trusted

A hook, and a stdio (`local`) MCP server, starts with the project's folder as its working folder, so `bun`, `npx`,
`uvx` and `git` read that folder's own files (a `bunfig.toml` preload, an `.npmrc`, a repository config) before your
script runs. Until the folder is trusted no hook runs, yours and your organization's included (one warning is logged),
and no stdio MCP server starts: it shows as failed with the reason, whatever its `cwd`. Granting the folder starts the
waiting servers at once, and hooks run from the next event. Remote MCP servers are not held. Before, only the project's
own hooks waited.

A `PreToolUse` hook is a guard, so it does not just stand aside: while the folder is not trusted, a tool call that one of
your or your organization's `PreToolUse` hooks applies to is refused, with a reason that names `/trust`, `orb trust` and
`--trust`, instead of going through as if no hook existed. Calls that no hook applies to run as before, and the other
events (which cannot stop a call) wait without refusing anything.

**Affects:** people who run `orb run` without `--trust`, the TUI, ACP editors and SDK hosts in a folder they have not
trusted, with hooks or stdio MCP servers in their user or managed config. A folder that holds nothing back shows no
trust dialog, so the hooks and servers wait without a prompt.

**What to do:** Trust the folder (`/trust` in the TUI, `orb trust`, or `--trust` on `orb run`) when you want your hooks
and servers there, and so that calls your guard hooks cover are judged by them again.

### An `external_directory` deny or ask also meets the folder a link or junction leads to

A file tool that reached a folder outside the project through a link, a Windows system junction (`Local Settings`,
`Documents and Settings`) or `/proc/self/root` was judged by the spelled folder only, so a deny or ask you or your
organization wrote for the real folder (for example `external_directory ~/.ssh/*`) did not apply. Read, Grep, Glob, the
language-server tool, Edit, Write, Patch and NotebookEdit now also check the folder behind the spelling, as they already
did for `Read` and `Edit` rules. An allow written for the real folder still does not lift a spelled path.

**Affects:** people with `external_directory` deny or ask rules, and managed settings that carry them.

**What to do:** Nothing. A path that is blocked by its plain spelling is now blocked by every spelling.

### A link inside a trusted project that leads out is asked about like the folder it leads to

Read, Grep, Glob, the language-server tool, Edit, Write, Patch, NotebookEdit and the shell's working folder used to follow
a link of a trusted project without a question, so `external_directory` rules (the built-in ask, and any deny or ask you
or your organization wrote) did not apply to a link such as `keys` pointing at `~/.ssh`, while the same folder named
directly, or by the shell, was asked about. They now ask `external_directory` for the folder the link leads to, and show
that folder as the place. Orbit's own allows still apply to it, because a trusted project's link is not an escape; the
extra mark that stops them is only for a project that is not trusted. A link to a network share is left as it was. A read
through such a link is outside the project, so it no longer picks up instruction files from the folder it leads to, as a
read of that folder by its own name never did.

**Affects:** people who work in a trusted project that has links to files or folders outside it, and anyone with
`external_directory` rules.

**What to do:** Answer the new question once, or allow the folder with `external_directory <folder>/* allow`.

### A chain of 41 or more links is judged like a short one

Windows follows a chain of up to 63 links, but Orbit stopped looking after 40 and then treated the path as having no
share and as lying inside the project. A repository with such a chain could make Orbit connect to a host it chose before
anyone was asked (when the chain ends at a share, even while its config loads or `orb trust` runs), and a write through a
chain that ends at a file outside the project was judged to be inside it, so no question was asked and deny rules for the
real folder did not apply. Orbit now follows up to 80 links, and a chain it gives up on is refused as a share is, or
reported as a place it could not resolve. A folder named `plugin` or `plugins` in a config directory that is itself a link
to a share is no longer listed when the trust status is read.

**Affects:** people who open repositories that contain links, on Windows.

**What to do:** Nothing. A chain that long is refused with the same message as a share.

### Managed `denied_domains` match an IPv4 address in its IPv6 spellings

An IPv4 address in the managed `denied_domains` list now also denies its mapped (`[::ffff:203.0.113.5]`), compatible, translated and well-known NAT64 (`[64:ff9b::203.0.113.5]`) IPv6 spellings, and an entry written in one of those spellings denies the dotted address. Before, such a URL missed the deny and fell through to the ordinary question or to your own allow rule.

**Affects:** organizations whose managed settings list an IP address in `denied_domains`.

**What to do:** Nothing.

### One bad field no longer drops its agent entry or its settings object

In any settings file, including the managed ones, a malformed field in an `agents.<name>` entry, or in an entry of the older `agent` and `mode` maps (`color`, `model`, `steps`, `mode`, `description`, `options`, or one entry of its `permission` object or `tools` map) now costs only itself, reported at its own path, and the entry's other fields and valid rules still apply. The same holds inside `sandbox`, `shell_tool`, `tool_execution`, `webfetch`, `websearch`, `worktree` and `warming`: a bad `sandbox.write` no longer takes `sandbox.enabled` with it. Before, the whole entry or object was dropped, so an organization's per-agent denies or `sandbox.enabled: true` could vanish because of one typo. An entry or object of which nothing is valid is still dropped.

**Affects:** anyone with a typo in one of these entries, administrators most of all; `orb doctor` lists each skipped field.

**What to do:** Nothing; fix the field that `orb doctor` names.

### A deny for the linked spelling of Orbit's own folders covers its real path

When the global config, data or temporary folder is reached through a link, Orbit allows it by both spellings. A deny or ask you wrote for the linked spelling (`external_directory ~/orbit-link/* deny`) now also decides a place named by the real path, and a deny written for the real path decides the linked spelling, as it did. Before, naming the real path directly fell through to Orbit's own allow. If a folder cannot be resolved at startup (a link loop), Orbit now keeps the spelled path and starts, instead of failing to build its agent and permission layers.

**Affects:** people whose config, data or temporary folder is a link and who wrote rules about it.

**What to do:** Nothing.

### `fhx` is a program under Windows PowerShell 5.1, and so is `lp` under PowerShell 7 on Windows

Orbit used to read `fhx` as `Format-Hex` in every PowerShell, and `lp` as `Out-Printer` in every PowerShell on Windows.
Some builds of Windows PowerShell 5.1 have no `fhx` (the Windows Server 2025 image of GitHub's runners is one), and
PowerShell 7 on Windows has no `lp`. A shell without the alias runs whatever program of that name it finds on PATH, so
Orbit now reads `fhx` as `Format-Hex` only under PowerShell 7 and `lp` as `Out-Printer` only under Windows PowerShell
5.1. Elsewhere each is an unknown program: `fhx` under 5.1 is no longer read-only and is asked about.

**Affects:** people on Windows PowerShell 5.1 who run `fhx`.

**What to do:** Write `Format-Hex` in full under Windows PowerShell 5.1 to keep it read-only.

## Plugins and SDK

Changes to the tool API that plugins and code built on the SDK use.

### Tools can declare traits, and a tool's context carries them

A tool registered through a plugin or the SDK can now declare `traits`: whether a call is read-only, safe to run beside
others or destructive (each a boolean, or a function of the decoded input that answers with a boolean), and fixed
values such as `openWorld`, `interruptBehavior`, `maxResultChars`, `searchHint` and `displayName`. For every call, Orbit
resolves them and passes the answers to the tool as `context.traits`. A trait a tool leaves out takes its default: not
read-only, not concurrency-safe, not destructive, and `block` on interrupt.

A call whose traits cannot be resolved gets conservative traits instead: not read-only, not concurrency-safe,
destructive, and `block` on interrupt. That happens for a tool that is unknown or was not offered in the request, for
input the schema rejects or fails to decode when a predicate needs to read it, and for a predicate that throws, fails
or answers with anything but a boolean; the last case, and a schema that throws, are also logged. What a known tool
declares about itself (`openWorld`, `requiresUserInteraction`, `cancelSiblingsOnFailure`, `maxResultChars`,
`searchHint` and `displayName`) does not depend on the call, so a broken predicate leaves it as declared. Only
`readOnly` may relax a permission decision, and a failing predicate never leaves it true. Nothing schedules, cancels
or limits calls by these traits yet, so tools run as they did before.

A registration whose traits are invalid is skipped with a log line, as other invalid registrations are, and the tools
beside it still register, in an Effect plugin and in a Promise plugin alike. Invalid means an empty `displayName` or
`searchHint`, a `maxResultChars` that is not a positive number (`Infinity` is allowed, and declares that the result is
never to be written to a file), an `interruptBehavior` other than `cancel` or `block`, a trait of the wrong type, or
`traits` that is not an object, such as text, a number, `null` or an array. An update that would leave a tool with
invalid traits keeps the earlier definition.

**Affects:** plugin authors and code built on the SDK. `Tool.Context` gains a required `traits` field, so code that
builds a context by hand, for example to call a tool's `execute` in a test, must add it. `Tool.Snapshot` gains `traits`
and `describe`, and the prepared model request gains `toolTraits` and `describeTool`, so code that implements either
must add them. The SDK exports `Traits` and `ResolvedTraits`, and a Promise plugin declares predicates that answer with
a boolean or a Promise of one.

**What to do:** Nothing for plugins that are already running; declaring `traits` is optional. If your code builds a
context by hand, add a `traits` record to it; the defaults are every boolean `false` and `interruptBehavior: "block"`.

### Tools can fail with a code, and refuse a call in `validate` before they ask for permission

`Tool.Error` has a new optional `code`, a string that names the failure. It becomes the error `type` of the failed call
and decides over the type of the `error` that the failure wraps; without a code the type is `tool.execution`, as before.
The SDK exports `ErrorCode`, the codes that Orbit gives its own failures, and a plugin may use any other string.

A tool can also declare `validate(input, context)`. It receives the decoded input and the same context as `execute`,
traits included. It runs after the `execute.before` hooks and after the input is decoded, and before `execute`, so a call
that it refuses never reaches the tool's own permission requests. In an Effect plugin it fails with a `Tool.Error`. In a
Promise plugin it throws or rejects, and the adapter turns that into a failure. A `Tool.Error` with a code keeps it; a
`Tool.Error` without one and any other failure become `tool.validation`, with the message of the failure. A defect, a
decline and an interrupt pass through as they do from `execute`. `validate` must not ask for permission or change
anything, and `execute` must check again whatever it relies on, because the state can change in between.

A registration whose `validate` is not a function is skipped with a log line, as other invalid registrations are, and
the tools beside it still register, in an Effect plugin and in a Promise plugin alike. An update that would leave a tool
with such a `validate` keeps the earlier definition.

**Affects:** plugin authors and code built on the SDK. `Tool.Info` gains an optional `validate`, and a Promise plugin's
`Tool.Info` declares it as `(input, context) => void | Promise<void>`. Code that builds a `Tool.Info` by hand or wraps
one is not affected, and a wrapper that replaces only `execute` keeps the tool's `validate`.

**What to do:** Nothing for plugins that are already running; both additions are optional.

### A tool's `searchHint` helps Code Mode search find it

A tool's `traits.searchHint` was accepted and ignored. Code Mode's `search` now matches it: a program that searches for a
word in the hint finds the tool. A match in the hint counts for less than a match in the tool's name and for more than
one in its description. The hint only ranks the tool; `search` and the catalog return the same fields as before. It
applies to the tools that Code Mode offers, which is every tool that does not set `codemode: false`. A tool that sets it
is advertised to the model directly and is not searched. `Tool.make` in `@orbit/codemode` takes the same `searchHint`
option.

How a tool is offered did not change, and `Tool.Options` now documents it: `codemode: false` advertises the tool
directly, leaving `codemode` out or setting anything else defers it into Code Mode, and `pinned: true` also keeps a
deferred tool in the catalog that the model sees first. There is no separate `defer` or `alwaysLoad` option. Core reads
these two options in one place, `ToolTraits.exposure` and `ToolTraits.pinned` in `@orbit/core/tool/traits`.

**Affects:** plugin authors and code built on the SDK or `@orbit/codemode` whose tools declare a `searchHint`: the order
of their Code Mode search results changes, and a tool can now appear for a word that only its hint contains. Code that
reads `options.codemode` or `options.pinned` of a registration to tell where a tool goes can ask the two functions
instead.

**What to do:** Nothing. To make a deferred tool easier to find, give it a short `searchHint` of the words someone
would use for it.

### Side queries run on the small model

`SideQuery` in `@orbit/core/side-query` runs one non-streaming model call on behalf of a session: `text` returns text
and `object` returns a value decoded from a single forced tool call. It uses the small model of the session's
provider, then the session's own model, always with the variant that reasons least (a session on `#high` still runs
its side queries at the lowest variant its model lists), and `agents.side.model` pins the choice; a pinned model that
the catalog does not list falls through to the small model. With `history: true` the session's tool definitions go
along, and the model may not call them. Nothing is added to the conversation. The cost lands on the session through a new durable event,
`session.side_query.recorded`, which `orb stats` counts in its cost and token totals; `session.usage.recorded` is
unchanged. A side query fails with `UnavailableError`, `InvalidOutputError` or `TimeoutError`, and never fails the
session. Title generation now picks its model through the same `SessionContext.selectAuxiliary`.

**Affects:** plugin authors, and anyone who reads the event log or `orb stats`: `generate` hooks see side queries with
`agent` set to `side`, and the new event type appears in the log. An older Orbit build that shares the database skips
the event, so only its `orb stats` totals leave side queries out; the cost still reaches the session row.

`agents.side.model` is withheld in an untrusted folder; see "A folder's model, provider and budget settings wait for
it to be trusted" under Configuration.

**What to do:** Nothing. A `generate` hook that should ignore side queries can return early when `agent` is `side`.

### Built-in, Code Mode and MCP tools declare traits, and simulated tools can

Orbit's own tools now declare their traits: `read`, `glob`, `grep`, `lsp`, `webfetch`, `websearch`, the MCP resource
tools, `skill`, `models`, `task_list`, `shell_output` and `shell_watch` are read-only and safe beside other calls, and
the file-changing tools, `todo`, `task_create`, `task_update` and the session tools are not. `question` and the plan-mode tools wait
for the person, `patch` is destructive when it deletes or moves a file or cannot be parsed, `memory` is read-only for
`read` and `list` and destructive for `delete`, and the Code Mode `execute` tool is neither read-only nor safe and reaches the network.
The shell declares only that a failure cancels its siblings. Nothing schedules or limits calls by these traits yet, so
tools run as they did before.

An MCP server's annotations map onto the traits of its tools, and they are treated as claims, not facts. `readOnlyHint:
true` makes a tool safe to run beside other calls and nothing else: an MCP tool is never read-only, its permission
request is the same with or without the hint, and plan mode and the read-only allowances never apply to it. A tool is
destructive unless it says `readOnlyHint: true` or `destructiveHint: false`, and open-world unless it says
`openWorldHint: false`, as the MCP specification defaults; both only inform how a call is shown. A `title`, or the
title in the annotations when that is blank, becomes the tool's `displayName`, trimmed. It is text the server chose, so
control characters and format characters such as a right-to-left override are stored written out (`\x1b`, `\u{202e}`).
A blank title gives no display name and the tool still registers.

A simulated tool registration (`tool.attach` in the simulation protocol) can carry a static `traits` record with the same
booleans, `interruptBehavior`, `maxResultChars` and `displayName`. Without it the tool is not safe and runs alone.

**Affects:** plugin authors who read `Tool.Info.traits` of the built-in or MCP tools, and drivers of the simulation
protocol, which accepts one more optional field.

**What to do:** Nothing.

### A tool's display name on its input event

When a tool declares a `displayName`, the `session.tool.input.started` event now carries it, and the projected assistant
tool message (`Session.Message.Assistant.Tool`) exposes it, so a client can show the name a tool chose for people. The
name is stored with control and format characters written out (`ESC` as `\x1b`, a right-to-left override as `\u{202e}`),
because the event is durable and outlives its source. A session file imported with `orb session import` is escaped the same
way. A tool that declares none, and a provider-hosted tool, leave the
field out, and events written before this change decode as they did.

**Affects:** SDK and client callers that read `session.tool.input.started` or assistant tool content, and the generated
client types, which gain one optional field. `@orbit/flow/plain` still exports the same escapers, which now live in
`@orbit/util/plain`.

**What to do:** Nothing. Show `displayName` when it is present and fall back to `name`.

## Agent loop

Changes to how a turn runs: what a response may call, and how its failures are told apart.

### A tool call the model did not finish writing no longer runs

When a response ended in the middle of a tool call, for example because the model reached its output limit, Orbit
rebuilt the arguments from the half-written text and ran the tool with them, so a `write` call cut off inside its
`content` wrote a truncated file. Routes that close each call before the finish reason arrives did this. A call rebuilt
from incomplete arguments now runs only when the response finishes with `tool-calls` or `stop`. If the response finishes
any other way (an output limit, a content filter or an unknown reason), or the stream breaks first, the call is dropped
and the tool does not run. After an output limit the input is recorded as failed with `tool.input-truncated` and the
response is resumed up to three times in a row (see "A response cut off by the output limit is resumed"); otherwise it
fails with the response's own error. A call whose arguments arrived complete is not affected, and still runs when a
later call in the same response was cut off. A call with no argument text at all is held the same way, because a call
cut off before its first argument token cannot be told from a call to a tool that takes no arguments: it runs with empty
arguments once the response finishes with `tool-calls` or `stop`, and is dropped after any other finish. Every route does
this, including the routes that run through the AI SDK, which used to run such a call with empty arguments. The one exception is a call that another block (a tool call, text or reasoning) follows: only the last block of a
response can be cut off, so that call was complete and is released as soon as the next block starts. The cost is that a
call with no arguments, when it is the last block, starts when the response finishes, not mid-stream.

Held calls keep the order the provider sent them in. A call that arrives behind a held one waits and is released with
it, so `task_list` followed by `task_update` still runs in that order, and a failing shell call sent after a
no-argument call no longer cancels it. When the response is cut off, only the held calls are dropped and the calls
behind them still run in order. Provider-executed calls are not held.

A cut-off call no longer counts as the evidence that its response finished. Two kinds of stream used to report
`tool-calls` because such a call was in them, which released the call: a Responses-style stream that the provider ended as
incomplete, with no reason or a reason Orbit does not know, and a Chat-style stream that ended without a finish reason
from a model whose `compatibility.requireFinishReason` is `false`. Both now report an unknown finish, so the call is
dropped (a call with no argument text in the second kind is a call to a tool without arguments and still runs), and the session handles the response as it handles any unknown finish: as an incomplete stream, which it
retries or continues. The first kind reports an unknown finish even when every call in it is complete, where it used to
report `tool-calls`; those calls still run.

**Affects:** sessions whose model reaches its output limit while writing a tool call, most often a large `write` or
`edit`, and sessions on a Responses-style provider that ends a response as incomplete without saying why, which the
session now retries or continues instead of treating as finished. It also affects code built on `@orbit/ai`: a
`tool-call` event carries `partialInput: true` when its input was rebuilt, `LLMClient.stream` and `generate` hold such a
call back until the response finishes and drop it unless the finish is `tool-calls` or `stop`, and `TestLLM` follows the
same rule for scripted responses.

**What to do:** nothing. If a large write keeps being cut off, ask the model to split it.

### Overloaded providers are classified, and an overload sent as a 429 is no longer a rate limit

A provider failure that says it is overloaded now carries `classification: "overloaded"` on its `ProviderInternal` error
reason, and `isOverloaded(error)` from `@orbit/ai` reads it. The evidence is status 529, the `overloaded_error` and
`server_is_overloaded` codes, or "overloaded" or "at capacity" in the error text of a 5xx or of a failure that carries
no error status. "Unavailable", "busy" and other server failures stay unclassified. An overload code now wins over
status 429, so a gateway that reports an overload as a 429 produces a `ProviderInternal` failure, which is the session
error `provider.internal`, where it used to produce a `RateLimit` one, `provider.rate-limit`. Both are retried, so
retries do not change.

**Affects:** code that matches on provider error reasons or on the session error type, and `orb flow` workflows whose
`retryOn` lists `rate-limit` without `transient`: such a 429 is `transient` to them now, so they no longer retry it.

**What to do:** nothing unless you match on `RateLimit` to detect these failures. Match `isOverloaded(error)` for an
overload, and add `transient` to a `retryOn` that lists `rate-limit` alone.

### A prompt's step, cost and token limits are enforced

A prompt could already carry `turn: { maxSteps, maxCost, maxTokens }`, and the options were recorded but ignored. The
runner now checks them at the start of every model step, before the automatic compaction and the request of that step,
and again before each retry of a step. When the turn has reached a limit, the busy period ends as failed with the
session error type `limit.steps`, `limit.cost` or `limit.tokens`, after the tools of the last response have settled and
with no partial response left behind. A cost limit that cannot be checked is refused with `limit.cost-unknown`
instead, as described below.

Not every request is checked. Title generation, a compaction that recovers from a context overflow, and a manual
compaction start without the check, and their spend counts at the next one. A subagent also checks the cost and
token limits of every turn above it before each of its own steps, counting what that turn has spent so far, siblings
included, so a subagent stops with `limit.cost` or `limit.tokens` instead of overshooting by a whole run; the parent's
step limit counts only the parent's own responses and never stops a subagent. A response is still priced after it
arrives, so the overshoot is at most one response. A subagent is limited by the turn that was open when its latest
prompt was admitted, not when it was delivered, even after that turn ends: a continued subagent belongs to the turn that continues it, not the one that
created it, and a background subagent that is still running when the turn ends, whether it succeeded, failed or hit the
limit, stops at the same cost or token limit, counting what the turn had spent. The completion notice of a background
subagent or a background shell job, like any other synthetic message that no prompt of the user began, wakes the Session
into a new turn that continues the limits of the turn before it, counted from the prompt that set them. A turn that holds a
prompt of the person's is never such a wake-up, whatever synthetic input (a plan reminder, editor context) was parked in front of it: the
prompt's own options, or none, apply. A response is priced after it arrives, so a
turn can also overshoot a cost or token limit by one response.

The window starts at the prompt that set the options. A queued prompt without options, or a prompt sent after the busy
period ended, runs without limits, and a steered prompt with its own options starts a new window. A prompt sent while a
limited turn is finishing joins that turn, and fails at once if the limit is already spent. Only responses that ended
count as steps: a retry before output, and a response that failed mid-stream, do not. Cost and tokens add the Session's
responses and its compaction and title usage, and the responses and usage of every subagent it started in the window.
These limits, the subagent binding above and the side-query and compaction totals of `orb stats` read two tables that the
session projector always fills (`session_usage`, `session_admission`), not the event log, which a server keeps only when
it is built to persist events. `orb serve`, the background service and `--standalone` do not, so before this change a
title or compaction cost was missing from the limits and from `orb stats` there, and a background subagent was not bound
to its parent's turn. A database that kept its events has them copied into `session_usage` when it migrates.

A cost limit never reads spend of unknown price as free, and a price of zero is not a price. It is refused with
`limit.cost-unknown`, a refusal and not a limit that was reached, when the model has no tier-less price above zero (a
catalog model without a price is listed as zero), and when anything in the window, the Session's own or a subagent's,
carries tokens with a cost of zero, a finished response carries no cost or no tokens, or a response failed mid-stream
with no cost. So a free model cannot run under a cost limit; use a step or token limit for it.

**Affects:** SDK and HTTP callers that send `turn` limits and clients that show session errors.

**What to do:** Nothing unless you send limits. Handle the four `limit.*` error types, and give models that you run
with a cost limit a price.

### VS Code asks whether to trust a folder, and starts only the `orb` of your own settings and PATH

The extension could not trust a folder, and it started whatever `orbit.executable` named, a setting that a repository's
`.vscode/settings.json` could set, with the workspace folder as its working folder.

- **The question.** The extension asks the server whether the folder its chat works in is trusted (see "A project's
  config waits for its folder to be trusted" above) when the chat starts, whenever the server reports a grant, a revoke,
  a change of config or a new connection, and before each message. While the folder is untrusted and holds something
  of its own back, a banner above the chat says what Orbit leaves out and lists the files that hold it, an "Orbit ·
  untrusted" item in the status bar says so too, and **Orbit: Trust This Folder…** (offered only then) asks. Each of the three opens a dialog with
  **Trust this folder** and **Not now**, and closing the dialog is "Not now". The first message in such a folder asks
  before a session exists or the model is asked anything, once per folder until the window is reloaded: "Not now" lets the
  message go on without what the folder holds back, and the banner stays. Nothing is asked in a folder that is trusted or
  holds nothing back. A home directory or a filesystem root is offered "Trust until Orbit restarts" instead, as in the
  terminal UI.
- **One folder.** Trust belongs to the project's folder, which is not always the one VS Code opened: a folder inside a
  repository, or a linked worktree, shares its project's decision. The dialog and the banner name the project's folder as
  the server reports it, and say which folder VS Code opened when it is another. The grant is made for the project's
  folder, and counts only when the server's answer names that folder and then reports the folder VS Code opened as
  trusted too. If either does not, or the second read fails or is late, the chat does not treat the folder as trusted,
  goes on as after "Not now", and says so.
  Config in a folder above the project is named, with no command to trust that folder, because a grant always goes to
  the project's folder and that is not always the folder that holds the config.
- **When the server cannot say.** Each read of the answer waits two seconds, and a grant ten. Once the server has
  answered, a read that does not come in time, fails or sends something that is not a trust status leaves the last
  answer in place with a line in the Orbit output channel, and the chat goes on: the server applies the same rules
  whether the extension asked or not. A withheld entry that does not fit is left out alone. A server older than
  workspace trust has no such route and would apply the folder's hooks and servers unasked, and one that has not
  answered at all may be such a server, so nothing that names the folder is sent until some read has been answered.
  A message is not sent and no session is created (the chat says the server's trust could not be reached, or, when the
  server answered that it has no such route, to run `orb service restart`), the model list stays empty, the output
  style is not written, and choosing a model or a mode changes only the extension's own choice. After the service is
  restarted the model list is fetched again without reloading the chat. The Runs view writes out the text of a run
  store that a clone ships, and ignores usage figures that are not numbers.
- **The program.** `orbit.executable` now has machine scope, so only your user settings, or those of the remote machine,
  can set it; a workspace's or a folder's value is ignored. The extension also declares that it does not support
  untrusted workspaces, so it stays off in VS Code's Restricted Mode until you trust the workspace in VS Code, which is a
  decision of its own and does not trust the folder for Orbit. The extension finds `orb` on PATH itself, skipping empty
  and relative entries, and starts it by its full path: on Windows a program started by a bare name is looked for in the
  working folder first, so an `orb.exe` committed to a repository ran when the Runs view listed its runs. A name with a
  directory in it that is not a full path, such as `.\orb.exe`, is refused. On Windows only a `.exe` or `.com` is started,
  as before.
- **Terminals.** **Open orb in Terminal** and the Runs view's terminals start that program, by its full path, as the
  terminal's own process. **Open orb in Terminal** used to type `orb` into your shell, where `cmd.exe` would look in the
  workspace folder first, and it left that shell open after `orb` quit. Now no shell is involved.

**Affects:** VS Code users, and anyone who set `orbit.executable` in a `.vscode/settings.json` or a workspace file, which is
now ignored. Everyone who opens a folder that holds project config sees the banner and the first question.

**What to do:** choose "Trust this folder" for each repository you trust, or run `orb trust` in it. Move `orbit.executable`
into your user settings, and give it the full path of `orb` if `orb` is not on PATH.

### A stalled stream on the default endpoint fails after 90 seconds of silence

A streamed response that sends no bytes for 300 seconds used to be treated as stalled for every provider. For one
provider's first-party default endpoint, whose stream sends periodic keepalive pings, the limit is now 90 seconds. The
run then retries the request, or continues after output, as it does for any dropped stream. A custom `baseURL`, such as
a gateway or proxy that may buffer or drop pings, keeps 300 seconds, and so does every other provider. A plugin that
moves a request to another `baseURL` in `model.request` also gets 300 seconds; one that only rewrites the URL in
`http.request` does not change the limit, which was chosen from the configured `baseURL`. An unset `chunkTimeout` no
longer pins 300 seconds in front of a provider default, so a provider can supply a shorter one.

**Affects:** people whose first-party stream goes silent for more than 90 seconds, including pings, for example behind
a network device that drops keepalives.

**What to do:** nothing in most setups. To allow longer silence, set `chunkTimeout` in the provider settings, or
`false` to turn the limit off.

### Failed model requests retry sooner, more often and for longer

A session step or compaction that fails with a transient error, an overload included, now waits 0.5, 1, 2, 4, 8 and
16 seconds, then 32 seconds for the remaining four of its ten retries, with 20% jitter. It used to wait 2, 4 and 8
seconds, then 10 seconds. A provider that stays down now holds a step for about 160 seconds before it fails, where it
held it for about 84. A provider's `Retry-After` still sets the minimum wait, capped at 15 minutes.

Timeouts still stop after 3 retries, and more of them count: WebSocket idle timeouts, and the response-header and
stream-idle timeouts of providers that use the AI SDK path. Session titles and `generate` calls never retry an overload;
they send one request.

**Affects:** people on an overloaded or unavailable provider, and plugins whose `retry` hook reads the proposed delay.

**What to do:** nothing. A `retry` hook can still shorten or stop the wait.

### `/cost` (alias `/usage`) shows what a session has cost

A new `/cost` command, also reachable as `/usage` and from the command palette as "Cost and usage", opens a dialog with
the session cost, its input, output, reasoning, cache read and cache write tokens, its wall-clock and API time, and a
breakdown by model. The session cost is the figure the prompt footer and sidebar show, including the spend of its
subagents; a Subagents line gives that part, and the tokens, breakdown and times stay this session's own. A cost that
the listed responses do not explain, such as undone responses, shows as Other. A model that has no price entries at all,
such as one you added in config, reads "unknown" rather than `$0.00` (the server records zero for it). A free model,
and a catalog model whose price is listed as zero, read `$0.00`, and the dialog cannot tell those two apart. A response
that failed with no recorded usage counts as unpriced. In a forked session the dialog counts only the forked session's
own responses, not the ones copied from the parent. API time runs to the end of each provider response and leaves out
tool execution and waiting on you. A time that older messages do not carry reads `-`. When older messages are not
loaded, the breakdown and API time say they cover only the loaded responses.

**Affects:** people who type `/cost` or `/usage` into the prompt. A user or project command with either name was
possible before; typing the name and pressing Enter now opens the built-in dialog instead of running that command, and
when the names collide both appear in autocomplete.

**What to do:** rename your own `cost` or `usage` command if you want Enter to run it; otherwise nothing.

### Tool calls in one step run in order, and only safe ones run together

A step used to start every tool call the moment the model finished writing it, all at once. Calls now start in the order
the model wrote them, and each waits for its turn. A call that a tool declares concurrency-safe (reads, searches, fetches)
runs beside other safe calls, up to `tool_execution.max_concurrency` at a time (default 10). A call that is not safe
(an edit, a shell command, a Code Mode `execute` call) runs alone, after the calls before it have finished, and the calls
after it wait for it. Calls start while the model is still writing later ones, and results still reach the model in
the order of the calls. A call that is waiting reports `{ "queued": true }` in its metadata until it starts; the bundled
clients do not show it yet.

A decline stops the queue. When you decline a call, the calls that have not started are not run and finish as
"aborted", as the declined call does. When you reject a call with feedback, the calls that have not started finish as
`tool.cancelled`, and the model sees your feedback and carries on. Calls that are already running are left to finish.
This holds for a call the model makes directly, including a direct MCP tool. It does not yet hold when the rejected call
is inside a Code Mode program: that program receives the feedback as an error result, and the calls queued behind it
still start and can ask. A permission prompt whose call is interrupted now closes in the terminal UI and the other
clients that follow permission events; the ACP client does not close it yet.

Subagents are tool calls too, so one step starts at most `max_concurrency` of them at once.

**Affects:** people whose model writes several edits, shell commands or other calls that change things in one response,
which used to overlap and now take turns; anyone who set no limit and relied on a large number of safe calls running
together; clients that show tool progress, which may now see `{ "queued": true }` on a call that has not started.

**What to do:** nothing in most setups. To change how many safe calls run together, set `tool_execution.max_concurrency`
to a positive whole number in your own config. A project's config cannot raise it above 10 until you trust the folder.

### A failed certificate check is no longer retried

When a connection to a model endpoint failed because its certificate could not be verified (a self-signed or unknown
issuer, an untrusted chain, an expired or not yet valid certificate, or a host name that does not match), Orbit treated
it like any other network failure and retried it for about 160 seconds before showing anything. A failed certificate
check gives the same answer every time, so it is now shown at once, with the verification message. Other network
failures, such as a reset or refused connection, still retry as before. This also covers the token request of a gateway
provider. Under Node, a verification result that Node does not name (a weak signature digest, a name-constraint
violation) is recognized by the generic `UNSPECIFIED` code on the cause of a failed fetch; under Bun every verification
result has a name. Cloudflare workerd reports no code, so a failed check there still retries.

**Affects:** people who reach a model endpoint behind a private certificate authority and have not yet told Orbit to
trust it, and scripts that waited out the retries.

**What to do:** trust the authority with `ORBIT_CA_CERTS` (or `NODE_EXTRA_CA_CERTS`), or fix the endpoint's certificate.

### New `fallback_model` setting

The root `fallback_model` setting names a model, as `provider/model#variant` or as `{ providerID, model, variant }`, to
use for the rest of a turn after the selected model is repeatedly overloaded (see the note on switching below). A
model that is unavailable, or is the session's own model, is ignored.

In a folder that is not trusted yet, `fallback_model` is left out whole, so a repository cannot choose your fallback
model. Orbit uses your own setting until you trust the folder.

**Affects:** people who want a backup model, and anyone reading `config.get`, which now lists the key.

**What to do:** nothing. Set `fallback_model` in your own config to use it.

### A response cut off by the output limit is resumed

When a model response stops because it reached its output limit, Orbit now adds a short hidden note asking the model to
resume where it stopped and sends the request again, up to three times in a row. Before, the turn ended with the cut-off
text. A tool call that was still being written when the limit hit is never run: it is recorded as failed with the error
`tool.input-truncated`, so the model learns it did not run and can issue it again in full. After three resumes in a row,
the next cut-off stays as it is. The count comes from the session's stored messages and starts over after any response
that finishes with `stop` or `tool-calls` and after a new message from you. A compaction does not reset it. The limit holds whether the
cut-off response was text only, ran a tool or ended inside a tool call. If a turn limit (`maxSteps`, `maxCost`,
`maxTokens`) is already spent at a cut-off, including the third resume's, the turn fails with that `limit.*` error and
no note is written. A text-only cut-off is resumed within the same step, so it shares that step's retry allowance, as
an incomplete stream's continuation does; the allowance is bounded. A text-only cut-off is always resumed first, also
when a steered message from you is waiting: the resume request does not carry that message, and the message is
delivered after the resumed reply, at the next step boundary (a change from the build before this one, which delivered
it at once instead of resuming; pinned by `test/session-runner.test.ts`). A steer that arrives during a resume waits for
at most the three resumes, and a steer withdrawn during the cut-off leaves the reply resumed, not left unfinished.

**Affects:** anyone whose model answers or tool calls are long enough to hit the output limit, and clients that list a
session's messages, which now see an extra note with `metadata.notice` set to `output-limit` and no description.

**What to do:** nothing. Raise the model's output limit, and raise or unset `output_token_cap` if you set it, if you
would rather avoid the extra requests.

### New `output_token_cap` setting

The root `output_token_cap` setting is a positive whole number of tokens that caps how much a model may write in one
request. A reply cut off at the cap is resumed like any other cut-off (see the output-limit note above), so the cap
limits each model request, not the whole reply. Compaction summaries and titles keep their own limits. Every agent
request, including a subagent's, asks for the smaller of the cap and the model's own maximum, and the cap is applied
before `session.context` hooks run, so a hook can still change it. It reaches every provider, including one whose
adapter otherwise omits the default limit, and `session.context` hooks see it as `outputTokenCap` when it lowered the
model's limit (except while an escalated retry is in effect, see the retry note below). The one exception is a model
that rejects an output limit at its highest reasoning effort, where Orbit sends none. The cap never raises a limit. Left unset, requests are unchanged. Zero, a negative number or a fraction is
reported and ignored. With a cap of 1,024 or less, every request from a model with a fixed reasoning budget is refused;
below about 2,000, most of the cap goes to reasoning.

In a folder that is not trusted yet, `output_token_cap` is left out whole, like the other settings that choose a model
or a budget. Orbit uses your own setting until you trust the folder.

**Affects:** people who want to bound each model request, and anyone reading `config.get`, which now lists the key.

**What to do:** nothing. Set `output_token_cap` in your own config to use it.

### A run switches to the fallback model after three overloads in a row

When the provider reports that the model is overloaded three times in a row within one step, Orbit now switches to the
fallback model, if one is set (`fallback_model`, or `turn.fallbackModel` on the prompt) and it differs from the
session's own model. The switch is immediate, with no wait, and the retry allowance starts again on the new model. Any
other failure between two overloads, such as a rate limit, restarts the count, and so does a response cut off by the
output limit. If the overloaded response had already produced text, that response stays failed and the step continues
from it on the fallback model. The conversation gets a `synthetic` message with `metadata.notice` of `fallback` and a
one-line `description` naming both models; the message also tells the model that it was switched. The fallback lasts
until the next turn starts (a queued prompt, or the first prompt after the session went idle) or until you switch model
yourself. Orbit reads it from that message, so a restart or a moved location keeps it. The message comes before the
fallback model's answer, never after it. The failed attempt's empty draft stays ahead of the message; it is closed
without a finish, left out of requests and not counted as a step. No new event type is added.

**Affects:** anyone with `fallback_model` or `turn.fallbackModel` set, and clients that print `synthetic` messages.

**What to do:** nothing. Without a fallback model, an overloaded step keeps retrying the selected model as before.

### A failed shell call cancels the calls that ran with it

When a `shell` call times out, is killed by a signal, cannot be started (on Linux and macOS; on Windows a shell that
cannot start looks like exit 1 for now) or is removed by a client while it runs, the other calls of the same model response
that have not finished no longer run on. Calls that have not started never start. A call that is still running is
interrupted. Each of them ends with the error type `tool.cancelled` and a short note that names the tool, and the step
carries on: the model sees those results and answers. A permission denial, a rejection with feedback, a call that
failed validation and a non-zero exit code do not cancel anything. A plugin tool takes part by declaring
`cancelSiblingsOnFailure` and returning `metadata.error: true`, on its result or on its `Tool.Error`. A subagent that
is cancelled this way now also shows its child session ID in the failure message. Today a shell call runs alone, so in
practice the calls cancelled are the ones queued behind it and the ones streamed after it.

**Affects:** people who ask for several tool calls at once, clients that show tool results, and plugin tool authors.

**What to do:** nothing. A client that matches on error types can treat `tool.cancelled` as "did not run to the end".

### A new message from you cancels tools that can be cancelled

Sending a message while a step is still running (the default delivery, "steer") now cancels the tool calls that are
safe to drop, such as reads, searches and web lookups, including ones still waiting to start. The model sees them as
cancelled and your message is delivered at the next step boundary. An open question from the agent is closed too.
Tools that must finish, such as shell commands, subagents and tools from MCP servers, keep running, and calls queued
behind them still run in order. If you cancel the steered message or move it back to the queue before it is delivered,
calls already cancelled stay cancelled, and cancelable calls that stream in later in the same attempt are cancelled too. Queued messages and background
completion notices never cancel anything. Before, every call ran to the end before your message was delivered.

**Affects:** anyone who types or sends a prompt while Orbit is running tools, including SDK and API callers.

**What to do:** Nothing. Send the message with delivery "queue" to let running calls finish first.

### A reply cut off at `output_token_cap` is retried once at the model's maximum

When a reply that ran no tool stops at the output cap that `output_token_cap` set, Orbit now repeats the same request
once with the model's own maximum before it resumes the reply (the resume works as described in the output-limit note
above). A reply that made any tool call before the cut-off, a provider-hosted one included, is resumed as before and is
never repeated, since a repeat would run and bill the call again. The cut-off attempt and a hidden
note with `metadata.notice` set to `output-escalation` (and `metadata.replaces` naming that attempt) stay in the
session's messages but are left out of every later request, token estimate, compaction summary and regenerated title, including in a fork,
whose copy of the note names the copied attempt. The larger limit lasts until a response ends normally. While it lasts,
`session.context` hooks see the model's maximum as `maxTokens` and no `outputTokenCap`. A compaction does not end it, and
a stretch escalates at most once however often it compacts. A `session.context` hook that changes or removes the
output limit keeps the limit it chose, and a request already at the model's maximum is not repeated. A steered message
that is waiting does not skip the repeat: the repeated request does not carry it, and it is delivered after the reply
(pinned by `delivers a waiting steer after the escalated retry` in `test/session-runner.test.ts`).

**Affects:** people who set `output_token_cap`, and clients reading session messages, which now see the hidden notice.

**What to do:** nothing. Unset `output_token_cap` to avoid the extra request.

### `orb run` takes limits and a fallback model, and its result says why it stopped

`orb run` and `orb -p` take `--max-steps` (alias `--max-turns`), `--max-cost` (US dollars), `--max-tokens` and
`--fallback-model` (`provider/model#variant`). They are sent with the prompt as its turn options, so the server enforces
them. A run that reaches a limit exits 1 and says which: the result object of `orb run --format result` and `orb run --json-schema`
gains `subtype` (`success`, `error_max_steps`, `error_max_cost`, `error_max_tokens`, `error` or `interrupted`), `usage`
(the steps, cost and tokens of this session's own responses to the prompt, read from the stored messages when the run
ends, so a subagent's spend is not in it; a response that failed part way adds its spend but is not a step) and
`truncated` (the last step stopped at the output limit, even when a limit then ended the run, which also prints a
warning). `orb -p` has no `usage`: its result carries the flat `steps`, `cost` and `tokens` described in the note on its
output envelope, which count failed steps and subagents' steps, so `steps` can exceed what `--max-steps` counted. With `--format json` and `stream-json` every `error` line of a printed run carries the same
`subtype`. A `--max-cost` that the model's missing price cannot check fails the run with the session error type
`limit.cost-unknown`, subtype `error`, instead of running without a bound; it is a refusal, so over ACP it fails the
turn rather than stopping with `max_turn_requests`. Without `-p`, the interface refuses these flags like the other flags
of a printed run. If the server does not echo the limits back, because it is an older version that drops fields it does
not know, the run first withdraws the prompt it sent from the server's inbox, then asks the server to interrupt the
session, and fails with a version error. Withdrawing the prompt is what stops it on a session whose run has not
started, where an interruption alone does nothing. A prompt that the server already delivered is not withdrawn, and
only the interruption stops it (pinned by `test/run/noninteractive.test.ts` and `test/run/stream-limits.test.ts`).

Any message that the runner marks with `metadata.notice` and a description, such as the switch to the fallback model,
now prints a warning line, or a `{"type":"notice","notice":...,"message":...}` line with `--format json` and
`stream-json`. Over ACP, a turn that reached a limit stops with `max_turn_requests` instead of failing, and every
notice is sent as a `session_info_update` with `orbit/notice` in `_meta`.

**Affects:** scripts that call `orb run` and read its result object or exit code, and ACP clients.

**What to do:** nothing; the new fields are additive. A script that passes a limit should check `subtype`.

### Over ACP, an approval describes what is asked, and a Code Mode write says its method

`orb acp` used to build an approval from the call that raised it, so a Read that followed a link out of the project was
shown as a read of the project file, and a Code Mode fetch, an MCP call and a Workflow agent were all shown as
`Execute` or `Workflow`. It now shows the caller's name and input only when the caller owns the request (the same table
the terminal interface uses, `ToolNames.owns`) and builds the prompt from the request otherwise: the folder outside the
project for `external_directory`, the method and URL for a fetch (`POST https://...`), the action and resources for an
MCP tool or an agent. A file edit shows the diff the server will write, taken from the request's `metadata.files`, so an
edit of a file with CRLF line endings is no longer shown as no change. The approval prompts of the terminal interface
and of Mini (`orb mini`) also name the method of a Code Mode fetch other than GET and HEAD, as `WebFetch POST <url>` with
a `Method:` line. A built-in tool's own input contributes only the fields that tool declares, never extra keys the model
added to it: a `cwd` on a shell call does not change the folder shown, and a `method` on a fetch does not change its
title. An MCP tool or a skill shows the arguments it sends in `rawInput`. A diff or a `<n> files` title appears only for
an edit, write, notebook edit or patch.

**Affects:** ACP clients that read the title, locations or `rawInput` of a permission request, and anyone who approves
Code Mode fetches.

**What to do:** nothing. `rawInput` of a request the caller does not own carries the request's metadata and `resources`.

### Approvals show a path where the tool acts, `~` included

The tools read a leading `~`, `~/` or (on Windows) `~\` in a path as your home folder, and a Git Bash, Cygwin or WSL
drive spelling such as `/c/Users/...` as that Windows drive. `orb acp` resolved the same path against the session's
folder instead, so a shell `workdir`, a Grep or Glob `path` or a Read, Edit, Write or Patch file of `~/config` was shown
in the approval and in the tool updates as `<project>/~/config` while the tool acted in your home folder. `orb acp` now
resolves a path from a tool's input as the tools do, `..` included, and shows an absolute path normalized, so on Windows
a path that starts with `/` is shown with a drive letter.

The server also names the place on the request. A shell approval carries `metadata.workdir`, the absolute folder the
command runs in, and the `metadata.path` of a Grep or Glob approval is now the absolute place searched rather than the
path as the model wrote it. An ACP approval for a Read, Edit, Write or Patch takes its locations from the request's
resources, which are the files the server resolved and checked your rules against, rather than from the calling tool's
input, and a Read, Edit or Write approval takes its title from them too. The approval prompts of the terminal interface
and of Mini (`orb mini`) name that file for a Read or an Edit as well: Mini showed
`~/../<you>/.config/orbit/orbit.json` as a file of the project. Their tool rows, such as a shell row's `cd <folder>`,
now draw a path from a tool's input the way the tools read it too, where they used to show `~/../<you>/.config/orbit` as
`<you>/.config/orbit` in the project. A path from a server on another kind of system is drawn as before.

**Affects:** ACP clients that read the locations or title of a tool call or an approval, people who approve reads and
edits in the terminal interface or Mini, and plugins or SDK callers that read `metadata.path` of a Grep or Glob
permission request.

**What to do:** nothing. A plugin that wanted the path as the model wrote it reads it from the tool call's input.

### Structured output is a validated tool hand-in

A prompt can ask that the turn end with an answer that follows a JSON Schema: `turn.output` on the prompt request holds
the `schema` and, optionally, `attempts` (1 to 20, default 5), and `orb run`, `orb -p` and the SDK send it from
`--json-schema`. The schema is checked and compiled when the prompt is admitted. The runner then offers the model one
extra tool, `StructuredOutput`, whose parameters are the schema as you wrote it, always as a direct tool: no permission
rule, agent tool list or context hook removes it, and it never asks. Each hand-in is validated; a bad one is
sent back to the model with every failure (a JSON Pointer and a reason), and a turn that stops without an accepted
hand-in is asked to hand one in. The turn ends with the latest accepted value, or fails: `limit.structured-output` after
`attempts` responses that handed in a wrong answer (a valid last attempt still succeeds), or `output.missing` when the model
never hands one in (after the eight turn-end continuations, or when the agent's step allowance ends first). A model that cannot call
tools fails with `output.unsupported-model`, and a stored schema that no longer compiles with `output.schema-invalid`. `structured_output` on the result comes from the accepted
hand-in in the history, and is present only on success.

This replaces the earlier text path: the schema is no longer appended to the prompt, and the answer is no longer parsed
from the reply (a fenced or bare JSON answer in prose is not an answer). Other changes:

- A schema is refused at admission (HTTP 400, field `turn.output.schema`) unless it is an object whose root declares
  `"type": "object"`, passes the meta-schema (draft-07, 2019-09 or 2020-12; no `$schema` means draft-07), uses only
  keywords the validator enforces (a `$id` is allowed only at the root), has only local `$ref`s that resolve (nothing is fetched), and stays under 256 KiB and 64
  levels of nesting. Unknown keywords, such as a misspelt `requred`, are refused instead of ignored. `format` and the
  other annotations (`title`, `description`, `default`, `examples`, `$comment`, `deprecated`, `readOnly`, `writeOnly`,
  `contentMediaType`, `contentEncoding`) are accepted and not enforced. The validator interprets the schema and never
  builds code from it.
- `--json-schema` takes inline JSON when its value starts with `{`, and otherwise the path of a file (a UTF-8 byte order
  mark is dropped and UTF-16 files are decoded). A missing file, invalid JSON or a root that is not an object schema is a
  usage error in the requested format, before any session exists. Windows PowerShell 5.1 strips the quotes from inline
  JSON, so pass a file there.
- `ORBIT_MAX_STRUCTURED_OUTPUT_RETRIES` (1 to 20) sets `attempts` for the prompts of a run; any other value is a usage error.
- A failed run reports the new subtype `error_max_structured_output_retries` for the attempt limit, and `reason:
"invalid_output"` when the turn ended without an answer. In stream input mode every user line carries `output`, so each has its own
  attempts and its own result line.
- An older server refuses a request that carries `turn.output`, and a server that drops it fails the run; neither falls
  back to parsing text.
- On an agent's last allowed step the hand-in tool is offered alone (and asked for by name) until an answer is accepted.

**Affects:** scripts and SDK callers that use `--json-schema` or build prompts with a schema in the text, anything that
matched the old `The answer was not valid JSON.` error, and schemas that were not object roots or used unknown keywords.

**What to do:** Pass the schema as `--json-schema` (or `turn.output`) and read `structured_output` from the result or
from the accepted `StructuredOutput` call; make the schema an object schema; update an older server.

### A turn with step, cost or token limits tells the model what is left

A turn that sets `maxSteps`, `maxCost` or `maxTokens` now carries a hidden budget reminder on every step. It lists,
for each limit the turn set, what is used and what is left, and says that the turn stops without a reply when a limit
is reached. From 90 % of a limit, or on the last step, it asks for the final answer instead of new work. A turn that
asked for a structured answer is told to hand it in through `StructuredOutput`, and with a step limit it is asked to
do so with two steps left, because an accepted hand-in needs one more request to close the turn. The figures are the
ones the limit check reads, so they include subagent and background spend. Nothing in the text comes from a file.
Subagents, turns without limits and `orb run --bare` get none. Before this, the model was not told about a limit and
the turn ended without an answer.

**Affects:** anyone who sets turn limits. Each step sends a few more input tokens, and the stored history holds one more
hidden row per step. Clients do not show it.

**What to do:** Nothing.

### Undo takes a file named like a pattern as that one file

Session snapshots, and the undo that restores from them, now hand every path to git as a name. Git used to read a file
name such as `[s]ub` (or `*` and `s*`, which Windows does not allow) as a pattern, so undoing a change to that file also
put back every file the pattern matched, such as `sub`, and the diff of that file listed them too. A capture that left
such a file out because it was too large dropped the files it matched from the snapshot, and one that recorded it also
recorded a large file it matched. A session started in a folder with such a name now records only that folder: outside
Windows a folder named `s*` also took in the files of a folder `sub` beside it, and on Windows git looked inside `sub`
for a repository of its own (`snapshot-untrusted-git.test.ts`, "Snapshot reads a file name that git would take for a
pattern as a name").

A name that starts with `:`, which only systems other than Windows allow, is a name too. Git read `:memo` and
`:(top)memo` as `memo`, so undoing a change to such a file deleted it when there was no `memo`, and a folder that
ignored `memo` left the file out of its snapshots. A capture or comparison that met a file named `:(icase)memo` or
`:!memo` failed.

**Affects:** folders that hold files or folders whose names git would read as a pattern.

**What to do:** Nothing.

### Undo keeps an edit made in the second git last wrote the folder's index

Orbit's first snapshot of a folder starts from a copy of the folder's own git index. On Linux the copy used to be newer
than every entry in it, so git took a tracked file that was rewritten to the same size within the second its index was
last written as unchanged: the snapshot held the committed text, and undoing the next step put that text back instead
of the edit. The copy now has the time of the index it came from, and git reads such a file again
(`snapshot-untrusted-git.test.ts`, "Snapshot captures a tracked file rewritten in the second its folder's index was
written").

**Affects:** people on Linux who edit a tracked file within a second of a git command in a folder that Orbit has not
taken a snapshot of before.

**What to do:** Nothing.

### Undo puts back only what Orbit's file tools changed

Undoing to a prompt (`/undo`, a revert with its files) used to put back every file that changed during the steps after
it, including what a shell command, a subagent or you changed by hand. It now puts back only the files that the
session's own Edit, Write, Patch and NotebookEdit calls changed, and only where git sees a difference; a shell
command's edits stay as they are (`session-revert-files.test.ts`, "undoes only the file-tool edits when /undo stages a
conversation revert with its files"). To record what it changed, Write now names its file in the completed call, as
Edit already did, and a Patch move names its source beside its destination.

Undo and the code-only rewind count only the file-tool calls made in the folder the session is in now. After the
session has moved (EnterWorktree, ExitWorktree or a session move), a file that a file tool changed in the other folder
is a different file from the one with the same name here, so a shell edit to the one here stays; calls made here
before the session left and came back still count (`session-revert.test.ts`, "Session.revert names from another
folder"). A Write recorded before this upgrade did not name its file in its result, so it counts by the path it was
given; a Patch move recorded before the upgrade names only its destination, so undoing it does not bring the source
back.

An undo to a prompt from before such a move used to fail (the server answered 500) whenever a step in another folder had
changed a file, because it asked this folder's git for a snapshot that only the other folder's snapshot repository
holds. It now puts back what the file tools changed here, from this folder's own snapshots, and leaves the other folder
as it is; the code-only rewind and its dry run answer that such a prompt has no checkpoint, as before
(`session-revert.test.ts`, "Session.revert across a folder switch"). Two related changes keep this true later on:
committing an undo (by sending the next prompt) now keeps the record of each move among the messages it removes, so
the transcript still shows that the session moved, and moving a session that has an undo staged commits that undo
first, as a prompt does, so a redo is no longer offered in the new folder ("commits a staged undo when the session
moves, so a redo there touches nothing").

A restore now skips, with a log line, a file whose folder became a link after the snapshot (a junction, a dangling link
or a link to a share), a file whose own name is now a link or a folder, and a file one of whose folders is now a file
of yours; the other files still go back. Before, git wrote through the link, removed a junction's target files on
Windows, removed a folder with what it held, removed your file to make the folder again, or the whole restore failed.
No folder is removed with what it holds. A file that git fails to put back no longer stops the rest:
the others go back and the restore then reports that it failed (`snapshot-restore-links.test.ts`). A tracked folder
that became a link no longer stops snapshots: git refuses a path beyond a link, which made every later snapshot fail on
Linux, so a rewind answered that snapshots were unavailable. The files behind the link now leave the snapshot and the
rest is recorded (`snapshot-restore-links.test.ts`, "takes the capture without the files behind the link, and records
the control"). On Windows a snapshot no longer stores the files that a junction in the project leads to ("does not
capture the files a link leads to").

An Edit, Write, Patch or NotebookEdit call that fails after it changed a file now names that file in the failed call
too, so an undo or a rewind puts it back.

An undo with its files now fails, and stages nothing, when Orbit cannot take the snapshot of the files it compares the
edits with (git fails on the snapshot repository, say). Before, it staged the conversation alone and reported success
without putting any file back (`session-revert.test.ts`, "fails a revert with its files when the capture before it
fails, and stages one without its files"). Undoing the conversation alone still works.

**Affects:** people who undo after letting the agent run shell commands that change files, and folders whose layout
changed to links after a step.

**What to do:** Undo shell edits yourself, for example with git.

### Rewind a prompt's files without touching the conversation

`POST /api/session/:sessionID/revert/files` with `{ messageID, dryRun? }` puts back, as they were when that prompt's
work began, the files that the session's own file tools changed, and leaves the conversation as it is. It takes effect
at once and has no redo. A dry run answers `canRewind` with the files that would change (absolute paths) and the lines
the rewind would add (`insertions`) and remove (`deletions`). It refuses a busy session (409 `SessionBusyError`), a
folder that is no longer trusted (403 `UntrustedFolderError`), an unknown message (404), and a message with no checkpoint,
a folder without snapshots or a restore that failed (409 `RewindFilesError` with `reason`; a dry run answers
`canRewind: false` instead). `orb run --rewind-files <message id>` and `orb -p --rewind-files <message id>` call it
once; they need `--session`, `--continue` or `--resume`, take no prompt, print one line and exit. A file that git leaves
out of snapshots (one the repository ignores, or an untracked file over 2 MB) is not rewound, and neither is a file
whose name or folder is now a link, nor one where a folder now stands, nor one whose folder is now a file; the dry run
leaves those out too. Prompts delivered together (sent while a step ran) share the checkpoint of the step after them.

`GET /api/session/:sessionID/diff` takes `scope=prompt`, which diffs from `from` to the next prompt and counts only the
file tools' edits, so a prompt steered in while the session was busy gets its own diff; `scope=turn`, the default, is
unchanged.

**Affects:** SDK callers and scripts that call `orb run` or `orb -p`.

**What to do:** Nothing.

### An imported session keeps no checkpoint ID that is not a snapshot tree

Importing a session (`orb session import` or `POST /api/experimental/session/import`) now drops, with a log line, a
step's start or end checkpoint that is not a git tree ID and a changed path that is not a plain name inside the
project, and keeps the rest of the step. Such a value used to reach git: `--output=<file>` made viewing the session's
diff write that file. Comparing, restoring and rewinding refuse such an ID before git starts.

**Affects:** imported sessions whose files were edited by hand.

**What to do:** Nothing.

## Prompts and instructions

What the model is told about itself and the place it works in.

### The model learns its shell, its system, its knowledge cutoff and a scratchpad folder

The environment block of the baseline now names the shell that the shell tool runs and the version of the operating
system (`Windows 11 Pro 10.0.26200`, `Darwin 24.6.0`, `Linux 6.8.0-45-generic`). The platform line gives the usual name
beside the system's own value, such as `Windows (win32)`. On Windows a Unix shell such as Git Bash is marked as one, with
a reminder to write Unix syntax. A directory that is a linked git worktree is named as one, with the folder of the main
checkout, and the model is told to stay out of it. The line that told the model to prefer Orbit's temporary folder over
`/tmp` is gone.

The model's identity part adds a `Knowledge cutoff` line (a month and a year) for a model whose entry in the model
catalog has one. The cutoff is read from the catalog Orbit already uses, the bundled one unless you configured a mirror,
and nothing is fetched to find it. A model that the catalog has no cutoff for gets no line. `Model.Info` has a new
optional `knowledge` field (`YYYY-MM`), so the generated client changed too.

Each session has a scratchpad: the folder `sessions/<ID of the session its lineage goes back to>` in Orbit's temporary
folder. The name goes back one level only: a subagent uses its parent's folder, a fork uses its source's folder, and a fork of a subagent or of a fork uses the folder of the session it came from. The baseline names the folder and says the same for every session, so an exact fork repeats its parent's system parts. Resolving the whole lineage is deferred by the plan's appendix (`FU-M4-r3-scratch`). The baseline names it and tells the model to
keep its temporary files there instead of in the system temp folder. Orbit makes it when a run starts. Every agent that
may edit files (not Plan, whose mode denies `Edit *`, so its writes there still ask until permissions-7) may edit in the folder of the session that asks without a question, and only where the real place of the
file is in that folder (a link inside it that leads elsewhere is decided by where it leads), and your own rules for the
folder still win. The folder is removed when its session is deleted, unless a fork of that session is left. A session
whose ID is anything but `ses_` followed by letters, digits and underscores gets none of this.

A session that exists already is told once, at its next step, that its environment changed and what the scratchpad is.

**Affects:** every session (the baseline text changes), SDK and client callers that read `Model.Info`, and plugins that
edit the model catalog.

**What to do:** Nothing.

### A session starts with a snapshot of the git repository

In a trusted git folder, the baseline of a session now carries a snapshot of the repository taken once: the current
branch, the main branch (from `origin`'s head or its `main` or `master`, else `main`), the git user name, the short
status (cut at 2,000 characters, with a note when it is longer) and the last five commits. The text says it is a
snapshot and is not updated, and a status that cannot be read leaves the snapshot out rather than reporting a clean tree.
A subagent sees its parent's snapshot, and a fork keeps its session's. The snapshot starts no git in a folder that is not
trusted. If a folder is trusted partway through a session, the next step adds one snapshot, worded as taken partway
through; if trust is taken away, the next step tells the model the snapshot no longer applies. `orb run --bare` keeps
the snapshot; an embedded instance that boots with `discovery: false` has none.

Set `"git_status": false` in any config scope to turn it off. A folder that is not trusted may set only `false`:
its `true` is dropped, because the later document wins and a folder above a trusted project would otherwise turn the
snapshot back on against your own `false`. The generated client types gain the optional `git_status` boolean in `Config.Info`.

**Affects:** every session in a git folder (the baseline text and its size change; a prompt cache for an existing
session is unaffected until its next step), and SDK callers that read `Config.Info`.

**What to do:** Nothing, or set `git_status` to `false` to keep git state out of the prompt.

### `@path` in an instruction file loads that file

An instruction file (`ORBIT.md`, `AGENTS.md`, another product's file when compatibility is on) can now pull in other
files by writing `@path` in its text: `@./docs/style.md`, `@docs/style.md`, `@~/notes/mine.md` or an absolute path. The
file is added to the instructions as a block of its own right after the file that named it, and its own `@path` lines are
followed to a depth of five files, each file once. The `@path` text stays where it was written. Nothing is imported from
inside a code span, a code block, an HTML block or comment, the target of a link or after a backslash, and a name with a
`#` is cut there (`@./guide.md#setup` imports `./guide.md`). A target that is not there, is a folder, is not a text file
(by its extension; a name with none counts) or holds a NUL character is skipped without a word, so prose such as `@team`
costs nothing. `instructions_exclude` applies to imports as to any file, and an imported file is watched, so editing it
updates the instructions of a running session. Files that the model's reads load later import only from inside the
project, whether or not it is trusted.

A file in a project whose folder is not trusted imports only files that really lie inside the folder you started in or
inside the project: a path that leaves it, or a link that leads out, is skipped (once the folder is trusted, a later note
below lets it import from outside). The skipped target is
recorded as a warning that no client shows yet. The home folder and a filesystem root are never counted as the project, and
count only once a person trusts them for the session, and then only as the folder the session started in, so an untrusted
session started in `~` imports nothing from below it, and a session started below `~` is held to its own folder. Your own global file may
import any path that is not a network path. A path that names a network share is never opened.

**Affects:** anyone whose instruction files already contain text like `@something` that names a file, which is now sent
to the model, and anyone who puts secrets in files next to their instructions.

**What to do:** Nothing for most setups. Write `\@name` or put the text in a code span to keep a name from being read as
an import, or list the file in `instructions_exclude`.

### An untrusted folder no longer sets your reply language or output style

`language` and `output_style` in a project's `orbit.json` (or `orbit.local.json`) used to win over your own value,
because the last entry wins. In a folder you have not trusted, Orbit now holds both back and your own value stays in
force; the trust prompt lists them under `settings`. When you trust the folder, the project's values apply after the
usual reload. The same goes for a project's `language` that asks the model to ignore your setting.

**What to do:** Nothing. If a project's language or style is wanted, trust the folder with `/trust` or `orb trust`, or
put the value in your own config.

### Editor context from the VS Code chat, the terminal UI and ACP keeps selected text out of the reminder

The editor context that these clients send with a message used to put the file path and the selected text inside the
reminder envelope itself, so a selection that held a reminder tag could close the envelope and write a fake one. Now the
selected text always follows the envelope in a labelled fenced block whose fence the text cannot close, and a look-alike
tag in it is escaped. The terminal UI puts the path in that block too. The VS Code chat keeps the file name, its language
and any problem messages on one line inside the envelope, with every `<` and `>` in them escaped, so no tag can be formed
there. The terminal UI now cuts a selection at 2,000 characters, as the VS Code chat and the core note already did, and its envelope says how many characters were left out (before, the whole selection up to the editor bridge's 100,000-character cap was sent). Text that an ACP editor marks for the
assistant is escaped the same way. The reminder tags are written as `&lt;system-reminder>` in what the model sees. The
rules are shared in `packages/util/src/reminder-text.ts`.

**What to do:** Nothing.

### Text that looks like a reminder is escaped in the listed places that carry a file or a tool's text

Orbit now has a reminder framework: model-facing context that the harness adds beside the conversation, stored as hidden
`session.synthetic` rows (`metadata.reminder.kind`) or worked out each time a request is built. No built-in reminder is
added by this change; later changes add producers. A reminder holds harness text in a `<system-reminder>` envelope, and
anything it quotes from a file or a tool follows in a labelled fenced block outside the envelope.

The base prompt has always said that a `<system-reminder>` or `<system-update>` block comes only from Orbit. To make that
true, Orbit now writes the opening bracket of such a tag as `&lt;` when it lowers text that is data: tool results and
tool errors (local and MCP, also when a server splits one result into several text parts and a tag is cut across them, and also a text or JSON file that a result carries, such as an MCP resource), attached files (including a file that an ACP editor embeds in a prompt, and a text file given with `orb run -f`, the stream-json `files` field or the terminal UI Mini's initial files, whose body and name are escaped where they join the prompt) and folder listings, the names of files that reach a model as a document title or file name (a Read result, an attachment, a Code Mode copy), the Code Mode tool listing (which carries MCP tool descriptions), the agent and skill listings (ids and descriptions), the output of a shell command you ran or that ran in the
background, the reply of a background subagent, the summary and recent text of a compaction checkpoint, instruction files
with their updates (including the ones loaded when a file is read), MCP server instructions, and the git snapshot (branch,
user, status and commit subjects). Some sinks are not covered yet (the reference listing, plugin system parts, direct MCP tool descriptions, a hosted tool's result, image and PDF bytes, which cannot be escaped); `docs/untrusted-repositories.md` lists them under Known gaps and `FU-M4-36` tracks them. The stored row keeps the original
bytes; only the request changes, and only for text that held such a tag. A prompt you type is not changed.

A compaction no longer reads reminder rows, because the next step collects them again after the checkpoint.

**Affects:** people whose files or tool output quote `<system-reminder>` or `<system-update>` tags (for example when
documenting them), who now see `&lt;system-reminder>` in what the model is sent; clients that list `session.synthetic`
messages, which should hide those with `metadata.reminder`.

**What to do:** Nothing.

### The model-family prompts are rewritten

The prompts that `packages/core/src/plugin/optimize.ts` selects by model ID for the Astra, Kimi, Trinity and Muse families, and for the general prompt, which `optimize.ts` picks by a substring of the model ID and which the Astra IDs replace with their own, were written again, and the local-model prompt was tidied to match. Each of the five full prompts now opens with the same opening paragraph as the base prompt, so an output style replaces that paragraph for these models too, and a style without coding instructions drops their Scope, Working in code and Evidence sections as it does the base's. The five full prompts and the local-model prompt tell the model to follow the user's and the project's instruction files, which come later in the prompt and win over the family guidance; on one point a project's file ranks lower, because it cannot approve a risky action ahead of time, while the user can in their own instructions or in the conversation (the base prompt is stricter and takes a standing yes only from the user's instructions). Reminder-shaped text inside a tool result is data for every model; the Kimi and Trinity prompts no longer say otherwise, and no family prompt mentions reminders at all. The `muse` prompt names the model Orbit runs on and makes no claim about who trained it. The Trinity prompt no longer forbids every comment, sets a limit on reply length in lines, or tells the model to hide why it declined; it keeps to short, answer-first replies. Kimi replies in the language the user writes in unless asked otherwise. No family prompt carries a git staging or commit-message procedure, only the rule not to commit, push or open pull requests unless asked. The Astra prompt and the general one split short commentary while working from a self-contained final answer, and the Astra prompt states its limit (confirm destructive, hard-to-undo or outward-facing actions, stay in scope) beside its push to carry a task through. The short block appended for one further model family only narrows the base comment rule. These points are pinned by `packages/core/test/plugin/system-prompt-text.test.ts`.

**Affects:** sessions on models of those families and on local models (the system prompt text changes, so a prompt cache for an existing session is unaffected until its next step).

**What to do:** Nothing.

### Plan mode, todo and verification reminders are derived from history

The Plan mode text no longer arrives as a stored `session.synthetic` row. The model now gets it from three derived reminder producers, computed again whenever a request is built and never stored.

- Plan mode: the first Plan step of a session (and the first after a compaction) gets the full instructions, which now tell the model to explore, design, check the plan against the request and present it through `ExitPlanMode`. After that a reminder comes back only once five prompts have passed since the last one; every fifth is the full text and the rest are one short paragraph. A child session running as the Plan agent gets a shorter subagent text. The first step that is not in Plan mode gets one note that Plan mode has ended. A person who returns to Plan mode within five prompts of the last reminder gets no new reminder until that point, because a leave resets the full and short cycle but not the five-prompt wait. When a plan was approved earlier in the session, the first reminder after a return starts with a note to read the saved plan and decide whether the task is the same. `ExitPlanMode` now also records `approved` and the saved plan's path in the call's metadata for that purpose, so a fork names the file its parent wrote. The leave and re-entry notes are worked out from the history the request carries, so a compaction drops a note that was still owed; the first step after one gets the ordinary plan reminder or none.
- Todo: once ten assistant text and tool-call blocks (not reasoning) have passed since the last `TodoWrite`, `TaskCreate` or `TaskUpdate` call and since the last nudge, the next step gets a nudge to update or tidy the list, with the current items. It is skipped when neither `TodoWrite` nor `TaskUpdate` is offered.
- Verification: when a call closes out a list of three or more (every call that leaves every item completed, including one that sends an all-completed list again) whose items are none about checking (`verif` in any letter case), the next step is asked to run the relevant checks before reporting and to say what it did not check.

Sessions that already hold the old Plan mode rows keep working: an old enter row counts as the first reminder and an old leave row as the leave. A running session sees one prompt-cache miss when it first picks this build up.

**Affects:** sessions that use Plan mode, `TodoWrite` or the task tools; clients that listed the Plan reminders as hidden `session.synthetic` rows will no longer see new ones.

**What to do:** Nothing.

### Input sent mid-turn, @agent mentions and editor context reach the model

Three notes are now written while a user message is lowered, from fields the message already stores, and none is stored itself.

- A message that the person sent while the agent was working, and that is steered in right after a round of tool calls, gets a short note ahead of it saying so and that it must be acted on once the current task is done. The person's words stay outside the note, unchanged. Such a message gets only the note and its text: its `@agent` hints and its `editor` field are stored but not shown to the model, because only a prompt sent while idle carries them. A slash command typed mid-turn is steered like any other input, so its expanded text gets the note too (recorded as a deviation; see FU-M4-35). Input that waited in the queue, a first prompt, a prompt after idle, an interruption or a checkpoint, and a steer that follows a final text-only step get no note. A message that a subagent or workflow tool sent to a child session gets a note naming the parent agent as the sender.
- Each distinct `agents` entry of a prompt adds one hint that the person asked for that agent and that the `Agent` tool starts it. Admission now drops entries that name an agent the tool cannot start (unknown or primary-only); before, a mention had no effect on the model at all.
- A prompt can carry `editor`: the absolute path of the file open in the editor and, optionally, a 1-based inclusive line range with the selected text. The model reads one note, with the path and the text in a data block after it; the text is cut to 2,000 characters after line endings are normalized, and the note says how many were left out. Admission drops the field (and keeps the prompt) when the path is relative for the platform the server runs on (on Linux and macOS a Windows spelling such as `C:...`, `\...` or `\host...` is relative; a `~name/` spelling counts as relative; only `~`, `~/` and, on Windows, `~\` mean the home folder), cannot be resolved, is denied by a `Read` rule, or the range ends before it starts. `session.command` accepts the field but does not carry it. The VS Code chat and the terminal UI keep sending the editor context as a hidden item until a later change moves them.

`orb run --bare` and vanilla instances keep the mid-turn note and drop the hints and the editor note. On a normal instance, compaction summaries and session generations (/btw and the keep-alive warm-up) lower a prompt like the main request, so they share its cache and see the selection; retained recent messages never carry the hints or the editor note. A redacted session export now replaces `editor.path` and the selected text.

Each of these notes (the mid-turn note, every `@agent` hint, the editor note and the reasoning-effort note) now ends with a blank line when it is lowered, so a provider route that joins a message's text parts with nothing, such as the chat-completions providers, keeps every closing fence on its own line and starts your words on a new line outside the quoted block. Stored messages are unchanged; a running session sees one more prompt-cache miss. Under text tool calling, user messages that sit side by side are now joined with a blank line, so a reminder's closing fence stays apart from your prompt.

Sessions that already hold steered messages gain the note once when first lowered by this build, so a running session sees one prompt-cache miss. A steer that follows a fork, an import or a crash that cut history right after a tool step also gets the note, and the first steer after a completed checkpoint does not.

**Affects:** people who type while the agent works, users of `@agent` mentions, and SDK or protocol clients that can now send `editor` (the generated clients carry it).

**What to do:** Nothing.

### Nested instruction files load outermost first, and only for what a read returned

When the model reads a file or lists a folder below the folder the session started in, the instruction files of the folders between them are added to the conversation. Three things about that changed.

- The files now come outermost folder first, so a folder's file is read before the file of a folder inside it. They came innermost first.
- A read of a path outside the folder the session started in, such as a sibling package in the same repository, no longer loads that folder's instruction file. Only the folders below the started folder count. A read of a PDF, and a read that fails, load nothing either; a text file, an image, a notebook and a folder listing do.
- `orb run --bare` and instances created with discovery off load no nested instruction files on read. They did before.

A nested instruction file that is a link leading out of the project is no longer loaded, in a trusted project as well as in one that is not. A session started at the home folder loads nested files only once that folder has been trusted for the session. A file that the model edits or writes does not load nested files; the read the edit tools require beforehand does. A repeat read that is answered with the "has not changed" note loads nothing either.

**Affects:** projects with instruction files in subfolders, repositories that link an instruction file to a file outside them, and `orb run --bare`.

**What to do:** Nothing. Copy a linked instruction file into the project if you want it loaded.

### Rule folders: `.orbit/rules`, and rules that wait for a matching read

A folder named `rules` now holds instruction files too. Orbit reads `<folder>/.orbit/rules` in every folder of the instruction walk, `rules` in your own config folder, and `rules` in the managed folder beside the managed `ORBIT.md`. With compatibility on, the `rules` folder inside another product's dot-directory is read as well, before Orbit's own, so Orbit's rules take precedence. Every file whose name ends in `.md` (lower case) is a rule, in subfolders too, loaded by name order.

A rule with no `paths` in its front matter is an ordinary instruction file: it joins the first request right after the instruction file of its folder (the managed rules after the managed file, your own after your global file) and before that folder's local file. A rule with `paths` (a YAML list, or a comma-separated string, with `{a,b}` groups expanded) is not in the first request. It is added to the conversation, once, the first time the model reads a file that matches. The patterns follow the rules of a `.gitignore`, from the folder that holds the `.orbit` folder (your own and the managed rules: from the folder the session started in), on the real path of the file: `*.ts` matches at any depth, `src/api/**` and `/src/*.ts` are anchored, case is ignored, `*.md` matches `.notes.md`, and `!` takes a match back. Only a read triggers a rule, not an edit, a folder listing or a PDF. A read outside the folder the session started in, such as a file of a sibling package in the same repository, adds no rule, even one whose patterns match that file. A rule is added again after compaction drops it. A `paths` that cannot be read as YAML makes the rule apply from the start, and a front matter whose first line names a language (`---js`) is text, not front matter. A rule keeps at most 256 patterns of at most 1,024 characters each, and reading its `paths` stops after a fixed amount of work, enough for a list of 256 patterns of 480 characters. That work counts what is read and expanded whether it is kept or not, so a YAML alias that repeats one value thousands of times, or `{a,b}` groups whose every spelling is empty or refused, no longer holds Orbit up at each session start and each read below the rule's folder; before, a rule file of 17 KB written that way cost about 5 seconds each time. A rule keeps the patterns it had found when the work runs out, and one that had found none waits and matches no read. A rule whose front matter comes to more than its own text once its YAML aliases are followed is refused before its `paths` is read, and waits in the same way (see "Front matter and workflow YAML whose aliases come to more than their text are not read"). A pattern that ends in a long run of slashes followed by another character no longer costs the square of the run's length when it is compiled, and neither does an `@` import token after an underscore whose name is a long run of underscores: before, a rules folder of 64 files written that way held each read below it for 17 to 29 seconds on Windows, and an instruction file of 200,000 such underscores for 39 seconds.

An unconditional rule counts toward the 40,000-character size warning; a rule that waits does not. `instructions_exclude` applies to your own and the project's rules, never to the managed ones. In a project that is not trusted, a rule or a rules folder that is a link out of the project is skipped and logged once, and loads once the project is trusted. A rule with `paths` that is a link out of the project is never added on a read, in a trusted project too. Rule paths are matched by Bun's glob matcher, whose time grows with the path and the pattern and cannot blow up, and a read of a path more than 32 folders deep or 1,024 characters long matches no pattern. A rule in a folder above the project waits for the project to be trusted, as the instruction file in that folder does, and loads, or waits for a matching read, once it is.

A `.orbit/rules` folder (and, with compatibility on, the other product's `rules` folder) in a folder below the one the session started in is read when the model reads a file below it: its rules without `paths` are added to the conversation on that read, and also when the model lists that folder, and its rules with `paths` when the file read matches. They are read from what the folder held at a recent read (see the note on the cap below for how long that is kept), and a rules folder or a rule that is a link out of the project is neither listed nor read.

**Affects:** people who keep a `rules` folder in `.orbit`, in their config folder or, with compatibility on, in another product's dot-directory, and administrators who deploy policy.

**What to do:** Nothing, except to copy a rule with `paths` that is a link to a file outside the project into the project. Move text you want only for some files into a rule with `paths`.

### Links in a project at home or at a filesystem root, unreadable rules, and a cap on rule files

When the project is your home folder or a filesystem root, an instruction file of the walk (`AGENTS.md`, `ORBIT.local.md`, the other product's names) and a rule of a `rules` folder may no longer be a link that leads out of the folder you started the session in, unless it leads to a folder you have trusted and you started the session in that home or root folder and trusted it for the session. Trusting the project alone does not open it. Before, in a folder with no repository of its own below a home folder that was a repository, a downloaded `AGENTS.md` or rule that linked to `~/.ssh/id_rsa` was sent to the model at the start of the session, with no trust granted. A plain file in the started folder is still read.

A project or personal rule that cannot be read (no read permission, or a file another program holds open) is now left out with one warning line that names it. Before, it stopped every new session in the folder with "Instruction initialization blocked by unavailable sources". An instruction file of the walk (`AGENTS.md`, `ORBIT.local.md`, the other product's names) that cannot be read is left out the same way, and the next name in its slot in that folder is read instead; before, it stopped every new session in the folder with the same message, and a file that was readable when the session was prepared but gone when it was read kept its old text. The administrator's rules and file still stop the session, so that policy text is never dropped for a failed read.

One rules folder now lists at most 256 rule files, in name order, with one warning when more are there. One read of a file looks at no more than 256 rule files over all the folders it passes through, and the next read of the same folders does not list them again until a rescan or a short while has passed, so a new rule shows on a later read. Before, every read walked every rule folder on the way again, which took minutes in a repository that held thousands of rule files. One scan of a rules folder also enters at most 256 folders, with one warning when more are there. That limit counts the folders of one rules folder, not of the whole pass: a session scans two rules folders (Orbit's and, with compatibility on, which is the default, the other product's) in each folder from the one it started in up to the project root, and each scan has its own 256. A repository that fills every one of them with empty subfolders can therefore still delay the first request of a session started a few levels down: about 28 seconds on Windows with 400 empty subfolders in each rules folder of four levels, against 3 seconds without them. It costs time only; nothing runs and nothing is sent. This stays open as register row FU-M4-r2-rule-scan. The `@` import allowance in the next paragraph is shared by every file of a pass instead (register row FU-M4-r5-pass-budget). A rule or instruction file that fails to read costs only itself now; before, one file another program held open dropped every nested file of that read.

A rules folder that is a link, or a link to a folder inside one, is held to the same bound as a linked file: in a home or root project a linked folder of rules may no longer lead out of the folder you started in, and before it carried every `.md` file of the folder it led to, a diary under `~/Documents` included. One pass of loading instructions now follows at most 256 `@` imports in all, counted over every file of the pass (the instruction files of the walk, the rule files of every folder, and the files they import); the rest are left out with one warning for the pass, and an import whose target is missing or refused is not looked up again in the same pass. This is a limit of Orbit's own: the reference has no such cap. Before, a file with thousands of them delayed the first request of the session by about a minute for every 175 KiB, and a first cap of 256 for each file left the same delay when the tokens were spread over imported files (40 files of 256 missing imports took 35 seconds). In a project that is your home folder or a filesystem root, an agent, command, skill or output style file of the project's own config folders (`.orbit` and the other product's project folder) that is a link may no longer lead out of that config folder or the folder you started in, and a config folder that is itself a link out is not read from; trusting the project alone does not open it. Your own config (the global config folder, `~/.orbit`, the other product's user folder) is not held to this: a link there may lead anywhere, in any folder you start in, as it did before.

**Affects:** people who start a session in a folder below their home folder when home is a git repository, repositories that link an instruction file or a rule to a file outside the folder, and folders with more than 256 rule files.

**What to do:** Copy a linked file into the folder you start in. Merge rule files if you have more than 256.

### A reply language setting and the `ultrathink` keyword

The new `language` config key names the language the agent replies to you in, for example `"language": "Japanese"`. The main thread of a session is told about it in its baseline; subagents are not. Changing or clearing it mid-session is announced to the model as an instruction update. An empty or blank value counts as unset. A project's `language` applies only once its folder is trusted (see the note on untrusted folders and reply language above); until then your own value stays in force.

A prompt you send that starts a turn and holds the word `ultrathink` (any case, as a whole word), a shell command you type while the agent is idle that holds it, and a command or skill whose text holds it (a skill activated through the API included) now carry a short note asking for a high level of reasoning effort for that turn. Queued input that starts its own turn gets the note too. No model, variant or request setting changes, and the note stays in the conversation from then on, so the cached prompt prefix is unaffected. Input delivered mid-turn (a steer, a shell command or an activated skill that follows a tool step), the prompt a parent agent gives a subagent, the child prompt of a command that runs as a subagent, and the completion of a background job the agent started never carry it. A typed shell command carries the note on its completion notice. `orb run --bare` does not carry the note.

**Affects:** anyone who types `ultrathink` in a prompt or a command or skill text, and anyone who wants replies in another language.

**What to do:** Nothing. Set `language` in `orbit.json` to use the reply language.

### A call that lists the loaded instruction files, their sizes and the baseline the next step sends

`GET /api/experimental/session/:sessionID/instructions` (`client.session.instructions.preview` in the SDK, `orb api
GET /api/experimental/session/<id>/instructions` on the command line) answers with `status`, `initial` and `update`.
`status.files` lists the instruction files the session's location has loaded in the order the model reads them (none
for an agent that leaves instruction files out of its context, which reports `available` as true), each with its real
path, its scope (`managed`, `user`, `project` or `local`), its length in characters after front matter and comment
blocks are off, and the file that imported it when it was imported. `status.warnings` names each file longer than
40,000 characters, which is still sent whole, and each import that was left out because it leads outside what the
project may supply (`import-external`, or `import-untrusted` when trusting the folder would load it).
`status.available` is false when a source could not be read, as when the administrator's instruction file is there and
cannot be read, so the list is incomplete. A project instruction file that cannot be read keeps `available` true: it is
missing from the list, and the next name in its folder is listed in its place. `initial` is the baseline the
next request sends and `update` the instruction update the next step boundary would record, empty when nothing
changed. Neither starts a model request or needs a provider. When a source is unavailable and the session has no
baseline yet, `initial` and `update` are left out and `blocked` names the sources. Warnings never reach the model.

`orb api` now prints a JSON response again with C1 controls and bidi format characters written as `\uXXXX`, and other
bodies as message text, because a response can carry text from a project's files. JSON bodies are indented by two spaces.

**Affects:** SDK callers and scripts that call the experimental endpoint, and scripts that read the raw output of `orb api`
(the same JSON, re-indented).

**What to do:** Nothing.

### A file changed after the agent wrote it is reported to the model

When a file that a session wrote with its file tools is changed afterwards outside the
conversation (by you, an editor, a formatter or a shell command), the next step of that session gets a hidden reminder
with the changed lines, numbered as `Read` numbers them, with eight unchanged lines around each change and at most
8,192 characters in all. The reported change then counts as read, so the edit tools do not refuse the file as changed
on disk. Before, the model learned of such a change only when an edit was refused. A change counts as read only once
its reminder is stored: when the check runs out of time, is stopped, or a compaction ends while it runs, no file counts
as read because of it, the edit tools still refuse a changed file, and the change is reported at a later step. Each
step starts checking the files within a short time budget, and gives each file half of it, so a file that is slow to
check or read, or never answers, costs only its own share and the other files are reported. A check that is still
running when the budget ends keeps the rest of its share. When a step has no time for every file, the files the
session wrote most recently are checked first, and the next step goes on with the files not yet checked; a change to a
file whose check ran out of its share is reported once a later check finishes in time. The
changed lines of small changes are worked out before those of large rewrites, so a formatter rewriting many large files
does not hold up a one-line change.

Only what the session itself wrote is watched: a file it only read is not reported, and reading a file after writing it
ends the watch. A touch, a change of line endings or of the final line break alone, a notebook, an image, a file with a
NUL byte, a folder in the file's place and a file longer than one read are not reported. A deleted file is forgotten. A
file that a `Read` deny rule names, or that a link now leads to, is skipped, as is a file outside the project that an
`external_directory` deny rule covers, a file of the project that has become a link leading out of it, a file outside
it that no longer really is where the session wrote it because the file, its folder or a folder above it has become a
link or junction, and, once the project's trust is revoked, any file outside it. A subagent's session is told about the files it wrote, and what Orbit
holds about its files is released when its run ends, as it is when a session is deleted. Clients show nothing for
these rows, and `orb run --bare` adds none.

After a restart, the first step of each main session rebuilds what it saw from its history since the latest compaction:
a whole `Read`, a `Write` (whether or not the call succeeded), and an `Edit` or `Patch` that succeeded, whose files are
read from disk as they are then. A later `Patch` that deletes or moves a file away, or a later `NotebookEdit`, drops
what earlier calls showed of that file, so the session's own patch is never reported as someone else's change. Changes
made while Orbit was not running are then reported, and a file known this way can be edited without a new read. The
rebuild works from the newest call back, within a budget of its own: a file from history that is slow to check or
read, and the oldest files when there is no time for all of them, are left out of it, and a rebuild that does not finish within the
step's time limit is not tried again until Orbit restarts. Only
files inside the project that `Read` would open without a question are rebuilt, at most the 100 named most recently: a
file under an ask rule, such as the built-in one for `.env` files, is left out. A subagent is never rebuilt: a
continued or resumed one starts with nothing watched, so it must read a file again before it edits it. A file tracked for freshness is now dropped once a
session tracks more than 100 files or 25 MB of written text, least recently used first, and must be read again before
an edit.

**Affects:** everyone who edits files the agent wrote while a session runs, and clients that list hidden
`session.synthetic` rows, which now see rows of kind `file-change`.

**What to do:** Nothing.

### The active built-in output style is named on every step

When `output_style` names a built-in style (`explanatory` or `learning`, in any letter case), the main conversation gets
a short hidden reminder on each step that its replies follow that style. The default style and a style that a file defines add
nothing, and subagents and `orb run --bare` get nothing.

**Affects:** people who use a built-in output style.

**What to do:** Nothing.

### An opt-in reminder of how much of the context window is used

With `ORBIT_ENABLE_CONTEXT_USAGE_REMINDER` set to `1` or `true` in the server's environment, the main conversation gets
a hidden line on each step: how many tokens the newest response used, out of the model's context window less the
smaller of its output limit and 20,000 tokens, and how many are left. It is off by default, says nothing when the
model's window is not known, and is not sent to subagents or by `orb run --bare`.

**Affects:** people who set the variable.

**What to do:** Nothing; set the variable to turn the reminder on.

## Shell sandbox

### Shell sandbox: WSL1 refuses commands; WSL2 commands cannot start Windows programs

With `sandbox.enabled` set, Orbit now recognises Windows Subsystem for Linux from the kernel release. WSL2 uses the same
bubblewrap sandbox as Linux, and Orbit hides the WSL interop sockets (`/run/WSL`) from the sandboxed command, so a
sandboxed command on WSL2 cannot start Windows programs such as `cmd.exe` or `powershell.exe`. WSL1 has no support for
the namespaces bubblewrap needs, so a shell command there fails with a message saying so, instead of failing with
bubblewrap's own namespace error.

**Affects:** people who enable the shell sandbox inside a WSL1 or WSL2 distribution. On WSL2, commands that start a
Windows program now fail.

**What to do:** convert the distribution with `wsl --set-version <name> 2`, or turn the sandbox off.

### The status line refreshes on events, gets more fields and can keep colors

The status line command (`status_line.command`) used to run only on its interval and received a short JSON object. It
now also runs when a step ends or an execution starts or ends in the session, and when the selected agent, model or
model variant changes. Runs start at least 300 ms apart (the interval aside), and a trigger that arrives while a run is
in flight causes exactly one more run, 300 ms after the first started or when it ends, whichever is later. A command
that has not closed its output and exited within 2 s of starting is stopped together with the programs it
started, and the last good line stays. On macOS and Linux the command runs in its own session, so it has
no controlling terminal: a script that reads the terminal size from `/dev/tty` (`stty size`) fails, and the command is
given no terminal size. On Windows
that covers what the shell is still running when it is stopped; a program that the shell started detached
(`start /b`) and then left is not stopped. Its stdin JSON gains `version`, `session` (`id`, `title`), `cwd`,
`project_dir`, `model` (`provider`, `id`, `name`, `variant`, the model selected for the next prompt), `agent`,
`output_style`, `context` (`used`, `limit`, `percent`, all three for the selected model), `cost` (`usd`, `duration_ms`,
`lines_added`, `lines_removed`), `status` (`idle` or `running`) and `vim_mode`; `session_id` stays. The `model` object
now names its provider `provider` (it was `providerID`), `cost` is an object, where it was a number, and `context`
holds `used`, `limit` and `percent`, where it held `tokens` and `percent`. `session_id` and `model` are `null` on the
home screen, where they used to be absent. `lines_added` and `lines_removed` are `null` until Orbit tracks them. The new
`status_line.colors` key (default `false`) renders the command's colors, bold, dim, italic and underline instead of
removing them. Every other escape sequence, such as a
title change or a clipboard write, is dropped in both modes, control characters are shown as their control pictures,
and format characters such as a right-to-left override or a zero-width space are written out (`\u{202e}`). Private Use
Area glyphs (Powerline, Nerd Font) and the zero-width joiner of an emoji sequence are drawn as they are. On Windows the
command runs through `cmd.exe` by its full path and no longer finds a program of the same name in the working folder
first.

Known gap: the prompt, and with it the status line, is replaced by the permission prompt while a permission is
pending, so the line is not drawn then, and `status` has no `waiting` value.

**Affects:** people with a `status_line` command, in particular scripts that read `model` or `cost` from stdin.

**What to do:** Update a script that read `cost` as a number to read `cost.usd`, one that read `model.providerID` to
read `model.provider`, and one that read `context.tokens` to read `context.used`.
Set `status_line.colors` to `true` to see your script's colors.

### The shell tool no longer runs commands in csh or tcsh

When the tool shell is picked for compatibility, Orbit used to accept a `csh` or `tcsh` login shell and run commands in
it. Those shells cannot run the POSIX syntax that models write, and Orbit cannot analyse their syntax to decide which
commands need a question. They are now skipped like `fish` and `nu`: the tool falls back to the shell Orbit picks
otherwise (`zsh` on macOS, `bash` or `sh` on Linux, PowerShell or Git Bash on Windows). Your own terminal and your login
shell are unchanged.

**Affects:** people whose login shell, `SHELL` or `shell` setting is `csh` or `tcsh`.

**What to do:** nothing. Commands that relied on csh syntax (`setenv`, `set x = y`) must be written for the shell Orbit
picks.

## Tools

### Web search results start with a Sources reminder

Before, the `WebSearch` tool returned only the results and its description did not mention how to cite them. Its
description now asks the model to finish any reply that uses search results with a "Sources:" section of markdown
links to the pages it used, and explains `allowed_domains` and `blocked_domains`. Results that contain at least one page
also begin with a one-line reminder of that rule, ahead of the first result so that a result the session bounds (it
keeps the head) still carries it; an empty result does not. Domain filtering and the query sent to providers are
unchanged.

**Affects:** people who read `WebSearch` tool output in logs, ACP editor users and VS Code users who expand a WebSearch card, who see the reminder,
and plugin or SDK code that compares the result text exactly.

**What to do:** Nothing, unless you parse the result text: expect the reminder line before the first result.

### Read-only shell calls run at the same time

Before, every `Bash` call in a step ran alone, in the order the model wrote them. Now a call whose command the shell
analysis judges read-only (`ls`, `git status`, `cat a | grep b`, `sleep 1`) runs beside other safe calls, up to
`tool_execution.max_concurrency`. Any other call, such as `touch x` or `echo hi > f`, still runs alone and waits for
the calls before it. The decision uses the command text the model sent, before any hook rewrites it, and ignores
`run_in_background`, the timeout and the paths the command reads. A command that cannot be analysed, an empty command,
and every call under PowerShell, `cmd.exe` or an unrecognised shell stay serial. When `PATH` has a relative entry, or an
empty one in a POSIX `PATH`, no command counts as read-only, so shell calls stay serial. A trailing `;` in a Windows
`Path` does not do that (see the note on `readOnly` below).

**Affects:** people whose model issues several read-only shell commands in one step, and plugins that observe the
`execute.before` and `execute.after` hooks of `Bash` and assume they never overlap.

**What to do:** Nothing. To keep shell calls serial, set `tool_execution.max_concurrency` to 1.

### A failing shell command cancels the shell calls beside it

Before, a foreground `Bash` call that exited with a non-zero code left the other calls of its step alone. Now, under
`bash`, `sh` and the other POSIX shells (Git Bash included), it cancels the calls of that step that are still running
and the ones not started yet, because commands in a step often depend on each other. The exit code is read by the
program that ends the command line, as written: `grep`, `rg`, `find`, `diff`, `test` and `[` only fail at exit code 2 or
more, since 1 means no match, differences, unreadable folders or a false condition. `grep x f && echo found` is judged
by `echo`, and a line the analysis cannot model (a `$(...)`, an unknown variable, a syntax error) fails on any non-zero
code. Under PowerShell nothing cancels anything: not an exit code, and not a timeout, a kill by a signal, a command that
cannot start or one that is removed while it runs (pinned by the explicit-shell rows in `test/tool-shell.test.ts`). Under
`cmd.exe` any non-zero code does. Under the POSIX shells timeouts, signals and commands that cannot start already
cancelled their siblings. Background commands are not affected.

The text the model sees says "Exited with code N" only when the code is a failure by the same reading: a `grep` with no
match, a `diff` that found differences and a false `test` come back with their output alone (an empty run reads as the
empty run of a command that succeeded), while `false`, `exit 3` and a `grep` of a missing file still carry the line. A
timeout and a kill by a signal always carry theirs. PowerShell keeps the line for every non-zero code, and the output
of a background command keeps it too. The structured `exit` field is unchanged.

The shell tool also reports `readOnly` and `destructive` for each call (advisory; nothing
is allowed or asked differently because of them). `rm -rf x`, `git reset --hard`, `git push --force`, `DROP TABLE` and
similar are destructive; every command under `cmd.exe` or an unrecognised shell is. `destructive` is read from the command
text alone; `readOnly` also depends on where each program would be found, so a program on a relative `PATH` entry or in
the working folder is not read-only. An empty entry of a Windows `Path` does not count as the working folder, because Git
Bash drops it and Windows PowerShell 5.1 does not search the folder for it (`test/shell-analysis/readonly-tools.test.ts`);
an empty entry of a POSIX `PATH` still does.

**Affects:** people whose model issues several shell commands in one step, and plugins or SDK code that read the
`error` field of a shell result's metadata.

**What to do:** Nothing. Put commands that must not cancel each other in separate steps, or end them with `|| true`.

### A large tool result is saved in the session's folder and the model sees a preview

Before, a tool result longer than 2,000 lines or 50 KiB (UTF-8 bytes) was cut to that size, the whole text was written
to a flat `tool-output/tool_<id>` file in Orbit's data folder, and the stored result kept only the cut text. Now size is
counted in characters. A text-only result above its threshold is written whole to
`<data>/tool-output/<session ID>/<message ID>-<call ID>-<hash>.txt` (`.json`, pretty-printed, when the result has several
text parts), and the stored result keeps the tool's own full content with a `persisted` entry in its metadata. The model
gets a `<saved-output>` block instead: the size, the file's path, and the first 2,000 characters (cut back to a line
break past the first 1,000). Clients and `execute.after` hooks still see the tool's own content. A result that holds an
image, a PDF or another file part is sent whole, and so is a result whose file cannot be written. The call ID in the
file name keeps only letters, digits, `_` and `-` (at most 64), and the hash keeps two IDs that differ only in other
characters or in letter case apart.

The threshold is the tool's declared limit capped by `tool_output.max_result_chars`, which defaults to `max_bytes` and
otherwise 50,000 characters. Read and the shell never save (the shell keeps its own capture limits and full-output
file); Grep declares 20,000, so a larger search is saved; MCP tools declare 100,000, so under the default ceiling their
results are saved above 50,000 characters instead of being cut at 50 KiB; other tools use the ceiling. `max_lines` and `max_bytes` now bound only the shell's own capture of a command's output.
An untrusted folder cannot set any `tool_output` key.

A session reads the files in its own folder without the question about folders outside the project. Another session's
folder, a subagent's for its parent, the parent's for a subagent and the source's for a fork are asked about, and so are
the flat `tool_*` files of earlier builds, which the seven-day cleaning still removes.

**Affects:** people who read tool results in logs or exported sessions, scripts that looked for `tool_*` files or the
`truncated` and `outputPath` metadata on results that were not from the shell, and people who set `tool_output`.

**What to do:** Nothing, unless you parse result text or metadata. Set `tool_output.max_result_chars` in your own
config to save results at another size.

### A tool result with nothing in it says so

Before, a tool that returned no content was stored as the text `undefined` (or `null` for an MCP tool whose server sent
no content), an empty result could stop the step, and a shell command that printed nothing returned `(no output)`. Now
every successful result that is empty, blank or only whitespace is stored and sent as `(<tool> finished and returned no
output)`, with the name the model called. A silent shell command's own result text is blank, so the same line applies;
its exit and timeout notices still follow as before, and a background command's stored output is its notice alone.
Failed calls are not changed.

**Affects:** people and scripts that read tool results, and plugins that compare a silent shell result with
`(no output)`.

**What to do:** Nothing, unless you match the old texts.

### A very long tool error is cut in the middle

A failed tool call whose message is longer than 10,000 characters now keeps its first and last 5,000 characters with a
line counting what was cut between them. The cut message is what is stored, shown by clients and sent to the model.
Nothing of a failure is saved to a file.

**Affects:** people who read long tool errors, such as a failing build's output.

**What to do:** Nothing.

### A shell result keeps the start of the output, and the rest is saved

Before, a shell command's result kept the last 50 KiB and at most 2,000 lines of its output, followed by a line that
named the full-output file. Now it keeps the first 30,000 bytes (`tool_output.max_bytes`, at most 150,000), cut back
to a whole character, and `max_lines` is no longer read. When the output is longer, the step links the command's output
file, cut to 64 MB, into the session's tool-output folder and the model gets the `<saved-output>` block with the file's
size before the cut, its path and a preview of the head, which starts at its first line that is not blank; the notices
after the output follow the block. Output whose head is all blank lines still gets the block, with an empty preview,
instead of being reported as no output. A command whose exit code reads as a failure is never saved: its text is cut to its
first and last 5,000 characters. The shell declares a 30,000-character result limit, so a head raised past that by `max_bytes` is saved by
the step like any other result. A background command's completion message and the result of a command you run with
`!` carry the head too, and both name the output file when the output did not fit. An output file
that cannot be read is named in the result instead of giving an empty one, and a link planted at its path is not
followed.

A finished command dropped from memory (after 25 newer ones) no longer deletes its output file when a result did not
take all of it; the seven-day cleaning removes it later.

**Affects:** people and scripts that read shell results, and people who set `tool_output.max_lines` or `max_bytes`.

**What to do:** Nothing. Remove `max_lines` from your config at your convenience; it is still accepted.

### Background tasks can be turned off

A new setting, `"background_tasks": false`, keeps work in the foreground. The shell tool (Bash or PowerShell) no longer
offers `run_in_background` and the Agent tool no longer offers `background`; a call that passes either runs in the
foreground. A shell command still running at its timeout is stopped instead of moving to the background, moving
running work to the background leaves shell commands and the subagents of the Agent and Workflow tools where they
are, and the tool descriptions drop the background guidance. A command defined to run as a subagent still runs in the
background. A project's or local value applies only once the folder is trusted.

**Affects:** people who want every command and subagent to finish before the model goes on.

**What to do:** Nothing, unless you want it: set `"background_tasks": false` in your own config.

### A background command is stopped at 5 GB of output, and a subagent's commands end with it

A shell command that has left the foreground is killed at once (no grace period) once its output file passes 5 GB,
checked every five seconds; its completion message starts with a line saying so. When the run that an Agent call
started ends, whether it finished or failed, in the foreground or the background, and also when a background subagent
resumed after a restart ends, every shell command the subagent still has running is killed and reports nothing to it,
and every shell notice still waiting for the subagent is withdrawn. A command you ran in the subagent's session with `!`
is yours: it keeps running and its notice stays.

**Affects:** people who start long background commands, and subagents that leave servers or watchers running.

**What to do:** Nothing. Start a long-lived server from the main session, not from a subagent, if it must outlive the
subagent's run.

### A shell timeout written as a string is accepted

The shell tool reads `timeout` written as a decimal string, such as `"5000"`, as that number of milliseconds. Any other
string, such as `"5s"`, is still invalid input, and the tool's schema still asks for an integer.

**Affects:** models that send numbers as strings.

**What to do:** Nothing.
### Memory is kept with the file tools, and the Memory tool is gone

Before, the model saved notes with a `Memory` tool, and Orbit regenerated `MEMORY.md` from them after every save and
showed the new index to the session at once. Now the model writes memory files with Write and Edit into the project's
memory folder (`<data>/memory/<project ID>/`, or the folder `memory.directory` names) and keeps `MEMORY.md` itself. A
memory file may carry `name`, `description` and `type` front matter. Writes and reads in that folder ask no question,
even under an `edit: ask` or `read: ask` rule or in plan mode. A deny rule there wins over any ask and over plan mode;
as elsewhere, a later allow rule of yours lifts it. A shell command that names the folder, or runs in it, is asked about
as before, even by an agent that allows every command. The main thread's prompt gets a guide to memory, except when a
`system_prompt`, a `system_prompt_file` with text or an agent's own prompt takes the place of Orbit's. When the guide
goes in the middle of a session, the model is told that memory is switched off only when it is; after a switch to such
an agent it is told only that the guide no longer applies.
`MEMORY.md` loads after the instruction files, cut at 200 lines and 25,000 characters with a note to the model, and a
change to it reaches a session from its next compaction or in a new session. A Read of a memory file more than a day old starts with a note of its age. The index Orbit generated before is
kept, without the line that named the tool. New: `memory.enabled`, `memory.directory` (read only from your own, local,
command-line and managed configs) and `ORBIT_DISABLE_AUTO_MEMORY`; `orb run --bare` turns memory off. A
`memory.directory` of `~/` that names home or a folder above it is not used, with or without trailing separators
(`~/./`, `~//`, `~/../`), and the default folder is kept; so is one whose path leads through a link to a network
share. A deny rule written for a `memory.directory` that is a link also decides a file named by the folder's real path. A `MEMORY.md` that links out of the memory folder, or to a
network share, is not loaded, and notes moved over from before trust add no line to a `MEMORY.md` that is a link.

**Affects:** people with permission rules or hooks written for the `Memory` tool, which now name no tool, and anyone
who reads the memory folder.

**What to do:** Nothing for existing notes in the default folder. If you set `memory.directory`, Orbit neither reads
the default folder nor moves anything into yours: move the notes, and their `MEMORY.md`, from
`<data>/memory/<project ID>/` to your folder yourself. Notes saved before a folder was trusted keep moving to the
default folder. Move a rule written for `Memory` to `Edit` and `Read` on the memory folder, and set
`"memory": { "enabled": false }` or `ORBIT_DISABLE_AUTO_MEMORY=1` to switch memory off.

## Files and web tools

Changes to the file tools and the web tools.

### Read refuses devices and budgets its output by tokens

The Read, Grep and Glob tools now refuse a device or stream path with a message that says it is a device or stream (the failure reaches a client as an ordinary tool error, with no dedicated error type), before anything is asked or opened: `/dev/zero`, `/dev/random`, `/dev/stdin`, `/dev/ptmx`, `/dev/tty*`, `/dev/cu.*`, `/dev/pts/*`, `/dev/fd/*` and `/proc/<self, thread-self or pid>/[task/<tid>/]fd/*` on Linux and macOS, and `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9` (also `COM¹`, `COM²`, `COM³` and the `LPT` forms), `CONIN$`, `CONOUT$` (with or without an extension) and the `\\.\` forms and the `\\?\` forms of these names on Windows (a `\\?\` drive path such as `\\?\C:\Windows\win.ini` is read as the plain drive path and goes through the usual approval). On Linux and macOS a path whose target, followed through links, exists and is neither a file nor a folder (a pipe, a socket, a device the list lacks, or a link of the repository to one) is refused the same way. On Windows 11 (build 22000 and later) only the bare name is refused, with its trailing dots and spaces dropped (`CON`, `con.`, `nul `), because there `nul.txt` or `aux.c` is an ordinary file that reads like any other; before Windows 11 a name with an extension is refused too, so rename such a file to read it (pinned by `test/device-path.test.ts`, which runs both builds on any host). Files such as `console.log` still read. A read also returns at most about 25,000 tokens of rendered text (line numbers included) instead of 50 KB: a file of ordinary lines up to that size comes back whole where it was paged before, a file of more than 2,000 lines pages whatever its size, and a truncated read ends with the offset to continue from and a hint to use Grep. Notebooks page by the same budget.

**Affects:** people and scripts that read very large files or device paths through the Read tool.

**What to do:** Nothing for ordinary files. Continue a truncated read from the offset it names, or use Grep to find what you need.

### A touched file no longer blocks an edit, and a repeat read is short

The file tools remember what a Session read of a file and what its own edits left behind. When a file's modification time is newer than the one remembered but its bytes are the same (a touch, a checkout that rewrote the same content, a formatter that changed nothing), Edit, Write, NotebookEdit and Patch now go ahead instead of reporting that the file changed. This applies to files of up to 256 KiB that the Session read, whatever range it asked for, and files it last edited or wrote; a larger file still compares modification times only. A file whose content changed is refused as before, and a change of line endings alone (CRLF to LF) counts as no change while adding or removing a byte order mark does not. A file that was never read is refused before any of it is loaded. A file reached through a symbolic link is compared by the link target's modification time, as its read recorded it. Separately, reading the same range of an unchanged text file or notebook again in the same Session answers with a short "unchanged since your last read" note instead of the text; the tool's structured output is unchanged and its metadata says `unchanged: true`. Only the last range read of a file is remembered, so reading range A, then range B, then A again returns A in full. The note is never used for a directory listing, an image or a PDF, and never skips the permission check. The note is not used after the Session is compacted or a revert is committed, nor after any Edit, Write, Patch or NotebookEdit of that file. A completed compaction also forgets that the Session read any file: a file has to be read again after a compaction before Edit, Write, Patch or NotebookEdit may change it (a failed compaction changes nothing).

**Affects:** people who run formatters, version control or build tools while a Session is open, and clients that show Read results.

**What to do:** Nothing.

### Grep returns up to 250 matches in a token-bounded page, and clips long lines

Grep used to return 100 matches per call and cut a line at 2,000 characters. Its default page is now 250 matches, but
a page in `content` mode also stops before its text passes about 25,000 tokens, so a call with a lot of `context` holds
fewer. A truncated result says which matches it shows and the exact `offset` that continues it; paging from that
offset skips nothing and repeats nothing, because matches come in path order. A line longer than 500 characters is cut
to a window that starts about 100 characters before its first match, with ellipsis markers and a
`[line truncated: N chars]` note, and the submatch offsets in the result index into the clipped text; a match that runs
past the window is kept and cut at its end. A multiline match is measured one line at a time, so only a line longer
than 500 characters is cut, and a match of more than 20,000 characters ends with a
`[match continues for N more lines]` marker. A line that is not valid UTF-8 is shown with replacement characters
instead of failing the search. Submatch
`start` and `end` are now offsets in UTF-16 characters of the row's `text`, not UTF-8 bytes, on every line including
unclipped ones (a plugin reading `Ripgrep.Service` sees this too); `Match.offset` stays a byte offset. Grep and Glob
also skip `.svn`, `.hg`, `.bzr`, `.jj` and `.sl` folders and files of those names, as they already skipped `.git`.
Glob still returns at most 100 files.

**Affects:** people who read Grep results in scripts or plugins, and anyone who relied on a search entering one of
those version-control folders.

**What to do:** Nothing for most setups. Pass `limit` to keep the old page size, and follow the `offset` in the
truncation note for more results.

### Language servers hear about every write, and about each save

A file created or overwritten with Write now goes to its language server, so the tool result carries the same inline
errors that Edit already reported; before, a Write got none. After every edit (Write, Edit, Patch and NotebookEdit),
the server is also sent `textDocument/didSave` once the new text is synced, with the text only when the server asked
for it. Servers that run extra checks on save, such as rust-analyzer with `cargo check`, may now do so after each edit.
The `LSP` tool never saves.

Language servers and formatters now also decide per file. A file outside the project is served only when the folder that
owns it (the nearest folder above it with a `.git` or `.hg`, else its own folder) is trusted too; trusting the project
is no longer enough for an edit that reaches into another folder. A link is decided twice, by the spelling it was
given and by where it really leads, and the stricter answer wins: a link in an untrusted folder, even one with no
`.git`, that leads into a trusted one is refused. A skipped file leaves the tool result as it was. A server is started through Orbit's process spawner: a bare program name is found on `PATH`
only.

**Affects:** people with a language server configured or on `PATH`, mostly Rust users.

**What to do:** Nothing. Set `lsp` to `false` to turn language servers off.

### A web search that nobody agreed to fails as "websearch.not-enabled"

When the web search consent form is cancelled, is not answered within a minute, or cannot be shown, the `WebSearch` tool now
fails with the type `websearch.not-enabled` and a fixed message that names the `websearch` setting, tells the model that
only the user can turn search on (it must not edit Orbit's config or settings files or send the query to a search
service some other way) and not to
call the tool again in this run, and says how the user can turn search on. Before, the failure had the type `tool.execution`
and the message "Unable to search the web for ...". Nothing is searched or stored: a cancelled or timed-out form does not
save a choice, so the next call asks again. Headless runs (`orb run` with no flag, `--auto` or
`--dangerously-skip-permissions`) still never answer the form, so they search only when the user has already chosen: by
answering the prompt in an interactive client, or by setting `websearch` in their own config or a trusted project's
config; the exit code of such a run does not change.

**Affects:** clients and hooks that match on the error type of a failed `WebSearch` call, and people who read logs.

**What to do:** Nothing. To allow search in a headless run, set `websearch` (for example `{ "provider": "random" }`) in your
own Orbit config.

### WebFetch follows same-site redirects only, checks every hop and caches pages for 15 minutes

`WebFetch` used to let the HTTP client follow every redirect to any host, with one approval for the URL the model named.
It now sends each request itself:

- A redirect within the same site is followed: the same protocol (or `http:` to `https:`), the same port, no credentials
  in the target, and the same host once one leading `www.` is dropped from each. A redirect to anything else is not
  followed. The call succeeds with a note that names the URL that redirected, the target and the status, and says to call
  `WebFetch` again with the target. Nothing is sent to the target, and the note is not cached. A 303 is a status error.
  At most 10 redirects are followed; an 11th fails with "Too many redirects". (Tests: `WebFetchTool redirects` in
  `packages/core/test/tool-webfetch.test.ts`.)
- Every request is asked about, not only the first, so a rule written for a URL applies to a redirect target on the same
  site. A hop from `example.com` to `www.example.com` is a different host, so it can prompt once. The approval of a hop
  shows the hop's own method and URL, with the hop it came from in `redirect`. (Tests: "follows a same-host redirect" and
  "follows a hop that only adds or drops a leading www.")
- An `http:` URL is fetched over `https:`, and the approval shows the `https:` URL. A single-label host such as
  `localhost` or an address keeps its scheme. A URL with a username or password, or one longer than 2000 characters, is
  refused before anything is asked or sent. (Tests: `WebFetchTool URL checks`.)
- After the permission for a request, the host is checked: a name that resolves to a loopback or private-network address
  is refused unless `experimental.allow_local_fetch` is on, a link-local or cloud metadata address is always refused, and
  so is a name that resolves to nothing. The request then connects to the address that was checked, with the name in
  `Host` and in the TLS handshake. Fetching a local development server therefore needs `experimental.allow_local_fetch`,
  which a repository cannot turn on. (Tests: `WebFetchTool address guard and pinning`.)
- A response body may be up to 10 MiB, up from 5 MiB; an HTML page is still converted to Markdown within a 5 MiB budget.
  (Tests: `WebFetchTool size cap`.)
- A fetched page is cached for 15 minutes from the moment it is stored, up to 50 MiB in all, and shared by the sessions of
  one project. A repeat call within that time sends no request, but still asks permission for the URL and for each
  redirect it was reached through, in order, so a rule or a decline written for a hop applies to a cached page as it does
  to a live one. A failure, a redirect note or a timeout is never cached. (Tests: `WebFetchTool cache` and
  `tool-webfetch-cache.test.ts`.)
- The timeout (30 seconds by default, at most 120) applies to each request and to the read of the body, not to the whole
  call and never to a question put to you, which can wait as long as you take. A chain of redirects can therefore take
  longer than the timeout in all, and the limit of 10 redirects bounds it. (Tests: `WebFetchTool timeout`.)
- The name of a site is now resolved on this machine, and a name that does not resolve there is refused. The exception
  is a request that goes through a configured proxy, which is sent the name and resolves it, as the note "`WebFetch`
  sends the host name to a configured proxy" below says.

**Affects:** people and scripts that fetch a local server or a private address with `WebFetch`, pages that redirect to
another host, and anyone with `WebFetch` rules written for `http:` URLs, which now match the `https:` URL.

**What to do:** To fetch local servers, set `experimental.allow_local_fetch` to `true` in your own configuration. Write
rules for the `https:` form of a URL. When a note reports a redirect, call `WebFetch` again with the target it names.

### Edit keeps a file's curly quotes and removes the line break of a deleted line

When Edit finds `old_string` only after matching typography (curly quotes, dashes, spaces) or ignoring trailing whitespace, and the quote characters of the text it found differ from those of `old_string`, it writes the straight `"` and `'` of `new_string` in the quote style of the text it replaced: curly doubles are used only if the replaced text has curly doubles, curly singles only if it has curly singles, and a quote opens at the start of `new_string`, after a space, tab or line break, after `(`, `[` or `{`, or after an en or em dash, and closes anywhere else (a no-break space and a hyphen-minus close). A match whose quotes equal `old_string`'s (an exact match, or one that differs only in whitespace, dashes or spaces) is never restyled. When `new_string` is empty and the matched text is the only thing on its line (apart from whitespace), Edit also removes the line break, so no blank line is left; a deletion in the middle of a line, or one whose `old_string` starts or ends with a line break, removes only the matched text.

Only the four English curly quotes (U+2018, U+2019, U+201C and U+201D) match a straight quote when Edit looks for
`old_string`. A file that spells its quotes with the low-9 forms (U+201A and U+201E, as German does) or the reversed
forms (U+201B and U+201F) no longer matches an `old_string` with straight quotes: the edit fails as not found and the
file is left alone, so spell the quotes of the file in `old_string` (pinned by the `Q9` rows in `test/tool-edit.test.ts`).

**Affects:** people and scripts that rely on the exact bytes Edit writes, and edits of text with German or reversed quotes.

**What to do:** Nothing, or copy the file's own quote characters into `old_string`.

### WebFetch answers a question about the page

WebFetch used to return the page as text, Markdown or HTML, and answered a question only when you passed an optional `prompt`. Now `prompt` is required and `format` is gone (a stale `format` is ignored). A small model reads the page, with nothing else from the conversation and no tools, and WebFetch returns only its answer. HTML is converted to Markdown first, and a page longer than 100,000 characters is cut, with a note that it was. If no answer can be produced, WebFetch returns a short note that says so, and never the page. The page stays cached for 15 minutes, so trying again costs only the answer.

A new key, `webfetch.verbatim_hosts`, lists hosts (`docs.example.com`, `*.example.com`, or `example.com/guides` for a path prefix) whose Markdown pages under 100,000 characters are returned whole instead of answered. Write a non-ASCII host in its ASCII form and an IPv6 address in brackets. The default is none. Listing a host grants no permission to fetch it, and a project that is not yet trusted cannot set a non-empty list.

**Affects:** prompts, scripts and plugins that called WebFetch without a `prompt`, or relied on it returning the raw page or HTML.

**What to do:** Ask for what you need in `prompt`. To read a documentation site whole, list its host in `webfetch.verbatim_hosts` in your own configuration.

### The LSP tool finds implementations, searches workspace symbols and walks call hierarchies

The `LSP` tool has five new actions: `implementation`, `workspace_symbols` (with a new `query` input, sent as an empty
string when left out; `path` only chooses the language server), `prepare_call_hierarchy`, `incoming_calls` and
`outgoing_calls`. The call actions take the position of a function's name and use the first item the server finds there.
The language server client also declares link, implementation, call hierarchy and workspace symbol support when it
starts, retries a request up to three times (after 0.5 s, 1 s and 2 s) when a server answers that its content changed
while it was indexing, and refuses a file larger than 10 MB with a message instead of sending it.

The existing actions print differently: `definition` and `references` give a headline with a count, references are grouped
by file, a link falls back to its whole target when it has no selection range, hover shows a list as separate paragraphs
and starts with the range's position when the server sends one, and `symbols` shows each symbol's kind, detail and the line
where its range starts. Paths are relative to the session's folder only when that is shorter and does not climb two folders, use
forward slashes, and a result that is not a file path (for example a `jdt:` address) is printed as given. Results in
git-ignored files are left out of `definition`, `implementation`, `references` and `workspace_symbols`; a file git tracks is
always shown, and a folder that is not a repository hides nothing.

**Affects:** models and scripts that parse the text of an `LSP` result, and anyone who relied on seeing results inside
git-ignored folders such as `node_modules`.

**What to do:** Nothing for most setups. Read results by their content, not by the old `path:line:column` lines.

### Read returns a PDF by page range

Read takes a new optional `pages` argument for PDFs: a page such as `3` or a range such as `1-5`, counted from 1, at most 20 pages per call. It copies those pages into a new PDF, so the text stays selectable. A PDF of more than 10 pages can no longer be read whole: Read fails and tells the model to pass `pages`, where it used to send the file whole up to 20 MiB. A last page past the end is clamped to the last page; a first page past the end fails. A PDF that cannot be parsed, or is password-protected, is refused with a message instead of being sent; so is one whose page tree lists a page node twice, and one that holds any invalid object, even an unreferenced one, which a more lenient reader would still open. A PDF above 32 MiB is refused, and one between 20 and 32 MiB can still be read through `pages`. `pages` on any other file is ignored; a malformed value, or one wider than 20 pages, fails before anything is read. No program is installed or run: the pages are cut in process.

**Affects:** models, scripts and plugins that read PDFs of more than 10 pages, or PDFs that are not valid, with Read.

**What to do:** Pass `pages`, for example `"1-5"`, for a long PDF. A model that cannot take PDF input still receives the usual unsupported-media text.

### `--input-format stream-json` lets a program drive a headless run

`orb -p --input-format stream-json --output-format stream-json` (and `orb run --input-format stream-json --format stream-json`)
reads one JSON input per line from standard input while the run goes on, instead of sending one message and exiting. The
inputs are `user` (`text`, optional `files`, `delivery` `steer` or `queue`, `id`), `interrupt`, `permission_reply`,
`form_reply`, `form_cancel`, `set_model` and `end`. Output is the envelope of `--output-format stream-json`, with an init
line first and one `result` line for each busy period, plus `permission_request` and `form_request` lines for the asks and
questions the program should answer, `request_cancelled` when one of them is settled by someone else, and `error` lines with
type `invalid_input`, `unknown_request` or `input_failed` for a line or operation that failed (the run goes on). A message
sent with `delivery: "steer"` joins the work that is running and shares its result; `"queue"` waits and gets its own. When
standard input closes, every ask that is still open is rejected (a question is cancelled) with feedback so the model carries on,
the queued work finishes, and the exit status is 1 if the last result was an error and 0 otherwise. A first message may also be
given on the command line. Like `orb -p`, it refuses an untrusted folder. Without `--yolo`, `--auto` or `--dangerously-skip-permissions` every ask goes to the program;
with one of them, asks are approved without being shown.

**Affects:** nothing that exists: the flag is new. `--input-format` is a new `-p` flag, so a script that passes it to a
root command without `-p` now gets the usual usage error.

**What to do:** Nothing, unless you want to drive Orbit from a program. See `orb -p --help` for the line shapes.

### The question tool has limits and option previews

The question tool now accepts 1 to 4 questions per call, with 2 to 4 options each. Question texts must differ within a call and option labels must differ within a question. A call outside those limits is refused with a readable error and the model can retry; before, any non-empty list of questions and any number of options was accepted. An option can also carry a `preview`, markdown that a client may show while the option is focused. SDK clients receive it on `Form.Option`; Orbit's own clients do not draw previews yet, so the tool description does not mention them to the model. Previews apply to single-select questions only and the answer is still the option label. The tool description was rewritten, and it now declares a 100,000-character `maxResultChars` limit.

**Affects:** SDK callers that build question forms and read `Form.Option`, which gains an optional `preview`, and anyone whose agents or plugins send questions with no options or one option, more than four options, or more than four questions.

**What to do:** Nothing for most setups. Clients that do not draw previews keep working because the field is optional.

### Read reports image sizes, and a resized image comes with a note

Read now opens an image with a header line that names its pixel size and type, for example "Image read successfully (1920×1080 px, image/png)", and puts the same size in the result metadata under `image`. When the size cannot be read from the header, the line names the type alone. Whenever an image that a tool returns directly is scaled down to fit the size limits, a short bracketed note follows it with the original size, the size it is shown at and a factor (original width divided by shown width, two decimals) for turning positions read from the shown image into positions in the original. An image that is only re-encoded at the same pixel size gets no note, and neither does one passed through because the resizer is unavailable. An image returned to a Code Mode program (the Execute tool) is resized as before and gets no note yet, and images in your own prompts are resized as before and get no note yet.

**Affects:** anyone who matches Read's exact "Image read successfully" text, SDK callers that read the Read tool output schema (images gain an optional `dimensions`), and sessions that read large images.

**What to do:** Nothing for most setups. Match the line by its prefix if you parse it.

### Editing any file of a plugin folder asks about the folder again

A project plugin folder is now fingerprinted by every regular file in it, not only its entry files and `package.json`, so a change to a helper module counts like a change to the entry. A folder named `node_modules` directly in `plugin/` or `plugins/` is never a plugin: it is not read and not loaded. Inside a plugin folder, `node_modules` is named but not read, so a change inside an existing `node_modules` does not ask again, while creating it (a first install) or changing a lockfile or `package.json` does. Before a folder is trusted, Orbit lists a plugin folder without following links that lead out of the project or onto a network share.

**Affects:** projects with plugin folders that hold more than the entry files, under a trust grant made before this change.

**What to do:** Nothing; grant the folder again if it asks.

### `orb run` and `-p` wait for commands that moved to the background

A shell command that outlives its timeout now keeps running in the background, and the model is told when it ends. A headless run (`orb run`, `orb -p`) used to stop at the first idle moment, which killed such a command with the standalone server, or left it running unwatched in a service, while the run reported success. It now keeps waiting while the session owns a running command, then waits for the step that the completion notice starts, so the final answer reflects the command's result. A notice that does not arrive within ten seconds after the last command ended stops the wait.

**Affects:** scripts and CI jobs that run `orb run` or `orb -p` with commands longer than the shell timeout, or that start a long-lived command in the background (a dev server) and expect the run to end without it.

**What to do:** Nothing for commands that end. Stop a long-lived command before the model's last step, or interrupt the run.

### Deny and ask rules also see where a link in a trusted project leads

A link in a trusted project (a symlink or a junction) was followed, but the rules were checked against the link's own name only, so `keys/id_rsa` passed a Read or Edit deny written for `~/.ssh/*` when `keys` led to that folder, and a managed deny did not hold. The file tools (Read, Grep, Glob, LSP, Edit, Write, Patch, NotebookEdit) now also check the deny and ask rules, the person's and the managed ones, against the place the path really leads to, a link that points nowhere included. An allow written for the real place alone never lifts the link: only a deny or an ask on that place applies.

**Affects:** projects that hold links to folders outside them, under deny or ask rules written for those folders.

**What to do:** Nothing. Write the rule for the real folder as before; it now covers the links to it.

### A deny on the place a link leads to now holds for links outside the project, and for rules written relative to it

The check above also applies to a path outside the project that goes through a link (`~/elsewhere/k` leading to `~/.ssh`): a deny or an ask written for the real folder holds even when an allow for `~/elsewhere/*` comes after it, in the person's rules and in the managed ones (the rows "a deny or ask for the real place beats a later allow for the link's folder" in `packages/core/test/permission-leads.test.ts`). The Plan agent keeps its plan file when the home folder or `~/.orbit` is a link, because its allow for the plan folder is also written for the folder's real path (`packages/core/test/plugin/plan.test.ts` and the Plan rows of `permission-leads.test.ts`); a link inside the plan folder that leads elsewhere stays denied.

A place a link leads to is matched in its real path, in the same place under the project's folders as they are spelled, and relative to the session folder (`secrets/*`, `.env`), whether Orbit was started in the project's folder or through a link to it, for relative and absolute rules, managed and configured ("the session folder spelled directly or through a link" rows). For a place inside the project the last rule that matches any of those spellings decides, so an allow written as `src/*` or as the absolute path still covers a link to `src/real-gen`. A link that leads out of the project is decided by the folder it leads to: under a broad `Edit * ask`, an allow written for the link's own name (`vendor/*`) does not lift the ask. Read refuses a `\\?\Volume{...}` or `\\.\Volume{...}` path as a share or device spelling (`file.spelling`), and a device such as `NUL` with `file.device` instead of `unknown` (`file-access-spelling.test.ts`, `tool-read.test.ts`).

**Affects:** projects with links to folders, and `\\?\` or `\\.\` paths on Windows.

**What to do:** Nothing for most setups. To allow a link that leads out of the project under a broad ask, write the allow for the folder it leads to.

### The Ollama model list is read before the first session starts

Starting a location now waits for the first read of the Ollama server's model list (each request is limited to 1 second),
so a run that relies on the default model finds the Ollama models instead of failing with "No model was set" when the
list arrives a moment late. With an Ollama address that does not answer, the start takes up to 1 second longer.

A read that a location rebuild interrupts (as `--trust` does right after it grants) no longer leaves a "checked" mark
without models behind, so the next start reads the list again instead of finding it empty until the refresh interval
passes. The LM Studio and vLLM model lists follow the same rule.

### The shell guard asks about more places for PowerShell, and reports a refused place as unresolved

PowerShell 7 goes to the home folder when a location change names nothing, so a bare `Set-Location` or `cd`, `Set-Location $null`, and a variable that is unset or empty (`${env:NAME}`) are now asked about as the home folder on every host; Windows PowerShell 5.1 fails there, and the home folder is the stricter reading. On Linux and macOS a backslash in a PowerShell word is read as a separator, as `pwsh` reads it there, so `Set-Location ..\outside` is asked about as `../outside`. A place that the file layer refuses (a link of the project that leads to a share, or a share spelling) is now reported as unresolved even when it lies in the sandbox's writable roots, where it used to count as inside them, and so is any `\`-led place when the project itself is on a network share. The effect is one more question for these unusual spellings, never fewer.

A PowerShell location change to an empty path (`Set-Location ''`, `cd ""`, `-Path ''`, `-Path:''`) or with only parameters that take no path (`cd -PassThru`, `cd -ErrorAction Stop`) is asked about as the home folder as well, since PowerShell 7 goes home for each of them. The end-of-parameters marker `--` names no place, so `cd --` and `cd -PassThru --` are asked about as home too, and a block comment or a quoted `<#` in the input no longer changes that.

**Affects:** `pwsh` users who run `cd` or `Set-Location` with no folder or with an unset variable, `pwsh` on Linux or macOS with backslash paths, and projects that hold links to shares or sit on a network share.

**What to do:** Nothing; answer the extra question, or write the folder out.

### A link to a network share is never opened by a loader, and a trusted project's tools ask about one

In a repository, a link that leads to a Windows share or device path (`\\host\share`, `\\.\...`) is now left alone,
before anything is asked, by the loaders that `share-roots.test.ts`, `theme-share.test.ts` and `store-share.test.ts`
pin: the commands, agents, skill folders and plugin source folders of a config folder, the compatibility roots, the
settings file, the MCP file, `{file:}` references, instruction markers found by walking up, the custom themes of the
terminal UI and Mini (`.orbit/themes`), the run store (`.orbit/runs.db` and its `-wal`, `-shm` and `-journal` files)
that `orb flow` opens, and the workflow and suite files that `orb flow` reads before it asks about trust, which
includes the file name that `orb flow resume` takes from the run store. Folders are listed without following links,
and a link inside them is entered only after its target is known not to be a share (in a trusted project too). Before,
one such link made the start, the trust status or a reload wait for the share to answer. A theme behind such a link is
skipped, with one line in the log, and `orb flow` stops with a message that names the store or the file. Not covered:
config discovery's own `.orbit` folder, the loading of config files by `Config`, the compatibility plugin's real-path
lookup, the terminal UI's plugin folders, the native file watcher and the VS Code diff view.

A trusted project's file tools now ask before they open a place that a link of the project leads to a share, as they do
for any folder outside the project; the place is not read to draw the question. A chain of more than 80 links is
refused with a message about links, not about shares. On Linux and macOS the "too many links" answer is a rooted path,
so it can no longer be taken for a path inside the working folder.

**Affects:** projects that link to network shares, on Windows.

**What to do:** Nothing; use the share's drive path, or copy the files into the project, if a loader should read them.

### Mercurial is not run in a folder that is not trusted

When a client opened a folder that holds `.hg`, Orbit ran `hg log` there to name the project, and then `hg branch`,
`hg status` and `hg diff` for the branch and the changes, and Mercurial loads the `[extensions]` and `[hooks]` of that
folder's own `.hg/hgrc` into each command. None of them is run now until you trust the folder: the branch is unknown
and there are no changes or diffs, and they appear once you trust it. An untrusted Mercurial folder is its own project
(identified by its path), not the shared `global` project, so its saved "always allow" answers are not shared with other
folders. A trusted folder with no `hg` or no changeset keeps that name too (see "A repository that git or Mercurial
cannot name keeps its project once trusted").

**Affects:** Mercurial users who open a clone before trusting it.

**What to do:** Nothing; trust the folder.

### Git is not run in a folder that is not trusted

When a client opened a folder that holds `.git`, Orbit ran `git rev-parse`, `git remote get-url`, `git rev-list` and
`git worktree list` there to name the project, and `git status`, `git diff` and `git reflog show` for the branch and the
changes, and the location watcher asked git where `HEAD` is. Git applies the folder's own `.git/config`, which can name
programs for it to run: `core.fsmonitor`, hooks, the filter and text-conversion drivers that `.gitattributes` selects, and
`gpg.program` for a commit that carries a signature. None of them is run now until you trust the folder. The project is
named from the files of `.git` (the remote URL in its config, or the path of the folder when it names none), the branch is
unknown and there are no changes, diffs or review base, and they appear once you trust the folder, with no restart. A
repository with a remote keeps the project ID that it had. One with no remote is named by its path until you trust it (never
`global`, whose saved "always allow" answers every such folder would share), and by its first commit afterwards; one with
no commit yet keeps the name of its path (see "A repository that git or Mercurial cannot name keeps its project once
trusted").
The URL is read as written, so a remote that an include or a `url.<base>.insteadOf` rule supplies or rewrites gives the
folder another project ID until you trust it. A linked worktree follows the decision for its main checkout. A `.git` that is a link, a submodule or a separate git
directory, or that names another repository's directories, is read for its remote only after you trust the folder, and
counts as a project of its own until then. The check that asks git whether a path is ignored runs without
`core.fsmonitor`.

On Windows, when git is on no PATH, Orbit no longer starts the bare name `git`. The library that starts programs looks in
the working folder for a bare name, with and without an extension, and started the interpreter named by the first line of a
file called `git` that a repository could ship. A git that is not found now fails as a git that is not installed fails.

**Affects:** anyone who opens a clone before trusting it, in the terminal UI or with `orb`, and on Windows anyone whose git
is not on PATH.

**What to do:** Run `orb trust` in the folder, or choose "Trust this folder" when the terminal UI asks, which it does only
for a folder that holds config of its own back, so for a repository with none no dialog or indicator says that the
branch and the changes wait (`/trust` does not show either); or put git on PATH.

### Declarations that print the environment ask like any command

`export -p`, a bare `export`, `declare` or `typeset` (with or without `-p`, `-f`, `-F`), a bare `local` or `readonly`, and any of them with a print or function flag list every variable with its value, which would send credentials in the environment to the model. They are now shell requests that a `Bash` rule (yours or your organization's) can allow, ask about or deny. Declarations that only set named variables (`export A=1`, `declare -x B=2`, `export A`) and `unset`, `cd`, `pushd` and `popd` still run without a question.

A repository's `HEAD`, `objects`, `refs` and `.git` that are links to a network share are no longer opened by the shell guard's repository check, and the same holds for the `.git`, `.hg` and `.orbit` names the terminal UI looks for at startup. A link of this kind counts as a repository marker that is there but not followed, so the shell command asks and Orbit starts at once instead of waiting about 40 seconds for the share.

**Affects:** anyone who runs `export -p`, `declare -p` or similar from the shell tool under a rule that allowed them silently, and Windows users who open a folder that holds such links.

**What to do:** Nothing; answer the question, or write a `Bash` rule for the form you want.

### Shell rules meet printing declarations

A leading assignment or a wrapper in front of a program (`FOO=1 rm x`, `timeout 5 rm x`, `nice`, `nohup`, `time`, `stdbuf`, `env`, `sudo`, `doas`, `exec`) is still not looked through: a `Bash` deny or ask rule written for the program (`rm *`) does not meet it, and an "always" reply to such a command saves what the scanner saves for it and nothing more. That is a known gap, carried as a follow-up by `shell-safety-12`, so a leading assignment or a wrapper can still step around a `Bash` deny rule.

A declaration that prints the environment (`export -p`, `declare -p`) next to other commands (`export -p; ls`, `declare -p && git status`, `export -p | cat`) is a request of its own, so a `Bash` ask or deny for it applies and an allow for the other command does not lift it.

Opaque PowerShell input that starts with a path to a program in the repository (`.\rm x`, `scripts\rm x`) is no longer lifted by an allow written for the cmdlet of the same name; a deny for the cmdlet still blocks it.

"Always allow" no longer offers `Where-Object *`, `Select-Object *`, `Sort-Object *`, `Group-Object *`, `Measure-Object *`, the `Format-*` cmdlets, `Out-String`, `Out-Host`, `Write-Output`, `Write-Host`, `Start-Sleep`, `Invoke-WmiMethod` or `Invoke-CimMethod`, or their aliases, because a saved grant would lift script blocks and .NET calls in their arguments.

**Affects:** anyone who runs `export -p`, `declare -p` or similar next to other commands under a rule that allowed them silently, and anyone who saved "always" for one of the cmdlets above.

**What to do:** Nothing; answer the questions. For a program that you do not want run behind a wrapper, deny the wrapper too.

### Shell commands that write through an output option meet your Edit rules

The shell guard now records the file that an output option names as a write: `sort -o`, `-oFILE`, `--output` (and any prefix of it that `sort` accepts), the second operand of `uniq IN OUT`, `find -fprint`, `-fprint0`, `-fprintf` and `-fls`, `tree -o` and `--output`, and the file of a `w`, `W` or `s///w` command (and the file of an `r`) in a sed script given on the command line. An `Edit` rule on that file applies, a file outside the project asks the folder question, and the sandbox treats it as a write. Before, these files were recorded as reads or not at all. `rg --pre` and `--hostname-bin` name a program, so such a command is asked about as a whole. Sed reads `[/]` as a bracket that holds the delimiter, so `sed -n '/[/]/w out'` records `out`. A git output file (`git diff --output`, `git format-patch -o`, `git archive -o`) is not checked as a write, and an assignment-shaped argument such as `cat x=~/s` has its `~` read literally, although bash expands it (`paths.test.ts`); both are follow-ups carried by `shell-safety-12`. `dd` is the exception: `dd if=~/x of=~/y` expands both, as bash does (`paths.test.ts`), and `sed` refuses a word such as `f=~/x` rather than guess (`sed.test.ts`). Writers that the guard does not model (`curl -o`, `wget -O`, `awk` redirects, `tar -x`, interpreter one-liners) are unchanged.

A read through a wildcard (`cat secr*.txt`, `head *`) is still checked against your `Read` rules for the folder it starts in, not for each file the wildcard matches. A glob spelling of a file can therefore still read past a `Read` deny on that file. That is a known gap, carried as a follow-up by `shell-safety-12`.

**Affects:** anyone with `Edit` deny rules who also lets the model run shell commands.

**What to do:** Nothing; a command that your rules now stop is refused with the rule that matched.

### The WebSearch domain lists are `allowed_domains` and `blocked_domains`

The two optional inputs of `WebSearch` that filter results by site are now named `allowed_domains` and `blocked_domains`.
Before, they were `allowedDomains` and `blockedDomains`, and a call that used the new names got no filtering, since the
keys were dropped. The old names are no longer read: a call that sends them is searched without a filter. The names show
in the tool description, in the permission request's `metadata`, in the input that a foreign hook receives as
`tool_input`, and in the fields that the ACP client is shown (pinned by `test/tool-websearch.test.ts`,
`test/plugin/lifecycle-hooks.test.ts` and `packages/cli/test/acp/tool.test.ts`).

**Affects:** plugins, hooks and prompts that name the old keys of a `WebSearch` call.

**What to do:** Use the snake_case names.

### Web tools refuse bad searches with a type, send no trace headers, and Read keeps folders and long lines in bounds

- `WebSearch` refuses a query shorter than 2 characters (type `tool.input-invalid`) and a call that gives both
  `allowed_domains` and `blocked_domains` (type `websearch.invalid`). Both are refused before the permission request, the
  consent form or any provider call, so nothing is asked or sent. Before, a one-character query was sent to the provider
  and the blocked list silently won over the allowed one.
- `WebFetch` refusals now carry a type: `webfetch.refused` for a URL that cannot be fetched (not http or https,
  credentials, longer than 2,000 characters, a host with `*`) and for an address the address guard blocks, and
  `webfetch.redirect-limit` for more than 10 same-site redirects. Code Mode `fetch` uses `webfetch.refused` for the same
  refusals. Before, they arrived as `unknown` or `tool.execution`. Failures that are not refusals (a status error, a
  timeout, an unsupported content type) keep their old type.
- `WebFetch` and the web search providers no longer send `traceparent`, `tracestate` or `b3` headers to the sites and
  providers they contact, on the first request or on a redirect hop. Requests to model providers are not affected.
- `Read` of a folder now stays within about 25,000 tokens, like a file: a long listing is cut before the entry that
  would pass the budget, with the usual `Continue reading with offset:` note.
- `Read` of a file with very long lines, or none, no longer slows down with the file's size or holds the whole file in
  memory. The part of a line past what a page can show is skipped as it is read; a null byte in it still makes the file
  binary.
- The note for a repeat read of an unchanged range and the note after a resized image are worded differently
  ("this range has not changed since you last read it ..." and "[Shown at W x H px; the file itself is ...]"), and the
  extraction instruction for a host in `webfetch.verbatim_hosts` is reworded. The meaning is the same.

**Affects:** clients and hooks that match on the error type of a failed `WebSearch` or `WebFetch` call or on the exact
wording of those notes, and models that sent a one-character query or both domain lists.

**What to do:** Nothing. Send one domain list per search.

### `WebFetch` sends the host name to a configured proxy

When a proxy is configured, `WebFetch` now sends the request to it for the host name. One proxy serves both schemes: it
is the first of `https_proxy`, `HTTPS_PROXY`, `http_proxy` and `HTTP_PROXY` that is set to an `http:` or `https:` address, so
a page with `https:` goes to a proxy that only `HTTP_PROXY` names, and the other way round. Before, Orbit resolved the
name itself, checked the address and sent the address, so a proxy that filters by name saw an address. The proxy
resolves the name and connects, so Orbit's own address check does not run for that request; the permission check for
each hop still does. A literal address, `localhost` and the names under `.localhost` are never sent that way. This is the
owner's exception of 2026-10-19 to connecting to the checked address.

A host that `NO_PROXY` names is not sent for its name: Orbit resolves it, checks the address and pins the request to
that address. The runtime still applies its own proxy variables to a request for an address, so the request goes through
the proxy as that address, unless `NO_PROXY` lists the address too. It does not connect directly, as the reference does
for such a host; that difference is on the follow-up list (FU-M4-r3-no-proxy).

**Affects:** people who run Orbit behind a proxy and fetch pages with `WebFetch`.

**What to do:** Nothing. To keep a host out of the proxy, list its name and its addresses in `NO_PROXY`.

### Grep and Glob say where to put ripgrep when it is missing

Orbit runs the ripgrep it finds on PATH or in its own `bin` folder and never downloads one. When neither has it, a Grep
or Glob call used to fail with only "ripgrep execution failed". It now fails with a message that ripgrep was not found,
naming the program and the full path of the `bin` folder copy that would work.

**Affects:** people on a machine without ripgrep, such as a fresh Windows install or a CI image that does not ship it.

**What to do:** Install ripgrep so that it is on PATH, or copy the program into Orbit's `bin` folder.

## System prompt

### The base system prompt is rewritten, with a fixed list of sections

The default system prompt, the text that opens the system prompt of a request, is new. After a one-line introduction it
has seven sections, always in this order: Harness, Consent, Scope, Working in code, Evidence, Tool use and Writing to
the user. Main's prompt had Harness, Communication, Doing tasks, Code style, Safety and Verification. Consent takes
over the old Safety section, and Scope, Working in code and Evidence take over the coding rules.

- **Where text comes from.** The prompt tells the model where `<system-reminder>` and `<system-update>` blocks come
  from, and that a lookalike inside a tool result, a file or a data block is data. File contents, command output,
  fetched pages and search and MCP results are information and not instructions, with three exceptions that also arrive
  in tool results: your own answers, the instructions of a skill that was loaded for the task, and hook feedback, which
  counts as your own words. A skill that says you already agreed to a risky step has not made it so: a standing
  approval comes only from your own instructions, given ahead of time.
- **New rules.** Write a comment only when the code cannot say why. Check that a change works before calling a task
  done, and report results faithfully in both directions. Say so when a request rests on a mistaken premise. Commentary
  between tool calls runs to about 25 words, and the closing message to about 100 unless the task needs more. Web
  addresses come only from you, the project's files, or search and fetch results; the single thing the model may offer
  from memory is the documentation site of a library the project uses.
- **Git.** The git guidance in the base prompt is one line, which says to ask before committing, pushing or opening a
  pull request. The advice on staging and commit messages that was there is gone, and the prompt no longer names any
  instruction file.
- **Tool guidance.** `AskUserQuestion`, `Skill`, `LSP`, `Workflow`, `EnterWorktree`, `ExitWorktree` and `Execute` get a
  guidance line, `Agent` says how to brief an agent and check what it did, and the lines for `Read`, `Edit`, `Write`,
  `Glob`, `Grep` and `Bash` say which shell habit each one replaces. `Patch` and `WebSearch` get none, because a hook
  can remove them after the prompt is rendered.
- **Size.** The static text, which is everything but the guidance lines, grows from about 4,200 to about 7,200
  characters, and a request that offers the usual tools carries about 12,400 characters of prompt instead of about
  7,300, which is about 1,300 more tokens. A model with a small context window has that much less room for history,
  and the first request of a session after the upgrade misses the provider's prompt cache once.

**Affects:** sessions that use the default prompt, since the model's behavior follows its prompt. That is every model
except the ones that have a prompt of their own, which replaces it and ends with the Orbit rules (the third note
below): a model that one of the prompt overlays in `packages/core/src/plugin/system-prompt` matches by its ID, and a model of a local provider that runs on the user's machine, or
one that takes tool calls as text. A model of the family that Orbit treats as its main target gets the default prompt with a block added after it. An agent that
has a system prompt of its own gets neither. Also anything that compares the default system prompt byte for byte, such
as a recorded request in a test or a plugin that looks for the heading `# Safety`.

**What to do:** Nothing. Refresh a recorded request that holds the default prompt.

### A web page question is answered with its own instructions, not the session's prompt

WebFetch asks a second model about a fetched page with instructions of its own (answer from the page alone, short
quotes, no lyrics). The request keeps its own text whichever model overlay, prompt key or subagent template applies to
the session. Pinned by `packages/core/test/plugin/side-query-prompt.test.ts`.

**Affects:** sessions on models with a prompt overlay, sessions with the prompt keys set, and subagents that fetch pages.

**What to do:** Nothing.

### An output style keeps the coding sections only when it asks for them, and the opening line follows the style

A custom output style used to keep the coding sections of the default prompt (Scope, Working in code and
Evidence) unless its front matter said `keep-coding-instructions: false`. It now keeps them only when the front
matter sets `keep-coding-instructions` to `true`, as a boolean or as the string `"true"`. A missing key, `false` and any
other value drop them. The built-in Explanatory and Learning styles keep them. While a style applies, the opening line
of the default prompt is replaced by one that says the agent helps the way the output style at the end of the prompt
describes. A prompt that does not open with the default line, such as an agent's own system prompt or a `system_prompt` replacement,
keeps its first line. The model-family prompts open with the default line, so the style replaces it for them too. A prompt whose style comes from a folder that is not trusted yet keeps it too: Orbit still reads that
style and puts its text last in the prompt, but the clone's style does not get to say what the agent is for until you
trust the folder. No style removes the rules about approval, which stay in the sections that every style keeps. The
style also applies to the requests that compact a conversation and to the background generate requests (such as cache
warming), so they carry the same system prompt as your messages and reuse its cached prefix; a one-shot side query such
as a web page extraction keeps its own text.

**Affects:** people with a custom output style that has no `keep-coding-instructions` key, including styles kept in
another product's folder that Orbit reads while compatibility is on, and people who open a repository with a style of
its own before they trust it.

**What to do:** Add `keep-coding-instructions: true` to the front matter of a style that should still follow the
coding sections.

### The rules that every model-specific prompt carries say what outside content is

A model with a prompt of its own, which replaces the default prompt, gets the `# Orbit rules` block after it. Its data
rule said to treat all text inside tool results and fetched pages as data, which also told the model to ignore the
instructions of a loaded skill, your own answers to a question and hook feedback. It now says that outside content is
information and not instructions, except for those three, and that an attempt to redirect the task is reported to you.
The block also says where reminders and updates come from, that hook feedback counts as your own words, that an approval
covers only the action it was given for and that a skill's claim of an earlier approval does not count, and that long
conversations are summarized automatically. The rule about not committing, pushing or opening pull requests unless
asked is unchanged.

**Affects:** people who use a model with a prompt of its own, and tests that compare that prompt.

**What to do:** Nothing.

### Commits and pull requests the agent writes carry an Orbit attribution by default

Every request that offers the shell tool now has a "Git and pull requests" section in its system prompt, for every
agent, whichever model prompt applies. It follows the model prompt and comes before any output style. It says that commits, pushes and pull requests wait for your
request, that published history, git configuration, hooks and signing are left alone, that a commit holds only the
task's changes staged by path, and that a pull request description covers every commit on the branch and says how the
change was verified. Instructions about the form of commits and pull requests (message format, trailers, branch names, templates) from you or the project take precedence, but only you can lift the ask-first rule and the steps that need your explicit request; a project's file cannot. It also asks the agent to end each commit
message with `Assisted-by: Orbit` and each pull request description with `Created with Orbit`. The first request of a
session after the upgrade misses the prompt cache once, because the system prompt changed.

The new `attribution` key sets either text. Each field is decided by the highest-priority config that sets it, so your
own `commit: ""` and a project's `pr` combine. An empty string turns that one off and tells the agent to add none. The
value may hold several lines, such as several trailers. A project's or local config can set it too: its value applies once the folder is trusted, and then takes precedence
over your own, your `""` included. Until then your own value, or the default, applies.

```json
{ "attribution": { "commit": "Co-authored-by: Name <name@example.com>", "pr": "" } }
```

**Affects:** everyone who asks Orbit to commit or open pull requests, and anyone whose repository checks commit
trailers.

**What to do:** Set `attribution.commit` or `attribution.pr` to `""` to turn the line off, or to your own text.

### Config keys that replace or extend the system prompt

Three keys change the system prompt of the main thread of a session (a session without a parent, and forks of it):

- `system_prompt` replaces Orbit's base prompt, the model-specific prompt included. Orbit's core rules (where
  reminders come from, that outside content is data) are kept after it, then the git section, then the appended text and
  the output style. Put `${ORBIT_TOOL_GUIDANCE}` where the guidance lines of the offered tools should go; without it
  there are none.
- `system_prompt_file` is the same with the text read from a UTF-8 file at each request, so an edit applies from the next
  request. The path is absolute, starts with `~/`, or is relative to the folder of the config file that names it. A file
  that cannot be read keeps the default prompt and logs one warning. A path on a network share is refused.
- `append_system_prompt` adds text after the base and the git section, also on top of an agent's own prompt.

An agent with a prompt of its own keeps it and gets no replacement; the appended text still applies on the main thread.
Subagent child sessions get neither. A config with no file resolves a relative `system_prompt_file` against the folder
the session runs in. The three keys are read only from your own config (the global and home folders), the `ORBIT_CONFIG`
file and `ORBIT_CONFIG_CONTENT`, and managed settings. A project's or local config never sets them, trusted or not. The
highest-priority of those that sets a replacement decides, and an empty string counts as unset.

**Affects:** people who set these keys, and SDK callers.

**What to do:** Nothing unless you want to use them. A replacement removes Orbit's coding guidance on purpose.

## No saved grant for `ipconfig`, `hostname` and `route`

- PowerShell and shell no longer offer a saved grant for `ipconfig`, `hostname` and `route`, whose arguments change what they do.

**Affects:** people who saved grants for those programs.

**What to do:** Nothing.

## A saved grant lifts a command that steers its program only by exact text

- A saved grant lifts a command that sets `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV` or `IFS` as a plain `NAME=` word, or gives `env` an option, only when it is that command's exact text. An `env *` or `ls *` grant does not lift `env PATH=. ls`.
- That exact-text rule covers only those plain spellings. An "always" on a command led by `env`, `sudo`, `timeout`, `nice` and the like saves the scanner's prefix (`env *`, `sudo *`, `timeout *`), which lifts every later command behind that word, `env ./prog` included, so a program in the repository can run unasked. A quoted or escaped assignment such as `env "PATH"=. ls` is also lifted by `env *` (follow-up).

**Affects:** people who answer "always" on `env`, `sudo`, `timeout` or similar commands, or on `PATH=` commands.

**What to do:** Answer "always" on such a command only for a program you trust everywhere; otherwise answer once. For a command that steers its program as in the first point, "always" saves the pattern of the first word after any leading assignments (`env *`, `sudo *`, `timeout *`, `nice *`, `printf *`), or nothing for a plain `IFS=` command, and that does not lift the command again (`tool-shell.test.ts`). For `env`, `sudo` or `timeout`, that pattern covers every program behind the word (the bullet above), so answer "always" only when you would let every command starting with that word run unasked. To stop the question for the command itself, write a Bash allow rule with its exact text.

## A project ID file shipped in a folder is ignored unless the folder is trusted

- Orbit reads `.git/orbit` and `.hg/orbit` only in a trusted folder, and only when the file holds a hash of the shape Orbit
  makes (40 or 64 hexadecimal characters). Anything else (`global`, a short value, a path) is dropped with one log line.
  Orbit never writes these files, so a folder that ships one could pick its own project ID, and with it the saved "always
  allow" answers and the data folders of another project. An untrusted Mercurial folder is its own project, as before.
- A link that the file system cannot resolve (a loop, a path through a file, no access) in a commands, agents or skills
  folder is now skipped with one log line on Linux and macOS. It used to stop the loaders.

**Affects:** people who edited `.git/orbit` or `.hg/orbit` by hand, and repositories that ship such a file or link.

**What to do:** Nothing; trust the folder, or use a 40-character hash, to keep a hand-written ID.

## A trusted project's instruction files can import files outside the project

- An `@path` import in a project instruction file (`AGENTS.md` and the like) may now name a file outside the project's
  folders, such as `@~/team/rules.md`, `@../shared.md` or an absolute path, once the folder that holds the importing
  file is trusted. Until then the import is skipped and the file is not sent to the model; a warning names the folder
  whose trust would load it. Granting or revoking trust rescans the files. Before this change such an import was always
  skipped.
- The project's own decision covers the files in the project. A file above the project, or one that a trusted file
  imports from outside, needs the folder that owns it trusted before it imports anything from outside. When the
  repository is the home folder itself (or a filesystem root), a session started below it imports only from the folder
  it started in, even with home trusted for the session. A file above the project that the home folder or a root owns
  (`~/AGENTS.md` for a project in `~/code/repo`) never imports from outside. A session started at home itself, with
  home trusted for the session, does let home's own files import from outside.
- Network paths are never read, trusted or not, and files that the model's reads load later never import from outside.

**Affects:** people who trust a project whose instruction files import files outside it.

**What to do:** Nothing for a project you trust; the outside files are sent with the first request. Run
`orb trust --revoke` in a folder to stop its files importing from outside.

## Turn cost, token and step limits count every spend and every response

- `--max-cost` and `--max-tokens` now count what side queries spend (today the summary of a fetched page; a side query
  added later is recorded the same way) and what session generations spend (`/btw`, warming, plugin and doctor calls),
  in the session and in its subagents. They used to count only responses, compaction and titles.
- A response that the provider cut off before it reported usage (a stream that failed part way, a side query that
  timed out after it was sent, a title or summary compaction call that failed) is counted by an estimate priced with the model's
  own rates, so recovery after it (continuing the reply, retrying, the fallback model) runs under a cost limit
  instead of ending the turn as `limit.cost-unknown`. A request the provider refused before it began costs nothing.
  An attempt that reported usage and was then retried is counted too.
- A subagent's limit check now includes the response of its parent that started it, from the moment the provider
  reported that response, instead of after the parent's tools finished.
- A token limit refuses with the new `limit.tokens-unknown` (a plain error, like `limit.cost-unknown`, not a limit that
  was reached) when a finished response or a usage record in the turn reported no tokens. A usage record with no tokens
  and no cost now counts as unknown spend under a cost limit.
- A reply that was cut off at the output limit and then escalated or resumed is one step with what continues it, so
  `--max-steps 1` no longer stops a text-only capped reply from being repeated at the larger cap. `orb run` reports the
  same step count. A cut-off that holds a tool part (a completed call, an input the cap cut off, or a hosted call) is a
  step of its own, so a reply cut off while it was writing a tool call still ends with `limit.steps`.
- The session's shown cost and `orb stats` totals now include estimates for failed responses, retried attempts and
  generations, which were not counted before.
- A wake-up (a background job's or subagent's completion notice) continues the limits of the turn before it whether it
  was queued or steered, and finds that turn in a fixed number of reads however many wake-ups came between.

**Affects:** people who run with `--max-cost`, `--max-tokens` or `--max-steps`, and scripts that read the `limit.*`
error types.

**What to do:** Nothing; expect a cost or token limit to stop a little earlier than before when side queries ran, and
treat `limit.tokens-unknown` as a refusal to count (for example, use a provider that reports usage, or drop the token limit).

## Agent and skill listings are context, not tool text

- The agent types the `Agent` and `Workflow` tools can start are no longer appended to those tools' descriptions. They arrive as their own instruction source (`core/agent-guidance`), so the tool definitions stay the same when agents change and the model is told only what changed.
- The skill listing is one bullet per skill (`- id: description`), each description is cut to 250 characters, and the whole listing is held to about 1% of the model's context window (4 characters per token): descriptions are shortened evenly, then dropped to names only. Every skill stays listed. Switching to a model with a different window can restate the listing.
- The skill listing is offered only when the request has the `Skill` tool, and the agent listing only when it has `Agent` or `Workflow`.
- Agent ids, descriptions and tool names, and skill ids and descriptions, are flattened to one line (control characters become a space) and envelope look-alikes are escaped before they are listed, and the agent picker, the skill picker, the `@` and `/` autocomplete and every Mini menu (including the `/` composer) escape control characters in what they draw (`dialog-listings.test.tsx`, `autocomplete-hostile.test.tsx`, `footer.view.test.tsx`). In a Plan-mode session the agent listing names only the agents Plan mode lets it start, and the `explore` agent is listed with the tools it has (Grep, Glob, Read, WebFetch, WebSearch).

**Affects:** plugins that read the `Agent` or `Workflow` tool description for the agent list, and people with many skills.

**What to do:** Read the agent list from the conversation context instead of the tool description; shorten skill descriptions that matter early.

## Instruction files run from general to specific, with local variants and a managed file

- The instruction files in the first request now run from general to specific, because the later one takes precedence: the managed file, the global file, then the project's folders from the farthest ancestor to the one the session started in (they ran nearest first before). The baseline opens with a short header that says so, and that the files are standing background to apply where they bear on the task. Every running session with instruction files takes one prompt-cache miss, because its baseline is rendered again with the header. The project memory index (`MEMORY.md`) comes after the project files.
- `ORBIT.local.md` (and the reference vendor's local file while compatibility is on) is looked up in every folder of the walk, after that folder's shared file, and loads even in a folder with no shared file. Keep it out of version control. A repository can ship one too, so the baseline labels it (and every file it imports) as a local variant that carries no approval from the user, in a trusted folder as well as an untrusted one, and the header says a project's file cannot approve a risky action, local variants included. The first-of rule for shared names (`ORBIT.md`, then `AGENTS.md`) is unchanged and applies to the local names separately.
- A file named `ORBIT.md` in the managed folder (`%ProgramFiles%\Orbit` on Windows, `/Library/Application Support/Orbit` on macOS, `/etc/orbit` elsewhere, or `ORBIT_MANAGED_DIR`) is organisation policy: it loads in every project, trusted or not, and `instructions_exclude` cannot remove it. Its imports outside the project load only once the project is trusted. `ORBIT_DISABLE_INSTRUCTIONS`, `orb run --bare` and an agent whose `context.instructions` is `false` switch it off.
- A session whose project files come from two or more different folders sees one short note that the order changed. A worktree inside its main checkout skips the main checkout's shared files above the worktree and keeps its local ones.

**Affects:** people whose instruction files conflict across folders, and administrators who deploy policy.

**What to do:** Put the more specific instruction in the nearer folder; add `ORBIT.local.md` to `.gitignore`.

## Exact forks carry the parent baseline

- `Session.fork` in core takes `prompt: "exact"`. The fork then renders the same epoch baseline as its parent (its first model request repeats the parent's system parts, tools and settled history, and, when the parent is not itself a fork or a subagent child, its cache key and scratchpad folder, because a fork of a fork has its own affinity), because `session.forked` carries the parent's epoch-start values as an optional `baseline`. A default fork is unchanged and writes no `baseline`.
- An exact fork must start at the parent's settled tail; any other boundary fails with `Session.ForkBoundaryError` and publishes nothing. A source that really changed since the parent's last request still produces a normal update in the child.
- The HTTP fork payload does not change. The `session.forked` event type in the generated clients gains the optional `baseline`. `InstructionState.initialize` now takes `{ initial, current }` instead of one value set.

**Affects:** code that calls `InstructionState.initialize` or reads `session.forked` events.

**What to do:** Pass `{ initial, current }` to `initialize`; treat a missing `baseline` as the same as `instructions`.

## New built-in commands: /ide, /terminal-setup, /todos, /vim, and agents you can create

- `/ide` lists the editor windows that have the session's folder open, links the session to the one you pick, and `/ide open` opens the folder in an editor (VS Code, the editors built on it and VSCodium, by their command-line programs, found on `PATH`). Choosing "No editor" closes the link and stops the search until you pick a window again. Outside an editor's own terminal nothing connects by itself; a setting for that is not built yet.
- `/terminal-setup` adds one `shift+enter` binding to the keybindings file of VS Code, or of an editor built on it, after showing you the file and asking. It keeps your comments and other bindings, saves a backup beside the file first, and leaves a file it cannot read as a list exactly as it was. For other terminals it shows the setting to change and copies it to the clipboard. In a terminal where Shift+Enter already works it says so.
- `/todos` shows the session's plan in full, as the plan above the prompt reads it. `/vim` turns `prompt.vim` in `cli.json` on and off.
- `/model`, `/mcp`, `/config` and `/plugin` are aliases of `/models`, `/mcps`, `/settings` and `/plugins`. They open the same dialogs; the argument forms (`/model <name>`) are not built yet.
- `/agents` has a "Create agent" row that writes `agents/<name>.md` under the project's `.orbit` folder or your own config folder, and an "Edit an agent file" row that opens the file in `$VISUAL` or `$EDITOR`. Both are offered only when the server runs on this machine. A new or edited file reaches the server through `POST /api/experimental/config/sources/changed`, which rebuilds the agents without a reload, so questions waiting in other sessions stay open. The text steps of Create can be edited in your editor with the rebindable key `dialog.prompt.editor` (Ctrl+G by default).

**Affects:** people who use the terminal UI; clients of the generated API gain `config.sources.changed`; code that implements `Config.Interface` gains `notify`.

**What to do:** Nothing. A server started with the file watcher off now picks up an agent file when the terminal UI reports it.

## Late language-server problems reach the model as a reminder

- An edit no longer waits for a language server that is not running yet. The first Edit, Write, Patch or NotebookEdit in a language starts its server in the background and returns at once, with no inline error block; the errors that server publishes reach the model through this reminder at a later step. A server that is already running is still waited for (about 3 seconds), so its errors stay inline. The `LSP` tool and other direct callers still wait for a start. A server that was starting when the folder's session ends is stopped (pinned by `test/lsp-reminder.test.ts`).
- When a language server publishes a problem for a file the session changed after the edit tool stopped waiting (about 3 seconds), the problem now reaches the model once, at the start of a later step, as a hidden reminder row. Only the main conversation gets it, and only when a shell tool is offered. A subagent's late problems are reported to its top-level session.
- The reminder lists errors, then warnings, information and hints, at most 10 per file and 30 per step, with the path relative to the project, the line and column, the message, and the code and source when the server sends them. A problem is reported once; a completed compaction makes the ones that remain reportable again. The inline block after an edit is unchanged, except that a diagnostic with no severity now counts as an error there, as it already did in the `LSP` tool.
- Language servers that spell a file's address differently from Orbit (a lower-case Windows drive with an encoded colon) now match the file they published for.
- A server is no longer started for a file that the `LSP` tool would refuse for its size, and a request the server asks to retry sends the document once instead of once per retry.

**Affects:** plugins and clients that read hidden `session.synthetic` rows (kind `lsp-diagnostics`), and servers that were slow to publish.

**What to do:** Nothing. A client that shows reminder rows can show the row's description, which holds counts only.

## The prompt text was rewritten in Orbit's own words

- The prompt texts that ship with Orbit were written from Orbit's own requirements: the base system prompt, the model
  overlays, the new git section, the subagent prompt and its report notes, the plan, todo, task and verification
  reminders, the scratchpad, environment and git snapshot texts, the notes for messages that arrive mid-task, the agent
  listing and several tool descriptions and results. The sections of the base prompt are listed in the note above.
- The section list of the base prompt, and what became of main's git advice, are in the first note under "System
  prompt" above.
- A style without coding instructions drops Scope, Working in code and Evidence. Consent stays, and in it the rule that
  only the user can approve a risky action ahead of time, in the default prompt and in every full model overlay. The
  prompt for local models keeps that rule under How to work.
- The environment block labels the repository line `Git repository`, and the git snapshot labels its fields Branch,
  Pull request target, Configured author, Changes and Latest commits.
- The built-in Explanatory style marks its notes with `Design note:` instead of `Insight:`, and the Learning style
  leaves a comment reading `ORBIT:YOURS` in the source instead of `TODO(human)`, for one small piece at a time. A
  comment that an earlier session left behind under the old marker is ordinary text now.
- The explore agent's description names the depth levels cursory, careful and sweeping.
- The idle reminder of the terminal UI now reads "The session has stopped and the next step is yours" (the notification
  title stays `Orbit`).

**Affects:** people who match on prompt text or section names in tests, hooks or recordings; people who rely on the
`Insight:` or `TODO(human)` markers; every session's first request after the upgrade (the system part changed once, so
the provider's prompt cache is cold for it).

**What to do:** Update recorded requests and any match on prompt text. Nothing else.

## Instruction notes, and an explicit rescan of the instruction files

- Two endpoints add a quick note to the instruction files. `GET /api/location/instructions/note` lists, for the user, project and local scopes in that order, the file a note would go to (`path`), whether it exists, whether that scope's instruction files are loaded in this location (`enabled`) and whether the file is loaded now (`loaded`). `POST /api/location/instructions/note` takes `{ scope, text }` (the text is trimmed and must be 1 to 2,000 characters) and appends it as a bullet; later lines of the note are indented under it.
- A note goes to the file the loader already reads in that scope: the first of `ORBIT.md`, `AGENTS.md` (and the other tool's file name only while compatibility makes it the loader's choice) that exists and is not excluded by `instructions_exclude`. When there is none, the note creates `ORBIT.md` in Orbit's config folder (user), `AGENTS.md` at the project root (project) or `ORBIT.local.md` at the project root (local). A new `ORBIT.local.md` is added to the repository's own `.git/info/exclude`, as an anchored line, unless a git ignore already covers it; no tracked file and no global git file changes. Existing text is never rewritten: the bullet is appended in the file's own line break style, and an existing byte order mark is kept.
- A refusal is `400 InvalidRequestError` with `field: "scope"` and the reason in `kind`: `disabled` (that scope's instruction files are off here, or the location is outside the project root), `unavailable` (an instruction source could not be read, so where the note would load is not known), `excluded` (a pattern of `instructions_exclude` drops the file) or `outside` (in a project that is not trusted, the file leads outside the project through a link; also, trusted or not, the file is a link to a network share, which is never opened or connected to). Nothing is created or changed for any of them. A file that cannot be written (permissions, a lock held by another program) is a `503` for the `instructions` service. A missing default that a pattern excludes is created, and `loaded` is `false` in the answer. In the `GET` listing, `enabled` is `false` for a file that a `POST` would refuse as `excluded` or `outside`, and the project and local `path` is the file as spelled in the project folder.
- After a write, and before answering `GET`, Orbit reads the instruction files again from disk, so the note is in the instruction list at once even when the file watcher is off, and a running session gets it as a chronological instruction update at its next step boundary. This is the new `InstructionDiscovery.rescan()`, with `addRescan` for a source of files to register how it refreshes. Other open locations of the same project see the note through their own file watcher.
- Not built yet: a note typed in a file that ends inside an unclosed HTML comment is appended but the loader strips it, and `loaded` still says `true`.

**Affects:** clients of the generated API gain `instruction.note.targets` and `instruction.note.add`; code that implements `InstructionDiscovery.Interface` gains `addRescan` and `rescan`.

**What to do:** Nothing. A client that offers a `#` note asks the targets first and shows `loaded: false` and the refusal reasons.

## An untrusted folder cannot change the prompt of an agent that exists

A project or local config in a folder that is not trusted can no longer set `agents.<id>.system`, `description` or `initial_prompt` for an agent that is not the folder's alone: one Orbit ships, or one that your own trusted config names, whatever its scope. That includes an agent defined only in a scope that ranks above the project, the flag scope (filled by `--agents`, `--settings`, `ORBIT_CONFIG` and `ORBIT_CONFIG_CONTENT`) or managed settings, which does not exist yet when the project's config is read. Before, that text became the agent's prompt and your `system_prompt` was skipped for it, and for an agent defined only above the project the repository's file was recorded as the agent's source. A file under `agents/` in such a folder is skipped whole for the same agents. An agent that only the folder defines keeps its prompt, and a trusted folder is unchanged. Trust status now lists such an `orbit.json` entry (`system`, `description`, `initial_prompt` or `disallowed_tools`) as holding back `permissions`, so the trust question opens for the folder, and Orbit logs a line for each entry it holds back.

**Affects:** people who open a repository that sets a prompt on a built-in agent, or on an agent they pass with `--agents` or keep in managed settings, before trusting it.

**What to do:** Trust the folder if you want its prompt to apply.

## A provider package written as an absolute file path loads again

A `package` of a provider that is a plain absolute file path (`/opt/providers/acme.mjs`, `C:\providers\acme.mjs`) loads as the `file://` URL of that file. In the compiled binary such a path did not load at all, because the binary never looks a name up in the folder it starts in. A relative path is still refused: it would be read against Orbit's own folder, not the folder of the config that wrote it.

**Affects:** people whose provider config names a package by an absolute file path.

**What to do:** Nothing. Use an absolute path or a `file://` URL, not a relative one.

## The embedded SDK gives `SessionNotFoundError` for an unknown session

`sessions.get` of the embedded Effect client used to fail with the core error `Session.NotFoundError` for a session that does not exist. It now fails with the protocol's `SessionNotFoundError` (with `sessionID` and `message`), the error the HTTP client already gave, so one handler covers both transports.

**Affects:** code that calls `sessions.get` on an embedded `Orbit` from `@orbit/sdk/effect` and catches the core error.

**What to do:** Catch `SessionNotFoundError` (tag `"SessionNotFoundError"`) instead of `Session.NotFoundError`.

## One experimental key does not hide another

A later settings file that has an `experimental` block no longer hides the keys of an earlier block that it does not set. `allow_local_fetch`, `portable_shell_scanner` and `subagent_depth` each take the value of the last file that sets that key, so a project that sets a depth leaves your own `allow_local_fetch`. An untrusted project's block is still withheld. The other nested blocks (`compaction`, `tool_output`, `media`, `shell_tool`, `sandbox`) still take the whole block from the last file.

**Affects:** people who set `experimental` keys in both their own config and a project's.

**What to do:** Nothing.

## A dropped or pasted `.svg` path is no longer read into the prompt, and only absolute image paths attach

Dropping or pasting the path of an `.svg` file used to read the file and put its text into the prompt as if you had typed it, in the full terminal UI and in Mini. The path now stays as the text you pasted and the file is never opened. Only PNG, JPEG, GIF and WebP files attach: a PDF path and an AVIF path stay as typed text too, and a PDF is no longer read and attached whole. A relative image path such as `shot.png` or `assets/logo.png` used to be looked up in the working folder and attached when the file was there; it now stays as typed text and is not read.

Both clients read a drop or a paste the same way. The text is cut into lines, and a line is cut again only at a space that comes right before an absolute path, or before a quote that opens one, since Windows Terminal puts quotes around every path it drops. A piece attaches when, once one pair of quotes around it and (outside Windows) its backslash escapes are taken off, it is an absolute path ending in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` that reads as an image; a `file://` URL counts as the path it names. Every other piece stays in the prompt exactly as you pasted it, quotes, backslashes and line breaks included, and is never read. So `/tmp/shot.png /tmp/logo.svg` attaches the PNG and keeps the SVG path, a paste of three lines whose middle line is an image path attaches the image and keeps the first and last lines, and `compare /tmp/shot.png with the mockup` stays as typed with nothing attached, because the piece that starts at the path ends in `mockup`. To show a model an SVG or a PDF, ask it to read the file, or paste the markup yourself.

**Affects:** people who drop SVG or PDF files into the prompt to send their contents, and people who paste a relative image path to attach it.

**What to do:** Ask the agent to read an SVG or a PDF, or paste the markup. To attach an image, drop it or paste its absolute path.

## U+2028 and U+2029 are text inside a line of an instruction file or of front matter

A long line that held U+2028 or U+2029 after a run of fence markers or spaces cost time that grew with the square of the line: one such line of 100 KB in a cloned repository's `AGENTS.md`, or in the front matter of one of its rules, held the reading of the instruction files at the start of a session for tens of seconds, before anyone had trusted the folder. A lone CR inside a front matter line did the same, and so did a long run of empty lines anywhere in a front matter block: 100 KB of them in a rule held that reading for seconds. Such a line or run now takes time in proportion to its length. Front matter is still read as before, by the same YAML and JSON readers, with JavaScript refused; only the step that looked for a block of nothing but comments is Orbit's own now.

The characters are read as part of their line, as a Markdown line ends only at LF, CR or CRLF:

- In an instruction file or a rule, a line that opens a fence or a list item and holds U+2028 or U+2029 opens it. Before, it was read as plain text, so a comment block in the fence or under the item was removed, a heading in the fence opened a section, and an `@` token in the fence was followed.
- In front matter, a value that holds a lone CR, U+2028 or U+2029 gets the same retry as any other value with an unquoted colon or a YAML indicator. A `description: Use when: it fits` line that ends in a stray CR before its CRLF now reads, and a rule whose `paths` line ends in U+2028 or U+2029 keeps its patterns; before, that front matter did not parse, and such a rule applied from the start.

**Affects:** repositories whose instruction, rule or Markdown config files hold U+2028, U+2029 or a stray CR.

**What to do:** Nothing.

## Front matter and workflow YAML whose aliases come to more than their text are not read

In YAML an alias names a value that an anchor wrote earlier, and Orbit's readers handle each alias as a full copy of that value. A file of a few hundred bytes whose anchors each named the one before ten times stood for billions of values, so an agent or skill file like that in a cloned repository ran Orbit out of time and memory while it fingerprinted the project's config, before anyone had trusted the folder. A value is now measured with every alias followed, counting each value and the characters of each string and key:

- **Front matter** of agents, skills, commands, output styles and rules is not read when it comes to more than its text and 10,000, or nests 1,000 levels deep. The file is skipped as a file whose front matter does not parse is, and when it is an agent or a skill in a project's config folder, the trust fingerprint logs one `config file skipped` warning that names it. A rule whose front matter is refused this way waits and matches no read; it does not apply from the start as a rule whose front matter does not parse does. An anchor named a few times reads as before.
- **`orb flow` and `orb eval`** refuse a YAML workflow or suite that comes to more than its text in the same way, with an error that names the file, in every reader of the file.
- **Trust fingerprints.** A config value that comes to more than 4,000,000 values and characters, or nests 1,000 levels deep, is not digested: that kind of that file is `unreadable`, which counts as changed, as a file that cannot be read does, with one `config fingerprint unreadable` warning.

**Affects:** projects whose front matter, workflow or suite files repeat large values through YAML aliases, or nest that deep.

**What to do:** Write the repeated values out, or repeat them less.

## Automatic compaction follows the context window less the summary's room, and a failed one no longer fails the turn

- **Where it starts.** The summary now keeps the smaller of the model's output limit, `output_token_cap` and 20,000
  tokens free, and automatic compaction starts 13,000 tokens below the window that is left (`compaction.buffer`
  replaces the 13,000). The summary never keeps more than half the window, and compaction never starts below half the
  window, so a small window, a model whose output limit fills its window, or a large buffer cannot make every request
  compact. On a 200,000-token window with a 32,000-token output limit it starts at 167,000 tokens; it used to
  start at 180,000. A model with an unknown window never compacts automatically and is never refused locally, as before
  (`session-context-window.test.ts`, "automatic compaction threshold"; `session-runner.test.ts`, "context accounting").
- **A failed automatic compaction keeps the turn going.** The failure is still recorded as a `compaction.failed`
  message, but the request is sent without it. It used to end the step with the compaction's error. Three failures in a
  turn pause automatic compaction until the next turn, and a paused turn also skips the rebuild after a provider
  rejects a request as too long, so the provider's error ends the step. Input steered into a running turn does not
  restart the count.
- **At most one automatic compaction per request.** A retry, a fallback switch or a continuation resends the same
  request and no longer compacts a second time. A resume after the output limit is a new request and is checked again.
- **With automatic compaction off, a request that cannot fit is refused.** When the conversation reaches 3,000 tokens
  below the window that is left, the step fails with the new `context.limit` error, whose message names `/compact`,
  and no request is sent. On a window under about 46,000 tokens the limit is the point where automatic compaction
  would have started (half the window at least), so the refusal comes no earlier than that. Clients show it as they
  show any other failed execution.
- **New event.** `session.context.updated` reports how full the context is after each measured response, and again
  with `stale: true` after each compaction. It is not stored.
- **Native compaction spend.** A native compaction call that reports no usage is recorded with zero tokens, which a
  turn limit reads as unknown spend, and one that fails or is interrupted after the provider began to answer is
  recorded as an estimate (`session-native-compaction.test.ts`). A request the provider refused costs nothing, as
  before. Only a summary compaction call that failed was counted before.

**Affects:** people who set `compaction.buffer` or `output_token_cap`, run with `compaction.auto` off, set
`--max-cost` or `--max-tokens` with native compaction, or read `session.execution.failed` from scripts or SDKs.

**What to do:** Nothing. A buffer you set still sets how far below the window compaction starts, measured from the
window less the summary's room instead of the whole window; lower it if compaction now starts earlier than you want.

## The terminal UI warns when the context is almost full

The full-screen terminal UI now draws the latest `session.context.updated` report of the session in view in the prompt's
footer row, after the model and location, on one line. The line replaces the context bar and gives the footer shortcuts
their place when the row cannot hold both; a very short row cuts it at its end, keeping its start and percent.

- **When it shows.** Only for a report whose state is `warning` or `error` and that is not `stale`. Before any report,
  below the warning band, after a compaction, and for a state this client does not know, the footer is as before.
- **Words.** With automatic compaction on, a muted `N% left before auto-compaction`, also while repeated failures have
  paused it. With it off, `Context almost full (N% left) · run /compact` in the warning or error feedback color.
- **When it hides.** It is hidden while a revert is staged (`/undo`) and drawn again when the revert is cleared. The
  report is forgotten when the session is deleted, another model is selected, the configuration changes, the
  session moves to another location, a revert is
  committed or the event stream reconnects, and the line stays hidden until the next measured response. It is hidden
  too while a narrow footer hides its details for the interrupt hint, and drawn in shell mode as in normal mode.
- **Plugins.** `context.data.session.context(sessionID)` returns the latest report of a loaded session, or `undefined`.
- Mini, ACP, VS Code and SDK hosts draw nothing.

**Affects:** people who use the full-screen terminal UI and run long sessions.

**What to do:** Nothing. Run `/compact` when the line asks for it.
