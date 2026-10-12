import { expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { attempt } from "../src/agent"

// A command the model moved to the background outlives the step that started it, and its notice starts another step.
// An agent node reads its reply only after both, for every kind of node that goes through `attempt`.
function client(input: { runningPolls: number; otherSession?: boolean }) {
  let polls = 0
  const ended = () => !input.otherSession && input.runningPolls > 0 && polls > input.runningPolls
  const assistant = (id: string, text: string) => ({
    id,
    type: "assistant",
    content: [{ type: "text", text }],
    tokens: {},
    cost: 0,
  })
  const fake = {
    session: {
      create: async () => ({ id: "ses_1" }),
      prompt: async () => ({ id: "msg_prompt" }),
      wait: async () => {},
      inbox: { list: async () => [] },
    },
    shell: {
      list: async () => {
        polls++
        return {
          data:
            polls <= input.runningPolls
              ? [
                  {
                    id: "shl_1",
                    status: "running",
                    metadata: { sessionID: input.otherSession ? "ses_other" : "ses_1" },
                  },
                ]
              : [],
        }
      },
    },
    message: {
      list: async () => ({
        data: ended()
          ? [
              assistant("msg_after", "AFTER-NOTIFICATION"),
              {
                id: "msg_notice",
                type: "synthetic",
                metadata: { source: "shell", shellID: "shl_1", state: "completed" },
              },
              assistant("msg_before", "WAITING-TEXT"),
            ]
          : [assistant("msg_before", "WAITING-TEXT")],
        cursor: { next: null },
      }),
    },
  }
  return fake as unknown as OrbitClient
}

const input = { directory: "/work", title: "t", prompt: "run it", started: () => {} }

test.each([
  ["a command still running when the step ends", 2, false, "AFTER-NOTIFICATION"],
  ["a command that ended before the first poll", 0, false, "WAITING-TEXT"],
  ["a command of another session", 2, true, "WAITING-TEXT"],
] as const)("an attempt with %s reads the reply after the notice", async (_name, runningPolls, otherSession, text) => {
  const result = await attempt(client({ runningPolls, otherSession }), input)
  expect(result.error).toBeUndefined()
  expect(result.text).toBe(text)
}, 20_000)
