import { json, plain } from "@orbit/flow/plain"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.trace,
  Effect.fn("cli.flow.trace")(function* (input) {
    // The run store is a file that a clone can ship with any run in it, and finding it reads the folder's `.git`, so the
    // folder has to be trusted before the store is opened (classes 1, 5 and 12; FU-M4-202).
    const client = yield* connect(input)
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
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
    // timeline shows them through `plain`, and the OTLP output through `json`.
    process.stdout.write(
      (input.format === "otlp"
        ? json(otlp(run, all))
        : timeline(all.map((span) => ({ ...span, name: plain(span.name) })))) + EOL,
    )
  }),
)
