import { expect, test } from "bun:test"
import { SystemPart } from "@orbit/ai"
import { Agent } from "@orbit/core/agent"
import { IdentityPlugin } from "@orbit/core/plugin/identity"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Provider } from "@orbit/core/provider"
import { Effect, Layer } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const isolated = testEffect(Layer.empty)

const ref = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-4o-mini") })

test("formats the model identity part", () => {
  expect(IdentityPlugin.identity({ name: "GPT-4o mini", ref })).toBe(
    ["# Your Model", "- Name: GPT-4o mini", "- Provider ID: openai", "- Model ID: gpt-4o-mini"].join("\n"),
  )
})

test("adds the knowledge cutoff after the model ID when the catalog gives one", () => {
  expect(IdentityPlugin.identity({ name: "GPT-4o mini", ref, knowledge: Model.Knowledge.make("2025-01") })).toBe(
    [
      "# Your Model",
      "- Name: GPT-4o mini",
      "- Provider ID: openai",
      "- Model ID: gpt-4o-mini",
      "- Knowledge cutoff: January 2025",
    ].join("\n"),
  )
})

// One row for each month, so the table of names is read against the catalog's two digits and cannot be off by one.
const months = [
  ["01", "January"],
  ["02", "February"],
  ["03", "March"],
  ["04", "April"],
  ["05", "May"],
  ["06", "June"],
  ["07", "July"],
  ["08", "August"],
  ["09", "September"],
  ["10", "October"],
  ["11", "November"],
  ["12", "December"],
] as const
for (const [month, name] of months)
  test(`writes a cutoff in month ${month} as ${name}, with the year`, () => {
    expect(IdentityPlugin.identity({ name: "M", ref, knowledge: Model.Knowledge.make(`2024-${month}`) })).toEndWith(
      `\n- Knowledge cutoff: ${name} 2024`,
    )
  })

// A month taken through `Date` moves with the time zone at the edge of a month; the fixed table of names cannot.
isolated.effect("writes a cutoff the same in every time zone", () =>
  Effect.forEach(["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"], (zone) =>
    withEnv({ TZ: zone }, () =>
      Effect.sync(() =>
        expect(IdentityPlugin.identity({ name: "M", ref, knowledge: Model.Knowledge.make("2024-12") })).toEndWith(
          "- Knowledge cutoff: December 2024",
        ),
      ),
    ),
  ),
)

const identity = (name: string, id: string, knowledge?: string) =>
  [
    "# Your Model",
    `- Name: ${name}`,
    "- Provider ID: test",
    `- Model ID: ${id}`,
    ...(knowledge ? [`- Knowledge cutoff: ${knowledge}`] : []),
  ].join("\n")

const context = (id: string): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_model_identity"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(id) }),
  system: [SystemPart.make("Agent prompt"), SystemPart.make("Initial context")],
  messages: [],
  tools: {},
  options: {},
})

it.effect("inserts the structured model block after the agent prompt", () =>
  Effect.gen(function* () {
    const catalog = yield* Provider.Service
    const hooks = yield* PluginHooks.Service
    const plugins = yield* Plugin.Service
    const pluginHost = yield* PluginHost.make(plugins)
    yield* catalog.transform((editor) => {
      editor.models.update(Provider.ID.make("test"), Model.ID.make("meta/muse-spark-1.1"), (model) => {
        model.name = "Muse Spark"
      })
    })
    yield* IdentityPlugin.Plugin.effect(pluginHost)

    const named = context("meta/muse-spark-1.1")
    yield* hooks.trigger("session", "context", named)
    expect(named.system.map((part) => part.text)).toEqual([
      "Agent prompt",
      identity("Muse Spark", "meta/muse-spark-1.1"),
      "Initial context",
    ])

    const fallback = context("unknown-model")
    yield* hooks.trigger("session", "context", fallback)
    expect(fallback.system.map((part) => part.text)).toEqual([
      "Agent prompt",
      identity("unknown-model", "unknown-model"),
      "Initial context",
    ])
  }),
)

it.effect("tells the model its cutoff when the catalog gives one, in the same place, and nothing for a model it lacks", () =>
  Effect.gen(function* () {
    const catalog = yield* Provider.Service
    const hooks = yield* PluginHooks.Service
    const plugins = yield* Plugin.Service
    const pluginHost = yield* PluginHost.make(plugins)
    yield* catalog.transform((editor) => {
      editor.models.update(Provider.ID.make("test"), Model.ID.make("meta/muse-spark-1.1"), (model) => {
        model.name = "Muse Spark"
        model.knowledge = Model.Knowledge.make("2025-01")
      })
      editor.models.update(Provider.ID.make("test"), Model.ID.make("meta/muse-flash-1.1"), (model) => {
        model.name = "Muse Flash"
      })
    })
    yield* IdentityPlugin.Plugin.effect(pluginHost)

    // The hook splices at index 1 for the request, the compaction and the generation alike.
    for (const name of ["context", "compaction", "generate"] as const) {
      const named = context("meta/muse-spark-1.1")
      yield* hooks.trigger("session", name, named)
      expect(named.system.map((part) => part.text)).toEqual([
        "Agent prompt",
        identity("Muse Spark", "meta/muse-spark-1.1", "January 2025"),
        "Initial context",
      ])
    }

    // A model in the catalog with no cutoff, and one the catalog lacks, get none.
    for (const [id, name] of [
      ["meta/muse-flash-1.1", "Muse Flash"],
      ["unknown-model", "unknown-model"],
    ] as const) {
      const other = context(id)
      yield* hooks.trigger("session", "context", other)
      expect(other.system.map((part) => part.text)).toEqual(["Agent prompt", identity(name, id), "Initial context"])
    }
  }),
)
