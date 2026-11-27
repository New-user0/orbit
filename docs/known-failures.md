# Known test failures on Windows

This is the list of tests that fail, or fail under load, on the Windows development machine for a reason that has nothing to do with the change under test. CI must be green: every job of `.github/workflows/check.yml` passes on its first attempt, on every run. The owner, 2026-11-27: "No alone pass is fine but ci needs to be green always fix this". A test that fails under load is fixed at its cause in the PR that meets it, and is never listed here; passing when its file is re-run alone, or when the job runs again, is not a fix (AGENTS.md, Testing). Compare a package's other failures with this list before you decide a run is red.

Rows were last checked package by package at commit `b79898f` (with `origin/main` at `a0a4222` merged in), before M3. Round 7 then re-ran the file of every row alone, on Windows and in Linux Docker, at `4e29991`; see "Round 7" at the end of this file for what each row did. Round 7 also ran each row's file in the package's parallel run (see "Round 7"). `bun run test` in core, cli, tui, server and vscode runs files in parallel worker processes; `ORBIT_TEST_WORKERS=1` runs one after the other. Until ci-always-green a file that timed out under that load was re-run alone with `bun test --timeout 60000 <file>` (in core, `bun run test <file>`) to tell load from a defect; that run tells where to look, and the failure is then fixed at its cause. M3 round 2 re-ran the three symlink gates on Windows with Developer Mode on and on Linux in Docker: all three pass, so they no longer have a row under "Fail every run". All 22 packages that have a `test` script were run, one at a time, with `bun run test` from their directories: cli, core, tui, client, schema, sdk, util, vscode, merman, ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, server, simulation and theme. A package with a row below fails those tests and nothing else; ai, codemode, compat, flow, http-recorder, httpapi-codegen, latex, plugin, plugin-browser, protocol, simulation and theme had no failures, so a failure in one of them is new, not missing from this list. The cli run needs about 40 minutes on a loaded machine (the first run, with a 25 minute limit, was cut off).

How to start a run: use Git Bash for `packages/core`, `packages/sdk` and `packages/cli`, with Git's `usr\bin` ahead of System32 on `PATH` (Git Bash does that). From PowerShell a bare `bash` resolves to the WSL launcher in System32, which prints `execvpe(/bin/bash) failed`, and `echo` and `sleep` are missing; that made core fail about 258 tests instead of 5 (the real-shell rows in `shell-scan/bash-safety.test.ts`, the shell tool, command subagents, `cross-spawn-spawner` and `persistent-pty-daemon`), and the sdk test `blocks the model-selected first tool on lazy provisioning` times out with 'first tool did not provision' for another reason: with `SHELL` unset, as in PowerShell, Orbit's session shell on Windows is PowerShell, so the shell tool is offered as PowerShell while the test's model asks for Bash. Git Bash exports `SHELL`, which is why it passes there. The cli package needs Git Bash as well, because its `mini-config` tests call `mktemp -d`. Of the other packages, only `packages/sdk` differs between the two shells (the test above); the rest give the same result from both. Core clears `SHELL` in `packages/core/test/preload.ts` on win32, so Git Bash's `SHELL=/bin/bash.exe` does not change a result.

On Linux, as CI's ubuntu job or a local container runs the packages, the tests need these on PATH as a person who is not root, because root ignores file permissions:
- `git`, `ripgrep`, `pgrep` (procps), `bubblewrap` and `socat`;
- Node.js 22.15 or later: the ESM reload tests in `packages/tui/test/plugin-source.test.ts` use `module.registerHooks`, and fail with Node 20.

The bubblewrap test in `packages/core/test/shell-sandbox.test.ts` also needs user namespaces, which Docker's default seccomp and AppArmor profiles block.

`tools/linux-test/linux-test.sh <git ref> [package...]` runs packages this way in Docker, with those profiles off for the test container: it bundles the commit, clones it in the container and runs each package's own `bun run test` (set `TEST_FILES` to run only some files). GitHub Actions has no minutes on this account, so this is how Linux runs for now.

Columns: "On main" is `yes` when the test failed in that verification run on `origin/main`, and `intermittent` when it is a known failure that did not appear in that run because it depends on load or timing. A cause that says "not root-caused" records only the failing assertion; it is not shown to be specific to Windows.

## Gates

A gate is a test that pins a promise in `docs/untrusted-repositories.md`. A gate is never excused by this list, with one exception that is a limit of the machine and not of the code (the symlink tests below):

- The idle-egress tests (`packages/cli/test/egress.test.ts`) and the class 9 control-character tests (for example `packages/tui/test/component/dialog-flow-runs.test.tsx`) pass in every CI run. A timeout under load is a defect, fixed at its cause without slowing, skipping or loosening the gate.
- The class 3 and 4 symlink tests (`grants both the written and real spelling of a symlinked root and drops links to cwd` in `packages/cli/test/acp/additional-directories.test.ts`, `FileSystem > canonicalizes local symlinked directories` in `packages/core/test/location-filesystem.test.ts`, and `real watchers observe atomic saves to nested, outside-root, and symlinked helpers` in `packages/tui/test/plugin-source.test.ts`) pass on Linux and on Windows with Developer Mode on. On unelevated Windows without Developer Mode `symlink()` fails with `EPERM` and they fail; that is a limit of the machine, not an accepted failure. They must pass on Linux, or on Windows with Developer Mode, before a milestone that touches path containment closes.
- The tests that guard trust (for example `LifecycleHooksPlugin under workspace trust` in `packages/core/test/plugin/lifecycle-hooks.test.ts` and the controls of `packages/cli/test/trust-doors.test.ts`) are gates too and pass in every CI run.

## Fail every run

No row is left. Of the 24 rows that stood here until the ci-green task (PR #192), the 23 of CI's packages were fixed at
their cause, in the product or in the test, and "ci-green" at the end of this file names the cause, the commit and the
test for each; the merman row moved to the paragraph below.

merman is not run by CI: `.github/workflows/check.yml` has no merman job. Run by hand, its `audits deterministic
flowchart and state layout families` (`packages/merman/src/layout-audit.test.ts`) fails on Windows and on Linux: the
layout metric `bends.max` is 31 against a limit of 30 (round 7). A change to merman runs that package by hand.

## Flaky, depend on load

No row. CI must be green on every run (the owner, 2026-11-27: "No alone pass is fine but ci needs to be green always
fix this"), so a test that fails under load is fixed at its cause and never listed here. The rows that stood here until
the ci-always-green task are in "ci-always-green" at the end of this file, each with its cause, its fix and the test
that shows it.

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

## ci-always-green

The ci-always-green task (2026-11-27, on the owner's word "No alone pass is fine but ci needs to be green always fix
this") removed every row of "Flaky, depend on load". Each row, grouped by cause, with its fix and the test that shows
it:

- core, the native watcher crash (`worker crashed: exit code 3` in files with real directory watches, FU-M5-022):
  ending a live Windows directory watch while its read is queued meets parcel-bundler/watcher#262, and the tests ended
  them all the time. Every row runs with the memo map of `packages/core/test/fixture/native-watcher.ts`
  (`packages/core/test/lib/effect.ts`), whose one entry is the native watcher layer built once for the file, so a
  runtime that closes parks its watches for the next one ("in a test process the native watches outlive each runtime:
  a closed one ends none, the next reuses it", `packages/core/test/filesystem/watcher.test.ts`). That pool is never
  closed ("a test file ends none of its native watches, also after its last row"). A watch a finished file leaves open
  keeps a callback of that file's global, so the rows watch only folders that no later file touches: each test file
  has a config folder of its own ("gives each test file a config folder of its own",
  `packages/core/test/preload.test.ts`), and `config/reload.test.ts` copies its skill sources into the row's folder.
  The product no longer ends a parked watch whose folder was moved, replaced or cannot be read, which
  `config/reload.test.ts` met four times a run: it is retired until the native layer closes, and the next watch of the
  folder gets a native watch of its own ("on Windows a parked watch whose folder was moved away is not reused and not
  ended", "on Windows every later watch of a folder with a retired watch is set apart from it"). A pass over the core
  files that watch folders on Windows, with every unsubscribe of the binding logged, ended 12 watches that had a read
  queued before these changes (at a file's end: the worker's config folder in `mcp`, `session-prompt` and
  `node-build`, and the two skill folders of the checkout in `config/reload`; during rows: the four replaced roots of
  `config/reload`) and none after. FU-M5-022 keeps only the close of the native layer as a server or an SDK host
  shuts down.
- cli, the trust-doors control that runs a node with a model and the YAML `permissions:auto` row of `flow.test.ts`: a
  first Ollama `/api/tags` read that ran past its 1 s limit was kept as a fresh answer for 30 s and not tried again
  before the interval (FU-M3-385). A read that fails, times out or is interrupted now leaves the cache as it was, and
  while the plugin has no models a failed read is tried again after 1 s, doubling up to the interval, pinned by the rows
  of `packages/core/test/plugin/provider-ollama.test.ts` that name the retry, one for each way a read fails (a refused
  connection, a body that is not JSON, a body of the wrong shape, a 503 and a read that runs out of time).
- core `Npm.add` rows (`npm.test.ts`): the workers shared npm's cache (the runner's `%LOCALAPPDATA%\npm-cache` on
  Windows, the shared root's `~/.npm` on Linux), and a Git install cloned into it (run 45898058796). Each worker has its
  own now, pinned by "gives each worker an npm cache of its own" (`packages/core/test/preload.test.ts`).
- tui `/compact with text ...` (`compact-admission.test.tsx`) and the rows that ran out at the timed waits' 10 s
  default: the waits gave up before their row's own 30 s limit. Both now last as long as the row, pinned by "the wait
  for a compaction request is not cut short before the row's own limit" (`compact-admission.test.tsx`) and "a wait that
  names no limit keeps looking for as long as its row may run" (`packages/tui/test/fixture/render.test.tsx`).
- cli `import-export`, `session-list`, `auth`, `mini`, `argv`, `mcp-auth-choices`, `acp/command`, `debug-config` and
  `debug-paths`: their `orb` children took the parent's environment, so they shared the runner's own data, config and
  state folders, and held no start slot. They start through `packages/cli/test/fixture/orb.ts` now, which applies
  `isolatedEnv` and the start gate, and `child-starts.test.ts` 'no cli test starts a child with the parent's
  environment and a few overrides' fails on that shape. The children of the other cli files that start `orb` with an
  environment of their own (`isolatedEnv`, `serviceEnv` and the like) but no start slot are left out of the gate: in
  run 46021659425 the slowest row of each such file took less than half its limit on both platforms, apart from rows
  whose time is mostly a fixed wait of their own (the `config-overlay-flags` and `managed-bypass` root runs that
  wait out 60 s).
- core, the rows at Bun's 5 s default that start real processes (`npm.test.ts`, `vcs.test.ts`, `git.test.ts`,
  `session-context-vcs.test.ts`, `session-context-usage.test.ts`, `project.test.ts`, `lsp-ignored.test.ts`,
  `session-rehydration.test.ts`, `tool-lsp.test.ts`, `tool-search.test.ts`, `formatter.test.ts`, `location-layer.test.ts`,
  `lsp-reminder.test.ts`, `edit-link.test.ts`, `mcp.test.ts` and `LifecycleHooksPlugin under workspace trust` in
  `plugin/lifecycle-hooks.test.ts`, a trust gate), and the server rows of the same kind: on a loaded Windows runner
  their git, language-server, MCP, shell and npm children passed 5 s. Each row whose worst time passed half its limit,
  in the JUnit report of run 45919528051 (every core and server job, Windows and Linux), in loaded runs on the
  development machine (4 cores, 2 workers, coverage) and in the ci-measure run 45943098053 (every Windows core shard,
  server and flow, 50 runs of each row on a real runner), now has a measured limit: twice that worst time, rounded up
  to a whole 5 s. A row that timed out at 5 s in those 50 runs has twice its p95 plus the longest stall the run showed
  in any row (7.2 s), rounded up. No limit was lowered and no assertion changed. The config-trust rows (FU-M3-387) took
  at most 1.6 s, so they keep 5 s.
- core `falls back to local logging when OTLP initialization fails` (`effect/observability.test.ts`): its child had a
  cache folder of its own and transpiled Effect from nothing on every run (0.4 s alone, over 5 s on a loaded runner). It
  shares the run's transpiler cache now, as every `bun` child of a core worker does (`packages/core/test/preload.ts`
  sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH`), and the row checks that its own cache folder holds none. The same cause
  timed out a shell-parser child of `shell-parse-compatibility.test.ts` (0.4 s, past 5 s in run 45924043976, attempt 2).
- core, rows of both workers that stalled at the same moment on Windows, among them the class 3 and 4 gate
  'decides every spelling as the project's own name, and follows a repository link below it'
  (`file-access-spelling.test.ts`) and `config/agent.test.ts` 'loads Markdown separate legacy variant', which timed out
  together in run 45933441327 though neither starts a decoy: every decoy program of `packages/core/test/fixture/decoy.ts`
  was a fresh build, a 110 MB copy of the Bun runtime, and the program lookup rows plant two or more per row. The
  ci-measure run 45940559989 traced each test and each pause of a worker's event loop beside typeperf samples: both
  workers' event loops stopped for 2 to 10 s at the same second while the processor was mostly idle and hard page
  faults ran at 10,000 a second (median 9), and the rows that plant decoys took 21% of those seconds and 4% of the run.
  A run of the test runner now keeps one build in its `ORBIT_TEST_PROGRAMS` folder and links every decoy to it, pinned
  by `packages/core/test/decoy-build.test.ts`. Pauses of 1.5 s and more that met a pause of the other worker: 17 in the
  150 Windows core runs of the base and 8 in 39 runs of the branch before the change (runs 45943098053 and
  45940559989), none in the 150 runs after it.
- vscode, the two rows of FU-M4-226: `ide-bridge.test.ts` 'sends a cleared selection when no file editor remains'
  connected while its first selection's 20 ms flush was pending (1 of 400 repeats failed; 0 of 400 after the row waits
  out the flush), and `controller.test.ts` dropped its first prompt when the cold server's first trust read outlasted
  the controller's 2 s limit, which then handed the scripted Write call to the next row. The file waits for the
  server's trust answer before its rows, and its model answers by what the prompt asks.
- core, the rows that timed out at 5 s in the Windows core 1/3 runs of ci-measure run 45955987228 although they
  took at most 2.4 s in the 50 runs before (SessionRetention 'home: a document that does not parse skips the pass',
  `edit-link.test.ts` 'ask for its absolute spelling: Patch update through a folder link, in an untrusted folder' and
  the `Lsp.ignored` gitlink row of `git-gitlink.test.ts`): the runner's system disk stopped. The typeperf logs of the
  103 traced Windows jobs (about 181,000 seconds) show C:, where the runner's TEMP is and so every folder the tests
  made, holding queued requests and moving no byte for 305 seconds in all, 25 times for 3 s or more and at most 7 s,
  while D: never did. Each of these rows ran inside such a stall of 4 to 7 s, with the processor nearly idle, and so
  did 9 of the 16 other rows that timed out in those jobs. `check.yml` now keeps TEMP and TMP of the Windows test jobs
  in `D:\orbit-test-temp`, and keeps what the tests needed of the C: folder: D: makes 8.3 short names (fsutil turns
  them on, and the step fails if D: still makes none), the path holds no character that Markdown escapes (the ACP
  approval titles show a path as plain text only then, and `RUNNER_TEMP` is `D:\a\_temp`), Bun runs from a copy on D:
  (`retained-image.test.ts` hard-links the running image into a temp folder), and the sdk row 'the Effect SDK's
  sessions.create and sessions.move refuse an untrusted folder, however it is spelled' makes its folders in the home
  when the temp folder is not in it, for its `~` spelling (run 46006785063). The C: temp folder is named in
  `ORBIT_TEST_OTHER_VOLUME` for 'copies the output to the session's folder when the shell file is on another volume'
  (`tool-shell-output-cap.test.ts`), which needs a second volume. That folder also holds the class 3 and 4 rows that
  spell a path through the legacy junctions `Documents and Settings` and `Local Settings`, which lead only below a
  profile's `AppData\Local`: with TEMP on D: those spellings named nothing, and the rows dropped them without a skip
  (98 ACP approval rows of `acp/spelling-matrix-*` and `acp/permission-spellings`, and spellings inside the
  `file-access-spelling.test.ts` and `external-leads.test.ts` rows; run 46021659425). They make their folders through
  `packages/core/test/fixture/legacy-junction.ts` now, and a Windows row of each file fails when those spellings are
  missing ('the rows go through the Documents and Settings and Local Settings spellings of the workspace folder',
  'has the Documents and Settings and Local Settings spellings of the project to decide', and the `external-leads`
  row itself). The `file-access-spelling.test.ts` rows that use them have a measured limit of 20 s for the C: stall.
  The fourth row of that run, 'enters at most MAX_FOLDERS folders, however many empty ones a rules folder
  holds' (`config/instruction-rules.test.ts`), waited on the same disk while it made and removed 2,048 folders, and
  makes twice the cap in folders now (366c0b55).
- core `ShellTool timeouts` 'returns a command that exits as the deadline passes inline, with no notification and no
  marker' (`tool-shell.test.ts`, Windows core 3/3 of run 46017939770): the row held the call 1.5 s after the deadline
  and needed the command to end in that time, so a PowerShell that took longer to start found the command still
  running. The command now outlives its 200 ms deadline and the row holds the call until the job has ended, so the
  command always ends between its move and the call's look at it, however slow its shell is to start.
- cli `flow-team.test.ts` 'a resumed team reuses the turns that ran and continues from the failed one' (FU-M3-421,
  lead#3 for lead#2 once in a full parallel Linux cli run): not fixed, and FU-M3-421 stays open. Both suspects the
  register names were forced and ruled out: a resume through another spelling of the folder ('a team resumed through
  another spelling of its folder sends its lead no message of its own') and a process stopped during a lead turn ('a
  team resumed after its process stopped during a lead turn asks the lead once, with no recovered message'), each on
  Windows and on Linux. The row ran 131 times under load (115 on Linux, 16 on Windows) without a failure, and it
  prints every recorded request when a lead turn passes 2, so a recurrence names the extra message.
- util `observability-otlp.test.ts` 'exports a span through the configured OTLP trace endpoint': no cause in the code.
  The row starts no child and nothing in `packages/util` changed; it ran 50 times under load on Windows (4 CPUs,
  coverage on) with no failure, so the row is closed on that count.
- The rows of the side builders of this task (cli children through the start gate and measured limits, the TUI waits,
  the sdk first-request row) are named with their causes in their own commits on PR #195.

Bun 1.4.2's segfault of a long-lived Windows test worker (FU-M5-023) is fixed by the upgrade to Bun 1.4.5 (84e1f83a):
the decoded reports are a FinalizationRegistry cleanup of a finished file's global, which oven-sh/bun#44279 cancels from
Bun 1.4.3 on, and its reproduction crashed 10 of 10 runs on 1.4.2 and none of 10 on 1.4.5. Every ci-measure count in
this section was taken on 1.4.2.
