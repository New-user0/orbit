import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { Config } from "@orbit/core/config"
import { OutputStylePlugin } from "@orbit/core/plugin/output-style"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionReminders } from "@orbit/core/session/reminders"
import { testEffect } from "./lib/effect"

/**
 * prompts-context-7: the output-style reminder. As in the reference, every step of the main conversation is reminded of
 * a built-in style that is not the default; a custom or plugin style, the default and no style produce nothing.
 */

const it = testEffect(Layer.empty)
const styled = (name: string): Entry =>
  new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ output_style: name }) })

const input = (messages: ReadonlyArray<SessionMessage.Info> = [], parentID?: Session.ID) => ({
  session: { id: Session.ID.make("ses_style_reminder"), ...(parentID ? { parentID } : {}) } as never,
  agent: {} as never,
  tools: [],
  model: {} as never,
  messages,
  step: 1,
  firstStep: messages.length === 0,
})

const produce = (entries: ReadonlyArray<Entry>, messages: ReadonlyArray<SessionMessage.Info> = []) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    return yield* OutputStylePlugin.durable(config).run(input(messages))
  }).pipe(Effect.provide(Config.testLayer([...entries])))

const at = Date.now()
const history = (messages: ReadonlyArray<unknown>) =>
  messages.map((message) => Schema.decodeUnknownSync(SessionMessage.Info)(message))
const assistant = (id: string) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "fake", id: "fake-model" },
  content: [],
  time: { created: at, completed: at },
})
const row = (id: string, kind: string) => ({
  id,
  type: "synthetic",
  text: "<system-reminder>\nposted\n</system-reminder>",
  metadata: { reminder: { kind } },
  time: { created: at },
})

describe("the output-style reminder", () => {
  for (const [name, shown] of [
    ["explanatory", "Explanatory"],
    ["Learning", "Learning"],
    ["LEARNING", "Learning"],
  ] as const)
    it.effect(`names the built-in style ${JSON.stringify(name)} as active, in harness text only`, () =>
      Effect.gen(function* () {
        const entries = yield* produce([styled(name)])
        expect(entries).toHaveLength(1)
        expect(entries[0].kind).toBe(OutputStylePlugin.REMINDER_KIND)
        expect(entries[0].text).toContain(shown)
        expect(entries[0].data).toBeUndefined()
        expect(entries[0].description).toBeUndefined()
      }),
    )

  for (const [name, entries] of [
    ["no style", []],
    ["the default style", [styled("default")]],
    ["the default style set after a built-in one", [styled("explanatory"), styled("default")]],
    // A custom style is a file in an output-styles folder; the reference's lookup finds no built-in by that name.
    ["a custom style", [styled("team-voice")]],
  ] as const)
    it.effect(`produces nothing for ${name}`, () =>
      Effect.gen(function* () {
        expect(yield* produce(entries)).toEqual([])
        // The control: a built-in style set after the same entries is reminded of.
        expect(yield* produce([...entries, styled("explanatory")])).toHaveLength(1)
      }),
    )

  it.effect("is posted on every step, once per run, so a restarted drain does not post it twice", () =>
    Effect.gen(function* () {
      const earlier = history([assistant("msg_0000000001"), row("msg_0000000002", OutputStylePlugin.REMINDER_KIND), assistant("msg_0000000003")])
      // The newest run (after the latest step) has no row yet: this step gets one.
      expect(yield* produce([styled("explanatory")], earlier)).toHaveLength(1)
      const posted = history([assistant("msg_0000000001"), row("msg_0000000002", OutputStylePlugin.REMINDER_KIND)])
      expect(yield* produce([styled("explanatory")], posted)).toEqual([])
    }),
  )

  it.effect("is for the main conversation only and is left out of the minimal lists", () =>
    Effect.gen(function* () {
      const producer = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        return OutputStylePlugin.durable(config)
      }).pipe(Effect.provide(Config.testLayer([styled("explanatory")])))
      expect(producer.scope).toBe("primary")
      expect(producer.minimal).not.toBe(true)
      expect(SessionReminders.minimal({ durable: [producer], derived: [] }).durable).toEqual([])
    }),
  )
})
