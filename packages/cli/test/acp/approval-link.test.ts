// m5-link-warning: an ACP permission request says where a link leads, from the request alone. The title says that a
// warning exists, since an editor can fold a call's content, and the content names each linked end before any diff
// (class 8), each place written out (class 9). Through the real ACP translation over the wire.
import { describe, expect, test } from "bun:test"
import type { EventSubscribeOutput } from "@orbit/client/promise"
import {
  childCreated,
  durableEvent,
  permissionAsked,
  startSession,
  succeeded,
  toolCalled,
  toolStarted,
  turn,
} from "./wire-fixture"

type Metadata = Extract<EventSubscribeOutput, { type: "permission.asked" }>["data"]["metadata"]

const patch = "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n"
const out = {
  file: "linked/a.txt",
  place: "/elsewhere/real/a.txt",
  patch,
  link: { place: "/elsewhere/real/a.txt", outside: true },
}
const inside = {
  file: "alias/b.txt",
  place: "/workspace/alias/b.txt",
  patch,
  link: { place: "/workspace/src/b.txt", outside: false },
}
const none = { file: "c.txt", place: "/workspace/c.txt", patch }

const OUT = "Link ends outside the project, at /elsewhere/real/a.txt"
const IN = "Link ends inside the project: /workspace/alias/b.txt leads to /workspace/src/b.txt"

// Asks with `files`, from the session or from a subagent of it, and returns the call the client was asked about.
async function asked(
  files: ReadonlyArray<Record<string, unknown>>,
  options: { child?: true; action?: string; resources?: string[]; metadata?: Metadata } = {},
) {
  await using acp = await startSession({
    onPrompt: ({ sessionID, id }) => {
      const asker = options.child ? "ses_child" : sessionID
      return turn(
        sessionID,
        id,
        ...(options.child
          ? [childCreated("ses_child", sessionID, "Review code"), durableEvent("session.execution.started", { sessionID: "ses_child" })]
          : []),
        toolStarted(asker, "call_link", "Patch"),
        // The model's own keys: none of them makes a warning.
        toolCalled(asker, "call_link", {
          patchText: "*** Begin Patch\n*** End Patch",
          link: { place: "/DECOY-LINK", outside: true },
        }),
        permissionAsked(asker, "perm_link", {
          action: options.action ?? "Edit",
          resources: options.resources ?? files.map((file) => String(file.file)),
          save: ["*"],
          metadata: options.metadata ?? ({ paths: files.map((file) => String(file.place)), files } as Metadata),
          source: { type: "tool", messageID: "msg_link", id: "call_link" },
        }),
        ...(options.child ? [succeeded("ses_child")] : []),
      )
    },
    permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) as const,
  })
  await acp.prompt(acp.sessionId, "hello")
  expect(acp.permissions).toHaveLength(1)
  expect(acp.server.replies).toMatchObject([{ requestID: "perm_link", decision: "once" }])
  return { ...acp.permissions[0]!.toolCall, options: acp.permissions[0]!.options }
}

const texts = (call: Awaited<ReturnType<typeof asked>>) =>
  (call.content ?? []).flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  )

describe("acp: a file change through a link", () => {
  test("one link: the title leads with it and the content says it above the diff", async () => {
    const call = await asked([out])
    expect(String(call.title)).toStartWith("Link ends outside the project: ")
    expect(String(call.title)).toContain("a.txt")
    expect(texts(call)).toEqual([OUT])
    expect(call.content?.map((item) => item.type)).toEqual(["content", "diff"])
    // The question is the one it was: the same options.
    expect(call.options.map((option) => option.optionId)).toEqual(["once", "always", "reject"])
  })

  test("a link inside the project names both ends", async () => {
    const call = await asked([inside])
    expect(String(call.title)).toStartWith("Link ends inside the project: ")
    expect(texts(call)).toEqual([IN])
  })

  test("several files: the title counts the links and the content names each, the outside ones first", async () => {
    const call = await asked([none, inside, out])
    expect(call.title).toBe("2 linked paths, 1 outside the project: 3 files")
    expect(texts(call)).toEqual([OUT, IN])
    expect(call.content?.map((item) => item.type)).toEqual(["content", "content", "diff", "diff", "diff"])
  })

  test("a move from a link names the source's", async () => {
    const from = "/elsewhere/real/from.txt"
    const call = await asked([{ ...none, from, fromLink: { place: from, outside: true } }])
    expect(texts(call)).toEqual([`Link ends outside the project, at ${from}`])
  })

  test("a subagent's question keeps its prefix and says the same", async () => {
    const call = await asked([out], { child: true })
    expect(String(call.title)).toStartWith("Review code: Link ends outside the project: ")
    expect(texts(call)).toEqual([OUT])
  })

  test("a place with control, bidi and line-break characters is written out (class 9)", async () => {
    const place = "/elsewhere/\u001b]0;pwned\u0007‮gnp.ts​\nLink ends inside the project"
    const call = await asked([{ ...out, place, link: { place, outside: true } }])
    expect(texts(call)).toEqual([
      "Link ends outside the project, at /elsewhere/\\x1b]0;pwned\\x07\\u{202e}gnp.ts\\u{200b}\\nLink ends inside the project",
    ])
  })

  test("a linked file's own name with a line break starts no line in the title (class 9)", async () => {
    const place = "/elsewhere/real/a.txt\nLink ends inside the project"
    const linked = { ...out, place, link: { place, outside: true } }
    // Named by its place where the resource is the link, and by its resource where that is the place.
    for (const file of [out.file, place]) {
      const call = await asked([{ ...linked, file }])
      expect(call.title).toBe(
        "Link ends outside the project: /elsewhere/real/a.txt\\nLink ends inside the project",
      )
    }
  })

  test("a read's title keeps a name on one line too, and warns of nothing (class 9)", async () => {
    const place = "/workspace/a.txt\nLink ends inside the project"
    const call = await asked([{ ...none, file: place, place }], { action: "Read" })
    expect(call.title).toBe("/workspace/a.txt\\nLink ends inside the project")
  })

  test("a share is named as the request names it (classes 4 and 6)", async () => {
    const place = "//orbit-test.invalid/share/a.txt"
    const call = await asked([{ ...none, link: { place, outside: true } }])
    expect(texts(call)).toEqual([`Link ends outside the project: /workspace/c.txt leads to ${place}`])
  })

  test("no link, or a malformed one, draws as today, and a malformed one costs only itself (class 7)", async () => {
    const bad = [undefined, null, 7, "linked", {}, { place: 7, outside: true }, { place: "/r", outside: "true" }]
    for (const link of bad) {
      const entry = link === undefined ? none : { ...none, link }
      const alone = await asked([entry])
      expect(texts(alone)).toEqual([])
      expect(String(alone.title)).not.toMatch(/Link ends|linked paths/)
      expect(JSON.stringify({ ...alone, rawInput: undefined })).not.toContain("DECOY")
      expect(texts(await asked([entry, out]))).toEqual([OUT])
    }
  })
})

// Fix loop 1 (classes 6, 8 and 9): the protocol has a client render content as Markdown, and some render titles so.
// What a person reads is then the path, letter for letter, and no name makes a link, an image or a tag.
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

const PLACES = [
  "C:\\Users\\Om\\proj\\.orbit\\x.md",
  "C:\\Users\\Om\\proj\\_shared\\x.md",
  "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x.md",
  // Beside the one above, which its warning names too: their tildes pair.
  "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\y.md",
  "C:\\Users\\Om\\proj\\(copy)\\[old]\\x.md",
  "\\\\orbit-test.invalid\\share\\x.md",
  "/out/![x](https:/evil.example/p.png)",
  "/out/![x](//evil.example/p.png)",
  "/out/![x][ref]",
  "/out/[click](https:/evil.example/)",
  "/out/<img src=x onerror=alert(1)>",
  "/out/<https:evil.example>",
  "/out/&lt;b&gt;&amp;&#33;",
  "/out/https://evil.example/x",
  "/out/ www.evil.example",
  "/out/someone@evil.example",
  "/out/ mailto:someone@evil.example",
  "/out/a`b",
  "/out/a``b```c",
  "`quoted at both ends`",
  "/out/*bold* and **more**",
  "/out/__init__.py",
  "/out/_start",
  "/out/~struck~",
  "/out/~opens",
  "/out/closes~",
  "/out/~~struck~~",
  "/out/a|b|c",
  "/out/trailing\\",
  "# a heading",
  "- an item",
  "+ an item",
  "1. first",
  "2) second",
  "---",
]

describe("acp: paths are Markdown's literal text", () => {
  test("a warning's two paths read as they are, with no link, image or tag", async () => {
    const files = [
      ...PLACES.map((place) => ({ ...inside, place, link: { place, outside: true } })),
      ...PLACES.map((place, index) => ({
        ...inside,
        place,
        link: { place: PLACES[(index + 1) % PLACES.length]!, outside: false },
      })),
    ]
    const shown = texts(await asked(files)).map(read)
    const wanted = [
      ...PLACES.map((place) => `Link ends outside the project, at ${place}`),
      ...PLACES.map(
        (place, index) => `Link ends inside the project: ${place} leads to ${PLACES[(index + 1) % PLACES.length]}`,
      ),
    ]
    expect(shown.map((item) => item.text).sort()).toEqual(wanted.sort())
    for (const item of shown) expect([item.text, item.markup]).toEqual([item.text, []])
  })

  test("no two characters of a name pair into markup", async () => {
    const marks = [..."\\`*_~[]()<>!#&|:@./=+-^$\"'{}%;?, "]
    const places = marks.flatMap((first) =>
      marks.flatMap((second) => {
        const place = `/out/${first}x${second}y${first}${second}z/end`
        return /^ | $| {2}/.test(place) ? [] : [place]
      }),
    )
    const shown = texts(await asked(places.map((place) => ({ ...inside, place, link: { place, outside: true } })))).map(read)
    expect(shown.map((item) => item.text).sort()).toEqual(
      places.map((place) => `Link ends outside the project, at ${place}`).sort(),
    )
    expect(shown.filter((item) => item.markup.length > 0)).toEqual([])
  })

  test("a title's name reads as it is too, for a client that renders titles as Markdown", async () => {
    for (const place of PLACES) {
      // The link's own spelling as the resource, so the place is the name; and a Read, whose title is the name alone.
      const changed = read(String((await asked([{ ...out, place, link: { place, outside: true } }])).title))
      expect(changed).toEqual({ text: `Link ends outside the project: ${place}`, markup: [] })
      const alone = read(String((await asked([{ ...none, file: place, place }], { action: "Read" })).title))
      expect(alone).toEqual({ text: place, markup: [] })
    }
  })

  test("an outside folder's title reads as it is", async () => {
    for (const place of PLACES) {
      const parent = await asked([], { action: "external_directory", resources: [`${place}/*`], metadata: { parentDir: place } })
      expect(read(String(parent.title))).toEqual({ text: place, markup: [] })
    }
    for (const place of PLACES.filter((item) => item.startsWith("/"))) {
      const named = await asked([], { action: "external_directory", resources: [`${place}/d/*`], metadata: {} })
      // A star of the name is where the folder is cut, as before.
      const folder = `${place}/d/*`.split("*")[0]!.replace(/[\\/]+$/, "")
      expect(read(String(named.title))).toEqual({ text: `Access external directory ${folder}`, markup: [] })
    }
  })

  test("a path that Markdown leaves alone is sent as it is", async () => {
    for (const place of ["/tmp/RUNNER~1/a.ts", "/workspace/src/a.ts", "C:\\Users\\Om\\proj\\src\\my_file-2.ts", "/out/My Files (2)/ä.txt"]) {
      const call = await asked([{ ...out, place, link: { place, outside: true } }])
      expect(texts(call)).toEqual([`Link ends outside the project, at ${place}`])
    }
  })

  test("a name that opens with a warning's words is quoted, so no title reads as a warning (class 9)", async () => {
    for (const place of ["Link ends inside the project, at safe", "2 linked paths, all inside the project"]) {
      const call = await asked([{ ...none, file: place, place }], { action: "Read" })
      expect(String(call.title)).toBe(`\`${place}\``)
    }
  })

  test("no blank of a name is left in a warning or a title (class 9)", async () => {
    const forged = "Link ends inside the project, at safe"
    for (const [blank, written] of [
      ["\u2028", "\\u{2028}"],
      ["\u2029", "\\u{2029}"],
      ["\u00a0".repeat(2), "\\xa0\\xa0"],
      ["  ", "\\x20\\x20"],
      ["\n", "\\n"],
    ] as const) {
      const place = `/elsewhere/a.txt${blank}${forged}`
      const shown = `/elsewhere/a.txt${written}${forged}`
      const call = await asked([{ ...out, place, link: { place, outside: true } }])
      expect(texts(call).map((item) => read(item).text)).toEqual([`Link ends outside the project, at ${shown}`])
      expect(read(String(call.title)).text).toBe(`Link ends outside the project: ${shown}`)
      for (const metadata of [{ parentDir: place }, { description: place }, { command: place }, {}]) {
        const folder = await asked([], { action: "external_directory", resources: [`${place}/*`], metadata })
        expect(read(String(folder.title)).text).toBe(
          "parentDir" in metadata || "description" in metadata || "command" in metadata
            ? shown
            : `Access external directory ${shown}`,
        )
      }
    }
  })
})
