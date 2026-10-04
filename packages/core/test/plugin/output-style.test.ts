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

describe("OutputStylePlugin", () => {
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
})
