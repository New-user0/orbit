import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller, type TrustAnswer, type Update } from "../src/controller"
import type { TrustView } from "../src/protocol"
import { serve, until } from "./fixture/serve"

// trust-first part 2, D8 (owner, 2026-10-21: "match refrence"): as the reference does, a folder that is trusted is never
// asked about again. Its config loads as it is now, so a change after the grant neither asks the person nor holds the
// message back. Against a real `orb serve` that trusts a folder only when a grant says so, with a scripted model.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-trust-reference-")))
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

function chat(directory: string, answer: TrustAnswer) {
  const updates: Update[] = []
  const questions: TrustView[] = []
  const controller = new Controller(
    main.client,
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

test("a trusted folder whose config changed after the grant is not asked about again, and the message goes to the model", async () => {
  const repo = path.join(root, "work", "changed")
  await Bun.write(path.join(repo, "orbit.json"), JSON.stringify({ username: "before" }))
  const directory = await fs.realpath(repo)
  await main.client.location.trust.update({ location: { directory }, trust: true })
  await main.client.location.reload()

  // A pull adds a hook to the folder's settings after the grant. The model answers in text, so it never runs here.
  await Bun.write(
    path.join(directory, "orbit.json"),
    JSON.stringify({
      username: "after",
      hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo CLONE-HOOK-AFTER-GRANT" }] }] },
    }),
  )
  await main.client.location.reload()

  // "Not now", were it asked: then nothing would be sent, which is what the old question about the changes led to.
  const { controller, updates, questions } = chat(directory, "later")
  await Bun.sleep(500)
  const asked = steps.length
  await controller.send("hello")
  await until(() => (updates.some((update) => update.type === "busy" && !update.busy) ? true : undefined), 20_000)

  expect(questions).toEqual([])
  expect(steps.length).toBeGreaterThan(asked)
})
