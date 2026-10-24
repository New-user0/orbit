import { describe, expect, test } from "bun:test"
import type { OrbitEvent } from "@orbit/client/promise"
import { ACPTranslate } from "../../src/acp/translate"
import {
  assistantMessage,
  childCreated,
  delivered,
  durableEvent,
  failed,
  interrupted,
  stepEnded,
  succeeded,
  textDelta,
  tokens,
  toolCalled,
  toolProgress,
  toolStarted,
  toolSucceeded,
} from "./wire-fixture"

const root = "ses_root"
const ctx: ACPTranslate.Context = {
  sessionID: root,
  cwd: "/workspace",
  start: { type: "input", id: "msg_input" },
  childUpdates: false,
  mode: "turn",
}

function run(events: ReadonlyArray<OrbitEvent>, context = ctx, state = ACPTranslate.initial) {
  return events.reduce<{ state: ACPTranslate.TurnState; outputs: ACPTranslate.Output[]; terminal?: string }>(
    (acc, event, index) => {
      const next = ACPTranslate.step(acc.state, { ...event, id: `evt_${index + 1}` }, context)
      return {
        state: next.state,
        outputs: [...acc.outputs, ...next.outputs],
        ...(next.terminal ? { terminal: next.terminal } : {}),
      }
    },
    { state, outputs: [] },
  )
}

function started(...events: OrbitEvent[]) {
  return run([delivered(root, "msg_input"), ...events])
}

function updates(outputs: ReadonlyArray<ACPTranslate.Output>) {
  return outputs.flatMap((output) => (output._tag === "SessionUpdate" ? [output.update] : []))
}

describe("acp turn translation", () => {
  test("ignores a session's events until its own input is delivered, and other sessions' events after", () => {
    const result = run([
      textDelta(root, "msg_early", "early"),
      delivered(root, "msg_other_input"),
      delivered("ses_other", "msg_input"),
      succeeded(root),
      delivered(root, "msg_input"),
      textDelta("ses_other", "msg_other", "other session"),
      textDelta(root, "msg_ok", "accepted"),
    ])

    expect(result.terminal).toBeUndefined()
    expect(updates(result.outputs)).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "msg_ok", content: { type: "text", text: "accepted" } },
    ])
  })

  test("sums usage across steps, including a failed step, and keeps the last step for context", () => {
    const result = started(
      durableEvent("session.step.failed", {
        sessionID: root,
        assistantMessageID: "msg_1",
        error: { type: "provider.stream", message: "stream interrupted" },
        cost: 0,
        tokens: { ...tokens(), input: 40, output: 4 },
      }),
      durableEvent("session.step.started", {
        sessionID: root,
        assistantMessageID: "msg_2",
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        started: 0,
      }),
      stepEnded(root, "msg_2", { finish: "length", tokens: { ...tokens(), input: 20, output: 7, reasoning: 2 } }),
    )

    expect(result.state.usage).toEqual({
      turn: { input: 60, output: 11, reasoning: 2, cache: { read: 0, write: 0 } },
      last: { input: 20, output: 7, reasoning: 2, cache: { read: 0, write: 0 } },
    })
    expect(ACPTranslate.failure(result.state)).toBeUndefined()
    expect(ACPTranslate.response(result.state, root, "succeeded")).toEqual({
      stopReason: "max_tokens",
      usage: { inputTokens: 60, outputTokens: 11, thoughtTokens: 2, totalTokens: 73 },
      _meta: {},
    })
  })

  test("ends a turn cleanly when a step starts after a failed one, and reports the failure when none does", () => {
    const stepFailed = durableEvent("session.step.failed", {
      sessionID: root,
      assistantMessageID: "msg_1",
      error: { type: "provider.stream", message: "stream interrupted" },
    })
    const stepStarted = durableEvent("session.step.started", {
      sessionID: root,
      assistantMessageID: "msg_2",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      started: 0,
    })

    const recovered = started(stepFailed, stepStarted, succeeded(root))
    expect(recovered.terminal).toBe("succeeded")
    expect(ACPTranslate.failure(recovered.state)).toBeUndefined()
    expect(ACPTranslate.response(recovered.state, root, "succeeded").stopReason).toBe("end_turn")

    // The step that starts is what clears the failure: without it the same failure is reported.
    const unrecovered = started(stepFailed, succeeded(root))
    expect(unrecovered.terminal).toBe("succeeded")
    expect(ACPTranslate.failure(unrecovered.state)).toMatchObject({ errorName: "provider.stream" })
  })

  test.each(["limit.steps", "limit.cost", "limit.tokens"])("a turn that ended with %s stops at max_turn_requests", (type) => {
    const result = started(failed(root, { type, message: "The turn reached its limit." }))
    expect(result.terminal).toBe("failed")
    expect(ACPTranslate.failure(result.state)).toBeUndefined()
    expect(ACPTranslate.response(result.state, root, "failed").stopReason).toBe("max_turn_requests")
    // Any other execution failure is still a failure.
    const other = started(failed(root, { type: "provider.stream", message: "x" }))
    expect(ACPTranslate.failure(other.state)).toMatchObject({ errorName: "provider.stream" })
    // A cost limit that cannot be counted was refused, not reached.
    const unknown = started(failed(root, { type: "limit.cost-unknown", message: "No price." }))
    expect(ACPTranslate.failure(unknown.state)).toMatchObject({ errorName: "limit.cost-unknown" })
    expect(ACPTranslate.response(unknown.state, root, "failed").stopReason).not.toBe("max_turn_requests")
    // The same for a token limit that cannot be counted because a response reported no tokens.
    const noTokens = started(failed(root, { type: "limit.tokens-unknown", message: "No tokens." }))
    expect(ACPTranslate.failure(noTokens.state)).toMatchObject({ errorName: "limit.tokens-unknown" })
    expect(ACPTranslate.response(noTokens.state, root, "failed").stopReason).not.toBe("max_turn_requests")
    // A request refused locally because the conversation no longer fits is a failure, not a reached limit.
    const noRoom = started(failed(root, { type: "context.limit", message: "Run /compact." }))
    expect(ACPTranslate.failure(noRoom.state)).toMatchObject({ errorName: "context.limit" })
    expect(ACPTranslate.response(noRoom.state, root, "failed").stopReason).not.toBe("max_turn_requests")
  })

  test("forwards any synthetic message that names a notice, and none that does not", () => {
    const synthetic = (metadata?: Record<string, string>, description?: string) =>
      durableEvent("session.synthetic", { sessionID: root, text: "text", description, metadata })
    const result = started(
      synthetic({ notice: "fallback" }, "Switched to a fallback model."),
      synthetic({ notice: "plan-exit" }, "Left plan mode."),
      synthetic({ notice: "output-escalation", replaces: "msg_1" }, "The output limit was raised."),
      synthetic({ reminder: "turn-budget" }, "A reminder."),
      synthetic(undefined, "No metadata."),
    )
    expect(updates(result.outputs)).toEqual([
      { sessionUpdate: "session_info_update", _meta: { "orbit/notice": { notice: "fallback", description: "Switched to a fallback model." } } },
      { sessionUpdate: "session_info_update", _meta: { "orbit/notice": { notice: "plan-exit", description: "Left plan mode." } } },
      {
        sessionUpdate: "session_info_update",
        _meta: {
          "orbit/notice": { notice: "output-escalation", description: "The output limit was raised.", replaces: "msg_1" },
        },
      },
    ])
  })

  test("forwards nothing for a waiting shell notice, whose text quotes script output", () => {
    const hostile = "\u001b]0;pwned\u0007\u001b[2KProceed (y/n) \rOVERWRITTEN"
    const result = started(
      durableEvent("session.synthetic", {
        sessionID: root,
        text: `<shell id="sh_1" state="waiting" command="x">\nThe output ends with:\n${hostile}\n</shell>`,
        description: "npm init \u001b]0;title\u0007\r",
        metadata: { source: "shell", state: "waiting", shellID: "sh_1" },
      }),
    )
    expect(updates(result.outputs)).toEqual([])
    expect(JSON.stringify(result.outputs)).not.toContain("OVERWRITTEN")
  })

  test("marks a compaction that fails before starting, and drops an end with no start", () => {
    const result = started(
      durableEvent("session.compaction.failed", {
        sessionID: root,
        reason: "auto",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
      }),
      durableEvent("session.compaction.ended", { sessionID: root, reason: "auto", text: "summary", recent: "" }),
    )

    expect(updates(result.outputs).map((update) => update._meta?.["orbit/compaction"])).toEqual([
      {
        status: "failed",
        messageId: "msg_2",
        reason: "auto",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
      },
    ])
    expect(result.state.compactions.size).toBe(0)
  })

  test("projects a nested child's updates with its depth and its own parent", () => {
    const result = started(
      childCreated("ses_child", root, "Explore"),
      childCreated("ses_grandchild", "ses_child", "Deeper"),
      childCreated("ses_stranger", "ses_unknown", "Unrelated"),
      toolStarted("ses_grandchild", "call_1", "read"),
      textDelta("ses_stranger", "msg_stranger", "ignored"),
    )

    expect(updates(result.outputs)).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "ses_grandchild:call_1",
        title: "Deeper: read",
        _meta: { "orbit/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" } },
      }),
    ])
    expect([...result.state.openChildren]).toEqual(["ses_child", "ses_grandchild"])
  })

  test("ends a background consumer when its last open child settles, without session updates", () => {
    const turn = started(childCreated("ses_a", root, "A"), childCreated("ses_b", root, "B"), succeeded(root))
    const background = { ...ctx, mode: "background" as const }
    const first = run(
      [textDelta(root, "msg_root", "ignored"), toolStarted("ses_a", "call_1", "read"), succeeded("ses_a")],
      background,
      turn.state,
    )
    const last = run([childCreated("ses_later", root, "Later"), interrupted("ses_b")], background, first.state)

    expect(turn.terminal).toBe("succeeded")
    expect(first.outputs).toEqual([])
    expect(first.terminal).toBeUndefined()
    expect(last.state.children.has("ses_later")).toBe(false)
    expect(last.terminal).toBe("interrupted")
  })

  test("fails the tools a cancelled turn left open, including a child's", () => {
    const result = started(
      childCreated("ses_child", root, "Explore"),
      toolStarted(root, "call_root", "shell"),
      toolCalled(root, "call_root", { command: "sleep 60" }),
      toolProgress(root, "call_root", { pid: 1 }),
      toolStarted("ses_child", "call_child", "read"),
      failed("ses_child", { type: "aborted", message: "interrupted" }),
    )

    const abandoned = ACPTranslate.abandonTools(result.state, ctx)

    expect(abandoned.state.tools.size).toBe(0)
    expect(updates(abandoned.outputs)).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_root",
        status: "failed",
        rawInput: expect.objectContaining({ command: "sleep 60" }),
        rawOutput: { metadata: { pid: 1 }, error: "Cancelled" },
      }),
      expect.objectContaining({ toolCallId: "ses_child:call_child", status: "failed", title: "Explore: read" }),
    ])
    expect(ACPTranslate.abandonTools(abandoned.state, ctx).outputs).toEqual([])
  })
})

// An approval can be answered with the person's own version of the file, which the tool writes instead of the model's
// proposal. The completed call then shows the diff the tool recorded of what it wrote, live and when a loaded session
// replays it, never one rebuilt from the model's input (class 8).
describe("acp shows a completed Edit or Write as what ran", () => {
  const place = "/workspace/a.txt"
  const rows: ReadonlyArray<{
    readonly name: string
    readonly tool: string
    readonly input: Record<string, string>
    readonly files?: Array<{ file: string; patch: string }>
    readonly shown?: { readonly oldText: string; readonly newText: string }
  }> = [
    {
      name: "an Edit whose approval carried the person's version",
      tool: "Edit",
      input: { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
      files: [{ file: "a.txt", patch: "--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+REVISED\n" }],
      shown: { oldText: "alpha\nbeta", newText: "alpha\nREVISED" },
    },
    {
      name: "a Write whose approval carried the person's version",
      tool: "Write",
      input: { file_path: "a.txt", content: "proposed\n" },
      files: [{ file: "a.txt", patch: "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+revised\n" }],
      shown: { oldText: "", newText: "revised" },
    },
    {
      name: "an Edit that recorded no diff",
      tool: "Edit",
      input: { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
    },
  ]
  const diffs = (content: ReadonlyArray<{ readonly type: string }> | null | undefined) =>
    (content ?? []).filter((item) => item.type === "diff")
  const expected = (row: (typeof rows)[number]) => (row.shown ? [{ type: "diff", path: place, ...row.shown }] : [])

  for (const row of rows) {
    const metadata = { places: [place], ...(row.files ? { files: row.files } : {}) }

    test(`${row.name}, live`, () => {
      const result = started(
        toolStarted(root, "call_ran", row.tool),
        toolCalled(root, "call_ran", row.input),
        toolProgress(root, "call_ran", { places: [place] }),
        toolSucceeded(root, "call_ran", metadata, "done"),
      )
      const completed = updates(result.outputs).flatMap((update) =>
        update.sessionUpdate === "tool_call_update" && update.status === "completed" ? [update] : [],
      )
      expect(completed).toHaveLength(1)
      expect(diffs(completed[0]?.content)).toEqual(expected(row))
    })

    test(`${row.name}, replayed`, () => {
      const replayed = [
        ...ACPTranslate.replayMessage(
          assistantMessage("msg_ran", {
            content: [
              {
                type: "tool",
                id: "call_ran",
                name: row.tool,
                time: { created: 1, completed: 2 },
                state: { status: "completed", input: row.input, metadata, content: [{ type: "text", text: "done" }] },
              },
            ],
          }),
          "/workspace",
        ),
      ].flatMap((update) =>
        update.sessionUpdate === "tool_call_update" && update.status === "completed" ? [update] : [],
      )
      expect(replayed).toHaveLength(1)
      expect(diffs(replayed[0]?.content)).toEqual(expected(row))
    })
  }
})
