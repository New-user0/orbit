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
async function asked(files: ReadonlyArray<Record<string, unknown>>, options: { child?: true } = {}) {
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
          action: "Edit",
          resources: files.map((file) => String(file.file)),
          save: ["*"],
          metadata: { paths: files.map((file) => String(file.place)), files } as Metadata,
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
