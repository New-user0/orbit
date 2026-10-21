import type { Event, NodeState, Run } from "@orbit/flow"
import { json, plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory } from "./execute"

/**
 * A run, its nodes and team conversations, as `orb flow show` prints them. The run store is a file in the repository, so
 * a clone brings its own and what it says is text from an untrusted file: every piece of text is printed through
 * `plain` (or `json`, for programs), and the amounts are read with `Number`, which leaves no text in them.
 */
export function render(run: Run, nodes: ReadonlyArray<NodeState>, events: ReadonlyArray<Event>) {
  const lines = [
    `${shown(run.id)}  ${shown(run.workflow)}  ${shown(run.status)}`,
    `file  ${shown(run.file)}`,
    ...nodes.map((node) => {
      const usage = node.result?.usage as { cost?: unknown; input?: unknown; output?: unknown } | undefined
      return [
        `${marks[node.status]} ${shown(node.id)}`,
        ...(node.attempts > 0 ? [`attempts ${node.attempts}`] : []),
        ...(usage
          ? [
              `tokens ${Number(usage.input ?? 0)}/${Number(usage.output ?? 0)}`,
              `cost ${Number(usage.cost ?? 0).toFixed(4)}`,
            ]
          : []),
        ...(node.error ? [shown(node.error.message)] : []),
        ...(node.status === "waiting" ? [`waiting: ${shown(node.message)}`] : []),
      ].join("  ")
    }),
    // Teams: what members said to each other and wrote on the board, in order.
    ...events.flatMap((event) =>
      event.type === "team.message"
        ? [`  ${shown(event.node)}: ${shown(event.data.from)} → ${shown(event.data.to)}: ${oneLine(event.data.text)}`]
        : event.type === "team.note"
          ? [
              `  ${shown(event.node)}: ${shown(event.data.from)} noted ${shown(event.data.key)}: ${oneLine(event.data.text)}`,
            ]
          : [],
    ),
  ]
  return lines.join(EOL)
}

const marks = { running: "…", waiting: "?", succeeded: "✓", failed: "✗" }

export default Runtime.handler(
  Commands.commands.flow.commands.show,
  Effect.fn("cli.flow.show")(function* (input) {
    // The run store is a file that a clone can ship with any run in it, and finding it reads the folder's `.git`, so the
    // folder has to be trusted before the store is opened (classes 1, 5 and 12; FU-M4-202).
    const client = yield* connect(input)
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const run = store.run(input.run)
    const nodes = [...store.nodes(input.run).values()]
    const events = store.events(input.run)
    store.close()
    if (!run) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    if (input.format === "json") return process.stdout.write(json({ run, nodes, events }) + EOL)
    process.stdout.write(render(run, nodes, events) + EOL)
  }),
)

const shown = (value: unknown) => plain(String(value))

function oneLine(value: unknown) {
  const text = shown(String(value).replace(/\s+/g, " "))
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
