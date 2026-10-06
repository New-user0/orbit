import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { json, plain, progress } from "@orbit/flow/plain"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { requireTrust } from "../../util/trust"
import { directory, trustOptions } from "./flow/execute"

export default Runtime.handler(
  Commands.commands.eval,
  Effect.fn("cli.eval")(function* (input) {
    const { evaluate, loadSuite, openStore, summarize } = yield* Effect.promise(() => import("@orbit/flow"))
    const file = path.resolve(directory(), input.suite)
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      trust: input.trust,
    })
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // Before the suite is loaded, so that a refusal that says no work was done comes before any code of the file runs.
    const trust = yield* trustOptions(file, "suite")
    yield* requireTrust(client, directory(), { grant: input.trust, ...trust })
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
          log: (line) => process.stderr.write(`${progress(line)}${EOL}`),
        }),
      catch: (cause) => cause,
    })
    if (!result.scores) {
      process.exitCode = 1
      return yield* Effect.fail(new Error(`Eval ${result.id} did not finish: ${plain(result.error ?? result.status)}`))
    }
    const summary = summarize(result.scores)
    // The scores name the tasks of the suite, and a resumed eval takes its models from the run store: text from files.
    if (input.format === "json")
      return process.stdout.write(json({ run: result.id, summary, scores: result.scores }) + EOL)
    const tasks = [...new Set(result.scores.map((score) => score.task))]
    // The task IDs are text from the suite. A resumed eval takes its models, and what the tasks that it reuses spent,
    // from the run store. Both are files in the repository that a clone brings along, and the amounts are read with
    // `Number`, which leaves no text in them.
    const table = [
      ["model", "passed", "rate", "input", "output", "cost", "time"],
      ...summary.map((row) => [
        plain(row.model),
        `${row.passed}/${row.total}`,
        `${Math.round((row.passed / row.total) * 100)}%`,
        String(Number(row.input)),
        String(Number(row.output)),
        `$${Number(row.cost).toFixed(4)}`,
        `${row.seconds}s`,
      ]),
    ]
    const tasksTable = [
      ["task", ...summary.map((row) => plain(row.model))],
      ...tasks.map((task) => [
        plain(task),
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
