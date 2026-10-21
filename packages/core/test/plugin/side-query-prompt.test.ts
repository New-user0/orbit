import { describe, expect } from "bun:test"
import { SystemPart } from "@orbit/ai"
import { Document, Info } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { OptimizePlugin } from "@orbit/core/plugin/optimize"
import { OutputStylePlugin } from "@orbit/core/plugin/output-style"
import { PromptConfigPlugin } from "@orbit/core/plugin/prompt-config"
import { SubagentPromptPlugin } from "@orbit/core/plugin/subagent-prompt"
import { Provider } from "@orbit/core/provider"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// A side query (WebFetch's extraction request) carries its caller's whole system text. The three plugins that rewrite
// `system[0]` (the subagent template, the prompt keys, the model overlays) must leave it as written; the same sessions
// still get their rewrite on an ordinary agent's request.
const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const document = (info: unknown) => new Document({ type: "document", info: decode(info) })
const EXTRACTION = "You answer a question about one web page. The page is between <page> tags and the question follows it."

const rows: ReadonlyArray<{
  name: string
  child: boolean
  model: string
  keys: unknown
  rewritten: (text: string) => boolean
}> = [
  { name: "a child session", child: true, model: "plain-model", keys: {}, rewritten: (text) => text.includes("working as a subagent") },
  {
    name: "a root session with system_prompt and append_system_prompt",
    child: false,
    model: "plain-model",
    keys: { system_prompt: "PERSONAL-BASE", append_system_prompt: "PERSONAL-APPEND" },
    rewritten: (text) => text.startsWith("PERSONAL-BASE") && text.endsWith("PERSONAL-APPEND"),
  },
  {
    name: "a root session on a model with an overlay",
    child: false,
    model: "gpt-5-mini",
    keys: {},
    rewritten: (text) => text.startsWith("You are Orbit") && text !== EXTRACTION,
  },
  {
    name: "a root session with an output style",
    child: false,
    model: "plain-model",
    keys: { output_style: "explanatory" },
    rewritten: (text) => text.includes("# Output style: Explanatory\n"),
  },
]

describe("side query prompt", () => {
  const run = (row: (typeof rows)[number], agent: string, hook: "generate" | "context") =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const catalog = yield* Provider.Service
      yield* agents.transform((editor) => {
        for (const id of ["side", "worker"])
          editor.update(Agent.ID.make(id), (item) => {
            item.mode = "primary"
            item.hidden = id === "side"
          })
      })
      yield* catalog.transform((editor) => {
        editor.models.update(Provider.ID.make("test"), Model.ID.make("gpt-5-mini"), () => {})
      })
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(host), { discard: true })
      yield* PromptConfigPlugin.Plugin.effect(host)
      yield* OutputStylePlugin.Plugin.effect(host)
      yield* SubagentPromptPlugin.Plugin.effect(host)
      const root = yield* host.session.create({ title: "root" })
      const session = row.child ? yield* host.session.create({ title: "child", parentID: root.id }) : root
      const config = yield* Config.Test
      yield* config.setEntries([document(row.keys)])
      const event: SessionHooks["context"] = {
        sessionID: session.id,
        agent: Agent.ID.make(agent),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(row.model) }),
        system: [SystemPart.make(EXTRACTION)],
        messages: [],
        tools: {},
        options: {},
      }
      yield* (yield* PluginHooks.Service).trigger("session", hook, event as never)
      return event.system[0]?.text ?? ""
    })

  for (const row of rows) {
    it.effect(`${row.name}: the side agent keeps its own text`, () =>
      Effect.gen(function* () {
        expect(yield* run(row, "side", "generate")).toBe(EXTRACTION)
      }),
    )
    it.effect(`${row.name}: control, an ordinary agent still gets the rewrite`, () =>
      Effect.gen(function* () {
        expect(row.rewritten(yield* run(row, "worker", "generate"))).toBe(true)
      }),
    )
  }
})
