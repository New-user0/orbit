// `orb -p --input-format stream-json` against a real private server and a scripted model: questions, model changes,
// refused operations, the end of input, the exit status and the flags of the stream door. Every run is a child process
// of src/index.ts and has a deadline. The root and helpers are in fixture/stream-run.ts.
import { expect, test } from "bun:test"
import path from "node:path"
import { controller as start, modelAsked, results, scripted } from "../fixture/stream-controller"
import {
  workspace,
  controller,
  write,
  slow,
  question,
  spawnOrb,
} from "../fixture/stream-run"

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

test("a refused --mcp-config through the stream door writes one result line and exits 1", async () => {
  await scripted(["unused"], async (own, home) => {
    const file = path.join(home, "mcp.json")
    await Bun.write(file, JSON.stringify({ servers: { demo: { type: "local", command: ["demo"] } } }))
    const managed = path.join(home, "managed-only")
    await Bun.write(
      path.join(managed, "managed-settings.json"),
      JSON.stringify({ managed: { mcp: { managed_only: true } } }),
    )
    // One after the other: two private servers on one database start slowly and can lose to each other.
    const runs = [
      await spawnOrb(
        home,
        own,
        ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", file, "hello"],
        { ORBIT_MANAGED_DIR: managed },
      ),
      await spawnOrb(
        home,
        own,
        ["run", "--input-format", "stream-json", "--format", "stream-json", "--mcp-config", file, "hello"],
        { ORBIT_MANAGED_DIR: managed },
      ),
    ]
    runs.forEach((run) => {
      const lines = run.stdout
        .trim()
        .split("\n")
        .map((line) => {
          if (!line) throw new Error(`No output. stderr: ${run.stderr}`)
          return JSON.parse(line)
        })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ type: "result", is_error: true, outcome: "failed" })
      expect(lines[0].error).toContain("Managed settings run only the MCP servers they define")
      expect(run.code).toBe(1)
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

test.skipIf(process.platform === "win32")(
  "SIGINT gives an interrupted result and exit 130",
  async () => {
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
  },
  240_000,
)

test("a controller that stops reading standard output ends the run and interrupts what was running", async () => {
  await scripted([slow], async (own, home) => {
    const run = controller(home, own)
    run.send({ type: "user", text: "go" })
    await modelAsked(own, 1)
    await run.abandon()
    // The next line the child writes has nowhere to go. A hello from the model would do; an interrupt makes a result.
    run.send({ type: "interrupt" })
    const started = Date.now()
    const done = await run.finish(90_000)

    // The model call would take a minute; the run does not wait for it, because nobody can read what it would write.
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(typeof done.code).toBe("number")
    expect(own.steps).toHaveLength(1)
  })
}, 240_000)
