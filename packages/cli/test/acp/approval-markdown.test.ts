// m5-quality, FU-M5-009 (classes 6, 8 and 9): the protocol has a client render a call's content as Markdown, and some
// clients render titles so. Every value a model, a file or a subagent chose that ACP sends in a title or in content is
// sent so that Markdown shows it letter for letter, as m5-link-warning sends paths: an external folder question titled
// with a description or a command, a fetch's URL, a search's pattern or query, an MCP call's arguments, a shell call's
// title (its command) and a subagent's title in front of its calls. None becomes a link, an image or a tag, and a line
// break is written out, so no value starts a line that reads as one of Orbit's. A value that Markdown leaves alone is
// sent as it is (the control). Through the real ACP translation over the wire.
import { describe, expect, test } from "bun:test"
import type { EventSubscribeOutput, OrbitEvent, SessionMessageInfo } from "@orbit/client/promise"
import { availableCommands, buildModelSelectOption, buildModeSelectOption } from "../../src/acp/config-option"
import { ACPElicitation } from "../../src/acp/elicitation"
import { ACPTranslate } from "../../src/acp/translate"
import {
  childCreated,
  delivered,
  durableEvent,
  ephemeralEvent,
  makeSession,
  permissionAsked,
  reasoningDelta,
  reviewCommand,
  startSession,
  startWire,
  succeeded,
  textDelta,
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
    // Output that ends with a line break closes its block on the next line, with no empty line drawn before the fence.
    expect((await output("one\ntwo\n")).map(block)).toEqual([shown("one\ntwo")])
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

// Review of fix loop 1 (classes 6, 8 and 9): the rest of what ACP sends that a model, a tool, a subagent or an MCP server
// chose. A form's message (a subagent's title and the form's title) and its fields' words read as they are; the model's
// own Markdown goes as written except that no image or raw tag in it is fetched, as the reference's renderer shows an
// image as its address; and names, titles and error messages that a client draws as plain text are one line with no
// control character, as the terminal UI draws them.
describe("acp: other text a model, a tool or a server chose", () => {
  const value = (raw: string) => (raw === BROKEN.value ? BROKEN.shown : raw)
  const form = (sessionID: string, title: string) =>
    ephemeralEvent("form.created", {
      form: {
        id: "frm_markdown",
        sessionID,
        title,
        metadata: { kind: "question", tool: { messageID: "msg_tools", id: "call_child" } },
        fields: [{ key: "q0", title: "Runtime", type: "string", options: [{ value: "Bun", label: "Bun" }] }],
      },
    })

  test("a form's message: a subagent's title and the form's title", async () => {
    const message = async (child: string, title: string) => {
      await using acp = await startSession({
        capabilities: { elicitation: true },
        onPrompt: ({ sessionID, id }) => [
          delivered(sessionID, id),
          childCreated("ses_child", sessionID, child),
          durableEvent("session.execution.started", { sessionID: "ses_child" }),
          form("ses_child", title),
        ],
        elicitation: () => ({ action: "accept", content: { q0: "Bun" } }),
        onFormReply: ({ sessionID }) => [succeeded(sessionID), succeeded(acp.sessionId)],
      })
      await acp.prompt(acp.sessionId, "hello")
      expect(acp.elicitations).toHaveLength(1)
      return acp.elicitations[0]!.message
    }
    for (const raw of [...HOSTILE, BROKEN.value]) {
      expect(read(await message(raw, "Questions"))).toEqual(shown(`${value(raw)}: Questions`))
      expect(read(await message("Explore code", raw))).toEqual(shown(`Explore code: ${value(raw)}`))
    }
    expect(await message("Explore code", "Questions")).toBe("Explore code: Questions")
  })

  test("a form's field titles, descriptions and option labels", () => {
    const fields = (text: string) =>
      ACPElicitation.requestedSchema(
        {
          id: "frm_test",
          sessionID: "ses_test",
          title: "Test",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              title: text,
              description: text,
              type: "string",
              options: [{ value: "a", label: text, description: text }],
              custom: true,
            },
          ],
        },
        { childSessionUpdates: false, formElicitation: true },
      )?.properties as Record<string, { title?: string; description?: string; oneOf?: { title: string; description?: string }[] }>
    for (const raw of [...HOSTILE, BROKEN.value]) {
      const schema = fields(raw)
      const words = [
        schema.q0?.title,
        schema.q0?.description,
        schema.q0?.oneOf?.[0]?.title,
        schema.q0?.oneOf?.[0]?.description,
      ]
      expect(words.map((word) => read(String(word)))).toEqual(Array(4).fill(shown(value(raw))))
      expect(read(String(schema.q0_custom?.title))).toEqual(shown(`${value(raw)} (other)`))
    }
    const plain = fields("Runtime")
    expect([plain.q0?.title, plain.q0?.oneOf?.[0]?.title, plain.q0_custom?.title]).toEqual([
      "Runtime",
      "Runtime",
      "Runtime (other)",
    ])
  })

  // What the client was given of a message streamed in `deltas`, as a message and as a thought.
  async function streamed(deltas: string[]) {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) =>
        turn(
          sessionID,
          id,
          ...deltas.map((delta) => textDelta(sessionID, "msg_markdown", delta)),
          ...deltas.map((delta) => reasoningDelta(sessionID, "msg_markdown", delta)),
        ),
    })
    await acp.prompt(acp.sessionId, "hello")
    const chunks = (kind: string) =>
      acp.updates
        .map((item) => item.update as { sessionUpdate: string; content?: { type: string; text?: string } })
        .flatMap((update) => (update.sessionUpdate === kind && update.content?.text ? [update.content.text] : []))
        .join("")
    return [chunks("agent_message_chunk"), chunks("agent_thought_chunk")]
  }

  test("the model's Markdown: an image or a raw tag is never fetched, whole or in pieces, and prose and code are as written", async () => {
    const address = "https://evil.example/p.png"
    for (const deltas of [
      [`![x](${address})`],
      [`![x][ref]\n\n[ref]: ${address}`],
      [`<img src=${address} onerror=alert(1)>`],
      [`<picture><source srcset=${address}></picture>`],
      ["!", `[x](${address})`],
      ["<", `img src=${address}>`],
      ["<im", `g src=${address}>`],
      ["```\ncode\n```\n", `![x](${address})`],
    ]) {
      for (const markdown of await streamed(deltas)) {
        const seen = Bun.markdown.html(markdown, { autolinks: true, strikethrough: true, tables: true, tasklists: true })
        expect([deltas, seen]).not.toEqual([deltas, expect.stringMatching(/<(img|picture|source)\b/i)])
        // A reference definition is never drawn, so only an inline address is read in the text.
        if (!deltas.join("").includes("[ref]:")) expect(read(markdown).text).toContain(address)
      }
    }
    // The controls: prose keeps its emphasis and links, code keeps its marks, and an autolink is a link.
    for (const markdown of [
      "*bold* and [a link](https://example.com/)",
      "use `vec![1]` and `<img>` here",
      "a span of two marks holds one: ``a ` ![x](u) ``",
      "```\nlet v = vec![1]; // <img src=x>\n```",
      "see <https://example.com/>",
    ])
      expect(await streamed([markdown])).toEqual([markdown, markdown])
    // Code split across pieces is still code.
    expect(await streamed(["``", "`\n![x](y)\n``", "`"])).toEqual(Array(2).fill("```\n![x](y)\n```"))
  })

  test("a loaded session's replay: the model's Markdown as it streams, and a slash command's prompt as its command", () => {
    const replayed = (message: SessionMessageInfo) =>
      [...ACPTranslate.replayMessage(message, "/workspace")].flatMap((update) =>
        (update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        update.content.type === "text"
          ? [update.content.text]
          : [],
      )
    const assistant = {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      content: [
        { type: "text", text: "![x](https://evil.example/p.png) and `vec![1]`" },
        { type: "reasoning", text: "<img src=https://evil.example/p.png>" },
      ],
      time: { created: 1 },
    } as unknown as SessionMessageInfo
    expect(replayed(assistant)).toEqual([
      "!\\[x](https://evil.example/p.png) and `vec![1]`",
      "&lt;img src=https://evil.example/p.png>",
    ])
    const user = (command?: { name: string; arguments: string }) =>
      ({
        id: "msg_u",
        type: "user",
        text: "Review the callers. EXPANDED-BODY",
        ...(command ? { command } : {}),
        time: { created: 1 },
      }) as unknown as SessionMessageInfo
    expect(replayed(user({ name: "review", arguments: "src/a.ts" }))).toEqual(["/review src/a.ts"])
    expect(replayed(user({ name: "review", arguments: "" }))).toEqual(["/review"])
    expect(replayed(user())).toEqual(["Review the callers. EXPANDED-BODY"])
  })

  // Class 9: names and words that a client draws as plain text.
  const CONTROL = "evil\u001b]0;pwned\u0007\nnext‮"
  const clean = (text: string | undefined) => expect(String(text)).not.toMatch(/[\u0000-\u001f\u007f‮]/)

  test("a command's, a model's and a mode's name and words, and an error's message, are one line with no control character", () => {
    const [command] = availableCommands({ commands: [{ ...reviewCommand, name: CONTROL, description: CONTROL }] } as never)
    clean(command?.name)
    clean(command?.description)
    const model = buildModelSelectOption({
      providers: [{ id: "p", name: CONTROL, models: [{ id: "m", name: CONTROL }] }],
      currentModel: { providerID: "p", modelID: "m" },
    })
    const named = (option: { name?: string; description?: string | null }) =>
      option.name === undefined ? [] : [option.name, option.description ?? ""]
    const models = model.type === "select" ? model.options.flatMap(named) : []
    expect(models).toHaveLength(2)
    models.forEach(clean)
    const mode = buildModeSelectOption({ modes: [{ id: "m", name: CONTROL, description: CONTROL }], currentModeId: "m" })
    const modes = mode.type === "select" ? mode.options.flatMap(named) : []
    expect(modes).toHaveLength(2)
    modes.forEach(clean)
    const failure = ACPTranslate.failure({
      ...ACPTranslate.initial,
      stepError: { type: "provider.stream", message: CONTROL },
    })
    clean(failure?._tag === "ACPServiceFailureError" ? failure.safeMessage : undefined)
    // The controls: plain words are unchanged.
    const [plain] = availableCommands({ commands: [reviewCommand] } as never)
    expect(plain).toEqual({ name: "review", description: "Review changes" })
  })

  test("a session's title in the session list is one line with no control character", async () => {
    await using acp = await startWire()
    await acp.initialize()
    const created = await acp.request("session/new", { cwd: "/workspace", mcpServers: [] })
    acp.server.sessions.set(created.sessionId, { ...makeSession(created.sessionId), title: CONTROL })
    const listed = await acp.request("session/list", { cwd: "/workspace" })
    expect(listed.sessions).toHaveLength(1)
    clean(listed.sessions[0]?.title ?? undefined)
    acp.server.sessions.set(created.sessionId, { ...makeSession(created.sessionId), title: "Fix the parser" })
    expect((await acp.request("session/list", { cwd: "/workspace" })).sessions[0]?.title).toBe("Fix the parser")
  })
})
