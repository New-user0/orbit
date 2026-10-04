import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import type { Event, NodeState, Run } from "@orbit/flow"
import { directory } from "./execute"

/** A run, its nodes and team conversations, as `orb flow show` prints them. */
export function render(run: Run, nodes: ReadonlyArray<NodeState>, events: ReadonlyArray<Event>) {
  const lines = [
    `${run.id}  ${run.workflow}  ${run.status}`,
    `file  ${run.file}`,
    ...nodes.map((node) => {
      const usage = node.result?.usage as { cost?: number; input?: number; output?: number } | undefined
      return [
        `${marks[node.status]} ${node.id}`,
        ...(node.attempts > 0 ? [`attempts ${node.attempts}`] : []),
        ...(usage ? [`tokens ${usage.input ?? 0}/${usage.output ?? 0}`, `cost ${(usage.cost ?? 0).toFixed(4)}`] : []),
        ...(node.error ? [String(node.error.message)] : []),
        ...(node.status === "waiting" ? [`waiting: ${node.message}`] : []),
      ].join("  ")
    }),
    // Teams: what members said to each other and wrote on the board, in order.
    ...events.flatMap((event) =>
      event.type === "team.message"
        ? [`  ${event.node}: ${event.data.from} → ${event.data.to}: ${oneLine(event.data.text)}`]
        : event.type === "team.note"
          ? [`  ${event.node}: ${event.data.from} noted ${event.data.key}: ${oneLine(event.data.text)}`]
          : [],
    ),
  ]
  return lines.join(EOL)
}

const marks = { running: "…", waiting: "?", succeeded: "✓", failed: "✗" }

export default Runtime.handler(
  Commands.commands.flow.commands.show,
  Effect.fn("cli.flow.show")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const run = store.run(input.run)
    const nodes = [...store.nodes(input.run).values()]
    const events = store.events(input.run)
    store.close()
    if (!run) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    if (input.format === "json") return process.stdout.write(JSON.stringify({ run, nodes, events }, null, 2) + EOL)
    process.stdout.write(render(run, nodes, events) + EOL)
  }),
)

function oneLine(value: unknown) {
  const text = String(value).replace(/\s+/g, " ")
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
