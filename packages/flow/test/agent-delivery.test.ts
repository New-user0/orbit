import { expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { attempt } from "../src/agent"

// `session.wait` can resolve before the execution has taken a prompt that was admitted a moment after the last one
// ended; the reply is then not there yet and the attempt must not read the history as "no reply".
function client(queuedReads: number) {
  let reads = 0
  let waits = 0
  const fake = {
    session: {
      create: async () => ({ id: "ses_1" }),
      prompt: async () => ({ id: "msg_prompt" }),
      wait: async () => {
        waits++
      },
      inbox: {
        list: async () => (reads++ < queuedReads ? [{ id: "msg_prompt" }] : []),
      },
    },
    shell: { list: async () => ({ data: [] }) },
    message: {
      list: async () => ({
        data:
          reads > queuedReads
            ? [{ id: "msg_reply", type: "assistant", content: [{ type: "text", text: "ok" }], tokens: {}, cost: 0 }]
            : [],
      }),
    },
  }
  return { client: fake as unknown as OrbitClient, waits: () => waits }
}

const input = { directory: "/work", title: "t", prompt: "say ok", started: () => {} }

test.each([0, 1, 3])("an attempt reads the reply after a prompt that stayed queued for %i checks", async (queued) => {
  const fake = client(queued)
  const result = await attempt(fake.client, input)
  expect(result.error).toBeUndefined()
  expect(result.text).toBe("ok")
  expect(fake.waits()).toBe(queued + 1)
})
