# Fork map: upstream v2.0.22 → Orbit

- **Base:** upstream tag `v2.0.22` (the v2 rewrite line, released 2026-10-02), imported with full history in the merge commit "Import upstream v2.0.22 (MIT)".
- **Why not v1:** the `dev` branch is the v1.x line (`v1.18.34`). Since the two lines split in June 2026, v2 has had 4,051 commits and v1 has had 1,340.

Everything below comes from a read-only audit of this tree, plus one baseline run. Line numbers refer to v2.0.22 and will drift as we edit.

## Baseline (Phase 1, step 3)

| Check                                                                                                   | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install` with Bun 1.3.14                                                                           | Fails. The repo pins `packageManager: bun@1.4.2`, and older Bun re-resolves dependencies and trips `minimumReleaseAge` in `bunfig.toml`. **Use Bun ≥ 1.4.2.**                                 |
| `bun install --frozen-lockfile --filter ./packages/cli` with Bun 1.4.2                                  | Works (766 packages). A full install also fetches `ghostty-web` as a GitHub tarball for `packages/app` and `gui-extensions`; the sandbox proxy blocks that (403), but your laptop should not. |
| `bun run --cwd packages/cli src/index.ts --version` / `--help`, outbound traffic forced to a dead proxy | Works. Prints `<upstream> vlocal` and the command list.                                                                                                                                       |
| Windows: `bun install`, `bun dev`, one chat against Ollama                                              | **Your run.** Not possible from this sandbox.                                                                                                                                                 |

## Package map

The CLI is `packages/cli`. Its bins are `<upstream>` and `<upstream>2`, both via `bin/<upstream>.cjs`.

**Keep** (the runtime closure of the CLI):

- `cli`, `core`, `server`, `tui`, `client`, `protocol`, `schema`, `util`, `plugin`, `ai`, `theme`
- `simulation`, `codemode`, `plugin-browser`, `latex`, `merman`
- `ui` (the TUI imports its sounds)
- `script` (build), `http-recorder` and `httpapi-codegen` (dev)
- `sdk`
- root `patches/` (applied at install)

**Keep for now, decide in Phase 4:** `app`, `session-ui`, `gui-extensions`.

- They form the web UI that is embedded into the binary.
- `--skip-web-ui` skips them, but the runtime then fails at `cli/src/app-assets.ts:16`. Cutting them means patching that.

**Keep but rebuild:** `sdks/vscode`. It is a v1-era launcher: it calls `/tui/append-prompt`, which no longer exists in the v2 server. **Phase 4 is real work, not just a rebrand.**

**Cut:**

| Item                                            | What it is                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `desktop`                                       | Electron app                                               |
| `enterprise`                                    | Share and enterprise site                                  |
| `web`                                           | Docs. It accounts for 21,383 of the 41,749 matching lines. |
| `posts`                                         | Blog                                                       |
| `function`                                      | Cloudflare worker                                          |
| `storybook`                                     | Component explorer                                         |
| `containers`                                    | Container images                                           |
| `identity`                                      | Logos                                                      |
| `effect-drizzle-sqlite`                         | Examples only                                              |
| `console/*`                                     | Hosted console, Zen, billing                               |
| `stats/*`                                       | Hosted stats                                               |
| `services/{www,update,files}`                   | Hosted services                                            |
| `infra`, `sst.config.ts`, `sst-env.d.ts`, `nix` | Deployment and packaging                                   |
| `github` (Action)                               | GitHub Action                                              |
| `specs`, `perf`, `artifacts`                    | Specs, benchmarks, artifacts                               |
| `install` (shell installer)                     | Downloads from the upstream site                           |
| `.<upstream>`, `.github` workflows              | Rewritten as our own                                       |
| root `script/`                                  | Everything except `script/ast-grep`                        |
| 24 `README.*` files                             | Translations                                               |

## Phone-home removal (Phase 2b, revised for v2)

| #   | Upstream behaviour                                                                                                                                                                                                                                 | Where                                                                                                               | Default                        | Orbit                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Update check every 10 min, plus self-upgrade (`bun install -g`, `curl …/v2/install`)                                                                                                                                                               | `cli/src/services/updater.ts:241,386,397`; `commands/handlers/default.ts:70-86`; `upgrade` and `uninstall` commands | **ON**                         | Delete the updater and both commands                                                                                                                        |
| 2   | Models catalog from the upstream site, refreshed every 5 min                                                                                                                                                                                       | `core/src/models-dev.ts:268,333-336,420`                                                                            | **ON**                         | Delete the remote fetch and keep the bundled snapshot (`models-dev/snapshot.txt`) plus Orbit's registry. An optional internal mirror URL is off by default. |
| 3   | Free "<upstream>" Zen provider, enabled with `apiKey:"public"`, **sends prompts and code to the upstream site**                                                                                                                                    | `core/src/plugin/provider/<upstream>.ts:317-340`; `ai/src/providers/<upstream>-zen.ts`                              | **ON**                         | Delete it and unregister it (`core/src/plugin/provider.ts:22,54`)                                                                                           |
| 4   | Console login, remote org config polled every minute, websearch proxy                                                                                                                                                                              | `core/src/plugin/provider/<upstream>.ts:20,368,462-475,565-595`                                                     | After login                    | Delete (same plugin as row 3)                                                                                                                               |
| 5   | Plugin update checks against npm every 24 h                                                                                                                                                                                                        | `core/src/plugin/update.ts:8,39`                                                                                    | ON when plugins are configured | Delete                                                                                                                                                      |
| 6   | Runtime npm install of provider and plugin packages                                                                                                                                                                                                | `core/src/provider.ts:128`; `plugin/provider/sdk-factory.ts:8`; `plugin/module.ts:91`                               | When config references one     | Off by default. Built-in providers are bundled. Opt-in `plugins.install: true`.                                                                             |
| 7   | ripgrep download from GitHub                                                                                                                                                                                                                       | `core/src/ripgrep/binary.ts:109`                                                                                    | If `rg` is missing             | Delete the download. Use `rg` from PATH, or bundle it. `orb doctor` checks it.                                                                              |
| 8   | Tree-sitter wasm and queries from GitHub, including `<upstream-org>/*`                                                                                                                                                                             | `tui/src/parsers-config.ts:9-381`                                                                                   | Lazy, per language             | Bundle the grammars we ship; drop the remote URLs                                                                                                           |
| 9   | Web search (Exa keyless, Parallel, Firecrawl, Tavily, TinyFish)                                                                                                                                                                                    | `core/src/plugin/websearch/*`                                                                                       | Off until selected             | Keep **opt-in**; remove the keyless Exa default                                                                                                             |
| 10  | `.well-known/<upstream>` remote config                                                                                                                                                                                                             | `core/src/wellknown.ts:61`                                                                                          | Only with a well-known auth    | Rename to `.well-known/orbit`, or delete                                                                                                                    |
| 11  | MCP OAuth `client_id` = the upstream site                                                                                                                                                                                                          | `core/src/mcp/oauth.ts:27,183`                                                                                      | When MCP OAuth is used         | Replace with dynamic client registration, or a configurable client id                                                                                       |
| 12  | OTLP export                                                                                                                                                                                                                                        | `util/src/observability/otlp.ts`                                                                                    | OFF                            | Keep opt-in; set `service.name=orbit`                                                                                                                       |
| 13  | Web UI: changelog.json and a notification icon from the upstream site                                                                                                                                                                              | `app/src/shell/updates/highlights.tsx:12`; `app/src/runtime/platform/web.ts:33`                                     | Partly                         | Delete the fetches (or cut `app`)                                                                                                                           |
| 14  | Identity headers on **every** LLM request: `x-<upstream>-session-id`, `x-<upstream>-parent-session-id`, `x-session-affinity`, `X-Session-Id`, `x-parent-session-id`, `x-<upstream>-project`, `-session`, `-client`, and `User-Agent: <upstream>/…` | `core/src/session/model-request.ts:279-287`; `core/src/generate.ts:70`; `core/src/app.ts:17,24`                     | **ON**                         | Delete them all. The User-Agent becomes `orbit/<ver>`. Keep `promptCacheKey` only where the provider supports prompt caching.                               |
| 15  | Attribution headers `HTTP-Referer: <upstream site>` and `X-Title: <upstream>`                                                                                                                                                                      | `core/src/plugin/provider/{openrouter,kilo,vercel,llmgateway,nvidia,zenmux}.ts`                                     | ON                             | Delete                                                                                                                                                      |
| 16  | `originator: <upstream>` (ChatGPT OAuth)                                                                                                                                                                                                           | `core/src/plugin/provider/openai.ts:267,310,412`                                                                    | With ChatGPT login             | **Done:** ChatGPT login removed (OpenAI is API-key only); the xAI provider is removed too                                                                   |
| 17  | WebFetch User-Agent `upstream-User/1.0; +the upstream site                                                                                                                                                                                         | `core/src/tool/plugin/webfetch.ts:59`                                                                               | ON                             | `Orbit/<ver>`                                                                                                                                               |
| 18  | Binary default UA (`--user-agent=<upstream>/…`)                                                                                                                                                                                                    | `cli/script/build.ts:144`                                                                                           | ON                             | `orbit/<ver>`                                                                                                                                               |
| 19  | `stats` command ("shareable usage statistics")                                                                                                                                                                                                     | `packages/cli`                                                                                                      | —                              | Check what it does; delete it if it uploads anything                                                                                                        |

No session share and no Sentry or PostHog analytics exist in the v2 runtime.

**Egress chokepoint**

- HTTP: the Effect `HttpClient` = `FetchHttpClient.layer` = `globalThis.fetch` (`util/src/effect/app-node-platform.ts:11`).
- Several paths call `fetch` directly (the AI SDK path, some provider plugins, `codemode/web.ts`, the MCP SDK).
- WebSockets: `core/src/effect/websocket-constructor.ts`.
- Child processes: npm, curl, git.

So the **egress allowlist and TLS** are installed as:

- a `globalThis.fetch` wrapper set first in `cli/src/index.ts` and `cli/src/server-process.ts`,
- a patched WebSocket constructor,
- process-spawn checks for npm and curl.

The binary already runs with `--use-system-ca` (`build.ts:145`), so the OS trust store works out of the box.

## Branding (Phase 2c)

- **Volume:** 41,749 matching lines in 3,459 files. Cutting the packages above removes over 30,000 of them.
- **Identifiers to route through `brand.ts`:**
  - Binary name: `cli/script/build.ts:15,153`, `bin/<upstream>*.cjs`, and `client/src/effect/service.ts:68`, which spawns `<upstream> serve`.
  - Package scope: `@<upstream>/*` → `@orbit/*`.
  - Config: `core/src/config/discovery.ts:11,41` (`<upstream>.json[c]`, `.<upstream>/`).
  - XDG dirs: `util/src/global.ts:12`, `client/src/effect/service.ts:158`.
  - Env vars: 67 runtime `<UPSTREAM>_*`, 166 in the whole repo. There is no central registry, so `brand.ts` becomes one.
  - Request headers: `x-<upstream>-directory` (`server/src/location.ts:43`), `x-<upstream>-ticket` (`protocol/src/groups/pty.ts:10`).
  - Basic-auth username `"<upstream>"` (`server/src/auth.ts:20` and its 3 clients).
  - Effect service tags and plugin ids (`<upstream>.websearch.*`).
  - OTLP `service.name`.
- **Prompts:**
  - `core/src/plugin/system-prompt/*.txt`
  - `core/src/session/runner/prompt/system.txt`
  - bundled skill `core/src/plugin/skill/<upstream>.md`
  - tool `core/src/tool/plugin/<upstream>.ts`
- **Visuals:**
  - `tui/src/logo.ts`, `component/logo.tsx`, `mini/splash.ts`
  - themes `<upstream>.json` (two of them)
  - `$schema: the upstream site in all 34 themes
- **Upstream npm packages whose names contain "<upstream>":** resolved in Phase 2. The persistent PTY package was dropped (the feature reports unavailable). The GitLab provider was removed together with `gitlab-ai-provider`, which wrote to upstream's config paths and bundled upstream's OAuth app. The renamed entries were removed from the `bunfig.toml` exclude list. The embedded Bun runtime also carries the name (its trusted-dependency list and a variable in its `styleText` builtin): `packages/cli/script/build.ts` patches a copy of the runtime with same-length replacements before compiling, so `rebrand.ts --scan` checks the binary strictly. Cross-target builds need `BUN_COMPILE_RELEASE` so their runtime can be patched too.

## Provider layer (Phase 3, revised for v2)

v2 replaced the Vercel AI SDK with its own Effect-based layer, `packages/ai` (design in `packages/ai/AGENTS.md`).

- **Shape:** a route is **Protocol + Endpoint + Auth + Framing** (`ai/src/route/`). There are about 40 protocol adapters, `openai-compatible-chat` among them.
- **Adding a provider:**
  1. `ai/src/providers/<x>.ts` plus an entry in `ai/package.json` exports
  2. register it in `core/src/provider.ts` builtins
  3. a catalog entry
  4. optionally an auth/header plugin in `core/src/plugin/provider/<x>.ts`
- **Already built in, so we use it instead of writing our own:**
  - **Per-model `max_tokens` vs `max_completion_tokens`:** `compatibility.maxTokensField` (`schema/src/model.ts:75-83`). If unset, it is auto-detected from provider and base URL (`ai/src/protocols/openai-chat.ts:685-716`). For Tachyon, Orbit **sets it explicitly per model** from `config/model-capabilities.json` and never relies on the auto-detection.
  - **Per-request auth headers:** `Auth` is an Effect that returns headers for each request (`ai/src/route/auth.ts:36-37`). That is where the Tachyon token exchange, the token cache and the 5 required headers go (`docs/tachyon.md`).
  - **Request rewriting:** the plugin hook `http.request` (template: `core/src/plugin/provider/azure.ts:438-452`).
- **Missing:** there is no custom-fetch option on the native path. That doesn't matter, because TLS is handled at the global chokepoint above.
- **Tachyon plan (revised):**
  - `ai/src/providers/tachyon.ts`: openai-compatible-chat protocol + Tachyon `Auth` + Tachyon error mapping
  - `core/src/plugin/provider/tachyon.ts`: config, model capabilities, fallback
  - plus a catalog entry

## Server API

- **Working directory per request:** the query param `location[directory]` or the header `x-<upstream>-directory` (→ `x-orbit-directory`), falling back to `process.cwd()` (`server/src/location.ts:39-46`). This is all Orbit Flow needs for one git worktree per agent.
- **Plugin hooks:**
  - session: prompt, context, compaction, generate, title, model.request, http.request, http.response, ws.\*, retry
  - tool: execute.before, execute.after
  - shell: create.before
  - permission: evaluate
  - aisdk: sdk, language
  - transforms

## Build

- **Bun:** ≥ 1.4.2.
- **Dev:** `bun run --cwd packages/cli src/index.ts`.
- **Single-file binary:** `bun run packages/cli/script/build.ts --single [--skip-web-ui]`. It produces `packages/cli/dist/<target>/bin/<upstream>`, which becomes `orb`.
  - `<UPSTREAM>_VERSION`, `<UPSTREAM>_CHANNEL` and `<UPSTREAM>_ARTIFACT` are injected via `define` (`build.ts:120-185`).
