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

- **Left out whole:** `model`, an agent's `model` and `steps`, a command's `model`, `hooks`, `mcp`, `plugins`, `shell`,
  `providers`, `sandbox`, `formatter`, `lsp`, `skills`, `references`, `worktree`, `experimental`, `share`,
  `enterprise`, `update`, `fallback_model`, `output_token_cap` and `default_agent`, and `disabled` on an agent, whose
  entry goes with it. So are `mode` and `hidden` on an agent and `agent` on a command, because an agent's own rules
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
  10 or less, so a repository cannot raise the limit above 10.
- **Kept as written:** everything else, such as `output_style`, `username`, `snapshots`, `watcher`, `media`,
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

### A folder's model, provider and budget settings wait for it to be trusted

An untrusted folder can no longer pick a model, a provider or a budget, because every one of them is paid for by you.
While a folder is untrusted, `ConfigTrust` takes these out of its config documents and out of its agent and command
files, keeps the rest of each entry, and reports the `providers` kind as withheld: the top-level `model`, the `model`
and `steps` of every agent (so also `agents.title.model`, which `small_model` migrates to, and `agents.side.model`,
which pins the model of side queries), and the `model` of every command. Orbit uses your own settings instead.
Trusting the folder restores them. The config has no other field that picks a model, a provider or a budget today.

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

**Affects:** a repository that sets `model`, an agent's `model` or `steps`, or a command's `model` in its own
`orbit.json` or in a file of its `.orbit` directory, until its folder is trusted.

**What to do:** Nothing for your own config. To use a repository's model settings, run `orb trust` in it, or set them in
your user config.

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

### `orb -p` sends a message and prints the answer

`orb -p <message>` (or `--print`) runs one message the way `orb run` does and exits. The words after the flags are the
message, so `orb -p run the tests` sends "run the tests" and never starts `orb run`; the flag may come anywhere before
a literal `--`, except that when the first word is a subcommand `-p` must come before it: `orb debug this -p` goes to
the `debug` subcommand and `orb run -p` is still a `run` command line (a usage error). A word right after a flag that takes a value is that
flag's value, as in `orb -p --agent plan fix it`. Boolean flags never take the next word into the message, so `orb -p yes do it` sends
"yes do it" and `orb -p --thinking false positives` sends "false positives" with thinking on; write `--no-thinking` or
`--thinking=false` to turn a flag off. Only to find the subcommand does `orb` treat a yes/no/true/false word after a
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
prompt with its mode and mentions. With `prompt.vim` on, `ctrl+r` in normal mode is still redo. The command is
`prompt.history.search`.

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
arguments once the response finishes with `tool-calls` or `stop`, and is dropped after any other finish. The cost is that
a call with no arguments starts when the response finishes, not mid-stream. Provider-executed calls are not held.

A cut-off call no longer counts as the evidence that its response finished. Two kinds of stream used to report
`tool-calls` because such a call was in them, which released the call: a Responses-style stream that the provider ended as
incomplete, with no reason or a reason Orbit does not know, and a Chat-style stream that ended without a finish reason
from a model whose `compatibility.requireFinishReason` is `false`. Both now report an unknown finish, so the call is
dropped, and the session handles the response as it handles any unknown finish: as an incomplete stream, which it
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
arrives, so the overshoot is at most one response. A background subagent that is still running when a limit ends the turn
keeps running, because the turn is over and no longer limits it. Its completion notice then wakes
the Session into a new turn, which carries no limit. A response is priced after it arrives, so a turn can also overshoot
a cost or token limit by one response.

The window starts at the prompt that set the options. A queued prompt without options, or a prompt sent after the busy
period ended, runs without limits, and a steered prompt with its own options starts a new window. A prompt sent while a
limited turn is finishing joins that turn, and fails at once if the limit is already spent. Only responses that ended
count as steps: a retry before output, and a response that failed mid-stream, do not. Cost and tokens add the Session's
responses and its compaction and title usage, and the responses and usage of every subagent it started in the window.

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
an incomplete stream's continuation does; the allowance is bounded. A text-only cut-off is not resumed when a steered
message from you is already waiting: that message is delivered at once and starts a new count. A steer that arrives
during a resume waits for at most the three resumes.

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
output limit keeps the limit it chose, and a request already at the model's maximum is not repeated.

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
not know, the run asks the server to interrupt its session and fails with a version error. That interruption does
nothing for a session that is idle or not yet running, so on such a server the prompt can still run without its limits.

Any message that the runner marks with `metadata.notice` and a description, such as the switch to the fallback model,
now prints a warning line, or a `{"type":"notice","notice":...,"message":...}` line with `--format json` and
`stream-json`. Over ACP, a turn that reached a limit stops with `max_turn_requests` instead of failing, and every
notice is sent as a `session_info_update` with `orbit/notice` in `_meta`.

**Affects:** scripts that call `orb run` and read its result object or exit code, and ACP clients.

**What to do:** nothing; the new fields are additive. A script that passes a limit should check `subtype`.
