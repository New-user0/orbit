import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { ServerConnection } from "../../../services/server-connection"
import { plain, progress } from "../../../util/plain"
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
  const server = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    trust: input.trust,
  })
  const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  // Before the workflow is loaded, so that a refusal that says no work was done comes before any code of the file runs.
  // For a resumed run the file is the one the repository's run store names.
  const trust = yield* trustOptions(file, "workflow")
  yield* requireTrust(client, directory(), { grant: input.trust, ...trust })
  const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
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
      log: (line) => process.stderr.write(`${progress(line)}\n`),
    }),
  )
  if (result.status === "failed") process.exitCode = 1
  // 2 means the run needs a person: it paused at a gate rather than failing. The person decides on what the workflow
  // says at the gate, so the text goes through `plain`, and cannot hide itself with a carriage return or an escape.
  if (result.status === "waiting") {
    process.exitCode = 2
    process.stderr.write(
      [
        "",
        `${result.id} is waiting for a decision:`,
        ...(result.waiting ?? []).map((item) => `  ${plain(item.gate)}: ${plain(item.message)}`),
        "",
        `Approve with \`orb flow approve ${result.id} <gate>\` (or add --reject), then run \`orb flow resume ${result.id}\`.`,
        "",
      ].join("\n"),
    )
  }
  if (result.output !== undefined) process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`)
})

/**
 * What a workflow or suite file asks of its folder's trust before the command loads it, as `requireTrust` takes it. A
 * module is imported, which runs the code in it, so it needs a trusted folder whatever the folder holds back. A YAML or
 * JSON file is only read, which runs nothing, but a run of it carries out three things on the file's own account. It
 * executes the shell commands that its check nodes, verify nodes and suite tasks define, which no permission rule is
 * asked about. It approves what the agents of its nodes ask permission for where they set `permissions` to `auto`. And it
 * runs nodes as the agents it names, in the `agent` of a node, of a team member or of a `judge`, whose own rules are added
 * after the user's global rules and win. The last two settle the user's own rules in the file's favour. A file that
 * defines any of the three needs a trusted folder as well. One that defines none keeps the check that `orb run` has.
 */
export const trustOptions = Effect.fn("cli.flow.trustOptions")(function* (file: string, kind: "workflow" | "suite") {
  const { importsModule, suiteAgents, suiteCommands, workflowAgents, workflowApprovals, workflowCommands } =
    yield* Effect.promise(() => import("@orbit/flow"))
  const defines = yield* Effect.tryPromise({
    try: async () => ({
      file,
      commands: await (kind === "workflow" ? workflowCommands(file) : suiteCommands(file)),
      // A suite has no `permissions` to set: each of its tasks runs as a verify node that passes none on.
      approvals: kind === "workflow" ? await workflowApprovals(file) : [],
      // A suite names an agent only as the `judge` of a task.
      agents: await (kind === "workflow" ? workflowAgents(file) : suiteAgents(file)),
    }),
    catch: (cause) => cause,
  })
  return { imports: importsModule(file) ? file : undefined, defines }
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
