// m5-quality, FU-M5-009 (classes 6, 8 and 9): the protocol has a client render a call's content as Markdown, and some
// clients render titles so. Every value a model, a file or a subagent chose that ACP sends in a title or in content is
// sent so that Markdown shows it letter for letter, as m5-link-warning sends paths: an external folder question titled
// with a description or a command, a fetch's URL, a search's pattern or query, an MCP call's arguments, a shell call's
// title (its command) and a subagent's title in front of its calls. None becomes a link, an image or a tag, and a line
// break is written out, so no value starts a line that reads as one of Orbit's. A value that Markdown leaves alone is
// sent as it is (the control). Through the real ACP translation over the wire.
import { describe, expect, test } from "bun:test"
import type { EventSubscribeOutput, OrbitEvent } from "@orbit/client/promise"
import {
  childCreated,
  durableEvent,
  permissionAsked,
  startSession,
  succeeded,
  toolCalled,
  toolFailed,
  toolStarted,
  toolSucceeded,
  turn,
} from "./wire-fixture"

type Metadata = Extract<EventSubscribeOutput, { type: "permission.asked" }>["data"]["metadata"]

// What a person reads of `markdown` once a client renders it, and the markup it made besides paragraphs and code.
const read = (markdown: string) => {
  const html = Bun.markdown.html(markdown, { autolinks: true, strikethrough: true, tables: true, tasklists: true })
  const tags = [...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((found) => found[1]!.toLowerCase())
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n$/, "")
  return { text, markup: [...new Set(tags.filter((tag) => tag !== "p" && tag !== "code"))] }
}

// Values a model or a file can choose, each at most 40 characters so that no title's cut changes what is read.
const HOSTILE = [
  "![x](https://evil.example/p.png)",
  "[click](https://evil.example/)",
  "<img src=x onerror=alert(1)>",
  "see https://evil.example/x",
  "*bold* and __under__",
  "a`b``c",
  "~~struck~~ ~one~",
  "# heading",
  "- an item",
  "&lt;b&gt;&amp;",
  "a|b|c",
]
// A line break, written out as `\n`, so the second line cannot read as a warning of Orbit's.
const BROKEN = { value: "ok\nLink ends outside the project", shown: "ok\\nLink ends outside the project" }
// Values Markdown leaves alone, which are sent unchanged.
const PLAIN = ["ls -la", "Review code", "npm run build"]

// Asks one permission question after `events`, answers it, and returns the call the client was asked about.
async function asked(
  request: { action: string; resources: string[]; metadata?: Metadata; source?: string },
  events: (sessionID: string) => OrbitEvent[] = () => [],
) {
  await using acp = await startSession({
    onPrompt: ({ sessionID, id }) =>
      turn(
        sessionID,
        id,
        ...events(sessionID),
        permissionAsked(sessionID, "perm_markdown", {
          action: request.action,
          resources: request.resources,
          save: ["*"],
          metadata: request.metadata ?? {},
          ...(request.source ? { source: { type: "tool", messageID: "msg_markdown", id: request.source } } : {}),
        }),
      ),
    permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) as const,
  })
  await acp.prompt(acp.sessionId, "hello")
  expect(acp.permissions).toHaveLength(1)
  return acp.permissions[0]!.toolCall
}

const texts = (call: Awaited<ReturnType<typeof asked>>) =>
  (call.content ?? []).flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  )

// The titles the client was given for the call `id`, in order, by any update of the turn.
async function titles(events: (sessionID: string) => OrbitEvent[], id: string) {
  await using acp = await startSession({
    onPrompt: ({ sessionID, id: inbox }) => turn(sessionID, inbox, ...events(sessionID)),
  })
  await acp.prompt(acp.sessionId, "hello")
  return acp.updates.flatMap((item) => {
    const update = item.update as { toolCallId?: string; title?: string }
    return update.toolCallId === id && typeof update.title === "string" ? [update.title] : []
  })
}

const shown = (value: string) => ({ text: value, markup: [] })

describe("acp: model and file text in an approval reads as it is", () => {
  test("an external folder question titled with a description or a command", async () => {
    for (const key of ["description", "command"] as const) {
      for (const value of HOSTILE) {
        const call = await asked({ action: "external_directory", resources: ["/out/*"], metadata: { [key]: value } })
        expect([key, read(String(call.title))]).toEqual([key, shown(value)])
      }
      const broken = await asked({
        action: "external_directory",
        resources: ["/out/*"],
        metadata: { [key]: BROKEN.value },
      })
      expect([key, read(String(broken.title))]).toEqual([key, shown(BROKEN.shown)])
      for (const value of PLAIN) {
        const call = await asked({ action: "external_directory", resources: ["/out/*"], metadata: { [key]: value } })
        expect([key, call.title]).toEqual([key, value])
      }
    }
  })

  test("a fetch's URL, for a GET and for another method", async () => {
    for (const value of HOSTILE) {
      const url = `https://evil.example/${value.replaceAll(" ", "%20")}`
      const get = await asked({ action: "WebFetch", resources: [url], metadata: { url, method: "GET" } })
      expect(read(String(get.title))).toEqual(shown(url))
      const post = await asked({
        action: "WebFetch",
        resources: [url, `POST ${url}`],
        metadata: { url, method: "POST" },
      })
      expect(read(String(post.title))).toEqual(shown(`POST ${url}`))
    }
  })

  test("a search's pattern", async () => {
    for (const action of ["Grep", "Glob"]) {
      for (const value of [...HOSTILE, BROKEN.value]) {
        const call = await asked({ action, resources: [value], metadata: { path: "/workspace" } })
        expect([action, read(String(call.title))]).toEqual([
          action,
          shown(value === BROKEN.value ? BROKEN.shown : value),
        ])
      }
      const plain = await asked({ action, resources: ["needle"], metadata: { path: "/workspace" } })
      expect(plain.title).toBe("needle")
    }
  })

  test("a web search's query", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const call = await asked({ action: "WebSearch", resources: ["*"], source: "call_search" }, (sessionID) => [
        toolStarted(sessionID, "call_search", "WebSearch"),
        toolCalled(sessionID, "call_search", { query: value }),
      ])
      expect(read(String(call.title))).toEqual(shown(value === BROKEN.value ? BROKEN.shown : value))
    }
  })

  test("an MCP call's arguments", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const call = await asked({
        action: "slack_post_message",
        resources: ["*"],
        metadata: { arguments: { channel: "#ops", text: value } },
      })
      const written = `Arguments: ${JSON.stringify({ channel: "#ops", text: value })}`
      expect(texts(call).map(read)).toEqual([shown(written)])
    }
  })

  // Cell 6.h: a request whose caller is not its tool (here none) is titled with its action and what it reaches, which an
  // MCP server or a model chose. The plain name is the control.
  test("a request whose caller is not its tool, titled with its action and what it reaches", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const call = await asked({ action: "slack_post_message", resources: [value] })
      expect(read(String(call.title))).toEqual(
        shown(`slack_post_message ${value === BROKEN.value ? BROKEN.shown : value}`),
      )
    }
    const plain = await asked({ action: "slack_post_message", resources: ["*"] })
    expect(plain.title).toBe("slack_post_message")
  })
})

describe("acp: model text in a call's title reads as it is", () => {
  test("a shell call's title is its command, one line", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const all = await titles(
        (sessionID) => [
          toolStarted(sessionID, "call_shell", "Bash"),
          toolCalled(sessionID, "call_shell", { command: value }),
        ],
        "call_shell",
      )
      expect(all.length).toBeGreaterThan(0)
      for (const title of all.filter((item) => item !== "Bash"))
        expect(read(title)).toEqual(shown(value === BROKEN.value ? BROKEN.shown : value))
    }
    const plain = await titles(
      (sessionID) => [
        toolStarted(sessionID, "call_shell", "Bash"),
        toolCalled(sessionID, "call_shell", { command: "ls -la" }),
      ],
      "call_shell",
    )
    expect(plain.at(-1)).toBe("ls -la")
  })

  // Cell 6.h: any other call is titled with its name, which an MCP server chose. `read` is the control.
  test("another call's title is its name, one line", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const all = await titles((sessionID) => [toolStarted(sessionID, "call_tool", value)], "call_tool")
      expect(all.length).toBeGreaterThan(0)
      for (const title of all) expect(read(title)).toEqual(shown(value === BROKEN.value ? BROKEN.shown : value))
    }
    const plain = await titles((sessionID) => [toolStarted(sessionID, "call_tool", "read")], "call_tool")
    expect(plain).toEqual(["read"])
  })

  test("a subagent's title in front of its calls", async () => {
    for (const value of [...HOSTILE, BROKEN.value]) {
      const all = await titles(
        (sessionID) => [
          childCreated("ses_child", sessionID, value),
          durableEvent("session.execution.started", { sessionID: "ses_child" }),
          toolStarted("ses_child", "call_read", "read"),
          succeeded("ses_child"),
        ],
        "ses_child:call_read",
      )
      expect(all.length).toBeGreaterThan(0)
      for (const title of all)
        expect(read(title)).toEqual(shown(`${value === BROKEN.value ? BROKEN.shown : value}: read`))
    }
    const plain = await titles(
      (sessionID) => [
        childCreated("ses_child", sessionID, "Explore code"),
        durableEvent("session.execution.started", { sessionID: "ses_child" }),
        toolStarted("ses_child", "call_read", "read"),
        succeeded("ses_child"),
      ],
      "ses_child:call_read",
    )
    expect(plain).toEqual(["Explore code: read"])
  })
})

// Review of fix loop 1 (classes 6 and 9): what a tool gave back is content too, and a repository or a server chose it:
// the text of a file a Read opened, another tool's output, the text of an error. Text of several lines keeps its lines in
// a fenced code block that no line of it can close, and one line that Markdown draws letter for letter is sent as it is
// (the control). Nothing in it becomes a link, an image or a tag.
describe("acp: what a tool gave back reads as it is", () => {
  // A file's text: several lines, fences of its own, and each hostile value on a line.
  const FILE = ["# Read me", "```", ...HOSTILE, "````", "Link ends outside the project"].join("\n")
  const VALUES = [...HOSTILE, BROKEN.value, FILE]

  // What a person reads of `markdown`, which may be a block: the text without the block's last line break.
  const block = (markdown: string) => {
    const seen = read(markdown)
    return { text: seen.text.replace(/\n$/, ""), markup: seen.markup.filter((tag) => tag !== "pre") }
  }

  // The text content of the last update the client was given for the call `id`.
  async function content(events: (sessionID: string) => OrbitEvent[], id: string) {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id: inbox }) => turn(sessionID, inbox, ...events(sessionID)),
    })
    await acp.prompt(acp.sessionId, "hello")
    const last = acp.updates
      .map((item) => item.update as { toolCallId?: string; content?: Awaited<ReturnType<typeof asked>>["content"] })
      .filter((update) => update.toolCallId === id && update.content !== undefined)
      .at(-1)
    return texts({ toolCallId: id, content: last?.content })
  }

  test("a Read's file text", async () => {
    const opened = (text: string) =>
      content(
        (sessionID) => [
          toolStarted(sessionID, "call_read", "Read"),
          toolCalled(sessionID, "call_read", { file_path: "README.md" }),
          toolSucceeded(sessionID, "call_read", {}, JSON.stringify({ type: "text-page", content: text })),
        ],
        "call_read",
      )
    for (const value of VALUES) expect((await opened(value)).map(block)).toEqual([shown(value)])
    expect(await opened("Plain notes")).toEqual(["Plain notes"])
  })

  test("another tool's text output", async () => {
    const output = (text: string) =>
      content(
        (sessionID) => [
          toolStarted(sessionID, "call_shell", "Bash"),
          toolCalled(sessionID, "call_shell", { command: "cat notes" }),
          toolSucceeded(sessionID, "call_shell", {}, text),
        ],
        "call_shell",
      )
    for (const value of VALUES) expect((await output(value)).map(block)).toEqual([shown(value)])
    expect(await output("done")).toEqual(["done"])
  })

  test("an error's text", async () => {
    const failed = (message: string) =>
      content(
        (sessionID) => [
          toolStarted(sessionID, "call_mcp", "slack_post_message"),
          toolCalled(sessionID, "call_mcp", { text: "hi" }),
          toolFailed(sessionID, "call_mcp", { error: { type: "unknown", message } }),
        ],
        "call_mcp",
      )
    for (const value of VALUES) expect((await failed(value)).map(block)).toEqual([shown(value)])
    expect(await failed("Channel not found")).toEqual(["Channel not found"])
  })
})
