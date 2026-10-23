import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "../fixture/environment"
import { scriptedModel, type ScriptedReply, type ScriptedRequest } from "../fixture/scripted-model"
import { controller, results, type Line } from "../fixture/stream-controller"

// clients-ux-37: tool labels and prompt suggestions in `orb -p` and `orb run` with stream-json. Both are opt-in: a run
// asks the server for a label after each finished batch of tool calls only with --tool-labels, and for a suggestion
// after each result only with --prompt-suggestions. Every run is a child process of src/index.ts against a real private
// server and a scripted model, with a deadline.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-assist-")))
// A folder where the Read tool runs unasked, and one where a write asks, so a run can be interrupted at the ask.
const workspace = path.join(root, "workspace")
const asking = path.join(root, "asking")
const OUTPUT_MARK = "READ-OUTPUT-MARK"
const notes = path.join(workspace, "notes.txt")

beforeAll(async () => {
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(asking, { recursive: true })
  // The marker comes first, so it is inside the 300 characters of the output that a label request carries.
  await Bun.write(notes, `${OUTPUT_MARK}\n${"o".repeat(1000)}\n`)
  await Bun.write(path.join(asking, "orbit.json"), JSON.stringify({ permission: { edit: "ask" } }))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// A suggestion is a side query that sends the session's history, so it carries the session's tools with
// `tool_choice: "none"`; a label carries no tools, and only it holds the output of the batch it names.
const isSuggestion = (request: ScriptedRequest) => Boolean(request.body.tools) && request.body.tool_choice === "none"
const isLabel = (request: ScriptedRequest) =>
  !request.body.tools && JSON.stringify(request.body.messages).includes(OUTPUT_MARK)

type Answers = { label?: (count: number) => ScriptedReply; suggestion?: (count: number) => ScriptedReply }

async function scripted<T>(
  replies: ReadonlyArray<ScriptedReply>,
  answers: Answers,
  run: (own: ReturnType<typeof scriptedModel>, home: string) => Promise<T>,
) {
  const counts = { label: 0, suggestion: 0 }
  const own = scriptedModel(replies, undefined, undefined, [], (request) => {
    if (isSuggestion(request)) return answers.suggestion?.(++counts.suggestion)
    if (isLabel(request)) return answers.label?.(++counts.label)
    return undefined
  })
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-assist-own-")))
  await own.configure(home)
  try {
    return await run(own, home)
  } finally {
    await own.stop()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

const read = (chunks: string[] = []) => ({ chunks, tool: { name: "Read", input: { file_path: notes } } })
const of = (lines: Line[], type: string) => lines.filter((line) => line.type === type)
const indexOf = (lines: Line[], match: (line: Line) => boolean) => lines.findIndex(match)

const optIn = ["--tool-labels", "--prompt-suggestions"]

test("no flag, no call: without the flags no label or suggestion is asked for or written; with them both are (the control)", async () => {
  const replies = [read(), "first answer", "second answer"]
  const answers = { label: () => "Read the notes", suggestion: () => "run the tests" }
  for (const [args, expected] of [
    [optIn, true],
    [[], false],
  ] as const) {
    await scripted(replies, answers, async (own, home) => {
      const run = controller(home, own, { args: [...args], workspace })
      run.send({ type: "user", text: "one" })
      const first = await run.until((line) => line.type === "result")
      run.send({ type: "user", text: "two" })
      await run.until((line) => line.type === "result", first.next)
      // The control waits for its suggestion line; the run without flags has nothing to wait for.
      if (expected) await run.until((line) => line.type === "prompt_suggestion", first.next)
      run.end()
      const done = await run.finish()

      expect(done.code).toBe(0)
      expect(results(run.lines)).toHaveLength(2)
      expect({ args, labels: of(run.lines, "tool_label").length > 0 }).toEqual({ args, labels: expected })
      expect({ args, suggestions: of(run.lines, "prompt_suggestion").length > 0 }).toEqual({
        args,
        suggestions: expected,
      })
      expect({ args, asked: own.requests.some(isLabel) }).toEqual({ args, asked: expected })
      expect({ args, asked: own.requests.some(isSuggestion) }).toEqual({ args, asked: expected })
    })
  }
}, 240_000)

test.each([
  { door: "orb -p", print: true },
  { door: "orb run", print: false },
])(
  "$door --tool-labels writes one tool_label line for a finished batch, before its result, from a request that carries the batch",
  async (row) => {
    // The intent is the text before the call, cut to 200 characters: the J's after the first 39 never reach the model.
    const intent = `${"I".repeat(150)}INTENT-MARK${"J".repeat(300)}`
    await scripted([read([intent]), "done"], { label: () => "Read the notes" }, async (own, home) => {
      const run = controller(home, own, { args: ["--tool-labels"], workspace, print: row.print })
      run.send({ type: "user", text: "read the notes" })
      await run.until((line) => line.type === "result")
      run.end()
      const done = await run.finish()

      expect(done.code).toBe(0)
      const tool = of(run.lines, "tool_use")[0]
      const labels = of(run.lines, "tool_label")
      expect(labels).toEqual([
        {
          type: "tool_label",
          timestamp: expect.any(Number),
          sessionID: run.lines[0].sessionID,
          messageID: tool.part.messageID,
          toolIDs: [tool.part.id],
          label: "Read the notes",
        },
      ])
      expect(indexOf(run.lines, (line) => line.type === "tool_label")).toBeLessThan(
        indexOf(run.lines, (line) => line.type === "result"),
      )
      // One request, with no tools and no history: the tool's name, its input and its output cut to 300 characters
      // (the file holds 1000 o's), and the assistant's text before the call as the intent.
      const asked = own.requests.filter(isLabel)
      expect(asked).toHaveLength(1)
      const body = JSON.stringify(asked[0].body.messages)
      expect(body).toContain("Read")
      expect(body).toContain("notes.txt")
      expect(body).toContain("...")
      expect(body).not.toContain("o".repeat(400))
      expect(body).toContain(`${"I".repeat(150)}INTENT-MARK${"J".repeat(39)}`)
      expect(body).not.toContain("J".repeat(40))
      expect(body).not.toContain("read the notes")
      // Suggestions were not asked for.
      expect(own.requests.some(isSuggestion)).toBe(false)
      expect(of(run.lines, "prompt_suggestion")).toEqual([])
    })
  },
  240_000,
)

test("--prompt-suggestions writes a prompt_suggestion line after the result, from the second assistant message on, from the session's model and history", async () => {
  await scripted(["first answer", "second answer"], { suggestion: () => "run the tests" }, async (own, home) => {
    const run = controller(home, own, { args: ["--prompt-suggestions"], workspace })
    run.send({ type: "user", text: "first line" })
    const first = await run.until((line) => line.type === "result")
    run.send({ type: "user", text: "second line" })
    const second = await run.until((line) => line.type === "result", first.next)
    const suggestion = await run.until((line) => line.type === "prompt_suggestion", second.next)
    run.end()
    const done = await run.finish()

    expect(done.code).toBe(0)
    expect(suggestion.line).toEqual({
      type: "prompt_suggestion",
      timestamp: expect.any(Number),
      sessionID: run.lines[0].sessionID,
      suggestion: "run the tests",
    })
    // After the first result the session held one assistant message, too early for a suggestion: the model was asked
    // once, after the second, with the session's model and both user lines.
    expect(of(run.lines, "prompt_suggestion")).toHaveLength(1)
    const asked = own.requests.filter(isSuggestion)
    expect(asked).toHaveLength(1)
    expect(asked[0].body.model).toBe("scripted:1b")
    const history = JSON.stringify(asked[0].body.messages)
    expect(history).toContain("first line")
    expect(history).toContain("second line")
    expect(history).toContain("second answer")
    // Labels were not asked for.
    expect(of(run.lines, "tool_label")).toEqual([])
  })
}, 240_000)

test("label and suggestion text reaches the output with its control and format characters written out (class 9)", async () => {
  const label = "Read\u001b]0;owned\u0007 notes‮"
  const suggestion = "run the \u001b[2Jtests‮ now"
  await scripted([read(), "done"], { label: () => label, suggestion: () => suggestion }, async (own, home) => {
    const run = controller(home, own, { args: optIn, workspace })
    run.send({ type: "user", text: "read the notes" })
    const result = await run.until((line) => line.type === "result")
    await run.until((line) => line.type === "prompt_suggestion", result.next)
    run.end()
    await run.finish()

    expect(of(run.lines, "tool_label").map((line) => line.label)).toEqual([label])
    expect(of(run.lines, "prompt_suggestion").map((line) => line.suggestion)).toEqual([suggestion])
    const printed = run.raw.filter((line) => line.includes('"tool_label"') || line.includes('"prompt_suggestion"'))
    expect(printed).toHaveLength(2)
    for (const line of printed) expect(line).not.toMatch(/[\u001b\u0007‮]/)
  })
}, 240_000)

test("a suggestion the filters drop writes no line, though the model was asked", async () => {
  await scripted([read(), "done"], { suggestion: () => "Looks good, thanks!" }, async (own, home) => {
    const run = controller(home, own, { args: ["--prompt-suggestions"], workspace })
    run.send({ type: "user", text: "read the notes" })
    await run.until((line) => line.type === "result")
    run.end()
    const done = await run.finish()

    expect(done.code).toBe(0)
    expect(own.requests.filter(isSuggestion)).toHaveLength(1)
    expect(of(run.lines, "prompt_suggestion")).toEqual([])
  })
}, 240_000)

test("a new user line drops the suggestion in flight, and the next result gets its own", async () => {
  const answers = {
    suggestion: (count: number) =>
      count === 1 ? { chunks: ["stale suggestion here"], delayMs: 4_000 } : "fresh suggestion here",
  }
  await scripted([read(), "first answer", "second answer"], answers, async (own, home) => {
    const run = controller(home, own, { args: ["--prompt-suggestions"], workspace })
    run.send({ type: "user", text: "one" })
    const first = await run.until((line) => line.type === "result")
    // Sent while the first suggestion is still being written.
    run.send({ type: "user", text: "two" })
    const second = await run.until((line) => line.type === "result", first.next)
    await run.until((line) => line.type === "prompt_suggestion", second.next)
    // Long enough for the stale answer to have arrived, had it not been dropped.
    await Bun.sleep(5_000)
    run.end()
    await run.finish()

    expect(of(run.lines, "prompt_suggestion").map((line) => line.suggestion)).toEqual(["fresh suggestion here"])
    expect(indexOf(run.lines, (line) => line.type === "prompt_suggestion")).toBeGreaterThan(second.next - 1)
  })
}, 240_000)

test("the end of the input waits for the suggestion in flight before the run exits", async () => {
  await scripted(
    [read(), "done"],
    { suggestion: () => ({ chunks: ["commit this"], delayMs: 1_500 }) },
    async (own, home) => {
      const run = controller(home, own, { args: ["--prompt-suggestions"], workspace })
      run.send({ type: "user", text: "read the notes" })
      await run.until((line) => line.type === "result")
      run.end()
      const done = await run.finish()

      expect(done.code).toBe(0)
      expect(run.lines.at(-1)).toMatchObject({ type: "prompt_suggestion", suggestion: "commit this" })
    },
  )
}, 240_000)

// A batch the controller interrupts gets no label, as in the reference; the control replies to the same ask.
test.each([
  { settle: "permission_reply", labelled: true },
  { settle: "interrupt", labelled: false },
])(
  "a batch settled by $settle gets a label: $labelled",
  async (row) => {
    const write = { tool: { name: "Write", input: { file_path: path.join(asking, "out.txt"), content: OUTPUT_MARK } } }
    await scripted([write, "done"], { label: () => "Wrote out.txt" }, async (own, home) => {
      const run = controller(home, own, { args: ["--tool-labels"], workspace: asking })
      run.send({ type: "user", text: "write it" })
      const ask = await run.until((line) => line.type === "permission_request")
      run.send(
        row.settle === "interrupt"
          ? { type: "interrupt" }
          : { type: "permission_reply", requestID: ask.line.request.id, decision: "once" },
      )
      await run.until((line) => line.type === "result", ask.next)
      run.end()
      await run.finish()

      expect(of(run.lines, "tool_label").map((line) => line.label)).toEqual(row.labelled ? ["Wrote out.txt"] : [])
      expect(
        own.requests.some((request) => !request.body.tools && JSON.stringify(request.body).includes("out.txt")),
      ).toBe(row.labelled)
    })
  },
  240_000,
)

// Each flag needs the stream it writes to: a label is a line of stream-json output, and a suggestion is only of use to
// a program that sends the next message as a stream-json line. A refused run asks the model nothing.
test.each([
  { args: ["-p", "--tool-labels", "hi"], message: "--tool-labels requires --output-format stream-json" },
  {
    args: ["-p", "--output-format", "json", "--tool-labels", "hi"],
    message: "--tool-labels requires --output-format stream-json",
  },
  {
    args: ["-p", "--output-format", "stream-json", "--prompt-suggestions", "hi"],
    message: "--prompt-suggestions requires --input-format stream-json",
  },
  { args: ["run", "--format", "json", "--tool-labels", "hi"], message: "--tool-labels requires --format stream-json" },
  {
    args: ["run", "--format", "stream-json", "--prompt-suggestions", "hi"],
    message: "--prompt-suggestions requires --input-format stream-json",
  },
])(
  "$args is a usage error: $message",
  async (row) => {
    await scripted(["ok"], {}, async (own, home) => {
      const child = Bun.spawn(
        [process.execPath, "run", "src/index.ts", ...row.args.slice(0, -1), "--standalone", "--model", own.model, "hi"],
        {
          cwd: path.join(import.meta.dir, "..", ".."),
          env: isolatedEnv(home, { USERPROFILE: home, PWD: workspace, ORBIT_CONFIG: undefined }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const code = await Promise.race([
        child.exited,
        Bun.sleep(60_000).then(() => {
          child.kill()
          throw new Error("The run did not exit")
        }),
      ])
      const stderr = await new Response(child.stderr).text()

      expect(code).toBe(1)
      expect(stderr).toContain(row.message)
      expect(own.requests).toEqual([])
    })
  },
  120_000,
)
