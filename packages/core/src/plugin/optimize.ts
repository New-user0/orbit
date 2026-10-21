export * as OptimizePlugin from "./optimize.js"

import { define } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect } from "effect"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import { PromptConfigPlugin } from "./prompt-config.js"
import { SubagentPromptPlugin } from "./subagent-prompt.js"

import PROMPT_GPT from "./system-prompt/gpt.txt"
import PROMPT_ASTRA from "./system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "./system-prompt/kimi.txt"
import PROMPT_META from "./system-prompt/meta.txt"
import PROMPT_TRINITY from "./system-prompt/trinity.txt"
import PROMPT_ANTHROPIC from "./system-prompt/anthropic.txt"
import PROMPT_LOCAL from "./system-prompt/local.txt"
import CORE_RULES from "./system-prompt/core-rules.txt"

export const OpenAIPlugin = make("orbit.prompt.openai", (model) => {
  const id = model.id.toLowerCase()
  if (!id.includes("gpt")) return undefined
  return id.includes("astra") ? PROMPT_ASTRA : PROMPT_GPT
})

export const AnthropicPlugin = make(
  "orbit.prompt.anthropic",
  (model) => {
    const id = model.id.toLowerCase()
    if (!id.includes("claude")) return undefined
    return PROMPT_ANTHROPIC
  },
  "append",
)

// Both OpenAIToolsPlugin and AnthropicToolsPlugin are disabled intentionally until we can figure out a good ux for displaying
// heavy grep/glob usage done via shell or other mechanisms

export const OpenAIToolsPlugin = make("orbit.optimize.openai.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("gpt")) return undefined
  delete tools.Grep
  delete tools.Glob
  return undefined
})

export const AnthropicToolsPlugin = make("orbit.optimize.anthropic.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("claude")) return undefined
  delete tools.Grep
  delete tools.Glob
  return undefined
})

export const KimiPlugin = make("orbit.prompt.kimi", (model) =>
  model.id.toLowerCase().includes("kimi") ? PROMPT_KIMI : undefined,
)
export const ArceePlugin = make("orbit.prompt.arcee", (model) =>
  model.id.toLowerCase().includes("trinity") ? PROMPT_TRINITY : undefined,
)
export const MetaPlugin = make("orbit.prompt.meta", (model) => {
  if (!model.id.toLowerCase().includes("muse")) return undefined
  return PROMPT_META.replaceAll("{{MODEL_NAME}}", model.name)
})

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp", "llama.cpp", "vllm"])

// Small local models follow a short, imperative prompt better than the full baseline.
export const LocalPlugin = make("orbit.prompt.local", (model) =>
  LOCAL_PROVIDERS.has(model.providerID.toLowerCase()) || model.compatibility?.toolCalling === "text"
    ? PROMPT_LOCAL
    : undefined,
)

export const Plugins = [OpenAIPlugin, AnthropicPlugin, KimiPlugin, ArceePlugin, MetaPlugin, LocalPlugin] as const

function make(
  id: string,
  optimize: (model: Model.Info, tools: SessionHooks["context"]["tools"]) => string | undefined,
  mode: "override" | "append" = "override",
) {
  return define({
    id,
    effect: Effect.fn(`OptimizePlugin.${id}`)(function* (ctx) {
      const hook = (event: SessionHooks["context"]) =>
        Effect.gen(function* () {
          if (PromptConfigPlugin.sideQuery(event)) return
          const model =
            (yield* ctx.model.list()).data.find(
              (model) => model.providerID === event.model.providerID && model.id === event.model.id,
            ) ?? Model.Info.default(event.model.providerID, event.model.id)
          // Curate tools before rendering their guidance, including for agents with a custom system prompt.
          const template = optimize(model, event.tools)
          if (!template) return
          if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
          // A subagent has its own base (`SubagentPromptPlugin`); the overlays are written for the main template.
          if (yield* SubagentPromptPlugin.subagent(ctx, event.sessionID)) return
          const system = event.system[0]
          if (!system) return
          const rendered = SessionSystemPrompt.render(template, Object.keys(event.tools))
          // Overrides replace the baseline wholesale, so they carry Orbit's shared rules with them.
          const text = mode === "append" ? `${system.text}\n\n${rendered}` : `${rendered}\n\n${CORE_RULES}`
          event.system[0] = { ...system, text }
        }).pipe(Effect.catch(() => Effect.void))
      yield* ctx.session.hook("context", hook)
      yield* ctx.session.hook("compaction", hook)
      yield* ctx.session.hook("generate", hook)
    }),
  })
}
