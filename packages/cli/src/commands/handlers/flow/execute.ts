import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { ServerConnection } from "../../../services/server-connection"
import { requireTrust } from "../../../util/trust"

// Shared by `orb flow run` and `orb flow resume`: connect, load the workflow file, and drive the run.
export const execute = Effect.fn("cli.flow.execute")(function* (input: {
  readonly server: Option.Option<string>
  readonly standalone: boolean
  readonly trust: boolean
  readonly auto: boolean
  readonly model: Option.Option<string>
  readonly maxCost: Option.Option<number>
  readonly maxTokens: Option.Option<number>
  readonly file: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly resume?: string
}) {
  const { run } = yield* Effect.promise(() => import("@orbit/flow"))
  const file = path.resolve(directory(), input.file)
  const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
  const server = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    trust: input.trust,
  })
  const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  yield* requireTrust(client, directory(), { grant: input.trust })
  const result = yield* Effect.promise(() =>
    run({
      client,
      workflow,
      file,
      directory: directory(),
      input: input.input,
      resume: input.resume,
      permissions: input.auto ? "auto" : "reject",
      model: Option.getOrUndefined(input.model),
      budget:
        Option.isSome(input.maxCost) || Option.isSome(input.maxTokens)
          ? { maxCost: Option.getOrUndefined(input.maxCost), maxTokens: Option.getOrUndefined(input.maxTokens) }
          : undefined,
      log: (line) => process.stderr.write(`${line}\n`),
    }),
  )
  if (result.status === "failed") process.exitCode = 1
  // 2 means the run needs a person: it paused at a gate rather than failing.
  if (result.status === "waiting") {
    process.exitCode = 2
    process.stderr.write(
      [
        "",
        `${result.id} is waiting for a decision:`,
        ...(result.waiting ?? []).map((item) => `  ${item.gate}: ${item.message}`),
        "",
        `Approve with \`orb flow approve ${result.id} <gate>\` (or add --reject), then run \`orb flow resume ${result.id}\`.`,
        "",
      ].join("\n"),
    )
  }
  if (result.output !== undefined) process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`)
})

// The dev script runs from packages/cli, so like `orb run` the user's directory comes from PWD.
export function directory() {
  return process.env.PWD ?? process.cwd()
}

/** `key=value` pairs, or a JSON object, merged in order. */
export function parseInput(values: ReadonlyArray<string>) {
  return Object.fromEntries(
    values.flatMap((value) => {
      const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
        value,
      )
      if (Option.isSome(json)) return Object.entries(json.value)
      const separator = value.indexOf("=")
      if (separator <= 0) throw new Error(`--input must be key=value or a JSON object, got ${value}`)
      return [[value.slice(0, separator), value.slice(separator + 1)]]
    }),
  )
}

export async function load(file: string) {
  const { loadWorkflow } = await import("@orbit/flow")
  return loadWorkflow(file)
}
