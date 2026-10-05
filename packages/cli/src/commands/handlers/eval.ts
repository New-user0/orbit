import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { requireTrust } from "../../util/trust"
import { directory } from "./flow/execute"

export default Runtime.handler(
  Commands.commands.eval,
  Effect.fn("cli.eval")(function* (input) {
    const { evaluate, importsModule, loadSuite, openStore, summarize } = yield* Effect.promise(
      () => import("@orbit/flow"),
    )
    const file = path.resolve(directory(), input.suite)
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      trust: input.trust,
    })
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // Before the suite is loaded: loading imports a module, whose top-level code then runs here. So a module needs a
    // trusted folder whatever the folder holds back, and a refusal that says no work was done has to come before it.
    // Loading a JSON or YAML suite runs nothing, so it keeps the check that `orb run` has.
    yield* requireTrust(client, directory(), { grant: input.trust, imports: importsModule(file) ? file : undefined })
    const suite = yield* Effect.tryPromise({ try: () => loadSuite(file), catch: (cause) => cause })
    const resume = Option.getOrUndefined(input.resume)
    // A resumed eval compares the models it started with.
    const recorded = resume
      ? yield* Effect.promise(async () => {
          const store = await openStore(directory())
          const run = store.run(resume)
          store.close()
          return run
        })
      : undefined
    if (resume && !recorded) return yield* Effect.fail(new Error(`No run ${resume} in this repository`))
    const models = recorded
      ? (recorded.input.models as string[])
      : Option.getOrUndefined(input.models)
          ?.split(",")
          .map((model) => model.trim())
          .filter(Boolean)
    const result = yield* Effect.tryPromise({
      try: () =>
        evaluate({
          client,
          suite,
          file,
          directory: directory(),
          models,
          concurrency: Option.getOrUndefined(input.concurrency),
          permissions: input.auto ? "auto" : "reject",
          resume,
          log: (line) => process.stderr.write(`${line}${EOL}`),
        }),
      catch: (cause) => cause,
    })
    if (!result.scores) {
      process.exitCode = 1
      return yield* Effect.fail(new Error(`Eval ${result.id} did not finish: ${result.error ?? result.status}`))
    }
    const summary = summarize(result.scores)
    if (input.format === "json")
      return process.stdout.write(JSON.stringify({ run: result.id, summary, scores: result.scores }, null, 2) + EOL)
    const tasks = [...new Set(result.scores.map((score) => score.task))]
    const table = [
      ["model", "passed", "rate", "input", "output", "cost", "time"],
      ...summary.map((row) => [
        row.model,
        `${row.passed}/${row.total}`,
        `${Math.round((row.passed / row.total) * 100)}%`,
        String(row.input),
        String(row.output),
        `$${row.cost.toFixed(4)}`,
        `${row.seconds}s`,
      ]),
    ]
    const tasksTable = [
      ["task", ...summary.map((row) => row.model)],
      ...tasks.map((task) => [
        task,
        ...summary.map((row) => {
          const score = result.scores?.find((item) => item.model === row.model && item.task === task)
          return score?.passed ? `✓${score.iterations > 1 ? ` (${score.iterations} tries)` : ""}` : "✗"
        }),
      ]),
    ]
    process.stdout.write(
      [format(table), "", format(tasksTable), "", `Details: orb flow show ${result.id}`].join(EOL) + EOL,
    )
  }),
)

function format(rows: string[][]) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join(EOL)
}
