import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller, limits, type TrustAnswer, type Update } from "../src/controller"
import type { TrustView } from "../src/protocol"
import { prompt } from "../src/trust"
import { serve, until } from "./fixture/serve"

// The chat against a real `orb serve` that trusts a folder only when a grant says so, which is how the shared background
// service behaves, with a scripted model. Whether a folder is trusted is the server's to say: these tests check that the
// chat asks it, shows what it answers, asks the person once before work starts, and trusts the folder it showed.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-trust-")))
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
// The settings of a project that guards its files: a hook blocks every write. It is what a clone can bring that runs code.
const guard = { hooks: { PreToolUse: [{ matcher: "write", hooks: [{ type: "command", command: "exit 2" }] }] } }
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

let count = 0
// A folder to open in the chat: with the settings of a project that guards its files, and as a git repository, if asked.
async function folder(options: { config?: boolean; git?: boolean; in?: string } = {}) {
  const directory = path.join(options.in ?? path.join(root, "work"), `folder-${++count}`)
  await fs.mkdir(directory, { recursive: true })
  if (options.git) expect(Bun.spawnSync(["git", "init", "--quiet", directory]).exitCode).toBe(0)
  if (options.config) await Bun.write(path.join(directory, "orbit.json"), JSON.stringify(guard))
  return fs.realpath(directory)
}

type Answer = TrustAnswer | ((trust: TrustView) => TrustAnswer | Promise<TrustAnswer>)

// A chat in `directory`: what it told the window, and every question it asked the person, answered as `answer` says.
function chat(client: ReturnType<typeof Orbit.make>, directory: string, answer: Answer = "later", wait = limits) {
  const updates: Update[] = []
  const questions: TrustView[] = []
  const controller = new Controller(
    client,
    directory,
    (update) => void updates.push(update),
    async (trust) => {
      questions.push(trust)
      return typeof answer === "function" ? answer(trust) : answer
    },
    wait,
  )
  opened.push(controller)
  return { controller, updates, questions }
}

const trusts = (updates: Update[]) => updates.flatMap((update) => (update.type === "trust" ? [update] : []))
const logs = (updates: Update[]) => updates.flatMap((update) => (update.type === "log" ? [update.text] : []))
const notes = (updates: Update[]) =>
  updates.flatMap((update) => (update.type === "item" && update.item.type === "note" ? [update.item] : []))
// The answer that the window shows now, once there is one.
const shown = (updates: Update[]) => until(() => trusts(updates).at(-1))
const idle = (updates: Update[], times = 1) =>
  until(() => (updates.filter((update) => update.type === "busy" && !update.busy).length >= times ? true : undefined))
const same = (left: string, right: string) => path.relative(left, right) === ""

test("shows what an untrusted folder holds back, as the server names it", async () => {
  const repo = await folder({ config: true })

  const { updates, questions } = chat(main.client, repo)
  const update = await shown(updates)

  expect(update).toMatchObject({
    unchecked: false,
    trust: { persistent: true, summary: "hooks", held: [{ name: "orbit.json", kinds: "hooks" }], above: [] },
  })
  expect(same(update?.trust?.directory ?? "", repo)).toBe(true)
  expect(update?.trust?.opened).toBeUndefined()
  // Nothing is asked until work starts.
  expect(questions).toEqual([])
})

test("shows, trusts and works in one folder when VS Code opened a folder inside the project", async () => {
  const repo = await folder({ config: true, git: true })
  const sub = path.join(repo, "packages", "app")
  await fs.mkdir(sub, { recursive: true })

  const { controller, updates, questions } = chat(main.client, sub, "trust")
  const update = await shown(updates)

  // Asked about the folder that VS Code opened, shown as the project's folder, with the opened one named beside it.
  expect(same(update?.trust?.directory ?? "", repo)).toBe(true)
  expect(update?.trust?.opened).toBe(sub)
  expect(update?.trust?.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])

  const grant = await controller.review()

  expect(questions).toHaveLength(1)
  expect(grant).toMatchObject({ persistent: true, above: [] })
  expect(same(grant?.directory ?? "", repo)).toBe(true)
  // The grant was made for the project's folder and not for the one that was opened, and both read as trusted.
  const stored = await main.client.location.trust.list()
  expect(stored.some((item) => same(item.directory, repo))).toBe(true)
  expect(stored.some((item) => same(item.directory, sub))).toBe(false)
  for (const directory of [repo, sub]) {
    const status = await main.client.location.trust.get({ location: { directory } })
    expect({ directory, trusted: status.trusted, root: same(status.directory, repo) }).toEqual({
      directory,
      trusted: true,
      root: true,
    })
  }
  expect(await until(() => (trusts(updates).at(-1)?.trust === undefined ? true : undefined))).toBe(true)
})

test("asks before the first message in an untrusted folder, and the model is asked only after the answer", async () => {
  const repo = await folder({ config: true })
  const before: Array<{ steps: number; sessions: number }> = []
  const { controller, updates, questions } = chat(main.client, repo, async (): Promise<TrustAnswer> => {
    before.push({ steps: steps.length, sessions: (await controller.sessions()).length })
    return "trust"
  })
  // The event stream must be connected before the prompt so no event is missed.
  await Bun.sleep(500)
  const asked = steps.length

  await controller.send("hello")
  await idle(updates)

  expect(questions).toHaveLength(1)
  expect(questions[0]?.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])
  // No session existed and the model had not been asked when the person was.
  expect(before).toEqual([{ steps: asked, sessions: 0 }])
  expect(steps.length).toBeGreaterThan(asked)
  expect(await main.client.location.trust.get({ location: { directory: repo } })).toMatchObject({
    trusted: true,
    source: "saved",
  })
  expect(trusts(updates).at(-1)?.trust).toBeUndefined()
  expect(notes(updates)).toContainEqual(
    expect.objectContaining({ tone: "muted", text: expect.stringMatching(/^Trusted .+\.$/) }),
  )
})

test("goes on without the folder's config after Not now, asks once, and asks again when the person opens the question", async () => {
  const repo = await folder({ config: true })
  const { controller, updates, questions } = chat(main.client, repo, "later")
  await Bun.sleep(500)
  const asked = steps.length

  await controller.send("one")
  await idle(updates, 1)
  await controller.send("two")
  await idle(updates, 2)

  // Both prompts went to the model, and the person was asked once.
  expect(steps.length - asked).toBeGreaterThanOrEqual(2)
  expect(questions).toHaveLength(1)
  expect(trusts(updates).at(-1)?.trust).toBeDefined()
  expect(await main.client.location.trust.get({ location: { directory: repo } })).toMatchObject({ trusted: false })
  // The banner and the command ask again, whatever was answered before, and a refusal there trusts nothing.
  expect(await controller.review()).toBeUndefined()
  expect(questions).toHaveLength(2)
  expect(await main.client.location.trust.get({ location: { directory: repo } })).toMatchObject({ trusted: false })
})

test("asks nothing in a folder that holds nothing back or is already trusted", async () => {
  const bare = await folder()
  const known = await folder({ config: true })
  await main.client.location.trust.update({ location: { directory: known }, trust: true })

  for (const directory of [bare, known]) {
    const { controller, updates, questions } = chat(main.client, directory, "trust")
    await Bun.sleep(500)
    const asked = steps.length

    await controller.send("hello")
    await idle(updates)

    expect({ directory, questions, worked: steps.length > asked }).toEqual({ directory, questions: [], worked: true })
    expect(trusts(updates).at(-1)?.trust).toBeUndefined()
    expect(await controller.review()).toBeUndefined()
    expect(questions).toEqual([])
  }
})

test("follows a grant and a revoke that are made elsewhere", async () => {
  const repo = await folder({ config: true })
  const { updates } = chat(main.client, repo)
  expect((await shown(updates))?.trust).toBeDefined()

  // `orb trust` in a terminal, or the terminal UI, grants it: the banner goes without anyone asking the chat.
  await main.client.location.trust.update({ location: { directory: repo }, trust: true })
  expect(await until(() => (trusts(updates).at(-1)?.trust === undefined ? true : undefined))).toBe(true)

  await main.client.location.trust.update({ location: { directory: repo }, trust: false })
  expect(await until(() => (trusts(updates).at(-1)?.trust !== undefined ? true : undefined))).toBe(true)
})

test("names config above the project, and gives no command for it", async () => {
  const parent = await folder({ config: true })
  const child = await folder({ config: true, git: true, in: parent })
  const only = await folder({ git: true, in: parent })

  // A repository that holds nothing of its own back has nothing that trusting it would turn on, however much sits above.
  const quiet = chat(main.client, only)
  expect((await shown(quiet.updates))?.trust).toBeUndefined()
  expect(await quiet.controller.review()).toBeUndefined()
  expect(quiet.questions).toEqual([])

  const { controller, updates, questions } = chat(main.client, child, "trust")
  const update = await shown(updates)
  expect(update?.trust?.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])
  expect(update?.trust?.above.map((item) => same(item, parent))).toEqual([true])

  const grant = await controller.review()

  expect(grant?.above.map((item) => same(item, parent))).toEqual([true])
  const text = prompt(update?.trust as TrustView).detail
  expect(text).toContain("stays off: each folder is trusted on its own.")
  expect(text.replaceAll("`orb trust --revoke`", "")).not.toMatch(/orb trust/)
  expect(questions).toHaveLength(1)
  // The parent is another folder with a decision of its own, and it is still not trusted.
  expect(await main.client.location.trust.get({ location: { directory: parent } })).toMatchObject({ trusted: false })
  expect(await main.client.location.trust.get({ location: { directory: child } })).toMatchObject({ trusted: true })
})

test("trust persists across a restart of the server, for the folder that was trusted and for no other", async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-home-")))
  try {
    const trusted = await folder({ config: true, git: true, in: path.join(home, "work") })
    const other = await folder({ config: true, git: true, in: path.join(home, "work") })
    const first = await serve(home)
    const before = chat(first.client, trusted, "trust")
    expect((await shown(before.updates))?.trust?.persistent).toBe(true)

    const grant = await before.controller.review()

    expect(grant?.persistent).toBe(true)
    expect(
      (await first.client.location.trust.list()).map((item) => item.directory).some((item) => same(item, trusted)),
    ).toBe(true)
    expect(await first.client.location.trust.get({ location: { directory: trusted } })).toMatchObject({
      trusted: true,
      source: "saved",
    })
    before.controller.dispose()
    await first.stop()

    // The same home, so the same database: a new server finds the grant on disk.
    const second = await serve(home)
    try {
      expect(await second.client.location.trust.get({ location: { directory: trusted } })).toMatchObject({
        trusted: true,
        source: "saved",
      })
      // A chat opened now has nothing to ask about the folder that was trusted, and still asks about the other one.
      const again = chat(second.client, trusted)
      expect((await shown(again.updates))?.trust).toBeUndefined()
      const elsewhere = chat(second.client, other)
      expect((await shown(elsewhere.updates))?.trust?.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])
      expect(await elsewhere.controller.review()).toBeUndefined()
      expect(elsewhere.questions).toHaveLength(1)
    } finally {
      await second.stop()
    }
  } finally {
    // A killed server can hold its files for a moment on Windows, and a folder left in the temp directory harms nothing.
    await fs.rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }).catch(() => undefined)
  }
}, 180_000)

// A server that answers as the test says. The failures that a real server does not make on request are made here: no
// answer at all, no such route, a failure, something that is not JSON and something that is JSON and not a trust status.
function stub(routes: {
  get?: (count: number) => Response | Promise<Response>
  post?: () => Response | Promise<Response>
}) {
  const seen: string[] = []
  // The folder that each read and each grant was asked for, and what each grant asked for.
  const asked: string[] = []
  const grants: unknown[] = []
  let gets = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A request that is never answered stays open, instead of being cut after ten seconds.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/location/trust")
        asked.push(`${request.method} ${url.searchParams.get("location[directory]")}`)
      if (url.pathname === "/api/location/trust" && request.method === "GET")
        return routes.get?.(++gets) ?? new Response("not found", { status: 404 })
      if (url.pathname === "/api/location/trust" && request.method === "POST") {
        grants.push(await request.json())
        return routes.post?.() ?? new Response("not found", { status: 404 })
      }
      // Starting work: a session is created. It fails, which is enough to see that the chat got that far.
      if (url.pathname === "/api/session" && request.method === "POST") return new Response("no", { status: 500 })
      // The event stream stays open and says nothing.
      if (url.pathname === "/api/event")
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
      return new Response("not found", { status: 404 })
    },
  })
  return {
    client: Orbit.make({ baseUrl: `http://127.0.0.1:${server.port}` }),
    seen,
    asked,
    grants,
    stop: () => server.stop(true),
  }
}

const project = path.join(root, "stub-project")
const held = [{ path: path.join(project, "orbit.json"), kinds: ["hooks"] }]
const answer = (extra: Record<string, unknown> = {}) =>
  Response.json({ directory: project, trusted: false, persistent: true, withheld: held, ...extra })
const quick = { read: 300, grant: 300 }

test("carries on when the server does not answer in time, after the time it is given", async () => {
  const server = stub({ get: () => new Promise<Response>(() => {}) })
  try {
    const started = performance.now()
    const { controller, updates, questions } = chat(server.client, project)

    // The first read, and the one the message waits for, each have the time that a person would wait: two seconds.
    await controller.send("hello").catch(() => undefined)
    const waited = performance.now() - started

    expect(limits.read).toBe(2_000)
    expect(waited).toBeGreaterThanOrEqual(1_900)
    expect(waited).toBeLessThan(6_000)
    // The prompt went on, without a question: the server said nothing about the folder, and it is the one that decides.
    expect(server.seen).toContain("POST /api/session")
    expect(questions).toEqual([])
    expect(trusts(updates)).toEqual([])
    expect(logs(updates).length).toBeGreaterThanOrEqual(1)
    expect(logs(updates)[0]).toStartWith("could not read workspace trust")
  } finally {
    await server.stop()
  }
}, 30_000)

test("carries on, and says so, when the server is older than workspace trust", async () => {
  const server = stub({})
  try {
    const { controller, updates, questions } = chat(server.client, project, "trust", quick)
    expect((await shown(updates))?.unchecked).toBe(true)

    await controller.send("hello").catch(() => undefined)

    expect(trusts(updates).at(-1)).toEqual({ type: "trust", trust: undefined, unchecked: true })
    expect(server.seen).toContain("POST /api/session")
    expect(questions).toEqual([])
    // A route that is not there is not a failure to read: the server is simply old.
    expect(logs(updates)).toEqual([])
    expect(server.seen.filter((item) => item.startsWith("POST /api/location/trust"))).toEqual([])
  } finally {
    await server.stop()
  }
})

test("keeps going, with one line in the log, when the server fails or sends something that is not a trust status", async () => {
  const bad: Array<[string, () => Response]> = [
    ["a server error", () => new Response("boom", { status: 500 })],
    ["credentials refused", () => new Response("no", { status: 401 })],
    ["text that is not JSON", () => new Response("{nope", { headers: { "content-type": "application/json" } })],
    ["JSON that is not an object", () => Response.json(["trusted"])],
    ["a status of the wrong shape", () => Response.json({ directory: project, trusted: "yes" })],
    ["a status with an entry that does not fit", () => answer({ withheld: [...held, null] })],
  ]
  for (const [name, get] of bad) {
    const server = stub({ get })
    try {
      const { controller, updates, questions } = chat(server.client, project, "trust", quick)
      await Bun.sleep(300)

      await controller.send("hello").catch(() => undefined)

      expect({ name, worked: server.seen.includes("POST /api/session"), questions, shown: trusts(updates) }).toEqual({
        name,
        worked: true,
        questions: [],
        shown: [],
      })
      expect(logs(updates).length).toBeGreaterThanOrEqual(1)
      for (const line of logs(updates)) expect(line).toStartWith("could not read workspace trust")
    } finally {
      await server.stop()
    }
  }
})

test("asks the server again before it asks the person, so a folder trusted in the meantime is not asked about", async () => {
  // No event reaches this chat, as when one is missed: only a read can tell it that the folder is trusted now.
  const server = stub({ get: (count) => (count === 1 ? answer() : answer({ trusted: true, withheld: [] })) })
  try {
    const { controller, updates, questions } = chat(server.client, project, "trust", quick)
    expect((await shown(updates))?.trust).toBeDefined()

    await controller.send("hello").catch(() => undefined)

    expect(questions).toEqual([])
    expect(server.seen).toContain("POST /api/session")
    expect(server.seen).not.toContain("POST /api/location/trust")
    expect(trusts(updates).at(-1)?.trust).toBeUndefined()
  } finally {
    await server.stop()
  }
})

test("keeps the last answer when a later read fails, and still asks", async () => {
  const server = stub({ get: (count) => (count === 1 ? answer() : new Response("boom", { status: 500 })) })
  try {
    const { controller, updates, questions } = chat(server.client, project, "later", quick)
    expect((await shown(updates))?.trust?.held).toEqual([{ name: "orbit.json", kinds: "hooks" }])

    await controller.review()

    // The server could not be reached the second time, so the first answer stands and the person is still asked.
    expect(questions).toHaveLength(1)
    expect(logs(updates)).toHaveLength(1)
    expect(trusts(updates).at(-1)?.trust).toBeDefined()
  } finally {
    await server.stop()
  }
})

test("asks about the folder VS Code opened and trusts the folder the server named", async () => {
  const sub = path.join(project, "sub")
  let granted = false
  const server = stub({
    get: () => (granted ? answer({ trusted: true, withheld: [] }) : answer()),
    post: () => {
      granted = true
      return answer({ trusted: true, withheld: [] })
    },
  })
  try {
    const { controller, updates } = chat(server.client, sub, "trust", quick)
    expect((await shown(updates))?.trust).toMatchObject({ directory: project, opened: sub })

    const grant = await controller.review()

    // Every read was for the opened folder, and the one grant was for the project's folder that the question showed.
    expect(grant).toEqual({ directory: project, persistent: true, above: [] })
    expect(new Set(server.asked.filter((item) => item.startsWith("GET")))).toEqual(new Set([`GET ${sub}`]))
    expect(server.asked.filter((item) => item.startsWith("POST"))).toEqual([`POST ${project}`])
    expect(server.grants).toEqual([{ trust: true, persist: true }])
    expect(trusts(updates).at(-1)?.trust).toBeUndefined()
  } finally {
    await server.stop()
  }
})

test("a folder that can only be trusted until Orbit restarts is asked for, and granted, as that", async () => {
  let granted = false
  const server = stub({
    get: () => (granted ? answer({ persistent: false, trusted: true, withheld: [] }) : answer({ persistent: false })),
    post: () => {
      granted = true
      return answer({ persistent: false, trusted: true, source: "session", withheld: [] })
    },
  })
  try {
    const { controller, updates, questions } = chat(server.client, project, "trust", quick)
    const update = await shown(updates)
    expect(update?.trust?.persistent).toBe(false)

    const grant = await controller.review()

    expect(prompt(questions[0] as TrustView).accept).toBe("Trust until Orbit restarts")
    expect(server.grants).toEqual([{ trust: true, persist: false }])
    expect(grant).toEqual({ directory: project, persistent: false, above: [] })
  } finally {
    await server.stop()
  }
})

test("does not call a folder trusted when the server trusted another one", async () => {
  const other = path.join(root, "stub-other")
  const server = stub({
    get: () => answer(),
    post: () => answer({ directory: other, trusted: true, withheld: [] }),
  })
  try {
    const { controller, updates } = chat(server.client, project, "trust", quick)
    await shown(updates)

    await expect(controller.review()).rejects.toThrow(`The server did not trust ${project}.`)

    expect(trusts(updates).at(-1)?.trust).toBeDefined()
    // The grant was asked for the folder that was shown, and for no other.
    expect(server.seen.filter((item) => item === "POST /api/location/trust")).toHaveLength(1)
  } finally {
    await server.stop()
  }
})

test("writes out the control characters of a folder's name wherever it tells the person about it", async () => {
  // ESC ] 0 BEL sets the title of a terminal window, and U+202E reorders the text after it. A repository names its folder.
  const evil = path.join(root, "evil\u001b]0;pwned\u0007\u001b[2K‮gpj")
  const written = "evil\\x1b]0;pwned\\x07\\x1b[2K\\u{202e}gpj"
  const body = (extra: Record<string, unknown> = {}) =>
    Response.json({ directory: evil, trusted: false, persistent: true, withheld: held, ...extra })
  const server = stub({
    get: () => body(),
    post: () => body({ directory: path.join(root, "stub-other"), trusted: true, withheld: [] }),
  })
  try {
    const { controller, updates } = chat(server.client, evil, "trust", quick)
    const update = await shown(updates)
    expect(update?.trust?.directory).toContain(written)

    const failure = await controller.review().catch((error: Error) => error)
    await controller.send("hello").catch(() => undefined)

    expect(failure).toBeInstanceOf(Error)
    for (const text of [(failure as Error).message, ...notes(updates).map((note) => note.text), JSON.stringify(update)])
      expect(text).not.toMatch(/\p{C}/u)
    expect((failure as Error).message).toContain(written)
    expect(notes(updates).some((note) => note.text.includes(written))).toBe(true)
  } finally {
    await server.stop()
  }
})

test("takes the stricter answer when the folder VS Code opened still reads as untrusted after the grant", async () => {
  const sub = path.join(project, "sub")
  const server = stub({
    get: () => answer(),
    post: () => answer({ trusted: true, withheld: [] }),
  })
  try {
    const { controller, updates, questions } = chat(server.client, sub, "trust", quick)
    await shown(updates)

    await controller.send("hello").catch(() => undefined)

    // The grant came back trusted, the read for the opened folder did not, and the second one stands: not trusted. The
    // message goes on without what the folder holds back, and the chat says that the trust did not take.
    expect(questions).toHaveLength(1)
    expect(server.seen).toContain("POST /api/session")
    expect(trusts(updates).at(-1)?.trust).toBeDefined()
    expect(notes(updates)).toContainEqual(
      expect.objectContaining({
        tone: "error",
        text: expect.stringContaining(`The server trusted ${project} but does not report ${sub} as trusted.`),
      }),
    )
    expect(notes(updates).some((note) => note.text.startsWith("Trusted"))).toBe(false)
  } finally {
    await server.stop()
  }
})

test("stops waiting for a grant that the server does not answer", async () => {
  const server = stub({ get: () => answer(), post: () => new Promise<Response>(() => {}) })
  try {
    const { controller, updates } = chat(server.client, project, "trust", quick)
    await shown(updates)
    const started = performance.now()

    await expect(controller.review()).rejects.toThrow()

    expect(performance.now() - started).toBeLessThan(5_000)
    expect(limits.grant).toBe(10_000)
    expect(trusts(updates).at(-1)?.trust).toBeDefined()
  } finally {
    await server.stop()
  }
})
