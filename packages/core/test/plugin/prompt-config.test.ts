import { describe, expect } from "bun:test"
import fs from "fs/promises"
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
import { ShellSelect } from "@orbit/core/shell/select"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect, Layer, Schema } from "effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const base = SessionSystemPrompt.make(["Bash"])
const decode = Schema.decodeUnknownSync(Info)
const document = (info: unknown) => new Document({ type: "document", info: decode(info) })
const tool = { description: "tool", input: { type: "object" as const } }

const context = (
  options: { tools?: string[]; agent?: string; model?: string; text?: string } = {},
): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_prompt_config"),
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
      expect(at("...OptimizePlugin.Plugins")).toBeLessThan(at("PromptConfigPlugin.Plugin"))
      expect(at("PromptConfigPlugin.Plugin")).toBeLessThan(at("OutputStylePlugin.Plugin"))
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
