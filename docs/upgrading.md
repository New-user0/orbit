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
  In a project the shared file ranks as project config and the local file as local config. Each ranks below Orbit's
  own documents of the same kind, so an `orbit.json` or `orbit.local.json` outranks them. When several hooks block a
  tool call, the model is told the reason from the highest-ranked document, so Orbit's own files come before another
  product's. A hook that cannot be read is reported in the log, with its file and its place in it, and costs only
  itself, and a file that is not JSON costs only that file.
- **Hook matchers and names.** A hook matcher in any document also accepts the names other products give a tool:
  `Bash` for `shell`; `Edit` and `MultiEdit` for `edit`, and `Write` for `write`, and all three also for `patch`,
  which takes the place of `edit` and `write` on some models; `NotebookEdit`, `Glob`, `Grep`, `WebFetch` and
  `WebSearch` for the tool of the same name; `Task` and `Agent` for `subagent`; `TodoWrite` for `todo`; and
  `mcp__<server>__<tool>` for an MCP tool. A hook from another product's settings file is told that name as
  `tool_name`, and every hook gets that product's project-directory variable beside `ORBIT_PROJECT_DIR`. Hooks in
  Orbit's own files still get Orbit's names for the tool.
- **`.mcp.json`.** Its `mcpServers` become project config: servers that run a command become local servers, and those
  with `"type": "http"` or `"type": "sse"` become remote servers. `${NAME}` and `${NAME:-fallback}` expand from the
  environment of the Orbit server in commands, arguments, variables, directories, URLs and headers. A server with no
  command or URL, of another type, or that names a variable that is unset and has no fallback is skipped, with a
  warning, and the others still load. A server of the same name in `orbit.json` wins.
- **When edits apply.** Orbit now picks up a change to a settings file or to `.mcp.json` when the config reloads, a
  moment after the file is saved, and no longer reads the settings files again on every hook event.

**Affects:** people with hooks in another product's settings files, who may see a different block reason or tool name
than before; repositories that keep a `.mcp.json`, whose servers now start when the project is opened, as those in a
project's `orbit.json` already do; and code built on `@orbit/core`, where `HookConfig` moved from
`@orbit/core/hook/config` to `@orbit/schema/config/hook-config` and `McpTool.namespace` and `McpTool.name` are now
defined in `@orbit/schema/mcp` and re-exported.

**What to do:** Nothing for hooks that keep working. If a repository's `.mcp.json` should not start servers for you,
turn compatibility off, or move the servers you want into `orbit.json`.

## Clients

Changes to the terminal UI, the `orb` command line, the client libraries and SDK, and the VS Code extension.

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
