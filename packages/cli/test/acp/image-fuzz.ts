// m5-quality (classes 6 and 9): a fuzz of the filter that keeps a model's Markdown from drawing an image or a raw tag
// in an ACP client, through the same calls the live stream and a session/load replay make. It runs as a script, so
// that image-fuzz.test.ts can give it a deadline: `bun test/acp/image-fuzz.ts <seed> <cases> <bun|marked>`. It prints
// one JSON object: the counts, each failure shrunk to a small input, and each control text the filter changed other
// than by a word joiner.
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import type { EventSubscribeOutput, SessionMessageInfo } from "@orbit/client/promise"
import { ACPTranslate } from "../../src/acp/translate"

const ADDRESS = "https://evil.example/p.png"
const JOINER = String.fromCharCode(0x2060)
const RENDERER = { autolinks: true, strikethrough: true, tables: true, tasklists: true }

// Images and raw tags a model, or a repository that steers it, can write. Each raw tag carries `data-x`, so a tag that
// a renderer passes through is found whatever its name.
const HOSTILE = [
  `![x](${ADDRESS})`,
  `![x](<${ADDRESS}> "t")`,
  "![x][r]",
  "![r]",
  "![r][]",
  `[![x](${ADDRESS})](https://example.com/)`,
  `<img src=${ADDRESS} data-x>`,
  `<IMG SRC=${ADDRESS} data-x>`,
  `<picture data-x><source srcset=${ADDRESS}></picture>`,
  `<svg data-x><image href=${ADDRESS} /></svg>`,
  "<span data-x>",
  "<details data-x>",
  `<a data-x href=${ADDRESS}>`,
  `<!-- c --><img src=${ADDRESS} data-x>`,
  // A tag with a backtick after it, which a backtick before it on the line may pair with.
  `<img src=${ADDRESS} data-x> \``,
]
// Fix loop 7: a label with a backtick in it, and definitions that `marked` reads on over the next line, a fence line
// too: a label alone, a label left open, and a title whose quote or parenthesis is left open on its line or opened on
// the next one.
const DEFINITIONS = [
  `[r]: ${ADDRESS}`,
  `[r]: <${ADDRESS}> "t"`,
  `   [r]:\n${ADDRESS}`,
  `[b\`]: ${ADDRESS}`,
  "[r]:",
  "[r]: ",
  "- [r]:",
  "[",
  "[a b",
  `[r]: ${ADDRESS} "`,
  `[r]: ${ADDRESS} '`,
  `[r]: ${ADDRESS} (`,
  `[r]: ${ADDRESS}\n"`,
  `[r]: ${ADDRESS}\n(`,
  `[r]:\n${ADDRESS} "`,
  `[r]:\n${ADDRESS} (`,
]

const INLINE = [
  "word",
  "text",
  "a",
  "x y",
  "`",
  "``",
  "```",
  "````",
  "\\`",
  "`code`",
  "``a`b``",
  "` a `",
  "`a",
  "b`",
  "*",
  "_",
  "**b**",
  "*em*",
  "~~s~~",
  "~",
  "[",
  "]",
  "(",
  ")",
  "](",
  "[link](https://example.com/)",
  '[t](https://example.com/ "ti`tle")',
  '[t](https://example.com/ "title")',
  "[t](<a b>)",
  "[t](a`b)",
  "[r]",
  "[r][]",
  "[b`]",
  "[x][b`]",
  "[b`][]",
  "[a `x](u)",
  "<https://a.example/>",
  "<https://a.example/`b>",
  "https://bare.example/x",
  "www.example.com",
  "|",
  "\\",
  "!",
  '"',
  "'",
  "&lt;",
  "&amp;",
  "&#96;",
  "<",
  ">",
  "\t",
  "  ",
  " ",
  "\\!",
  "\\[",
  "]:",
  "-->",
]
const PREFIX = [
  "",
  "",
  "",
  "# ",
  "## ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "2) ",
  "  - ",
  "    - ",
  "> ",
  "> > ",
  ">",
  "- > ",
  "> - ",
  "   ",
  "    ",
  "\t",
  "- [ ] ",
  "| ",
]
const FENCE_INDENT = ["", "", "", " ", "  ", "   ", "    ", "     ", "      ", "\t", " \t", "  \t", "\t "]
const FENCE_CONTAINER = ["", "", "", "", "- ", "1. ", "> ", "- > ", "> - ", "  ", "-\t", "10. "]
const FENCE_INFO = ["", "", "", "js", " js", "a`b", "~", " x ```", "`", " ~~~", "rust title"]
const SPECIAL = [
  "===",
  "---",
  "***",
  "    indented code",
  "| a | b |",
  "| a | b |\n|---|---|",
  "a | b\n- | -",
  "- [ ]",
  "1. [x]",
  "|---|---|",
  "| `x | y` |",
  "| c | d |",
  "<div>",
  "</div>",
  "<!--",
  "-->",
  "<pre>",
  "</pre>",
  "<?php",
  "?>",
  "<![CDATA[",
  "]]>",
  "<!DOCTYPE html>",
  '[a](u "t',
  't")',
  "[r]: https://example.com/",
  "<details>",
  "</details>",
  "<script>",
  "</script>",
  "<style>",
  "</style>",
  "<textarea>",
]
const HTML_PIECES = new Set([...SPECIAL.filter((line) => line.startsWith("<")), "<!--", "-->", "<", ">"])

type Random = ReturnType<typeof seeded>

// A small seeded generator, so a failure names a case that fails again.
function seeded(seed: number) {
  const state = { value: seed | 0 }
  const next = () => {
    state.value = (state.value + 0x6d2b79f5) | 0
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const value = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return (value ^ (value >>> 14)) >>> 0
  }
  return {
    int: (limit: number) => next() % limit,
    pick: <T>(items: readonly T[]) => items[next() % items.length]!,
    chance: (p: number) => next() / 4294967296 < p,
  }
}

function fenceLine(random: Random) {
  const run = (random.chance(0.6) ? "`" : "~").repeat(3 + random.int(4))
  return (
    random.pick(FENCE_CONTAINER) +
    random.pick(FENCE_INDENT) +
    run +
    (random.chance(0.5) ? "" : random.pick(FENCE_INFO)) +
    random.pick(["", "", " ", "\t"])
  )
}

function line(random: Random, html: boolean): string {
  const roll = random.int(100)
  if (roll < 30) return fenceLine(random)
  if (roll < 38) return ""
  if (roll < 48) {
    const special = random.pick(SPECIAL)
    return !html && special.startsWith("<") ? "" : special
  }
  const prefix = random.pick(PREFIX)
  const pieces = Array.from({ length: random.int(7) }, () => random.pick(INLINE)).filter(
    (piece) => html || !HTML_PIECES.has(piece),
  )
  return prefix + pieces.map((piece) => (random.chance(0.5) ? piece : ` ${piece}`)).join("")
}

function text(random: Random, hostile: boolean) {
  const lines = Array.from({ length: 1 + random.int(10) }, () => line(random, hostile))
  if (hostile) {
    Array.from({ length: 1 + random.int(2) }).forEach(() => {
      const value = random.pick(HOSTILE)
      const at = random.int(lines.length + 1)
      const where = random.int(4)
      if (where === 0 || at === lines.length) return void lines.splice(at, 0, value)
      if (where === 1) return void (lines[at] = value + lines[at])
      if (where === 2) return void (lines[at] = lines[at] + value)
      const cut = random.int(lines[at]!.length + 1)
      lines[at] = lines[at]!.slice(0, cut) + value + lines[at]!.slice(cut)
    })
    if (random.chance(0.4)) lines.splice(random.int(lines.length + 1), 0, random.pick(DEFINITIONS))
    // A label with a backtick in it is a reference only where it is defined, in a paragraph of its own.
    if (random.chance(0.2)) lines.splice(random.int(lines.length + 1), 0, `\n[b\`]: ${ADDRESS}\n`)
  }
  const ending = random.int(10)
  if (ending === 0) return lines.join("\r\n")
  if (ending === 1) return lines.join("\r")
  if (ending === 2) return lines.map((item) => item + random.pick(["\n", "\r\n", "\r"])).join("")
  return lines.join("\n") + (random.chance(0.3) ? "\n" : "")
}

function chunks(random: Random, value: string) {
  if (value.length > 0 && random.chance(0.1)) return value.split("")
  const cuts = [...new Set(Array.from({ length: random.int(6) }, () => random.int(value.length + 1)))].sort(
    (a, b) => a - b,
  )
  return [0, ...cuts, value.length]
    .slice(1)
    .map((end, index, ends) => value.slice(index === 0 ? 0 : ends[index - 1], end))
    .filter((piece) => piece.length > 0)
}

type Part = {
  readonly kind: "text" | "reasoning"
  /** Whether this part starts a new assistant message. */
  readonly message: boolean
  /** Whether a tool call stands between this part and the one before it. */
  readonly tool: boolean
  readonly chunks: readonly string[]
}

function generate(random: Random, hostile: boolean): Part[] {
  return Array.from({ length: random.chance(0.5) ? 1 : 2 + random.int(3) }, (_, index) => {
    const value = text(random, hostile)
    return {
      kind: random.chance(0.7) ? ("text" as const) : ("reasoning" as const),
      message: index === 0 || random.chance(0.4),
      tool: index > 0 && random.chance(0.15),
      chunks: chunks(random, value),
    }
  })
}

type Sent = { readonly kind: "message" | "thought"; readonly id: string; readonly part: number; readonly text: string }
type Mark = Sent | { readonly kind: "tool" }

const ctx: ACPTranslate.Context = {
  sessionID: "ses",
  cwd: "/workspace",
  start: { type: "input", id: "inbox" },
  childUpdates: false,
  mode: "turn",
}
const event = (type: string, data: Record<string, unknown>) =>
  ({ id: "", created: 0, type, data }) as unknown as EventSubscribeOutput

// The live stream: each part's deltas and its end, through `ACPTranslate.step`, as the server sends them.
function live(parts: readonly Part[]): Mark[] {
  const opened = ACPTranslate.step(
    ACPTranslate.initial,
    event("session.inbox.delivered", { sessionID: "ses", inboxID: "inbox" }),
    ctx,
  )
  const counters = { message: -1, text: 0, reasoning: 0 }
  return parts.reduce(
    (run, part, index) => {
      if (part.message) Object.assign(counters, { message: counters.message + 1, text: 0, reasoning: 0 })
      const assistantMessageID = `msg_${counters.message}`
      const ordinal = part.kind === "text" ? counters.text++ : counters.reasoning++
      const delta = part.kind === "text" ? "session.text.delta" : "session.reasoning.delta"
      const ended = part.kind === "text" ? "session.text.ended" : "session.reasoning.ended"
      const events = [
        ...(part.tool
          ? [
              event("session.tool.input.started", {
                sessionID: "ses",
                assistantMessageID,
                id: `call_${index}`,
                name: "bash",
              }),
            ]
          : []),
        ...part.chunks.map((piece) => event(delta, { sessionID: "ses", assistantMessageID, ordinal, delta: piece })),
        event(ended, { sessionID: "ses", assistantMessageID, ordinal, text: part.chunks.join("") }),
      ]
      return events.reduce((current, item) => {
        const stepped = ACPTranslate.step(current.state, item, ctx)
        const marks = stepped.outputs.flatMap((output): Mark[] =>
          output._tag === "SessionUpdate" ? mark(output.update, index) : [],
        )
        return { state: stepped.state, marks: [...current.marks, ...marks] }
      }, run)
    },
    { state: opened.state, marks: [] as Mark[] },
  ).marks
}

function mark(update: SessionUpdate, part: number): Mark[] {
  if (update.sessionUpdate === "tool_call") return [{ kind: "tool" }]
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return []
  if (update.content.type !== "text") return []
  return [
    {
      kind: update.sessionUpdate === "agent_message_chunk" ? "message" : "thought",
      id: update.messageId ?? "",
      part,
      text: update.content.text,
    },
  ]
}

// The session/load replay: each message's parts through `ACPTranslate.replayMessage`, with what one message leaves
// open carried to the next as the service carries it.
function replay(parts: readonly Part[]): Mark[] {
  const messages = parts.reduce<{ part: Part; index: number }[][]>((all, part, index) => {
    if (part.message || all.length === 0) return [...all, [{ part, index }]]
    all[all.length - 1]!.push({ part, index })
    return all
  }, [])
  const carry: { before?: unknown } = {}
  return messages.flatMap((message, m) => {
    const info = {
      id: `msg_${m}`,
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      // A tool call between two texts is a recorded call, still streaming, so it carries no input to decode.
      content: message.flatMap((item) => [
        ...(item.part.tool
          ? [{ type: "tool", id: `call_${item.index}`, name: "bash", state: { status: "streaming" } }]
          : []),
        { type: item.part.kind, text: item.part.chunks.join("") },
      ]),
      time: { created: 1 },
    } as unknown as SessionMessageInfo
    const generator = (ACPTranslate.replayMessage as (...args: unknown[]) => Generator<SessionUpdate, unknown>)(
      info,
      "/workspace",
      ...(carry.before === undefined ? [] : [carry.before]),
    )
    const updates = [] as SessionUpdate[]
    for (const step = { next: generator.next() }; ; step.next = generator.next()) {
      if (step.next.done) {
        carry.before = step.next.value
        break
      }
      updates.push(step.next.value)
    }
    const texts = message.map((item) => item.index)
    return updates.flatMap((update) => {
      const found = mark(update, -1)
      return found.map((item) => (item.kind === "tool" ? item : { ...item, part: texts.shift()! }))
    })
  })
}

// What clients render: each text on its own, every chunk of one message ID together, or every consecutive chunk of one
// kind appended into one block until a tool call or a chunk of the other kind comes between.
function documents(marks: readonly Mark[]) {
  const sent = marks.filter((item): item is Sent => item.kind !== "tool")
  const byPart = Map.groupBy(sent, (item) => item.part)
  const byId = Map.groupBy(sent, (item) => `${item.kind}:${item.id}`)
  const appended = marks.reduce<{ kind: string; text: string }[]>((blocks, item) => {
    if (item.kind === "tool") return [...blocks, { kind: "tool", text: "" }]
    const last = blocks.at(-1)
    if (last?.kind !== item.kind) return [...blocks, { kind: item.kind, text: item.text }]
    last.text += item.text
    return blocks
  }, [])
  return {
    // A text on its own, where no other text shares its message ID: a client cannot tell texts that share one apart.
    part: new Map(
      [...byPart.entries()]
        .filter(([part, group]) => byId.get(`${group[0]!.kind}:${group[0]!.id}`)!.every((item) => item.part === part))
        .map(([part, group]) => [part, group.map((item) => item.text).join("")]),
    ),
    id: [...byId.values()].map((group) => group.map((item) => item.text).join("")),
    appended: appended.filter((block) => block.kind !== "tool").map((block) => block.text),
  }
}

const LEAK = /<(?:img|picture|source|svg|image|iframe|video|audio|object|embed|span|details|script|style)\b/i

const renderer = { render: (markdown: string) => Bun.markdown.html(markdown, RENDERER) }

function leaks(markdown: string) {
  const html = renderer.render(markdown)
  // A quoted attribute value is the renderer's own escaped text, so only what stands outside one is markup.
  const bare = html.replace(/"[^"]*"/g, '""')
  return LEAK.test(bare) || /<[a-z][^<>]*\bdata-x\b/i.test(bare) ? html : undefined
}

type Mode = "live/part" | "live/id" | "live/appended" | "replay/part" | "replay/id" | "replay/appended"

function failures(parts: readonly Part[]) {
  const streamed = documents(live(parts))
  const replayed = documents(replay(parts))
  const rows: [Mode, string[]][] = [
    ["live/part", [...streamed.part.values()]],
    ["live/id", streamed.id],
    ["live/appended", streamed.appended],
    ["replay/part", [...replayed.part.values()]],
    ["replay/id", replayed.id],
    ["replay/appended", replayed.appended],
  ]
  return rows.flatMap(([mode, docs]) =>
    docs.flatMap((markdown) => {
      const html = leaks(markdown)
      return html === undefined ? [] : [{ mode, markdown, html }]
    }),
  )
}

// Text with no image or tag in it comes back as written but for a word joiner after a `!` or a `<`, and a backtick
// that starts a text after one that ended the text before, which is escaped.
function changed(parts: readonly Part[]) {
  const streamed = documents(live(parts)).part
  const replayed = documents(replay(parts)).part
  return parts.flatMap((part, index) => {
    const input = part.chunks.join("")
    // A text that shares its message ID with another is not drawn on its own.
    const back = [streamed.get(index), replayed.get(index)].map((out) => out?.replaceAll(JOINER, ""))
    if (back.every((out) => out === undefined || out === input || (index > 0 && out === input.replace(/^`/, "\\`"))))
      return []
    return [{ input, live: back[0], replay: back[1] }]
  })
}

// The smallest case that still fails: fewer parts, then plainer parts, then fewer and shorter chunks.
function shrink(parts: Part[], fails: (parts: Part[]) => boolean) {
  const deadline = Date.now() + 3000
  const best = { parts }
  const attempt = (candidate: Part[]) => {
    if (Date.now() > deadline || candidate.length === 0 || !fails(candidate)) return false
    best.parts = candidate
    return true
  }
  const candidates = (current: Part[]): Part[][] => [
    ...current.map((_, i) =>
      current.filter((__, j) => j !== i).map((part, j) => (j === 0 ? { ...part, message: true, tool: false } : part)),
    ),
    ...current.flatMap((part, i) => [
      ...(part.tool ? [current.map((item, j) => (j === i ? { ...item, tool: false } : item))] : []),
      ...(i > 0 && part.message ? [current.map((item, j) => (j === i ? { ...item, message: false } : item))] : []),
      ...(part.kind === "reasoning"
        ? [current.map((item, j) => (j === i ? { ...item, kind: "text" as const } : item))]
        : []),
      ...part.chunks.flatMap((piece, c) => [
        ...(c + 1 < part.chunks.length
          ? [replace(current, i, [...part.chunks.slice(0, c), piece + part.chunks[c + 1], ...part.chunks.slice(c + 2)])]
          : []),
        ...(part.chunks.length > 1
          ? [
              replace(
                current,
                i,
                part.chunks.filter((_, k) => k !== c),
              ),
            ]
          : []),
        ...Array.from({ length: piece.length }, (_, at) =>
          replace(
            current,
            i,
            part.chunks.map((item, k) => (k === c ? item.slice(0, at) + item.slice(at + 1) : item)).filter(Boolean),
          ),
        ),
      ]),
    ]),
  ]
  while (Date.now() < deadline) if (!candidates(best.parts).some(attempt)) break
  return best.parts
}

function replace(parts: Part[], index: number, chunks: string[]) {
  if (chunks.length === 0) return []
  return parts.map((item, j) => (j === index ? { ...item, chunks } : item))
}

function show(parts: readonly Part[]) {
  return parts.map((part) => ({
    kind: part.kind,
    ...(part.message ? {} : { sameMessage: true }),
    ...(part.tool ? { toolBefore: true } : {}),
    chunks: part.chunks,
  }))
}

// Shrinking takes up to three seconds a case, so only the first cases that fail are shrunk.
const SHRUNK = 10

export function run(seed: number, cases: number) {
  const random = seeded(seed)
  const found = new Map<string, { count: number; mode: Mode; parts: ReturnType<typeof show>; markdown: string }>()
  const controls = new Map<string, { count: number; input: string; live?: string; replay?: string }>()
  const counts = { cases: 0, failing: 0, controls: 0, controlChanged: 0 }
  Array.from({ length: cases }).forEach(() => {
    counts.cases++
    const parts = generate(random, true)
    const failed = failures(parts)
    if (failed.length > 0) {
      counts.failing++
      const mode = failed[0]!.mode
      const small =
        counts.failing > SHRUNK
          ? parts
          : shrink(parts, (candidate) => failures(candidate).some((row) => row.mode === mode))
      const key = mode + JSON.stringify(show(small))
      const row = failures(small).find((item) => item.mode === mode)
      found.set(key, {
        count: (found.get(key)?.count ?? 0) + 1,
        mode,
        parts: show(small),
        markdown: row?.markdown ?? failed[0]!.markdown,
      })
    }
    // A control: the same grammar with no image and no raw tag.
    const control = generate(random, false).filter((part) => !/!\[|<(?!https:\/\/)/.test(part.chunks.join("")))
    if (control.length === 0) return
    counts.controls++
    const diff = changed(control)
    if (diff.length === 0) return
    counts.controlChanged++
    const first = { ...control.find((part) => part.chunks.join("") === diff[0]!.input)!, message: true, tool: false }
    const small =
      counts.controlChanged > SHRUNK ? [first] : shrink([first], (candidate) => changed(candidate).length > 0)
    const result = changed(small)[0] ?? diff[0]!
    const key = JSON.stringify(show(small))
    controls.set(key, { count: (controls.get(key)?.count ?? 0) + 1, ...result })
  })
  return {
    seed,
    counts,
    failures: [...found.values()].sort((a, b) => b.count - a.count),
    controls: [...controls.values()].sort((a, b) => b.count - a.count),
  }
}

if (import.meta.main) {
  const [seed, cases] = process.argv.slice(2, 4).map(Number)
  if (process.argv[4] === "marked") {
    const { marked } = await import("marked")
    renderer.render = (markdown) => marked.parse(markdown, { gfm: true, async: false })
  }
  console.log(JSON.stringify(run(seed || 20261124, cases || 2000)))
}
