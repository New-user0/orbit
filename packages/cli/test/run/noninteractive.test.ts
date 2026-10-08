import { afterEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test"
import {
  Orbit,
  type EventSubscribeOutput,
  type JsonValue,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
} from "@orbit/client/promise"
import { EOL } from "node:os"
import path from "node:path"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"
import { reportRunError } from "../../src/run/run"
import { UI } from "../../src/run/ui"

type V2Event = EventSubscribeOutput
type FormInfo = Extract<V2Event, { type: "form.created" }>["data"]["form"]
const location = { directory: "/work tree", workspaceID: "wrk_1" }

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function form(id: string, sessionID: string): FormInfo {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com/form" }],
  }
}

function formCreated(info: FormInfo, eventLocation = location): V2Event {
  return { id: `evt_${info.id}`, created: 0, type: "form.created", location: eventLocation, data: { form: info } }
}

function prompted(inboxID: string): V2Event {
  return {
    id: "evt_prompted",
    created: 0,
    type: "session.inbox.delivered",
    durable: { aggregateID: "ses_1", seq: 0, version: 1 },
    data: { sessionID: "ses_1", inboxID },
  }
}

function settled(
  outcome: "success" | "interrupted" = "success",
  reason: "user" | "shutdown" | "superseded" | "inactivity" = "user",
): V2Event {
  if (outcome === "interrupted")
    return {
      id: "evt_interrupted",
      created: 0,
      type: "session.execution.interrupted",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", reason },
    }
  return {
    id: "evt_succeeded",
    created: 0,
    type: "session.execution.succeeded",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1" },
  }
}

function stepStarted(messageID = "msg_assistant", agent = "build"): V2Event {
  return {
    id: `evt_step_started_${messageID}`,
    created: 1,
    type: "session.step.started",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: {
      started: 1,
      sessionID: "ses_1",
      assistantMessageID: messageID,
      agent,
      model: { providerID: "test", id: "test-model" },
    },
  }
}

function stepFailed(message: string, messageID = "msg_assistant", cost?: number): V2Event {
  return {
    id: `evt_step_failed_${messageID}`,
    created: 2,
    type: "session.step.failed",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: messageID,
      ...(cost === undefined
        ? {}
        : { cost, tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      error: { type: "provider.transport", message },
    },
  }
}

function stepEnded(messageID: string, finish: "stop" | "length" | "tool-calls" = "stop", cost = 0): V2Event {
  return {
    id: `evt_step_ended_${messageID}`,
    created: 3,
    type: "session.step.ended",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: messageID,
      finish,
      cost,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  }
}

function textEnded(messageID: string, text: string, ordinal = 0): V2Event {
  return {
    id: `evt_text_ended_${messageID}_${ordinal}`,
    created: 2,
    type: "session.text.ended",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: messageID, ordinal, text },
  }
}

// What the hidden notice carries when the runner raises the output limit and answers again from the start.
const replacing = (messageID: string): Record<string, JsonValue> => ({
  notice: "output-escalation",
  replaces: messageID,
})

function escalation(metadata: Record<string, JsonValue>, description?: string): V2Event {
  return {
    id: "evt_escalation",
    created: 3,
    type: "session.synthetic",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: { sessionID: "ses_1", text: "The output limit was raised.", description, metadata },
  }
}

function reasoningEnded(messageID: string, text: string): V2Event {
  return {
    id: `evt_reasoning_ended_${messageID}`,
    created: 2,
    type: "session.reasoning.ended",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: messageID, ordinal: 0, text },
  }
}

function toolInputStarted(messageID: string, name: string): V2Event {
  return {
    id: `evt_tool_input_${messageID}`,
    created: 2,
    type: "session.tool.input.started",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: messageID, id: "call_tool", name },
  }
}

// The model finished writing the call, so it goes ahead; its result has not come back yet.
function toolCalled(messageID: string): V2Event {
  return {
    id: `evt_tool_called_${messageID}`,
    created: 3,
    type: "session.tool.called",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: messageID, id: "call_tool", input: {}, executed: false },
  }
}

function toolSucceeded(messageID: string): V2Event {
  return {
    id: `evt_tool_success_${messageID}`,
    created: 3,
    type: "session.tool.success",
    durable: { aggregateID: "ses_1", seq: 3, version: 2 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: messageID,
      id: "call_tool",
      metadata: {},
      content: [{ type: "text", text: "done" }],
      executed: false,
    },
  }
}

function failingTool(messageID: string, name: string, error: { type: string; message: string }): V2Event[] {
  return [
    toolInputStarted(messageID, name),
    {
      id: `evt_tool_failed_${messageID}`,
      created: 3,
      type: "session.tool.failed",
      durable: { aggregateID: "ses_1", seq: 3, version: 2 },
      data: { sessionID: "ses_1", assistantMessageID: messageID, id: "call_tool", error, executed: false },
    },
  ]
}

// A tool call that the model began and the output limit cut off before its input was complete.
const truncatedTool = (messageID: string, name = "write") =>
  failingTool(messageID, name, {
    type: "tool.input-truncated",
    message: "The tool call was cut off by the output limit.",
  })

function permissionAsked(action: string, resources: string[]): V2Event {
  return {
    id: "evt_permission",
    created: 0,
    type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action, resources },
  }
}

// What the server projects for an assistant message, for a run that reads its history instead of its events.
function assistant(
  id: string,
  finish: "stop" | "length" | undefined,
  text?: string,
  error?: { type: string; message: string },
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    content: text === undefined ? [] : [{ type: "text", text }],
    ...(finish ? { finish } : {}),
    ...(error ? { error } : {}),
    time: { created: 2, completed: 3 },
  }
}

function synthetic(id: string, metadata: Record<string, JsonValue>, description?: string): SessionMessageInfo {
  return { id, type: "synthetic", text: "The output limit was raised.", description, metadata, time: { created: 3 } }
}

// The messages of a session that the server returns, newest first and ending with the prompt of the run.
function history(...chronological: SessionMessageInfo[]) {
  return (promptID: string): SessionMessageInfo[] => [
    ...chronological.toReversed(),
    { id: promptID, type: "user", text: "hello", time: { created: 1 } },
  ]
}

function executionFailed(message: string): V2Event {
  return {
    id: "evt_execution_failed",
    created: 3,
    type: "session.execution.failed",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: {
      sessionID: "ses_1",
      error: { type: "provider.transport", message },
    },
  }
}

function failedTool(inboxID: string): V2Event[] {
  return [
    prompted(inboxID),
    {
      id: "evt_failed_tool_input",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        name: "shell",
      },
    },
    {
      id: "evt_failed_tool_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        input: { command: "printf partial && false" },
        executed: true,
      },
    },
    {
      id: "evt_failed_tool_progress",
      created: 3,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        metadata: { checkpoint: 1 },
      },
    },
    {
      id: "evt_failed_tool_terminal",
      created: 4,
      type: "session.tool.failed",
      durable: { aggregateID: "ses_1", seq: 4, version: 2 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        error: { type: "unknown", message: "tool failed" },
        metadata: { checkpoint: 1 },
        content: [{ type: "text", text: "partial output" }],
        executed: true,
      },
    },
    settled(),
  ]
}

function answered(text: string) {
  return (inboxID: string): V2Event[] => [
    prompted(inboxID),
    {
      id: "evt_text_ended",
      created: 1,
      type: "session.text.ended",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", assistantMessageID: "msg_answer", ordinal: 0, text },
    },
    settled(),
  ]
}

function successfulGrep(inboxID: string): V2Event[] {
  const text = "Found 2 matches\n/src/a.ts:\n  Line 1: needle\n/src/b.ts:\n  Line 2: needle"
  return [
    prompted(inboxID),
    {
      id: "evt_grep_input",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        name: "grep",
      },
    },
    {
      id: "evt_grep_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        input: { pattern: "needle" },
        executed: true,
      },
    },
    {
      id: "evt_grep_success",
      created: 3,
      type: "session.tool.success",
      durable: { aggregateID: "ses_1", seq: 3, version: 2 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        metadata: { matches: 2 },
        content: [{ type: "text", text }],
        executed: false,
      },
    },
    settled(),
  ]
}

// Runs one non-interactive prompt against a mocked SDK. `turn` produces the
// live events the prompt admission triggers, keyed by the generated message ID.
async function run(input: {
  turn: (inboxID: string) => V2Event[]
  pendingForms?: FormInfo[]
  attached?: boolean
  format?: "default" | "json" | "stream-json" | "result"
  jsonSchema?: unknown
  envelope?: { cwd: string; agent?: string; model?: string; version: string }
  compatibility?: "v1"
  cancel?: (input: { sessionID: string; formID: string }) => Promise<void>
  renderTool?: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError?: (part: SessionMessageAssistantTool) => Promise<void>
  messages?: (inboxID: string) => SessionMessageInfo[]
  wait?: () => Promise<void>
  terminalDelay?: number
  // How the event stream ends once the events of the turn have been delivered: it finishes, or the connection drops.
  streamEnd?: "done" | "disconnect"
  thinking?: boolean
  // Called as an event is about to be delivered, which waits for what it returns.
  beforeEvent?: (event: V2Event) => void | Promise<void>
  // The history is not returned until this settles.
  historyGate?: Promise<void>
}) {
  const sdk = Orbit.make({ baseUrl: "https://orbit.test" })
  const values: V2Event[] = [{ id: "evt_connected", type: "server.connected", data: {} }]
  let wake: (() => void) | undefined
  let queued = false
  const wait = Promise.withResolvers<void>()
  const stream = (async function* (): AsyncGenerator<V2Event, void, unknown> {
    while (true) {
      const value = values.shift()
      if (!value) {
        if (input.streamEnd === "disconnect" && queued) throw new Error("socket closed")
        if (input.streamEnd === "done" && queued) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      if (value.type.startsWith("session.execution.")) {
        if (input.terminalDelay) await Bun.sleep(input.terminalDelay)
        setTimeout(wait.resolve, 0)
      }
      await input.beforeEvent?.(value)
      yield value
    }
  })()
  spyOn(sdk.event, "subscribe").mockImplementation(() => stream)
  spyOn(sdk.permission, "list").mockImplementation(() => ok([]) as never)
  spyOn(sdk.permission, "reply").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session, "interrupt").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session.form, "list").mockImplementation(
    (request) => ok(input.pendingForms?.filter((item) => item.sessionID === request.sessionID) ?? []) as never,
  )
  spyOn(sdk.form, "list").mockImplementation(
    () =>
      ok({
        location: { ...location, project: { id: "proj_1", directory: location.directory } },
        data: input.pendingForms?.filter((item) => item.sessionID === "global") ?? [],
      }) as never,
  )
  spyOn(sdk.session.form, "cancel").mockImplementation((request) => (input.cancel?.(request) ?? ok(undefined)) as never)
  let promptID = "msg_prompt"
  spyOn(sdk.session, "wait").mockImplementation(() => input.wait?.() ?? wait.promise)
  spyOn(sdk.message, "list").mockImplementation(async () => {
    await input.historyGate
    return {
      data: input.messages?.(promptID) ?? [{ id: promptID, type: "user", text: "hello", time: { created: 1 } }],
      cursor: {},
    }
  })
  spyOn(sdk.session, "prompt").mockImplementation((request) => {
    const messageID = request.id ?? "msg_prompt"
    promptID = messageID
    values.push(...input.turn(messageID))
    queued = true
    wake?.()
    wake = undefined
    return ok({ id: messageID, sessionID: "ses_1", time: { created: 1 } }) as never
  })
  await runNonInteractivePrompt({
    client: sdk,
    sessionID: "ses_1",
    location,
    message: "hello",
    files: [],
    thinking: input.thinking ?? false,
    format: input.format ?? "default",
    jsonSchema: input.jsonSchema,
    envelope: input.envelope,
    auto: false,
    attached: input.attached ?? false,
    compatibility: input.compatibility,
    renderTool: input.renderTool ?? (() => Promise.resolve()),
    renderToolError: input.renderToolError ?? (() => Promise.resolve()),
  })
  return sdk
}

// `tty` is whether stdout is a terminal, which decides where the answer is written. A run is a pipe unless it says so.
// `record` keeps what a run throws, which `orb run` reports itself, and `capture` fails the test with it.
async function record(input: Parameters<typeof run>[0] & { tty?: boolean }) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = process.exitCode
  const isTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: input.tty ?? false, configurable: true, writable: true })
  const stdoutWrite = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    const error = await run(input).then(
      () => undefined,
      (thrown) => thrown,
    )
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode, error }
  } finally {
    process.exitCode = exitCode ?? 0
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true, writable: true })
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
}

async function capture(input: Parameters<typeof record>[0]) {
  const output = await record(input)
  if (output.error !== undefined) throw output.error
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode }
}

// The events that a format of JSON lines printed.
const events = (stdout: string) =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

afterEach(() => {
  mock.restore()
  process.exitCode = 0
})

describe("runNonInteractivePrompt", () => {
  test("result format prints one JSON object with the final answer", async () => {
    const output = await capture({ format: "result", turn: answered("All tests pass.") })
    expect(output.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(output.stdout)).toEqual({
      type: "result",
      sessionID: "ses_1",
      is_error: false,
      result: "All tests pass.",
    })
  })

  test("a JSON schema asks for JSON and parses the answer, failing when it is not JSON", async () => {
    const schema = { type: "object", properties: { count: { type: "number" } } }
    const valid = await capture({ format: "result", jsonSchema: schema, turn: answered('```json\n{"count": 3}\n```') })
    expect(JSON.parse(valid.stdout)).toMatchObject({ is_error: false, structured_output: { count: 3 } })

    const invalid = await capture({ format: "result", jsonSchema: schema, turn: answered("three") })
    expect(JSON.parse(invalid.stdout)).toMatchObject({ is_error: true, error: "The answer was not valid JSON." })
    expect(invalid.exitCode).toBe(1)
  })

  test("keeps formatted tool output and compact tool metadata in JSON", async () => {
    const output = await capture({ format: "json", turn: successfulGrep })
    const events = output.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use",
      part: {
        tool: "grep",
        state: {
          status: "completed",
          output: expect.stringContaining("Found 2 matches"),
          metadata: {
            metadata: { matches: 2 },
            content: [{ type: "text", text: expect.stringContaining("/src/a.ts") }],
          },
        },
      },
    })
    expect(events[0].part.state.metadata.metadata).toEqual({ matches: 2 })
    expect(events[0].part.state.metadata.result).toBeUndefined()
  })

  test("uses session.wait then reconciles projected output without a terminal event", async () => {
    const idle = Promise.withResolvers<void>()
    let done = false
    const task = capture({
      format: "json",
      turn: (messageID) => [prompted(messageID)],
      wait: () => idle.promise,
      messages: (messageID) => [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          content: [{ type: "text", text: "projected answer" }],
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
        { id: messageID, type: "user", text: "hello", time: { created: 1 } },
      ],
    }).then((output) => {
      done = true
      return output
    })

    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(done).toBe(false)
    idle.resolve()
    const output = await task
    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ type: "text", part: expect.objectContaining({ text: "projected answer" }) })])
  })

  test("reports an observed execution failure before prompt promotion", async () => {
    const output = await capture({
      format: "json",
      turn: () => [executionFailed("instructions unavailable")],
      messages: () => [],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        type: "error",
        error: { type: "provider.transport", message: "instructions unavailable" },
      }),
    ])
    expect(output.exitCode).toBe(1)
  })

  test("waits for a terminal failure when idle wins before projection", async () => {
    for (const promotedBeforeFailure of [true, false]) {
      const output = await capture({
        format: "json",
        turn: (messageID) => [
          ...(promotedBeforeFailure ? [prompted(messageID)] : []),
          executionFailed("selection unavailable"),
        ],
        messages: (messageID) =>
          promotedBeforeFailure ? [{ id: messageID, type: "user", text: "hello", time: { created: 1 } }] : [],
        wait: () => Promise.resolve(),
        terminalDelay: 10,
      })

      expect(output.exitCode).toBe(1)
      expect(output.stdout).toContain("selection unavailable")
    }
  })

  test("cancels session and global form blockers and exits on pre-promotion interrupt", async () => {
    const sdk = await run({
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      // No prompted event: the execution settles interrupted before promotion,
      // which must not leave the consume loop waiting forever.
      turn: () => [formCreated(form("frm_live", "global")), settled("interrupted")],
    })
    const globalOptions = {
      headers: {
        "x-orbit-directory": "%2Fwork%20tree",
      },
    }
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "global", formID: "frm_live" }, globalOptions)
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.session.form.cancel).toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      globalOptions,
    )
    expect(sdk.form.list).toHaveBeenCalledWith({
      location: { directory: "/work tree" },
    })
    expect(process.exitCode).toBe(1)
  })

  test("attach mode cancels only session-owned forms", async () => {
    const sdk = await run({
      attached: true,
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      turn: (messageID) => [formCreated(form("frm_live", "global")), prompted(messageID), settled()],
    })
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.form.list).not.toHaveBeenCalled()
    expect(sdk.session.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_live" },
      expect.anything(),
    )
    expect(sdk.session.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      expect.anything(),
    )
    expect(process.exitCode).toBe(1)
  })

  test("V1 JSON output flushes step_start before an unrelated step failure", async () => {
    const output = await capture({
      compatibility: "v1",
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("Provider request failed"),
        executionFailed("Provider request failed"),
      ],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ type: "step_start", part: expect.objectContaining({ type: "step-start" }) }),
      expect.objectContaining({
        type: "error",
        error: { type: "provider.transport", message: "Provider request failed" },
      }),
    ])
    expect(output.stderr).toBe("")
    const sdk = await run({ compatibility: "v1", turn: (messageID) => [prompted(messageID), settled()] })
    expect(sdk.session.wait).not.toHaveBeenCalled()
    expect(sdk.message.list).not.toHaveBeenCalled()
  })

  test("V1 default output flushes step_start before an unrelated execution failure", async () => {
    const output = await capture({
      compatibility: "v1",
      turn: (messageID) => [prompted(messageID), stepStarted(), executionFailed("Execution failed")],
    })

    expect(output.stdout).toBe("")
    expect(output.stderr).toContain("> build · test-model")
    expect(output.stderr).toContain("Error: \u001b[0mExecution failed")
    expect(output.stderr.indexOf("> build · test-model")).toBeLessThan(output.stderr.indexOf("Execution failed"))
  })

  test("V1 preserves terminal-finish failure suppression before content", async () => {
    const output = await capture({
      compatibility: "v1",
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("The provider response ended unexpectedly."),
        executionFailed("The provider response ended unexpectedly."),
      ],
    })

    expect(output).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  test("renders a native terminal failure snapshot when live progress was missed", async () => {
    const rendered: SessionMessageAssistantTool[] = []
    const failed: SessionMessageAssistantTool[] = []
    await capture({
      turn: (inboxID) => failedTool(inboxID).filter((event) => event.type !== "session.tool.progress"),
      renderTool: (part) => {
        rendered.push(part)
        return Promise.resolve()
      },
      renderToolError: (part) => {
        failed.push(part)
        return Promise.resolve()
      },
    })

    expect(rendered).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "completed",
          metadata: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
        },
      },
    ])
    expect(failed).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "error",
          metadata: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
          error: { message: "tool failed" },
        },
      },
    ])
  })

  test("keeps failed tool partial output out of the explicit V1 JSON bridge shape", async () => {
    const output = await capture({ compatibility: "v1", format: "json", turn: failedTool })
    const events = output.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use",
      part: {
        type: "tool",
        id: "call_failed_tool",
        tool: "shell",
        state: {
          status: "error",
          input: { command: "printf partial && false" },
          error: "tool failed",
        },
      },
    })
    expect(events[0].part.state.output).toBeUndefined()
    expect(events[0].part.state.metadata.metadata).toBeUndefined()
    expect(events[0].part.state.metadata.content).toBeUndefined()
    expect(output.stderr).toBe("")
  })
})

describe("runNonInteractivePrompt while the runner recovers", () => {
  const errors = (stderr: string) => stderr.match(/Error: /g) ?? []
  // A run with nothing to wait for, so that it reads its history as soon as it can.
  const idle = { turn: (messageID: string) => [prompted(messageID)], wait: () => Promise.resolve() }

  test("a failed step that another step follows is not an error", async () => {
    const turn = (messageID: string) => [
      prompted(messageID),
      stepFailed("stream ended"),
      stepStarted(),
      textEnded("msg_answer", "recovered"),
      settled(),
    ]

    const text = await capture({ turn })
    expect(text.exitCode).toBe(0)
    expect(text.stderr).not.toContain("stream ended")
    expect(errors(text.stderr)).toEqual([])
    expect(text.stdout).toBe(`recovered${EOL}`)

    const result = await capture({ format: "result", turn })
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      sessionID: "ses_1",
      is_error: false,
      result: "recovered",
    })
    expect(result.exitCode).toBe(0)

    const json = await capture({ format: "json", turn })
    expect(events(json.stdout).map((event) => event.type)).toEqual(["step_start", "text"])
    expect(json.exitCode).toBe(0)
  })

  describe("when the events are behind the history", () => {
    // The server ended the run and answered the wait before the events of its last steps reached this process. They
    // arrive while the history is being read, which is returned after the last of them.
    const behind = (before: V2Event[], late: V2Event[], messages: SessionMessageInfo[]) => {
      const waitGate = Promise.withResolvers<void>()
      const historyGate = Promise.withResolvers<void>()
      return {
        turn: (messageID: string) => [prompted(messageID), ...before, ...late],
        wait: () => waitGate.promise,
        historyGate: historyGate.promise,
        messages: history(...messages),
        beforeEvent: async (event: V2Event) => {
          if (event === late[0]) {
            waitGate.resolve()
            await Bun.sleep(20)
          }
          if (event.type.startsWith("session.execution.")) setTimeout(historyGate.resolve, 20)
        },
      }
    }

    test("a failed step that the history shows another step followed is not an error", async () => {
      const output = await capture(
        behind(
          [stepFailed("stream ended", "msg_one")],
          [stepStarted("msg_two"), textEnded("msg_two", "recovered"), stepEnded("msg_two"), settled()],
          [
            assistant("msg_one", undefined, undefined, { type: "provider.transport", message: "stream ended" }),
            assistant("msg_two", "stop", "recovered"),
          ],
        ),
      )
      expect(errors(output.stderr)).toEqual([])
      expect(output.stderr).not.toContain("stream ended")
      expect(output.stdout).toBe(`recovered${EOL}`)
      expect(output.exitCode).toBe(0)
    })

    test("text that the output limit cut is joined to the text that the history shows after it", async () => {
      const output = await capture(
        behind(
          [stepStarted("msg_one"), textEnded("msg_one", "forty-tw"), stepEnded("msg_one", "length")],
          [stepStarted("msg_two"), textEnded("msg_two", "o."), stepEnded("msg_two"), settled()],
          [assistant("msg_one", "length", "forty-tw"), assistant("msg_two", "stop", "o.")],
        ),
      )
      expect(output.stdout).toBe(`forty-two.${EOL}`)
      expect(output.exitCode).toBe(0)
    })

    test("a failure that the history shows is reported once, and so is the failure of the execution", async () => {
      const failure = { type: "provider.transport", message: "gave up" }
      const output = await capture(
        behind(
          [],
          [stepStarted("msg_one"), stepFailed("gave up", "msg_one"), executionFailed("gave up")],
          [assistant("msg_one", undefined, undefined, failure)],
        ),
      )
      expect(errors(output.stderr)).toHaveLength(1)
      expect(output.exitCode).toBe(1)
    })
  })

  test("the failure of the execution is reported once and replaces a step failure that was held back", async () => {
    const turn = (messageID: string) => [
      prompted(messageID),
      stepFailed("step message"),
      executionFailed("execution message"),
    ]

    const text = await capture({ turn })
    expect(errors(text.stderr)).toHaveLength(1)
    expect(text.stderr).toContain("execution message")
    expect(text.stderr).not.toContain("step message")
    expect(text.exitCode).toBe(1)

    const json = await capture({ format: "json", turn })
    expect(events(json.stdout)).toEqual([
      expect.objectContaining({ type: "error", error: { type: "provider.transport", message: "execution message" } }),
    ])
    expect(json.exitCode).toBe(1)
  })

  test("a failed step that nothing follows is reported when the execution succeeds and when the stream ends", async () => {
    const endings = [
      { turn: (messageID: string) => [prompted(messageID), stepFailed("late failure"), settled()] },
      {
        turn: (messageID: string) => [prompted(messageID), stepFailed("late failure")],
        streamEnd: "done" as const,
        wait: () => Bun.sleep(20),
      },
      {
        turn: (messageID: string) => [prompted(messageID), stepFailed("late failure")],
        streamEnd: "disconnect" as const,
        wait: () => Bun.sleep(20),
      },
    ]

    for (const ending of endings) {
      const text = await capture(ending)
      expect(errors(text.stderr)).toHaveLength(1)
      expect(text.stderr).toContain("late failure")
      expect(text.exitCode).toBe(1)

      const json = await capture({ ...ending, format: "json" })
      expect(events(json.stdout)).toEqual([
        expect.objectContaining({ type: "error", error: { type: "provider.transport", message: "late failure" } }),
      ])

      const result = await capture({ ...ending, format: "result" })
      expect(JSON.parse(result.stdout)).toMatchObject({ is_error: true })
      expect(result.exitCode).toBe(1)
    }
  })

  test("a failed step is reported when the run is stopped by someone else", async () => {
    // This run did not ask for the interruption, so it does not hide the failure that came before it.
    const output = await capture({
      turn: (messageID) => [prompted(messageID), stepFailed("late failure"), settled("interrupted")],
    })
    expect(errors(output.stderr)).toHaveLength(1)
    expect(output.stderr).toContain("late failure")
    expect(output.exitCode).toBe(1)
  })

  test("a failed step is reported in place of the interruption that follows it", async () => {
    const failed = await capture({
      turn: (messageID) => [prompted(messageID), stepFailed("late failure"), settled("interrupted", "shutdown")],
    })
    expect(errors(failed.stderr)).toHaveLength(1)
    expect(failed.stderr).toContain("late failure")
    expect(failed.stderr).not.toContain("Session interrupted")
    expect(failed.exitCode).toBe(1)

    // With nothing held back, the interruption is what is reported.
    const interrupted = await capture({
      turn: (messageID) => [prompted(messageID), settled("interrupted", "shutdown")],
    })
    expect(errors(interrupted.stderr)).toHaveLength(1)
    expect(interrupted.stderr).toContain("Session interrupted: shutdown")
    expect(interrupted.exitCode).toBe(1)
  })

  test("the result reports a stop that the user did not ask for as an interruption with its reason", async () => {
    const envelope = { cwd: "/tmp", version: "test" }
    const shutdown = await capture({
      format: "result",
      envelope,
      turn: (messageID) => [prompted(messageID), settled("interrupted", "shutdown")],
    })
    expect(JSON.parse(shutdown.stdout)).toMatchObject({ is_error: true, outcome: "interrupted", reason: "shutdown" })
    expect(shutdown.exitCode).toBe(1)
  })

  test("the result takes the run's own outcome before the answer's validity, field by field", async () => {
    const envelope = { cwd: "/tmp", version: "test" }
    const jsonSchema = { type: "object" }
    const answer = (text: string, ...ending: V2Event[]) => (messageID: string) => [
      prompted(messageID),
      stepStarted("msg_one"),
      textEnded("msg_one", text),
      stepEnded("msg_one"),
      ...ending,
    ]
    const rows: {
      name: string
      turn: (messageID: string) => V2Event[]
      expected: Record<string, unknown>
      absent: string[]
    }[] = [
      {
        name: "success",
        turn: answer('{"a":1}', settled()),
        expected: { is_error: false, outcome: "succeeded", structured_output: { a: 1 } },
        absent: ["reason", "error"],
      },
      {
        name: "invalid JSON after a success",
        turn: answer("nope", settled()),
        expected: { is_error: true, outcome: "failed", reason: "invalid_output", error: "The answer was not valid JSON." },
        absent: ["structured_output"],
      },
      {
        name: "failure with an empty answer",
        turn: (messageID) => [prompted(messageID), executionFailed("boom")],
        expected: { is_error: true, outcome: "failed", reason: "error", error: "boom" },
        absent: ["structured_output"],
      },
      {
        name: "failure after an answer that is not JSON",
        turn: answer("nope", executionFailed("boom")),
        expected: { is_error: true, outcome: "failed", reason: "error", error: "boom" },
        absent: [],
      },
      {
        name: "interruption",
        turn: answer("nope", settled("interrupted", "shutdown")),
        expected: { is_error: true, outcome: "interrupted", reason: "shutdown", error: "Session interrupted: shutdown" },
        absent: [],
      },
      {
        name: "stop at the output limit",
        turn: (messageID) => [
          prompted(messageID),
          stepStarted("msg_one"),
          textEnded("msg_one", "nope"),
          stepEnded("msg_one", "length"),
          settled(),
        ],
        expected: { is_error: true, outcome: "failed" },
        absent: [],
      },
    ]

    // One after the other: each run replaces process.stdout.write.
    for (const row of rows) {
      const output = await capture({ format: "result", envelope, jsonSchema, turn: row.turn })
      const result = JSON.parse(output.stdout)
      expect({ row: row.name, ...result }).toMatchObject({ row: row.name, ...row.expected })
      row.absent.forEach((key) => expect({ row: row.name, has: key in result }).toEqual({ row: row.name, has: false }))
      expect(output.exitCode).toBe(1 - Number(row.expected.is_error === false))
    }
  })

  test("the result counts the cost, tokens and steps of a failed step too", async () => {
    const output = await capture({
      format: "result",
      envelope: { cwd: "/tmp", version: "test" },
      turn: (messageID) => [
        prompted(messageID),
        stepStarted("msg_one"),
        stepFailed("gave up", "msg_one", 0.25),
        stepStarted("msg_two"),
        stepEnded("msg_two", "stop", 0.5),
        settled(),
      ],
    })

    expect(JSON.parse(output.stdout)).toMatchObject({
      steps: 2,
      cost: 0.75,
      tokens: { input: 3, output: 1 },
    })
  })

  test("a failed run with a schema in the text format prints its error once", async () => {
    const output = await capture({
      envelope: { cwd: "/tmp", version: "test" },
      jsonSchema: { type: "object" },
      turn: (messageID) => [prompted(messageID), executionFailed("boom")],
    })
    expect(output.stderr.match(/boom/g)).toHaveLength(1)
    expect(output.exitCode).toBe(1)
  })

  test("a failed step that nothing follows is reported when the execution ends, before the history is read", async () => {
    // What has been written to stderr so far, which a run's reading of the history can look at.
    const writtenSoFar = () =>
      (process.stderr.write as unknown as Mock<(chunk: unknown) => boolean>).mock.calls
        .map((call) => String(call[0]))
        .join("")

    for (const ending of [settled(), settled("interrupted")]) {
      let beforeHistory = ""
      const output = await capture({
        turn: (messageID) => [prompted(messageID), stepFailed("late failure"), ending],
        messages: (messageID) => {
          beforeHistory = writtenSoFar()
          return [{ id: messageID, type: "user", text: "hello", time: { created: 1 } }]
        },
      })
      expect(beforeHistory).toContain("late failure")
      expect(errors(output.stderr)).toHaveLength(1)
    }
  })

  test("a run that is stopped with a signal does not report the failure that was held back", async () => {
    const output = await capture({
      turn: (messageID) => [prompted(messageID), stepFailed("late failure"), settled("interrupted")],
      // The signal arrives as the interruption does, after the failed step was seen. Only the handler of this run is
      // called, because other listeners belong to the test runner.
      beforeEvent: (event) => {
        if (event.type === "session.execution.interrupted") process.listeners("SIGINT").at(-1)?.("SIGINT")
      },
    })
    expect(output.stderr).not.toContain("late failure")
    expect(output.exitCode).toBe(130)
  })

  test("reads only the error of the last assistant message from the history", async () => {
    const earlier = { type: "provider.transport", message: "earlier failure" }
    const later = { type: "provider.transport", message: "later failure" }

    const recovered = await capture({
      ...idle,
      messages: history(assistant("msg_a", undefined, undefined, earlier), assistant("msg_b", "stop", "fixed")),
    })
    expect(errors(recovered.stderr)).toEqual([])
    expect(recovered.stderr).not.toContain("earlier failure")
    expect(recovered.stdout).toBe(`fixed${EOL}`)
    expect(recovered.exitCode).toBe(0)

    const failing = await capture({
      ...idle,
      messages: history(
        assistant("msg_a", undefined, undefined, earlier),
        assistant("msg_b", undefined, undefined, later),
      ),
    })
    expect(errors(failing.stderr)).toHaveLength(1)
    expect(failing.stderr).toContain("later failure")
    expect(failing.stderr).not.toContain("earlier failure")
    expect(failing.exitCode).toBe(1)

    const result = await capture({
      ...idle,
      format: "result",
      messages: history(assistant("msg_a", undefined, undefined, earlier), assistant("msg_b", "stop", "fixed")),
    })
    expect(JSON.parse(result.stdout)).toEqual({ type: "result", sessionID: "ses_1", is_error: false, result: "fixed" })
  })

  test("a failure that the history shows after the events ended is not dropped", async () => {
    // The events showed a failed step and a step after it, but the history says that the last one failed as well.
    const output = await capture({
      turn: (messageID) => [prompted(messageID), stepFailed("first"), stepStarted("msg_two"), settled()],
      messages: history(
        assistant("msg_assistant", undefined, undefined, { type: "provider.transport", message: "first" }),
        assistant("msg_two", undefined, undefined, { type: "provider.transport", message: "second" }),
      ),
    })
    expect(errors(output.stderr)).toHaveLength(1)
    expect(output.stderr).toContain("second")
    expect(output.exitCode).toBe(1)
  })

  test("writes the text of a step before a request for permission that comes after it", async () => {
    const output = await capture({
      tty: true,
      turn: (messageID) => [
        prompted(messageID),
        stepStarted("msg_one"),
        textEnded("msg_one", "Working on it."),
        permissionAsked("edit", ["src/a.ts"]),
        stepEnded("msg_one"),
        settled(),
      ],
    })
    const lines = output.stderr.split(EOL)
    expect(lines).toContain("Working on it.")
    expect(lines.findIndex((line) => line.includes("permission requested"))).toBeGreaterThan(
      lines.indexOf("Working on it."),
    )
  })

  describe("text that the output limit cut", () => {
    // Two steps, the first of which stopped at the output limit.
    const cut =
      (first: string, second: string, finish: "length" | "stop" = "length") =>
      (messageID: string) => [
        prompted(messageID),
        stepStarted("msg_one"),
        textEnded("msg_one", first),
        stepEnded("msg_one", finish),
        stepStarted("msg_two"),
        textEnded("msg_two", second),
        stepEnded("msg_two"),
        settled(),
      ]

    test("is joined in the answer and in the value that a JSON Schema parses", async () => {
      const result = await capture({ format: "result", turn: cut("The answer is forty-tw", "o.") })
      expect(JSON.parse(result.stdout)).toEqual({
        type: "result",
        sessionID: "ses_1",
        is_error: false,
        result: "The answer is forty-two.",
      })

      const parsed = await capture({
        format: "result",
        jsonSchema: { type: "object" },
        turn: cut('{"name": "Ali', 'ce"}'),
      })
      expect(JSON.parse(parsed.stdout)).toEqual({
        type: "result",
        sessionID: "ses_1",
        is_error: false,
        result: '{"name": "Alice"}',
        structured_output: { name: "Alice" },
      })
      expect(parsed.exitCode).toBe(0)
    })

    test("gives the same answer in the result and stream-json envelopes", async () => {
      const envelope = { cwd: "/tmp", version: "test" }
      // One after the other: each run replaces process.stdout.write.
      const results = []
      for (const format of ["result", "stream-json"] as const) {
        const output = await capture({
          format,
          envelope,
          jsonSchema: { type: "object" },
          turn: cut('{"name": "Ali', 'ce"}'),
        })
        results.push(JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1)!))
      }

      results.forEach((result) =>
        expect(result).toMatchObject({ is_error: false, result: '{"name": "Alice"}', structured_output: { name: "Alice" } }),
      )
    })

    test("is written as one line to a pipe and to a terminal", async () => {
      const piped = await capture({ turn: cut("The answer is forty-tw", "o.") })
      expect(piped.stdout).toBe(`The answer is forty-two.${EOL}`)

      const terminal = await capture({ tty: true, turn: cut("The answer is forty-tw", "o.") })
      expect(terminal.stdout).toBe("")
      expect(terminal.stderr.split(EOL)).toContain("The answer is forty-two.")
      expect(terminal.stderr.split(EOL)).not.toContain("o.")
    })

    test("is joined as it is, without a separator or trimming, and only after a step that stopped at the limit", async () => {
      const spaced = await capture({ turn: cut("one ", " two") })
      expect(spaced.stdout).toBe(`one  two${EOL}`)

      const whole = await capture({ turn: cut("The answer is forty-tw", "o.", "stop") })
      expect(whole.stdout).toBe(`The answer is forty-tw${EOL}o.${EOL}`)
      const wholeResult = await capture({ format: "result", turn: cut("The answer is forty-tw", "o.", "stop") })
      expect(JSON.parse(wholeResult.stdout).result).toBe("The answer is forty-tw\n\no.")
    })

    test("is not joined across a step that failed, which the runner continues", async () => {
      // Only a step that stopped at the limit is carried on by the next one; a step that failed has its text written as
      // it is, and the step that follows it writes its own.
      const output = await capture({
        turn: (messageID) => [
          prompted(messageID),
          stepStarted("msg_one"),
          textEnded("msg_one", "forty-tw"),
          stepFailed("stream ended", "msg_one"),
          stepStarted("msg_two"),
          textEnded("msg_two", "o."),
          stepEnded("msg_two"),
          settled(),
        ],
      })
      expect(output.stdout).toBe(`forty-tw${EOL}o.${EOL}`)
      expect(errors(output.stderr)).toEqual([])
      expect(output.exitCode).toBe(0)
    })

    test("stays one part per line in the JSON formats, which end it with the reason of the step", async () => {
      for (const format of ["json", "stream-json"] as const) {
        const output = await capture({ format, turn: cut("The answer is forty-tw", "o.") })
        expect(events(output.stdout).map((event) => [event.type, event.part.messageID])).toEqual([
          ["step_start", "msg_one"],
          ["text", "msg_one"],
          ["step_finish", "msg_one"],
          ["step_start", "msg_two"],
          ["text", "msg_two"],
          ["step_finish", "msg_two"],
        ])
        expect(events(output.stdout).find((event) => event.type === "step_finish").part.reason).toBe("length")
        expect(
          events(output.stdout)
            .filter((event) => event.type === "text")
            .map((event) => event.part.text),
        ).toEqual(["The answer is forty-tw", "o."])
      }
    })

    test("is not joined across something that is written in between", async () => {
      const between =
        (...inBetween: V2Event[]) =>
        (messageID: string) => [
          prompted(messageID),
          stepStarted("msg_one"),
          textEnded("msg_one", "forty-tw"),
          stepEnded("msg_one", "length"),
          stepStarted("msg_two"),
          ...inBetween,
          textEnded("msg_two", "o."),
          stepEnded("msg_two"),
          settled(),
        ]

      // A thinking line is written between them when it is shown, and nothing is when it is not.
      const shown = await capture({ thinking: true, turn: between(reasoningEnded("msg_two", "hm")) })
      expect(shown.stdout).toBe(`forty-tw${EOL}Thinking: hm${EOL}o.${EOL}`)
      const hidden = await capture({ turn: between(reasoningEnded("msg_two", "hm")) })
      expect(hidden.stdout).toBe(`forty-two.${EOL}`)

      // A tool call that failed is written between them, and so is one that succeeded, and one that has only begun to
      // run.
      const failed = await capture({
        turn: between(...failingTool("msg_two", "grep", { type: "unknown", message: "no" })),
      })
      expect(failed.stdout).toBe(`forty-tw${EOL}o.${EOL}`)
      expect(errors(failed.stderr)).toHaveLength(1)
      const succeeded = await capture({ turn: between(toolSucceeded("msg_two")) })
      expect(succeeded.stdout).toBe(`forty-tw${EOL}o.${EOL}`)
      const running = await capture({ turn: between(toolInputStarted("msg_two", "grep"), toolCalled("msg_two")) })
      expect(running.stdout).toBe(`forty-tw${EOL}o.${EOL}`)

      // Text that waits for the end of its step is not carried on by a step that starts without having seen it end.
      const unended = await capture({
        turn: (messageID) => [
          prompted(messageID),
          stepStarted("msg_one"),
          textEnded("msg_one", "forty-tw"),
          stepStarted("msg_two"),
          textEnded("msg_two", "o."),
          stepEnded("msg_two"),
          settled(),
        ],
      })
      expect(unended.stdout).toBe(`forty-tw${EOL}o.${EOL}`)
    })

    test("is written when the run ends, and when the history is read", async () => {
      // No step ended after the text, and no execution ended either: the stream stopped, which fails the run, and the
      // text that was waiting is in the result however it stopped.
      const endings = [
        { streamEnd: "done" as const, error: "Event stream disconnected during prompt execution" },
        { streamEnd: "disconnect" as const, error: "socket closed" },
      ]
      for (const ending of endings) {
        const ended = await record({
          turn: (messageID) => [prompted(messageID), stepStarted("msg_one"), textEnded("msg_one", "last words")],
          streamEnd: ending.streamEnd,
          wait: () => Bun.sleep(20),
          format: "result",
        })
        expect(ended.error).toEqual(new Error(ending.error))
        expect(JSON.parse(ended.stdout)).toMatchObject({ is_error: true, result: "last words" })
      }

      const read = await capture({
        ...idle,
        messages: history(assistant("msg_one", "length", "The answer is forty-tw"), assistant("msg_two", "stop", "o.")),
      })
      expect(read.stdout).toBe(`The answer is forty-two.${EOL}`)
    })
  })

  test("a tool call that the output limit cut off is a note, not an error", async () => {
    const failed: SessionMessageAssistantTool[] = []
    const turn = (messageID: string) => [
      prompted(messageID),
      stepStarted("msg_one"),
      textEnded("msg_one", "Writing the file."),
      ...truncatedTool("msg_one"),
      stepEnded("msg_one", "length"),
      stepStarted("msg_two"),
      textEnded("msg_two", "Done."),
      stepEnded("msg_two"),
      settled(),
    ]

    const text = await capture({
      turn,
      renderToolError: (part) => {
        failed.push(part)
        return Promise.resolve()
      },
    })
    expect(text.stderr.match(/Tool call cut off by the output limit: write/g)).toHaveLength(1)
    expect(text.stderr).toContain(
      `${UI.Style.TEXT_DIM}Tool call cut off by the output limit: write${UI.Style.TEXT_NORMAL}`,
    )
    expect(errors(text.stderr)).toEqual([])
    expect(failed).toEqual([])
    expect(text.stdout).toBe(`Writing the file.${EOL}Done.${EOL}`)
    expect(text.exitCode).toBe(0)

    // The JSON formats keep the event, as they do for any tool call.
    const json = await capture({ format: "stream-json", turn })
    expect(events(json.stdout).filter((event) => event.type === "tool_use")).toEqual([
      expect.objectContaining({
        part: expect.objectContaining({
          tool: "write",
          state: expect.objectContaining({ status: "error", error: "The tool call was cut off by the output limit." }),
        }),
      }),
    ])

    // The same note when the history is what shows the call.
    const read = await capture({
      ...idle,
      messages: (messageID) => [
        {
          ...assistant("msg_one", "length"),
          content: [
            {
              type: "tool",
              id: "call_tool",
              name: "write",
              executed: false,
              state: {
                status: "error",
                input: {},
                metadata: {},
                error: { type: "tool.input-truncated", message: "The tool call was cut off by the output limit." },
              },
              time: { created: 2 },
            },
          ],
        },
        { id: messageID, type: "user", text: "hello", time: { created: 1 } },
      ],
    })
    expect(read.stderr.match(/Tool call cut off by the output limit: write/g)).toHaveLength(1)
    expect(errors(read.stderr)).toEqual([])

    // Any other failed tool call is still reported as one.
    const other = await capture({ turn: failedTool })
    expect(errors(other.stderr)).toHaveLength(1)
    expect(other.stderr).toContain("tool failed")
  })

  describe("an output-escalation notice", () => {
    // The first attempt stopped at the output limit and the runner answers again from the start, so the first attempt is
    // no part of the answer. The run is described by its events and by the history that the server projects.
    const attempts = (first: string, second: string, ...inFirst: V2Event[]) => ({
      events: (messageID: string) => [
        prompted(messageID),
        stepStarted("msg_first"),
        textEnded("msg_first", first),
        ...inFirst,
        stepEnded("msg_first", "length"),
        escalation(replacing("msg_first")),
        stepStarted("msg_second"),
        textEnded("msg_second", second),
        stepEnded("msg_second"),
        settled(),
      ],
      history: {
        ...idle,
        messages: history(
          assistant("msg_first", "length", first),
          synthetic("msg_notice", replacing("msg_first")),
          assistant("msg_second", "stop", second),
        ),
      },
    })
    const runs = (first: string, second: string) =>
      [
        ["its events", { turn: attempts(first, second).events }],
        ["its history", attempts(first, second).history],
      ] as const

    test.each(runs("Draft", "Answer"))(
      "drops the replaced attempt from the answer when it reads %s",
      async (_, source) => {
        const result = await capture({ ...source, format: "result" })
        expect(JSON.parse(result.stdout)).toEqual({
          type: "result",
          sessionID: "ses_1",
          is_error: false,
          result: "Answer",
        })
        expect(result.exitCode).toBe(0)

        const text = await capture(source)
        expect(text.stdout).toBe(`Answer${EOL}`)
        expect(text.exitCode).toBe(0)
      },
    )

    test.each(runs('{"a":1}', '{"b":2}'))(
      "drops the replaced attempt from the value that a JSON Schema parses when it reads %s",
      async (_, source) => {
        const result = await capture({ ...source, format: "result", jsonSchema: { type: "object" } })
        expect(JSON.parse(result.stdout)).toEqual({
          type: "result",
          sessionID: "ses_1",
          is_error: false,
          result: '{"b":2}',
          structured_output: { b: 2 },
        })
        expect(result.exitCode).toBe(0)
      },
    )

    test.each(runs("Draft", "Answer"))(
      "prints one notice line that names the replaced message when it reads %s",
      async (_, source) => {
        for (const format of ["json", "stream-json"] as const) {
          const output = await capture({ ...source, format })
          expect(events(output.stdout).filter((event) => event.type === "notice")).toEqual([
            {
              type: "notice",
              timestamp: expect.any(Number),
              sessionID: "ses_1",
              notice: "output-escalation",
              replaces: "msg_first",
            },
          ])
          // The parts of both attempts are still printed, for a program to drop by the message they belong to.
          expect(
            events(output.stdout)
              .filter((event) => event.type === "text")
              .map((event) => [event.part.messageID, event.part.text]),
          ).toEqual([
            ["msg_first", "Draft"],
            ["msg_second", "Answer"],
          ])
        }

        // The other formats print no line for it.
        for (const format of ["default", "result"] as const) {
          const quiet = await capture({ ...source, format })
          expect(quiet.stdout).not.toContain("notice")
          expect(quiet.stderr).not.toContain("output limit")
        }
      },
    )

    test("prints the notice line whether or not the notice has a description", async () => {
      const line = {
        type: "notice",
        timestamp: expect.any(Number),
        sessionID: "ses_1",
        notice: "output-escalation",
        replaces: "msg_first",
      }
      for (const description of [undefined, "Raised the output limit"]) {
        const fromEvents = await capture({
          format: "stream-json",
          turn: (messageID) => [prompted(messageID), escalation(replacing("msg_first"), description), settled()],
        })
        expect(events(fromEvents.stdout)).toEqual([line])

        // No message answers, so the run waits for the end of the events as well.
        const fromHistory = await capture({
          ...idle,
          turn: (messageID) => [prompted(messageID), settled()],
          format: "stream-json",
          messages: history(synthetic("msg_notice", replacing("msg_first"), description)),
        })
        expect(events(fromHistory.stdout)).toEqual([line])
      }
    })

    test("drops the note about a tool call that the replaced attempt left unfinished", async () => {
      const replacedRun = await capture({ turn: attempts("Draft", "Answer", ...truncatedTool("msg_first")).events })
      expect(replacedRun.stdout).toBe(`Answer${EOL}`)
      expect(replacedRun.stderr).not.toContain("cut off")
      expect(errors(replacedRun.stderr)).toEqual([])

      // Without the notice the draft and the note are written, so the run above did not lack them in the first place.
      const kept = await capture({
        turn: (messageID) => [
          prompted(messageID),
          stepStarted("msg_first"),
          textEnded("msg_first", "Draft"),
          ...truncatedTool("msg_first"),
          stepEnded("msg_first", "length"),
          stepStarted("msg_second"),
          textEnded("msg_second", "Answer"),
          stepEnded("msg_second"),
          settled(),
        ],
      })
      expect(kept.stdout).toBe(`Draft${EOL}Answer${EOL}`)
      expect(kept.stderr).toContain("cut off")
    })

    test("replaces only the message it names, and only when it names one", async () => {
      // With nothing replaced, the text of the second step carries on from the text of the first, which the limit cut.
      const turn = (metadata?: Record<string, JsonValue>) => (messageID: string) => [
        prompted(messageID),
        stepStarted("msg_first"),
        textEnded("msg_first", "Draft"),
        stepEnded("msg_first", "length"),
        ...(metadata ? [escalation(metadata)] : []),
        stepStarted("msg_second"),
        textEnded("msg_second", "Answer"),
        stepEnded("msg_second"),
        settled(),
      ]
      const control = await capture({ format: "result", turn: turn(replacing("msg_first")) })
      expect(JSON.parse(control.stdout).result).toBe("Answer")

      const unnamed: Array<Record<string, JsonValue>> = [
        { notice: "output-escalation" },
        { notice: "output-escalation", replaces: 42 },
        { notice: "output-escalation", replaces: "first" },
        { notice: "restart", replaces: "msg_first" },
      ]
      for (const metadata of [undefined, replacing("msg_elsewhere"), ...unnamed]) {
        const result = await capture({ format: "result", turn: turn(metadata) })
        expect(JSON.parse(result.stdout)).toMatchObject({ is_error: false, result: "DraftAnswer" })
      }

      // And no line says that anything was replaced.
      for (const metadata of unnamed) {
        const lines = await capture({ format: "stream-json", turn: turn(metadata) })
        expect(events(lines.stdout).filter((event) => event.type === "notice")).toEqual([])
      }
    })
  })

  test("V1 reports a failed step at once and writes each text part as it ends", async () => {
    const failed = await capture({
      compatibility: "v1",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted("msg_one"),
        stepFailed("boom", "msg_one"),
        stepStarted("msg_two"),
        textEnded("msg_two", "recovered"),
        stepEnded("msg_two"),
        settled(),
      ],
    })
    expect(failed.stderr).toContain("> build · test-model")
    expect(failed.stderr).toContain("Error: \u001b[0mboom")
    expect(failed.stdout).toBe(`recovered${EOL}`)
    expect(failed.exitCode).toBe(1)

    const cut = await capture({
      compatibility: "v1",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted("msg_one"),
        textEnded("msg_one", "forty-tw"),
        stepEnded("msg_one", "length"),
        stepStarted("msg_two"),
        textEnded("msg_two", "o."),
        stepEnded("msg_two"),
        ...failingTool("msg_two", "write", { type: "tool.input-truncated", message: "cut" }),
        settled(),
      ],
    })
    expect(cut.stdout).toBe(`forty-tw${EOL}o.${EOL}`)
    // V1 has no note for a cut-off call: it is an error there, as it was before.
    expect(errors(cut.stderr)).toHaveLength(1)
  })
})

describe("runNonInteractivePrompt output channels", () => {
  // A set-title sequence, one that erases the line, the C1 starts of a control sequence and of a command string, DEL, a
  // carriage return, a right-to-left override and a zero-width space: what text from a repository can carry.
  const hostile = "\u001b]0;pwned\u0007\u001b[2K\u009b31m\u009d0;x\u007f\r\u{202e}\u{200b}end"
  const shown = "\\x1b]0;pwned\\x07\\x1b[2K\\x9b31m\\x9d0;x\\x7f\\x0d\\u{202e}\\u{200b}end"

  // What a terminal would act on: the characters of Unicode category C that are left on a line once the colors of the
  // run itself are taken out.
  const acting = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => Object.values(UI.Style).reduce((rest, code) => rest.replaceAll(code, ""), line))
      .filter((line) => /\p{C}/u.test(line))

  // Each way that text reaches stderr in the default format.
  const toStderr: Array<[string, Parameters<typeof capture>[0]["turn"]]> = [
    ["the failure of an execution", (id) => [prompted(id), executionFailed(hostile)]],
    ["a failed step that nothing follows", (id) => [prompted(id), stepFailed(hostile), settled()]],
    [
      "a failed tool call",
      (id) => [prompted(id), ...failingTool("msg_one", "grep", { type: "unknown", message: hostile }), settled()],
    ],
    [
      "a tool call that was cut off",
      (id) => [prompted(id), ...truncatedTool("msg_one", hostile), stepEnded("msg_one", "length"), settled()],
    ],
    ["the label of a step", (id) => [prompted(id), stepStarted("msg_one", hostile), settled()]],
    ["a request for permission", (id) => [permissionAsked(hostile, [hostile]), prompted(id), settled()]],
  ]

  test.each(toStderr)("writes out the text of %s on stderr", async (_, turn) => {
    const output = await capture({ turn })
    expect(acting(output.stderr)).toEqual([])
    expect(output.stderr).toContain(shown)
  })

  test("writes out the error that the history shows the same way", async () => {
    const output = await capture({
      turn: (messageID) => [prompted(messageID)],
      wait: () => Promise.resolve(),
      messages: history(assistant("msg_one", undefined, undefined, { type: "provider.transport", message: hostile })),
    })
    expect(acting(output.stderr)).toEqual([])
    expect(output.stderr).toContain(shown)
  })

  // Each way that text reaches stdout as a line of JSON: what to read the text from, and what it has to equal.
  const toJson: Array<[string, Parameters<typeof capture>[0]["turn"], (lines: ReturnType<typeof events>) => unknown]> =
    [
      [
        "the failure of an execution",
        (id) => [prompted(id), executionFailed(hostile)],
        (lines) => lines.find((line) => line.type === "error").error.message,
      ],
      [
        "a part of the answer",
        (id) => [prompted(id), textEnded("msg_one", hostile), settled()],
        (lines) => lines.find((line) => line.type === "text").part.text,
      ],
      [
        "a failed tool call",
        (id) => [prompted(id), ...failingTool("msg_one", hostile, { type: "unknown", message: hostile }), settled()],
        (lines) => lines.find((line) => line.type === "tool_use").part.state.error,
      ],
      [
        "the name of a tool",
        (id) => [prompted(id), ...failingTool("msg_one", hostile, { type: "unknown", message: "no" }), settled()],
        (lines) => lines.find((line) => line.type === "tool_use").part.tool,
      ],
      [
        "the message that a notice replaces",
        (id) => [prompted(id), escalation({ notice: "output-escalation", replaces: `msg_${hostile}` }), settled()],
        (lines) => lines.find((line) => line.type === "notice").replaces.slice("msg_".length),
      ],
    ]

  test.each(toJson)("writes out %s as JSON that parses back to the same text", async (_, turn, read) => {
    for (const format of ["json", "stream-json"] as const) {
      const output = await capture({ format, turn })
      expect(acting(output.stdout)).toEqual([])
      expect(read(events(output.stdout))).toBe(hostile)
    }
  })

  test("writes out the result as JSON that parses back to the same text", async () => {
    const output = await capture({ format: "result", turn: answered(hostile) })
    expect(acting(output.stdout)).toEqual([])
    expect(JSON.parse(output.stdout).result).toBe(hostile)
  })

  test("writes out the error that comes before a session exists as JSON that parses back to the same text", async () => {
    for (const format of ["json", "stream-json"] as const) {
      const stdout: string[] = []
      const exitCode = process.exitCode
      const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk))
        return true
      })
      try {
        reportRunError({ format }, hostile, "ses_1")
      } finally {
        write.mockRestore()
        process.exitCode = exitCode
      }
      expect(acting(stdout.join(""))).toEqual([])
      expect(JSON.parse(stdout.join("")).error.message).toBe(hostile)
    }
  })

  // In a process of its own, because a process prints one result and the tests above have printed theirs.
  test("writes out the result for an error that comes before a session exists the same way", async () => {
    const source = `import { reportRunError } from ${JSON.stringify(path.join(import.meta.dir, "../../src/run/run.ts"))}
reportRunError({ format: "result" }, ${JSON.stringify(hostile)}, "ses_1")`
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 1, stderr: "" })
    expect(acting(stdout)).toEqual([])
    expect(JSON.parse(stdout)).toEqual({
      type: "result",
      sessionID: "ses_1",
      is_error: true,
      result: "",
      error: hostile,
    })
  })
})
