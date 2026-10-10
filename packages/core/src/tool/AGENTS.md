# Core Tool Architecture

`src/tool.ts` owns the Location-scoped tool service, registrations, effective lookup, execution, and terminal outcomes. This folder contains its supporting runtime modules and built-in plugins.

## Representations

- Plugin authors get schema-derived input types at the `ToolEditor.add` boundary through `Tool`.
- The heterogeneous Core registry deliberately erases registered definitions to `Tool.Info`. Use `any` at this internal boundary; do not replace it with `unknown`, JSON-value plumbing, casts, or compiled wrapper types solely to preserve type safety after registration.
- Executors return model content and metadata alongside declared machine output. Shipped built-ins and plugin tools use the same runtime shape after registration.
- `src/tool.ts` stores canonical Location registrations, derives LLM definitions, executes tools, and normalizes model content and images.
- Built-in tool plugins live in `tool/plugin`.

Do not add a second executable entry type, registry-owned executor, authorization callback, output-path callback, or legacy normalization path.

## Construction

Tool schemas use `input` and `output` terminology. Each tool carries its name, options, schemas, and executable behavior in one object.

Location-scoped built-in layers acquire `Permission.Service` and every other required Location service while the layer is constructed. The executor captures those services. Permission sources are always constructed from the canonical invocation context:

```ts
const source = {
  type: "tool" as const,
  messageID: context.messageID,
  id: context.id,
}
```

Leaves own resolution, permission, and side-effect ordering. Translate only expected typed errors into `ToolFailure`; do not use `catchCause`, because interruption and defects must survive. User declines from `Permission.assert` and question dismissals travel as defects beneath leaf `mapError` blankets and resurface as typed failures at `SessionModelRequest.executeTool`; leaves must never catch or convert them. A decline with feedback (`Permission.CorrectedError`) stays typed so the leaf converts it into `ToolFailure` and the model continues.

## Registration

Built-ins, plugins, and MCP install tools through `Tool.Service.transform`, adding complete tool objects to the editor. A tool may provide a namespace, which flattens direct model names to `<namespace>_<tool>`, and defaults into CodeMode (`codemode` defaults true; `codemode: false` keeps the tool on the provider's native tool list).

Namespace descriptions are registered once through `editor.namespace(...)`. Tool options continue to reference the namespace by string name; an unregistered namespace remains valid and simply has no namespace description.

The service uses shared `State` to replay synchronous transforms in registration order against a fresh editor. `Tool.Service.reload()` rebuilds from captured source data without changing registration precedence. Registrations are scoped and return a real, idempotent `dispose` Effect:

- The latest valid active registration for the same effective name wins.
- `update` and `remove` target effective names and do nothing for missing tools. Updates preserve the name and namespace; invalid updates leave the previous definition intact. Creating a tool requires `add`.
- Disposing a registration or closing its scope removes only its transform and rebuilds from the remaining transforms, revealing any earlier definition it overrode.
- Each model request captures the effective definitions and executors it advertises; later reloads and disposal affect later snapshots. Captured executors may still reference mutable producer-owned state.

MCP owns one stable tool transform that reads its latest discovered tools. Tool-list changes update that source and reload the tool state instead of re-registering at the end of the transform order. MCP refresh therefore preserves the precedence of later plugin overrides.

Type safety ends at registration. The registry validates model input and declared output at runtime and should not carry producer schema generics through storage or execution.

`Tool.Service` is Location-scoped. Do not make the registry process-global or construct a separate application-tool service for each Location.

## Traits

`Tool.Info.traits` is what a tool declares about itself beyond its schemas. `schema/src/tool.ts` documents each field, the defaults and the conservative record; `tool/traits.ts` is the one module that decides how they resolve.

- Registration validates traits next to the definition (`ToolTraits.problem`). A tool with invalid traits is logged and skipped like any other invalid registration, an invalid update leaves the earlier definition in place, and the editor copies `traits` as it copies `options`.
- Traits resolve at two points. `Snapshot.traits`, which `Prepared.toolTraits` binds to the request's advertised definitions, resolves before any hook runs, on the input the model sent, so it can order work. `Tool.Context.traits` is resolved by `runtime.execute` after the hooks, on the decoded input of the tool that actually runs, and is what the tool receives. The registry gate does not read it (a `readOnly` tool that does not authorize itself is still asked about), and no hook payload carries traits. Code Mode inner calls take the second path through the same `executeTool`, so each carries its own tool's traits. What does not depend on the call comes from `Snapshot.describe` (`Prepared.describeTool`).
- Resolution never fails, and it fails closed. A predicate that throws, fails, dies or answers with anything but a boolean is logged and the call takes `ToolTraits.conservativeFor` its tool: the conservative answers wherever a trait depends on the call, and what the tool declares about itself (`openWorld`, `cancelSiblingsOnFailure`, `maxResultChars` and the rest) unchanged. A call that no tool stands behind, one that is unknown or was not offered in the request, takes the frozen `ToolTraits.conservative`. Input that the schema rejects resolves like a broken predicate without a log line, because `execute` reports it, and a schema that throws is logged. Interrupts are not caught. Do not add a path that reads an unresolved trait as read-only or concurrency-safe, or that drops a declared caution because a predicate broke.
- A plugin door that converts `traits` before it registers them, as the Promise adapter does in `effectTraits`, hands anything that is not an object to the registry as it is. The registry check is the one place that refuses it, so a malformed declaration costs one log line and the tools beside it still register. Do not destructure or spread `traits` ahead of that check, and run the invalid-traits table (`invalidTraits` in `test/lib/tool.ts`) through any new door.
- Only `readOnly` may relax a permission decision, and only when Orbit or plugin code declares it. MCP annotations never set it, and `destructive` and `openWorld` are advisory.

## Errors and validation

A failed call reaches the model and the clients as a `SessionError` whose `type` is the `code` of its `Tool.Error`. A failure without a code is `tool.execution`. `Tool.ErrorCode` in `schema/src/tool.ts` lists the codes that Orbit gives its own failures, and a plugin may use others. `toSessionError` is the one place where a code becomes a type: the code decides over the type of the `error` the failure wraps, so a coded failure that wraps a permission error is not reported as `permission.rejected`. Set a code where the failure is made, and never infer one from a message.

`Tool.Info.validate` refuses a call before the tool asks anyone about it. A call runs in this order: the `execute.before` hooks (`tool.ts`), the lookup of the tool (`tool.unknown`, `tool.unavailable`), decoding (`tool.input-invalid`), the traits, `validate`, then `execute`, where the tool asks for its own permissions.

- A failure of `validate` that carries a code keeps it. A `Tool.Error` without one, and a failure of any other kind, becomes `tool.validation`. A defect, a decline and an interrupt pass through as they do from `execute`, so a `validate` that dies fails the call and the tool does not run.
- `validate` must not ask for permission, change anything or read what nobody has approved. It holds no lock of its own, but `Edit` reads its file under the file's lock, so an earlier edit that is still formatting does not make the next one look stale. What it saw can still be out of date when `execute` runs: `execute` repeats every check it relies on, and is the one that decides.
- A `validate` that is not a function is refused at registration, with one log line, as invalid traits are; the Promise adapter hands anything that is not a function to the registry as it is.
- `Edit` is the first tool to use it. Its `validate` refuses identical strings and an empty `old_string`. For a file inside the Location (`FileAccess.resolve` reports no `externalDirectory`) it also refuses a file that the session has not read or that changed since, a file that does not exist, a directory, and an `old_string` that is not in the file exactly once (`replace_all` allows more). A file outside the Location is not read before `execute` has asked for `external_directory`, because nobody has approved reaching it. What `validate` cannot resolve or read for any other reason is left to `execute` to report. `execute` makes the same checks under the file's lock before it asks for `Edit`, for every file, so the person is never asked to approve an edit that cannot work.
- Because those content checks come before the `Edit` permission, a denied edit still answers "no match". The ledger limits what that gives away: `assertFresh` runs first, and it passes only for a file that the session has read or written, whose content the session has seen. A `validate` that reads a file must run `assertFresh` first, or stay out of the file.

## Exposure

Whether the model gets a tool in the request or finds it through Code Mode is `Tool.Options.codemode`, and `ToolTraits.exposure` is the only Core code that reads it: the snapshot's split into advertised tools and the Code Mode inventory, and the reserved `Execute` name at registration (its old spelling `execute` is refused too), both ask it. `pinned` (a deferred tool that the inline catalog always lists) is read only by `ToolTraits.pinned`, which the catalog asks. There is no `defer` or `alwaysLoad` field: `codemode: false` is always loaded, leaving it out is deferred, and `pinned` is deferred but always listed. `schema/src/tool.ts` documents the mapping. A tool is `direct` only when `codemode` is exactly `false`, and a plugin that hands over anything else gets `deferred`, as before. Anything that changes where tools go, such as deferring tools until the model asks for them, changes the resolver and leaves the registrations alone. `protocol/src/simulation.ts` checks the same field on simulated registrations for the reserved name; Protocol cannot import Core, so keep the two readings the same: both refuse `Execute` and `execute`.

A tool's `traits.searchHint` goes to Code Mode with the tool (`runtime()` in `codemode/tool.ts`), where a match in it counts in `search` for less than a match in the tool's path and for more than one in its description. It ranks and nothing else: the catalog and the search results do not carry it.

## Permissions

Tool filtering is catalog visibility, not execution authorization. `Tool.Options.permission` names the action that filtering and the registry gate use; most registrations default to their effective name, and `Edit`, `Write`, `Patch` and `NotebookEdit` use the shared `Edit` action. A tool registered under an old built-in name (`shell`, `write`) is registered under the current one and replaces that built-in; `effectiveName` in `tool/runtime.ts` does it.

The registry gate is the last step before `execute` (hooks, decode, traits, `validate`, gate, `execute`) and runs in `executeTool`, which every path shares: a model call, a Code Mode inner call, and through the session runner the SDK hosts and flow nodes. A tool that asks about its own calls sets `Tool.Options.authorizes` to `true`, or to a predicate on the decoded input that answers `true`; `ToolAuthorization.authorizesItself` resolves it and fails closed. A tool that leaves it out, or whose predicate throws, fails, dies or answers with anything but a boolean, is asked about by the registry: `permission.assert` on its permission action (or its effective name), resource `*`, saved as `*`. A refusal fails the call like a failure of `execute`, a correction reaches the model as the failure text, and a decline is a defect, as in a leaf. Only a tool that asks per resource in its own `execute` sets `authorizes: true`: `Read`, `Glob`, `Grep`, `LSP`, `Edit`, `Write`, `Patch`, `NotebookEdit`, `Bash`, `AskUserQuestion`, `Skill`, `Agent`, `Workflow`, `WebSearch`, `WebFetch`, the two `orbit` MCP resource tools, the MCP tools (they ask in `execute`; their annotations never change that) and `Execute` (Code Mode), whose inner calls are each gated by themselves and whose `fetch` asks per request. Every other built-in leaves it out and is asked about by the registry on its action or name, so ask and deny rules and any mode govern it: `Memory`, `EnterWorktree`, `ExitWorktree`, `orbit_session_rename`, `orbit_session_move`, `orbit_models`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TodoWrite`, `TaskOutput`, `TaskWatch`, `TaskStop`, `EnterPlanMode` and `ExitPlanMode`. Under the default `* * allow` they run unasked. A new built-in that does not ask per resource must not set `authorizes`; each suite of the tools above pins that with `expectRegistryAsks` (`test/lib/tool.ts`). A plugin that claims `authorizes` takes the decision on itself. `runtime.execute` takes the gate as a required parameter, so a new caller cannot run a tool unasked by leaving it out.

`Tool.CurrentCall` (`tool/current-call.ts`) is a `Context.Reference` holding `{tool, input}` of the call that is executing, set by `executeTool` around the gate and `execute` (a Code Mode inner call replaces the program's call for its own duration). `Permission` stores it on `Pending.call` when it creates a request and `Permission.callOf(id)` reads it, for the classifier and explain tasks. The input is as the registry received it, before the schema decoded it.

## Output

Built-ins return complete tool responses. `Tool.Snapshot.execute` is the local execution boundary. Generic output bounding is applied by the Session runner after execution.

Producer capture remains local to producers. Shell stores combined process output in its backing file and returns a bounded tail with the full-output path when truncated.

## Current Gaps

- Future Session-scoped registrations still need an explicit canonical registration design.
- `Snapshot.traits` runs before the `execute.before` hooks. A hook that turns a read-only call into a mutating one is seen only in `Tool.Context.traits`, not in the answer that orders work.
- A trait predicate that never answers holds its call, because resolution has no time limit. A `validate` that never answers does the same.
- Only `Edit` has a `validate`. `Write`, `Patch` and `NotebookEdit` report `file.unread` and `file.stale` from the ledger and `edit.stale` from the post-approval re-check inside `execute`, and their other failures carry no code yet.
