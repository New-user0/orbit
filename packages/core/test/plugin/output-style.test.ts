import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SystemPart } from "@orbit/ai"
import { Directory, Document, Info } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { OutputStylePlugin } from "@orbit/core/plugin/output-style"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect, Layer, Schema } from "effect"
import { scriptedMarkdown } from "../fixture/front-matter"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const base = SessionSystemPrompt.make([])
const decode = Schema.decodeUnknownSync(Info)
const styled = (name: string) => new Document({ type: "document", info: decode({ output_style: name }) })

const context = (): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_output_style"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
  system: [SystemPart.make(base)],
  messages: [],
  tools: {},
  options: {},
})

const writeStyle = (root: string, name: string, body: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(root, "output-styles"), { recursive: true })
    await Bun.write(path.join(root, "output-styles", `${name}.md`), `---\nname: ${name}\n---\n${body}\n`)
  })

// Activates the plugin over a config that reports the given compatibility state, and returns the system prompt a
// session would get for the named style.
const styledPrompt = (name: string, compat: Config.Compat) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* OutputStylePlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service)).pipe(
      Effect.provide(Config.testLayer([styled(name)], compat)),
    )
    const event = context()
    yield* hooks.trigger("session", "context", event)
    return event.system[0]?.text
  })

describe("OutputStylePlugin", () => {
  it.live("reads styles from the reference vendor's roots while compatibility is enabled", () =>
    Effect.gen(function* () {
      const vendor = (yield* tmpdirScoped()).path
      const agents = (yield* tmpdirScoped()).path
      yield* writeStyle(vendor, "terse", "Answer in one sentence.")
      yield* writeStyle(agents, "chatty", "Answer at length.")
      const roots = [
        { path: AbsolutePath.make(vendor), kind: "vendor", scope: "project" },
        { path: AbsolutePath.make(agents), kind: "agents", scope: "project" },
      ] as const

      expect(yield* styledPrompt("terse", { enabled: true, roots })).toEndWith(
        "# Output style: terse\nAnswer in one sentence.",
      )
    }),
  )

  it.live("leaves a style unresolved when it is only in a shared .agents root", () =>
    Effect.gen(function* () {
      const agents = (yield* tmpdirScoped()).path
      yield* writeStyle(agents, "chatty", "Answer at length.")
      const roots = [{ path: AbsolutePath.make(agents), kind: "agents", scope: "project" }] as const

      expect(yield* styledPrompt("chatty", { enabled: true, roots })).toBe(base)
    }),
  )

  it.live("stops resolving the vendor's styles when compatibility is disabled", () =>
    Effect.gen(function* () {
      const vendor = (yield* tmpdirScoped()).path
      yield* writeStyle(vendor, "terse", "Answer in one sentence.")

      // A disabled switch reports no roots, so the same style that resolved above is unknown.
      expect(yield* styledPrompt("terse", { enabled: false, roots: [] })).toBe(base)
    }),
  )

  it.live("appends a built-in or file style, and drops coding sections when a style asks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const config = yield* Config.Test
      const directory = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "output-styles"), { recursive: true })
        await Bun.write(
          path.join(directory, "output-styles", "reviewer.md"),
          "---\nname: Reviewer\nkeep-coding-instructions: false\n---\nOnly review; never write code.\n",
        )
      })
      yield* OutputStylePlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))

      const unstyled = context()
      yield* hooks.trigger("session", "context", unstyled)
      expect(unstyled.system[0]?.text).toBe(base)

      yield* config.setEntries([styled("explanatory")])
      const explanatory = context()
      yield* hooks.trigger("session", "context", explanatory)
      expect(explanatory.system[0]?.text.startsWith(base)).toBe(true)
      expect(explanatory.system[0]?.text).toContain("# Output style: Explanatory\n")

      yield* config.setEntries([
        new Directory({ type: "directory", path: AbsolutePath.make(directory) }),
        styled("reviewer"),
      ])
      const reviewer = context()
      yield* hooks.trigger("session", "context", reviewer)
      const text = reviewer.system[0]?.text ?? ""
      expect(text).toEndWith("# Output style: Reviewer\nOnly review; never write code.")
      expect(text).toContain("# Communication")
      expect(text).not.toContain("# Doing tasks")
      expect(text).not.toContain("# Verification")
    }),
  )

  it.live("leaves a style unresolved when its front matter is JavaScript, and runs nothing", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const config = yield* Config.Test
      const directory = (yield* tmpdirScoped()).path
      const marker = path.join(directory, "ran")
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "output-styles", "scripted.md"), scriptedMarkdown(marker)),
      )
      yield* OutputStylePlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      yield* config.setEntries([
        new Directory({ type: "directory", path: AbsolutePath.make(directory) }),
        styled("scripted"),
      ])

      const scripted = context()
      yield* hooks.trigger("session", "context", scripted)
      expect(scripted.system[0]?.text).toBe(base)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )
})
