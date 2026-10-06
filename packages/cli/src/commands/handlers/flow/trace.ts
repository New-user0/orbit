import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { plain } from "../../../util/plain"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.trace,
  Effect.fn("cli.flow.trace")(function* (input) {
    const { openStore, otlp, spans, timeline } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const run = store.run(input.run)
    const events = store.events(input.run)
    store.close()
    if (!run) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    const all = spans(run, events)
    const target = Option.getOrUndefined(input.otlp)
    // Only an explicit --otlp sends anything, and only to the collector it names.
    if (target) {
      const url = target.replace(/\/+$/, "").endsWith("/v1/traces") ? target : `${target.replace(/\/+$/, "")}/v1/traces`
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(otlp(run, all)),
          }),
        catch: (cause) =>
          new Error(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })
      if (!response.ok)
        return yield* Effect.fail(
          new Error(`${url} answered ${response.status}: ${yield* Effect.promise(() => response.text())}`),
        )
      return process.stdout.write(`Sent ${all.length} spans of ${run.id} to ${url}${EOL}`)
    }
    // The names of the spans are text from the run store, a file in the repository that a clone brings along, so the
    // timeline shows them through `plain`. The OTLP output is JSON, which escapes them.
    process.stdout.write(
      (input.format === "otlp"
        ? JSON.stringify(otlp(run, all), null, 2)
        : timeline(all.map((span) => ({ ...span, name: plain(span.name) })))) + EOL,
    )
  }),
)
