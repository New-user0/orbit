import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { allTools, check, create, nameProblem, render, toolGroups, type AgentDraft } from "../../src/util/agent-file"

async function folder() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orbit-agent-file-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

const draft = (patch: Partial<AgentDraft> = {}): AgentDraft => ({
  scope: "project",
  name: "reviewer",
  description: "Reviews a change before it ships",
  prompt: "You review changes and report what could break, in order of risk.",
  tools: ["Read", "Grep"],
  model: "small",
  permissionMode: "plan",
  ...patch,
})

const parsed = (text: string) => ConfigMarkdown.parseOption(text)

test("the file parses back to the chosen values, carries no name, and keeps the prompt as the body", () => {
  const result = parsed(render(draft()))!
  expect(result.data).toEqual({
    description: "Reviews a change before it ships",
    tools: ["Read", "Grep"],
    model: "small",
    permission_mode: "plan",
  })
  expect(result.content.trim()).toBe("You review changes and report what could break, in order of risk.")
})

test("all tools omits tools, and inherit omits model", () => {
  const result = parsed(render(draft({ tools: undefined, model: "inherit", permissionMode: undefined })))!
  expect(Object.keys(result.data)).toEqual(["description"])
})

test("no tools is written as an empty list", () => {
  expect(parsed(render(draft({ tools: [] })))!.data.tools).toEqual([])
})

test.each([
  ["a colon and a quote", 'Use when: the user says "review"'],
  ["a line break", "first line\nsecond: line\n---\nname: injected"],
  ["a closing delimiter", "---\nmodel: large\n---"],
  ["a backslash", "C:\\temp\\x"],
  ["YAML line separators", "a\u0085b\u2028c\u2029d"],
  ["a leading hash and a dash", "- # not a comment"],
])("a description with %s round-trips and adds no key", (_name, description) => {
  const result = parsed(render(draft({ description, tools: undefined, model: "inherit", permissionMode: undefined })))!
  expect(result.data).toEqual({ description })
  expect(result.content.trim()).toBe("You review changes and report what could break, in order of risk.")
})

test.each(["ab", "-ab", "ab-", "a b", "a".repeat(51), "con", "NUL", "com1", "a/b", "a.b", "..", "ab\u001b"])(
  "%j is not a name",
  (value) => {
    expect(nameProblem(value)).toBeDefined()
  },
)

test.each(["abc", "code-reviewer", "A1b", "a".repeat(50)])("%j is a name", (value) => {
  expect(nameProblem(value)).toBeUndefined()
})

test("a name that any agent has is an error that names where it is from, whatever the case", () => {
  expect(check(draft({ name: "Build" }), [{ id: "build" }]).errors.join()).toContain("built in")
  expect(check(draft(), [{ id: "reviewer", scope: "user" }]).errors.join()).toContain("user scope")
})

test("errors block and warnings do not", () => {
  const empty = check(draft({ description: "", prompt: "short" }), [])
  expect(empty.errors).toEqual(["The description is missing.", "The system prompt needs at least 20 characters."])
  const cautions = check(draft({ description: "tiny", tools: [] }), [])
  expect(cautions.errors).toEqual([])
  expect(cautions.warnings.length).toBe(2)
  expect(check(draft({ tools: undefined }), []).warnings).toEqual(["The agent gets every tool."])
  expect(check(draft({ tools: ["Nonsense"] }), []).errors.join()).toContain("Nonsense")
})

test("the tool groups hold every built-in tool once", () => {
  expect(toolGroups.flatMap((group) => group.tools as string[]).toSorted()).toEqual(allTools.toSorted())
})

test("a project agent is written under .orbit/agents and the folder is made", async () => {
  await using tmp = await folder()
  const config = path.join(tmp.dir, ".orbit")
  const result = await create({ configDirectory: config, root: tmp.dir, draft: draft() })
  expect(result).toEqual({ type: "created", file: path.join(config, "agents", "reviewer.md") })
  expect(parsed(await readFile((result as { file: string }).file, "utf8"))!.data.description).toBe(
    "Reviews a change before it ships",
  )
})

test("an existing file is never overwritten", async () => {
  await using tmp = await folder()
  const config = path.join(tmp.dir, ".orbit")
  await mkdir(path.join(config, "agents"), { recursive: true })
  const file = path.join(config, "agents", "reviewer.md")
  await writeFile(file, "mine")
  expect(await create({ configDirectory: config, root: tmp.dir, draft: draft() })).toEqual({ type: "exists", file })
  expect(await readFile(file, "utf8")).toBe("mine")
})

test("a link out of the project is refused and nothing is written there", async () => {
  await using tmp = await folder()
  await using elsewhere = await folder()
  const project = path.join(tmp.dir, "project")
  await mkdir(path.join(project, ".orbit"), { recursive: true })
  // A junction on Windows needs no privilege; a directory link elsewhere.
  const made = await symlink(elsewhere.dir, path.join(project, ".orbit", "agents"), process.platform === "win32" ? "junction" : "dir").then(
    () => true,
    () => false,
  )
  if (!made) return
  const result = await create({ configDirectory: path.join(project, ".orbit"), root: project, draft: draft() })
  expect(result.type).toBe("escapes")
  expect(await readdir(elsewhere.dir)).toEqual([])
})

test("a .orbit that is a link out of the project is refused too, before anything is made", async () => {
  await using tmp = await folder()
  await using elsewhere = await folder()
  const project = path.join(tmp.dir, "project")
  await mkdir(project)
  const made = await symlink(elsewhere.dir, path.join(project, ".orbit"), process.platform === "win32" ? "junction" : "dir").then(
    () => true,
    () => false,
  )
  if (!made) return
  const result = await create({ configDirectory: path.join(project, ".orbit"), root: project, draft: draft() })
  expect(result.type).toBe("escapes")
  expect(await readdir(elsewhere.dir)).toEqual([])
})

test("the user's own config directory has no project to stay in", async () => {
  await using tmp = await folder()
  const config = path.join(tmp.dir, "config")
  const result = await create({ configDirectory: config, draft: draft({ scope: "user" }) })
  expect(result.type).toBe("created")
})

test("a name that is not valid is refused by the writer too", async () => {
  await using tmp = await folder()
  const result = await create({ configDirectory: path.join(tmp.dir, ".orbit"), root: tmp.dir, draft: draft({ name: "../x" }) })
  expect(result.type).toBe("failed")
  expect(await readdir(tmp.dir)).toEqual([])
})
