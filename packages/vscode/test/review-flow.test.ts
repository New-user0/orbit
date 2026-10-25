// clients-ux-15 part 2, the chat's side of the in-diff review, against a real `orb serve` that trusts a folder only by a
// grant, with a scripted model and a real repository. An approval says whether it takes the person's own version of the
// file; a reply with that version reaches the server, which writes it; a reply the server refuses leaves the card
// pending and says why (class 13). The folder a review checks is the asking session's own as the server names it, and
// none while the folder is not trusted (classes 1 and 3). Each prompt that goes out tells the host to close its review
// tabs. A prompt's changes come from the server's per-prompt diff, and a restore is the server's dry run, the person's
// confirm, then the server's rewind: the extension writes nothing itself (class 12). The transport is the real one,
// recorded, so a test can say which routes the chat called.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { Orbit } from "@orbit/client"
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller, type TrustAnswer, type Update } from "../src/controller"
import type { Item } from "../src/protocol"
import { serve } from "./fixture/serve"

setDefaultTimeout(120_000)

// What part 2 adds to the controller, its updates and its items. The tests reach them through these widened types, so the
// file typechecks before the build (when the calls fail) and after it.
type Spec = {
  reply(id: string, decision: "once" | "always" | "reject", content?: string): Promise<boolean>
  folder(sessionID: string): Promise<string | undefined>
  changes(messageID: string): Promise<ReadonlyArray<Record<string, unknown>> | undefined>
  restore(messageID: string, confirm: (question: unknown) => Promise<boolean>): Promise<void>
}
type SpecUpdate = Update | { readonly type: "prompt" }
type SpecItem = Item & { readonly messageID?: string; readonly revisable?: boolean }

// The scripted model: a prompt `CALL {"name":…,"arguments":…}` makes it call that tool once; anything else, and a tool
// result, ends the step with a line of text.
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { tools?: unknown; messages?: Array<{ role: string; content?: unknown }> }
    if (!body.tools) return sse([{ delta: { content: "Title" } }], "stop")
    const last = body.messages?.at(-1)
    const texts =
      last?.role !== "user"
        ? []
        : typeof last.content === "string"
          ? [last.content]
          : Array.isArray(last.content)
            ? last.content.flatMap((part: { text?: unknown }) => (typeof part.text === "string" ? [part.text] : []))
            : []
    const call = texts.map((item) => /^CALL (\{.*\})$/s.exec(item.trim())?.[1]).find((item) => item !== undefined)
    if (!call) return sse([{ delta: { content: "Done." } }], "stop")
    const parsed = JSON.parse(call) as { name: string; arguments: unknown }
    return sse(
      [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
              },
            ],
          },
        },
      ],
      "tool_calls",
    )
  },
})

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-review-")))
let main: Awaited<ReturnType<typeof serve>>
const opened: Controller[] = []
const patient = { read: 20_000, grant: 20_000 }

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      model: "test/test-model",
      // Every call asks, so each test has a question to answer.
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
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
    }),
  )
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

test("an Edit or Write approval says it takes the person's own version; a Glob approval does not", async () => {
  const chat = await open(await repo(), "trust")

  await chat.controller.send(call("Write", { file_path: "a.txt", content: "proposed\n" }))
  const write = await chat.pending()
  // The base drops the request's `revisable` from the chat item.
  expect(write.revisable).toBe(true)
  await chat.controller.reply(write.id, "once")
  await chat.idle()

  await chat.controller.send(call("Glob", { pattern: "*.txt" }))
  const glob = await chat.pending()
  expect(glob.revisable).toBe(false)
  await chat.controller.reply(glob.id, "once")
  await chat.idle()
})

test("a once reply with the person's version writes that version, and the card shows it allowed", async () => {
  const directory = await repo()
  const chat = await open(directory, "trust")

  await chat.controller.send(call("Write", { file_path: "b.txt", content: "proposed\n" }))
  const request = await chat.pending()
  const taken = await chat.controller.reply(request.id, "once", "revised\n")
  await chat.idle()

  // The base sends no content, so the proposal is written.
  expect(await fs.readFile(path.join(directory, "b.txt"), "utf8")).toBe("revised\n")
  expect(taken).toBe(true)
  expect(chat.items.get(request.id)).toMatchObject({ status: "once" })
})

test("a refused answer leaves the card pending and says why, and a plain answer is taken after it", async () => {
  const chat = await open(await repo(), "trust")

  await chat.controller.send(call("Glob", { pattern: "*.txt" }))
  const request = await chat.pending()
  // A version of the file on a question that is not an Edit or Write: the server refuses it with a typed 400. The base
  // never sends the content, so the server takes a plain once.
  const taken = await chat.controller.reply(request.id, "once", "revised\n")

  expect(chat.items.get(request.id)).toMatchObject({ status: "pending" })
  expect(taken).toBe(false)
  const note = [...chat.items.values()].find((item) => item.type === "note" && item.tone === "error")
  expect(note).toMatchObject({ type: "note", tone: "error" })
  if (note?.type !== "note") throw new Error("no note")
  expect(note.text).toContain("only an Edit or Write approval does")

  expect(await chat.controller.reply(request.id, "once")).toBe(true)
  expect(chat.items.get(request.id)).toMatchObject({ status: "once" })
  await chat.idle()
})

test("the folder a review checks is the asking session's own, as the server names it, and none while untrusted", async () => {
  const directory = await repo()
  const chat = await open(directory, "trust")

  await chat.controller.send(call("Write", { file_path: "f.txt", content: "f\n" }))
  const request = await chat.pending()
  const session = await main.client.session.get({ sessionID: request.sessionID })
  expect(await chat.controller.folder(request.sessionID)).toBe(session.location.directory)
  expect(path.relative(directory, session.location.directory)).toBe("")
  await chat.controller.reply(request.id, "once")
  await chat.idle()

  // Once the folder is no longer trusted, there is no folder to check against, so Open diff reads nothing.
  await main.client.location.trust.update({ location: { directory }, trust: false, persist: true })
  expect(
    await until(async () => ((await chat.controller.folder(request.sessionID)) === undefined ? true : undefined)),
  ).toBe(true)
})

test("each prompt the chat sends tells the host to close its tabs, and a refused one does not", async () => {
  const trusted = await open(await repo(), "trust")
  await trusted.controller.send("hello")
  await trusted.idle()
  const kinds = trusted.updates.map((update) => update.type)
  // Once per prompt that goes out, before the work starts.
  expect(kinds.filter((kind) => kind === "prompt")).toHaveLength(1)
  const working = trusted.updates.findIndex((update) => update.type === "busy" && update.busy)
  expect(kinds.indexOf("prompt")).toBeGreaterThan(-1)
  expect(kinds.indexOf("prompt")).toBeLessThan(working)

  const refused = await open(await repo(), "later")
  await refused.controller.send("hello")
  await until(() => (refused.questions.length > 0 ? true : undefined))
  await Bun.sleep(500)
  expect(refused.updates.some((update) => update.type === "prompt")).toBe(false)
})

test("a prompt's user item carries its message ID, and Changes rebuilds both sides from the server's per-prompt diff", async () => {
  const directory = await repo()
  const chat = await open(directory, "trust")

  await chat.controller.send(call("Write", { file_path: "c.txt", content: "one\ntwo\n" }))
  await chat.controller.reply((await chat.pending()).id, "once")
  await chat.idle()

  const user = [...chat.items.values()].find((item) => item.type === "user")
  if (user?.type !== "user") throw new Error("no user item")
  const sessionID = (await chat.controller.sessions())[0]?.id ?? ""
  const history = (await main.client.message.list({ sessionID, limit: 50, order: "asc" })).data
  // The base gives the user item a random ID and no message ID.
  expect(user.messageID).toBe(history.find((message) => message.type === "user")?.id)

  const shown = await chat.controller.changes(user.messageID ?? "")
  expect(shown).toMatchObject([{ file: "c.txt", status: "added", before: "", after: "one\ntwo\n" }])
  expect(chat.requests.some((request) => request.path === `/api/session/${sessionID}/diff`)).toBe(true)

  // A session opened from history gives its prompts' message IDs too.
  const other = await open(directory, "trust")
  await other.controller.open(sessionID)
  const replayed = [...other.items.values()].find((item) => item.type === "user")
  expect(replayed).toMatchObject({ type: "user", messageID: user.messageID })
})

test("a restore runs the dry run, asks with its files and totals, and changes files only after confirm", async () => {
  const directory = await repo()
  const chat = await open(directory, "trust")
  await chat.controller.send(call("Write", { file_path: "d.txt", content: "one\ntwo\n" }))
  await chat.controller.reply((await chat.pending()).id, "once")
  await chat.idle()
  const user = [...chat.items.values()].find((item) => item.type === "user")
  if (user?.type !== "user" || !user.messageID) throw new Error("no message ID")
  const created = path.join(directory, "d.txt")
  const rewinds = () => chat.requests.filter((request) => request.path.endsWith("/revert/files"))

  // Declined: the dry run went out, the question named the file and its totals, and nothing else was sent.
  const asked: unknown[] = []
  await chat.controller.restore(user.messageID, async (question) => {
    asked.push(question)
    return false
  })
  expect(asked).toHaveLength(1)
  expect(JSON.stringify(asked[0])).toContain("d.txt")
  expect(JSON.stringify(asked[0])).toMatch(/[-−]2\b/)
  expect(rewinds().map((request) => JSON.parse(request.body ?? "{}").dryRun)).toEqual([true])
  expect(await Bun.file(created).exists()).toBe(true)

  // Confirmed: the dry run again, then the rewind, which the server performs.
  await chat.controller.restore(user.messageID, async () => true)
  expect(rewinds().map((request) => JSON.parse(request.body ?? "{}").dryRun)).toEqual([true, true, undefined])
  expect(await Bun.file(created).exists()).toBe(false)
  expect(await fs.readFile(path.join(directory, "tracked.txt"), "utf8")).toBe("tracked\n")
  expect([...chat.items.values()].some((item) => item.type === "note" && item.text.includes("Restored"))).toBe(true)
})

test("no changes view or restore while the folder is not trusted, and the server sees neither", async () => {
  const directory = await repo()
  const chat = await open(directory, "trust")
  await chat.controller.send(call("Write", { file_path: "u.txt", content: "u\n" }))
  const request = await chat.pending()
  await chat.controller.reply(request.id, "once")
  await chat.idle()
  const user = [...chat.items.values()].find((item) => item.type === "user")
  if (user?.type !== "user" || !user.messageID) throw new Error("no message ID")

  await main.client.location.trust.update({ location: { directory }, trust: false, persist: true })
  await until(async () => ((await chat.controller.folder(request.sessionID)) === undefined ? true : undefined))
  const before = chat.requests.length

  expect(await chat.controller.changes(user.messageID)).toBeUndefined()
  let asked = false
  await chat.controller.restore(user.messageID, async () => {
    asked = true
    return true
  })

  expect(asked).toBe(false)
  const sent = chat.requests.slice(before).map((item) => item.path)
  expect(sent.filter((item) => item.endsWith("/diff") || item.endsWith("/revert/files"))).toEqual([])
  expect(await Bun.file(path.join(directory, "u.txt")).exists()).toBe(true)
  expect(
    [...chat.items.values()].filter((item) => item.type === "note" && item.text.includes("not trusted")).length,
  ).toBeGreaterThanOrEqual(2)
})

let count = 0
// A repository with one tracked file, so the server takes checkpoints of it.
async function repo() {
  const directory = path.join(root, "work", `repo-${++count}`)
  await Bun.write(path.join(directory, "tracked.txt"), "tracked\n")
  await $`git init -q`.cwd(directory).quiet()
  await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
  return fs.realpath(directory)
}

async function open(directory: string, answer: TrustAnswer) {
  const updates: SpecUpdate[] = []
  const items = new Map<string, SpecItem>()
  const questions: unknown[] = []
  const requests: { method: string; path: string; body?: string }[] = []
  const client = Orbit.make({
    baseUrl: main.url,
    headers: { authorization: `Basic ${btoa("orbit:secret")}` },
    // The real transport, recorded: which routes the chat calls, and with what.
    fetch: ((input: string | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return fetch(input, init)
    }) as typeof fetch,
  })
  const controller = new Controller(
    client,
    directory,
    (update) => {
      updates.push(update)
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    async (trust) => {
      questions.push(trust)
      return answer
    },
    patient,
  )
  opened.push(controller)
  // The event stream must be connected before the prompt so no event is missed.
  await Bun.sleep(500)
  return {
    controller: controller as unknown as Omit<Controller, "reply"> & Spec,
    updates,
    items,
    questions,
    requests,
    async pending() {
      const found = await until(() =>
        [...items.values()].find(
          (item): item is Extract<SpecItem, { type: "permission" }> =>
            item.type === "permission" && item.status === "pending",
        ),
      )
      if (!found) throw new Error("no question was asked")
      return found
    },
    // The chat says it is no longer busy and the server runs none of its sessions. Another test's question that was never
    // answered keeps that test's session running, so only this chat's own sessions count.
    async idle() {
      await until(async () => {
        const last = updates.findLast((update) => update.type === "busy")
        if (last?.type !== "busy" || last.busy) return undefined
        const active = await main.client.session.active()
        const own = await controller.sessions()
        return own.some((item) => active[item.id] !== undefined) ? undefined : true
      })
    },
  }
}

// Polls `read` until it answers something, for as long as `timeout` allows.
async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  return undefined
}

function call(name: string, args: Record<string, unknown>) {
  return `CALL ${JSON.stringify({ name, arguments: args })}`
}

function sse(deltas: Array<{ delta: Record<string, unknown> }>, finish: string) {
  const chunks = [
    ...deltas.map((item) => ({ choices: [{ index: 0, delta: item.delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
