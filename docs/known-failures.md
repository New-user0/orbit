# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. Compare a package's failures with this list before you decide a run is red. A new flake is fixed, or added here with its reason, in the PR that meets it; the one exception is a timeout-only failure that passes when its file is re-run alone (see the end of this file).

Rows were last checked package by package at commit `b79898f` (with `origin/main` at `a0a4222` merged in), before M3. Round 7 then re-ran the file of every row alone, on Windows and in Linux Docker, at `4e29991`; see "Round 7" at the end of this file for what each row did. Round 7 also ran each row's file in the package's parallel run (see "Round 7"). `bun run test` in core, cli, tui, server and vscode runs files in parallel worker processes; `ORBIT_TEST_WORKERS=1` runs one after the other, and a file that timed out under that load is re-run alone with `bun test --timeout 60000 <file>` (in core, `bun run test <file>`). M3 round 2 re-ran the three symlink gates on Windows with Developer Mode on and on Linux in Docker: all three pass, so they no longer have a row under "Fail every run". All 22 packages that have a `test` script were run, one at a time, with `bun run test` from their directories: cli, core, tui, client, schema, sdk, util, vscode, merman, ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, server, simulation and theme. A package with a row below fails those tests and nothing else; ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, simulation and theme had no failures, so a failure in one of them is new, not missing from this list. The cli run needs about 40 minutes on a loaded machine (the first run, with a 25 minute limit, was cut off).

How to start a run: use Git Bash for `packages/core`, `packages/sdk` and `packages/cli`, with Git's `usr\bin` ahead of System32 on `PATH` (Git Bash does that). From PowerShell a bare `bash` resolves to the WSL launcher in System32, which prints `execvpe(/bin/bash) failed`, and `echo` and `sleep` are missing; that made core fail about 258 tests instead of 5 (the real-shell rows in `shell-scan/bash-safety.test.ts`, the shell tool, command subagents, `cross-spawn-spawner` and `persistent-pty-daemon`), and the sdk test `blocks the model-selected first tool on lazy provisioning` times out with 'first tool did not provision' for another reason: with `SHELL` unset, as in PowerShell, Orbit's session shell on Windows is PowerShell, so the shell tool is offered as PowerShell while the test's model asks for Bash. Git Bash exports `SHELL`, which is why it passes there. The cli package needs Git Bash as well, because its `mini-config` tests call `mktemp -d`. Of the other packages, only `packages/sdk` differs between the two shells (the test above); the rest give the same result from both. Core clears `SHELL` in `packages/core/test/preload.ts` on win32, so Git Bash's `SHELL=/bin/bash.exe` does not change a result.

On Linux, as CI's ubuntu job or a local container runs the packages, the tests need these on PATH as a person who is not root, because root ignores file permissions:
- `git`, `ripgrep`, `pgrep` (procps), `bubblewrap` and `socat`;
- Node.js 22.15 or later: the ESM reload tests in `packages/tui/test/plugin-source.test.ts` use `module.registerHooks`, and fail with Node 20.

The bubblewrap test in `packages/core/test/shell-sandbox.test.ts` also needs user namespaces, which Docker's default seccomp and AppArmor profiles block.

`tools/linux-test/linux-test.sh <git ref> [package...]` runs packages this way in Docker, with those profiles off for the test container: it bundles the commit, clones it in the container and runs each package's own `bun run test` (set `TEST_FILES` to run only some files). GitHub Actions has no minutes on this account, so this is how Linux runs for now.

Columns: "On main" is `yes` when the test failed in that verification run on `origin/main`, and `intermittent` when it is a known failure that did not appear in that run because it depends on load or timing. A cause that says "not root-caused" records only the failing assertion; it is not shown to be specific to Windows.

## Gates

A gate is a test that pins a promise in `docs/untrusted-repositories.md`. A gate is never excused by this list, with one exception that is a limit of the machine and not of the code:

- The idle-egress tests (`packages/cli/test/egress.test.ts`) and the class 9 control-character tests (for example `packages/tui/test/component/dialog-flow-runs.test.tsx`) must pass when re-run alone. A timeout under load is re-run alone; it is not an accepted failure.
- The class 3 and 4 symlink tests (`grants both the written and real spelling of a symlinked root and drops links to cwd` in `packages/cli/test/acp/additional-directories.test.ts`, `FileSystem > canonicalizes local symlinked directories` in `packages/core/test/location-filesystem.test.ts`, and `real watchers observe atomic saves to nested, outside-root, and symlinked helpers` in `packages/tui/test/plugin-source.test.ts`) pass on Linux and on Windows with Developer Mode on. On unelevated Windows without Developer Mode `symlink()` fails with `EPERM` and they fail; that is a limit of the machine, not an accepted failure. They must pass on Linux, or on Windows with Developer Mode, before a milestone that touches path containment closes.
- The load-flake tests that guard trust (`LifecycleHooksPlugin under workspace trust` in `packages/core/test/plugin/lifecycle-hooks.test.ts`) are gates too: if one times out, re-run its file alone and it must pass.

## Fail every run

No row is left. Of the 24 rows that stood here until the ci-green task (PR #192), the 23 of CI's packages were fixed at
their cause, in the product or in the test, and "ci-green" at the end of this file names the cause, the commit and the
test for each; the merman row moved to the paragraph below.

merman is not run by CI: `.github/workflows/check.yml` has no merman job. Run by hand, its `audits deterministic
flowchart and state layout families` (`packages/merman/src/layout-audit.test.ts`) fails on Windows and on Linux: the
layout metric `bends.max` is 31 against a limit of 30 (round 7). A change to merman runs that package by hand.

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
| core | `Npm.add > installs a Git package from an npm ::path: subdirectory at a commit` and `... at a branch` (same file) | The real Git install exceeds the 5 second limit, and on this machine also when the file runs alone (M4 verification round 12, at `ad1a6425` and at its parent `70341594`); the file passes with `--timeout 60000` (16 pass). | intermittent |
| core | `Vcs > ignores stale, deleted, renamed, and self-mirroring creation hints` (`packages/core/test/vcs.test.ts`) | Git work exceeds the 5 second limit under load. | intermittent |
| core | `Vcs > uses an explicit diff base without treating upstream or Git config as a parent` (same file) | Same 5 second limit; passes at `--timeout 30000`. | intermittent |
| core | a worker that runs real directory watches, such as `packages/core/test/config/reload.test.ts`, crashes (`worker crashed: exit code 3`) | Windows only. A use-after-free in `@parcel/watcher` 2.5.1 (also in 2.6.0, the latest): its `unsubscribe()` frees a Windows watch while the watch's directory read is still queued, and the read's completion then runs on freed memory (parcel-bundler/watcher#262; the fix, parcel-bundler/watcher#277, is in no release). Seen in the parallel core 1/2 run of PR #189 at 8e79ffda (run 45011365879, segmentation fault at address 0x8) and once in 624 runs of `reload.test.ts` under load on Windows during m5-flakes (Bun 1.4.2, address 0x38, every frame of the report in `watcher.node`, `ntdll.dll` and `KERNELBASE.dll`). Orbit no longer ends a live watch while a server runs: a released one is kept and reused (`packages/core/src/filesystem/watcher.ts`, pinned by the "Watcher native directory watches" rows of `packages/core/test/filesystem/watcher.test.ts`). Two cases still end a live watch, because a live watch keeps the process from exiting: closing the native watcher layer (each test's runtime, and a server or SDK host shutting down) and a kept watch whose folder was moved. Counted over `reload`, `skill`, `location-layer` and `managed-settings` tests: 42 ends of a live watch before the change, all on release, and 37 after, 33 at a runtime's close and 4 for a folder no longer at its path. The tests close a runtime per test, so their exposure stays; drop this row when a release with #277 is installed. | CI only, intermittent |
| core | a long-lived worker crashes on Windows (`worker crashed: exit code 3`), seen in `packages/core/test/config/normalization.test.ts` | Bun itself, not the file: `panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF` (address 0xC8 in the third attempt) in a `--test-worker` that had run for about 379 s, with only `KERNEL32.DLL` and `ntdll.dll` in the visible frames; the file uses no watcher. Windows core 1/3 of run 45620627170 (PR #191 at 4bfd4e6f), jobs 139227484544, 139247116066 and 139250663422. Consistent with oven-sh/bun#41343 (the same address on Windows, Bun 1.4.1, open), not proven: the reports were not decoded. No Bun release names a fix (1.4.5 is current). The shard repeated 10 times on Windows at 9612b76f did not crash, and a re-run passes. A Linux SIGABRT in `permission-own-folders.test.ts` reported on the same PR was not found in that run's logs and did not recur in 10 Linux runs, so it has no row. | CI only, intermittent |
| core | `Vcs > creates detached worktrees without review metadata and requires an explicit base without a named hint` (same file) | Same 5 second limit. | intermittent |
| core | `Vcs > does not infer beyond the bounded creation-reflog window` (same file) | Same 5 second limit. | intermittent |
| core | `Formatter > does not cache a command resolved before reload` (`packages/core/test/formatter.test.ts`) | Hit the 5 second limit under load; passes when its file is re-run alone. | intermittent |
| core | `Git > fetches, checks out, and resets remote changes` (`packages/core/test/git.test.ts`) | Same 5 second limit. | intermittent |
| core | `LocationServiceMap > routes located events only to their location` (`packages/core/test/location-layer.test.ts`, line 351) | Same 5 second limit. | intermittent |
| core | `LocationServiceMap > isolates provider state by location` (same file, line 453) | Same 5 second limit. | intermittent |
| core | `LifecycleHooksPlugin under workspace trust > runs the user's hooks, and the project's and its other-product settings hooks only once trusted` (`packages/core/test/plugin/lifecycle-hooks.test.ts`) | Same 5 second limit. A trust gate: see Gates. | intermittent |
| cli | `acp lifecycle subprocess` tests (`packages/cli/test/acp/lifecycle.subprocess.test.ts`; for example `delete capability and delete request`, `close capability and close request`, `new session succeeds on the first request`) | A different one to three of the file's tests fail with `Timed out waiting for initialize response` in each run, and did so in two of two runs of the file alone while other agents were using the machine. Not root-caused. | intermittent |
| cli | `acp prompt content subprocess > accepts embedded text resource image and file resource link prompt content` (`packages/cli/test/acp/prompt-content.subprocess.test.ts`) | Fails with `Timed out waiting for initialize response`, a harness wait for the spawned process, under load. | intermittent |
| tui | (`packages/tui/test/session-home.test.tsx`) `Home loads a stable, bounded beginning (mixed)` | Timing flake. | intermittent |
| tui | (`packages/tui/test/status-line-app.test.tsx`) `the status line follows the selection, the session's location and its step events` | Windows, under load: Windows tui 2/2 of run 45807756983 (PR #193 at 2012257c, attempt 1) failed with `The line never matched (ran 2 times)` after the agent changed; attempt 2 passed, and so did the file alone on Windows (3 of 3 at the head, 3 of 3 at its base 4d82af81). The status line stops its command after 2 s (`TIMEOUT_MS` in `packages/tui/src/util/status-line.ts`), the row's command is a cold `bun` start, and a run the limit cuts is not run again until the next change or the 60 s interval; forcing the third run to take 2.5 s gives the same message. Not fixed: it needs a test command that always ends inside 2 s on a loaded runner, or a retry after a cut run. | intermittent |
| tui | (`packages/tui/test/cli/tui/dialog-open.test.tsx`) `does not show the previous project's worktrees while loading another project` | Linux, under load: the tui job of run 45807756983 (PR #193 at 2012257c, attempt 1) failed when its 10 s frame wait ended on a blank last frame (283 frames drawn, no cell updated, a render still scheduled); attempt 2 passed, and so did the file alone on Windows (3 of 3 at the head, 3 of 3 at its base 4d82af81). Not root-caused. | intermittent |
| util | (`packages/util/test/observability-otlp.test.ts`) `exports a span through the configured OTLP trace endpoint` | Hit its 5.16 s timeout under load. | intermittent |
| cli | the trust-gate control in `packages/cli/test/trust-doors.test.ts` that runs a node with a model (about line 324; `trust.test.ts` line 1146 until ci-speed split that file), and the YAML `permissions:auto` row of `packages/cli/test/flow.test.ts` | Seen in multi-file Linux runs with 8 workers; each passes alone. Likely cause, from the review that found it and not reproduced in round 6: Ollama discovery gives `/api/tags` and each `/api/show` 1 s, and one failed attempt is cached for 30 s, so a slow first answer leaves the run with no Ollama models and the node fails with "has no models here". It replaces the earlier inbox-delivery guess for the `permissions:auto` row. This is a product weakness (a retry soon after a failed first discovery would remove it), not a test fault. The trust row is a gate: it must pass when re-run alone. | intermittent |
| cli | `a resumed team reuses the turns that ran and continues from the failed one` (`packages/cli/test/flow-team.test.ts`, line 268) | Failed once with an assertion, not a timeout (the lead's turns ended in `lead#3`, expected `lead#2`) in the full parallel Linux cli run at `bcfcfd7` (M3 verification round 9); passes when its file runs alone (3 pass). Cause not established; follow-up FU-M3-421 in `docs/follow-ups.md`. | intermittent |

A timeout-only failure under load is a load flake: it passes when its file is re-run alone, and it needs no new row. The timeout may be the test's own (5 seconds in core, 30 seconds in cli and tui), the runner's, or a harness wait such as a spawned process that does not answer. The PR names the test and the file it re-ran alone. A gate (see Gates) must still pass when re-run alone. Any other failure is fixed, or added here with its reason.

## Round 6

Checked in M3 convergence round 6, on Windows (the Linux run of the same files is in the commit that made each change):

- `packages/core/test/browser-idle.test.ts` failed under load with `rpc.unavailable` because its 2 s idle time started before the location was built and attached. The time is now 5 s and the file passes; it has no row.
- `packages/simulation/test/simulated-provider.test.ts` `controls arbitrary tools through scoped SDK overlays` timed out every run because the registry asked Permission about the overlay tool and nobody answered. The test now replaces Permission with one that allows, and the file passes (7 of 7). Simulation has no failing rows.
- `packages/core/test/link-chain.test.ts` rows (the chain of 63 links included) had a 30 s limit that a parallel run could pass; they now have 90 s, and the bound on the lookup itself is 30 s, under the 45 to 60 s of the slow path it guards against.
- `packages/cli/test/flow.test.ts` `parallel agents run in separate worktrees and merge into the checkout` met a git `commondir` race between concurrent `git worktree add` calls. The adds of one repository now run one at a time (`packages/flow/src/git.ts`), pinned by `packages/flow/test/git.test.ts`; the flake needs no row.
- `packages/core/script/migration.ts` compared generated files byte for byte and reported a stale schema on a checkout with `core.autocrlf=true`; it now compares with line endings normalised.
- `packages/cli/test/config-overlay.test.ts` used the real per-user state folder; the cli test preload (`test/fixture/state-home.ts`, listed in `bunfig.toml`) now gives every test run a temporary one: it runs once in a serial run and once per test file in a parallel run, and an `afterAll` in the preload removes the folder (pinned by `packages/cli/test/state-home.test.ts`).

## Round 7

Every row's file was re-run alone at `4e29991`, on Windows (`bun test --timeout 60000 <file>`, core through `bun run test <file>`) and on Linux in Docker (`tools/linux-test/linux-test.sh`, `TEST_FILES` set), on 2026-10-14. A passing row is still listed: each is a load flake, which fails only in a busy parallel run, and "passes alone" is what its row already says.

- Still fail on Windows alone, rows kept as they are: the four `acp config option subprocess` tests; `client` `import-boundaries`, and the six `service`/`promise-service` tests; core `normalizes Git Bash shell paths from env`; merman `layout-audit` (`bends.max` over its limit); schema `contract-hygiene` and `v1-isolation`; sdk `transport` (two), `embedded` and `promise`; util `global`; the four vscode `endpoint` rows and the `runs` row.
- Pass on Linux: cli `config-options.subprocess`, client `import-boundaries`, `service` and `promise-service`, core `shell`, schema `contract-hygiene` and `v1-isolation`, util `global`, vscode `endpoint` and `runs`. All but one depend on the Windows host; client `import-boundaries` depends on the install instead: it fails under the hoisted install (`--linker hoisted`) that the Windows machines use, and the Linux runs use an isolated one.
- Fail on Linux too, so they are not Windows-specific: the four sdk rows (`transport` two, `embedded`, `promise`).
- Pass alone on both systems (and in the parallel runs below), confirming the load-flake rows: cli `egress` (both gates), `flow`, `standalone`, `acp/lifecycle.subprocess`, `service`, `acp/prompt-content.subprocess` and `trust`; core `npm`, `vcs`, `supervisor-reload`, `formatter`, `git`, `location-layer` and `lifecycle-hooks`; server `worktree`; tui `session-home`; util `observability-otlp`. The `supervisor-reload` row (it failed alone in 2 of 3 runs before) passed on its single run here, so its "does not always pass alone" note stands unchanged.
- merman `layout-audit` also fails on Linux (`linux-test.sh <ref> merman`: 503 pass, 1 fail), so that row is not Windows-specific.
- Parallel run, 2026-10-14 (`bun run test`; the whole package for client, schema, sdk, util, vscode and merman; the row files together for core, cli, server and tui, because a whole run of those takes too long here). Windows gave the same failures as the alone runs for every package with a failing row: client 7, schema 2, sdk 4, util 1, vscode 5 (including the `afterAll`), merman 1, core `shell` 1, cli the four `config-options` tests; server `worktree` and tui `session-home` passed. Linux gave 0 failures for client, schema, util, vscode, server, tui, and the core and cli row files; sdk failed the same 4 and merman the same 1. One timeout was new in the core parallel run, `Npm.add > installs a Git package from an npm ::path: subdirectory at a commit` (5 s limit); `npm.test.ts` passed alone (16 of 16), so it is the same load flake as the other `Npm.add` rows.
- The cli `state-home.test.ts` added in this round passes on both.
- 2026-10-19 (M4 verification round 2): the two sdk `transport` rows are removed. The embedded `sessions.get` now gives the protocol's `SessionNotFoundError`, as the HTTP client does (FU-M1-041, f86239e0), and both rows pass on Windows. The sdk `embedded` (web search) and `promise` (stream cancellation) rows are separate and stay; so the older lines above that count four sdk failures describe the state before this change.

## ci-green

The ci-green task (PR #192, 2026-11-25) removed every row of "Fail every run". Each row's cause, the commit that fixed
it and the test that shows it, on the platform where it failed (Windows CI or a local Windows run; Linux CI):

- cli, the four `acp config option subprocess` rows: before trust-first, config discovery walked from the session's
  folder up to the drive root, and the fixture's temporary folder sits under the developer's real home, so sources in
  that home (other products' dot folders) were read as project sources and the session came up on the host's model.
  Fixed by `b555a280` (trust-first part 2, owner decision D7: nothing above the project is read). The rows pass on
  Windows CI and locally, and `packages/core/test/config/above-project.test.ts` "config above the project" pins the
  walk.
- client `import-boundaries.test.ts`: it read `packages/client/node_modules/effect`, which the hoisted install does not
  create. It resolves `effect` from the package now (`faed67b3`).
- client, the six `service`/`promise-service` replacement and signal rows: on Windows a kill from another process is
  TerminateProcess, so the fixture's SIGTERM handler never runs and the process ends with status 1. The fixture names
  what each platform gives when the client stops a service (`faed67b3`); every row still checks that the client stopped
  it.
- core `shell > normalizes Git Bash shell paths from env`: the row hard-coded a Git under `C:\Program Files`, and the
  product found no Git Bash at all when started from Git Bash, which puts its toolchain's `git` (`ucrt64\bin` on the
  runner, `mingw64\bin` before) first on `PATH`. The lookup now looks one folder higher from a toolchain's copy
  (`accab30c`, `86f1374e`), and the row builds its path from the machine's own Git Bash. "finds Git Bash from each folder
  Git for Windows keeps git.exe in" pins every layout (`7f5447e4`).
- core `ManagedSettings.read unreadable input`, the access-list row, which failed on the GitHub Windows runner only:
  the runner's account read a file that its access list denied. Run 45631647500 showed why: that account has the
  backup privilege enabled, which opens a file past its access list, while a second PowerShell that opened the file
  without backup semantics was refused by the same deny. The read also got past a handle held with no sharing, which
  binds on the development machine; how is not established, and the row no longer depends on it. A byte-range lock is
  checked on every read whatever the account, so the row's helper (PowerShell by its System32 path, class 10) now locks
  the whole file and stops at a failed open (`f402602f`, `55c66536`, `8af42120`). The row, "reports a file this account
  cannot read instead of treating it as missing", checks that the lock alone fails a plain read, then denies read to
  Everyone (icacls by its System32 path) and expects the open to be refused, or, for an account with the backup
  privilege, the read to meet the lock, before the product reads. It passes on the development machine and on the
  GitHub runner (run 45636655891).
- schema `contract-hygiene` and `v1-isolation`: `URL.pathname` is `/D:/...` on Windows. They scan
  `path.join(import.meta.dir, "../src")` and first check that the scan found the source (`33250350`).
- sdk `embedded client exposes plugin-backed web search`: the web search routes answered the request that boots a
  Location before its plugins were active. They, and `model.list` and `model.default`, now wait for activation
  (`a7c07d1d`), pinned by the four "the first request to a fresh Location" rows (`2c169526`, `8dc2bed9`); the row reads
  its config from the fixture's folder. Fix loop 1 closes the rest of that class: every route that reads what a plugin
  adds waits too (`provider.list` and `.get`, `agent.get`, `integration.get`, `.connect.key`, `.oauth.connect`,
  `.oauth.status`, `.oauth.complete`, `.command.connect` and `.command.status`, `mcp.list`, `.connect`, `.disconnect`
  and `.remove`, `reference.list`, and `vcs.get`, `.base`, `.status`, `.branch.list` and `.diff`), each with its own
  "the first request to a fresh Location" row and control. Routes that read nothing a plugin adds, or already wait, are
  listed in the PR.
- sdk `Promise event streams support cancellation`: the row expected a Transport error, but an aborted subscriber of the
  shared event stream ends with `done`, as the client's tests pin. The row expects that now (`c89e1f09`).
- util `global > building a layer with default tmp ...`: `os.tmpdir()` reads `TEMP` and `TMP` on Windows, not `TMPDIR`.
  The child gets all three (`33250350`).
- vscode, the `endpoint` and `runs` rows and the `afterAll` hook: on Windows the extension starts only a `.exe` or `.com`
  (class 10), and the stand-in `orb` was a shell script. A shared fixture compiles it into `orb.exe` there, and the hook
  stops the service through the extension's lookup before it removes the folder (`8c4da141`, `295b6165`).
- merman `layout-audit`: not run by CI; see "Fail every run".
