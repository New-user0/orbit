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
  agent, whose entry goes with it. A key that is set but empty, such as `sandbox: {}` or `formatter: true`, is left out
  too: a project's value outranks yours, so it would otherwise replace the one in your own config.
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

Orbit starts no language server and runs no formatter in a folder that is not trusted, the built-in ones and the ones
in your own config alike, because they read the folder's own code and config and several of them run it. Both start
working as soon as the folder is trusted.

The files in a project's `.orbit` directory are held to the same decision, because some of them run code:

- **Plugins:** the plugins in `.orbit/plugins` (or `.orbit/plugin`) are not loaded, and they are not reported as failed.
  They start when the folder is trusted, without a restart, and stop again when the trust is taken away.
- **Commands:** a command from `.orbit/commands`, or from a `commands` setting of the project, is still listed, and one
  whose template has no shell snippet works as before. One that runs a shell snippet (an exclamation mark and a command
  in backticks) fails with a message that names the command and says its folder is not trusted. Nothing is asked about
  or started first.
- **Agents:** an agent defined in `.orbit/agents` or `.orbit/modes` keeps its prompt, model and description, and loses
  what the same entry in `orbit.json` would lose: its `request`, its `allow` and `ask` rules, and `disabled`, so a file
  cannot remove one of the agents that are already there.

Skills and output styles in a project are text, so they stay available. The list of what a folder holds back also names
each `.orbit` directory with the plugins, commands with shell snippets, and agents with requests or approvals it holds.

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
terminal UI, VS Code and the desktop app): those settings now stay off. So do the plugins in `.orbit/plugins`, the shell
snippets in the commands of `.orbit/commands`, the `request` overrides and `allow` rules of agents in `.orbit/agents`,
and language servers and formatters, in every folder that is not trusted, which until the trust prompt arrives is every
folder. The same goes for SDK hosts and servers that leave `trust.implicit` unset, and for tests that write project config
and start a server. Code built on `@orbit/core`: `Config.Document` and `Config.Directory` gain `trusted`,
`Config.Document` gains `withheld`, the roots that `Config.compat` lists can carry `trusted`, `Config` now needs
`WorkspaceTrust`, `Lsp` and `Formatter` now need `ProjectTrust`, `ProjectTrust` now needs `FSUtil`, `ProjectTrust.status`
also lists `.orbit` directories, `ProjectTrust.allows` says whether a file may run the code it carries (ask it before
running anything a file carries, such as the hooks in a skill's or an agent's front matter), and a global `trust.updated`
event reports each change.

**What to do:** nothing for config you keep in your own files. For a repository you trust, run with `--standalone` and
`ORBIT_TRUST_PROJECT=1`, or pass `trust: { implicit: true }` to the host you embed, which also suits CI and tests.
`orb trust`, the trust prompt in the terminal UI and the headless refusals that go with them arrive in following
changes, and until they do the background service has no way to trust a folder.

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

## Permissions

Changes to what Orbit asks about before it acts, and to how rules and saved approvals apply.

### Code Mode `fetch` asks for webfetch permission

The `fetch` that Code Mode scripts call used to run without any permission check. It now asks for `webfetch` permission,
per URL, the same way the `webfetch` tool does, and a policy or rule that denies `webfetch` blocks it too. A request with
a method other than GET or HEAD also asks about `METHOD url`, for example `POST https://example.com/x`. A rule or
approval written for a URL, an origin or a host never allows such a write; a deny written for them still blocks it. Only
`http:` and `https:` URLs work, so `file:` and `data:` URLs now fail before anything is sent, and the URL must be a
string or a `URL` and the method a string. Redirects are not checked again: a request to an approved origin that
redirects elsewhere still goes through.

**Affects:** agents that run Code Mode scripts calling `fetch` while `webfetch` is set to ask or deny. With the default
allow-all rules nothing changes, apart from the new limits on what `fetch` accepts.

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
