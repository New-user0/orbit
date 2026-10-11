# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. Compare a package's failures with this list before you decide a run is red. A new flake is fixed, or added here with its reason, in the PR that meets it; the one exception is a timeout-only failure that passes when its file is re-run alone (see the end of this file).

Last verified at commit `b79898f` (this branch with `origin/main` at `a0a4222` merged in; this and later commits change only documentation). All 22 packages that have a `test` script were run, one at a time, with `bun run test` from their directories: cli, core, tui, client, schema, sdk, util, vscode, merman, ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, server, simulation and theme. A package with a row below fails those tests and nothing else; ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, simulation and theme had no failures, so a failure in one of them is new, not missing from this list. The cli run needs about 40 minutes on a loaded machine (the first run, with a 25 minute limit, was cut off).

How to start a run: PowerShell or Git Bash works for every package except `packages/cli`, which needs Git Bash because its `mini-config` tests call `mktemp -d`. Core clears `SHELL` in `packages/core/test/preload.ts` on win32, so a Git Bash terminal (which exports `SHELL=/bin/bash.exe`) gives the same result as PowerShell.

On Linux, as CI's ubuntu job or a local container runs the packages, the tests need these on PATH as a person who is not root, because root ignores file permissions:
- `git`, `ripgrep`, `pgrep` (procps), `bubblewrap` and `socat`;
- Node.js 22.15 or later: the ESM reload tests in `packages/tui/test/plugin-source.test.ts` use `module.registerHooks`, and fail with Node 20.

The bubblewrap test in `packages/core/test/shell-sandbox.test.ts` also needs user namespaces, which Docker's default seccomp and AppArmor profiles block.

`tools/linux-test/linux-test.sh <git ref> [package...]` runs packages this way in Docker, with those profiles off for the test container: it bundles the commit, clones it in the container and runs each package's own `bun run test` (set `TEST_FILES` to run only some files). GitHub Actions has no minutes on this account, so this is how Linux runs for now.

Columns: "On main" is `yes` when the test failed in that verification run on `origin/main`, and `intermittent` when it is a known failure that did not appear in that run because it depends on load or timing. A cause that says "not root-caused" records only the failing assertion; it is not shown to be specific to Windows.

## Gates

A gate is a test that pins a promise in `docs/untrusted-repositories.md`. A gate is never excused by this list, with one exception that is a limit of the machine and not of the code:

- The idle-egress tests (`packages/cli/test/egress.test.ts`) and the class 9 control-character tests (for example `packages/tui/test/component/dialog-flow-runs.test.tsx`) must pass when re-run alone. A timeout under load is re-run alone; it is not an accepted failure.
- The class 3 and 4 symlink tests (`packages/cli/test/acp/additional-directories.test.ts` and `FileSystem > canonicalizes local symlinked directories` in `packages/core/test/location-filesystem.test.ts`) cannot pass on unelevated Windows, because `symlink()` fails with `EPERM`. They must pass on Linux, or on Windows with Developer Mode, before a milestone that touches path containment closes. The same holds for the `tui` test in `packages/tui/test/plugin-source.test.ts` below.
- The load-flake tests that guard trust (`LifecycleHooksPlugin under workspace trust` in `packages/core/test/plugin/lifecycle-hooks.test.ts`) are gates too: if one times out, re-run its file alone and it must pass.

## Fail every run

| Package | Test (file) | Cause | On main |
| --- | --- | --- | --- |
| cli | `acp additional directories over the wire > grants both the written and real spelling of a symlinked root and drops links to cwd` (`packages/cli/test/acp/additional-directories.test.ts`) | Creating a symlink fails with `EPERM` without Developer Mode or elevation. Class 3/4 gate: see Gates. | yes |
| cli | `acp config option subprocess > model option is listed with category "model"` (`packages/cli/test/acp/config-options.subprocess.test.ts`) | Not root-caused: the fixture's `test` provider is missing from the listed options, and the current model reported is `ollama/gemma3:4b`, the host's own Ollama model. Also fails at the import commit `7845c97`. Not verified with Ollama stopped. | yes |
| cli | `acp config option subprocess > model switch updates currentValue` (`packages/cli/test/acp/config-options.subprocess.test.ts`) | Same as above: not root-caused. | yes |
| cli | `acp config option subprocess > effort option is listed with category "thought_level" when selected model supports variants` (`packages/cli/test/acp/config-options.subprocess.test.ts`) | Same as above: not root-caused. | yes |
| cli | `acp config option subprocess > effort survives model synchronization and can be reset to default` (`packages/cli/test/acp/config-options.subprocess.test.ts`) | Same as above: not root-caused. | yes |
| client | `packages/client/test/import-boundaries.test.ts` (file fails to load) | Calls `realpathSync` on a package path that does not exist under the hoisted install (`--linker hoisted`). | yes |
| client | `evicts an unresponsive registered service before starting its replacement` (`packages/client/test/service.test.ts`) | Asserts on process signals and service replacement. Not root-caused. | yes |
| client | `evicts an unresponsive registered service before starting its replacement` (`packages/client/test/promise-service.test.ts`) | Same: not root-caused. | yes |
| client | `replaces an incompatible registered service` (`packages/client/test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals an incompatible service before starting its replacement` (`packages/client/test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals an unresponsive registered service process` (`packages/client/test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals the registered service process` (`packages/client/test/promise-service.test.ts`) | Same: not root-caused. | yes |
| core | `FileSystem > canonicalizes local symlinked directories` (`packages/core/test/location-filesystem.test.ts`) | Creating a symlink fails with `EPERM`. Class 3/4 gate: see Gates. | yes |
| core | `shell > normalizes Git Bash shell paths from env` (`packages/core/test/shell.test.ts`) | The test hard-codes `/cygdrive/c/Program Files/Git/bin/bash.exe`; Git is at `D:\Git` here, so the resolver falls back to another shell. | yes |
| merman | `audits deterministic flowchart and state layout families` (`packages/merman/src/layout-audit.test.ts`) | The layout metric `bends.max` is 31 against a limit of 30. Not shown to depend on this machine. merman is not part of CI. | yes |
| schema | `contract hygiene > current source limits Any to reviewed boundaries and avoids mutable contract wrappers` (`packages/schema/test/contract-hygiene.test.ts`) | The source scan turns `URL.pathname` into a path with a leading slash before the drive letter, which Windows cannot read. | yes |
| schema | `current source does not import the V1 subtree directly` (`packages/schema/test/v1-isolation.test.ts`) | Same `URL.pathname` cause. | yes |
| sdk | `create keeps requests and streams on its own transport despite an ambient Fetch` (`packages/sdk/test/transport.test.ts`) | The test expects `SessionNotFoundError` and receives a plain `NotFoundError` (line 48). Not shown to be Windows-specific; also fails at `7845c97`. | yes |
| sdk | `layer keeps requests and streams on its own transport despite an ambient Fetch` (`packages/sdk/test/transport.test.ts`) | Same as above. | yes |
| sdk | `embedded client exposes plugin-backed web search` (`packages/sdk/test/embedded.test.ts`) | Fails with `Web search provider not found: embedded-websearch`. Not root-caused; not shown to be Windows-specific. | yes |
| sdk | `Promise event streams support cancellation` (`packages/sdk/test/promise.test.ts`, line 48) | After the stream is aborted, `next()` resolves `{ done: true }` instead of rejecting with `ClientError` (`reason: "Transport"`). Not root-caused; not shown to be Windows-specific. | yes |
| tui | `real watchers observe atomic saves to nested, outside-root, and symlinked helpers` (`packages/tui/test/plugin-source.test.ts`) | Creating the symlink at line 195 fails with `EPERM`, before any watcher assertion runs, so the watcher is not tested on Windows. Same cause and rule as the other symlink tests: see Gates. | yes |
| util | `global > building a layer with default tmp creates and canonicalizes it` (`packages/util/test/global.test.ts`) | The test sets `TMPDIR`, which `os.tmpdir()` ignores on Windows, so the canonicalized path does not exist (`ENOENT` on `lstat`). | yes |
| vscode | `starts the background service through orb and returns an endpoint that authenticates` (`packages/vscode/test/endpoint.test.ts`) | The test plants a fake `orb` executable without an extension; Windows cannot run it, and the program lookup fails with `Could not find "...\orb". Set orbit.executable...`. | yes |
| vscode | `reports why orb could not start` (`packages/vscode/test/endpoint.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `reads the version orb prints` (`packages/vscode/test/endpoint.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `lists runs and their nodes, and approves a waiting gate` (`packages/vscode/test/runs.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `afterAll` hook (`packages/vscode/test/endpoint.test.ts:22`, reported as `(unnamed)`) | Stopping the service with the fake `orb` throws, so the hook ends before it removes its temporary folder. Same fake `orb` cause. | yes |

## Flaky, depend on load

Each passes when re-run alone, unless its row says otherwise.

| Package | Test (file) | Cause | On main |
| --- | --- | --- | --- |
| cli | `a headless run reaches only the configured model` (`packages/cli/test/egress.test.ts`) | Spawns a CLI child process and can time out when the machine is busy. Gate: see Gates. | intermittent |
| cli | `an idle server makes no outbound connections` (`packages/cli/test/egress.test.ts`) | Same as above. Gate. | intermittent |
| cli | (`packages/cli/test/flow.test.ts`) `a YAML workflow runs nodes as their needs finish, fills templates, and pauses at its gate` | Timing flake in the YAML gate test. | intermittent |
| cli | (`packages/cli/test/standalone.test.ts`) `standalone server exits when its owner is killed` | Takes about 9.6 s alone against a 10 s race, so it fails under any load. | intermittent |
| core | (`packages/core/test/npm.test.ts`) `Npm.add > reifies when package cache directory exists without the package installed` | The real install times out under load. | intermittent |
| core | `Npm.add > installs and locates unnamed Git packages with dependencies` (`packages/core/test/npm.test.ts`, line 223) | The real install times out under load (5 second limit). | intermittent |
| core | `Npm.add > installs and locates named Git packages with dependencies` (same file) | Same. | intermittent |
| core | `Vcs > ignores stale, deleted, renamed, and self-mirroring creation hints` (`packages/core/test/vcs.test.ts`) | Git work exceeds the 5 second limit under load. | intermittent |
| core | `Vcs > uses an explicit diff base without treating upstream or Git config as a parent` (same file) | Same 5 second limit; passes at `--timeout 30000`. | intermittent |
| core | `PluginSupervisor reload > retains a discovered plugin change during initial activation` and `... a configured plugin change ...` (`packages/core/test/plugin/supervisor-reload.test.ts`) | Not a timeout: `condition never became true after 100 advances` (`packages/core/test/lib/clock.ts`). Failed in the full run and in 2 of 3 runs of its file alone, so it does not always pass alone. Not root-caused; not shown to be Windows-specific. | intermittent |
| server | `refresh discovers both clones while list alone never discovers external worktrees` and `remove loads canonical strategies and enforces project ownership` (`packages/server/test/worktree.test.ts`) | Exceed the default 5 second limit even when the package is re-run alone; pass with `bun test --timeout 60000`. | intermittent |
| core | `Vcs > creates detached worktrees without review metadata and requires an explicit base without a named hint` (same file) | Same 5 second limit. | intermittent |
| core | `Vcs > does not infer beyond the bounded creation-reflog window` (same file) | Same 5 second limit. | intermittent |
| core | `Formatter > does not cache a command resolved before reload` (`packages/core/test/formatter.test.ts`) | Hit the 5 second limit under load; passes when its file is re-run alone. | intermittent |
| core | `Git > fetches, checks out, and resets remote changes` (`packages/core/test/git.test.ts`) | Same 5 second limit. | intermittent |
| core | `LocationServiceMap > routes located events only to their location` (`packages/core/test/location-layer.test.ts`, line 351) | Same 5 second limit. | intermittent |
| core | `LocationServiceMap > isolates provider state by location` (same file, line 453) | Same 5 second limit. | intermittent |
| core | `LifecycleHooksPlugin under workspace trust > runs the user's hooks, and the project's and its other-product settings hooks only once trusted` (`packages/core/test/plugin/lifecycle-hooks.test.ts`) | Same 5 second limit. A trust gate: see Gates. | intermittent |
| cli | `acp lifecycle subprocess` tests (`packages/cli/test/acp/lifecycle.subprocess.test.ts`; for example `delete capability and delete request`, `close capability and close request`, `new session succeeds on the first request`) | A different one to three of the file's tests fail with `Timed out waiting for initialize response` in each run, and did so in two of two runs of the file alone while other agents were using the machine. Not root-caused. | intermittent |
| cli | `unresponsive managed port occupancy reports a bounded conflict`, `port contender recognizes an incumbent registered during the bind race` and `a failed service stays registered and owns the selected port until stopped` (`packages/cli/test/service.test.ts`) | Time out at 20 to 27 s in the full run; the file passes alone (28 pass with the lifecycle file's other test). | intermittent |
| cli | `acp prompt content subprocess > accepts embedded text resource image and file resource link prompt content` (`packages/cli/test/acp/prompt-content.subprocess.test.ts`) | Fails with `Timed out waiting for initialize response`, a harness wait for the spawned process, under load. | intermittent |
| cli | `CLI frontend import boundaries > keeps TUI Mini independent from Core, Server, and CLI` (`packages/cli/test/import-boundaries.test.ts`) | Fails the same way on a clean `m3-integration` checkout; no task owns it yet. | yes |
| cli | `an untrusted Read through a \?\Volume path is refused before any question`, the trusted variant, and the `\.\Volume` pair (`packages/cli/test/acp/permission-files.subprocess.test.ts`) | Four rows that fail on a clean `m3-integration` checkout on this Windows machine. | yes |
| cli | `an untrusted WebFetch with a model-added files array is titled by its URL and has no diffs` (same file) | Fails on a clean `m3-integration` checkout. | yes |
| cli | `a YAML workflow that sets permissions to auto is not run in an untrusted folder that holds nothing back, and runs with --trust` (`packages/cli/test/trust.test.ts`) | Seen once on Linux (Docker, see Gates) in the full file run, not a timeout: `The agent produced no reply. No model was set for it`. Passed when re-run alone, and did not recur in two later Linux runs of the file. Not root-caused. | intermittent |
| tui | (`packages/tui/test/session-home.test.tsx`) `Home loads a stable, bounded beginning (mixed)` | Timing flake. | intermittent |
| tui | `files a sent prompt under its directory and time, and keeps only history_limit entries` (`packages/tui/test/prompt/history-provider.test.tsx`) | Seen on Linux (Docker, see Gates): an entry the limit trim removed comes back (`two, three, two`). Prompt-history writes are not serialized, so an append still in flight when the trim rewrites the file restores it. It failed in 3 of 6 runs of the file at `e405408` and 2 of 5 at `4a2c9b5`. Not a timeout. | intermittent |
| util | (`packages/util/test/observability-otlp.test.ts`) `exports a span through the configured OTLP trace endpoint` | Hit its 5.16 s timeout under load. | intermittent |

A timeout-only failure under load is a load flake: it passes when its file is re-run alone, and it needs no new row. The timeout may be the test's own (5 seconds in core, 30 seconds in cli and tui), the runner's, or a harness wait such as a spawned process that does not answer. The PR names the test and the file it re-ran alone. A gate (see Gates) must still pass when re-run alone. Any other failure is fixed, or added here with its reason.
