import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { controller as start, modelAsked, results, scripted, type Line } from "../fixture/stream-controller"

// `orb -p --input-format stream-json` against a real private server and a scripted model. Every run is a child process
// of src/index.ts and has a deadline, so a hang fails the test instead of blocking the runner.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-")))
const workspace = path.join(root, "workspace")

beforeAll(async () => {
  await fs.mkdir(workspace, { recursive: true })
  // Writes ask, so a run has something for the controller to decide.
  await Bun.write(path.join(workspace, "orbit.json"), JSON.stringify({ permission: { edit: "ask" } }))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const controller = (home: string, own: Parameters<typeof start>[1], args: string[] = []) =>
  start(home, own, { args, workspace })

const write = (name: string, extra: Record<string, unknown> = {}) => ({
  tool: { name: "Write", input: { file_path: path.join(workspace, name), content: "written", ...extra } },
})

const slow = { chunks: ["slow"], delayMs: 60_000 }

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
      expect(ask.line.request).toMatchObject({ action: "Edit", source: { type: "tool" }, metadata: { files: [{ status: "added" }] } })
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

const question = {
  tool: {
    name: "AskUserQuestion",
    input: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Alpha", description: "a" }] }] },
  },
}

test("a question is a form_request, and form_reply answers it", async () => {
  await scripted([question, "thanks"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "ask me" })
    const form = await run.until((line) => line.type === "form_request")
    run.send({ type: "form_reply", formID: form.line.form.id, answer: { q0: "Alpha" } })
    await run.until((line) => line.type === "result", form.next)
    run.end()
    await run.finish()

    expect(form.line.form).toMatchObject({ metadata: { kind: "question" } })
    expect(JSON.stringify(own.steps.at(-1)?.body.messages)).toContain("Alpha")
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded", result: "thanks" })
  })
}, 240_000)

test("form_cancel with a message lets the model carry on", async () => {
  await scripted([question, "thanks"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "ask me" })
    const form = await run.until((line) => line.type === "form_request")
    run.send({ type: "form_cancel", formID: form.line.form.id, message: "ask me later instead" })
    await run.until((line) => line.type === "result", form.next)
    run.end()
    await run.finish()

    expect(JSON.stringify(own.steps.at(-1)?.body.messages)).toContain("ask me later instead")
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded", result: "thanks" })
  })
}, 240_000)

test("set_model changes the model of the next step", async () => {
  await scripted(
    ["one", "two", "three"],
    async (own, home) => {
      const run = controller(home, own)
      run.send({ type: "set_model", model: "ollama/scripted:2b" })
      run.send({ type: "user", text: "first" })
      const first = await run.until((line) => line.type === "result")
      run.send({ type: "set_model", model: own.model })
      run.send({ type: "user", text: "second" })
      await run.until((line) => line.type === "result", first.next)
      run.end()
      const done = await run.finish()

      expect(run.lines.filter((line) => line.type === "error")).toEqual([])
      expect(own.steps.map((step) => step.body.model)).toEqual(["scripted:2b", "scripted:1b"])
      expect(done.code).toBe(0)
    },
    ["scripted:2b"],
  )
}, 240_000)

test("an operation the server refuses costs only itself, and the request stays open", async () => {
  await scripted([question, "thanks"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "ask me" })
    const form = await run.until((line) => line.type === "form_request")
    run.send({ type: "form_reply", formID: form.line.form.id, answer: { q0: 5 } })
    const failed = await run.until((line) => line.type === "error", form.next)
    run.send({ type: "form_reply", formID: form.line.form.id, answer: { q0: "Alpha" } })
    await run.until((line) => line.type === "result", failed.next)
    run.end()
    const done = await run.finish()

    expect(failed.line.error).toMatchObject({ type: "input_failed", input: "form_reply" })
    expect(run.lines.filter((line) => line.type === "error")).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded", result: "thanks" })
    expect(done.code).toBe(0)
  })
}, 240_000)

// Both are sent while the first message's model call is in flight.
test.each([
  { delivery: "steer", answers: ["a\n\nb"] },
  { delivery: "queue", answers: ["a", "b"] },
] as const)(
  "a $delivery message sent during a run gives $answers.length result line(s)",
  async (row) => {
    await scripted([{ chunks: ["a"], delayMs: 4_000 }, "b", "c"], async (own, home) => {
      const run = controller(home, own)
      run.send({ type: "user", text: "first" })
      await modelAsked(own, 1)
      run.send({ type: "user", text: "second", delivery: row.delivery })
      run.end()
      const done = await run.finish()

      expect(results(run.lines).map((line) => line.result)).toEqual([...row.answers])
      expect(own.steps.map((step) => step.user)).toEqual(["first", "second"])
      expect(done.code).toBe(0)
    })
  },
  240_000,
)

test("the same user id is admitted once", async () => {
  await scripted(["only", "never"], async (own, home) => {
    const run = controller(home, own)
    const message = { type: "user", text: "once", id: "msg_clientchosen0001" }
    run.send(message)
    const first = await run.until((line) => line.type === "result")
    run.send(message)
    run.end()
    const done = await run.finish()

    expect(first.line).toMatchObject({ outcome: "succeeded", result: "only" })
    expect(results(run.lines)).toHaveLength(1)
    expect(own.steps).toHaveLength(1)
    expect(done.code).toBe(0)
  })
}, 240_000)

test("end of input with nothing sent exits 0 without a result", async () => {
  await scripted(["unused"], async (own, home) => {
    const run = controller(home, own)
    run.end()
    const done = await run.finish()

    expect(run.lines).toHaveLength(1)
    expect(run.lines[0]).toMatchObject({ type: "init" })
    expect(done.code).toBe(0)
    expect(own.steps).toHaveLength(0)
  })
}, 240_000)

test("a positional message is the first input, and the run ends with its result when the input closes", async () => {
  await scripted(["from the command line"], async (own, home) => {
    const run = controller(home, own, ["say hi"])
    run.end()
    const done = await run.finish()

    expect(results(run.lines)).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ result: "from the command line" })
    expect(own.steps.map((step) => step.user)).toEqual(["say hi"])
    expect(done.code).toBe(0)
  })
}, 240_000)

test("end of input while an ask is open rejects it with feedback, and later asks are settled unseen", async () => {
  await scripted([write("eof-one.txt"), write("eof-two.txt"), "carried on"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "write both" })
    await run.until((line) => line.type === "permission_request")
    run.end()
    const done = await run.finish()

    expect(run.lines.filter((line) => line.type === "permission_request")).toHaveLength(1)
    expect(results(run.lines)).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded", result: "carried on" })
    expect(results(run.lines)[0].rejected.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(own.steps[1].body.messages)).toContain("closed its input")
    expect(await Bun.file(path.join(workspace, "eof-one.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(workspace, "eof-two.txt")).exists()).toBe(false)
    expect(done.code).toBe(0)
  })
}, 240_000)

test("end of input while a question is open cancels it", async () => {
  await scripted([question, "no answer needed"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "ask me" })
    await run.until((line) => line.type === "form_request")
    run.end()
    const done = await run.finish()

    expect(JSON.stringify(own.steps.at(-1)?.body.messages)).toContain("closed its input")
    expect(results(run.lines)[0]).toMatchObject({ outcome: "succeeded", result: "no answer needed" })
    expect(done.code).toBe(0)
  })
}, 240_000)

test("end stops what is running and exits after the result", async () => {
  await scripted([slow], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "go" })
    await modelAsked(own, 1)
    run.send({ type: "end" })
    const done = await run.finish()

    expect(results(run.lines)).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ outcome: "interrupted" })
    expect(done.code).toBe(1)
  })
}, 240_000)

test("the exit status follows the last result", async () => {
  const failing = { chunks: ["blocked"], finish: "content_filter" }
  await scripted([failing, "fine"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "one" })
    const first = await run.until((line) => line.type === "result")
    run.send({ type: "user", text: "two" })
    await run.until((line) => line.type === "result", first.next)
    run.end()
    const done = await run.finish()

    expect(results(run.lines).map((line) => line.is_error)).toEqual([true, false])
    expect(done.code).toBe(0)
  })
  await scripted(["fine", failing], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "one" })
    const first = await run.until((line) => line.type === "result")
    run.send({ type: "user", text: "two" })
    await run.until((line) => line.type === "result", first.next)
    run.end()
    const done = await run.finish()

    expect(results(run.lines).map((line) => line.is_error)).toEqual([false, true])
    expect(done.code).toBe(1)
  })
}, 240_000)

test("every line on standard output is one JSON object, with no raw separator inside", async () => {
  const hostile = "evil\u001b]0;pwned\u0007\u009b31m   ‮"
  await scripted([{ tool: { name: hostile, input: {} } }, "done"], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "go" })
    run.send("{broken\n")
    await run.until((line) => line.type === "result")
    run.end()
    await run.finish()

    // `raw` holds the lines as written; the controller helper parsed each one, so a stray write would have thrown.
    run.raw.forEach((line) => expect(/[\p{C}\p{Zl}\p{Zp}]/u.test(line)).toBe(false))
    expect(run.raw.some((line) => line.includes("evil"))).toBe(true)
  })
}, 240_000)

test("a data URL attachment reaches the model, and a bad one costs only itself", async () => {
  await scripted(["seen"], async (own, home) => {
    const run = controller(home, own)
    const data = `data:text/plain;base64,${Buffer.from("ATTACHED-MARKER").toString("base64")}`
    run.send({ type: "user", text: "look", files: ["not-base64:data"] })
    const bad = await run.until((line) => line.type === "error")
    run.send({ type: "user", text: "look", files: [data] })
    await run.until((line) => line.type === "result", bad.next)
    run.end()
    await run.finish()

    expect(bad.line.error).toMatchObject({ type: "input_failed", input: "user" })
    expect(own.steps).toHaveLength(1)
    expect(own.steps[0].user).toContain("ATTACHED-MARKER")
  })
}, 240_000)

test("--yolo approves the ask without showing it to the controller", async () => {
  await scripted([write("yolo.txt"), "done"], async (own, home) => {
    const run = controller(home, own, ["--yolo"])
    run.send({ type: "user", text: "write it" })
    await run.until((line) => line.type === "result")
    run.end()
    await run.finish()

    expect(run.lines.filter((line) => line.type === "permission_request")).toEqual([])
    expect(await Bun.file(path.join(workspace, "yolo.txt")).exists()).toBe(true)
  })
}, 240_000)

test("orb run takes the same protocol", async () => {
  await scripted(["via run"], async (own, home) => {
    const run = start(home, own, { workspace, print: false })
    run.send({ type: "user", text: "go" })
    await run.until((line) => line.type === "result")
    run.end()
    const done = await run.finish()

    expect(run.lines[0]).toMatchObject({ type: "init", protocol: 1 })
    expect(results(run.lines)[0]).toMatchObject({ result: "via run" })
    expect(done.code).toBe(0)
  })
}, 240_000)

test("--input-format stream-json needs stream-json output, and starts no server", async () => {
  await scripted(["unused"], async (own, home) => {
    const runs = await Promise.all(
      [
        [["-p", "--input-format", "stream-json", "hello"], "--output-format stream-json"],
        [["-p", "--input-format", "stream-json", "--output-format", "json", "hello"], "--output-format stream-json"],
        [["run", "--input-format", "stream-json", "hello"], "--format stream-json"],
        [["run", "--input-format", "stream-json", "--format", "json", "hello"], "--format stream-json"],
      ].map(async ([args, needs]) => ({ needs, run: await spawnOrb(home, own, args as string[]) })),
    )

    runs.forEach(({ run, needs }) => {
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(`--input-format stream-json requires ${needs}`)
      expect(run.stdout).toBe("")
    })
    expect(own.requests).toHaveLength(0)
  })
}, 240_000)

test("--file with stream input needs a message", async () => {
  await scripted(["unused"], async (own, home) => {
    const run = await spawnOrb(home, own, [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--file",
      "a.txt",
    ])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("--file needs a message")
  })
}, 240_000)

test.skipIf(process.platform === "win32")("SIGINT gives an interrupted result and exit 130", async () => {
  await scripted([slow], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "go" })
    await modelAsked(own, 1)
    run.child.kill("SIGINT")
    const done = await run.finish()

    expect(results(run.lines)).toHaveLength(1)
    expect(results(run.lines)[0]).toMatchObject({ outcome: "interrupted" })
    expect(done.code).toBe(130)
  })
}, 240_000)

// `orb` with its standard input closed, for the checks that end before any input is read.
async function spawnOrb(home: string, own: { model: string }, args: string[]) {
  const { isolatedEnv } = await import("../fixture/environment")
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args.slice(0, 1), "--standalone", "--model", own.model, ...args.slice(1)], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: isolatedEnv(home, { USERPROFILE: home, PWD: workspace, ORBIT_CONFIG: undefined, ORBIT_CONFIG_CONTENT: undefined }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

export type { Line }
