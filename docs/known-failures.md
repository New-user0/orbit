# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. Compare a package's failures with this list before you decide a run is red. A new flake is fixed, or added here with its reason, in the PR that meets it.

Last verified against `origin/main` at `b205ea7` by running each package's `bun run test` one at a time from its directory (core from Git Bash).

Columns: "On main" is `yes` when the test failed in that verification run on `origin/main`, and `intermittent` when it is a known failure that did not appear in that run because it depends on load or timing. Anything on this list that passes is fine; anything that fails and is not listed is yours to explain.

## Fail every run

| Package | Test | Reason | On main |
| --- | --- | --- | --- |
| cli | `acp additional directories over the wire > grants both the written and real spelling of a symlinked root and drops links to cwd` | Symlink handling differs on Windows (creating a symlink needs a privilege an unelevated account usually lacks). | yes |
| cli | `orb models waits for Ollama models that a fresh server has not discovered yet` | The machine runs a real Ollama server, so models are already discovered and the "not yet discovered" state cannot be set up. | yes |
| cli | `acp config option subprocess` (4 tests: model category, model switch, effort category, effort survives sync) | The host Ollama server leaks into the fixture: the session selects `ollama/gemma3:4b` instead of `test/test-model` and the `test/second-model` option is missing. Same cause as the Ollama test above. | yes |
| client | `import-boundaries.test.ts` (file fails to load) | The test calls `realpathSync` on a package path that does not exist under the hoisted install (`--linker hoisted`). | yes |
| client | `evicts an unresponsive registered service before starting its replacement` (two cases), `replaces an incompatible registered service`, `signals an incompatible service before starting its replacement`, `signals an unresponsive registered service process`, `signals the registered service process` | The tests assert on process signals and service replacement, which behave differently on Windows. | yes |
| core | `FileSystem > canonicalizes local symlinked directories` | Symlink handling differs on Windows (creating a symlink needs a privilege an unelevated account usually lacks). | yes |
| core | `Session.create > runs a shell command and projects the started/ended shell message` | The shell tool cannot find a POSIX shell on this machine. | yes |
| core | `Session.shell` (8 tests) | Same cause: no POSIX shell, so the shell never completes and the tests wait out their 5 second limit. | yes |
| core | `ShellTool` (18 tests) | Same cause: no POSIX shell. | yes |
| core | `shell > normalizes Git Bash shell paths from env` | The test expects POSIX-style Git Bash paths and gets Windows paths. | yes |
| merman | `audits deterministic flowchart and state layout families` | A layout metric exceeds its limit on this machine. merman is not part of CI. | yes |
| schema | `contract hygiene > current source limits Any to reviewed boundaries and avoids mutable contract wrappers` and `current source does not import the V1 subtree directly` | The source scans turn `URL.pathname` into a path, which has a leading slash and drive-letter form that Windows cannot read. | yes |
| sdk | `create keeps requests and streams on its own transport despite an ambient Fetch` and `layer keeps requests and streams on its own transport despite an ambient Fetch` | The transport assertion fails on Windows. | yes |
| sdk | `embedded client exposes plugin-backed web search` | `Web search provider not found: embedded-websearch`. | yes |
| sdk | `Promise event streams support cancellation` | Cancellation assertion fails on Windows. | yes |
| tui | `real watchers observe atomic saves to nested, outside-root, and symlinked helpers` | The Windows file watcher does not report these atomic saves (or the symlinked helper) as the test expects. | yes |
| util | `global > building a layer with default tmp creates and canonicalizes it` | The layer's default tmp directory is missing at the path the test canonicalizes (`ENOENT` on `lstat`). | yes |
| vscode | `starts the background service through orb and returns an endpoint that authenticates`, `lists runs and their nodes, and approves a waiting gate`, `reads the version orb prints`, `reports why orb could not start`, `(unnamed)` | The tests plant a fake `orb` executable without an extension, and Windows cannot run it (`Executable not found in $PATH`). | yes |

## Flaky, depend on load or on how the test is started

| Package | Test | Reason | On main |
| --- | --- | --- | --- |
| cli | `egress.test.ts`: `a headless run reaches only the configured model` and `an idle server makes no outbound connections` | The two tests spawn a CLI child process and time out when the machine is busy. | intermittent |
| cli | `flow.test.ts`: `a YAML workflow runs nodes as their needs finish, fills templates, and pauses at its gate` | Timing flake in the YAML gate test. Passes alone. | intermittent |
| cli | `mini-config.test.ts` (3 tests) | They call `mktemp -d`, which exists under Git Bash but not under PowerShell. Run them from Git Bash. | intermittent |
| core | `Npm.add > reifies when package cache directory exists without the package installed` | The real install times out under load. Passes alone. | intermittent |
| core | `Vcs` creation-hint tests (`ignores stale, deleted, renamed, and self-mirroring creation hints`, `creates detached worktrees without review metadata and requires an explicit base without a named hint`) | Git work in these tests exceeds the 5 second limit under load. Pass alone. | intermittent |
| tui | `component/dialog-flow-runs.test.tsx` | Timing flake. Passes alone. | intermittent |
