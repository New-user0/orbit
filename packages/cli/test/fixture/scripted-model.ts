import fs from "node:fs/promises"
import path from "node:path"

export type ScriptedRequest = {
  /**
   * Whether the request is one step of the agent, which carries tools it may call, and not a helper request such as a
   * title. A side query that sends the session's history carries the tools too, with `tool_choice: "none"`, and is not
   * a step.
   */
  readonly step: boolean
  readonly system: string
  /** The text of the last user message. */
  readonly user: string
  readonly body: {
    model?: string
    messages: Array<{ role: string; content?: unknown }>
    tools?: unknown
    tool_choice?: unknown
  }
}

/**
 * A local OpenAI-compatible chat server that answers from a script and records what it was asked, for tests that run
 * the real `orb` against it. The Nth step of the agent (a request that carries tools) is answered with the Nth reply of
 * `replies`, or with the last one when the script is shorter; every other request is answered by `helper`, or with
 * "Title".
 *
 * `config` is the content of an orbit.json that points the ollama provider at it; the model is `ollama/scripted:1b`.
 */
export type ScriptedReply =
  | string
  | {
      /** The text, sent as one chunk per element, so a client sees the answer stream. With `tool`, the text comes first. */
      readonly chunks?: ReadonlyArray<string>
      /** A tool call to make instead of answering; the model is asked again with its result. */
      readonly tool?: { readonly name: string; readonly input: unknown }
      /** The finish reason of the step, such as "content_filter" for a step the runner counts as failed. */
      readonly finish?: string
      /** Wait this long before answering, so a slow start such as an MCP server connecting is over by the next request. */
      readonly delayMs?: number
    }

export function scriptedModel(
  replies: ReadonlyArray<ScriptedReply> = ["ok"],
  contextLength = 32_768,
  /** Called for each request before it is answered, so a test can look at the machine while the run is in progress. */
  observe?: (request: ScriptedRequest) => void | Promise<void>,
  /** Names of further models the server lists next to `scripted:1b`, for a test that switches models. */
  extraModels: ReadonlyArray<string> = [],
  /** Answers a request that is not a step; no function, or an undefined answer, answers "Title". */
  helper?: (request: ScriptedRequest) => ScriptedReply | undefined,
) {
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
          models: ["scripted:1b", ...extraModels].map((name) => ({
            name,
            model: name,
            modified_at: "2026-01-01T00:00:00Z",
            size: 1,
            digest: "d",
            details,
          })),
        })
      if (pathname === "/api/show")
        return Response.json({
          parameters: "",
          capabilities: ["completion", "tools"],
          model_info: { "general.architecture": "llama", "llama.context_length": contextLength },
          details: { parent_model: "", ...details },
        })
      if (pathname === "/api/ps") return Response.json({ models: [] })
      const body: ScriptedRequest["body"] = await request.json()
      const user = body.messages.findLast((message) => message.role === "user")?.content
      const entry = {
        step: Boolean(body.tools) && body.tool_choice !== "none",
        system: String(body.messages.find((message) => message.role === "system")?.content ?? ""),
        user: typeof user === "string" ? user : JSON.stringify(user),
        body,
      }
      requests.push(entry)
      await observe?.(entry)
      const reply = entry.step
        ? (replies[Math.min(requests.filter((item) => item.step).length - 1, replies.length - 1)] ?? "ok")
        : (helper?.(entry) ?? "Title")
      const scripted = typeof reply === "string" ? { chunks: [reply] } : reply
      if ("delayMs" in scripted && scripted.delayMs) await Bun.sleep(scripted.delayMs)
      const text = (scripted.chunks ?? []).map((chunk, index) => ({
        choices: [
          {
            index: 0,
            delta: { ...(index === 0 ? { role: "assistant" } : {}), content: chunk },
            finish_reason: null,
          },
        ],
      }))
      const events = [
        ...text,
        ...(scripted.tool
          ? [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${requests.length}`,
                          type: "function",
                          function: { name: scripted.tool.name, arguments: JSON.stringify(scripted.tool.input) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
            ]
          : []),
        {
          choices: [{ index: 0, delta: {}, finish_reason: scripted.finish ?? (scripted.tool ? "tool_calls" : "stop") }],
        },
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
