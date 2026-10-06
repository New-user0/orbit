- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit generated client files directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk` composes Client, Core, and Server.
- Current implementation changes belong in `packages/core`, `packages/cli`, `packages/server`, `packages/protocol`, `packages/schema`, and related generated client surfaces when required.
- This repository does not use Changesets. Do not add `.changeset` files; follow the existing release workflow instead.
- Base new branches, worktrees and pull requests on the repository's default branch unless the requester names another.
- Run `bun tools/rebrand/rebrand.ts --check` before committing; the upstream product name must not appear anywhere except `THIRD_PARTY_NOTICES.txt`. After merging upstream changes, run it with `--apply` first.
- Run `bun tools/rebrand/vendor.ts --check` before committing too. Other agent products' names, directories, instruction files and variables belong only in `packages/compat`, and model vendors' names only in provider adapter code. Fix a hit by rewording it or moving it there. Add an entry to the allowlist in `tools/rebrand/vendor.ts`, with a reason, only when neither fits.
- Orbit makes no network calls other than to model providers, MCP servers and integrations the user configured. Do not add telemetry, update checks, hosted catalogs or default-on remote services.

## Live V2 TUI Testing

- Run `bun run dev:live` from a development worktree to test its TUI against the currently elected `orb` background server and live sessions.
- Pass a directory after the script when needed, for example `bun run dev:live /path/to/project`.
- The script discovers the server with `orb service status`, injects its private local credential from `orb service get password`, and uses the `dev` TUI storage channel so tabs and other client-local state match the installed client.
- Prefer `dev:live` over plain `bun run dev` for this workflow. An implicit managed-service connection may replace the live server when the worktree client version differs; explicit `--server` warns and continues without replacing it.

## V2 TUI Stories

- When a user asks for a TUI story, add a fixture-driven story under `packages/tui/src/feature-plugins/system/storybook` and register it in `index.tsx`.
- Render the real production component rather than a visual copy. Keep submissions and other side effects local to the story so it is safe to explore repeatedly.
- Expose the meaningful state dimensions through story keybindings and list them in `StoryFooter`; include a reset command when combinations can leave the fixture in a confusing state.
- Run a specific story with `ORBIT_STORY=<story-id> bun run dev:live` from the development worktree, and exercise narrow and wide terminal sizes when layout is relevant.

## TUI Theme Tokens

- Choose theme tokens by semantic role, not by their current color. Do not use raw `theme.hue` values or borrow an unrelated semantic token to achieve a preferred appearance.
- Use `text.feedback` and `background.feedback` only for outcome or status feedback such as errors, warnings, success messages, and informational messages. Use `formfield` states for form-control text, ordinals, and selection markers, and `action` states for actions.
- If the theme does not expose a token for the required semantic role, extend the theme schema, defaults, resolution, and types with that role before using it in a component. Do not repurpose the nearest-looking existing token.
- When changing the public theme token surface, verify the built-in light and dark defaults and the custom-theme fallback path in addition to the affected TUI component.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `orbit`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use type-position `import("...")` references such as `Schema.declare<import("@orbit/plugin/effect/plugin").Plugin["effect"]>`. Only when two imports genuinely collide on a name and no other option exists, an aliased type import (`import type { Plugin as PluginDefinition } from "..."`) is permitted as a last resort — still strongly preferred not to.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@orbit/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Untrusted Repositories

A cloned repository chooses every file in its folder, and Orbit starts there before anyone has decided anything, so treat what a folder supplies as hostile until `ProjectTrust` says that folder is trusted.

- Before writing a loader (anything that reads, imports, evaluates or spawns what the folder supplies), list its surface in the header of `packages/core/src/config/trust.ts` and gate it on "this folder is trusted" in the process that does the work (`ProjectTrust.trusted()` in the server, `requireTrust` in a command, `trust.startup` in the TUI) before the first read, import or spawn; never on "something is held back".
- Classify every new config, agent or command field in `ConfigTrust.classification`; a field that selects which rules, agent, mode, model or provider apply is a permission, so an untrusted folder gets deny rules only and cannot name an agent.
- Treat a repository data file that reaches a shell, an approval or an agent choice as code: list it with a reader that shares the runner's validator (`workflowCommands`, `workflowApprovals`, `workflowAgents` in `packages/flow/src/load.ts`), gate on that list, and test that gate and runner agree.
- Parse Markdown front matter only through `ConfigMarkdown`, whose evaluating engines are disabled; never call gray-matter or another parser that can evaluate content, and test every spelling with a marker file.
- Decide trust for one resolved folder and pass that same value through ask, display, grant and act; where two components resolve a root differently (server and TUI, cwd and file, link and real path, `.git` file and worktree list), the stricter answer wins.
- Judge containment by real path at the moment of reading, with `FSUtil.contains` and `ProjectTrust.reachable`, `supplies` or `escapes`, never by name or string comparison; cover dangling links, targets that do not exist yet, UNC paths and Windows case.
- Treat a name, ID or ref read from a file the clone ships (run store, config, workflow) as hostile: validate its exact shape where it enters, and never join it into a path, git ref, glob or session title before that.
- Ask permission for every hop of a request a repository or script can influence (`PermissionWeb.request`), pass `AddressGuard.check`, and connect to the address that was checked with the name only in `Host` and SNI; refuse a name that resolves to nothing, fails to resolve or answers with names.
- Give every gate and decoder an explicit result for error, unknown input, old server, timeout and a malformed sibling: refuse with one log line, and let one bad entry cost only itself (`HookConfig.decode` decodes entry by entry).
- Pass every string from a file, run store, workflow or session that reaches a person through `plain`, `progress`, `json` (`@orbit/flow/plain`) or `terminalTitle` at the sink, and escape text that is stored at write time.
- Assume the compiled binary starts in an untrusted repository before any trust check: keep the autoload options in `packages/cli/script/autoload.ts` off except `autoloadPackageJson`, never load a package or look up an executable by name in the folder (on Windows the npm `which` package searches it before `PATH`), and close what a dependency leaves to the runtime in `packages/cli/script/runtime-requires.ts`.
- Route every entry point that can start work (each command, subprocess, TUI plugin loader, editor button and SDK host) through the same gate, because a gate in the server does not reach the CLI or the TUI process, and carry each refusal and decline to every client (TUI, JSON, ACP, SDK) as a typed error with a time limit.
- Make every test fail on the pre-fix code: write each attack as a marker file with a trusted control run, record the mutation in the PR, and run the tests that skip on your platform (real symlinks, POSIX hooks) elsewhere before closing.
- Write docs, schema descriptions, comments and the PR body last, from the final tree, claim only what a named test pins, and add a `docs/upgrading.md` note for every visible behavior change.
- When a review finds one hole, list its class from `docs/untrusted-repositories.md` (surfaces, sinks, spellings, entry points) and close every member in one commit with a table-driven test; a hole a clone can demonstrate on a default or reachable path is not a speculative edge case, so fix it in the PR that finds it and put speculative hardening on a follow-up list.

Walk the Review checklist in `docs/untrusted-repositories.md` before opening a PR that reads project files, runs commands, makes network requests, prints text from a file or changes the build; it holds the reasons, helpers, tests and review questions behind each rule.

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package directories such as `packages/core`.

## Checks

- Run `bun run check` from the repository root as the canonical full lint and type-check verification.
- During focused iteration, run `bun typecheck` from the affected package directory (for example, `packages/core`). Never run `tsc` directly.

## V2 Session Core

- Keep durable events minimal: record irreducible new facts and do not repeat state derivable by folding the ordered aggregate history. Enrich projections and read models with previous or derived state when consumers need self-contained views.
- Keep durable prompt admission separate from model execution. `Session.prompt(...)` publishes `session.inbox.enqueued`, whose projection inserts one durable `session_inbox` row, before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. Delivery publishes `session.inbox.delivered`; its projection consumes the inbox row and inserts the visible message in the same transaction. `session_inbox` stores only unconsumed work.
- Reusing a Session ID adopts the existing Session. Reusing a user or synthetic inbox item ID is idempotent when Session and type match: the first admission wins and the retried payload, metadata, and delivery mode are ignored, whether the item is still pending or already delivered (reconciled from the projected message without retained enqueue history). Cross-Session or cross-type reuse fails. Control items keep their operation-specific conflict behavior.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; interruption of a known but idle or locally unowned Session is a no-op, while the public API rejects an unknown Session.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per Physical Attempt and reload projected history before durable continuation. A logical Step may use generic pre-output retries, one full-context retry after continuation rejection, incomplete-stream continuation, or one overflow-compaction rebuild. Generic retries retain the logical step number and do not consume another agent-step allowance. Do not delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. A write-ahead execution claim marks a process-local busy period for restart recovery: terminal completion, failure, or user interruption releases it, while shutdown interruption and process death preserve it. Startup recovery resumes claimed top-level Sessions with durable per-execution attempt accounting. The claim is a recovery marker, not clustered ownership, fencing, or an exactly-once guarantee.
- Keep provider-specific native compaction mechanisms in `@orbit/ai` behind `LLMClient.compact`. `SessionCompaction` chooses a summary or native compaction from the model's `compaction` setting and owns route provenance, request shrinking, the retry policy, interruption, usage accounting, and checkpoint persistence.
- Keep delivery vocabulary explicit. Prompts steer by default. At safe step boundaries, steered compaction takes priority up to the first steered move control; other steers retain enqueue order. At an idle boundary, steers take priority; otherwise exactly one queued item delivers before the runner reevaluates continuation. Inbox items may be cancelled or changed between queue and steer before delivery. Promoting new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not write "provider turn", and do not use bare "turn" for a single call: "turn" is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Keep event replay ownership separate from clustered Session execution ownership.
- Keep the Instructions algebra and built-ins in `src/instructions`; keep instruction producers with their observed domains, and keep Session History selection plus `InstructionState` and `InstructionEntry` persistence Session-owned. `InstructionDiscovery` observes ambient global and upward-project instructions. The runner composes built-ins, discovery, guidance, and entries explicitly in `loadInstructions`; there is no instruction registry.
- `session.instructions.updated` stores changed source keys and content hashes and may freeze rendered chronological update text. Blob values live once in `instruction_blob`; the projected `instruction_state` row is the normal boundary-processing source of current and initial values. Request assembly renders the epoch baseline from stored values, while later frozen updates enter history as durable System messages. Completed compaction moves the instruction epoch; Session movement retains it so destination instruction changes are chronological, while committed revert clears it. Forks adopt the parent's newest instruction values even when copied message history ends at an earlier boundary. Unavailable sources retain the last value and block only the initial complete delta.
