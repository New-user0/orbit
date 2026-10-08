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
- Traits resolve at two points. `Snapshot.traits`, which `Prepared.toolTraits` binds to the request's advertised definitions, resolves before any hook runs, on the input the model sent, so it can order work. `Tool.Context.traits` is resolved by `runtime.execute` after the hooks, on the decoded input of the tool that actually runs, and is what the tool receives. No permission code reads it yet (task `permissions-16` will), and no hook payload carries traits. Code Mode inner calls take the second path through the same `executeTool`, so each carries its own tool's traits. What does not depend on the call comes from `Snapshot.describe` (`Prepared.describeTool`).
- Resolution never fails, and it fails closed. A predicate that throws, fails, dies or answers with anything but a boolean is logged and the call takes `ToolTraits.conservativeFor` its tool: the conservative answers wherever a trait depends on the call, and what the tool declares about itself (`openWorld`, `cancelSiblingsOnFailure`, `maxResultChars` and the rest) unchanged. A call that no tool stands behind, one that is unknown or was not offered in the request, takes the frozen `ToolTraits.conservative`. Input that the schema rejects resolves like a broken predicate without a log line, because `execute` reports it, and a schema that throws is logged. Interrupts are not caught. Do not add a path that reads an unresolved trait as read-only or concurrency-safe, or that drops a declared caution because a predicate broke.
- A plugin door that converts `traits` before it registers them, as the Promise adapter does in `effectTraits`, hands anything that is not an object to the registry as it is. The registry check is the one place that refuses it, so a malformed declaration costs one log line and the tools beside it still register. Do not destructure or spread `traits` ahead of that check, and run the invalid-traits table (`invalidTraits` in `test/lib/tool.ts`) through any new door.
- Only `readOnly` may relax a permission decision, and only when Orbit or plugin code declares it. MCP annotations never set it, and `destructive` and `openWorld` are advisory.

## Exposure

Whether the model gets a tool in the request or finds it through Code Mode is `Tool.Options.codemode`, and `ToolTraits.exposure` is the only Core code that reads it: the snapshot's split into advertised tools and the Code Mode inventory, and the reserved `execute` name at registration, both ask it. `pinned` (a deferred tool that the inline catalog always lists) is read only by `ToolTraits.pinned`, which the catalog asks. There is no `defer` or `alwaysLoad` field: `codemode: false` is always loaded, leaving it out is deferred, and `pinned` is deferred but always listed. `schema/src/tool.ts` documents the mapping. A tool is `direct` only when `codemode` is exactly `false`, and a plugin that hands over anything else gets `deferred`, as before. Anything that changes where tools go, such as deferring tools until the model asks for them, changes the resolver and leaves the registrations alone. `protocol/src/simulation.ts` checks the same field on simulated registrations for the reserved name; Protocol cannot import Core, so keep the two readings the same.

A tool's `traits.searchHint` goes to Code Mode with the tool (`runtime()` in `codemode/tool.ts`), where a match in it counts in `search` for less than a match in the tool's path and for more than one in its description. It ranks and nothing else: the catalog and the search results do not carry it.

## Permissions

The registry has no `Permission.Service` dependency and performs no execution authorization. Registration options may attach a permission action solely to preserve whole-tool definition filtering. Most registrations default to their effective name; `edit`, `write`, and `patch` use the shared `edit` action.

Tool filtering is catalog visibility, not execution authorization. A call still executes the captured tool's leaf policy if it reaches execution.

## Output

Built-ins return complete tool responses. `Tool.Snapshot.execute` is the local execution boundary. Generic output bounding is applied by the Session runner after execution.

Producer capture remains local to producers. Shell stores combined process output in its backing file and returns a bounded tail with the full-output path when truncated.

## Current Gaps

- Future Session-scoped registrations still need an explicit canonical registration design.
- `Snapshot.traits` runs before the `execute.before` hooks. A hook that turns a read-only call into a mutating one is seen only in `Tool.Context.traits`, not in the answer that orders work.
- A trait predicate that never answers holds its call, because resolution has no time limit.
