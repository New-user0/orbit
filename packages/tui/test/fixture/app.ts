import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import type { TuiInput } from "../../src/app"
import type { Config } from "../../src/config"
import { clearDrafts } from "../../src/component/prompt/draft-stash"
import { tmpdir } from "./fixture"
import { createEventStream, createFetch, type FetchHandler } from "./tui-client"

export async function createAppFixture(
  input: {
    width?: number
    height?: number
    state?: string
    config?: Config.Info
    /** What `config.update` does; the default changes nothing. A test passes its own to see the draft it is given. */
    update?: (update: (draft: any) => void) => Promise<Config.Info>
    /** Where cli.json would be. The keybindings file is read from beside it. */
    configPath?: string
    args?: TuiInput["args"]
    fetch?: FetchHandler
    /** How a package spec becomes a folder; a test passes its own to see which specs the TUI asks for. */
    packages?: TuiInput["packages"]
    /** Where log lines go; a test passes its own to see what was logged. */
    log?: TuiInput["log"]
    /** The clipboard the app reads and writes; a test passes its own. */
    clipboard?: TuiInput["clipboard"]
  } = {},
) {
  const { run } = await import("../../src/app")
  const state = input.state ? undefined : await tmpdir()
  const setup = await createTestRenderer({
    width: input.width ?? 100,
    height: input.height ?? 30,
    useThread: false,
    kittyKeyboard: true,
  })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  // The terminal UI sets the process's exit status when a person declines to trust its folder; the test process's own
  // status is put back when the app is disposed.
  const exitCode = process.exitCode
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        path: input.configPath,
        get: async () => input.config ?? { animations: false },
        update: input.update ?? (async () => ({})),
      },
      packages: input.packages ?? { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: input.args ?? {},
      log: input.log ?? (() => {}),
      clipboard: input.clipboard,
    }).pipe(
      Effect.provide(Global.layerWith({ state: input.state ?? state?.path })),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    events,
    ready: ready.promise,
    /** Settles when the terminal UI has ended and done what it does at the end. */
    ended: task,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        // Drafts live in a module-level stash, so they would reach the next app of the same process.
        clearDrafts()
        // Bun ignores an assignment of undefined, so the status before the app was nothing becomes 0.
        process.exitCode = exitCode ?? 0
        await server.stop()
        await state?.[Symbol.asyncDispose]()
      }
    },
  }
}

/** Whether the prompt's footer has rendered: the pinned banner also names the commands key, inside its frame. */
export function promptReady(frame: string) {
  return /^[^│]*commands/m.test(frame)
}
