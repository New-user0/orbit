import { createHash } from "node:crypto"
import type { Event, Run } from "./store.js"

// A run's event log as spans: the run, each node, and each model attempt inside a node. `otlp` produces OTLP/HTTP
// JSON, the format OpenTelemetry collectors accept; Orbit only sends it where the user points `orb flow trace --otlp`.

export interface Span {
  readonly id: string
  readonly parent?: string
  readonly name: string
  readonly start: number
  readonly end: number
  readonly failed: boolean
  readonly attributes: Readonly<Record<string, string | number>>
}

export function spans(run: Run, events: ReadonlyArray<Event>): Span[] {
  const last = events.at(-1)?.time ?? run.updated
  const root: Span = {
    id: run.id,
    name: `run ${run.workflow}`,
    start: run.created,
    end: run.status === "running" ? last : run.updated,
    failed: run.status === "failed",
    attributes: { "orbit.run.id": run.id, "orbit.run.status": run.status, "orbit.workflow": run.workflow },
  }
  const nodes = new Map<string, { start: number; end?: number; failed: boolean }>()
  const attempts: Span[] = []
  const open = new Map<string, { start: number; model: string; attempt: number }>()
  for (const event of events) {
    if (!event.node) continue
    const node = nodes.get(event.node)
    if (event.type === "node.started" || event.type === "gate.pending" || (!node && event.type === "node.reused"))
      nodes.set(event.node, { start: node?.start ?? event.time, failed: false })
    if (event.type === "node.succeeded" || event.type === "node.reused" || event.type === "gate.decided")
      nodes.set(event.node, { start: node?.start ?? event.time, end: event.time, failed: false })
    if (event.type === "node.failed")
      nodes.set(event.node, { start: node?.start ?? event.time, end: event.time, failed: true })
    if (event.type === "attempt.started")
      open.set(event.node, {
        start: event.time,
        model: String(event.data.model ?? "default"),
        attempt: Number(event.data.attempt ?? 1),
      })
    if (event.type === "attempt.ended") {
      const started = open.get(event.node)
      open.delete(event.node)
      attempts.push({
        id: `${event.node}#attempt${started?.attempt ?? event.data.attempt}@${event.seq}`,
        parent: event.node,
        name: `attempt ${event.data.model ?? started?.model ?? "default"}`,
        start: started?.start ?? event.time,
        end: event.time,
        failed: event.data.error !== undefined,
        attributes: {
          "gen_ai.request.model": String(event.data.model ?? started?.model ?? "default"),
          "gen_ai.usage.input_tokens": Number(event.data.input ?? 0),
          "gen_ai.usage.output_tokens": Number(event.data.output ?? 0),
          "orbit.cost_usd": Number(event.data.cost ?? 0),
          ...(event.data.error
            ? { "error.type": String((event.data.error as { class?: string }).class ?? "unknown") }
            : {}),
        },
      })
    }
  }
  return [
    root,
    ...[...nodes.entries()].map(([id, node]) => ({
      id,
      parent: run.id,
      name: id,
      start: node.start,
      end: node.end ?? last,
      failed: node.failed,
      attributes: { "orbit.node.id": id },
    })),
    ...attempts,
  ]
}

/** A text timeline: each span's start, duration and a bar on a shared scale. */
export function timeline(all: ReadonlyArray<Span>, width = 40) {
  const root = all[0]
  const total = Math.max(1, root.end - root.start)
  const depth = (span: Span): number =>
    span.parent ? 1 + depth(all.find((item) => item.id === span.parent) ?? root) : 0
  const rows = all.map((span) => {
    const from = Math.round(((span.start - root.start) / total) * width)
    const length = Math.max(1, Math.round(((span.end - span.start) / total) * width))
    return {
      label: `${"  ".repeat(depth(span))}${span.failed ? "✗" : "✓"} ${span.name}`,
      bar: `${" ".repeat(from)}${"█".repeat(Math.min(length, width - from || 1))}`.padEnd(width),
      time: `+${((span.start - root.start) / 1000).toFixed(1)}s  ${((span.end - span.start) / 1000).toFixed(1)}s`,
    }
  })
  const labels = Math.max(...rows.map((row) => row.label.length))
  return rows.map((row) => `${row.label.padEnd(labels)}  |${row.bar}|  ${row.time}`).join("\n")
}

export function otlp(run: Run, all: ReadonlyArray<Span>) {
  const traceId = digest(run.id, 32)
  const value = (item: string | number) =>
    typeof item === "number"
      ? Number.isInteger(item)
        ? { intValue: String(item) }
        : { doubleValue: item }
      : { stringValue: item }
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "orbit-flow" } }] },
        scopeSpans: [
          {
            scope: { name: "orbit.flow" },
            spans: all.map((span) => ({
              traceId,
              spanId: digest(`${run.id}/${span.id}`, 16),
              ...(span.parent ? { parentSpanId: digest(`${run.id}/${span.parent}`, 16) } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: `${span.start}000000`,
              endTimeUnixNano: `${span.end}000000`,
              attributes: Object.entries(span.attributes).map(([key, item]) => ({ key, value: value(item) })),
              status: span.failed ? { code: 2 } : { code: 1 },
            })),
          },
        ],
      },
    ],
  }
}

function digest(text: string, length: number) {
  return createHash("sha256").update(text).digest("hex").slice(0, length)
}
