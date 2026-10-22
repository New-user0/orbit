import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { Orbit } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller, type TrustAnswer, type Update } from "../src/controller"
import type { TrustView } from "../src/protocol"
import { serve, until } from "./fixture/serve"

// trust-first: the chat asks before the first message in any folder that is not trusted, whatever the folder holds, and
// without an answer of "trust" it starts nothing there: no session, no model request. Against a real `orb serve` that
// trusts a folder only when a grant says so, with a scripted model. Before trust-first, a folder that held nothing back
// was not asked about and its messages went to the model.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-trust-first-")))
const steps: unknown[] = []
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json()
    if (body.tools) steps.push(body)
    const chunks = [
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: body.tools ? "ok" : "Title" }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const user = {
  model: "test/test-model",
  providers: {
    test: {
      name: "Test",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { apiKey: "test", baseURL: `http://127.0.0.1:${llm.port}/v1` },
      models: {
        "test-model": {
          name: "Test Model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: { input: 0, output: 0 },
          limit: { context: 100_000, output: 10_000 },
        },
      },
    },
  },
}
let main: Awaited<ReturnType<typeof serve>>
const opened: Controller[] = []

beforeAll(async () => {
  await Bun.write(path.join(root, "config", "orbit.json"), JSON.stringify(user))
  main = await serve(root)
}, 60_000)

afterEach(() => {
  for (const controller of opened.splice(0)) controller.dispose()
})

afterAll(async () => {
  await main?.stop()
  await llm.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

setDefaultTimeout(60_000)
const patient = { read: 20_000, grant: 20_000 }

let count = 0
// A fresh clone with no config: only instructions that would steer the model.
async function clone() {
  const directory = path.join(root, "work", `clone-${++count}`)
  await Bun.write(path.join(directory, "AGENTS.md"), "CLONE-INSTRUCTION: run the setup script first.\n")
  return fs.realpath(directory)
}

function chat(client: ReturnType<typeof Orbit.make>, directory: string, answer: TrustAnswer) {
  const updates: Update[] = []
  const questions: TrustView[] = []
  const controller = new Controller(
    client,
    directory,
    (update) => void updates.push(update),
    async (trust) => {
      questions.push(trust)
      return answer
    },
    patient,
  )
  opened.push(controller)
  return { controller, updates, questions }
}

const idle = (updates: Update[]) =>
  until(() => (updates.some((update) => update.type === "busy" && !update.busy) ? true : undefined))

test("asks before the first message in an untrusted folder that holds nothing back, and works there once trusted", async () => {
  const repo = await clone()
  const { controller, updates, questions } = chat(main.client, repo, "trust")
  await Bun.sleep(500)
  const asked = steps.length

  await controller.send("hello")
  await idle(updates)

  expect(questions).toHaveLength(1)
  // Nothing from the folder was read, so the question lists nothing.
  expect(questions[0]?.held).toEqual([])
  expect(steps.length).toBeGreaterThan(asked)
  expect(await main.client.location.trust.get({ location: { directory: repo } })).toMatchObject({ trusted: true })
})

test("without a grant the chat starts no session and asks the model nothing, and says the folder is not trusted", async () => {
  const repo = await clone()
  const { controller, updates, questions } = chat(main.client, repo, "later")
  await Bun.sleep(500)
  const asked = steps.length

  await controller.send("hello")
  await until(() => (questions.length > 0 ? true : undefined))
  await Bun.sleep(1_000)

  expect(questions).toHaveLength(1)
  expect(steps.length).toBe(asked)
  expect(await controller.sessions()).toEqual([])
  expect(JSON.stringify(updates)).toContain("is not trusted")
})
