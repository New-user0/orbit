# Orbit V2 Promise Plugin API

The Promise plugin API at `@orbit/plugin` is the async/await equivalent of `@orbit/plugin/effect`. It grants plugins the same two in-process capabilities:

- `hook` installs behavior at an Orbit extension point.
- `reload` reruns every transform hook for a stateful domain.

The Promise API uses Promises instead of Effects for setup, runtime hook
callbacks, hook registration, `reload`, and `Registration.dispose`. Transform
editor callbacks remain synchronous.

## Defining A Plugin

```ts
import { Plugin } from "@orbit/plugin"

export default Plugin.define({
  id: "example",
  setup: async (ctx) => {
    await ctx.provider.transform((editor) => {
      editor.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

Plugin setup registers hooks imperatively through each domain's `hook` method.
It may return a synchronous or asynchronous cleanup function. Orbit awaits
the cleanup when the plugin is unloaded or replaced:

```ts
setup: async (ctx) => {
  const timer = setInterval(refresh, 60_000)
  return () => clearInterval(timer)
}
```

Configuration supplied for the plugin is available as `ctx.options`.

A registration may be removed early through `dispose`:

```ts
const registration = await ctx.model.transform(applyModelPolicy)
await registration.dispose()
```

## Transform Hooks

Transform hooks contribute to stateful domains. The editor is synchronous,
so load asynchronous data before registering a transform or reloading its domain:

```ts
const description = await loadReviewerDescription()

await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = description
    item.mode = "subagent"
  })
})
```

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.command.transform
ctx.integration.transform
ctx.mcp.transform
ctx.model.transform
ctx.provider.transform
ctx.reference.transform
ctx.skill.transform
ctx.tool.transform
ctx.vcs.transform
ctx.websearch.transform
```

Provider transforms contribute provider settings and immutable model definitions. After provider availability is resolved,
model transforms edit the complete active-provider candidate collection in order. Use `ctx.model.transform` for runtime
model restrictions; `editor.provider.get()` reads source templates even when their provider is inactive.

```ts
await ctx.model.transform((editor) => {
  editor
    .list()
    .filter((model) => model.cost.some((tier) => tier.output > 20))
    .forEach((model) => {
      editor.remove(model.providerID, model.id)
    })
})
```

## Runtime Hooks

Runtime hooks intercept live operations:

```ts
await ctx.aisdk.hook("sdk", async (event) => {
  if (event.package !== "@ai-sdk/mistral") return
  const mod = await import("@ai-sdk/mistral")
  event.sdk = mod.createMistral(event.options)
})

await ctx.aisdk.hook("language", (event) => {
  if (event.model.providerID !== "mistral") return
  event.language = event.sdk.languageModel(event.model.modelID)
})
```

Session context is mutable immediately before provider dispatch:

```ts
await ctx.session.hook("context", (event) => {
  event.tools.Read.description = "Read a file using narrow line ranges."
  delete event.tools.Write
})

await ctx.session.hook("retry", (event) => {
  if (event.attempt >= 3) event.decision = { retry: false }
})
```

Promise tools use complete executable tool values with async executors:

```ts
import { Schema } from "effect"

await ctx.tool.transform((tools) => {
  tools.add({
    name: "echo",
    options: { codemode: false },
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: async ({ text }) => ({ output: { text }, content: text }),
  })
})
```

`options.codemode` decides how the model gets the tool. `false`, as above, advertises it directly in the request.
Leaving it out, or `true`, defers it: the model finds the tool through Code Mode's catalog and `search` and calls it
from a program. `pinned: true` on a deferred tool also keeps it listed in the catalog that the model sees first,
however much the catalog leaves out to fit its budget.

A tool can also declare `traits`: what it tells Orbit about itself beyond its schemas. `readOnly`, `concurrencySafe` and
`destructive` are a boolean or a function of the decoded input that answers with a boolean or a Promise of one. The rest
are plain values: `openWorld`, `requiresUserInteraction`, `cancelSiblingsOnFailure`, `interruptBehavior`,
`maxResultChars`, `searchHint` and `displayName`. A trait you leave out takes its default, and the tool's context
carries the answers for the call as `context.traits`. A `searchHint` is a few words that Code Mode's `search` matches
when it looks for a deferred tool. A call with `cancelSiblingsOnFailure` fails for that purpose only when its result or
its `Tool.Error` carries `metadata.error: true`; denials, rejections with feedback and validation failures never count.

```ts
tools.add({
  name: "lookup",
  description: "Look up a record",
  input: Schema.Struct({ id: Schema.String }),
  traits: {
    readOnly: true,
    concurrencySafe: async ({ id }) => id !== "*",
    displayName: "Lookup",
  },
  // The context reports what was resolved for this call. Report it, but do not branch on it.
  execute: async ({ id }, context) => ({
    content: `read ${id}`,
    metadata: { concurrencySafe: context.traits.concurrencySafe },
  }),
})
```

A predicate that throws, rejects or answers with anything but a boolean is logged, and that call takes conservative
answers: not read-only, not concurrency-safe, destructive and left to finish on interrupt. What the tool declares
about itself, such as `openWorld`, stays as declared. The conservative answers are not what the tool declared, so a
tool that did something different when `context.traits.readOnly` is true would switch branches whenever a predicate
broke. Only `readOnly` may relax a permission decision, and a failing predicate never leaves it true. A registration
with invalid traits, such as an empty `displayName`, a `maxResultChars` that is not positive or traits that are not an
object, is skipped with a log line, and the tools beside it still register.

A tool can also refuse a call before it asks anyone about it. `validate` receives the decoded input and the same context
as `execute`. It runs after the `execute.before` hooks and before `execute`, so a call that it refuses never reaches the
tool's own permission requests. Throw to refuse, with a `Tool.Error` that carries a `code`, so a client can tell the
failure apart without reading the message. `Tool.ErrorCode` lists the codes that Orbit uses for its own failures, and any
other string is yours to define.

```ts
import { Tool } from "@orbit/sdk"

tools.add({
  name: "move",
  description: "Move a file",
  input: Schema.Struct({ from: Schema.String, to: Schema.String }),
  validate: async ({ from }) => {
    if (!(await exists(from))) throw new Tool.Error({ message: `No such file: ${from}`, code: "move.not-found" })
  },
  execute: async ({ from, to }) => ({ content: await move(from, to) }),
})
```

A `Tool.Error` without a `code`, and anything else that `validate` throws or rejects with, is reported as
`tool.validation` with its message. A call that `validate` refuses reaches the model and the clients with the code as its
error `type`. `validate` must not ask for permission or change anything, and what it checked can change before `execute`
runs, so `execute` should check again whatever it relies on. A tool whose `validate` is not a function is skipped with a
log line, like a tool with invalid traits.

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
const source = { providers: await loadProviders() }

await ctx.provider.transform((editor) => {
  source.providers.forEach((provider) => editor.add(provider))
})

source.providers = await loadProviders()
await ctx.provider.reload()
```

`loadProviders()` returns entries shaped as `{ info: Provider.Info, models: readonly Model.Info[] }`. Provider reloads
also invalidate the active model result, so every model transform runs again with the refreshed definitions. Model
callbacks edit raw overrides; provider defaults are merged once when the result is committed.

Available reload operations are:

```ts
ctx.agent.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.mcp.reload()
ctx.model.reload()
ctx.provider.reload()
ctx.reference.reload()
ctx.skill.reload()
ctx.tool.reload()
ctx.vcs.reload()
ctx.websearch.reload()
```
