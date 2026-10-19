import { describe, expect, test } from "bun:test"
import { Context, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { MAX_MARKDOWN_BYTES } from "../src/tool/html-markdown"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { Permission } from "@orbit/core/permission"
import { Config } from "@orbit/core/config"
import { Model } from "@orbit/core/model"
import { Session } from "@orbit/core/session"
import { SideQuery } from "@orbit/core/side-query"
import { Document, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/core/tool"
import { WebFetchTool } from "@orbit/core/tool/plugin/webfetch"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Image } from "@orbit/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

// No test resolves a real name: a name answers with `addresses[name]`, or with a public address.
const publicAddress = "93.184.216.34"
const lookups: string[] = []
let addresses: Record<string, ReadonlyArray<string> | Error> = {}
const lookup = async (name: string) => {
  lookups.push(name)
  const answer = addresses[name] ?? [publicAddress]
  if (answer instanceof Error) throw answer
  return answer
}
const withLookup = Effect.gen(function* () {
  const tools = yield* Tool.Service
  yield* tools.transform((editor) => editor.web({ lookup }))
})

const webFetchToolNode = makeLocationNode({
  name: "test/webfetch-tool-plugin",
  layer: Layer.effectDiscard(withLookup.pipe(Effect.andThen(registerToolPlugin(WebFetchTool.Plugin)))),
  deps: [Tool.node, Permission.node, LayerNodePlatform.httpClient, Config.node, SideQuery.node],
})

// The side query is the model boundary: it records what the tool sent and answers with the page itself unless a test
// sets `reply`, so the tests of the fetch read the page from the result. The request SideQuery builds from this input
// (small model, no transcript, no tools) is pinned in side-query.test.ts.
const queries: SideQuery.TextInput[] = []
type Reply = (input: SideQuery.TextInput) => Effect.Effect<string, SideQuery.Error>
const pageOf = (input: SideQuery.TextInput) =>
  input.prompt.slice(input.prompt.indexOf("<page>\n") + 7, input.prompt.indexOf("\n</page>\n"))
const echo: Reply = (input) => Effect.succeed(pageOf(input))
let reply: Reply = echo
const sideQuery = Layer.succeed(
  SideQuery.Service,
  SideQuery.Service.of({
    text: (input) =>
      Effect.sync(() => queries.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => reply(input))),
        Effect.map((text) => ({ text, model: Model.Ref.parse("test/small") })),
      ),
    object: () => Effect.die("WebFetch asks for text"),
  }),
)
// The hosts the configuration lists, read by the tool at each call.
let verbatimHosts: string[] = []
const configLayer = Layer.mock(Config.Service)({
  entries: () =>
    Effect.sync(() => [
      new Document({
        type: "document",
        info: Schema.decodeUnknownSync(Info)({ webfetch: { verbatim_hosts: verbatimHosts } }),
      }),
    ]),
})

const allowLocal = Effect.gen(function* () {
  const tools = yield* Tool.Service
  yield* tools.transform((editor) => editor.web({ allowLocal: true }))
})

const sessionID = Session.ID.make("ses_webfetch_test")
const webFetchUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Orbit-User/1.0; +https://orbit.invalid"
const requests: Array<{
  readonly url: string
  readonly headers: Record<string, string>
  readonly init: globalThis.RequestInit | undefined
}> = []
const assertions: Permission.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

// The client reads the fetch options from the fiber, so a request is recorded with the ones it would have been sent with.
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() =>
      requests.push({
        url: request.url,
        headers: request.headers,
        init: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit),
      }),
    ).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
let denying = false
// A URL whose ask is declined, and a URL whose ask takes this long to answer.
let denyUrl: string | undefined
let slow: { readonly url: string; readonly by: Duration.Duration } | undefined
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(slow !== undefined && input.metadata?.url === slow.url ? Effect.sleep(slow.by) : Effect.void),
      Effect.andThen(
        denying || (denyUrl !== undefined && input.metadata?.url === denyUrl)
          ? Effect.die(new Error("declined"))
          : Effect.void,
      ),
    ),
})
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([Tool.node, webFetchToolNode]), [
    Permission.node.replace(permission),
    Config.node.replace(configLayer),
    SideQuery.node.replace(sideQuery),
    Image.node.replace(imagePassthrough),
    ...replacements,
  ])
const it = testEffect(toolLayer([LayerNodePlatform.httpClient.replace(http)]))
const live = testEffect(toolLayer())

const reset = () => {
  denyUrl = undefined
  verbatimHosts = []
  reply = echo
  queries.length = 0
  slow = undefined
  requests.length = 0
  assertions.length = 0
  lookups.length = 0
  addresses = {}
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "WebFetch", input },
})

describe("WebFetchTool helpers", () => {
  test("requires a prompt, ignores a stale format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(() => decode({ url: "https://example.com" })).toThrow(/prompt/)
    expect(decode({ url: "https://example.com", prompt: "" })).toEqual({ url: "https://example.com", prompt: "" })
    // A stale `format` from an older prompt or client is dropped at decode.
    expect(decode({ url: "https://example.com", prompt: "q", format: "html" })).toEqual({
      url: "https://example.com",
      prompt: "q",
    })
    expect(() => decode({ url: "https://example.com", prompt: "q", timeout: 0 })).toThrow()
    expect(() =>
      decode({ url: "https://example.com", prompt: "q", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 }),
    ).toThrow()
  })

  test("describes a static, vendor-neutral tool that needs a prompt", () => {
    expect(WebFetchTool.description).toContain("prompt")
    expect(WebFetchTool.description).toContain("100,000 characters")
    expect(WebFetchTool.description).not.toMatch(/\bformat\b/i)
  })

  test("ports HTML markdown conversion without active content", () => {
    const html =
      "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong> <product-name>today</product-name></p><style>.bad {}</style>"
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide** today")
  })

  test("renders headings, inline semantics, links, images, breaks, and thematic breaks", () => {
    const html = `<h2>Read <em>this</em></h2><p><a href="https://example.com/a (b)" title="Example">docs</a><br><img src="diagram.png" alt="a ] b"></p><hr><p><del>old</del></p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `## Read *this*\n\n[docs](https://example.com/a%20\\(b\\) "Example")  \n![a \\] b](diagram.png)\n\n---\n\n~~old~~`,
    )
  })

  test("preserves inline and preformatted code verbatim with safe fences", () => {
    const html = `<p>Use <code>say(\`hello\`)</code> now.</p><pre><code class="language-ts">const fence = \`\`\`\n&amp; stays decoded</code></pre>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `Use \`\`say(\`hello\`)\`\` now.\n\n~~~ts\nconst fence = \`\`\`\n& stays decoded\n~~~`,
    )
  })

  test.each([
    ["`x`", "`` `x` ``"],
    ["`x", "`` `x ``"],
    ["x`", "`` x` ``"],
    ["`", "`` ` ``"],
    ["``", "``` `` ```"],
    ["``x`", "``` ``x` ```"],
    ["say(`x`)", "``say(`x`)``"],
    ["a``b`c", "```a``b`c```"],
    ["x", "`x`"],
    [" x ", "`  x  `"],
    [" x", "`  x `"],
    ["x ", "` x  `"],
    ["   ", "`   `"],
    [" ` ", "``  `  ``"],
  ])("preserves inline code boundaries for %j", (content, expected) => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>Use <code>${content}</code>.</p>`)).toBe(`Use ${expected}.`)
  })

  test.each([
    ["discarded trailing backtick after ASCII", "x`", 7, "``x``"],
    ["discarded trailing backtick after Unicode", "😀`", 10, "``😀``"],
    ["discarded trailing backtick with spare room", "x`", 9, "``x``"],
    ["retained trailing backtick", "x`", 10, "`` x` ``"],
    ["new trailing backtick from an internal run", "x`y", 8, "``x``"],
    ["leading backtick without padding room", "`x", 8, ""],
    ["leading backtick alone fits", "`x", 9, "`` ` ``"],
    ["leading backtick with payload fits", "`x", 10, "`` `x ``"],
    ["all backticks truncated", "``", 11, "``` ` ```"],
    ["all backticks fit", "``", 12, "``` `` ```"],
    ["mixed internal runs truncated", "a``b`c", 11, "```a```"],
    ["Unicode code point cannot fit", "😀`", 9, ""],
    ["ordinary payload cannot fit", "x", 3, ""],
    ["spaces cannot fit", "   ", 4, ""],
    ["space-only prefix fits", "   ", 5, "` `"],
    ["truncated prefix becomes space-only", " x", 6, "` `"],
    ["discarded trailing space", "x ", 5, "`x`"],
  ] as const)("fits inline code to its emitted boundaries: %s", (_name, content, spare, expected) => {
    const prefix = "x".repeat(MAX_MARKDOWN_BYTES - 64 * 1024 - spare)
    const html = `<p>${prefix}<code>${content}</code></p>`
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES)
    const output = WebFetchTool.convertHTMLToMarkdown(html)
    expect(output.slice(0, prefix.length)).toBe(prefix)
    expect(output.slice(prefix.length)).toBe(expected)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES)
  })

  test("keeps nested ordered and unordered lists structurally readable", () => {
    const html = `<ol start="3"><li>alpha<ul><li>nested <strong>item</strong></li></ul></li><li><p>beta first</p><p>beta second</p></li></ol>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `3. alpha\n\n   - nested **item**\n\n4. beta first\n\n   beta second`,
    )
  })

  test("renders blockquotes and tables as readable Markdown", () => {
    const html = `<blockquote><p>quoted <em>text</em></p><ul><li>point</li></ul></blockquote><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td><code>1</code></td></tr></tbody></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `> quoted *text*\n\n> - point\n\n| Name | Value |\n| --- | --- |\n| one | \`1\` |`,
    )
  })

  test("decodes entities and normalizes prose whitespace without joining words", () => {
    const html = `<p>alpha\n  <span>&amp; beta</span> <unknown>caf&eacute;</unknown>&nbsp;gamma 😀</p><p>delta</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`alpha & beta café gamma 😀\n\ndelta`)
  })

  test("omits active and fallback content while retaining surrounding prose", () => {
    const html = `<p>before <script><b>bad</b></script><style>bad</style><noscript>bad</noscript><iframe>bad</iframe><object>bad</object><embed src="bad"><meta content="bad"><link href="bad"><template>bad</template> after</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("before after")
  })

  test("is deterministic and bounded for malformed input across parser chunks", () => {
    const html = `<main><p>${"visible &amp; text ".repeat(4_096)}</main></p></unknown>`
    const first = WebFetchTool.convertHTMLToMarkdown(html)
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(first)
    expect(first.startsWith("visible & text visible & text")).toBe(true)
    expect(first.length).toBeLessThanOrEqual(html.length)
  })

  test("keeps the Markdown budget at 5 MiB and the fetch cap at 10 MiB", () => {
    expect(WebFetchTool.MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024)
    const output = WebFetchTool.convertHTMLToMarkdown("x".repeat(MAX_MARKDOWN_BYTES))
    expect(MAX_MARKDOWN_BYTES).toBe(5 * 1024 * 1024)
    expect(output).toHaveLength(MAX_MARKDOWN_BYTES - 64 * 1024)
  })

  test.each(["x", "\u00e9", "\u{1f600}"])("preserves UTF-8 boundaries at the content limit for %s", (character) => {
    const budget = MAX_MARKDOWN_BYTES - 64 * 1024
    const fitting = "aa" + character.repeat(Math.floor((budget - 2) / Buffer.byteLength(character)))
    expect(WebFetchTool.convertHTMLToMarkdown(fitting)).toBe(fitting)
    const truncated = WebFetchTool.convertHTMLToMarkdown(fitting + character)
    expect(truncated).toBe(fitting)
    expect(Buffer.byteLength(truncated)).toBe(Buffer.byteLength(fitting))
  })

  test("bounds deeply nested list output and fragmented code fences", () => {
    const lists = `${"<ul><li>item".repeat(2_000)}${"</li></ul>".repeat(2_000)}`
    const quotes = `${"<blockquote><p>item".repeat(2_000)}${"</p></blockquote>".repeat(2_000)}`
    const code = `<pre>${"` x ".repeat(4_096)}</pre>`
    expect(WebFetchTool.convertHTMLToMarkdown(lists).length).toBeLessThan(lists.length * 4)
    expect(WebFetchTool.convertHTMLToMarkdown(quotes).length).toBeLessThan(quotes.length * 4)
    expect(() => WebFetchTool.convertHTMLToMarkdown(code)).not.toThrow()
    expect(
      WebFetchTool.convertHTMLToMarkdown(
        "<div>".repeat(20_000) + "safe<script><b>bad</b>&amp;</script><p>tail &amp;</p>",
      ),
    ).toBe("safe tail &")
  })

  test("escapes prose that would otherwise become Markdown structure", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p># heading</p><p>1. item</p><p>---</p><p>a | b</p>`)).toBe(
      `\\# heading\n\n1\\. item\n\n\\---\n\na \\| b`,
    )
  })

  test("preserves code whitespace and quotes every line of multiline blocks", () => {
    const html = `<blockquote><pre>line  \n\n\nnext</pre><table><tr><td>a|b</td><td>c</td></tr></table></blockquote>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `> \`\`\`\n> line  \n> \n> \n> next\n> \`\`\`\n\n> | a\\|b | c |\n> | --- | --- |`,
    )
  })

  test("keeps nested blockquotes inside their outer quote", () => {
    const html = `<blockquote><p>outer</p><blockquote><p>inner</p></blockquote><p>end</p></blockquote>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`> outer\n>\n> > inner\n>\n> end`)
  })

  test("keeps visible whitespace around inline emphasis", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>a<strong> b</strong> c a <em>b </em>c</p>`)).toBe(`a **b** c a *b* c`)
    expect(WebFetchTool.convertHTMLToMarkdown(`a<strong> </strong>b a<em> </em>b`)).toBe(`a b a b`)
  })

  test("captures formatting elements inside preformatted content as code only", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<pre><b>x</b><i>y</i><del>z</del></pre>`)).toBe(`\`\`\`\nxyz\n\`\`\``)
  })

  test("normalizes multiline table cells without changing their columns", () => {
    const html = `<table><tr><td>x<br>y</td><td><code>a|b</code></td><td><p>first</p><p>second</p></td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`| x y | \`a\\|b\` | first second |\n| --- | --- | --- |`)
  })

  test("flattens nested tables without corrupting the outer table", () => {
    const html = `<table><tr><th>Parent</th><th>Sibling</th></tr><tr><td>Before<table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>After</td><td>Tail</td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `| Parent | Sibling |\n| --- | --- |\n| Before Key Value A 1 After | Tail |`,
    )
  })

  test("preserves loose text around malformed table rows", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<table>before<tr><td>cell</td></tr>after</table>`)).toBe(
      `before after\n\n| cell |\n| --- |`,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<table>alpha</table>`)).toBe(`alpha`)
  })

  test("escapes tilde fences and removes empty emphasis markers", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>~~~</p><p><strong></strong>content</p><p>~~~</p>`)).toBe(
      `\\~\\~\\~\n\ncontent\n\n\\~\\~\\~`,
    )
  })

  test("does not confuse source NUL text with buffered code", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>before \u00000\u0000 after</p><pre>code</pre>`)).toBe(
      `before \u00000\u0000 after\n\n\`\`\`\ncode\n\`\`\``,
    )
  })

  test("preserves multiline inline code verbatim", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p><code>first\n\n\nsecond  </code></p>`)).toBe(
      "` first\n\n\nsecond   `",
    )
  })

  test("prefixes inline code at the start of a blockquote line", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<blockquote><code>x</code> y</blockquote>`)).toBe(`> \`x\` y`)
  })

  test("keeps links nested in inline code associated with their text", () => {
    const html = `<dl><dt><code>socket = new <a href="#constructor">WebSocket</a>(url)</code><dd>Creates one.</dl>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `**\` socket = new  \`[\`WebSocket\`](#constructor)\`(url)\`**\n: Creates one.`,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<code><a href="#x">x</a></code> after`)).toBe(`[\`x\`](#x) after`)
    expect(
      WebFetchTool.convertHTMLToMarkdown(
        `<dl><dt><code><var>socket</var> = new <code><a href="#constructor">WebSocket</a></code>(<var>url</var>)</code><dd>Creates one.</dl>`,
      ),
    ).toBe(`**\` socket = new  \`[\`WebSocket\`](#constructor)\`(url)\`**\n: Creates one.`)
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x">b<a href="/y">c</a>d</a>e</code>`)).toBe(
      `\`a\`[\`b\`](\/x)[\`c\`](\/y)\`de\``,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x">b</code>c`)).toBe(`\`a\`[\`b\`](\/x)c`)
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x"><div>b</div>c</a>d</code>`)).toBe(
      `\`a\`[](\/x)\n\n\`bcd\``,
    )
  })

  test("indents nested list continuations and preserves ordered numbering", () => {
    const html = `<ol start="0"><li value="4"><p>first</p><p>continued</p><ul><li><p>nested</p><p>continued nested</p></li></ul></li><li>next</li></ol>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `4. first\n\n   continued\n\n   - nested\n\n     continued nested\n\n5. next`,
    )
  })

  test("renders block content outside link syntax", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<a href="/docs">before<div>block</div>after</a>`)).toBe(
      `[before](/docs)\n\nblock\n\n[after](/docs)`,
    )
  })

  test("recovers nested anchors without unmatched Markdown syntax", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<a href="/a">x<a href="/b">y</a>z</a>`)).toBe(`[x](/a)[y](/b)z`)
  })

  test("keeps emphasis whitespace through neutral wrappers", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>a<strong><span> bold</span></strong>c</p>`)).toBe(`a **bold** c`)
  })

  test("flattens preformatted content inside table cells", () => {
    const html = `<table><tr><td><pre>a|b\nnext</pre></td><td><code>x|y</code></td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`| a\\|b next | \`x\\|y\` |\n| --- | --- |`)
  })

  test("preserves Unicode in inline constructs", () => {
    const payload = "😀".repeat(16)
    const cases = [
      [`<strong>${payload}</strong>`, `**${payload}**`],
      [`<a href="/docs">${payload}</a>`, `[${payload}](/docs)`],
      [`<img src="image.png" alt="${payload}">`, `![${payload}](image.png)`],
      [`<code>${payload}</code>`, `\`${payload}\``],
    ] as const
    for (const [html, expected] of cases) {
      expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(expected)
    }
  })

  test("preserves block content and following lists", () => {
    const payload = "x".repeat(256)
    const table = WebFetchTool.convertHTMLToMarkdown(
      `<table><tr><th>Name</th></tr><tr><td>${payload}</td></tr></table>`,
    )
    const list = WebFetchTool.convertHTMLToMarkdown(`<ul><li>${payload}</li></ul><ul><li>next</li></ul>`)
    const code = WebFetchTool.convertHTMLToMarkdown(`<pre>${payload}</pre>`)
    expect(table).toBe(`| Name |\n| --- |\n| ${payload} |`)
    expect(list).toBe(`- ${payload}\n\n- next`)
    expect(code).toBe(`\`\`\`\n${payload}\n\`\`\``)
  })

  test("keeps quoted code with long delimiter runs inside a safe closed fence", () => {
    const payload = `${"`".repeat(32)}${"~".repeat(32)}${"x".repeat(64)}`
    const output = WebFetchTool.convertHTMLToMarkdown(`<blockquote><pre>${payload}</pre></blockquote>`)
    expect(output).toBe(`> ${"`".repeat(33)}\n> ${payload}\n> ${"`".repeat(33)}`)
  })

  test("separates reconstructed tables from adjacent inline and quoted content", () => {
    const html = `intro<table><tr><td>x</td></tr></table>outro<blockquote>quote<table><tr><td>cell</td></tr></table></blockquote><ul><li>item<table><tr><td>cell</td></tr></table></li></ul>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `intro\n\n| x |\n| --- |\n\noutro\n\n> quote\n\n> | cell |\n> | --- |\n\n- item\n\n| cell |\n| --- |`,
    )
  })

  test("keeps multiline quoted code closed before following prose", () => {
    const html = `<blockquote><pre>${"x\n".repeat(16)}</pre></blockquote><p>tail</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`> \`\`\`\n${"> x\n".repeat(16)}> \`\`\`\n\ntail`)
  })

  test("keeps active content suppressed when depth fallback begins", () => {
    const html = `<object>${"<div>".repeat(10_001)}LEAK${"</div>".repeat(10_001)}</object><p>visible</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("visible")
  })

  test("keeps visible text after depth fallback begins inside preformatted content", () => {
    const html = `<pre>${"<i>".repeat(10_001)}visible${"</i>".repeat(10_001)}</pre><p>after</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("visible after")
  })

  test("resumes links around every block structure", () => {
    const html = `<a href="/x">before<blockquote><p>quote</p></blockquote><ul><li>item</li></ul><pre>code</pre><table><tr><td>cell</td></tr></table>after</a>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `[before](/x)\n\n> quote\n\n- item\n\n\`\`\`\ncode\n\`\`\`\n\n| cell |\n| --- |\n\n[after](/x)`,
    )
  })

  test("indents child lists from the actual parent marker width", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<ol start="100"><li>outer<ul><li>inner</li></ul></li></ol>`)).toBe(
      `100. outer\n\n     - inner`,
    )
  })

  test("renders captions and definition lists with readable boundaries", () => {
    const html = `<table><caption>Cache modes</caption><tr><th>Name</th><th>Meaning</th></tr><tr><td>A</td><td>Local</td></tr></table><dl><dt>Cache</dt><dd>A local store</dd><dt>Origin</dt><dd>The remote source</dd></dl>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `Cache modes\n\n| Name | Meaning |\n| --- | --- |\n| A | Local |\n\n**Cache**\n: A local store\n\n**Origin**\n: The remote source`,
    )
  })

  test("falls back to row-oriented text for table spans", () => {
    const html = `<table><tr><th colspan="2">Group</th></tr><tr><td>A</td><td rowspan="2">Shared</td></tr><tr><td>B</td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`Group\n\nA | Shared\n\nB`)
  })

  test("suppresses head and hidden subtrees while retaining visible body content", () => {
    const html = `<head><title>noise</title></head><body><p>visible</p><div hidden>hidden</div><div aria-hidden="true">aria</div><div aria-hidden="false">shown</div></body>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`visible\n\nshown`)
  })

  test("preserves pre breaks and normalizes multiline link titles", () => {
    const html = `<pre>first<br>second</pre><p><a href="/x" title="line one\n  line two">link</a></p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `\`\`\`\nfirst\nsecond\n\`\`\`\n\n[link](/x "line one line two")`,
    )
  })

  test("renders closed and open details according to visibility", () => {
    const html = `<details><summary>Closed</summary><p>secret</p></details><details open><summary>Open</summary><p>visible</p></details>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`Closed\n\nOpen\n\nvisible`)
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL over https", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "WebFetch")).toMatchObject({
        readOnly: true,
        concurrencySafe: true,
        openWorld: true,
        interruptBehavior: "cancel",
      })
      const url = "http://example.com/public"
      const upgraded = "https://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["WebFetch", "Execute"])
      expect(yield* executeTool(registry, call({ url, prompt: "q", timeout: 4 }))).toEqual({
        status: "completed",
        output: { url, contentType: "text/plain", output: "hello" },
        content: [{ type: "text", text: "hello" }],
        metadata: { contentType: "text/plain", answered: true, url: upgraded },
      })
      // The URL that is asked about is the one that is fetched.
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "WebFetch",
          resources: [upgraded],
          aliases: { [upgraded]: ["example.com"] },
          save: ["https://example.com/*"],
          metadata: { url: upgraded, prompt: "q", timeout: 4, method: "GET" },
        },
      ])
      expect(requests).toMatchObject([
        {
          url: `https://${publicAddress}/public`,
          headers: {
            host: "example.com",
            accept: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": webFetchUserAgent,
          },
        },
      ])
      expect(requests[0]?.headers).not.toHaveProperty("sec-fetch-mode")
    }),
  )

  it.effect("accepts localhost URLs, which keep http:, once the configuration allows local servers", () =>
    Effect.gen(function* () {
      reset()
      yield* allowLocal
      const registry = yield* Tool.Service
      const url = "http://localhost/private"

      expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "hello" }],
      })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "WebFetch",
          resources: [url],
          aliases: { [url]: ["localhost"] },
          save: ["http://localhost/*"],
          metadata: { url, prompt: "q" },
        },
      ])
      // localhost is loopback whatever a resolver says, so it is never looked up and the request goes to the address.
      expect(requests.map((request) => request.url)).toEqual(["http://127.0.0.1/private"])
      expect(requests[0]?.headers.host).toBe("localhost")
      expect(lookups).toEqual([])
    }),
  )

  it.effect("asks about the normalized URL, with its host as an alias and its origin as the save", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const url = "https://Example.com/a"

      expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toMatchObject({ status: "completed" })
      expect(assertions).toHaveLength(1)
      expect(assertions[0]).toMatchObject({
        sessionID,
        action: "WebFetch",
        resources: ["https://example.com/a"],
        aliases: { "https://example.com/a": ["example.com"] },
        save: ["https://example.com/*"],
        // A client shows the URL the rules matched, not the spelling the model chose.
        metadata: { url: "https://example.com/a", prompt: "q", method: "GET" },
      })
      // The request goes to the address that was checked, for the name in the URL.
      expect(requests.map((request) => request.url)).toEqual([`https://${publicAddress}/a`])
      expect(requests[0]?.headers.host).toBe("example.com")
    }),
  )

  // The resource is the URL as rules see it: no credentials, no fragment, no default port, no trailing dot on the host
  // and an ASCII host. The host never has a port. A bare origin is also an alias without the root slash the parser adds.
  for (const [url, resource, aliases, save] of [
    [
      "https://Example.com:443/a/b?x=1#section",
      "https://example.com/a/b?x=1",
      ["example.com"],
      "https://example.com/*",
    ],
    ["http://Localhost:8080/docs#top", "http://localhost:8080/docs", ["localhost"], "http://localhost:8080/*"],
    ["https://pastebin.com./raw/x", "https://pastebin.com/raw/x", ["pastebin.com"], "https://pastebin.com/*"],
    ["https://pastebin.com../raw/x", "https://pastebin.com/raw/x", ["pastebin.com"], "https://pastebin.com/*"],
    [
      "https://bücher.example/a",
      "https://xn--bcher-kva.example/a",
      ["xn--bcher-kva.example"],
      "https://xn--bcher-kva.example/*",
    ],
    ["https://example.com", "https://example.com/", ["example.com", "https://example.com"], "https://example.com/*"],
    [
      "https://example.com:8080/?#top",
      "https://example.com:8080/",
      ["example.com", "https://example.com:8080"],
      "https://example.com:8080/*",
    ],
    ["https://example.com/?page=2", "https://example.com/?page=2", ["example.com"], "https://example.com/*"],
    [
      "https://аpple.com/login",
      "https://xn--pple-43d.com/login",
      ["xn--pple-43d.com"],
      "https://xn--pple-43d.com/*",
    ],
  ] as const) {
    it.effect(`normalizes ${url} to ${resource} with the aliases ${aliases.join(" and ")}`, () =>
      Effect.gen(function* () {
        reset()
        yield* allowLocal
        const registry = yield* Tool.Service
        yield* executeTool(registry, call({ url, prompt: "q" }))

        expect(assertions).toHaveLength(1)
        expect(assertions[0]).toMatchObject({
          resources: [resource],
          aliases: { [resource]: aliases },
          save: [save],
          // The approval shows the normalized URL, which is the one that is fetched.
          metadata: { url: resource, method: "GET" },
        })
      }),
    )
  }

  // "Always" saves the origin as a rule pattern, so a host that spells * must never reach permission.
  for (const url of [
    "https://docs.example.com*/x",
    "https://docs%2A.example.com/",
    "https://docs.example.com＊/x",
    "https://*.example.com/",
  ]) {
    it.effect(`rejects the wildcard host in ${url} before permission or transport`, () =>
      Effect.gen(function* () {
        reset()
        const registry = yield* Tool.Service

        expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toEqual({
          status: "error",
          error: { type: "webfetch.refused", message: "URL host must not contain *" },
        })
        expect(assertions).toEqual([])
        expect(requests).toEqual([])
      }),
    )
  }

  live.effect("follows redirects while approving only the requested URL", () => {
    const received: Array<Record<string, string | null>> = []
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            received.push({
              accept: request.headers.get("accept"),
              "accept-language": request.headers.get("accept-language"),
              "sec-fetch-mode": request.headers.get("sec-fetch-mode"),
              "user-agent": request.headers.get("user-agent"),
              // Orbit's trace context must not reach a site, on the first request or on a redirect hop.
              traceparent: request.headers.get("traceparent"),
              tracestate: request.headers.get("tracestate"),
              b3: request.headers.get("b3"),
              "x-b3-traceid": request.headers.get("x-b3-traceid"),
            })
            if (new URL(request.url).pathname === "/redirect")
              return new Response("", { status: 302, headers: { location: "/target" } })
            return new Response("redirected", { headers: { "content-type": "text/plain" } })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          reset()
          yield* allowLocal
          const registry = yield* Tool.Service
          const url = new URL("/redirect", server.url).toString()
          const target = new URL("/target", server.url).toString()

          expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toMatchObject({
            status: "completed",
            content: [{ type: "text", text: "redirected" }],
          })
          // Every hop is asked about, the redirect with the hop it came from.
          expect(assertions).toMatchObject([
            {
              sessionID,
              action: "WebFetch",
              resources: [url],
              aliases: { [url]: [new URL(url).hostname] },
              save: [`${new URL(url).origin}/*`],
              metadata: { url, prompt: "q" },
            },
            {
              action: "WebFetch",
              resources: [target],
              metadata: { url: target, method: "GET", redirect: { from: url, status: 302 } },
            },
          ])
          expect(received).toEqual(
            Array.from({ length: 2 }, () => ({
              accept: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
              "accept-language": "en-US,en;q=0.9",
              "sec-fetch-mode": null,
              "user-agent": webFetchUserAgent,
              traceparent: null,
              tracestate: null,
              b3: null,
              "x-b3-traceid": null,
            })),
          )
        }),
      (server) => Effect.promise(() => server.stop(true)),
    )
  })

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      // toSessionError unwraps the "Unable to fetch <url>" ToolFailure to its cause message.
      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", prompt: "q" }))).toEqual({
        status: "error",
        error: { type: "webfetch.refused", message: "URL must use http:// or https://" },
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to markdown", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", prompt: "q" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "# Hello\n\nworld" }],
      })
    }),
  )

  it.effect("converts deeply nested HTML without overflowing", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* Tool.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "content" }],
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", prompt: "q" }))).toEqual({
        status: "error",
        error: {
          type: "unknown",
          message: `Response too large (exceeds ${WebFetchTool.MAX_RESPONSE_BYTES} byte limit)`,
        },
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", prompt: "q" }))).toEqual({
        status: "error",
        error: {
          type: "unknown",
          message: `Response too large (exceeds ${WebFetchTool.MAX_RESPONSE_BYTES} byte limit)`,
        },
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed outcomes can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", prompt: "q" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: "Unsupported fetched image content type: image/png" },
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", prompt: "q" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: "Unsupported fetched file content type: application/pdf" },
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", prompt: "q" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "ok" }],
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toBe(webFetchUserAgent)
      expect(requests[1]?.headers["user-agent"]).toBe("orbit")
    }),
  )

  it.effect("does not retry ordinary 403 responses", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.succeed(new Response("forbidden", { status: 403 }))
      const registry = yield* Tool.Service
      const url = "https://example.com/forbidden"

      expect(yield* executeTool(registry, call({ url, prompt: "q" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: `Request failed with status 403 (GET ${url})` },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.headers["user-agent"]).toBe(webFetchUserAgent)
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* Tool.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", prompt: "q", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({
        status: "error",
        error: { type: "unknown", message: "Request timed out" },
      })
    }),
  )
})

// What the stub answers: the reply for `host/path`, or the page "hello". A request is for the Host it carries, because
// it is connected to an address.
const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain" } })
const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } })
const route = (routes: Record<string, () => Response>) => {
  respond = (request) => {
    const url = new URL(request.url)
    const key = `${request.headers.host ?? url.host}${url.pathname}${url.search}`
    const answer = routes[key]
    return Effect.succeed(answer ? answer() : new Response("missing " + key, { status: 404 }))
  }
}
const requested = () => requests.map((request) => `${request.headers.host}${new URL(request.url).pathname}`)
const asked = () => assertions.map((assertion) => assertion.metadata?.url)
const run = (registry: Tool.Interface, input: typeof WebFetchTool.Input.Type) =>
  executeTool(registry, call(input))
const failed = (message: string, type = "unknown") => ({ status: "error" as const, error: { type, message } })

describe("WebFetchTool redirects", () => {
  it.effect("follows a same-host redirect, asking about each hop and connecting to the checked address", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(301, "/b"), "example.com/b": () => text("page b") })
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/a", prompt: "q" })).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "page b" }],
      })
      expect(asked()).toEqual(["https://example.com/a", "https://example.com/b"])
      expect(requested()).toEqual(["example.com/a", "example.com/b"])
      expect(requests.map((request) => new URL(request.url).hostname)).toEqual([publicAddress, publicAddress])
      expect(assertions[1]?.metadata).toMatchObject({ redirect: { from: "https://example.com/a", status: 301 } })
      // The approval of a hop is the request the clients draw from: its URL is the hop's, not the call's raw input.
      const rows: Array<{ id: string; request: { action: string; resources: string[]; metadata: Record<string, unknown> } }> = yield* Effect.promise(() =>
        Bun.file(new URL("./fixture/approval-matrix-pinned.json", import.meta.url)).json(),
      )
      expect({
        action: assertions[1]?.action,
        resources: assertions[1]?.resources,
        metadata: assertions[1]?.metadata,
      }).toEqual(rows.find((item) => item.id === "WebFetch/redirect-hop")!.request)
    }),
  )

  it.effect("resolves a relative Location against the current hop, not the first URL", () =>
    Effect.gen(function* () {
      reset()
      route({
        "example.com/x/y/start": () => redirect(302, "/p/q/"),
        "example.com/p/q/": () => redirect(302, "r"),
        "example.com/p/q/r": () => text("done"),
        // Where a relative target would go if it were resolved against the first URL.
        "example.com/x/y/r": () => text("wrong base"),
      })
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/x/y/start", prompt: "q" })).toMatchObject({
        content: [{ type: "text", text: "done" }],
      })
      // Against the first URL the last hop would have gone to /x/y/r, so the middle hop pins the base.
      expect(asked()).toEqual([
        "https://example.com/x/y/start",
        "https://example.com/p/q/",
        "https://example.com/p/q/r",
      ])
    }),
  )

  it.effect("follows a hop that only adds or drops a leading www., asking about and looking up the new host", () =>
    Effect.gen(function* () {
      reset()
      route({
        "example.com/a": () => redirect(308, "https://www.example.com/a"),
        "www.example.com/a": () => text("www"),
        "www.example.org/a": () => redirect(307, "https://example.org/a"),
        "example.org/a": () => text("bare"),
      })
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/a", prompt: "q" })).toMatchObject({
        content: [{ type: "text", text: "www" }],
      })
      expect(assertions[1]).toMatchObject({ aliases: { "https://www.example.com/a": ["www.example.com"] } })
      expect(lookups).toEqual(["example.com", "www.example.com"])

      reset()
      route({ "www.example.org/a": () => redirect(307, "https://example.org/a"), "example.org/a": () => text("bare") })
      expect(yield* run(registry, { url: "https://www.example.org/a", prompt: "q" })).toMatchObject({
        content: [{ type: "text", text: "bare" }],
      })
      expect(lookups).toEqual(["www.example.org", "example.org"])
    }),
  )

  it.effect("follows 10 redirects and fails on the 11th without sending a 12th request", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const chain = (length: number, host: string) =>
        route(
          Object.fromEntries(
            Array.from({ length: length + 1 }, (_, index) => [
              `${host}/${index}`,
              () => (index === length ? text("end") : redirect(302, `/${index + 1}`)),
            ]),
          ),
        )

      chain(10, "example.com")
      expect(yield* run(registry, { url: "https://example.com/0", prompt: "q" })).toMatchObject({
        content: [{ type: "text", text: "end" }],
      })
      expect(requests).toHaveLength(11)

      reset()
      chain(11, "example.org")
      expect(yield* run(registry, { url: "https://example.org/0", prompt: "q" })).toEqual(
        failed("Too many redirects (more than 10)", "webfetch.redirect-limit"),
      )
      expect(requests).toHaveLength(11)
    }),
  )

  it.effect("reports a redirect to another host instead of following it, and does not cache the note", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(302, "https://other.example/x") })
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/a", prompt: "what?" } as const

      const first = yield* run(registry, input)
      expect(first).toMatchObject({
        status: "completed",
        metadata: { redirect: { url: "https://other.example/x", status: 302 } },
      })
      const note = (first.content?.[0] as { text: string }).text
      expect(note).toContain("https://example.com/a")
      expect(note).toContain("https://other.example/x")
      expect(note).toContain("302 Found")
      // Nothing is sent to the target, asked about or looked up, and the prompt is not answered from the note.
      expect(requested()).toEqual(["example.com/a"])
      expect(asked()).toEqual(["https://example.com/a"])
      expect(lookups).toEqual(["example.com"])
      expect(first.metadata).not.toHaveProperty("answered")

      yield* run(registry, input)
      expect(requests).toHaveLength(2)
    }),
  )

  for (const [label, status, location] of [
    ["a port change", 301, "https://example.com:8443/x"],
    ["a downgrade to http:", 307, "http://example.com/x"],
    ["credentials in the target", 308, "https://u:p@example.com/x"],
    ["a parent domain", 302, "https://example.com/x"],
    ["a protocol-relative other host", 302, "//other.example/x"],
    ["a scheme that is not http", 302, "file:///etc/passwd"],
  ] as const) {
    it.effect(`reports ${label} instead of following it`, () =>
      Effect.gen(function* () {
        reset()
        const from = label === "a parent domain" ? "docs.example.com" : "example.com"
        route({ [`${from}/a`]: () => redirect(status, location) })
        const registry = yield* Tool.Service

        const settled = yield* run(registry, { url: `https://${from}/a`, prompt: "q" })
        expect(settled).toMatchObject({ status: "completed", metadata: { redirect: { status } } })
        expect(requests).toHaveLength(1)
        expect(assertions).toHaveLength(1)
      }),
    )
  }

  it.effect("fails a 303 as a status error and a redirect without Location", () =>
    Effect.gen(function* () {
      reset()
      route({
        "example.com/see": () => redirect(303, "/other"),
        "example.com/bare": () => new Response(null, { status: 301 }),
        "example.com/bad": () => redirect(301, "http://["),
      })
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/see", prompt: "q" })).toEqual(
        failed("Request failed with status 303 (GET https://example.com/see)"),
      )
      expect(requests).toHaveLength(1)
      expect(yield* run(registry, { url: "https://example.com/bare", prompt: "q" })).toEqual(
        failed("Redirect response has no Location header"),
      )
      expect(yield* run(registry, { url: "https://example.com/bad", prompt: "q" })).toEqual(
        failed("Redirect Location is not a valid URL"),
      )
    }),
  )

  it.effect("retries a Cloudflare challenge on the second hop", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/a"
            ? redirect(302, "/b")
            : request.headers["user-agent"] === "orbit"
              ? text("ok")
              : new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
        )
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/a", prompt: "q" })).toMatchObject({
        content: [{ type: "text", text: "ok" }],
      })
      expect(requests.map((request) => request.headers["user-agent"])).toEqual([webFetchUserAgent, webFetchUserAgent, "orbit"])
    }),
  )

  it.effect("does not read the body of a redirect", () =>
    Effect.gen(function* () {
      reset()
      let pulled = false
      route({
        "example.com/a": () =>
          new Response(
            // Nothing is pulled until a reader asks; the body is finite so a mutation fails instead of hanging.
            new ReadableStream(
              {
                pull(controller) {
                  pulled = true
                  controller.enqueue(new Uint8Array(1024))
                  controller.close()
                },
              },
              { highWaterMark: 0 },
            ),
            { status: 302, headers: { location: "/b" } },
          ),
        "example.com/b": () => text("b"),
      })
      const registry = yield* Tool.Service

      expect(yield* run(registry, { url: "https://example.com/a", prompt: "q", timeout: 5 })).toMatchObject({
        content: [{ type: "text", text: "b" }],
      })
      expect(pulled).toBe(false)
    }),
  )
})

describe("WebFetchTool address guard and pinning", () => {
  it.effect("refuses a host that resolves to a metadata address after its permission and before any request", () =>
    Effect.gen(function* () {
      reset()
      addresses = { "meta.example": ["169.254.169.254"] }
      const registry = yield* Tool.Service

      const settled = yield* run(registry, { url: "https://meta.example/x", prompt: "q" })
      expect(settled).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(settled.error?.message).toContain("cloud metadata address")
      expect(asked()).toEqual(["https://meta.example/x"])
      expect(requests).toEqual([])
    }),
  )

  it.effect("refuses a same-site hop that resolves to a metadata address, after sending only the first request", () =>
    Effect.gen(function* () {
      reset()
      addresses = { "www.example.com": ["169.254.169.254"] }
      route({ "example.com/a": () => redirect(301, "https://www.example.com/a") })
      const registry = yield* Tool.Service

      const settled = yield* run(registry, { url: "https://example.com/a", prompt: "q" })
      expect(settled).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(settled.error?.message).toContain("cloud metadata address")
      expect(requests).toHaveLength(1)
      expect(asked()).toEqual(["https://example.com/a", "https://www.example.com/a"])
    }),
  )

  for (const [label, answer] of [
    ["a failing lookup", new Error("ENOTFOUND")],
    ["a lookup with no address", []],
    ["a private address", ["10.0.0.1"]],
    ["a loopback address", ["127.0.0.1"]],
  ] as const) {
    it.effect(`refuses ${label}, with no request`, () =>
      Effect.gen(function* () {
        reset()
        addresses = { "odd.example": answer }
        const registry = yield* Tool.Service

        expect(yield* run(registry, { url: "https://odd.example/x", prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
        expect(requests).toEqual([])
      }),
    )
  }

  it.effect("refuses local hosts by default and fetches them when the configuration allows it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      for (const url of ["http://localhost/x", "http://10.0.0.1/x", "http://127.0.0.1:8080/x", "http://[::1]/x"])
        expect(yield* run(registry, { url, prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(requests).toEqual([])

      yield* allowLocal
      for (const url of ["http://localhost/x", "http://10.0.0.1/x", "http://[::1]/x"])
        expect((yield* run(registry, { url, prompt: "q" })).status).toBe("completed")
      // A local host keeps its scheme.
      expect(requests.map((request) => new URL(request.url).protocol)).toEqual(["http:", "http:", "http:"])
    }),
  )

  it.effect("always refuses link-local and metadata addresses", () =>
    Effect.gen(function* () {
      reset()
      yield* allowLocal
      const registry = yield* Tool.Service
      for (const url of ["http://169.254.169.254/latest", "http://169.254.1.1/x", "http://[fd00:ec2::254]/x"])
        expect(yield* run(registry, { url, prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(requests).toEqual([])
    }),
  )

  it.effect("connects to the checked address with the name only in Host and the TLS server name", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      yield* run(registry, { url: "https://example.com:8443/x", prompt: "q" })
      expect(requests[0]?.url).toBe(`https://${publicAddress}:8443/x`)
      expect(requests[0]?.headers.host).toBe("example.com:8443")
      expect(requests[0]?.init).toMatchObject({ redirect: "manual", tls: { serverName: "example.com" } })
    }),
  )

  // The owner's exception (2026-10-19, FU-M1-008): through a configured proxy the request is for the name.
  const withProxyEnvironment = <A, E, R>(values: Record<string, string>, effect: Effect.Effect<A, E, R>) => {
    const names = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]
    const saved = names.map((name) => [name, process.env[name]] as const)
    return Effect.sync(() => {
      names.forEach((name) => delete process.env[name])
      Object.assign(process.env, values)
    }).pipe(
      Effect.andThen(effect),
      Effect.ensuring(
        Effect.sync(() =>
          saved.forEach(([name, value]) => (value === undefined ? delete process.env[name] : (process.env[name] = value))),
        ),
      ),
    )
  }

  it.effect("sends the name to a configured proxy and resolves nothing itself", () =>
    withProxyEnvironment(
      { HTTPS_PROXY: "http://proxy.test:3128" },
      Effect.gen(function* () {
        reset()
        const registry = yield* Tool.Service

        yield* run(registry, { url: "https://example.com/x", prompt: "q" })
        expect(requests[0]?.url).toBe("https://example.com/x")
        expect(requests[0]?.headers.host).toBeUndefined()
        expect(requests[0]?.init).toMatchObject({ redirect: "manual", proxy: "http://proxy.test:3128/" })
        expect(requests[0]?.init).not.toHaveProperty("tls")
        expect(lookups).toEqual([])
      }),
    ),
  )

  const P = "http://proxy.test:3128"
  for (const [label, values] of [
    ["a NO_PROXY entry for the host", { HTTPS_PROXY: P, NO_PROXY: "example.com" }],
    ["a NO_PROXY entry for its domain", { HTTPS_PROXY: P, NO_PROXY: ".example.com,other.test" }],
    ["a NO_PROXY of *", { HTTPS_PROXY: P, NO_PROXY: "*" }],
    ["a NO_PROXY entry for its port", { HTTPS_PROXY: P, NO_PROXY: "example.com:8443" }],
    ["only a proxy for the other scheme", { HTTP_PROXY: P }],
    ["a proxy value that is not an http address", { HTTPS_PROXY: "socks5://proxy.test:1080" }],
  ] as const) {
    it.effect(`connects to the checked address with ${label}`, () =>
      withProxyEnvironment(
        values,
        Effect.gen(function* () {
          reset()
          const registry = yield* Tool.Service

          yield* run(registry, { url: "https://example.com:8443/x", prompt: "q" })
          expect(requests[0]?.url).toBe(`https://${publicAddress}:8443/x`)
          expect(requests[0]?.init).not.toHaveProperty("proxy")
          expect(lookups).toEqual(["example.com"])
        }),
      ),
    )
  }

  it.effect("still refuses a metadata address, with and without a proxy configured", () =>
    Effect.gen(function* () {
      reset()
      addresses = { "meta.example": ["169.254.169.254"] }
      const registry = yield* Tool.Service

      // No proxy: the name resolves to a metadata address and nothing is sent.
      expect(yield* run(registry, { url: "https://meta.example/x", prompt: "q" })).toMatchObject({
        status: "error",
        error: { type: "webfetch.refused" },
      })
      // A proxy: a literal address and a loopback name are not sent to it either.
      yield* withProxyEnvironment(
        { HTTPS_PROXY: "http://proxy.test:3128", HTTP_PROXY: "http://proxy.test:3128" },
        Effect.gen(function* () {
          for (const url of ["http://169.254.169.254/latest", "https://[fd00:ec2::254]/x", "http://localhost/x"])
            expect(yield* run(registry, { url, prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
        }),
      )
      expect(requests).toEqual([])
    }),
  )

  it.effect("sends nothing for a file: URL", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      expect(yield* run(registry, { url: "file:///etc/passwd", prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(requests).toEqual([])
      expect(lookups).toEqual([])
    }),
  )
})

describe("WebFetchTool URL checks", () => {
  it.effect("fetches an http: URL over https:, except for a single-label or address host", () =>
    Effect.gen(function* () {
      reset()
      yield* allowLocal
      const registry = yield* Tool.Service

      for (const url of ["http://example.com/x", "http://localhost/x", "http://127.0.0.1/x", "http://devbox/x"])
        yield* run(registry, { url, prompt: "q" })
      expect(asked()).toEqual([
        "https://example.com/x",
        "http://localhost/x",
        "http://127.0.0.1/x",
        "http://devbox/x",
      ])
    }),
  )

  for (const url of ["https://user@example.com/x", "https://user:pass@example.com/x", "https://github.com@evil.example/x"])
    it.effect(`refuses ${url} before permission or transport`, () =>
      Effect.gen(function* () {
        reset()
        const registry = yield* Tool.Service
        expect(yield* run(registry, { url, prompt: "q" })).toEqual(
          failed("URL must not contain a username or password", "webfetch.refused"),
        )
        expect(assertions).toEqual([])
        expect(requests).toEqual([])
      }),
    )

  it.effect("refuses a URL of 2001 characters and accepts one of 2000", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const url = (length: number) => "https://example.com/" + "a".repeat(length - "https://example.com/".length)

      expect(yield* run(registry, { url: url(2001), prompt: "q" })).toMatchObject({ status: "error", error: { type: "webfetch.refused" } })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
      expect((yield* run(registry, { url: url(2000), prompt: "q" })).status).toBe("completed")
    }),
  )
})

describe("WebFetchTool size cap", () => {
  const mib = 1024 * 1024
  it.effect("refuses a declared 11 MiB without reading it and accepts a 6 MiB body", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () =>
        Effect.succeed(
          new Response(
            new ReadableStream({
              pull() {
                throw new Error("the body was read")
              },
            }),
            { headers: { "content-type": "text/plain", "content-length": String(11 * mib) } },
          ),
        )
      expect((yield* run(registry, { url: "https://1.1.1.1/big", prompt: "q" })).status).toBe("error")

      respond = () => Effect.succeed(text("x".repeat(6 * mib)))
      expect((yield* run(registry, { url: "https://1.1.1.1/six", prompt: "q" })).status).toBe("completed")
    }),
  )

  it.effect("accepts a streamed body of exactly 10 MiB and refuses one byte more", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () => Effect.succeed(text("x".repeat(10 * mib)))
      expect((yield* run(registry, { url: "https://1.1.1.1/exact", prompt: "q" })).status).toBe("completed")
      respond = () => Effect.succeed(text("x".repeat(10 * mib + 1)))
      expect((yield* run(registry, { url: "https://1.1.1.1/over", prompt: "q" })).status).toBe("error")
    }),
  )
})

describe("WebFetchTool timeout", () => {
  it.effect("does not count the time a person takes to answer the ask for a hop", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(301, "https://www.example.com/a"), "www.example.com/a": () => text("www") })
      slow = { url: "https://www.example.com/a", by: Duration.seconds(40) }
      const fiber = yield* run(yield* Tool.Service, { url: "https://example.com/a", prompt: "q", timeout: 30 }).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(Duration.seconds(40))

      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "completed", content: [{ type: "text", text: "www" }] })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("still times out a stalled hop", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        new URL(request.url).pathname === "/a" ? Effect.succeed(redirect(301, "/b")) : Effect.never
      const fiber = yield* run(yield* Tool.Service, { url: "https://example.com/a", prompt: "q", timeout: 1 }).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(Duration.seconds(2))

      expect(yield* Fiber.join(fiber)).toEqual(failed("Request timed out"))
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("times out a stalled body", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }), {
            headers: { "content-type": "text/plain" },
          }),
        )
      const fiber = yield* run(yield* Tool.Service, { url: "https://example.com/a", prompt: "q", timeout: 1 }).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(Duration.seconds(2))

      expect(yield* Fiber.join(fiber)).toEqual(failed("Request timed out"))
      expect(requests).toHaveLength(1)
    }),
  )
})

describe("WebFetchTool cache", () => {
  test("bounds the cache at 50 MiB and keeps a page for 15 minutes", () => {
    expect(WebFetchTool.CACHE_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(WebFetchTool.CACHE_TTL_MS).toBe(15 * 60 * 1000)
  })

  it.effect("does not cache a timeout", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () => (++count === 1 ? Effect.never : Effect.succeed(text("fine")))
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/p", prompt: "q", timeout: 1 } as const
      const fiber = yield* run(registry, input).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual(failed("Request timed out"))
      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "fine" }] })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("asks about each hop of a cached page, and refuses it when a hop is denied", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(301, "/admin"), "example.com/admin": () => text("secret") })
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/a", prompt: "q" } as const

      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "secret" }] })
      expect(requests).toHaveLength(2)

      assertions.length = 0
      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "secret" }] })
      expect(asked()).toEqual(["https://example.com/a", "https://example.com/admin"])
      expect(assertions[1]?.metadata).toMatchObject({ redirect: { from: "https://example.com/a", status: 301 } })

      denyUrl = "https://example.com/admin"
      const exit = yield* Effect.exit(run(registry, input))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(2)
    }),
  )

  const pageCalls = (count: () => number) => {
    respond = () => Effect.sync(() => text(`page ${count()}`))
  }

  it.effect("answers a repeat from the cache within 15 minutes, still asking permission, and fetches again after", () =>
    Effect.gen(function* () {
      reset()
      let served = 0
      pageCalls(() => ++served)
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/p", prompt: "q" } as const

      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "page 1" }] })
      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "page 1" }] })
      expect(requests).toHaveLength(1)
      expect(lookups).toEqual(["example.com"])
      expect(assertions).toHaveLength(2)

      yield* TestClock.adjust(Duration.minutes(16))
      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "page 2" }] })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("does not extend the life of an entry when it is read", () =>
    Effect.gen(function* () {
      reset()
      let served = 0
      pageCalls(() => ++served)
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/p", prompt: "q" } as const

      yield* run(registry, input)
      yield* TestClock.adjust(Duration.minutes(10))
      yield* run(registry, input)
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(Duration.minutes(6))
      yield* run(registry, input)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("keys on the URL, not the fragment or the prompt", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      yield* run(registry, { url: "https://example.com/p", prompt: "q" })
      yield* run(registry, { url: "https://example.com/p#section", prompt: "q" })
      yield* run(registry, { url: "https://example.com/p", prompt: "another question" })
      expect(requests).toHaveLength(1)
      yield* run(registry, { url: "https://example.com/q", prompt: "q" })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("does not return a cached page when permission is denied", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/p", prompt: "q" } as const
      yield* run(registry, input)
      denying = true
      // A decline is a defect, which the registry does not turn into a result.
      const exit = yield* Effect.exit(run(registry, input))
      denying = false
      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("does not cache a failure", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () => Effect.succeed(++count === 1 ? new Response("no", { status: 500 }) : text("fine"))
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/p", prompt: "q" } as const

      expect((yield* run(registry, input)).status).toBe("error")
      expect(yield* run(registry, input)).toMatchObject({ content: [{ type: "text", text: "fine" }] })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("caches a page reached through same-host redirects under the URL that was asked for", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(301, "/b"), "example.com/b": () => text("b") })
      const registry = yield* Tool.Service
      const input = { url: "https://example.com/a", prompt: "q" } as const

      yield* run(registry, input)
      yield* run(registry, input)
      expect(requests).toHaveLength(2)
    }),
  )
})

const markdown = (body: string, type = "text/markdown; charset=utf-8") =>
  new Response(body, { headers: { "content-type": type } })
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } })
const textOf = (settled: { readonly content?: ReadonlyArray<unknown> }) =>
  (settled.content?.[0] as { text: string } | undefined)?.text
const lastQuery = () => queries[queries.length - 1]!

describe("WebFetchTool answers", () => {
  it.effect("asks the small model for an answer with the page and the question, and returns only the answer", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/doc": () => html("<h1>Title</h1><p>The meaning of life is forty-two</p>") })
      reply = () => Effect.succeed("It is 42.")
      const settled = yield* run(yield* Tool.Service, { url: "https://example.com/doc", prompt: "what is it?" })

      expect(textOf(settled)).toBe("It is 42.")
      expect(settled.output).toEqual({ url: "https://example.com/doc", contentType: "text/html", output: "It is 42." })
      expect(settled.metadata).toEqual({ contentType: "text/html", answered: true, url: "https://example.com/doc" })
      expect(queries).toHaveLength(1)
      // The page converted to Markdown, then the question; the small model and no transcript are what SideQuery is asked for.
      expect(lastQuery()).toMatchObject({
        sessionID,
        purpose: "webfetch.summarize",
        model: "small",
        history: false,
        timeout: Duration.seconds(WebFetchTool.MAX_TIMEOUT_SECONDS),
      })
      expect(lastQuery().prompt).toBe(
        "<page>\n# Title\n\nThe meaning of life is forty-two\n</page>\n\nQuestion: what is it?",
      )
    }),
  )

  it.effect("answers a cache hit again, because the cache holds pages and not answers", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/p": () => text("the page") })
      const registry = yield* Tool.Service
      yield* run(registry, { url: "https://example.com/p", prompt: "first question" })
      yield* run(registry, { url: "https://example.com/p", prompt: "second question" })

      expect(requests).toHaveLength(1)
      expect(queries.map((query) => query.prompt.split("Question: ")[1])).toEqual(["first question", "second question"])
    }),
  )

  it.effect("ignores a stale format and never lets it reach the model", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/p": () => html("<p>hi</p>") })
      const registry = yield* Tool.Service
      const decoded = Schema.decodeUnknownSync(WebFetchTool.Input)({
        url: "https://example.com/p",
        prompt: "q",
        format: "html",
      })
      yield* run(registry, decoded)
      expect(lastQuery().prompt).toBe("<page>\nhi\n</page>\n\nQuestion: q")
    }),
  )

  it.effect("cuts a long page for the small model and says so, and leaves an exact fit alone", () =>
    Effect.gen(function* () {
      reset()
      route({
        "example.com/exact": () => text("a".repeat(100_000)),
        "example.com/over": () => text("a".repeat(100_000) + "TAIL"),
      })
      const registry = yield* Tool.Service
      yield* run(registry, { url: "https://example.com/exact", prompt: "q" })
      expect(lastQuery().prompt).toBe(`<page>\n${"a".repeat(100_000)}\n</page>\n\nQuestion: q`)

      yield* run(registry, { url: "https://example.com/over", prompt: "q" })
      const sent = lastQuery().prompt
      expect(sent).not.toContain("TAIL")
      expect(sent).toContain(`${"a".repeat(100_000)}\n[The page was cut here because it is too long.]\n</page>`)
    }),
  )

  it.effect("keeps the redirect note out of the model and says to repeat the prompt", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/a": () => redirect(302, "https://other.example/x") })
      const settled = yield* run(yield* Tool.Service, { url: "https://example.com/a", prompt: "what?" })
      expect(queries).toHaveLength(0)
      expect(textOf(settled)).toContain("and the same prompt.")
    }),
  )

  it.effect("returns a note and not the page when the model cannot answer, and does not echo the provider", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/p": () => text("PAGETEXT") })
      const registry = yield* Tool.Service
      for (const error of [
        new SideQuery.UnavailableError({ message: "The side query could not run", cause: "SECRETBODY overloaded" }),
        new SideQuery.InvalidOutputError({ message: "Model did not answer with text", cause: "SECRETBODY" }),
        new SideQuery.TimeoutError({ message: "Side query webfetch.summarize timed out after 2 minutes" }),
      ]) {
        reply = () => Effect.fail(error)
        const settled = yield* run(registry, { url: "https://example.com/p", prompt: "q" })
        expect(settled.status).toBe("completed")
        const note = textOf(settled)!
        expect(note).toContain(error.message)
        expect(note).toContain("cached")
        expect(note).not.toContain("PAGETEXT")
        expect(note).not.toContain("SECRETBODY")
        expect(settled.metadata).toEqual({ contentType: "text/plain", answered: false, error: error._tag })
      }
      // The page stayed cached, so a retry costs only the answer.
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("is interrupted, and does not become a failure note, while the model is answering", () =>
    Effect.gen(function* () {
      reset()
      route({ "example.com/p": () => text("page") })
      reply = () => Effect.never
      const fiber = yield* run(yield* Tool.Service, { url: "https://example.com/p", prompt: "q" }).pipe(
        Effect.forkChild,
      )
      for (let turn = 0; turn < 100 && queries.length === 0; turn++) yield* Effect.yieldNow
      expect(queries).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("WebFetchTool verbatim hosts", () => {
  const page = (length: number) => "x".repeat(length)

  it.effect("returns a small Markdown page from a listed host whole, with no model call", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      route({ "docs.example.com/guide": () => markdown(page(99_999)) })
      const settled = yield* run(yield* Tool.Service, { url: "https://docs.example.com/guide", prompt: "ignored" })

      expect(queries).toHaveLength(0)
      expect(textOf(settled)).toBe(page(99_999))
      expect(settled.metadata).toEqual({
        contentType: "text/markdown; charset=utf-8",
        answered: false,
        verbatim: true,
      })
      expect(settled.output).toMatchObject({ output: page(99_999) })
    }),
  )

  it.effect("answers a page of 100,000 characters, and sends it uncut", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      route({ "docs.example.com/guide": () => markdown(page(100_000)) })
      yield* run(yield* Tool.Service, { url: "https://docs.example.com/guide", prompt: "q" })
      expect(queries).toHaveLength(1)
      expect(lastQuery().prompt).toBe(`<page>\n${page(100_000)}\n</page>\n\nQuestion: q`)
    }),
  )

  for (const [label, response] of [
    ["HTML", () => html("<p>hi</p>")],
    ["plain text at a .md path", () => text("# hi")],
    ["x-markdown", () => markdown("# hi", "text/x-markdown")],
  ] as const) {
    it.effect(`answers ${label} from a listed host`, () =>
      Effect.gen(function* () {
        reset()
        verbatimHosts = ["docs.example.com"]
        route({ "docs.example.com/guide.md": response })
        const settled = yield* run(yield* Tool.Service, { url: "https://docs.example.com/guide.md", prompt: "q" })
        expect(queries).toHaveLength(1)
        expect(settled.metadata).toMatchObject({ answered: true })
      }),
    )
  }

  it.effect("answers small Markdown from a host that is not listed", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      route({ "other.example/guide": () => markdown("# hi") })
      yield* run(yield* Tool.Service, { url: "https://other.example/guide", prompt: "q" })
      expect(queries).toHaveLength(1)
    }),
  )

  for (const [label, hosts, url, listed] of [
    ["a wildcard covers a subdomain", ["*.example.com"], "https://a.example.com/p", true],
    ["a wildcard covers a deeper subdomain", ["*.example.com"], "https://a.b.example.com/p", true],
    ["a wildcard does not cover the bare domain", ["*.example.com"], "https://example.com/p", false],
    ["an entry in capitals matches on every platform", ["Docs.Example.com"], "https://docs.example.com/p", true],
    ["a trailing dot in the URL", ["docs.example.com"], "https://docs.example.com./p", true],
    ["a trailing dot in the entry", ["docs.example.com."], "https://docs.example.com/p", true],
    ["a path prefix covers the path itself", ["example.com/org"], "https://example.com/org", true],
    ["a path prefix covers below it", ["example.com/org"], "https://example.com/org/page", true],
    ["a path prefix stops at a segment boundary", ["example.com/org"], "https://example.com/org-evil/page", false],
    ["a path prefix with a trailing slash", ["example.com/org/"], "https://example.com/org/page", true],
    ["a path prefix does not cover another path", ["example.com/org"], "https://example.com/other", false],
    ["an empty list matches nothing", [], "https://example.com/p", false],
    ["a blank entry matches nothing", ["", " "], "https://example.com/p", false],
    ["a similar host is not covered", ["example.com"], "https://example.com.evil.example/p", false],
  ] as const) {
    it.effect(`matches hosts: ${label}`, () =>
      Effect.gen(function* () {
        reset()
        verbatimHosts = [...hosts]
        respond = () => Effect.succeed(markdown("# small"))
        const settled = yield* run(yield* Tool.Service, { url, prompt: "q" })
        expect(settled.metadata?.verbatim === true).toBe(listed)
        expect(queries).toHaveLength(listed ? 0 : 1)
      }),
    )
  }

  it.effect("reads the list at each call, so a change applies to a cached page", () =>
    Effect.gen(function* () {
      reset()
      route({ "docs.example.com/guide": () => markdown("# small") })
      const registry = yield* Tool.Service
      const input = { url: "https://docs.example.com/guide", prompt: "q" }
      yield* run(registry, input)
      expect(queries).toHaveLength(1)

      verbatimHosts = ["docs.example.com"]
      const settled = yield* run(registry, input)
      expect(requests).toHaveLength(1)
      expect(queries).toHaveLength(1)
      expect(textOf(settled)).toBe("# small")
    }),
  )

  it.effect("needs both hosts of a same-site redirect to be listed", () =>
    Effect.gen(function* () {
      reset()
      const routes = {
        "docs.example.com/a": () => redirect(301, "https://www.docs.example.com/a"),
        "www.docs.example.com/a": () => markdown("# small"),
      }
      route(routes)
      const registry = yield* Tool.Service
      verbatimHosts = ["docs.example.com"]
      yield* run(registry, { url: "https://docs.example.com/a", prompt: "q" })
      expect(queries).toHaveLength(1)

      reset()
      route(routes)
      verbatimHosts = ["docs.example.com", "www.docs.example.com"]
      const settled = yield* run(registry, { url: "https://docs.example.com/a", prompt: "q" })
      expect(queries).toHaveLength(0)
      expect(textOf(settled)).toBe("# small")
    }),
  )

  it.effect("grants no permission: a denied listed host is refused before any request", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      denyUrl = "https://docs.example.com/guide"
      route({ "docs.example.com/guide": () => markdown("# small") })
      const exit = yield* Effect.exit(run(yield* Tool.Service, { url: "https://docs.example.com/guide", prompt: "q" }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(0)
      expect(queries).toHaveLength(0)
      expect(assertions).toHaveLength(1)
    }),
  )

  it.effect("asks for permission on a listed host as on any other", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      route({ "docs.example.com/guide": () => markdown("# small") })
      yield* run(yield* Tool.Service, { url: "https://docs.example.com/guide", prompt: "q" })
      expect(asked()).toEqual(["https://docs.example.com/guide"])
    }),
  )

  it.effect("tells the model it may include detail for a listed host and to keep quotes short otherwise", () =>
    Effect.gen(function* () {
      reset()
      verbatimHosts = ["docs.example.com"]
      route({
        "docs.example.com/long": () => markdown(page(100_001)),
        "other.example/long": () => markdown(page(100_001)),
      })
      const registry = yield* Tool.Service
      yield* run(registry, { url: "https://docs.example.com/long", prompt: "q" })
      const listed = lastQuery().system
      yield* run(registry, { url: "https://other.example/long", prompt: "q" })
      const unlisted = lastQuery().system

      expect(listed).toContain("code samples")
      expect(listed).not.toContain("125 characters")
      expect(unlisted).toContain("125 characters")
      expect(unlisted).not.toContain("code samples")
      expect(unlisted).toContain("is legal")
    }),
  )
})
