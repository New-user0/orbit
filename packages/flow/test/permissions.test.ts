import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadWorkflow, workflowApprovals } from "../src/load"
import { run } from "../src/runner"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-permissions-"))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

type Reply = {
  readonly sessionID?: string
  readonly requestID?: string
  readonly decision: string
  readonly message?: string
}

/**
 * The part of the server a run talks to. `effective` is what `config.effective` answers; the agent's one action asks
 * permission as soon as its prompt is sent, and the session ends once that ask has been answered.
 */
function server(effective: () => Promise<unknown>) {
  const replies: Reply[] = []
  const events: unknown[] = []
  let wake = () => {}
  let answered = () => {}
  const answer = new Promise<void>((resolve) => (answered = resolve))
  const client = {
    config: { effective },
    event: {
      async *subscribe(options: { signal: AbortSignal }) {
        options.signal.addEventListener("abort", () => wake())
        while (!options.signal.aborted) {
          const next = events.shift()
          if (next) yield next
          else await new Promise<void>((resolve) => (wake = resolve))
        }
      },
    },
    permission: {
      async reply(input: Reply) {
        replies.push(input)
        answered()
      },
    },
    session: {
      async create() {
        return { id: "ses_run" }
      },
      async get() {
        return {}
      },
      async prompt() {
        events.push({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_run" } })
        wake()
      },
      wait: () => answer,
      async interrupt() {},
    },
    shell: { list: async () => ({ data: [] }) },
    message: {
      async list() {
        return { data: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "done" }], tokens: {} }] }
      },
    },
  } as unknown as OrbitClient
  return { client, replies }
}

const cases = [
  { name: "managed settings leave bypass open", effective: { permissions: { bypass: true } }, approved: true },
  { name: "managed settings turn bypass off", effective: { permissions: { bypass: false } }, approved: false },
  { name: "the server does not report it", effective: {}, approved: false },
] as const

for (const item of cases) {
  for (const where of ["the node", "the run's default"] as const) {
    test(`answers an auto request by ${where} when ${item.name}`, async () => {
      const directory = await fs.mkdtemp(path.join(root, "run-"))
      const { client, replies } = server(async () => item.effective)
      const result = await run({
        client,
        directory,
        file: path.join(directory, "workflow.ts"),
        ...(where === "the run's default" ? { permissions: "auto" as const } : {}),
        workflow: {
          name: "permissions",
          run: (ctx) =>
            ctx.agent("work", {
              prompt: "go",
              worktree: false,
              ...(where === "the node" ? { permissions: "auto" as const } : {}),
            }),
        },
      })

      expect(result.status).toBe("succeeded")
      expect(replies).toHaveLength(1)
      if (item.approved)
        return expect(replies[0]).toMatchObject({ sessionID: "ses_run", requestID: "per_1", decision: "once" })
      expect(replies[0]).toMatchObject({ decision: "reject" })
      expect(replies[0]?.message).toContain("managed settings")
    })
  }
}

test("answers an auto request with a rejection when the server cannot be asked", async () => {
  const directory = await fs.mkdtemp(path.join(root, "run-"))
  const { client, replies } = server(async () => Promise.reject(new Error("offline")))
  await run({
    client,
    directory,
    file: path.join(directory, "workflow.ts"),
    workflow: {
      name: "permissions",
      run: (ctx) => ctx.agent("work", { prompt: "go", worktree: false, permissions: "auto" }),
    },
  })

  expect(replies[0]).toMatchObject({ decision: "reject" })
})

test("leaves a reject node as it was, with the unattended feedback and not the managed one", async () => {
  const directory = await fs.mkdtemp(path.join(root, "run-"))
  const { client, replies } = server(async () => ({ permissions: { bypass: false } }))
  await run({
    client,
    directory,
    file: path.join(directory, "workflow.ts"),
    workflow: { name: "permissions", run: (ctx) => ctx.agent("work", { prompt: "go", worktree: false }) },
  })

  expect(replies[0]).toMatchObject({ decision: "reject" })
  expect(replies[0]?.message).not.toContain("managed settings")
})

// Every node that `workflowApprovals` lists for a YAML file is one that the runner answers with `auto`, so each of them
// must get the managed rejection when bypass is off. A node the list misses would be approved without the check.
const yamlRows = [
  {
    id: "work",
    file: ["name: w", "nodes:", "  - id: work", "    prompt: go", "    worktree: false", "    permissions: auto"],
  },
  {
    id: "work",
    file: [
      "name: w",
      "nodes:",
      "  - id: work",
      "    type: verify",
      "    prompt: go",
      "    worktree: false",
      "    permissions: auto",
      "    checks: []",
    ],
  },
  {
    id: "crew/lead",
    file: [
      "name: w",
      "nodes:",
      "  - id: crew",
      "    type: team",
      "    goal: go",
      "    worktree: false",
      "    maxRounds: 1",
      "    members:",
      "      lead:",
      "        permissions: auto",
    ],
  },
]

for (const row of yamlRows) {
  test(`gives ${row.id} of a YAML file the managed rejection when workflowApprovals lists it`, async () => {
    const directory = await fs.mkdtemp(path.join(root, "run-"))
    const file = path.join(directory, "workflow.yaml")
    await Bun.write(file, row.file.join("\n") + "\n")
    expect((await workflowApprovals(file)).map((item) => item.id)).toEqual([row.id])

    const { client, replies } = server(async () => ({ permissions: { bypass: false } }))
    await run({ client, directory, file, workflow: await loadWorkflow(file) })

    expect(replies[0]).toMatchObject({ decision: "reject" })
    expect(replies[0]?.message).toContain("managed settings")
  })
}
