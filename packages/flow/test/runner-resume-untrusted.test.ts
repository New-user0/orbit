import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { run } from "../src/runner"
import type { Workflow } from "../src/workflow"

// Classes 1, 5 and 12: a run store is a file that a clone ships, and a resume reuses the results it records. Each row
// makes a run, then rewrites one value of its store the way a clone could ship it, then resumes the run with a client
// that records where it opens sessions and which sessions it prompts. In a folder that is not trusted the resume takes
// no folder and no session ID from the store; the trusted control takes the same value, which shows the row is live.
// Mutations: taking the reviewer's folder as `work.worktree ?? home` fails the untrusted reviewer row, taking the check's
// as `checkOptions.in?.worktree ?? home` fails the untrusted check row, and keeping the session of every reused turn
// (dropping `if (options.trusted || !result.reused)`) fails the untrusted team row, and taking the stored base commit
// wherever there is a store (`source ? undefined : previous ? stored : repository ? head : undefined` in place of the
// guard on `repository`) fails the untrusted review diff row. The trusted rows pass under each.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-resume-")))
afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// A client that opens sessions and answers each prompt by what it asks: a reviewer approves, a team's lead hands work to
// `coder` and finishes once nobody has anything pending, and everyone else says ok. A prompt that `fail` picks gets a
// reply that ends in an error the runner does not retry.
function recording(fail: (prompt: string) => boolean = () => false) {
  const created: { title: string; directory: string }[] = []
  const prompted: string[] = []
  const prompts = new Map<string, string>()
  let sessions = 0
  let replies = 0
  const reply = (prompt: string) => {
    if (prompt.includes("Review a change another agent made")) return "APPROVED"
    if (prompt.includes("Nobody on the team has anything pending")) return "<done>finished</done>"
    if (prompt.includes("You lead.")) return '<message to="coder">go</message>'
    return "ok"
  }
  const client = {
    config: { effective: async () => ({ permissions: { bypass: true } }) },
    session: {
      create: async (input: { readonly title: string; readonly location: { readonly directory: string } }) => {
        created.push({ title: input.title, directory: input.location.directory })
        return { id: `ses_${++sessions}` }
      },
      prompt: async (input: { readonly sessionID: string; readonly text: string }) => {
        prompted.push(input.sessionID)
        prompts.set(input.sessionID, input.text)
      },
      wait: async () => ({}),
      get: async () => undefined,
    },
    shell: { list: async () => ({ data: [] }) },
    message: {
      list: async (input: { readonly sessionID: string }) => {
        const prompt = prompts.get(input.sessionID) ?? ""
        return {
          data: [
            {
              id: `msg_${replies++}`,
              type: "assistant",
              content: [{ type: "text", text: reply(prompt) }],
              tokens: {},
              cost: 0,
              ...(fail(prompt) ? { error: { type: "provider.invalid-request", message: "refused" } } : {}),
            },
          ],
        }
      },
    },
    model: { list: async () => ({ data: [] }) },
    event: { subscribe: async function* () {} },
  } as unknown as OrbitClient
  return { client, created, prompted }
}

// A repository with one commit, and a clone of it outside, which the store is made to name: it has the same commits, so
// the trusted control can diff there as it would in a worktree of the run.
async function repositories(name: string) {
  const clone = path.join(root, name, "clone")
  const victim = path.join(root, name, "victim")
  await fs.mkdir(clone, { recursive: true })
  const vcs = (directory: string, ...args: string[]) =>
    expect(Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode).toBe(0)
  vcs(clone, "init", "-q", "-b", "main")
  vcs(clone, "config", "user.email", "t@t")
  vcs(clone, "config", "user.name", "t")
  await Bun.write(path.join(clone, "a.txt"), "one\n")
  vcs(clone, "add", "-A")
  vcs(clone, "commit", "-qm", "one", "--no-gpg-sign")
  vcs(path.join(root, name), "clone", "-q", clone, victim)
  return { clone, victim }
}

// Sets one value in the result that the store records for a node, as a clone can ship its store with any value there.
function rewrite(clone: string, node: string, key: string, value: string) {
  const database = new Database(path.join(clone, ".orbit", "runs.db"))
  database
    .query("UPDATE event SET data = json_set(data, ?, ?) WHERE node = ? AND type = 'node.succeeded'")
    .run(`$.result.${key}`, value, node)
  database.close()
}

// Gives the run in the store a base commit, as a clone can ship a store whose run started at one, and makes the folder
// outside run a program whenever git reads its index: `core.fsmonitor` writes a line into `ran` beside it, and a change
// that is not committed yet makes a diff read the index.
async function monitored(clone: string, victim: string) {
  const database = new Database(path.join(clone, ".orbit", "runs.db"))
  database.query("UPDATE event SET data = json_set(data, '$.base', 'HEAD') WHERE type = 'run.started'").run()
  database.close()
  const program = path.join(path.dirname(victim), "fsmonitor.sh")
  await Bun.write(program, `#!/bin/sh\necho ran >> "${path.join(path.dirname(victim), "ran").replaceAll("\\", "/")}"\n`)
  await fs.chmod(program, 0o755)
  expect(Bun.spawnSync(["git", "config", "core.fsmonitor", program.replaceAll("\\", "/")], { cwd: victim }).exitCode).toBe(0)
  await Bun.write(path.join(victim, "a.txt"), "two\n")
}

const where = process.platform === "win32" ? "cd" : "pwd"

const rows: ReadonlyArray<{
  readonly name: string
  readonly workflow: Workflow
  readonly node: string
  readonly key: string
  readonly fail?: (prompt: string) => boolean
  readonly value: (victim: string) => string
  // What else the clone ships before the resume, beside the rewritten value.
  readonly prepare?: (clone: string, victim: string) => Promise<void>
  // What the resume did with the value: true when it used it.
  readonly used: (
    resumed: Awaited<ReturnType<typeof run>>,
    seen: ReturnType<typeof recording>,
    victim: string,
  ) => boolean
}> = [
  {
    name: "the reviewer of a verify node",
    workflow: { name: "w", run: (ctx) => ctx.verify("v", { prompt: "x", judge: true, onError: "continue" }) },
    node: "v#1",
    key: "worktree",
    // The first run's reviewer fails, so that the resume runs it again rather than reusing it.
    fail: (prompt) => prompt.includes("Review a change another agent made"),
    value: (victim) => victim,
    used: (_, seen, victim) =>
      seen.created.some((item) => item.title.endsWith("v#1.judge") && item.directory === victim),
  },
  {
    name: "a check of a verify node",
    workflow: { name: "w", run: (ctx) => ctx.verify("v", { prompt: "x", checks: [where] }) },
    node: "v#1",
    key: "worktree",
    value: (victim) => victim,
    // The check prints the folder it ran in. The clone's path does not hold the word.
    used: (resumed) =>
      (resumed.output as { readonly checks: ReadonlyArray<{ readonly output: string }> }).checks[0].output.includes(
        "victim",
      ),
  },
  {
    name: "a member of a team",
    workflow: {
      name: "w",
      run: (ctx) =>
        ctx.team("t", {
          goal: "g",
          members: { lead: { role: "lead" }, coder: { role: "code" } },
          worktree: false,
          onError: "continue",
        }),
    },
    node: "t/lead#1",
    key: "session",
    // The coder's first turn fails, so that the resume goes on to the lead's next turn.
    fail: (prompt) => prompt.includes('You are "coder"'),
    value: () => "ses_victim",
    used: (_, seen) => seen.prompted.includes("ses_victim"),
  },
  {
    // The reviewer's prompt holds the diff of the reused iteration's worktree against the run's base commit. Both come
    // from the store, so the diff would start git in the folder it names, with that folder's config.
    name: "the review diff of a verify node",
    workflow: { name: "w", run: (ctx) => ctx.verify("v", { prompt: "x", judge: true, onError: "continue" }) },
    node: "v#1",
    key: "worktree",
    fail: (prompt) => prompt.includes("Review a change another agent made"),
    value: (victim) => victim,
    prepare: monitored,
    used: (_, __, victim) => existsSync(path.join(path.dirname(victim), "ran")),
  },
]

for (const row of rows)
  for (const trusted of [false, true])
    test(`a resume ${trusted ? "in a trusted folder uses" : "in an untrusted folder takes no"} ${row.key} from the run store for ${row.name}`, async () => {
      const { clone, victim } = await repositories(`${row.name.replace(/\W+/g, "-")}-${trusted}`)
      const file = path.join(clone, "w.ts")
      const first = await run({
        client: recording(row.fail).client,
        directory: clone,
        trusted,
        file,
        workflow: row.workflow,
      })
      rewrite(clone, row.node, row.key, row.value(victim))
      await row.prepare?.(clone, victim)

      const seen = recording()
      const resumed = await run({
        client: seen.client,
        directory: clone,
        trusted,
        file,
        workflow: row.workflow,
        resume: first.id,
      })

      expect({ row: row.name, trusted, used: row.used(resumed, seen, victim) }).toEqual({
        row: row.name,
        trusted,
        used: trusted,
      })
    }, 60_000)
