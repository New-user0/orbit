import fs from "node:fs/promises"
import path from "node:path"

export type ScriptedRequest = {
  /** Whether the request is one step of the agent, which carries tools, and not a helper request such as a title. */
  readonly step: boolean
  readonly system: string
  /** The text of the last user message. */
  readonly user: string
  readonly body: { messages: Array<{ role: string; content?: unknown }> }
}

/**
 * A local OpenAI-compatible chat server that answers from a script and records what it was asked, for tests that run
 * the real `orb` against it. The Nth step of the agent (a request that carries tools) is answered with the Nth reply of
 * `replies`, or with the last one when the script is shorter; every other request is answered with "Title".
 *
 * `config` is the content of an orbit.json that points the ollama provider at it; the model is `ollama/scripted:1b`.
 */
export function scriptedModel(replies: ReadonlyArray<string> = ["ok"]) {
  const requests: ScriptedRequest[] = []
  const details = {
    format: "gguf",
    family: "llama",
    families: ["llama"],
    parameter_size: "1B",
    quantization_level: "Q4",
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/api/tags")
        return Response.json({
          models: [
            {
              name: "scripted:1b",
              model: "scripted:1b",
              modified_at: "2026-01-01T00:00:00Z",
              size: 1,
              digest: "d",
              details,
            },
          ],
        })
      if (pathname === "/api/show")
        return Response.json({
          parameters: "",
          capabilities: ["completion", "tools"],
          model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
          details: { parent_model: "", ...details },
        })
      if (pathname === "/api/ps") return Response.json({ models: [] })
      const body: ScriptedRequest["body"] & { tools?: unknown } = await request.json()
      const user = body.messages.findLast((message) => message.role === "user")?.content
      const entry = {
        step: Boolean(body.tools),
        system: String(body.messages.find((message) => message.role === "system")?.content ?? ""),
        user: typeof user === "string" ? user : JSON.stringify(user),
        body,
      }
      requests.push(entry)
      const text = entry.step ? (replies[Math.min(requests.filter((item) => item.step).length - 1, replies.length - 1)] ?? "ok") : "Title"
      const events = [
        { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]
      return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return {
    model: "ollama/scripted:1b",
    requests,
    /** The requests of the agent's steps. */
    get steps() {
      return requests.filter((request) => request.step)
    },
    /** Writes the config that points the provider at this server into `<root>/config`, where `isolatedEnv` looks. */
    async configure(root: string) {
      await fs.mkdir(path.join(root, "config"), { recursive: true })
      await Bun.write(
        path.join(root, "config", "orbit.json"),
        JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${server.port}/v1` } } } }),
      )
    },
    stop: () => server.stop(true),
  }
}
