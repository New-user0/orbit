import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ShellStall } from "@orbit/core/shell/stall"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("ShellStall.looksLikePrompt", () => {
  const prompts = [
    "Proceed (y/n)",
    "Delete? (Y/n) ",
    "Overwrite file (y/N)",
    "Do you want to continue? [Y/n] ",
    "Remove all (yes/no)",
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    "Would you like to proceed?",
    "Shall I continue?  ",
    "Ready to install?",
    "Press any key to continue . . .",
    "! First copy your one-time code: 1234-ABCD\nPress Enter to open github.com in your browser...",
    "Continue?",
    "OVERWRITE? ",
    "Proceed (y/n)\n",
    "Proceed (y/n)\r\n",
    "Downloading 40%\rContinue? ",
    "INFO retry policy (y/n) was applied",
  ]
  const others = [
    "",
    "  \n\t\r\n",
    "Compiling...",
    "[=====>    ] 45%",
    "Building 45%\r",
    "Do you want fries",
    "Would you like this? maybe",
    "cp: overwrite 'b'? ",
    "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
    "Password:",
    "Paste your access token: ",
    "package name: (demo) ",
    "Is this OK? (yes) ",
    "Waiting for you to finish signing in in the browser...",
    "Continue? (y/n)\nworking...",
  ]
  test.each(prompts)("is a prompt: %j", (tail) => expect(ShellStall.looksLikePrompt(tail)).toBe(true))
  test.each(others)("is not a prompt: %j", (tail) => expect(ShellStall.looksLikePrompt(tail)).toBe(false))
})

describe("ShellStall.watch", () => {
  const gone = { _tag: "Shell.NotFoundError" } as const

  /** A fake output the test grows, with the reads and stalls counted. */
  const harness = (initial = "") => {
    const state = { text: initial, tails: 0, stalls: [] as string[], failSize: false, tailFailures: 0 }
    const watcher = ShellStall.watch({
      size: Effect.suspend(() => (state.failSize ? Effect.fail(gone) : Effect.succeed(Buffer.byteLength(state.text)))),
      tail: Effect.suspend(() => {
        state.tails++
        if (state.tailFailures > 0) {
          state.tailFailures--
          return Effect.fail({ _tag: "Other" } as const)
        }
        return Effect.succeed(Buffer.from(state.text).subarray(-ShellStall.TAIL_BYTES).toString("utf8"))
      }),
      onStall: (tail) => Effect.sync(() => void state.stalls.push(tail)),
    })
    return { state, watcher }
  }
  const advance = (seconds: number) =>
    Effect.forEach(Array.from({ length: seconds / 5 }), () =>
      TestClock.adjust("5 seconds").pipe(Effect.andThen(Effect.yieldNow)),
    )

  it.effect("stays silent on a command with no output, reading the tail once per 45 seconds", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness()
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(600)
      expect(state.stalls).toEqual([])
      expect(state.tails).toBe(13)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("fires once, 50 seconds after output that was already there, and never again", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? [y/N] ")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(45)
      expect(state.stalls).toEqual([])
      yield* advance(5)
      expect(state.stalls).toEqual(["Continue? [y/N]"])
      yield* advance(600)
      expect(state.stalls).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("never reads the tail while the output keeps growing", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? ")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* Effect.forEach(Array.from({ length: 20 }), () =>
        Effect.sync(() => (state.text += "x")).pipe(Effect.andThen(advance(30))),
      )
      expect(state.tails).toBe(0)
      expect(state.stalls).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("waits another 45 seconds after a tail that is not a prompt", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Compiling...")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(50)
      expect(state.tails).toBe(1)
      yield* advance(40)
      expect(state.tails).toBe(1)
      state.text += "\nProceed (y/n) "
      yield* advance(50)
      expect(state.stalls).toEqual(["Compiling...\nProceed (y/n)"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("does not fire when it is interrupted before the threshold", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? ")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(40)
      yield* Fiber.interrupt(fiber)
      yield* advance(60)
      expect(state.stalls).toEqual([])
    }),
  )

  it.effect("ends quietly when the shell is gone", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? ")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      state.failSize = true
      yield* advance(100)
      expect(state.stalls).toEqual([])
      expect(fiber.pollUnsafe()).toBeDefined()
    }),
  )

  it.effect("retries a failed tail read at the next check", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? ")
      state.tailFailures = 1
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(50)
      expect(state.tails).toBe(1)
      expect(state.stalls).toEqual([])
      yield* advance(5)
      expect(state.stalls).toEqual(["Continue?"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("gives no second notice when new output ends on another prompt", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness("Continue? [y/N] ")
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(50)
      expect(state.stalls).toHaveLength(1)
      state.text += "\nOverwrite? "
      yield* advance(600)
      expect(state.stalls).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("hands over the last 1024 bytes and finds a prompt on the last line of a large output", () =>
    Effect.gen(function* () {
      const { state, watcher } = harness(`${"line of output\n".repeat(400)}Do you want to continue? [Y/n] \n`)
      const fiber = yield* Effect.forkChild(watcher, { startImmediately: true })
      yield* advance(50)
      expect(state.stalls).toHaveLength(1)
      expect(Buffer.byteLength(state.stalls[0] ?? "")).toBeLessThanOrEqual(1024)
      expect(state.stalls[0]).toEndWith("Do you want to continue? [Y/n]")
      yield* Fiber.interrupt(fiber)
    }),
  )
})
