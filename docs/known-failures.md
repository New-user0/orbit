# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. Compare a package's failures with this list before you decide a run is red. A new flake is fixed, or added here with its reason, in the PR that meets it.

Last verified against `origin/main` at `4b5e035` by running each package's `bun run test` one at a time from its directory.

How to start a run: PowerShell or Git Bash works for every package except `packages/cli`, which needs Git Bash because its `mini-config` tests call `mktemp -d`. Core clears `SHELL` in `packages/core/test/preload.ts` on win32, so a Git Bash terminal (which exports `SHELL=/bin/bash.exe`) gives the same result as PowerShell.

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
| vscode | `afterAll` hook (`test/endpoint.test.ts:22`, reported as `(unnamed)`) | Stopping the service with the fake `orb` throws, so the hook ends before it removes its temporary folder. Same fake `orb` cause. | yes |

## Flaky, depend on load

Each passes when re-run alone.

| Package | Test (file) | Cause | On main |
| --- | --- | --- | --- |
| cli | `a headless run reaches only the configured model` (`packages/cli/test/egress.test.ts`) | Spawns a CLI child process and can time out when the machine is busy. Gate: see Gates. | intermittent |
| cli | `an idle server makes no outbound connections` (`packages/cli/test/egress.test.ts`) | Same as above. Gate. | intermittent |
| cli | (`packages/cli/test/flow.test.ts`) `a YAML workflow runs nodes as their needs finish, fills templates, and pauses at its gate` | Timing flake in the YAML gate test. | intermittent |
| cli | (`packages/cli/test/standalone.test.ts`) `standalone server exits when its owner is killed` | Takes about 9.6 s alone against a 10 s race, so it fails under any load. | intermittent |
| core | (`packages/core/test/npm.test.ts`) `Npm.add > reifies when package cache directory exists without the package installed` | The real install times out under load. | intermittent |
| core | `Vcs > ignores stale, deleted, renamed, and self-mirroring creation hints` (`packages/core/test/vcs.test.ts`) | Git work exceeds the 5 second limit under load. | intermittent |
| core | `Vcs > creates detached worktrees without review metadata and requires an explicit base without a named hint` (same file) | Same 5 second limit. | intermittent |
| core | `Vcs > does not infer beyond the bounded creation-reflog window` (same file) | Same 5 second limit. | intermittent |
| core | `Formatter > does not cache a command resolved before reload` (`packages/core/test/formatter.test.ts`) | Hit the 5 second limit under load; passes when its file is re-run alone. | intermittent |
| core | `Git > fetches, checks out, and resets remote changes` (`packages/core/test/git.test.ts`) | Same 5 second limit. | intermittent |
| core | two `LocationServiceMap` tests (`packages/core/test/location-layer.test.ts`) | Same 5 second limit. | intermittent |
| core | `LifecycleHooksPlugin under workspace trust > runs the user's hooks ... only once trusted` (`packages/core/test/plugin/lifecycle-hooks.test.ts`) | Same 5 second limit. A trust gate: see Gates. | intermittent |
| tui | (`packages/tui/test/session-home.test.tsx`) `Home loads a stable, bounded beginning (mixed)` | Timing flake. | intermittent |
| util | (`packages/util/test/observability-otlp.test.ts`) `exports a span through the configured OTLP trace endpoint` | Hit its 5.16 s timeout under load. | intermittent |

A test that fails only with its 5 second timeout under load, and passes when its file is re-run alone, is a load flake: it needs no new row of its own beyond the rows above, but say in the PR which file you re-ran alone.
