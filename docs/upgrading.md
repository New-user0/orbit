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
other products' rule files. The system prompt now names only `ORBIT.md` and `AGENTS.md` as instruction files.

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

### A project's config waits for its folder to be trusted

The settings in a project's `orbit.json` and `orbit.local.json`, and in the hook settings and `.mcp.json` that other
agent products keep there, used to apply the moment Orbit opened the folder. They now apply in full only once the
folder is trusted. Until then Orbit keeps what cannot run code, spend money or reach the network, and leaves out the
rest:

- **Left out whole:** `hooks`, `mcp`, `plugins`, `shell`, `providers`, `sandbox`, `formatter`, `lsp`, `skills`,
  `references`, `worktree`, `experimental`, `share`, `enterprise`, `update` and `default_agent`, and `disabled` on an
  agent, whose entry goes with it. So are `mode` and `hidden` on an agent and `agent` on a command, because an agent's
  own rules come after yours and win: which agent a session starts as, which agent runs a command, and which agents the
  model may spawn as subagents choose between sets of rules, as `default_agent` does. A command from the project runs as
  the session's current agent, and an agent keeps the mode and visibility it has, or the ones a new agent gets. A key
  that is set but empty, such as `sandbox: {}` or `formatter: true`, is left out too: a project's value outranks yours,
  so it would otherwise replace the one in your own config.
- **Cut down:** `permissions`, and the `permissions` of each agent, keep only their `deny` rules, so a repository can
  add a block but never an approval. An agent's `request` is dropped, and so is every URL in `instructions` and every
  instruction path that leaves the project's folder. `websearch` and `warming` keep only `false`: a repository can
  switch web search or keep-alive requests off, but cannot pick a provider, so it cannot send your queries to the
  keyless search pool, and it cannot start generations that you pay for.
- **Kept as written:** everything else, such as `model`, `output_style`, `username`, `snapshots`, `watcher`, `media`,
  `tool_output`, `compaction`, and the fields of an agent that only describe it.

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
project follows links as before.

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
- **Agents:** an agent defined in `.orbit/agents` or `.orbit/modes` keeps its prompt, model and description, and loses
  what the same entry in `orbit.json` would lose: its `request`, its `allow` and `ask` rules, `disabled`, `mode` and
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

## Clients

Changes to the terminal UI, the `orb` command line, the client libraries and SDK, and the VS Code extension.

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
a workflow or suite's code, commands, approvals or agents" under Clients).
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
  folder, and closing the dialog with Esc counts as "Not now". Either one keeps it from opening by itself again for that
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
opens no session, so a YAML workflow is not stopped for the commands, approvals or agents it defines, and replaying one
still connects to no server.

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
or not the folder is trusted. A replay of a module workflow now connects to a server, and starts the background service
if that is the server it uses and it is not running. Commands run with `--standalone` and `ORBIT_TRUST_PROJECT=1`, or
against a server that trusts the folder, are not affected.

**What to do:** run `orb trust` once in each repository you trust, or pass `--trust` to a single run, or set
`ORBIT_TRUST_PROJECT=1` and `--standalone` in CI. Restart the background service after upgrading (`orb service
restart`). Look over a workflow or suite that you did not write, and the commands, nodes and agents that the refusal
lists, before you trust the folder that holds it, because trusting the folder lets it run.

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
error that names the address. A name whose address changes between the check and the connection is not caught.

**Affects:** Code Mode scripts that call `fetch`. One that follows a redirect while `webfetch` is set to ask or deny gets
another prompt. One that calls a server on `localhost`, on a private network or at a link-local address now fails, even
with allow-all rules.

**What to do:** approve the extra prompts, or add `webfetch` allow rules for the origins the redirects lead to. To let
scripts reach local dev servers, set `experimental.allow_local_fetch` to `true` in your own config. It lets `fetch` reach
loopback and private-network addresses and no others, and like the rest of `experimental` it is ignored in the config of
a folder that is not trusted.
