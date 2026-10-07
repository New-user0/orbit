import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

// The run store is an append-only event log; every other view of a run is derived from it. One SQLite file per
// project, at .orbit/runs.db.

export type RunStatus = "running" | "waiting" | "succeeded" | "failed"

export interface Run {
  readonly id: string
  readonly workflow: string
  readonly file: string
  readonly directory: string
  readonly input: Readonly<Record<string, unknown>>
  readonly status: RunStatus
  readonly created: number
  readonly updated: number
}

export interface Event {
  readonly seq: number
  readonly run: string
  readonly node: string | null
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
  readonly time: number
}

export interface NodeState {
  readonly id: string
  readonly status: "running" | "waiting" | "succeeded" | "failed"
  readonly key?: string
  /** Set on gates: what the approver is deciding. */
  readonly message?: string
  readonly attempts: number
  readonly result?: Readonly<Record<string, unknown>>
  readonly error?: Readonly<Record<string, unknown>>
  readonly started: number
  readonly ended?: number
}

/** Tokens and cost of one attempt, from `attempt.ended`. */
export interface Spend {
  readonly node: string
  readonly model: string
  readonly cost: number
  readonly input: number
  readonly output: number
}

const PASSING = new Set(["rate-limit", "transient", "timeout"])

// The IDs the runner makes: run_ and a timestamp of 14 digits, then 6 hexadecimal digits. The store is a file in the
// repository, so a clone brings its own, and what it holds is not to be trusted: an ID becomes a folder to remove and
// part of a branch name, and one like `../../../x` leads out of the repository. A row with any other ID is not a run, so
// the store neither lists it nor returns it.
const RUN_ID_GLOB = `run_${"[0-9]".repeat(14)}_${"[0-9a-f]".repeat(6)}`

export class Store {
  private readonly db: Database

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(`CREATE TABLE IF NOT EXISTS run (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, file TEXT NOT NULL, directory TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`)
    this.db.run(`CREATE TABLE IF NOT EXISTS event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, node TEXT, type TEXT NOT NULL,
      data TEXT NOT NULL, time INTEGER NOT NULL)`)
    this.db.run("CREATE INDEX IF NOT EXISTS event_run ON event (run, seq)")
  }

  static at(directory: string) {
    return new Store(path.join(directory, ".orbit", "runs.db"))
  }

  create(input: Omit<Run, "status" | "created" | "updated">, data: Readonly<Record<string, unknown>> = {}) {
    const now = Date.now()
    this.db
      .query(
        "INSERT INTO run (id, workflow, file, directory, input, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.workflow, input.file, input.directory, JSON.stringify(input.input), "running", now, now)
    this.append(input.id, null, "run.started", { ...data, workflow: input.workflow, input: input.input })
  }

  status(id: string, status: RunStatus, data: Readonly<Record<string, unknown>> = {}) {
    this.db.query("UPDATE run SET status = ?, updated = ? WHERE id = ?").run(status, Date.now(), id)
    this.append(id, null, `run.${status === "running" ? "resumed" : status}`, data)
  }

  append(run: string, node: string | null, type: string, data: Readonly<Record<string, unknown>> = {}) {
    this.db
      .query("INSERT INTO event (run, node, type, data, time) VALUES (?, ?, ?, ?, ?)")
      .run(run, node, type, JSON.stringify(data), Date.now())
    this.db.query("UPDATE run SET updated = ? WHERE id = ?").run(Date.now(), run)
  }

  run(id: string): Run | undefined {
    const row = this.db.query("SELECT * FROM run WHERE id = ? AND id GLOB ?").get(id, RUN_ID_GLOB) as RunRow | null
    return row ? toRun(row) : undefined
  }

  runs(limit = 20): Run[] {
    return (
      this.db
        .query("SELECT * FROM run WHERE id GLOB ? ORDER BY created DESC LIMIT ?")
        .all(RUN_ID_GLOB, limit) as RunRow[]
    ).map(toRun)
  }

  events(run: string): Event[] {
    return (this.db.query("SELECT * FROM event WHERE run = ? ORDER BY seq").all(run) as EventRow[]).map((row) => ({
      ...row,
      data: JSON.parse(row.data),
    }))
  }

  /** The latest state of every node, folded from the event log. */
  nodes(run: string): Map<string, NodeState> {
    return this.events(run).reduce((nodes, event) => {
      if (!event.node) return nodes
      const current = nodes.get(event.node)
      switch (event.type) {
        case "node.started":
          nodes.set(event.node, {
            id: event.node,
            status: "running",
            key: String(event.data.key ?? ""),
            attempts: 0,
            started: event.time,
          })
          break
        case "attempt.started":
          if (current) nodes.set(event.node, { ...current, attempts: current.attempts + 1 })
          break
        case "node.succeeded":
        case "node.reused":
          nodes.set(event.node, {
            ...(current ?? { id: event.node, attempts: 0, started: event.time }),
            status: "succeeded",
            key: String(event.data.key ?? current?.key ?? ""),
            result: event.data.result as Record<string, unknown>,
            ended: event.time,
          })
          break
        case "gate.pending":
          nodes.set(event.node, {
            id: event.node,
            status: "waiting",
            message: String(event.data.message ?? ""),
            attempts: 0,
            started: current?.started ?? event.time,
          })
          break
        case "gate.decided":
          nodes.set(event.node, {
            ...(current ?? { id: event.node, attempts: 0, started: event.time }),
            status: "succeeded",
            result: { approved: event.data.approved, ...(event.data.note ? { note: event.data.note } : {}) },
            ended: event.time,
          })
          break
        case "node.failed":
          nodes.set(event.node, {
            ...(current ?? { id: event.node, attempts: 0, started: event.time }),
            status: "failed",
            result: event.data.result as Record<string, unknown> | undefined,
            error: event.data.error as Record<string, unknown>,
            ended: event.time,
          })
          break
      }
      return nodes
    }, new Map<string, NodeState>())
  }

  /** Record a decision on a waiting gate; returns an error message when the gate is not waiting. */
  decide(run: string, gate: string, approved: boolean, note?: string) {
    const state = this.nodes(run).get(gate)
    if (state?.status !== "waiting")
      return state ? `${gate} is not waiting for a decision` : `No gate ${gate} in run ${run}`
    this.append(run, gate, "gate.decided", { approved, ...(note ? { note } : {}) })
    return undefined
  }

  /** Every attempt's tokens and cost, across the run's original execution and its resumes. */
  spend(run: string): Spend[] {
    return this.events(run).flatMap((event) =>
      event.type === "attempt.ended" && event.node
        ? [
            {
              node: event.node,
              model: String(event.data.model ?? "default"),
              cost: Number(event.data.cost ?? 0),
              input: Number(event.data.input ?? 0),
              output: Number(event.data.output ?? 0),
            },
          ]
        : [],
    )
  }

  /**
   * Whether a model's breaker is open: its latest attempts, in any run in this repository, are `threshold` failures
   * of a passing kind (rate limit, server or network trouble, timeout) within `window` milliseconds.
   */
  breaker(model: string, threshold = 3, window = 60_000) {
    const rows = this.db
      .query(
        `SELECT json_extract(data, '$.error.class') AS class FROM event
         WHERE type = 'attempt.ended' AND json_extract(data, '$.model') = ? AND time > ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(model, Date.now() - window, threshold) as Array<{ class: string | null }>
    return rows.length >= threshold && rows.every((row) => row.class !== null && PASSING.has(row.class))
  }

  close() {
    this.db.close()
  }
}

interface RunRow {
  id: string
  workflow: string
  file: string
  directory: string
  input: string
  status: RunStatus
  created: number
  updated: number
}

interface EventRow {
  seq: number
  run: string
  node: string | null
  type: string
  data: string
  time: number
}

function toRun(row: RunRow): Run {
  return { ...row, input: JSON.parse(row.input) }
}
