import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { DialogAgentCreate, type AgentCreateEnvironment } from "../../src/component/dialog-agent-create"
import { DialogAgentEdit } from "../../src/component/dialog-agent-edit"
import { Toast } from "../../src/ui/toast"
import { renderLocal } from "../fixture/local"

async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orbit-agent-create-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

function environment(dir: string, patch: Partial<AgentCreateEnvironment> = {}) {
  const notified: string[][] = []
  const opened: string[] = []
  const env: AgentCreateEnvironment & { onBack: () => void } = {
    taken: [{ id: "build" }, { id: "helper", scope: "user" }],
    configDirectory: (scope) => (scope === "project" ? path.join(dir, ".orbit") : path.join(dir, "user-config")),
    projectRoot: dir,
    trusted: true,
    notify: async (paths) => void notified.push(paths),
    open: async (file) => void opened.push(file),
    edit: async () => undefined,
    onBack: () => {},
    ...patch,
  }
  return { env, notified, opened }
}

const prompt = "You review a change and report what could break, in order of risk."

// A dialog paints before its deferred focus is ready for keys, so the frame is not enough to start typing.
async function until(setup: Awaited<ReturnType<typeof renderLocal>>, text: string) {
  const frame = await setup.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes(text))
  await Bun.sleep(60)
  return frame
}

/** The save is asynchronous and the renderer's own wait counts frames, not time. */
async function closed(setup: Awaited<ReturnType<typeof renderLocal>>) {
  for (let attempt = 0; attempt < 100 && setup.dialog.stack.length > 0; attempt++) await Bun.sleep(30)
  expect(setup.dialog.stack.length).toBe(0)
}

/** A toast comes after the asynchronous save, so the frame is polled for a while. */
async function toasted(setup: Awaited<ReturnType<typeof renderLocal>>, text: string) {
  let frame = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    await setup.renderOnce()
    frame = setup.captureCharFrame().replace(/\s+/g, " ")
    if (frame.includes(text)) return frame
    await Bun.sleep(30)
  }
  throw new Error(`No toast with ${text}:\n${frame}`)
}

/** Scope: project; the name, prompt and description typed; tools left as they are. */
async function fill(setup: Awaited<ReturnType<typeof renderLocal>>, input: { name: string; prompt?: string; description?: string }) {
  await until(setup, "where should it live")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: name")
  await setup.mockInput.typeText(input.name)
  setup.mockInput.pressEnter()
  await until(setup, "system prompt")
  await setup.mockInput.typeText(input.prompt ?? prompt)
  setup.mockInput.pressEnter()
  await until(setup, "when should it be used")
  await setup.mockInput.typeText(input.description ?? "Reviews a change before it ships")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: tools")
}

const arrow = (setup: Awaited<ReturnType<typeof renderLocal>>, direction: "up" | "down", times = 1) => {
  for (let index = 0; index < times; index++) setup.mockInput.pressArrow(direction)
}

test("a project agent is written with the chosen tools, model and permission mode, and the server is told its path", async () => {
  await using tmp = await project()
  await using setup = await renderLocal()
  const { env, notified, opened } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "reviewer" })

  // None, then the read-only group; Continue is the first row.
  arrow(setup, "down")
  setup.mockInput.pressEnter()
  arrow(setup, "down")
  setup.mockInput.pressEnter()
  arrow(setup, "up", 2)
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  arrow(setup, "down")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  arrow(setup, "down", 3)
  setup.mockInput.pressEnter()
  const review = await until(setup, "Create agent: review")
  expect(review).toContain("File:")
  expect(review).toContain("Save and open in your editor")
  setup.mockInput.pressEnter()
  await closed(setup)

  const file = path.join(tmp.dir, ".orbit", "agents", "reviewer.md")
  const parsed = ConfigMarkdown.parseOption(await readFile(file, "utf8"))!
  expect(parsed.data.description).toBe("Reviews a change before it ships")
  expect(parsed.data.model).toBe("small")
  expect(parsed.data.permission_mode).toBe("plan")
  expect(parsed.data.tools).toContain("Read")
  expect(parsed.data.tools).not.toContain("Edit")
  expect(parsed.data).not.toHaveProperty("name")
  expect(parsed.content.trim()).toBe(prompt)
  // The files were reported to the server, and nothing was opened.
  expect(notified).toEqual([[file]])
  expect(opened).toEqual([])
})

test("with every tool and the inherited model, those keys are left out; save and open opens the file", async () => {
  await using tmp = await project()
  await using setup = await renderLocal()
  const { env, notified, opened } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "all-rounder" })
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: review")
  arrow(setup, "down")
  setup.mockInput.pressEnter()
  await closed(setup)

  const file = path.join(tmp.dir, ".orbit", "agents", "all-rounder.md")
  expect(Object.keys(ConfigMarkdown.parseOption(await readFile(file, "utf8"))!.data)).toEqual(["description"])
  await Bun.sleep(50)
  expect(opened).toEqual([file])
  // Once after the write and once after the editor closed.
  expect(notified).toEqual([[file], [file]])
})

test("a description with a colon, a quote, a line break and --- adds no key", async () => {
  await using tmp = await project()
  const text = 'Use when: told to "review"'
  await using setup = await renderLocal()
  const { env } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "tricky", description: text })
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: review")
  setup.mockInput.pressEnter()
  await closed(setup)
  const parsed = ConfigMarkdown.parseOption(await readFile(path.join(tmp.dir, ".orbit", "agents", "tricky.md"), "utf8"))!
  expect(parsed.data).toEqual({ description: text })
})

test.each([
  ["ab", "at least 3"],
  ["-ab", "starting and ending"],
  ["ab-", "starting and ending"],
  ["a b", "starting and ending"],
  ["a".repeat(51), "at most 50"],
  ["con", "reserved"],
  ["NUL", "reserved"],
  ["com1", "reserved"],
  ["build", "exists"],
  ["Helper", "exists"],
])("the name %j is refused", async (name, why) => {
  await using tmp = await project()
  await using setup = await renderLocal()
  const { env } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await until(setup, "where should it live")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: name")
  await setup.mockInput.typeText(name)
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes(why))
  expect(frame).toContain("Create agent: name")
  expect(await readdir(tmp.dir)).toEqual([])
})

test("an error on the last step blocks the save, and a file that is there is not replaced", async () => {
  await using tmp = await project()
  await using setup = await renderLocal()
  const { env } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "terse", prompt: "Too short." })
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  const review = await until(setup, "Create agent: review")
  expect(review.replace(/\s+/g, " ")).toContain("needs at least 20 characters")
  expect(review).not.toContain("Save and open")
  expect(await readdir(tmp.dir)).toEqual([])

  // A warning does not: the same draft with a long enough prompt saves, and a second save finds the file.
  await using again = await renderLocal()
  await mkdir(path.join(tmp.dir, ".orbit", "agents"), { recursive: true })
  await writeFile(path.join(tmp.dir, ".orbit", "agents", "taken.md"), "mine")
  again.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(again, { name: "taken", description: "tiny" })
  again.mockInput.pressEnter()
  await until(again, "Create agent: model")
  again.mockInput.pressEnter()
  await until(again, "permission mode")
  again.mockInput.pressEnter()
  expect((await until(again, "Create agent: review")).replace(/\s+/g, " ")).toContain("The description is very short.")
  again.mockInput.pressEnter()
  await toasted(again, "already exists")
  expect(await readFile(path.join(tmp.dir, ".orbit", "agents", "taken.md"), "utf8")).toBe("mine")
})

test("a .orbit/agents that is a link out of the project writes nothing outside; a plain folder writes", async () => {
  await using tmp = await project()
  await using elsewhere = await project()
  await mkdir(path.join(tmp.dir, ".orbit"))
  const made = await symlink(
    elsewhere.dir,
    path.join(tmp.dir, ".orbit", "agents"),
    process.platform === "win32" ? "junction" : "dir",
  ).then(
    () => true,
    () => false,
  )
  if (!made) return
  await using setup = await renderLocal()
  const { env, notified } = environment(tmp.dir)
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "sneaky" })
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: review")
  setup.mockInput.pressEnter()
  await toasted(setup, "would be outside the")
  expect(await readdir(elsewhere.dir)).toEqual([])
  expect(notified).toEqual([])
})

test("an untrusted project is told what its file loses", async () => {
  await using tmp = await project()
  await using setup = await renderLocal()
  const { env } = environment(tmp.dir, { trusted: false })
  setup.dialog.replace(() => (
    <>
      <DialogAgentCreate {...env} />
      <Toast />
    </>
  ))
  await fill(setup, { name: "careful" })
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: model")
  setup.mockInput.pressEnter()
  await until(setup, "permission mode")
  setup.mockInput.pressEnter()
  expect((await until(setup, "Create agent: review")).replace(/\s+/g, " ")).toContain("withheld until it is")
})

test("escape steps back a step, and out of the first", async () => {
  await using tmp = await project()
  await using setup = await renderLocal()
  let left = false
  const { env } = environment(tmp.dir, { })
  setup.dialog.replace(() => <DialogAgentCreate {...env} onBack={() => (left = true)} />)
  await until(setup, "where should it live")
  setup.mockInput.pressEnter()
  await until(setup, "Create agent: name")
  setup.mockInput.pressEscape()
  await until(setup, "where should it live")
  setup.mockInput.pressEscape()
  await Bun.sleep(50)
  expect(left).toBe(true)
})

test("edit lists only the agents whose file is the person's, opens the one chosen and tells the server", async () => {
  await using setup = await renderLocal()
  const opened: string[] = []
  const notified: string[][] = []
  const at = (scope: string, file: string, plugin?: string) => ({ scope, path: file, plugin })
  setup.dialog.replace(() => (
    <DialogAgentEdit
      agents={[
        { id: "mine", source: at("user", "/home/me/agents/mine.md") },
        { id: "theirs", source: at("project", "/work/.orbit/agents/theirs.md") },
        { id: "org-wide", source: at("managed", "/etc/orbit/agents/org-wide.md") },
        { id: "from-plugin", source: at("project", "/work/plugin/agents/p.md", "plug") },
        { id: "build" },
        { id: "ev\u001b[2Jil", source: at("local", "/work/.orbit/agents/ev\u001b[31mil.md") },
      ]}
      open={async (file) => void opened.push(file)}
      notify={async (paths) => void notified.push(paths)}
      onBack={() => {}}
    />
  ))
  const frame = await until(setup, "Edit an agent file")
  expect(frame).toContain("mine")
  expect(frame).toContain("theirs")
  expect(frame).not.toContain("org-wide")
  expect(frame).not.toContain("from-plugin")
  expect(frame).not.toContain("build")
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)

  setup.mockInput.pressEnter()
  await Bun.sleep(100)
  expect(opened).toEqual(["/home/me/agents/mine.md"])
  expect(notified).toEqual([["/home/me/agents/mine.md"]])
})
