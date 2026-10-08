# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. Compare a package's failures with this list before you decide a run is red. A new flake is fixed, or added here with its reason, in the PR that meets it.

Last verified against `origin/main` at `b205ea7` by running each package's `bun run test` one at a time from its directory.

How to start a run: use PowerShell for every package. Core clears `SHELL` in `packages/core/test/preload.ts` on win32, so a Git Bash terminal (which exports `SHELL=/bin/bash.exe`) gives the same result. The cli `mini-config` tests call `mktemp -d`, which only Git Bash provides, so run `packages/cli` from Git Bash.

Columns: "On main" is `yes` when the test failed in that verification run on `origin/main`, and `intermittent` when it is a known failure that did not appear in that run because it depends on load or timing. A cause that says "not root-caused" records only the failing assertion; it is not shown to be specific to Windows.

Gates are not excused. Tests that the plan or `docs/untrusted-repositories.md` names as gates (the idle-egress tests, the class 3 and 4 symlink tests, the class 9 control-character tests) must pass when re-run alone. The symlink tests below cannot run unelevated on Windows, so they must run on Linux or with Windows Developer Mode before a milestone that touches them closes.

## Fail every run

| Package | Test (file) | Cause | On main |
| --- | --- | --- | --- |
| cli | `acp additional directories over the wire > grants both the written and real spelling of a symlinked root and drops links to cwd` (`test/acp/`) | Creating a symlink fails with `EPERM` without Developer Mode or elevation. Class 3/4 test: run it on Linux before closing a milestone. | yes |
| cli | `acp config option subprocess > model option is listed with category "model"` (`test/acp/config-options.subprocess.test.ts`) | Not root-caused: the fixture's `test` provider is missing from the listed options. Also fails at the import commit `7845c97`. May depend on the host (Ollama running); not verified with Ollama stopped. | yes |
| cli | `acp config option subprocess > model switch updates currentValue` (same file) | Same as above: not root-caused. | yes |
| cli | `acp config option subprocess > effort option is listed with category "thought_level" when selected model supports variants` (same file) | Same as above: not root-caused. | yes |
| cli | `acp config option subprocess > effort survives model synchronization and can be reset to default` (same file) | Same as above: not root-caused. | yes |
| client | `import-boundaries.test.ts` (file fails to load) | Calls `realpathSync` on a package path that does not exist under the hoisted install (`--linker hoisted`). | yes |
| client | `evicts an unresponsive registered service before starting its replacement` (`test/service.test.ts`) | Asserts on process signals and service replacement. Not root-caused. | yes |
| client | `evicts an unresponsive registered service before starting its replacement` (`test/promise-service.test.ts`) | Same: not root-caused. | yes |
| client | `replaces an incompatible registered service` (`test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals an incompatible service before starting its replacement` (`test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals an unresponsive registered service process` (`test/service.test.ts`) | Same: not root-caused. | yes |
| client | `signals the registered service process` (`test/promise-service.test.ts`) | Same: not root-caused. | yes |
| core | `FileSystem > canonicalizes local symlinked directories` | Creating a symlink fails with `EPERM`. Run it on Linux or with Developer Mode before closing a milestone that touches path containment. | yes |
| core | `shell > normalizes Git Bash shell paths from env` (`test/shell.test.ts`) | The test hard-codes `/cygdrive/c/Program Files/Git/bin/bash.exe`; Git is at `D:\Git` here, so the resolver falls back to another shell. | yes |
| merman | `audits deterministic flowchart and state layout families` | The layout metric `bends.max` is 31 against a limit of 30. Not shown to depend on this machine. merman is not part of CI. | yes |
| schema | `contract hygiene > current source limits Any to reviewed boundaries and avoids mutable contract wrappers` (`test/contract-hygiene.test.ts`) | The source scan turns `URL.pathname` into a path with a leading slash before the drive letter, which Windows cannot read. | yes |
| schema | `current source does not import the V1 subtree directly` (`test/v1-isolation.test.ts`) | Same `URL.pathname` cause. | yes |
| sdk | `create keeps requests and streams on its own transport despite an ambient Fetch` (`test/transport.test.ts`) | The test expects `SessionNotFoundError` and receives a plain `NotFoundError` (line 48). Not shown to be Windows-specific; also fails at `7845c97`. | yes |
| sdk | `layer keeps requests and streams on its own transport despite an ambient Fetch` (`test/transport.test.ts`) | Same as above. | yes |
| sdk | `embedded client exposes plugin-backed web search` (`test/embedded.test.ts`) | Fails with `Web search provider not found: embedded-websearch`. Not root-caused; not shown to be Windows-specific. | yes |
| sdk | `Promise event streams support cancellation` (`test/promise.test.ts`) | Cancellation assertion fails. Not root-caused; not shown to be Windows-specific. | yes |
| tui | `real watchers observe atomic saves to nested, outside-root, and symlinked helpers` | The Windows file watcher does not report these atomic saves (or the symlinked helper) as the test expects. Not root-caused further. | yes |
| util | `global > building a layer with default tmp creates and canonicalizes it` | The test sets `TMPDIR`, which `os.tmpdir()` ignores on Windows, so the canonicalized path does not exist (`ENOENT` on `lstat`). | yes |
| vscode | `starts the background service through orb and returns an endpoint that authenticates` (`test/endpoint.test.ts`) | The test plants a fake `orb` executable without an extension; Windows cannot run it (`Executable not found in $PATH`). | yes |
| vscode | `reports why orb could not start` (`test/endpoint.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `reads the version orb prints` (`test/endpoint.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `lists runs and their nodes, and approves a waiting gate` (`test/runs.test.ts`) | Same fake `orb` cause. | yes |
| vscode | `afterAll` hook (`test/endpoint.test.ts:22`, reported as `(unnamed)`) | Stopping the service with the fake `orb` throws, so the hook ends before it removes its temporary folder. Same fake `orb` cause. | yes |

## Flaky, depend on load

Each passes when re-run alone.

| Package | Test (file) | Cause | On main |
| --- | --- | --- | --- |
| cli | `egress.test.ts`: `a headless run reaches only the configured model` and `an idle server makes no outbound connections` | Each spawns a CLI child process and can time out when the machine is busy. These are gates: a failure under load is re-run alone and must then pass. They are not an accepted failure. | intermittent |
| cli | `flow.test.ts`: `a YAML workflow runs nodes as their needs finish, fills templates, and pauses at its gate` | Timing flake in the YAML gate test. | intermittent |
| cli | `standalone.test.ts`: `standalone server exits when its owner is killed` | Takes about 9.6 s alone against a 10 s race, so it fails under any load. | intermittent |
| core | `Npm.add > reifies when package cache directory exists without the package installed` | The real install times out under load. | intermittent |
| core | `Vcs > ignores stale, deleted, renamed, and self-mirroring creation hints` and `Vcs > creates detached worktrees without review metadata and requires an explicit base without a named hint` | Git work exceeds the 5 second limit under load. | intermittent |
| core | `Vcs > does not infer beyond the bounded creation-reflog window` | Same 5 second limit under load. | intermittent |
| tui | `session-home.test.tsx`: `Home loads a stable, bounded beginning (mixed)` | Timing flake. | intermittent |
| util | `observability-otlp.test.ts`: `exports a span through the configured OTLP trace endpoint` | Hit its 5.16 s timeout under load. | intermittent |
