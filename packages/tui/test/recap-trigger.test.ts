// clients-ux-27: the away summary's shared trigger, driven by a focus host the test controls. The TUI and Mini tests draw
// the real clients; these pin the timer and in-flight edges that a drawn client does not reach on its own.
import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import { createRecapTrigger } from "../src/recap"

// 30 ms, so a test waits a few delays.
const delay = 0.0005

function harness(input: { busy?: () => boolean; answered?: boolean; minutes?: number } = {}) {
  const renderer = new EventEmitter()
  const asked: Array<{ signal: AbortSignal; settle: () => void }> = []
  const trigger = createRecapTrigger({
    renderer,
    afterMinutes: () => input.minutes ?? delay,
    busy: input.busy ?? (() => false),
    // Unless `answered`, the answer waits for the test and ignores the abort, as a server that answers after the
    // person came back would.
    request: (signal) => {
      const settled = Promise.withResolvers<void>()
      asked.push({ signal, settle: () => settled.resolve() })
      if (input.answered) settled.resolve()
      return settled.promise
    },
  })
  return { renderer, asked, trigger }
}

test("a second blur restarts the delay rather than adding a second timer", async () => {
  const { renderer, asked, trigger } = harness({ answered: true })
  renderer.emit("blur")
  await Bun.sleep(15)
  renderer.emit("blur")
  await Bun.sleep(150)
  expect(asked).toHaveLength(1)
  trigger.dispose()
})

test("a delay that ends while a request is in flight sends no second one", async () => {
  const { renderer, asked, trigger } = harness()
  renderer.emit("blur")
  await Bun.sleep(80)
  renderer.emit("blur")
  await Bun.sleep(80)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.signal.aborted).toBe(false)
  trigger.dispose()
  expect(asked[0]?.signal.aborted).toBe(true)
})

test("after coming back the next blur may ask again, and a dropped answer arriving late does not unblock a third", async () => {
  const { renderer, asked, trigger } = harness()
  renderer.emit("blur")
  await Bun.sleep(80)
  renderer.emit("focus")
  renderer.emit("blur")
  await Bun.sleep(80)
  expect(asked).toHaveLength(2)
  // The first, dropped request settles now; the second is still in flight, so the next delay asks nothing.
  asked[0]?.settle()
  await Bun.sleep(0)
  renderer.emit("blur")
  await Bun.sleep(80)
  expect(asked).toHaveLength(2)
  trigger.dispose()
})

test("a deferred request goes out at the turn's end, and a turn's end with nothing deferred asks nothing", async () => {
  let busy = true
  const { renderer, asked, trigger } = harness({ busy: () => busy })
  trigger.idle()
  renderer.emit("blur")
  await Bun.sleep(80)
  expect(asked).toHaveLength(0)
  busy = false
  trigger.idle()
  expect(asked).toHaveLength(1)
  trigger.idle()
  expect(asked).toHaveLength(1)
  trigger.dispose()
})

// A delay past a 32-bit count of milliseconds would make the timer fire at once, so a person who sets a huge value to
// mean "almost never" would be asked on every blur.
test("a delay longer than a timer holds waits the longest a timer can rather than firing at once", async () => {
  const { renderer, asked, trigger } = harness({ answered: true, minutes: 100_000 })
  renderer.emit("blur")
  await Bun.sleep(80)
  expect(asked).toHaveLength(0)
  trigger.dispose()
})
