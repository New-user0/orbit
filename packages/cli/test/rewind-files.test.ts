import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// clients-ux-5: `orb run --rewind-files <prompt id>` and `orb -p --rewind-files <prompt id>` put back the files that the
// session's own file tools changed since that prompt's work began, through the server's code-only rewind, and exit. It
// needs a session to name (`--session`, `--continue` or `--resume`), refuses a prompt beside it, and a refusal exits 1
// with its reason on standard error. A real private server, a scripted model and a real git repository; the model writes
// `created.txt` with the Write tool when asked.
const model = "ollama/rewind:1b"
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "rewind:1b", model: "rewind:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
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
    const body: { tools?: unknown; messages: Array<{ role: string; content?: unknown }> } = await request.json()
    const last = body.messages.at(-1)
    const writes = body.tools && last?.role === "user" && JSON.stringify(last.content).includes("write created.txt")
    const delta = writes
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_write",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: "created.txt", content: "created\n" }),
              },
            },
          ],
        }
      : { role: "assistant", content: body.tools ? "done" : "Rewind" }
    const events = [
      { choices: [{ index: 0, delta }] },
      { choices: [{ index: 0, delta: {}, finish_reason: writes ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-rewind-cli-")))
const repo = path.join(root, "repo")

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      model,
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } },
    }),
  )
  await Bun.write(path.join(repo, "keep.txt"), "keep\n")
  expect((await spawned(["git", "init", "--quiet"], repo)).code).toBe(0)
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("rewinds the file a prompt's Write created, through orb run and orb -p, and refuses misuse", async () => {
  const wrote = await orb(["run", "--standalone", "--model", model, "write created.txt"])
  expect(wrote.code).toBe(0)
  expect(await Bun.file(path.join(repo, "created.txt")).text()).toBe("created\n")
  const rows = () => {
    const db = new Database(path.join(root, "orbit.db"), { readonly: true })
    const result = db
      .query<
        { id: string; session_id: string; type: string },
        []
      >("select id, session_id, type from session_message order by seq")
      .all()
    db.close()
    return result
  }
  const prompt = rows().find((row) => row.type === "user")!
  const step = rows().find((row) => row.type === "assistant")!
  const count = rows().length

  // Misuse is refused before anything changes: no session named, a prompt beside the flag, a message that is no prompt.
  const unnamed = await orb(["run", "--standalone", "--rewind-files", prompt.id])
  expect({ code: unnamed.code, mentions: unnamed.stderr.includes("--session") }).toEqual({ code: 1, mentions: true })
  const prompted = await orb(["run", "--standalone", "--session", prompt.session_id, "--rewind-files", prompt.id, "go"])
  expect({ code: prompted.code, mentions: prompted.stderr.includes("prompt") }).toEqual({ code: 1, mentions: true })
  const notPrompt = await orb(["run", "--standalone", "--session", prompt.session_id, "--rewind-files", step.id])
  expect({ code: notPrompt.code, mentions: notPrompt.stderr.includes(step.id) }).toEqual({ code: 1, mentions: true })
  expect(await Bun.file(path.join(repo, "created.txt")).exists()).toBe(true)

  const rewound = await orb(["run", "--standalone", "--session", prompt.session_id, "--rewind-files", prompt.id])
  expect({ code: rewound.code, mentions: rewound.stdout.includes(prompt.id) }).toEqual({ code: 0, mentions: true })
  expect({
    created: await Bun.file(path.join(repo, "created.txt")).exists(),
    keep: await Bun.file(path.join(repo, "keep.txt")).text(),
    // Code only: the conversation keeps every message, and no prompt was sent.
    messages: rows().length,
  }).toEqual({ created: false, keep: "keep\n", messages: count })

  // The print door takes the same flag; with nothing left to change it still succeeds.
  const printed = await orb(["-p", "--standalone", "--resume", prompt.session_id, "--rewind-files", prompt.id])
  expect(printed.code).toBe(0)
  expect(rows().length).toBe(count)
}, 300_000)

async function orb(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { USERPROFILE: root, PWD: repo, ORBIT_CONFIG_CONTENT: undefined }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return finished(child, `orb ${args.join(" ")}`, 120_000)
}

const spawned = (command: string[], cwd: string) =>
  finished(Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), command.join(" "), 60_000)

// Waits for a child for `limit` milliseconds at most, and names the command and what it printed when it does not end.
async function finished(child: Bun.Subprocess<"ignore", "pipe", "pipe">, command: string, limit: number) {
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const timer = setTimeout(() => child.kill("SIGKILL"), limit)
  const [stdout, stderr, code] = await output
  clearTimeout(timer)
  if (child.signalCode === "SIGKILL")
    throw new Error(`${command} did not end within ${limit / 1000} s:\n${stdout}\n${stderr}`)
  return { code, stdout, stderr }
}
