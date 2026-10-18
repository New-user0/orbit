import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SystemPart } from "@orbit/ai"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { OptimizePlugin } from "@orbit/core/plugin/optimize"
import { OutputStylePlugin } from "@orbit/core/plugin/output-style"
import { PromptConfigPlugin } from "@orbit/core/plugin/prompt-config"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { SessionInbox } from "@orbit/core/session/inbox"
import { IdentityPlugin } from "@orbit/core/plugin/identity"
import { ShellSelect } from "@orbit/core/shell/select"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect, Layer, Logger, Schema } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { Location } from "@orbit/core/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const base = SessionSystemPrompt.make(["Bash"])
const decode = Schema.decodeUnknownSync(Info)
const document = (info: unknown) => new Document({ type: "document", info: decode(info) })
const tool = { description: "tool", input: { type: "object" as const } }

const context = (
  options: { tools?: string[]; agent?: string; model?: string; text?: string; sessionID?: Session.ID } = {},
): SessionHooks["context"] => ({
  sessionID: options.sessionID ?? Session.ID.make("ses_prompt_config"),
  agent: Agent.ID.make(options.agent ?? "build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(options.model ?? "model") }),
  system: [SystemPart.make(options.text ?? base)],
  messages: [],
  tools: Object.fromEntries((options.tools ?? ["Bash"]).map((name) => [name, tool])),
  options: {},
})

// `system[0]` of one request for the given config, with the plugin active over the test config service.
const request = (
  entries: Entry[],
  options: Parameters<typeof context>[0] = {},
  kind: "context" | "compaction" | "generate" = "context",
) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const config = yield* Config.Test
    yield* config.setEntries(entries)
    const event = context(options)
    yield* hooks.trigger("session", kind, event as never)
    return event.system[0]?.text ?? ""
  })

const activate = Effect.gen(function* () {
  yield* PromptConfigPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
})

const gitOf = (text: string) => text.slice(text.indexOf(SessionSystemPrompt.GIT_HEADING))
const defaults = { commit: "Assisted-by: Orbit", pr: "Created with Orbit" }
const noTrailer = "Add no attribution trailer to commit messages"
const noFooter = "Add no attribution footer to pull request descriptions"

describe("PromptConfigPlugin", () => {
  it.effect("ends system[0] with the git section and both default lines when the shell tool is offered", () =>
    Effect.gen(function* () {
      yield* activate
      const text = yield* request([])
      expect(text).toBe(`${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`)
      expect(text).toContain("    Assisted-by: Orbit")
      expect(text).toContain("    Created with Orbit")
    }),
  )

  it.effect("adds no section when the shell tool is not offered", () =>
    Effect.gen(function* () {
      yield* activate
      expect(yield* request([], { tools: ["Read"] })).toBe(base)
    }),
  )

  it.effect("renders an explicit no-trailer line for an empty commit value and keeps the pr default", () =>
    Effect.gen(function* () {
      yield* activate
      const git = gitOf(yield* request([document({ attribution: { commit: "" } })]))
      expect(git).toContain(noTrailer)
      expect(git).not.toContain("Assisted-by: Orbit")
      expect(git).toContain("    Created with Orbit")
    }),
  )

  it.effect("renders an explicit no-footer line for an empty pr value and keeps the commit default", () =>
    Effect.gen(function* () {
      yield* activate
      const git = gitOf(yield* request([document({ attribution: { pr: "" } })]))
      expect(git).toContain(noFooter)
      expect(git).not.toContain("Created with Orbit")
      expect(git).toContain("    Assisted-by: Orbit")
    }),
  )

  it.effect("renders custom values in full, a multi-line one line for line, and keeps whitespace as given", () =>
    Effect.gen(function* () {
      yield* activate
      const git = gitOf(
        yield* request([
          document({ attribution: { commit: "Co-authored-by: A <a@x.test>\nSigned-off-by: B", pr: "  " } }),
        ]),
      )
      expect(git).toContain("    Co-authored-by: A <a@x.test>\n    Signed-off-by: B")
      // Only the exact empty string means none.
      expect(git).not.toContain(noFooter)
      expect(git).toContain("exactly this text (the indentation is not part of it):\n\n      ")
    }),
  )

  it.effect("decides each field by the highest-priority document that sets it", () =>
    Effect.gen(function* () {
      yield* activate
      const split = gitOf(
        yield* request([document({ attribution: { commit: "" } }), document({ attribution: { pr: "X" } })]),
      )
      expect(split).toContain(noTrailer)
      expect(split).toContain("    X")
      expect(split).not.toContain("Created with Orbit")
      // A higher empty string wins over a lower value, and a higher value over a lower empty string.
      const higherEmpty = gitOf(
        yield* request([document({ attribution: { commit: "U" } }), document({ attribution: { commit: "" } })]),
      )
      expect(higherEmpty).toContain(noTrailer)
      expect(higherEmpty).not.toContain("    U")
      const higherText = gitOf(
        yield* request([document({ attribution: { commit: "" } }), document({ attribution: { commit: "U" } })]),
      )
      expect(higherText).toContain("    U")
      expect(higherText).not.toContain(noTrailer)
    }),
  )

  it.effect("fills slots without string patterns, so a value comes out as written", () =>
    Effect.gen(function* () {
      yield* activate
      const text = yield* request([document({ attribution: { commit: "a $& b $$ c $` d", pr: "$'" } })])
      expect(text).toContain("    a $& b $$ c $` d")
      expect(text).toContain("    $'")
      expect(text).not.toContain("${")
    }),
  )

  it.effect("keeps a value that looks like a heading out of the section list, even when a style drops sections", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "output-styles"), { recursive: true })
        await Bun.write(
          path.join(directory, "output-styles", "reviewer.md"),
          "---\nname: reviewer\nkeep-coding-instructions: false\n---\nOnly review.\n",
        )
      })
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* PromptConfigPlugin.Plugin.effect(host)
      yield* OutputStylePlugin.Plugin.effect(host)
      const text = yield* request([
        new Directory({ type: "directory", path: AbsolutePath.make(directory) }),
        document({ output_style: "reviewer", attribution: { commit: "# Doing tasks\nTrailer: x" } }),
      ])
      expect(text).toContain("    # Doing tasks\n    Trailer: x")
      expect(text).not.toContain("# Doing tasks\n- ")
      // The only top-level headings are the kept base sections, the git section and the style.
      const headings = Array.from(text.matchAll(/^# (.+)$/gm), (match) => match[1])
      expect(headings).toEqual([
        "Harness",
        "Executing actions with care",
        "Using tools",
        "Communication",
        "Output efficiency",
        "Git and pull requests",
        "Output style: reviewer",
      ])
      // The secrets rule lives in the git section, so it outlasts the dropped Code style section.
      expect(text.indexOf("Never log, expose or commit secrets or credentials.")).toBeGreaterThan(
        text.indexOf(SessionSystemPrompt.GIT_HEADING),
      )
    }),
  )

  it.effect("keeps the pull request rules for every line separator a value can hold, with a style that drops sections", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "output-styles"), { recursive: true })
        await Bun.write(
          path.join(directory, "output-styles", "reviewer.md"),
          "---\nname: reviewer\nkeep-coding-instructions: false\n---\nOnly review.\n",
        )
      })
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* PromptConfigPlugin.Plugin.effect(host)
      yield* OutputStylePlugin.Plugin.effect(host)
      for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
        const text = yield* request([
          new Directory({ type: "directory", path: AbsolutePath.make(directory) }),
          document({
            output_style: "reviewer",
            attribution: { commit: `T: x${separator}# Doing tasks`, pr: "PR footer" },
          }),
        ])
        expect([JSON.stringify(separator), text.includes("Pull requests:"), text.includes("    PR footer")]).toEqual([
          JSON.stringify(separator),
          true,
          true,
        ])
      }
    }),
  )

  it.effect("follows the model overlay, whether it replaces the base or is appended to it", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), () => {}))
      yield* catalog.transform((editor) => {
        for (const id of ["gpt-5", "claude-sonnet-4"])
          editor.models.update(Provider.ID.make("test"), Model.ID.make(id), () => {})
      })
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(host), { discard: true })
      yield* PromptConfigPlugin.Plugin.effect(host)
      for (const model of ["gpt-5", "claude-sonnet-4"]) {
        const text = yield* request([], { model })
        // A replacing overlay ends with the shared rules, an appended one adds to the base; the git section is after both.
        if (model === "gpt-5")
          expect(text.indexOf("# Orbit rules")).toBeLessThan(text.indexOf(SessionSystemPrompt.GIT_HEADING))
        expect(text).not.toBe(`${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`)
        expect(text.endsWith(SessionSystemPrompt.renderGit(defaults))).toBe(true)
        expect(text.split(SessionSystemPrompt.GIT_HEADING)).toHaveLength(2)
      }
    }),
  )

  it.effect("serves agents with a system prompt of their own and subagents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Custom agent prompt"
        }),
      )
      yield* activate
      expect(yield* request([], { text: "Custom agent prompt" })).toBe(
        `Custom agent prompt\n\n${SessionSystemPrompt.renderGit(defaults)}`,
      )
      expect(yield* request([], { agent: "explore" })).toEndWith(SessionSystemPrompt.renderGit(defaults))
    }),
  )

  it.effect("serves compaction and generate requests the same text as context", () =>
    Effect.gen(function* () {
      yield* activate
      const entries = [document({ attribution: { commit: "T: 1" } })]
      const expected = yield* request(entries)
      expect(yield* request(entries, {}, "compaction")).toBe(expected)
      expect(yield* request(entries, {}, "generate")).toBe(expected)
    }),
  )

  it.effect("keeps the guidance and writes no attribution when the settings cannot be read", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* PromptConfigPlugin.Plugin.effect(host).pipe(
        Effect.provideService(Config.Service, { ...config, entries: () => Effect.die("unreadable") }),
      )
      const event = context()
      yield* hooks.trigger("session", "context", event as never)
      expect(event.system[0]?.text).toBe(`${base}\n\n${SessionSystemPrompt.renderGit({ commit: "", pr: "" })}`)
    }),
  )

  it.effect("is listed after the model prompts and before the output style", () =>
    Effect.gen(function* () {
      expect(PromptConfigPlugin.Plugin.id).toBe("orbit.prompt.config")
      const source = yield* Effect.promise(() =>
        Bun.file(path.join(import.meta.dir, "../../src/plugin/internal.ts")).text(),
      )
      const at = (name: string) => source.indexOf(name, source.indexOf("const pre = ["))
      // The patch plugin removes tools first, the subagent base is rendered from what is left, and the model prompts and
      // this plugin follow it.
      expect(at("PatchTool.Plugin")).toBeLessThan(at("SubagentPromptPlugin.Plugin"))
      expect(at("SubagentPromptPlugin.Plugin")).toBeLessThan(at("...OptimizePlugin.Plugins"))
      expect(at("...OptimizePlugin.Plugins")).toBeLessThan(at("PromptConfigPlugin.Plugin"))
      expect(at("PromptConfigPlugin.Plugin")).toBeLessThan(at("OutputStylePlugin.Plugin"))
    }),
  )
})

describe("the memory index", () => {
  it.effect("is activated after the instruction files, so it renders last", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        Bun.file(path.join(import.meta.dir, "../../src/plugin/internal.ts")).text(),
      )
      const at = (name: string) => source.indexOf(name, source.indexOf("const post = ["))
      expect(at("ConfigInstructionPlugin.Plugin")).toBeGreaterThan(-1)
      expect(at("ConfigInstructionPlugin.Plugin")).toBeLessThan(at("MemoryTool.Plugin"))
      expect(source.indexOf("MemoryTool.Plugin", source.indexOf("const pre = ["))).toBeGreaterThan(source.indexOf("const post = ["))
    }),
  )
})

describe("the PowerShell rename", () => {
  // The session's shell is PowerShell: a stand-in for the one method the plugin calls.
  const powershell = Layer.succeed(ShellSelect.Service, { resolve: () => Effect.succeed("pwsh") } as never)

  it.effect("renames the tool before the section and leaves an attribution value that says Bash as written", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), () => {}))
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* PromptConfigPlugin.Plugin.effect(host)
      yield* ShellTool.AdvertisePlugin.effect(host as never).pipe(Effect.provide(powershell))
      const text = yield* request([document({ attribution: { commit: "Run-by: Bash", pr: "Bash" } })])
      const section = text.indexOf(SessionSystemPrompt.GIT_HEADING)
      expect(text.slice(0, section)).toContain("PowerShell is for what only a shell can do")
      expect(text.slice(0, section)).not.toMatch(/\bBash\b/)
      expect(text.slice(section)).toContain("    Run-by: Bash")
      expect(text.slice(section)).toContain("    Bash")
      expect(text.slice(section)).not.toContain("PowerShell")
    }),
  )
})

describe("system prompt keys", () => {
  const readLine = "- Use Read, rather than `cat`"
  const tools = ["Bash", "Read"]

  // Sessions are real; the agents are `build` (no prompt), `own` (a prompt of its own) and `worker` (a subagent).
  const setup = (wrap: (fs: FSUtil.Interface) => FSUtil.Interface = (fs) => fs) => Effect.gen(function* () {
    const agents = yield* Agent.Service
    const catalog = yield* Provider.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("build"), () => {})
      editor.update(Agent.ID.make("own"), (agent) => {
        agent.system = "Own prompt"
      })
      editor.update(Agent.ID.make("worker"), (agent) => {
        agent.mode = "subagent"
      })
    })
    yield* catalog.transform((editor) => {
      editor.models.update(Provider.ID.make("test"), Model.ID.make("gpt-5"), () => {})
    })
    const host = yield* PluginHost.make(yield* Plugin.Service)
    yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(host), { discard: true })
    yield* IdentityPlugin.Plugin.effect(host)
    yield* PromptConfigPlugin.Plugin.effect(host).pipe(Effect.provideService(FSUtil.Service, wrap(yield* FSUtil.Service)))
    const root = yield* host.session.create({ title: "root" })
    const child = yield* host.session.create({ title: "child", parentID: root.id })
    return { host, root, child }
  })

  const templateRequest = (entries: Entry[], options: Parameters<typeof context>[0]) =>
    request(entries, { text: base, tools, ...options })

  it.effect("replaces the base and the overlay, keeps the core rules, then the git section", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const plain = yield* templateRequest([], { sessionID: root.id, model: "gpt-5" })
      const text = yield* templateRequest([document({ system_prompt: "BASE-MARK ${ORBIT_TOOL_GUIDANCE}" })], {
        sessionID: root.id,
        model: "gpt-5",
      })
      expect(text.startsWith("BASE-MARK - ")).toBe(true)
      expect(text).toContain(readLine)
      expect(text).not.toContain(SessionSystemPrompt.INTRO)
      // Nothing of the gpt overlay survives.
      expect(plain.slice(0, 120)).not.toBe(text.slice(0, 120))
      expect(text).not.toContain(plain.slice(0, 120))
      expect(text.indexOf("# Orbit rules")).toBeGreaterThan(text.indexOf(readLine))
      expect(text.indexOf(SessionSystemPrompt.GIT_HEADING)).toBeGreaterThan(text.indexOf("# Orbit rules"))
      expect(text.endsWith(SessionSystemPrompt.renderGit(defaults))).toBe(true)
    }),
  )

  it.effect("adds no guidance lines when the text has no placeholder", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const text = yield* templateRequest([document({ system_prompt: "ONLY-THIS" })], { sessionID: root.id })
      expect(text.startsWith("ONLY-THIS\n\n# Orbit rules")).toBe(true)
      expect(text).not.toContain(readLine)
    }),
  )

  it.effect("skips the replacement for an agent with a prompt of its own or a subagent, and still appends", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const entries = [document({ system_prompt: "BASE-MARK", append_system_prompt: "APPEND-MARK" })]
      const own = yield* request(entries, { sessionID: root.id, agent: "own", text: "Own prompt" })
      expect(own).toBe(`Own prompt\n\n${SessionSystemPrompt.renderGit(defaults)}\n\nAPPEND-MARK`)
      const worker = yield* templateRequest(entries, { sessionID: root.id, agent: "worker" })
      expect(worker).toBe(`${base}\n\n${SessionSystemPrompt.renderGit(defaults)}\n\nAPPEND-MARK`)
    }),
  )

  it.effect("logs a skipped replacement once per session and agent", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const lines: string[] = []
      const logger = Logger.make((entry) => {
        lines.push(String(entry.message))
      })
      const entries = [document({ system_prompt: "BASE-MARK" })]
      yield* Effect.gen(function* () {
        yield* request(entries, { sessionID: root.id, agent: "own", text: "Own prompt" })
        yield* request(entries, { sessionID: root.id, agent: "own", text: "Own prompt" })
        yield* request(entries, { sessionID: root.id, agent: "worker" })
      }).pipe(Effect.provide(Logger.layer([logger])))
      expect(lines.filter((line) => line.includes("replacement skipped"))).toHaveLength(2)
    }),
  )

  it.effect("serves compaction and generate requests the same text as context", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const entries = [document({ system_prompt: "BASE-MARK", append_system_prompt: "APPEND-MARK" })]
      const expected = yield* templateRequest(entries, { sessionID: root.id })
      expect(expected).toContain("APPEND-MARK")
      expect(yield* request(entries, { sessionID: root.id, tools }, "compaction")).toBe(expected)
      expect(yield* request(entries, { sessionID: root.id, tools }, "generate")).toBe(expected)
    }),
  )

  it.effect("applies on the main thread only", () =>
    Effect.gen(function* () {
      const { root, child } = yield* setup()
      const entries = [document({ system_prompt: "BASE-MARK", append_system_prompt: "APPEND-MARK" })]
      const forkOfRoot = { ...root, fork: { sessionID: root.id, boundary: {} as never } }
      const forkOfChild = { ...root, fork: { sessionID: child.id, boundary: {} as never } }
      expect(PromptConfigPlugin.mainThread(root)).toBe(true)
      expect(PromptConfigPlugin.mainThread(forkOfRoot, root)).toBe(true)
      expect(PromptConfigPlugin.mainThread(child)).toBe(false)
      expect(PromptConfigPlugin.mainThread(forkOfChild, child)).toBe(false)
      // A fork whose source was deleted is a fresh main conversation; a fork of a subagent stays one.
      expect(PromptConfigPlugin.mainThread(forkOfRoot)).toBe(true)
      expect(PromptConfigPlugin.mainThread({ ...forkOfRoot, parentID: child.id })).toBe(false)
      // A subagent child keeps the default prompt and gets no appended text.
      expect(yield* templateRequest(entries, { sessionID: child.id })).toBe(
        `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`,
      )
    }),
  )

  it.effect("treats empty text as unset and whitespace as set", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const defaultText = `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`
      expect(
        yield* templateRequest([document({ system_prompt: "", append_system_prompt: "" })], { sessionID: root.id }),
      ).toBe(defaultText)
      const blank = yield* templateRequest([document({ system_prompt: "  \n" })], { sessionID: root.id })
      expect(blank.startsWith("  \n\n\n# Orbit rules")).toBe(true)
    }),
  )

  it.effect("lets the highest-priority document that sets a replacement key decide", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const dir = (yield* tmpdirScoped()).path
      yield* Effect.promise(() => Bun.write(path.join(dir, "file.md"), "FROM-FILE"))
      const at = AbsolutePath.make(path.join(dir, "orbit.json"))
      const file = new Document({ type: "document", path: at, info: decode({ system_prompt_file: "file.md" }) })
      const user = document({ system_prompt: "USER", append_system_prompt: "USER-APPEND" })
      const flag = document({ system_prompt: "FLAG" })
      const high = yield* templateRequest([user, file], { sessionID: root.id })
      expect(high.startsWith("FROM-FILE")).toBe(true)
      expect(high).toContain("USER-APPEND")
      expect((yield* templateRequest([user, file, flag], { sessionID: root.id })).startsWith("FLAG")).toBe(true)
      expect((yield* templateRequest([file, user], { sessionID: root.id })).startsWith("USER")).toBe(true)
    }),
  )

  it.effect("reads the file relative to its document, to the location directory, from ~/ and absolute", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const dir = (yield* tmpdirScoped()).path
      const locationDir = (yield* Location.Service).directory
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, "nested"), { recursive: true })
        await Bun.write(path.join(dir, "nested", "p.md"), "NEXT-TO-DOCUMENT")
        await Bun.write(path.join(locationDir, "loc-prompt.md"), "IN-LOCATION")
        await Bun.write(path.join(dir, "abs.md"), "ABSOLUTE")
      })
      const withPath = new Document({
        type: "document",
        path: AbsolutePath.make(path.join(dir, "nested", "orbit.json")),
        info: decode({ system_prompt_file: "p.md" }),
      })
      expect((yield* templateRequest([withPath], { sessionID: root.id })).startsWith("NEXT-TO-DOCUMENT")).toBe(true)
      const pathless = document({ system_prompt_file: "loc-prompt.md" })
      expect((yield* templateRequest([pathless], { sessionID: root.id })).startsWith("IN-LOCATION")).toBe(true)
      const absolute = document({ system_prompt_file: path.join(dir, "abs.md") })
      expect((yield* templateRequest([absolute], { sessionID: root.id })).startsWith("ABSOLUTE")).toBe(true)
      // The home folder of the test run is isolated, so a file can be put under it.
      const testRoot = process.env.ORBIT_TEST_ROOT
      if (testRoot && os.homedir().startsWith(testRoot)) {
        // On Linux the home is shared by the workers, so the file name is per process.
        const name = `home-prompt-${process.pid}.md`
        yield* Effect.promise(() => Bun.write(path.join(os.homedir(), name), "IN-HOME"))
        const home = document({ system_prompt_file: `~/${name}` })
        expect((yield* templateRequest([home], { sessionID: root.id })).startsWith("IN-HOME")).toBe(true)
        yield* Effect.promise(() => fs.rm(path.join(os.homedir(), name), { force: true }))
      }
    }),
  )

  it.effect("keeps the default for a missing or empty file, warns once per path, and follows the file", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const dir = (yield* tmpdirScoped()).path
      const file = path.join(dir, "p.md")
      const entries = [document({ system_prompt_file: file })]
      const defaultText = `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`
      const lines: string[] = []
      const logger = Logger.make((entry) => {
        lines.push(String(entry.message))
      })
      const warned = () => lines.filter((line) => line.includes("system_prompt_file not used")).length
      yield* Effect.gen(function* () {
        expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
        expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
        expect(warned()).toBe(1)
        yield* Effect.promise(() => Bun.write(file, ""))
        expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
        yield* Effect.promise(() => Bun.write(file, "FIRST"))
        expect((yield* templateRequest(entries, { sessionID: root.id })).startsWith("FIRST")).toBe(true)
        yield* Effect.promise(() => Bun.write(file, "SECOND"))
        expect((yield* templateRequest(entries, { sessionID: root.id })).startsWith("SECOND")).toBe(true)
        yield* Effect.promise(() => fs.rm(file))
        expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
        expect(warned()).toBe(2)
      }).pipe(Effect.provide(Logger.layer([logger])))
    }),
  )

  const shares = [
    ["a backslash share", "\\\\host\\share\\p.md"],
    ["a slash share", "//host/share/p.md"],
    ["a device path", "\\\\?\\UNC\\host\\share\\p.md"],
    ["a rooted NT share", "\\??\\UNC\\host\\share\\p.md"],
    ["a lower-case NT share", "\\??\\unc\\localhost\\C$\\Windows\\win.ini"],
    ["an NT mup device", "\\??\\GLOBALROOT\\Device\\Mup\\host\\share\\p.md"],
    ["a slash NT share", "/??/UNC/host/share/p.md"],
  ] as const

  it.effect("refuses a share path before any file system call", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const recording = (real: FSUtil.Interface) =>
        Object.fromEntries(
          Object.entries(real).map(([key, value]) => [
            key,
            typeof value !== "function"
              ? value
              : (...args: unknown[]) => {
                  calls.push(key)
                  return value(...args)
                },
          ]),
        ) as FSUtil.Interface
      const { root } = yield* setup(recording)
      const defaultText = `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`
      const onShare = new Document({
        type: "document",
        path: (process.platform === "win32" ? "\\\\host\\share\\orbit.json" : "//host/share/orbit.json") as AbsolutePath,
        info: decode({ system_prompt_file: "p.md" }),
      })
      const cases = [...shares.map(([, target]) => [document({ system_prompt_file: target })]), [onShare]]
      for (const entries of cases) expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
      expect(calls).toEqual([])
      // A local absolute file is read through the same layer.
      const dir = (yield* tmpdirScoped()).path
      yield* Effect.promise(() => Bun.write(path.join(dir, "p.md"), "LOCAL-MARK"))
      expect(
        (yield* templateRequest([document({ system_prompt_file: path.join(dir, "p.md") })], { sessionID: root.id })).startsWith(
          "LOCAL-MARK",
        ),
      ).toBe(true)
      expect(calls.length).toBeGreaterThan(0)
    }),
  )

  it.effect("renders a real fork like its parent, also after the source is deleted", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const entries = [document({ system_prompt: "BASE-MARK", append_system_prompt: "APPEND-MARK" })]
      yield* sessions.prompt({ sessionID: root.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, root.id, "steer")
      const forked = yield* sessions.fork({ sessionID: root.id })
      const expected = yield* templateRequest(entries, { sessionID: root.id })
      expect(expected).toContain("APPEND-MARK")
      expect(yield* templateRequest(entries, { sessionID: forked.id })).toBe(expected)
      yield* sessions.remove(root.id)
      expect(yield* templateRequest(entries, { sessionID: forked.id })).toBe(expected)
    }),
  )

  it.effect("gives a real fork of a subagent child the default prompt", () =>
    Effect.gen(function* () {
      const { child } = yield* setup()
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const entries = [document({ system_prompt: "BASE-MARK", append_system_prompt: "APPEND-MARK" })]
      yield* sessions.prompt({ sessionID: child.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, child.id, "steer")
      const forked = yield* sessions.fork({ sessionID: child.id })
      expect(yield* templateRequest(entries, { sessionID: forked.id })).toBe(
        `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`,
      )
    }),
  )

  it.effect("keeps the identity part second and the baseline last next to a replacement", () =>
    Effect.gen(function* () {
      const { root } = yield* setup()
      const hooks = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([document({ system_prompt: "BASE-MARK" })])
      const event = { ...context({ sessionID: root.id, tools }), system: [SystemPart.make(base), SystemPart.make("BASELINE")] }
      yield* hooks.trigger("session", "context", event as never)
      expect(event.system[0]?.text.startsWith("BASE-MARK")).toBe(true)
      expect(event.system[1]?.text.startsWith("# Your Model")).toBe(true)
      expect(event.system.at(-1)?.text).toBe("BASELINE")
    }),
  )

  // A folder on the path is a link to a share: the target must not be opened.
  it.effect("refuses a path that leads to a share through a link, before reading it", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const calls: string[] = []
      const linked = (real: FSUtil.Interface) =>
        ({
          ...real,
          readLink: (file: string) =>
            path.basename(file) === "linked" ? Effect.succeed("\\\\host\\share") : real.readLink(file),
          readFileStringSafe: (file: string) => {
            calls.push(file)
            return real.readFileStringSafe(file)
          },
        }) as FSUtil.Interface
      const { root } = yield* setup(linked)
      const dir = (yield* tmpdirScoped()).path
      const defaultText = `${base}\n\n${SessionSystemPrompt.renderGit(defaults)}`
      const entries = [document({ system_prompt_file: path.join(dir, "linked", "p.md") })]
      expect(yield* templateRequest(entries, { sessionID: root.id })).toBe(defaultText)
      expect(calls).toEqual([])
    }),
  )

  const styled = (directory: string) => [
    new Directory({ type: "directory", path: AbsolutePath.make(directory) }),
    document({ output_style: "reviewer" }),
  ]
  const reviewerStyle = Effect.gen(function* () {
    const directory = (yield* tmpdirScoped()).path
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "output-styles"), { recursive: true })
      await Bun.write(
        path.join(directory, "output-styles", "reviewer.md"),
        "---\nname: reviewer\nkeep-coding-instructions: false\n---\nOnly review.\n",
      )
    })
    return directory
  })

  it.effect("puts appended text after the git section and before the style, and no style cut touches it", () =>
    Effect.gen(function* () {
      const { host, root } = yield* setup()
      yield* OutputStylePlugin.Plugin.effect(host)
      const directory = yield* reviewerStyle
      const appended = "Extra rules.\n\n# Code style\nMy own code style.\n\n# Doing tasks\nMy own tasks."
      const text = yield* templateRequest(
        [...styled(directory), document({ append_system_prompt: appended })],
        { sessionID: root.id },
      )
      const git = text.indexOf(SessionSystemPrompt.GIT_HEADING)
      const at = text.indexOf("Extra rules.")
      const style = text.indexOf("# Output style: reviewer")
      expect(git).toBeGreaterThan(0)
      expect(at).toBeGreaterThan(git)
      expect(style).toBeGreaterThan(at)
      expect(text).toContain("# Code style\nMy own code style.")
      expect(text).toContain("# Doing tasks\nMy own tasks.")
      // Orbit's own coding sections are still cut: the base has none left.
      expect(text.indexOf("# Doing tasks")).toBeGreaterThan(git)
    }),
  )

  // An agent prompt that ends in a coding section, or is one, and no shell tool, so nothing of Orbit's stands between that
  // prompt and the appended text. The appended text always follows, after one blank line, and no token is left behind.
  for (const row of [
    { name: "ends in a coding section", text: "Own prompt\n\n# Verification\nRun the tests.", head: "Own prompt\n\nAPPEND-MARK" },
    { name: "is a coding section", text: "# Doing tasks\nDo things.", head: "APPEND-MARK" },
  ])
    it.effect(`keeps appended text after an agent prompt that ${row.name}, under a style`, () =>
      Effect.gen(function* () {
        const { host, root } = yield* setup()
        yield* OutputStylePlugin.Plugin.effect(host)
        const directory = yield* reviewerStyle
        const text = yield* request(
          [...styled(directory), document({ append_system_prompt: "APPEND-MARK" })],
          { sessionID: root.id, agent: "own", text: row.text, tools: ["Read"] },
        )
        expect(text).not.toContain("# Verification")
        expect(text).not.toContain("# Doing tasks")
        expect(text).not.toContain("\u0000")
        expect(text.startsWith(row.head)).toBe(true)
        expect(text.indexOf("# Output style: reviewer")).toBeGreaterThan(text.indexOf("APPEND-MARK"))
      }),
    )

  it.effect("keeps the sections of a replacement that is named like a coding section, under a style", () =>
    Effect.gen(function* () {
      const { host, root } = yield* setup()
      yield* OutputStylePlugin.Plugin.effect(host)
      const directory = yield* reviewerStyle
      const text = yield* templateRequest(
        [...styled(directory), document({ system_prompt: "# Doing tasks\nMine.\n\n# Verification\nAlso mine." })],
        { sessionID: root.id },
      )
      expect(text.startsWith("# Doing tasks\nMine.\n\n# Verification\nAlso mine.\n\n# Orbit rules")).toBe(true)
      expect(text.indexOf("# Output style: reviewer")).toBeGreaterThan(text.indexOf(SessionSystemPrompt.GIT_HEADING))
    }),
  )

  it.effect("keeps the word the person used for the shell on PowerShell, and names the tool in the guidance", () =>
    Effect.gen(function* () {
      const { host, root } = yield* setup()
      const powershell = Layer.succeed(ShellSelect.Service, { resolve: () => Effect.succeed("pwsh") } as never)
      yield* ShellTool.AdvertisePlugin.effect(host as never).pipe(Effect.provide(powershell))
      const text = yield* templateRequest(
        [document({ system_prompt: "Use Bash here. ${ORBIT_TOOL_GUIDANCE} Never Bash twice.", append_system_prompt: "Bash!" })],
        { sessionID: root.id },
      )
      expect(text).toContain("Use Bash here. - PowerShell is for what only a shell can do")
      expect(text).toContain("Never Bash twice.")
      expect(text.endsWith("Bash!")).toBe(true)
      expect(text.slice(0, text.indexOf(SessionSystemPrompt.GIT_HEADING))).not.toMatch(/\bBash\b(?! here| twice)/)
    }),
  )
})

describe("resolveAttribution", () => {
  it.effect("falls back to the Orbit defaults field by field", () =>
    Effect.sync(() => {
      expect(PromptConfigPlugin.resolveAttribution([])).toEqual(defaults)
      expect(PromptConfigPlugin.resolveAttribution([document({ attribution: { pr: "" } })])).toEqual({
        commit: defaults.commit,
        pr: "",
      })
    }),
  )
})
