// m5-quality, FU-M5-009 (classes 6, 8 and 9): the protocol has a client render a call's content as Markdown, and some
// clients render titles so. Every value a model, a file or a subagent chose that ACP sends in a title or in content is
// sent so that Markdown shows it letter for letter, as m5-link-warning sends paths: an external folder question titled
// with a description or a command, a fetch's URL, a search's pattern or query, an MCP call's arguments, a shell call's
// title (its command) and a subagent's title in front of its calls. None becomes a link, an image or a tag, and a line
// break is written out, so no value starts a line that reads as one of Orbit's. A value that Markdown leaves alone is
// sent as it is (the control). Through the real ACP translation over the wire.
import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import type { EventSubscribeOutput, OrbitEvent, SessionMessageInfo } from "@orbit/client/promise"
import { availableCommands, buildModelSelectOption, buildModeSelectOption } from "../../src/acp/config-option"
import { ACPElicitation } from "../../src/acp/elicitation"
import { follow, prose, withoutImages } from "../../src/acp/markdown"
import { ACPTranslate } from "../../src/acp/translate"
import {
  childCreated,
  delivered,
  durableEvent,
  ephemeralEvent,
  makeSession,
  permissionAsked,
  reasoningDelta,
  reasoningEnded,
  reviewCommand,
  startSession,
  startWire,
  succeeded,
  textDelta,
  textEnded,
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
// U+2060 WORD JOINER, which the filter writes after a `!` or a `<` that could open an image or a tag.
const JOINER = String.fromCharCode(0x2060)
// What a person reads of `markdown` and the address of each link in it, such as the link an image becomes once a word
// joiner parts its `!` from its `[`.
const reached = (markdown: string) => {
  const html = Bun.markdown.html(markdown, { autolinks: true, strikethrough: true, tables: true, tasklists: true })
  return [read(markdown).text, ...[...html.matchAll(/href="([^"]*)"/g)].map((found) => found[1])].join("\n")
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
      )?.properties as Record<
        string,
        { title?: string; description?: string; oneOf?: { title: string; description?: string }[] }
      >
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
          textEnded(sessionID, "msg_markdown", deltas.join("")),
          ...deltas.map((delta) => reasoningDelta(sessionID, "msg_markdown", delta)),
          reasoningEnded(sessionID, "msg_markdown", deltas.join("")),
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
        const seen = Bun.markdown.html(markdown, {
          autolinks: true,
          strikethrough: true,
          tables: true,
          tasklists: true,
        })
        expect([deltas, seen]).not.toEqual([deltas, expect.stringMatching(/<(img|picture|source)\b/i)])
        // A reference definition is never drawn, so only an inline address is read in the text.
        if (!deltas.join("").includes("[ref]:")) expect(reached(markdown)).toContain(address)
      }
    }
    // The controls: prose keeps its emphasis and links, and a fenced block keeps its marks.
    for (const markdown of ["*bold* and [a link](https://example.com/)", "```\nlet v = vec![1]; // <img src=x>\n```"])
      expect(await streamed([markdown])).toEqual([markdown, markdown])
    // A code span is not sure to be code to every renderer, so its marks take joiners as prose does.
    expect(await streamed(["use `vec![1]` and `<img>` here"])).toEqual(
      Array(2).fill(`use \`vec!${JOINER}[1]\` and \`<${JOINER}img>\` here`),
    )
    // An autolink's `<` takes a word joiner as a tag's does, and its address is still a link.
    const autolink = await streamed(["see <https://example.com/>"])
    expect(autolink).toEqual(Array(2).fill(`see <${JOINER}https://example.com/>`))
    for (const markdown of autolink) expect(reached(markdown)).toContain("https://example.com/")
    // Code split across pieces is still code.
    expect(await streamed(["``", "`\n![x](y)\n``", "`"])).toEqual(Array(2).fill("```\n![x](y)\n```"))
  })

  // m5-quality fix loop 3 (classes 6 and 9): a backtick is code only where Markdown is sure to read it so. A lone, an
  // escaped or a broken one, one inside a link's address, an autolink or a table cell, and a fence that a list or a
  // line ending other than `\n` hides, each leaves what follows it as prose, so no image or tag after it is drawn.
  const ADDRESS = "https://evil.example/p.png"
  const RENDERER = { autolinks: true, strikethrough: true, tables: true, tasklists: true }
  const OPENS_NO_CODE = [
    "Press the ` key. IMAGE",
    "Press the \\` key. IMAGE",
    "Press the \\` key. IMAGE `",
    "a ` b\n\nIMAGE",
    "a ` b\n\nIMAGE `",
    "`a\nb ` IMAGE `",
    "`a\r\nb ` IMAGE `",
    "[a](b`c) IMAGE `",
    '[a](b "t)`x") IMAGE `',
    "[a](\nb`c) IMAGE `",
    "<https://a.example/`b> IMAGE `",
    "```a`b\nIMAGE",
    "a\n    ```\nIMAGE",
    "a\n    ```\n    IMAGE",
    "| a | b |\n|---|---|\n| `x IMAGE | y` |",
    "1. ~~~\n~~~\nIMAGE",
    "   ```\nx\n```\nIMAGE",
    "- a\n  ```\n  b\nc IMAGE",
    "```\rcode\r```\rIMAGE",
    "```\r\ncode\r\n```\r\nIMAGE",
    "<!--\n```\n-->\nIMAGE",
    // A shorter run inside a longer fence closes nothing, so the run that does close it opens no block after it.
    "````\n```\n````\nIMAGE",
    // Fix loop 4: a closing run four spaces or a tab in is code to Markdown, and a renderer that took it as the
    // closing line would read the real one as an opening line, so neither block after it is taken as code.
    "```\n    ```\n```\nIMAGE",
    "```\n\t```\n```\nIMAGE",
    "~~~\n    ~~~\n~~~\nIMAGE",
    "Code:\n\n```md\n    ```\n```\n\nIMAGE\n",
    // Fix loop 5: md4c reads a fence line in a table's rows as one more row, up to a blank line, so the lines after it
    // are cells and not code.
    "| a | b |\n|---|---|\n| 1 | 2 |\n```\nIMAGE\n```",
    "| a | b |\n|---|---|\n| 1 | 2 |\n~~~\nIMAGE\n~~~",
    "a | b\n--|--\n```\nIMAGE\n```",
    "| a |\n|---|\n```\n| IMAGE |\n```",
    "-|-\n-|-\r~~~\nIMAGE",
    "a | b\n|---|---|\n# h\n```\nIMAGE\n```",
    "| a | b |\n|:-|-:|\n| 1 | 2 |\n```\nIMAGE\n```",
    // And it reads the next line that is not blank after a list item that holds only a task box as that item's text,
    // a fence line too.
    "- [ ]\n```\nIMAGE\n```",
    "- [ ]\n\n```\nIMAGE\n```",
    "* [ ]\n```\nIMAGE\n```",
    "* [x]\n\n~~~\nIMAGE\n~~~",
    "1. [ ]\n```\nIMAGE\n```",
    "1. [ ]\n\n\n```\nIMAGE\n```",
    "- [ ] \n```\nIMAGE\n```",
    "> - [ ]\n```\nIMAGE\n```",
    "- [X]\n```\nIMAGE\n```",
    "- - [ ]\n```\nIMAGE\n```",
    "- [ ]\n\t\n```\nIMAGE\n```",
  ]

  test.each(OPENS_NO_CODE)(
    "the model's Markdown %p: what follows a backtick that opens no code is prose",
    async (row) => {
      for (const image of [`![x](${ADDRESS})`, `<img src=${ADDRESS}>`]) {
        const whole = row.replace("IMAGE", image)
        for (const deltas of [[whole], whole.split("")]) {
          for (const markdown of await streamed(deltas)) {
            const seen = Bun.markdown.html(markdown, RENDERER)
            expect([whole, seen]).not.toEqual([whole, expect.stringMatching(/<img\b/i)])
            expect(reached(markdown)).toContain(ADDRESS)
          }
        }
      }
    },
  )

  // Markdown reads the second line as code, so its block holds the image; a renderer that takes that line as the
  // closing one reads the block from the third line to the fifth, and the image as prose. So the tracker gives up there.
  test("the model's Markdown: after a closing run further in, no later block is taken as code", () => {
    expect(withoutImages(prose, "```\n    ```\n```\nx\n```\n![x](u)")[1]).toBe(
      `\`\`\`\n    \`\`\`\n\`\`\`\nx\n\`\`\`\n!${JOINER}[x](u)`,
    )
  })

  // The tracker does not follow where a quote ends, so a delimiter row behind quote marks starts a table as one without
  // them does, and a fence line after it opens no block: md4c reads that block as code, so at most a mark in it shows
  // escaped.
  test("the model's Markdown: a fence line after a quoted table is not taken as code", () => {
    expect(withoutImages(prose, "> a | b\n> --|--\n```\n![x](u)\n```")[1]).toBe(
      `> a | b\n> --|--\n\`\`\`\n!${JOINER}[x](u)\n\`\`\``,
    )
  })

  // Fix loop 8 (classes 6 and 9, decision 1b): text is left as written only in a fenced block that every renderer reads
  // as code, one that opens at the text's start or after a blank line, outside any paragraph, list item, quote, table or
  // definition. Whole and in pieces of one character.
  test("the model's Markdown: a fenced block at the text's start or after a blank line is written as it is", async () => {
    for (const markdown of [
      "~~~\n```\n<img src=x>\n~~~",
      "````\n```\n<img src=x>\n````",
      "Code:\n\n```\n<img src=x>\n```",
      "   ```\n   <img src=x>\n   ```",
      // A closing run three spaces in closes the block, so the block after it and a blank line is code too.
      "```\n<img src=x>\n   ```\n\n```\n<img src=y>\n```",
      // A run of the other mark, or a shorter one, closes nothing at any indentation.
      "```\n    ~~~\n\t``\n<img src=x>\n```",
      // A blank line ends a table, a paragraph and a task item with words, and a line at no indentation after it ends
      // a list.
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<img src=x>\n```",
      "- [ ] Do it\n\n```\n<img src=x>\n```",
      "- [ ]\nDo it\n\n```\n<img src=x>\n```",
      "- a\n\n```\n<img src=x>\n```",
    ])
      expect(await streamed(markdown.split(""))).toEqual([markdown, markdown])
    // A span that the text ends before it closes is prose like any other.
    expect(await streamed(["see `", "![x](u)"])).toEqual(Array(2).fill(`see \`!${JOINER}[x](u)`))
    expect(await streamed(["a [link](https://example.com/) and `<img>`"])).toEqual(
      Array(2).fill(`a [link](https://example.com/) and \`<${JOINER}img>\``),
    )
  })

  // Review 8's shapes: a code span, a fence line right after a paragraph's line, a fence in a list item, a fence right
  // after another block's closing line and one with a pipe in its info string are not code to every renderer, so their
  // marks take joiners. Neither renderer draws an image or a tag from any row, the controls included.
  test.each([
    ["a `<img src=x>` b", `a \`<${JOINER}img src=x>\` b`],
    ["`![x](https://e/p.png)`", `\`!${JOINER}[x](https://e/p.png)\``],
    // The cost: inline code such as a type's parameters carries a joiner a person does not see.
    ["`Vec<T>`", `\`Vec<${JOINER}T>\``],
    ["> ```\n> <img src=x>\n> ```", `> \`\`\`\n> <${JOINER}img src=x>\n> \`\`\``],
    ["``a ` <img src=x> ``", `\`\`a \` <${JOINER}img src=x> \`\``],
    ["para\n```\n<img src=x>\n```", `para\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``],
    ["para\n~~~\n![x](u)\n~~~", `para\n~~~\n!${JOINER}[x](u)\n~~~`],
    ["- item\n\n  ```\n  ![x](u)\n  ```", `- item\n\n  \`\`\`\n  !${JOINER}[x](u)\n  \`\`\``],
    ["1. item\n\n   ```\n   <img src=x>\n   ```", `1. item\n\n   \`\`\`\n   <${JOINER}img src=x>\n   \`\`\``],
    ["- a\n\nb\n\n   ```\n   <img src=x>\n   ```", `- a\n\nb\n\n   \`\`\`\n   <${JOINER}img src=x>\n   \`\`\``],
    ["```\na\n```\n```\n<img src=x>\n```", `\`\`\`\na\n\`\`\`\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``],
    ["```a|b\n-|-\n<img src=x>\n```", `\`\`\`a|b\n-|-\n<${JOINER}img src=x>\n\`\`\``],
    // A carriage return and a line feed end one line, so the fence line is right after the paragraph's.
    ["para\r\n```\r\n<img src=x>\r\n```", `para\r\n\`\`\`\r\n<${JOINER}img src=x>\r\n\`\`\``],
    // A fence line that opens no block the tracker is sure of, a closing run with anything after it, and a line that
    // starts to the left of an indented opening line each leave it unsure of every later block: here the renderers
    // read the last tag as prose.
    ["1. ```\n```\n\n```\n<img src=x>\n```", `1. \`\`\`\n\`\`\`\n\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``],
    ["```\n```js\n\n```\n<img src=x>\n```", `\`\`\`\n\`\`\`js\n\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``],
    ["   ```\nx\n\n```\n<img src=x>\n```", `   \`\`\`\nx\n\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``],
    // The same left line, inside the block: from it on the tracker writes joiners, even where Markdown reads code.
    ["   ```\nx\n<img src=x>\n   ```", `   \`\`\`\nx\n<${JOINER}img src=x>\n   \`\`\``],
    // Bun and `marked` read a run four spaces in, or after a tab, as a line of the block, so the fence line after the
    // blank line closes the block and both draw the image after it: a tracker that took the run as closing would open a
    // block at that fence line and leave the image whole.
    ["```\n    ```\n\n```\n![x](u)\n```", `\`\`\`\n    \`\`\`\n\n\`\`\`\n!${JOINER}[x](u)\n\`\`\``],
    ["```\n\t```\n\n```\n![x](u)\n```", `\`\`\`\n\t\`\`\`\n\n\`\`\`\n!${JOINER}[x](u)\n\`\`\``],
    // A fence line four spaces in is indented code to Markdown and no fence, so it opens no block the tracker is sure of.
    ["    ```\n    <img src=x>\n    ```", `    \`\`\`\n    <${JOINER}img src=x>\n    \`\`\``],
    // The controls: a fence at the text's start, after a blank line, and at no indentation after a list.
    ["```\n<img src=x>\n```", "```\n<img src=x>\n```"],
    ["para\n\n```\n<img src=x>\n```", "para\n\n```\n<img src=x>\n```"],
    ["- item\n\n```\n<img src=x>\n```", "- item\n\n```\n<img src=x>\n```"],
  ])("the model's Markdown %p: only a fenced block every renderer reads as code is left as written", (value, written) => {
    const [, out] = withoutImages(prose, value)
    expect(out).toBe(written)
    for (const html of [Bun.markdown.html(out, RENDERER), marked.parse(out, { gfm: true, async: false }) as string])
      expect([value, html]).not.toEqual([value, expect.stringMatching(/<img\b/i)])
  })

  // A client that joins two texts reads a fence line a few spaces in at the second's start as part of a list item that
  // the first ends with, so it takes joiners; at no indentation it is code in either reading.
  test("the model's Markdown: a fence line that starts a text after a list that the text before ends with", () => {
    const [before] = withoutImages(prose, "- item\n\n")
    expect(withoutImages(follow(prose, before), "  ```\n  <img src=x>\n  ```")[1]).toBe(
      `  \`\`\`\n  <${JOINER}img src=x>\n  \`\`\``,
    )
    expect(withoutImages(follow(prose, before), "```\n<img src=x>\n```")[1]).toBe("```\n<img src=x>\n```")
    // A title that the text before leaves open runs on over a blank line to `marked`.
    const [title] = withoutImages(prose, '[r]: /u "\n')
    expect(withoutImages(follow(prose, title), "\n```\n<img src=x>\n```")[1]).toBe(
      `\n\`\`\`\n<${JOINER}img src=x>\n\`\`\``,
    )
  })

  // Fix loop 4 (classes 6 and 9): ACP gives a chunk no text boundary. A client may draw the chunks of each message ID
  // as one block, append every chunk of a kind to the last block until a tool call, or start a block at each chunk of
  // the other kind, so what one text leaves open reaches the next text, of the same message or of a retry under a new
  // ID, in a reasoning part as in a message, live and on a session/load replay. In the rows below, what md4c draws for
  // any of the three has no image or tag.
  type Chunk = { sessionUpdate: string; messageId?: string; content?: { type: string; text?: string } }
  const blocks = (updates: Chunk[]) => {
    const byMessage = new Map<string, string>()
    // Every chunk of a kind until a tool call, and each run of chunks of one kind.
    const appended: Array<Map<string, string>> = [new Map()]
    const runs = [{ kind: "", text: "" }]
    for (const update of updates) {
      if (update.sessionUpdate === "tool_call") {
        appended.push(new Map())
        runs.push({ kind: "", text: "" })
      }
      if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") continue
      const text = update.content?.text ?? ""
      const id = update.messageId ?? ""
      byMessage.set(id, (byMessage.get(id) ?? "") + text)
      const joined = appended.at(-1)!
      joined.set(update.sessionUpdate, (joined.get(update.sessionUpdate) ?? "") + text)
      const run = runs.at(-1)!
      if (run.kind === update.sessionUpdate) run.text += text
      else runs.push({ kind: update.sessionUpdate, text })
    }
    const joined = appended.flatMap((map) => [...map.values()])
    return { all: [...joined, ...runs.map((run) => run.text), ...byMessage.values()], appended: joined }
  }
  const noImage = (label: string, updates: Chunk[], shown = true) => {
    const seen = blocks(updates)
    for (const block of seen.all)
      expect([label, Bun.markdown.html(block, RENDERER)]).not.toEqual([label, expect.stringMatching(/<img\b/i)])
    if (shown) expect(seen.appended.map(reached).join("\n")).toContain(ADDRESS)
  }
  const text = (sessionID: string, id: string, value: string, ordinal = 0) => [
    textDelta(sessionID, id, value, ordinal),
    textEnded(sessionID, id, value, ordinal),
  ]
  // Two texts, the second either the next text of the same message or a retry's under a new message ID.
  const PAIRS: Array<[string, string, string]> = [
    ["a fence that text 0 leaves open", "```\n", "```\nIMAGE\n```"],
    ["a cut-off attempt's code block", "Here:\n```html\n<div>", "Here:\n```\nIMAGE\n```"],
    ["a span that text 0 leaves open", "see `a", "b` IMAGE `c`"],
    ["a line that text 0 leaves open", "a", "```\nIMAGE\n```"],
    ["a paragraph that text 0 leaves mixed", "a ` b\n", "c ` IMAGE `"],
    ["a fence that text 0 has lost", "1. ~~~\n", "~~~\nIMAGE"],
  ]
  // Fix loop 5: a backtick that starts text 1 lengthens the run that closed text 0's span in a client that joins
  // them, and text 1's first line break ends text 0's line rather than a blank one.
  const RUNS_ON: Array<[string, string, string]> = [
    ["a span that closes at text 0's end", "Run `IMAGE`", "` next"],
    ["a span of two marks that closes at text 0's end", "Run ``a``", "` IMAGE ` x"],
    ["a line that text 0 leaves after a run", "a```", "\n```IMAGE```"],
  ]
  // A fence line that starts text 1 is a row of the table, or the text of the task item, that text 0 ends with.
  const ENDS_WITH: Array<[string, string, string]> = [
    ["a table that text 0 ends with", "| a | b |\n|---|---|\n", "```\nIMAGE\n```"],
    ["an empty task item that text 0 ends with", "- [ ]\n\n", "```\nIMAGE\n```"],
  ]
  const JOINS: Array<[string, (sessionID: string, image: string) => OrbitEvent[]]> = [
    ...[...PAIRS, ...RUNS_ON, ...ENDS_WITH].flatMap(([label, first, then]): typeof JOINS =>
      (["msg_a", "msg_b"] as const).map((id) => [
        `${label}, then ${id === "msg_a" ? "text 1 of the same message" : "a text of a new message"}`,
        (s, image) => [
          ...text(s, "msg_a", first.replace("IMAGE", image)),
          ...text(s, id, then.replace("IMAGE", image), id === "msg_a" ? 1 : 0),
        ],
      ]),
    ),
    // A client that joins a message ID's chunks joins text 1 to text 0 across another message's text between them.
    ...RUNS_ON.map(([label, first, then]): (typeof JOINS)[number] => [
      `${label}, then a clean text of another message, then text 1`,
      (s, image) => [
        ...text(s, "msg_a", first.replace("IMAGE", image)),
        ...text(s, "msg_b", "x\n"),
        ...text(s, "msg_a", then.replace("IMAGE", image), 1),
      ],
    ]),
    // Text 1 is read after the lines of text 0 by a client that joins a message ID's chunks, and after those of the
    // other message's text by one that appends, so the one whose lines a fence line after them is less sure of counts.
    ...(
      [
        ["an empty task item that text 0 ends with", "- [ ]\n", "\n```\nIMAGE\n```"],
        ["a line that text 0 ends with", "a\n", "```\nIMAGE\n```"],
      ] as const
    ).map(([label, first, then]): (typeof JOINS)[number] => [
      `${label}, then a table that another message's text ends with, then text 1`,
      (s, image) => [
        ...text(s, "msg_a", first),
        ...text(s, "msg_b", "| a | b |\n|---|---|\n"),
        ...text(s, "msg_a", then.replace("IMAGE", image), 1),
      ],
    ]),
    [
      "two reasoning parts",
      (s, image) => [
        reasoningDelta(s, "msg_a", "```\n", 0),
        reasoningEnded(s, "msg_a", "```\n", 0),
        reasoningDelta(s, "msg_a", `\`\`\`\n${image}\n\`\`\``, 1),
        reasoningEnded(s, "msg_a", `\`\`\`\n${image}\n\`\`\``, 1),
      ],
    ],
    [
      "a subagent's text on the session's own updates",
      (s, image) => [
        ...text(s, "msg_a", "```\n"),
        childCreated("ses_child", s, "Explore"),
        ...text("ses_child", "msg_child", `\`\`\`\n${image}\n\`\`\``),
      ],
    ],
    // A tool call starts a new block in a client that appends, so a text it cuts reads afresh there.
    [
      "a fence that a tool call cuts",
      (s, image) => [
        textDelta(s, "msg_a", "```\n"),
        toolStarted(s, "call_cut", "read"),
        textDelta(s, "msg_a", `${image}\n\`\`\``),
        textEnded(s, "msg_a", `\`\`\`\n${image}\n\`\`\``),
      ],
    ],
    [
      "a span that a tool call cuts",
      (s, image) => [
        textDelta(s, "msg_a", "`a"),
        toolStarted(s, "call_cut", "read"),
        textDelta(s, "msg_a", ` ${image} \``),
        textEnded(s, "msg_a", `\`a ${image} \``),
      ],
    ],
    // A span left open while a subagent's text is sent goes on after that text in a client that appends.
    [
      "a span held while a subagent's text is sent",
      (s, image) => [
        textDelta(s, "msg_a", "`a"),
        childCreated("ses_child", s, "Explore"),
        ...text("ses_child", "msg_child", "see `"),
        textDelta(s, "msg_a", ` ${image} \``),
        textEnded(s, "msg_a", `\`a ${image} \``),
      ],
    ],
  ]

  // The chunks a client was sent of a turn of `events`, and the child updates.
  async function chunked(events: (sessionID: string) => OrbitEvent[], childSessionUpdates = false) {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) => turn(sessionID, id, ...events(sessionID)),
      capabilities: { childSessionUpdates },
    })
    await acp.prompt(acp.sessionId, "hello")
    return {
      updates: acp.updates.map((item) => item.update as Chunk),
      children: acp.childUpdates.flatMap((item) => (item.type === "update" ? [item.update as Chunk] : [])),
    }
  }

  test.each(JOINS)(
    "the model's Markdown: %s draws no image or tag in a client that joins texts or not",
    async (_, row) => {
      for (const image of [`![x](${ADDRESS})`, `<img src=${ADDRESS}>`])
        noImage(image, (await chunked((s) => row(s, image))).updates)
    },
  )

  test("the model's Markdown: a `!` that ends a text makes no image of a `[` that starts the next", async () => {
    const seen = await chunked((s) => [...text(s, "msg_a", "see !"), ...text(s, "msg_b", `[x](${ADDRESS})`)])
    noImage("!", seen.updates)
  })

  // Fix loop 6 (classes 6 and 9): what image-fuzz.test.ts found with `marked` as the renderer. `marked` reads a link's
  // text again after unescaping it (H), takes a run with more backticks or tildes after it, and not one with a tab, as
  // a closing line (I and K), and runs a bare address on over a backtick (J). So an escape, a block or a span that the
  // tracker was sure of did not hold there. Each text goes through the wire as one or two texts of one message, and no
  // block a client draws of them has an image or a tag, with md4c or with `marked`.
  const MARKED_ROWS: Array<[string, string[], "apart"?]> = [
    ["H: an image in a link's text after a `[`", ["[[IMAGE]()"]],
    ["H across two texts of one message", ["[", "[IMAGE]()"]],
    ["I: a backtick fence closed by a run with a tilde after it", ["```\n```~\nIMAGE"]],
    ["I with carriage returns", ["```\r```~\rIMAGE"]],
    ["I: a closing run with a tab after it", ["```\nx\n```\t\nok\n```\nIMAGE\n```"]],
    ["J: a span after `www.`", ["www.m`IMAGE`"]],
    ["J: a span after `http`", ["http://e`IMAGE`"]],
    ["J: a span after an address that one text ends with", ["http://e", "```IMAGE```"]],
    ["K: a tilde fence closed by a run with a backtick after it", ["~~~\n~~~`\nIMAGE"]],
    // Fix loop 7, L: a reference's label takes a backtick in it from a code span, in md4c for a full reference and in
    // `marked` for a collapsed or a shortcut one too, so the span the tracker held from that backtick was prose there.
    ["L: a full reference whose label holds a backtick", ["[foo][b`] IMAGE `\n\n[b`]: /u"]],
    ["L: a collapsed reference whose label holds a backtick", ["[b`][] IMAGE `\n\n[b`]: /u"]],
    ["L: a shortcut reference whose label holds a backtick", ["[b`] IMAGE `\n\n[b`]: /u"]],
    ["L with the definition first", ["[b`]: /u\n\n[b`] IMAGE `"]],
    ["L: a label over two lines", ["[x][b\n`] IMAGE `\n\n[b\n`]: /u"]],
    ["L: a label that one text leaves open", ["[x][b\n", "`] IMAGE `\n\n[b\n`]: /u"]],
    ["L: a label that one message's text leaves open", ["[x][b\n", "`] IMAGE `\n\n[b\n`]: /u"], "apart"],
    // M: `marked` reads a link reference definition before any block, and its destination may stand on the next line
    // and its label and title may run over several, so a fence line there is part of the definition to it while md4c
    // opens a block. The block's lines are then prose to `marked`.
    ["M: a label alone before a fence line", ["[r]:\n```\nIMAGE\n```"]],
    ["M: a label and a space before a tilde fence", ["[r]: \n~~~\nIMAGE\n~~~"]],
    ["M: a label with a space in it", ["[a b]:\n```\nIMAGE\n```"]],
    ["M: a longer fence", ["[r]:\n````\nIMAGE\n````"]],
    ["M: an indented fence", ["[r]:\n   ```\n   IMAGE\n   ```"]],
    ["M: in a list item", ["- [r]:\n  ```\n  IMAGE\n  ```"]],
    ['M: a `"` title left open', ['[r]: /u "\n```\n"\nIMAGE\n```']],
    ["M: a `(` title left open", ["[r]: /u (\n```\n)\nIMAGE\n```"]],
    ["M: a `'` title left open", ["[r]: /u '\n```\n'\nIMAGE\n```"]],
    ["M: a title opened on the next line", ['[r]: /u\n"\n```\n"\nIMAGE\n```']],
    ["M: a label left open", ["[\n```\n]: /u\nIMAGE\n```"]],
    ['M: a `"` title over a blank line', ['[r]: /u "\n\n```\n"\nIMAGE\n```']],
    ["M: a `(` title over a blank line", ["[r]: /u (\n\n```\n)\nIMAGE\n```"]],
    ["M: a label over a blank line", ["[\n\n```\n]: /u\nIMAGE\n```"]],
    ["M: a label that one text ends with", ["[r]:\n", "```\nIMAGE\n```"]],
    ["M: a definition that one text ends with, and a title in the next", ["[r]: /u\n", '"\n```\n"\nIMAGE\n```']],
    ["M: a label that one message's text ends with", ["[r]:\n", "```\nIMAGE\n```"], "apart"],
    [
      "M: a definition that one message's text ends with, and a title in the next",
      ["[r]: /u\n", '"\n```\n"\nIMAGE\n```'],
      "apart",
    ],
    // The controls: a definition does not start inside a paragraph or past a quote's marks for `marked`.
    ["M's control: a label after a line of text", ["a\n[r]:\n```\nIMAGE\n```"]],
    ["M's control: a label in a quote", ["> [r]:\n> ```\n> IMAGE\n> ```"]],
    // And an inline link's text gives a span the priority in both.
    ["L's control: a backtick in an inline link's text", ["[a `x](/u) IMAGE `"]],
    ["L's control: a link's text that is one backtick", ["[`](/u) IMAGE `"]],
  ]

  // A row marked "apart" sends each text as a message of its own. The default keeps the callback's arity at two, which
  // bun's `test.each` would otherwise read as a done callback for rows without the mark.
  test.each(MARKED_ROWS)(
    "the model's Markdown, %s: no image or tag with either renderer",
    async (_, texts, apart = undefined) => {
      for (const image of [`![x](${ADDRESS})`, `<img src=${ADDRESS}>`]) {
        const seen = await chunked((s) =>
          texts.flatMap((value, ordinal) =>
            apart
              ? text(s, `msg_${ordinal}`, value.replaceAll("IMAGE", image))
              : text(s, "msg_a", value.replaceAll("IMAGE", image), ordinal),
          ),
        )
        for (const block of blocks(seen.updates).all)
          for (const html of [
            Bun.markdown.html(block, RENDERER),
            marked.parse(block, { gfm: true, async: false }) as string,
          ])
            expect([texts, html]).not.toEqual([texts, expect.stringMatching(/<img\b/i)])
      }
    },
  )

  // Where the tracker is unsure, a fenced block takes joiners as prose does, even one after a blank line: after a line
  // with a tilde or the start of an address that GFM links by itself, after a fence line it is not sure of, and after a
  // closing run that anything but spaces follows. A block it is sure of is as written.
  test.each([
    ["~/x\n\n```\n<img>\n```", `~/x\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["see www.example.com\n\n```\n<img>\n```", `see www.example.com\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["see http://e\n\n```\n<img>\n```", `see http://e\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    // GFM links an address's start in any case.
    ["ftp://e\n\n```\n<img>\n```", `ftp://e\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["HTTP://e\n\n```\n<img>\n```", `HTTP://e\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["WWW.example.com\n\n```\n<img>\n```", `WWW.example.com\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["see FTP://e\n\n```\n<img>\n```", `see FTP://e\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["1. ~~~\n~~~\n\n```\n<img>\n```", `1. ~~~\n~~~\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["```\n```js\n```\n\n```\n<img>\n```", `\`\`\`\n\`\`\`js\n\`\`\`\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    // The controls: a tilde fence, a closing run that only spaces follow, and an address's start cut by a line break
    // leave the tracker sure.
    ["~~~\n<img>\n~~~\n\n```\n<img>\n```", "~~~\n<img>\n~~~\n\n```\n<img>\n```"],
    ["```\n<img>\n```  \n\n```\n<img>\n```", "```\n<img>\n```  \n\n```\n<img>\n```"],
    ["www\n.\n\n```\n<img>\n```", "www\n.\n\n```\n<img>\n```"],
    // A code span takes joiners wherever it stands, in a link's text or not.
    ["[b`] `<img>`", `[b\`] \`<${JOINER}img>\``],
    ["[`<img>`](u)", `[\`<${JOINER}img>\`](u)`],
    ["[a](u) `<img>`", `[a](u) \`<${JOINER}img>\``],
    ["\\[b `<img>`", `\\[b \`<${JOINER}img>\``],
    ["a [b\n```\nx\n```\n`<img>`", `a [b\n\`\`\`\nx\n\`\`\`\n\`<${JOINER}img>\``],
    // A fence line that a link reference definition may still take opens no block, and leaves the tracker unsure: one
    // right after it, and one after a blank line that `marked` reads a label or a `"` or `(` title on over.
    ["[r]:\n```\n<img>\n```", `[r]:\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ['[r]: /u "\n\n```\n<img>\n```', `[r]: /u "\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["[r]: /u (a\n\n```\n<img>\n```", `[r]: /u (a\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ['[r]: /u\n"a\n\n```\n<img>\n```', `[r]: /u\n"a\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["[a\nb\n\n```\n<img>\n```", `[a\nb\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ["[a\\\n\n```\n<img>\n```", `[a\\\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ['[r]: /u "\na\n\n```\n<img>\n```', `[r]: /u "\na\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    ['[r]: <u v> "\n\n```\n<img>\n```', `[r]: <${JOINER}u v> "\n\n\`\`\`\n<${JOINER}img>\n\`\`\``],
    // The controls: a definition that is whole, or that is no definition, ends at a blank line, so the block after it
    // is code, and so is one after a `'` title that a blank line ends.
    ["[r]: /u\n\n```\n<img>\n```", "[r]: /u\n\n```\n<img>\n```"],
    ['[r]: /u "t"\n\n```\n<img>\n```', '[r]: /u "t"\n\n```\n<img>\n```'],
    ["[r]: /u (t)\n\n```\n<img>\n```", "[r]: /u (t)\n\n```\n<img>\n```"],
    ['[r]: /u\n"t"\n\n```\n<img>\n```', '[r]: /u\n"t"\n\n```\n<img>\n```'],
    ["[r]: /u '\n\n```\n<img>\n```", "[r]: /u '\n\n```\n<img>\n```"],
    ["[r]:\n/u '\n\n```\n<img>\n```", "[r]:\n/u '\n\n```\n<img>\n```"],
    ["[r]:\n\n```\n<img>\n```", "[r]:\n\n```\n<img>\n```"],
    ["[a]: /u\n[r]:\n\n```\n<img>\n```", "[a]: /u\n[r]:\n\n```\n<img>\n```"],
    ["[r]\n\n```\n<img>\n```", "[r]\n\n```\n<img>\n```"],
    ["[r]: <u\n\n```\n<img>\n```", `[r]: <${JOINER}u\n\n\`\`\`\n<img>\n\`\`\``],
    ["[r]: /u x\n\n```\n<img>\n```", "[r]: /u x\n\n```\n<img>\n```"],
    ['[r]: /u"t\n\n```\n<img>\n```', '[r]: /u"t\n\n```\n<img>\n```'],
    ["[a[b]:\n\n```\n<img>\n```", "[a[b]:\n\n```\n<img>\n```"],
  ])("the model's Markdown %p: where the tracker is unsure, code takes joiners", (value, written) => {
    expect(withoutImages(prose, value)[1]).toBe(written)
  })

  // In prose a joiner follows a `<` that opens a tag, a closing tag, a comment or a processing instruction, in any
  // case, and a `!` before a `[`; a `!` or a `<` before anything else is as written.
  test.each([
    ["<IMG SRC=x>", `<${JOINER}IMG SRC=x>`],
    ["<Picture>", `<${JOINER}Picture>`],
    ["</p><img src=x>", `<${JOINER}/p><${JOINER}img src=x>`],
    ["<!-- c -->", `<${JOINER}!-- c -->`],
    ["<?php x ?>", `<${JOINER}?php x ?>`],
    ["Hi! ![x](u)", `Hi! !${JOINER}[x](u)`],
    // The controls.
    ["Hi! there.", "Hi! there."],
    ["a!b and !(c)", "a!b and !(c)"],
    ["a < b <3 <-", "a < b <3 <-"],
  ])("the model's Markdown %p: a `<` or a `!` takes a joiner only before a tag or an image", (value, written) => {
    expect(withoutImages(prose, value)[1]).toBe(written)
  })

  // A carriage return and a line feed end one line only when nothing comes between them, so the text is never
  // changed. Whole and cut at every point.
  test.each(["x\r`y\nz", "``a``\r`\n", "a\r`b`\nc", "a\r\n`b`\r\n"])(
    "the model's Markdown %p: a line break after a carriage return keeps its place",
    (value) => {
      for (const cut of Array.from({ length: value.length + 1 }, (_, index) => index)) {
        const [state, first] = withoutImages(prose, value.slice(0, cut))
        expect(first + withoutImages(state, value.slice(cut))[1]).toBe(value)
      }
    },
  )

  test("the model's Markdown: what follows a clean text, a tool call or another channel is as written", async () => {
    const code = "```\nlet v = vec![1]; // <img src=x>\n```"
    const sent = (updates: Chunk[], id: string) =>
      updates
        .flatMap((update) => (update.messageId === id && update.content?.text ? [update.content.text] : []))
        .join("")
    // A text that ends after a blank line with nothing open leaves the next as it is, and one that ends after a line of
    // a paragraph leaves a fence line that starts the next one unsure, as a client that joins them reads it there.
    const clean = await chunked((s) => [...text(s, "msg_a", "Here is the code:\n\n"), ...text(s, "msg_a", code, 1)])
    expect(sent(clean.updates, "msg_a")).toBe(`Here is the code:\n\n${code}`)
    const joined = await chunked((s) => [...text(s, "msg_a", "Here is the code:\n"), ...text(s, "msg_a", code, 1)])
    expect(sent(joined.updates, "msg_a")).toBe(
      `Here is the code:\n${code.replace("!", `!${JOINER}`).replace("<", `<${JOINER}`)}`,
    )
    // A backtick is never escaped, at a text's start or anywhere else.
    for (const next of [" and `pwd` here", "\n`pwd` here", "` next"]) {
      const spans = await chunked((s) => [...text(s, "msg_a", "Run `ls`"), ...text(s, "msg_a", next, 1)])
      expect(sent(spans.updates, "msg_a")).toBe(`Run \`ls\`${next}`)
    }
    // After a tool call, a client draws the next text in a block of its own.
    const cut = await chunked((s) => [
      ...text(s, "msg_a", "```\n"),
      toolStarted(s, "call_a", "read"),
      ...text(s, "msg_b", code),
    ])
    expect(sent(cut.updates, "msg_b")).toBe(code)
    // A client that takes a subagent's updates apart draws its text apart from the session's.
    const child = await chunked(
      (s) => [
        ...text(s, "msg_a", "```\n"),
        childCreated("ses_child", s, "Explore"),
        ...text("ses_child", "msg_child", code),
      ],
      true,
    )
    expect(sent(child.children, "msg_child")).toBe(code)
  })

  // A session/load replay sends each text part whole, and carries what one leaves open to the next across messages.
  async function replayed(messages: unknown[]) {
    await using acp = await startWire()
    acp.server.sessions.set("ses_joined", makeSession("ses_joined"))
    acp.server.messages.set("ses_joined", messages as SessionMessageInfo[])
    await acp.initialize()
    await acp.request("session/load", { cwd: "/workspace", sessionId: "ses_joined", mcpServers: [] })
    return acp.updates.map((item) => item.update as Chunk)
  }
  const assistant = (id: string, ...content: unknown[]) => ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    content,
    time: { created: 1 },
  })
  const part = (value: string) => ({ type: "text", text: value })
  const call = {
    type: "tool",
    id: "call_a",
    name: "read",
    time: { created: 1 },
    state: { status: "running", input: {} },
  }

  test("a loaded session's replay: what one text part or message leaves open reaches the next", async () => {
    for (const image of [`![x](${ADDRESS})`, `<img src=${ADDRESS}>`]) {
      for (const [label, first, then] of [...RUNS_ON, ...ENDS_WITH]) {
        const [before, after] = [first.replace("IMAGE", image), then.replace("IMAGE", image)]
        noImage(`${label} in two parts`, await replayed([assistant("msg_a", part(before), part(after))]))
        noImage(
          `${label} in two messages`,
          await replayed([assistant("msg_a", part(before)), assistant("msg_b", part(after))]),
        )
      }
      const after = `\`\`\`\n${image}\n\`\`\``
      noImage("two parts", await replayed([assistant("msg_a", part("```\n"), part(after))]))
      noImage("two messages", await replayed([assistant("msg_a", part("```\n")), assistant("msg_b", part(after))]))
      noImage(
        "a compaction between",
        await replayed([
          assistant("msg_a", part("```\n")),
          { id: "msg_c", type: "compaction", status: "completed", reason: "auto", time: { created: 1 } },
          assistant("msg_b", part(after)),
        ]),
      )
      // A running compaction sends nothing.
      noImage(
        "a running compaction between",
        await replayed([
          assistant("msg_a", part("```\n")),
          { id: "msg_c", type: "compaction", status: "running", reason: "auto", time: { created: 1 } },
          assistant("msg_b", part(after)),
        ]),
      )
      // A message that fails to translate part way leaves what it sent unknown, so the next text is written as if open.
      noImage(
        "a message that fails part way",
        await replayed([
          assistant("msg_a", part("```\n"), { type: "tool", id: "call_bad", name: "read", time: { created: 1 } }),
          assistant("msg_b", part(after)),
        ]),
      )
    }
    // The controls: after a tool call or a prompt, a client draws the next message's text in a block of its own. (One
    // that draws a message's chunks as one block joins the text after a call to the text before it in that message.)
    const code = "```\nlet v = vec![1]; // <img src=x>\n```"
    const last = (updates: Chunk[]) => updates.findLast((update) => update.sessionUpdate === "agent_message_chunk")
    expect(
      last(await replayed([assistant("msg_a", part("```\n"), call), assistant("msg_b", part(code))]))?.content?.text,
    ).toBe(code)
    const prompt = { id: "msg_u", type: "user", text: "next", time: { created: 1 } }
    expect(
      last(await replayed([assistant("msg_a", part("```\n")), prompt, assistant("msg_b", part(code))]))?.content?.text,
    ).toBe(code)
  })

  const pieces = ["`", "``", "```", "~~~", "\n", "\n\n", "\r", "   ", " ", "\t", "- ", "1. ", "> ", "\\", "](", "["]
  const more = ["]", "(", ")", "!", "|", '"', "a", "<", ">", "<!--", "<https://a.example/", "[r]: ", "    "]
  // Fix loop 5: a table's delimiter row and a list item that holds only a task box.
  const structures = ["|---|", "-|-", "- [ ] ", "- [ ]\n"]
  const marks = [...pieces, ...more, ...structures, `![x](${ADDRESS})`, `<img src=${ADDRESS}>`]
  // A seeded generator, so a failure names a text that fails again.
  const seeded = (start: number) => {
    let seed = start
    return (limit: number) => {
      seed = (seed + 0x6d2b79f5) | 0
      const mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      const value = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((value ^ (value >>> 14)) >>> 0) % limit
    }
  }
  const drawsImage = (markdown: string) => /<(img|picture|source)\b/i.test(Bun.markdown.html(markdown, RENDERER))

  test("the model's Markdown: no text a renderer draws with an image or a tag, over random text in random pieces", () => {
    const random = seeded(20261124)
    const drawn = Array.from({ length: 20000 }, () =>
      Array.from({ length: 4 + random(16) }, () => marks[random(marks.length)]).join(""),
    ).flatMap((text) => {
      const cut = random(text.length + 1)
      const [state, first] = withoutImages(prose, text.slice(0, cut))
      const [, second] = withoutImages(state, text.slice(cut))
      return drawsImage(first + second) ? [text] : []
    })
    expect(drawn).toEqual([])
  })

  // Two texts as the translation writes them: the second a new text after the first (`follow`), drawn as each one's
  // own block and as a client that appends the second to the first draws them, or the next text of the same message,
  // which every client draws after the first.
  test("the model's Markdown: no pair of texts a renderer draws with an image or a tag, apart or joined", () => {
    const random = seeded(20261125)
    const draw = () => Array.from({ length: 2 + random(8) }, () => marks[random(marks.length)]).join("")
    const drawn = Array.from({ length: 20000 }, () => [draw(), draw()] as const).flatMap(([one, two]) => {
      const [before, first] = withoutImages(prose, one)
      const second = withoutImages(follow(prose, before), two)[1]
      const same = withoutImages(before, two)[1]
      return [first, second, first + second, first + same].some(drawsImage) ? [[one, two]] : []
    })
    expect(drawn).toEqual([])
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
        { type: "text", text: "`vec![1]` and ![x](https://evil.example/p.png)" },
        { type: "reasoning", text: "<img src=https://evil.example/p.png>" },
      ],
      time: { created: 1 },
    } as unknown as SessionMessageInfo
    expect(replayed(assistant)).toEqual([
      `\`vec!${JOINER}[1]\` and !${JOINER}[x](https://evil.example/p.png)`,
      `<${JOINER}img src=https://evil.example/p.png>`,
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
    const [command] = availableCommands({
      commands: [{ ...reviewCommand, name: CONTROL, description: CONTROL }],
    } as never)
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
    const mode = buildModeSelectOption({
      modes: [{ id: "m", name: CONTROL, description: CONTROL }],
      currentModeId: "m",
    })
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
