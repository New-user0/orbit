import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessageInfo } from "@orbit/client/promise"
import { assistantMessage, makeSession, startWire } from "./wire-fixture"

describe("acp session replay over the wire", () => {
  test("replays user, text, reasoning, and tool messages in order on session/load", async () => {
    await using acp = await startWire()
    acp.server.sessions.set("ses_replay", makeSession("ses_replay"))
    acp.server.messages.set("ses_replay", replayFixtureMessages())
    await acp.initialize()

    await acp.request("session/load", { cwd: "/workspace", sessionId: "ses_replay", mcpServers: [] })

    const updates = acp.updates.filter((item) => item.update.sessionUpdate !== "available_commands_update")
    expect(updates.every((update) => update.sessionId === "ses_replay")).toBe(true)
    expect(updates.map((item) => item.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "user_message_chunk",
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "tool_call",
    ])
    expect(updates[1]?.update).toMatchObject({
      content: { type: "resource_link", uri: "file:///workspace/note.md", name: "note.md", mimeType: "text/markdown" },
    })
    expect(updates[2]?.update).toMatchObject({
      content: { type: "resource", resource: { mimeType: "text/plain", text: "hello" } },
    })
    expect(updates[4]?.update).toMatchObject({ messageId: "msg_assistant:reasoning:0" })
    expect(updates[6]?.update).toMatchObject({
      toolCallId: "call_done",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: "AAAA" } },
      ],
      rawOutput: { metadata: { exit: 0 } },
    })
    expect(updates[8]?.update).toMatchObject({
      toolCallId: "call_running",
      status: "in_progress",
      title: "pwd",
      locations: [],
    })
    expect(updates[10]?.update).toMatchObject({
      toolCallId: "call_failed",
      status: "failed",
      content: [
        { type: "content", content: { type: "text", text: "partial" } },
        { type: "content", content: { type: "text", text: "failed hard" } },
      ],
    })
    expect(updates[11]?.update).toMatchObject({ toolCallId: "call_streaming", status: "pending", rawInput: {} })
  })

  test("continues replay after one message fails to translate", async () => {
    await using acp = await startWire({
      fetch(request) {
        if (request.path !== "/api/session/ses_replay_failure/message") return undefined
        return Response.json({
          data: [
            replayToolMessage("call_first", { status: "error", input: {}, metadata: {} }),
            replayToolMessage("call_after", {
              status: "completed",
              input: { command: "printf done" },
              metadata: { exit: 0 },
              content: [{ type: "text", text: "done" }],
            }),
          ],
          cursor: {},
        })
      },
    })
    acp.server.sessions.set("ses_replay_failure", makeSession("ses_replay_failure"))
    await acp.initialize()

    const loaded = await acp.request("session/load", {
      cwd: "/workspace",
      sessionId: "ses_replay_failure",
      mcpServers: [],
    })

    expect(loaded.configOptions).toBeDefined()
    expect(
      acp.updates.flatMap((item) =>
        item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update"
          ? [[item.update.toolCallId, item.update.sessionUpdate]]
          : [],
      ),
    ).toEqual([
      ["call_first", "tool_call"],
      ["call_after", "tool_call"],
      ["call_after", "tool_call_update"],
    ])
  })
})

// A replayed call names the places the tool recorded when it resolved them, never the input's own spelling of a path:
// `cfg/notes.md` can be a link to a folder outside the project. With no place recorded (a call from before the places
// were kept, or a tool that never resolved one) a replayed update names none and draws no diff. Class 4, 8 and 12.
describe("acp session replay names the recorded places", () => {
  const real = path.resolve("/outside/config/notes.md")
  const link = path.resolve("/workspace/cfg/notes.md")
  const input = { file_path: "cfg/notes.md", old_string: "a", new_string: "b", content: "b" }
  const states = {
    completed: { status: "completed", content: [{ type: "text", text: "ok" }] },
    running: { status: "running" },
    error: { status: "error", error: { type: "tool.error", message: "no" } },
  }
  for (const tool of ["write", "edit", "read", "notebook_edit", "glob", "grep", "lsp", "patch"])
    for (const [name, state] of Object.entries(states))
      for (const recorded of [true, false])
        test(`${tool} ${name} with ${recorded ? "the recorded place" : "no recorded place"}`, async () => {
          await using acp = await startWire()
          acp.server.sessions.set("ses_places", makeSession("ses_places"))
          acp.server.messages.set("ses_places", [
            {
              ...assistantMessage("msg_places"),
              content: [
                {
                  type: "tool",
                  id: "call_places",
                  name: tool,
                  time: { created: 1, completed: 2 },
                  state: { ...state, input, metadata: recorded ? { places: [real] } : {} },
                },
              ],
            },
          ] as unknown as SessionMessageInfo[])
          await acp.initialize()
          await acp.request("session/load", { cwd: "/workspace", sessionId: "ses_places", mcpServers: [] })

          const updates = acp.updates.flatMap((item) =>
            item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update"
              ? [item.update]
              : [],
          )
          expect(updates.length).toBe(2)
          // Everything a person is shown outside the raw input: the places and the diff's file.
          const shown = updates.flatMap((update) => [
            ...(update.locations ?? []).map((item) => item.path),
            ...(update.content ?? []).flatMap((item) => (item.type === "diff" ? [item.path] : [])),
          ])
          expect(shown).not.toContain(link)
          expect(shown.every((item) => item === real)).toBe(true)
          if (!recorded) expect(shown).toEqual([])
          // The pending call is sent as it is live: no input and no place.
          expect(updates[0]).toMatchObject({ status: "pending", rawInput: {} })
          expect(updates[0]?.locations ?? []).toEqual([])
        })
})

function replayToolMessage(id: string, state: Record<string, unknown>) {
  return {
    ...assistantMessage(`msg_${id}`),
    content: [{ type: "tool", id, name: "shell", time: { created: 1, completed: 2 }, state }],
  }
}

function replayFixtureMessages(): SessionMessageInfo[] {
  return [
    {
      id: "msg_user",
      type: "user",
      text: "hello",
      time: { created: 1 },
      files: [
        { data: "", mime: "text/markdown", name: "note.md", source: { type: "uri", uri: "file:///workspace/note.md" } },
        { data: "aGVsbG8=", mime: "text/plain", name: "inline.txt", source: { type: "inline" } },
      ],
    },
    assistantMessage("msg_assistant", {
      time: { created: 2, completed: 3 },
      content: [
        { type: "text", text: "answer" },
        { type: "reasoning", text: "thinking" },
        {
          type: "tool",
          id: "call_done",
          name: "shell",
          time: { created: 2, completed: 3 },
          state: {
            status: "completed",
            input: { command: "printf done" },
            metadata: { exit: 0 },
            content: [
              { type: "text", text: "done" },
              { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "image.png" },
            ],
          },
        },
        {
          type: "tool",
          id: "call_running",
          name: "shell",
          time: { created: 2, ran: 2 },
          state: { status: "running", input: { command: "pwd" }, metadata: {} },
        },
        {
          type: "tool",
          id: "call_failed",
          name: "read",
          time: { created: 2, completed: 3 },
          state: {
            status: "error",
            input: { path: "/workspace/missing.ts" },
            metadata: { bytes: 0 },
            content: [{ type: "text", text: "partial" }],
            error: { type: "tool.error", message: "failed hard" },
          },
        },
        {
          type: "tool",
          id: "call_streaming",
          name: "shell",
          time: { created: 2 },
          state: { status: "streaming", input: '{"command":' },
        },
      ],
    }),
  ]
}
