import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@orbit/client"
import { rewindPrompts } from "../src/routes/session/dialog-rewind"

// The rewind picker's rows and the revision each one asks its stats again by (clients-ux-5 part 2). The session route
// rebuilds them on every change to the conversation while the picker is open, so they are built in one walk.

const user = (id: string, text: string): SessionMessageInfo => ({ id, type: "user", text, time: { created: 1 } })
const reply = (id: string, completed: number | undefined, tools: ("completed" | "error" | "running")[]) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: 1, completed },
    content: [
      { type: "text", text: "Working on it." },
      ...tools.map((status, index) => ({
        type: "tool" as const,
        id: `${id}_tool_${index}`,
        name: "edit",
        time: { created: 1 },
        state:
          status === "running"
            ? { status, input: {}, metadata: {} }
            : status === "completed"
              ? {
                  status,
                  input: {},
                  content: [{ type: "text" as const, text: "done" }] as [{ type: "text"; text: string }],
                }
              : { status, input: {}, error: { type: "unknown", message: "failed" } },
      })),
    ],
  }) as SessionMessageInfo
const shell = (id: string, command: string, completed?: number): SessionMessageInfo => ({
  id,
  type: "shell",
  shellID: `sh_${id}`,
  command,
  status: completed === undefined ? "running" : "exited",
  time: { created: 1, completed },
})
const switched = (id: string): SessionMessageInfo => ({
  id,
  type: "location-switched",
  location: { directory: "/elsewhere" },
  time: { created: 1 },
})

// A row's range runs to the next user message, through a `!` command run during a reply; its revision names every
// message in that range (a reply with the time it completed and how many of its tool calls finished, a command with
// the time it completed) and then each folder switch after the range.
test("each prompt and `!` command is a row whose revision covers its range and the folder switches after it", () => {
  const list = [
    user("u1", "One"),
    reply("a1", 10, ["completed", "error", "running"]),
    switched("l1"),
    shell("s1", "git status", 20),
    user("u2", "Two"),
    reply("a2", undefined, []),
    switched("l2"),
    user("u3", "Three"),
    shell("s2", "ls"),
    switched("l3"),
  ]
  expect(rewindPrompts(list)).toEqual([
    { id: "u1", text: "One", created: 1, revision: "a1:10:2 l1 s1:20 u2 l2 l3" },
    { id: "s1", text: "git status", created: 1, shell: true, revision: "u2 l2 l3" },
    { id: "u2", text: "Two", created: 1, revision: "a2::0 l2 u3 l3" },
    { id: "u3", text: "Three", created: 1, revision: "s2: l3" },
    { id: "s2", text: "ls", created: 1, shell: true, revision: "l3" },
  ])
  expect(rewindPrompts([])).toEqual([])
})

// A scan of the rest of the conversation per message took seconds at this length; one walk takes milliseconds.
test("the rows of a long conversation are built in one walk", () => {
  const list = Array.from({ length: 10_000 }, (_, index) => [
    user(`u${index}`, `Prompt ${index}`),
    reply(`a${index}`, index, ["completed"]),
  ]).flat()
  const started = performance.now()
  const rows = rewindPrompts([...list, switched("last")])
  const elapsed = performance.now() - started
  expect(rows).toHaveLength(10_000)
  expect(rows[0].revision).toBe("a0:0:1 u1 last")
  expect(rows.at(-1)?.revision).toBe("a9999:9999:1 last")
  expect(elapsed).toBeLessThan(1000)
})
