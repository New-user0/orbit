# Orbit

Orbit (`orb`) is a terminal coding agent that works with any LLM provider: local models (Ollama, LM Studio,
llama.cpp, vLLM), any OpenAI-compatible API, Anthropic, and internal gateways such as Tachyon.

It makes no network calls other than to the model providers you configure: no telemetry, no update checks,
no hosted catalog fetches.

## Setup

Providers are configured in `orbit.json` in the global config directory (`orb debug paths` prints it) or in a
project. Values accept `{env:VAR}` and `{file:path}`.

- **Config precedence:** later sources win: remote config, the global config directory, `~/orbit.json` and
  `~/.orbit`, project `orbit.json` files and `.orbit/` directories (outermost first), `orbit.local.json` files (personal
  overrides, such as `.orbit/orbit.local.json`; keep them out of version control), then `ORBIT_CONFIG` and
  `ORBIT_CONFIG_CONTENT`. `ORBIT_CONFIG` used to rank below project files and now outranks them, so a host that sets a
  key in both places must drop it from `ORBIT_CONFIG` for the project file to apply.
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
| `packages/server` | Local HTTP API used by the TUI and editor integrations |
| `packages/tui` | Terminal UI |
| `packages/ai` | LLM protocol and provider layer |
| `packages/client`, `packages/sdk` | Client and SDK for the local API |
| `packages/flow` | Orbit Flow: multi-agent workflows, run store, worktrees, resume |
| `packages/vscode` | VS Code extension: sidebar chat, diffs and approvals, on the same local service |
| `docs/` | Design (`DESIGN.md`), fork map, Tachyon wire protocol |
| `tools/` | Tachyon discovery probe, brand gate |

## Development

Requires Bun 1.4.2 or newer.

```sh
bun install --frozen-lockfile
bun run dev              # start the TUI from source
bun run check            # lint + typecheck
```

Tests run per package, never from the root (for example `cd packages/core && bun test`).

## Brand gate

`bun tools/rebrand/rebrand.ts --check` fails if the upstream product name appears anywhere in the tree.
After merging upstream changes, run `bun tools/rebrand/rebrand.ts --apply`, then the check.
