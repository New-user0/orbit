// The suggestion state the TUI and Mini share: what it holds for each answer, and how a cancelled, replaced or undrawable
// answer is dropped (class 7).
import { expect, test } from "bun:test"
import { createPromptSuggestions } from "../src/prompt-suggestion"

function setup() {
  const asks: Array<{ sessionID: string; signal: AbortSignal; answer: PromiseWithResolvers<unknown> }> = []
  const logs: string[] = []
  const suggestions = createPromptSuggestions({
    // The request ignores its signal, so an answer that comes after a cancel is the state's own to drop.
    request: (sessionID, signal) => {
      const answer = Promise.withResolvers<unknown>()
      asks.push({ sessionID, signal, answer })
      return answer.promise
    },
    log: (message) => logs.push(message),
  })
  return { suggestions, asks, logs, session: suggestions.session("ses_a") }
}

const tick = () => Bun.sleep(0)

test("each answer holds the suggestion or nothing, and a failure logs one line", async () => {
  const rows = [
    { name: "a suggestion", answer: { suggestion: "run the tests" }, held: "run the tests" },
    { name: "null with a reason", answer: { suggestion: null, reason: "busy" }, held: undefined },
    { name: "a number for the text", answer: { suggestion: 42 }, held: undefined },
    { name: "a reason that is not known", answer: { suggestion: null, reason: "later" }, held: undefined },
    { name: "a string body", answer: "not json", held: undefined },
    { name: "a refusal", fail: new Error("UntrustedFolderError"), held: undefined },
  ]
  for (const row of rows) {
    const state = setup()
    state.suggestions.ended("ses_a")
    if (row.fail) state.asks[0]!.answer.reject(row.fail)
    else state.asks[0]!.answer.resolve(row.answer)
    await tick()
    expect({ name: row.name, held: state.session.text() }).toEqual({ name: row.name, held: row.held })
    expect({ name: row.name, logs: state.logs.length }).toEqual({ name: row.name, logs: row.held ? 0 : 1 })
  }
})

test("a cancelled or replaced ask holds nothing when its answer comes late", async () => {
  {
    const state = setup()
    state.suggestions.ended("ses_a")
    state.session.changed()
    expect(state.asks[0]!.signal.aborted).toBe(true)
    state.asks[0]!.answer.resolve({ suggestion: "late" })
    await tick()
    expect(state.session.text()).toBeUndefined()
  }
  {
    const state = setup()
    state.suggestions.ended("ses_a")
    state.suggestions.ended("ses_a")
    expect(state.asks[0]!.signal.aborted).toBe(true)
    state.asks[0]!.answer.resolve({ suggestion: "first" })
    state.asks[1]!.answer.resolve({ suggestion: "second" })
    await tick()
    expect(state.session.text()).toBe("second")
  }
  {
    const state = setup()
    state.suggestions.ended("ses_a")
    state.suggestions.dispose()
    expect(state.asks[0]!.signal.aborted).toBe(true)
    state.asks[0]!.answer.reject(new Error("aborted"))
    await tick()
    expect(state.logs).toEqual([])
  }
})

test("an answer that cannot be drawn is dropped, and one with no prompt in view is held", async () => {
  const rows = [
    { name: "a prompt that cannot draw it", watch: () => false, held: undefined },
    { name: "a prompt that can draw it", watch: () => true, held: "run the tests" },
    { name: "no prompt in view", watch: undefined, held: "run the tests" },
  ]
  for (const row of rows) {
    const state = setup()
    if (row.watch) state.session.watch(row.watch)
    state.suggestions.ended("ses_a")
    state.asks[0]!.answer.resolve({ suggestion: "run the tests" })
    await tick()
    expect({ name: row.name, held: state.session.text() }).toEqual({ name: row.name, held: row.held })
  }
  // A prompt that left stops deciding; a newer one that took its place keeps deciding.
  const state = setup()
  const first = state.session.watch(() => false)
  const second = state.session.watch(() => false)
  first()
  state.suggestions.ended("ses_a")
  state.asks[0]!.answer.resolve({ suggestion: "run the tests" })
  await tick()
  expect(state.session.text()).toBeUndefined()
  second()
  state.suggestions.ended("ses_a")
  state.asks[1]!.answer.resolve({ suggestion: "run the tests" })
  await tick()
  expect(state.session.text()).toBe("run the tests")
})

test("a turn start and a sent prompt end a held suggestion, and sessions keep their own", async () => {
  const state = setup()
  const other = state.suggestions.session("ses_b")
  state.suggestions.ended("ses_a")
  state.suggestions.ended("ses_b")
  state.asks[0]!.answer.resolve({ suggestion: "for a" })
  state.asks[1]!.answer.resolve({ suggestion: "for b" })
  await tick()
  expect([state.session.text(), other.text()]).toEqual(["for a", "for b"])
  state.suggestions.started("ses_a")
  expect([state.session.text(), other.text()]).toEqual([undefined, "for b"])
  other.submitted()
  expect(other.text()).toBeUndefined()
  // A turn starting while an ask is out cancels it.
  state.suggestions.ended("ses_a")
  state.suggestions.started("ses_a")
  expect(state.asks[2]!.signal.aborted).toBe(true)
  state.asks[2]!.answer.resolve({ suggestion: "late" })
  await tick()
  expect(state.session.text()).toBeUndefined()
})
