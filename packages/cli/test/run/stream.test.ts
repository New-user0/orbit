// `orb -p --input-format stream-json` against a real private server and a scripted model: results in order, asks and
// their answers, interrupts and how input lines decode. Every run is a child process of src/index.ts and has a deadline,
// so a hang fails the test instead of blocking the runner. The root and helpers are in fixture/stream-run.ts.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { modelAsked, results, scripted } from "../fixture/stream-controller"
import {
  root,
  workspace,
  controller,
  write,
  slow,
} from "../fixture/stream-run"

test("two user lines give two result lines in order, and the second sees the first", async () => {
  await scripted(["first answer", "second answer"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "one" })
    const first = await run.until((line) => line.type === "result")
    run.send({ type: "user", text: "two" })
    await run.until((line) => line.type === "result", first.next)
    run.end()
    const done = await run.finish()

    expect(done.code).toBe(0)
    expect(run.lines[0]).toMatchObject({ type: "init", protocol: 1 })
    expect(results(run.lines).map((line) => line.result)).toEqual(["first answer", "second answer"])
    expect(own.steps.map((step) => step.user)).toEqual(["one", "two"])
    expect(JSON.stringify(own.steps[1].body.messages)).toContain("one")
  })
}, 240_000)

test("with --json-schema every user line asks for its own answer and gets its own result line", async () => {
  const schema = path.join(root, "answer-schema.json")
  await Bun.write(
    schema,
    JSON.stringify({ type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }),
  )
  const handIn = (input: unknown) => ({ tool: { name: "StructuredOutput", input } })
  // The second line's first hand-in is wrong, so only that line retries, with a budget of its own.
  await scripted(
    [handIn({ n: 1 }), "", handIn({ n: "two" }), handIn({ n: 2 }), ""],
    async (own, home) => {
      const run = controller(home, own, ["--json-schema", schema])
      run.send({ type: "user", text: "one" })
      const first = await run.until((line) => line.type === "result")
      run.send({ type: "user", text: "two" })
      await run.until((line) => line.type === "result", first.next)
      run.end()
      const done = await run.finish()

      expect(done.code).toBe(0)
      const lines = results(run.lines)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({ is_error: false, subtype: "success", structured_output: { n: 1 } })
      expect(lines[1]).toMatchObject({ is_error: false, subtype: "success", structured_output: { n: 2 } })
      // The prompt text is the line itself: the schema travels in the request field, never in the words.
      expect([...new Set(own.steps.map((step) => step.user))]).toEqual(["one", "two"])
      expect(JSON.stringify(own.steps.map((step) => step.body.messages))).not.toContain("JSON Schema")
    },
  )
}, 240_000)

// Each decision of the controller on an ask for a write, and what follows from it.
test.each([
  { decision: "once", message: undefined, written: true, feedback: false },
  { decision: "reject", message: "no thanks, keep it as is", written: false, feedback: true },
  { decision: "reject", message: undefined, written: false, feedback: false },
])(
  "a permission_reply of $decision (message: $message) settles the ask the way it says",
  async (row) => {
    const name = `decision-${row.decision}-${row.message ? "message" : "plain"}.txt`
    await scripted([write(name, { forged: "MODEL-ADDED-KEY" }), "done"], async (own, home) => {
      const run = controller(home, own)
      run.send({ type: "user", text: "write it" })
      const ask = await run.until((line) => line.type === "permission_request")
      run.send({
        type: "permission_reply",
        requestID: ask.line.request.id,
        decision: row.decision,
        ...(row.message ? { message: row.message } : {}),
      })
      await run.until((line) => line.type === "result", ask.next)
      run.end()
      const done = await run.finish()

      // The request is the server's: the action, the resolved resources and the tool call, never the model's input.
      expect(ask.line.request).toMatchObject({
        action: "Edit",
        source: { type: "tool" },
        metadata: { files: [{ status: "added" }] },
      })
      expect(ask.line.request.resources).toEqual([name])
      expect(ask.line.request.metadata.files[0].patch).toContain("+written")
      expect(JSON.stringify(ask.line)).not.toContain("MODEL-ADDED-KEY")
      expect(await Bun.file(path.join(workspace, name)).exists()).toBe(row.written)
      if (row.message) expect(JSON.stringify(own.steps.at(-1)?.body.messages)).toContain(row.message)
      if (row.feedback) expect(results(run.lines)[0]).toMatchObject({ is_error: false, outcome: "succeeded" })
      if (row.decision === "reject" && !row.message) expect(done.code).toBe(1)
      else expect(done.code).toBe(0)
    })
  },
  240_000,
)

test("a write outside the folder asks about the resolved folder, from the server's request and not the model's input", async () => {
  const outside = path.join(root, "outside")
  // Joined as a string: path.join would remove the `..` before the model ever saw it.
  const target = [outside, "..", "outside", "escape.txt"].join(path.sep)
  await scripted(
    [{ tool: { name: "Write", input: { file_path: target, content: "x", forged: "MODEL-ADDED-KEY" } } }, "done"],
    async (own, home) => {
      const run = controller(home, own)
      run.send({ type: "user", text: "write it" })
      const ask = await run.until((line) => line.type === "permission_request")
      run.send({ type: "permission_reply", requestID: ask.line.request.id, decision: "reject" })
      await run.until((line) => line.type === "result", ask.next)
      run.end()
      await run.finish()

      expect(ask.line.request.action).toBe("external_directory")
      // The ask names the folder the server resolved, with the `..` already gone.
      expect(ask.line.request.resources).toEqual([`${outside.replaceAll("\\", "/")}/*`])
      expect(JSON.stringify(ask.line)).not.toContain("MODEL-ADDED-KEY")
      expect(await Bun.file(path.join(outside, "escape.txt")).exists()).toBe(false)
    },
  )
}, 240_000)

// m5-link-warning: stream-json and the SDK's view of a request are the request itself, so the link is in it.
test("a notebook edit through a link carries the link on the permission request", async () => {
  await fs.mkdir(path.join(workspace, "notebooks"), { recursive: true })
  await fs.symlink(path.join(workspace, "notebooks"), path.join(workspace, "nb-alias"), "junction")
  await Bun.write(
    path.join(workspace, "notebooks", "n.ipynb"),
    JSON.stringify({
      cells: [{ cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["print(1)"] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  )
  const spelled = "nb-alias/n.ipynb"
  await scripted(
    [
      { tool: { name: "Read", input: { file_path: spelled } } },
      {
        tool: {
          name: "NotebookEdit",
          input: { notebook_path: spelled, mode: "replace", cellId: "calc", source: "print(2)", link: "MODEL-ADDED-KEY" },
        },
      },
      "done",
    ],
    async (own, home) => {
      const run = controller(home, own)
      run.send({ type: "user", text: "edit the notebook" })
      const ask = await run.until((line) => line.type === "permission_request")
      run.send({ type: "permission_reply", requestID: ask.line.request.id, decision: "reject" })
      await run.until((line) => line.type === "result", ask.next)
      run.end()
      await run.finish()

      expect(ask.line.request.metadata.files[0].link).toEqual({
        place: path.join(workspace, "notebooks", "n.ipynb"),
        outside: false,
      })
      expect(JSON.stringify(ask.line)).not.toContain("MODEL-ADDED-KEY")
    },
  )
}, 240_000)

test("always saves the rule, so the same write asks nothing the second time", async () => {
  const name = "always.txt"
  await scripted([write(name), "first done", write(name), "second done"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "write it" })
    const ask = await run.until((line) => line.type === "permission_request")
    run.send({ type: "permission_reply", requestID: ask.line.request.id, decision: "always" })
    const first = await run.until((line) => line.type === "result", ask.next)
    run.send({ type: "user", text: "write it again" })
    await run.until((line) => line.type === "result", first.next)
    run.end()
    await run.finish()

    expect(run.lines.filter((line) => line.type === "permission_request")).toHaveLength(1)
    expect(results(run.lines).map((line) => line.result)).toEqual(["first done", "second done"])
  })
}, 240_000)

test("an interrupt during a model call gives an interrupted result and the next message still runs", async () => {
  await scripted([slow, "after"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "go" })
    await modelAsked(own, 1)
    run.send({ type: "interrupt" })
    const stopped = await run.until((line) => line.type === "result")
    run.send({ type: "user", text: "again" })
    await run.until((line) => line.type === "result", stopped.next)
    run.end()
    const done = await run.finish()

    expect(results(run.lines).map((line) => [line.outcome, line.subtype])).toEqual([
      ["interrupted", "interrupted"],
      ["succeeded", "success"],
    ])
    expect(results(run.lines)[1].result).toBe("after")
    expect(done.code).toBe(0)
  })
}, 240_000)

test("an interrupt while idle writes nothing, and the next message runs", async () => {
  await scripted(["ok"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "interrupt" })
    run.send({ type: "user", text: "go" })
    await run.until((line) => line.type === "result")
    run.end()
    const done = await run.finish()

    expect(results(run.lines)).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded" })
    expect(run.lines.filter((line) => line.type === "error")).toEqual([])
    expect(done.code).toBe(0)
  })
}, 240_000)

// A line that does not decode costs only itself, and says which field was at fault without quoting the line.
test.each([
  { name: "not JSON", line: "this is not json", path: [] },
  { name: "null", line: "null", path: [] },
  { name: "an array", line: "[1]", path: [] },
  { name: "a number", line: "7", path: [] },
  { name: "an unknown type", line: JSON.stringify({ type: "teleport" }), path: ["type"] },
  { name: "a missing type", line: JSON.stringify({ text: "x" }), path: ["type"] },
  { name: "a missing text", line: JSON.stringify({ type: "user" }), path: ["text"] },
  { name: "a bad delivery", line: JSON.stringify({ type: "user", text: "x", delivery: "now" }), path: ["delivery"] },
  { name: "a bad message id", line: JSON.stringify({ type: "user", text: "x", id: "nope" }), path: ["id"] },
  {
    name: "a bad request id",
    line: JSON.stringify({ type: "permission_reply", requestID: "x", decision: "once" }),
    path: ["requestID"],
  },
  { name: "a bad form id", line: JSON.stringify({ type: "form_cancel", formID: "x" }), path: ["formID"] },
  { name: "a bad model", line: JSON.stringify({ type: "set_model", model: "no-slash" }), path: ["model"] },
])(
  "$name gives one invalid_input error and the next valid message runs",
  async (row) => {
    await scripted(["fine"], async (own, home) => {
      const run = controller(home, own)
      run.send("\n   \n")
      run.send(row.line + "\n")
      const bad = await run.until((line) => line.type === "error")
      run.send({ type: "user", text: "go" })
      await run.until((line) => line.type === "result", bad.next)
      run.end()
      const done = await run.finish()

      expect(bad.line.error).toEqual({
        type: "invalid_input",
        message: expect.any(String),
        path: row.path,
        line: 1,
      })
      expect(JSON.stringify(bad.line)).not.toContain("teleport")
      expect(run.lines.filter((line) => line.type === "error")).toHaveLength(1)
      expect(results(run.lines)).toHaveLength(1)
      expect(done.code).toBe(0)
    })
  },
  240_000,
)

test("extra keys are ignored, a CRLF line and a first line with a byte-order mark decode", async () => {
  await scripted(["a", "b"], async (own, home) => {
    const run = controller(home, own)
    run.sendBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(`{"type":"user","text":"first","extra":1}\r\n`)]))
    const first = await run.until((line) => line.type === "result")
    run.send(JSON.stringify({ type: "user", text: "second" }) + "\r\n")
    await run.until((line) => line.type === "result", first.next)
    run.end()
    await run.finish()

    expect(run.lines.filter((line) => line.type === "error")).toEqual([])
    expect(own.steps.map((step) => step.user)).toEqual(["first", "second"])
  })
}, 240_000)

test("a final line without a newline is handled when the input ends", async () => {
  await scripted(["ok"], async (own, home) => {
    const run = controller(home, own)
    run.send(JSON.stringify({ type: "user", text: "last" }))
    run.end()
    const done = await run.finish()

    expect(results(run.lines)).toHaveLength(1)
    expect(own.steps.map((step) => step.user)).toEqual(["last"])
    expect(done.code).toBe(0)
  })
}, 240_000)

test("a multi-byte character split across two writes arrives intact", async () => {
  await scripted(["ok"], async (own, home) => {
    const bytes = Buffer.from(JSON.stringify({ type: "user", text: "snow ☃ and \u{1F680}" }) + "\n")
    const cut = bytes.indexOf(0xe2) + 1
    const run = controller(home, own)
    run.sendBytes(bytes.subarray(0, cut))
    await Bun.sleep(300)
    run.sendBytes(bytes.subarray(cut, cut + 6))
    await Bun.sleep(300)
    run.sendBytes(bytes.subarray(cut + 6))
    await run.until((line) => line.type === "result")
    run.end()
    await run.finish()

    expect(own.steps.map((step) => step.user)).toEqual(["snow ☃ and \u{1F680}"])
  })
}, 240_000)

test("a reply for a request that was never shown, or that was answered already, gets unknown_request and no server call", async () => {
  await scripted([write("unknown.txt"), "done"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "permission_reply", requestID: "per_neverseen", decision: "once" })
    const never = await run.until((line) => line.type === "error")
    run.send({ type: "user", text: "write it" })
    const ask = await run.until((line) => line.type === "permission_request", never.next)
    run.send({ type: "permission_reply", requestID: ask.line.request.id, decision: "reject", message: "no" })
    run.send({ type: "permission_reply", requestID: ask.line.request.id, decision: "once" })
    await run.until((line) => line.type === "result", ask.next)
    run.end()
    await run.finish()

    const errors = run.lines.filter((line) => line.type === "error")
    expect(errors.map((line) => line.error.type)).toEqual(["unknown_request", "unknown_request"])
    // The second reply was not sent to the server: the write stayed rejected.
    expect(await Bun.file(path.join(workspace, "unknown.txt")).exists()).toBe(false)
  })
}, 240_000)

test("an interrupt withdraws the ask that is open with request_cancelled", async () => {
  await scripted([write("cancelled.txt"), "done"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "write it" })
    const ask = await run.until((line) => line.type === "permission_request")
    run.send({ type: "interrupt" })
    await run.until((line) => line.type === "result", ask.next)
    run.end()
    await run.finish()

    expect(run.lines.find((line) => line.type === "request_cancelled")).toMatchObject({
      kind: "permission",
      id: ask.line.request.id,
    })
    expect(await Bun.file(path.join(workspace, "cancelled.txt")).exists()).toBe(false)
  })
}, 240_000)
