# Orbit

Orbit (`orb`) is a terminal coding agent that works with any LLM provider: local models (Ollama, LM Studio,
llama.cpp, vLLM), any OpenAI-compatible API, Anthropic, and internal gateways such as Tachyon.

It makes no network calls other than to the model providers you configure: no telemetry, no update checks,
no hosted catalog fetches.

## Setup

Providers are configured in `orbit.json` in the global config directory (`orb debug paths` prints it) or in a
project. Values accept `{env:VAR}` and `{file:path}`.

- **Config precedence:** later sources win: remote config; your own config (the global config directory, then
  `~/orbit.json` and `~/.orbit`); project `orbit.json` files and `.orbit/` directories (outermost first); project
  `orbit.local.json` files (personal overrides, such as `.orbit/orbit.local.json`; keep them out of version control);
  then `ORBIT_CONFIG` and `ORBIT_CONFIG_CONTENT`. An `orbit.local.json` in the global config directory, `~` or
  `~/.orbit` is part of your own config: it overrides the shared files beside it but ranks below every project file.
  `ORBIT_CONFIG` used to rank below project files and now outranks them, so a host that sets a key in both places must
  drop it from `ORBIT_CONFIG` for the project file to apply.
- **Other tools' files:** by default Orbit also reads the skills, output styles, hook settings, MCP servers
  (`.mcp.json`) and instruction files that other agent products keep, such as `.agents/skills`. One switch turns all of
  it off:
  `"compatibility": { "enabled": false }` in your own config or in `ORBIT_CONFIG` or `ORBIT_CONFIG_CONTENT`, or
  `ORBIT_DISABLE_COMPAT=1` (or `true`) in the environment the Orbit server starts in. A project's own `orbit.json` and
  `orbit.local.json` cannot change it, so a repository cannot switch it back on after you turned it off. With it off,
  skills that live only in `.agents/skills` or another product's directory no longer load: move them to
  `.orbit/skills` first. The same switch decides whether the TUI reads Zed's own editor database for the selection in
  a Zed terminal.
- **Project trust:** until its folder is trusted, a project's config applies only what cannot run code, spend money or
  reach the network. Its hooks, MCP servers (including `.mcp.json`), plugin list, providers, shell, sandbox, formatter
  and language server settings, default agent and keep-alive requests are left out, only its `deny` permission rules
  are kept, and it cannot choose a web search provider. The server loads none of the plugins in its `.orbit/plugins`,
  and the terminal UI imports none of the ones it finds there itself. Its commands run no shell snippets and run as the
  current agent, and its agent files lose their `request`, their `mode` and `hidden`, and their `allow` and `ask` rules.
  Its `{env:VAR}` references are not expanded, and a `{file:path}` reference or instruction path counts only inside the
  project's folder. A link in the project that leads out of it supplies no instruction file, agent, command, skill or
  output style, and the file tools ask before they follow one. Orbit starts no language server and runs no formatter in
  such a folder, built-in or configured, because they read its code and some run it. Config in the folders above a
  project follows the decision for the folder that holds it. Your own config, `ORBIT_CONFIG` and `ORBIT_CONFIG_CONTENT`
  are never held back. A private or foreground server trusts every folder
  except the home directory and filesystem roots when it starts with `ORBIT_TRUST_PROJECT=1`, and an SDK host does with
  `trust: { implicit: true }`; the shared background service never does, and a host that leaves the option unset trusts
  nothing. `orb trust` trusts a folder for good (`--list` shows the folders, `--revoke` ends it), and `--trust` on
  `orb run`, `orb loop`, `orb flow run`, `orb flow resume` and `orb eval` trusts it for one run on a private server.
  Those commands exit with status 1, doing nothing, in a folder that is not trusted and holds something back. The
  terminal UI asks about such a folder, and `/trust` asks again. `orb flow run`, `orb flow resume` and `orb eval` also
  stop in a folder that is not trusted, whatever it holds back, for a workflow or suite that is a TypeScript or
  JavaScript module, that defines shell commands, that names an agent, or, for a workflow, that sets
  `permissions: auto`, and they stop when the server is too old to say whether the folder is trusted. The folder that
  holds such a file is held to the same when it belongs to another project than the one they run in. See
  [docs/upgrading.md](docs/upgrading.md).
- **Tachyon:** set the same `TACHYON_*` variables the Python SDK uses; see [docs/tachyon.md](docs/tachyon.md).
- **Corporate TLS:** `ORBIT_CA_CERTS` (PEM files, separated like `PATH`) are trusted in addition to the bundled and
  OS roots. `ORBIT_CLIENT_CERT`, `ORBIT_CLIENT_KEY` and `ORBIT_CLIENT_KEY_PASSPHRASE` add a client certificate.
  Proxies come from `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.
- **Local models:** Ollama on `127.0.0.1:11434` is found automatically. Set `OLLAMA_CONTEXT_LENGTH` (for example
  32768) for Ollama; Orbit's prompt and tools alone need about 5k tokens. Models without native tool calling get their
  tools through the prompt; any model can opt in with `"compatibility": { "toolCalling": "text" }`.
- **Check:** `orb doctor` reports TLS, proxy, ripgrep and provider settings by name; `orb doctor --probe` sends one
  short request to one model per available provider, and `--model provider/model` probes one model.

## Workflows

New here? [docs/try-it-windows.md](docs/try-it-windows.md) walks through building Orbit and trying every feature.

In a chat, the agent can split a task across subagents with its `workflow` tool, for example a writer, a reviewer
and a fixer, keeping its own context for the plan and the final review. `orb flow run <file>` runs several agents as one recorded run: parallel agents in their own git worktrees, merged
back with conflict detection, with retries, fallback models and `orb flow resume`. See [docs/flow.md](docs/flow.md).

## Repository layout

| Path | Contents |
|---|---|
| `packages/cli` | The `orb` command, terminal UI entry point and background service |
| `packages/core` | Agent loop, tools, permissions, providers, plugins |
| `packages/compat` | The one place that names other agent products' files, with the compatibility switch, root discovery, the readers for their hook settings and MCP file, and their tool names |
| `packages/server` | Local HTTP API used by the TUI and editor integrations |
| `packages/tui` | Terminal UI |
| `packages/ai` | LLM protocol and provider layer |
| `packages/client`, `packages/sdk` | Client and SDK for the local API |
| `packages/flow` | Orbit Flow: multi-agent workflows, run store, worktrees, resume |
| `packages/vscode` | VS Code extension: sidebar chat, diffs and approvals, on the same local service |
| `docs/` | Design (`DESIGN.md`), fork map, Tachyon wire protocol, upgrade notes (`docs/upgrading.md`) |
| `tools/` | Tachyon discovery probe, brand gate |

## Development

Requires Bun 1.4.2 or newer.

```sh
bun install --frozen-lockfile
bun run dev              # start the TUI from source
bun run check            # lint + typecheck
```

Tests run per package, never from the root: `cd packages/core && bun run test`.

`bun run test` runs the big packages (core, cli, tui, server, vscode) in parallel, in worker processes: half the logical cores, at
least two. `ORBIT_TEST_WORKERS=<n>` sets the count, and `ORBIT_TEST_WORKERS=1` gives a serial run for debugging. The other packages
run serially because their files are small, and a worker costs about a second per file on Windows; setting `ORBIT_TEST_WORKERS`
runs them in parallel too. Each package keeps a `test/timings.json` that starts the slowest files first, and
`bun run test:timings` refreshes it (ordinary runs never write it). Each core worker gets its own home, XDG and temp folders. The
ACP approval matrix in cli (`permission-files.subprocess.test.ts`) runs its rows 8 at a time inside its one file; pass
`--max-concurrency=1` to run them one by one.

## Brand gate

`bun tools/rebrand/rebrand.ts --check` fails if the upstream product name appears anywhere in the tree.
After merging upstream changes, run `bun tools/rebrand/rebrand.ts --apply`, then the check.

## Vendor branding gate

`bun tools/rebrand/vendor.ts --check` fails if another agent product's name, directory, instruction file, variable or web
app appears outside `packages/compat`, or if a model vendor's name appears outside provider adapter code, tests and the
few other places the allowlist in `tools/rebrand/vendor.ts` names. Every allowlist entry carries a reason. Without `.git`,
both checks read the tree instead and skip what its `.gitignore` files exclude.
