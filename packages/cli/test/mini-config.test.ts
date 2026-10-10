import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { Effect, Option } from "effect"
import { expect, mock, spyOn, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Config } from "../src/config"
import type { MiniCommandInput } from "../src/mini"
import { ORBIT_VERSION } from "../src/version"

// Runs the mini handler against a config folder that holds `files`, and returns what it handed to the runtime and what it
// printed to stderr on the way.
async function runHandler(files: Record<string, string>, root: string) {
  const configDirectory = path.join(root, "config")
  const stateDirectory = path.join(root, "state")
  await mkdir(configDirectory, { recursive: true })
  await Promise.all(Object.entries(files).map(([name, text]) => Bun.write(path.join(configDirectory, name), text)))
  let received: MiniCommandInput["tuiConfig"]
  const mini = await import("../src/mini")
  mock.module("../src/mini", () => ({
    ...mini,
    validateMiniTerminal() {},
    runMini(input: Pick<MiniCommandInput, "tuiConfig">) {
      received = input.tuiConfig
      return Promise.resolve()
    },
  }))
  const handler = (await import("../src/commands/handlers/mini")).default
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] }),
  })
  const printed: string[] = []
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    printed.push(String(chunk))
    return true
  })

  try {
    await Effect.runPromise(
      handler({
        server: Option.some(server.url.toString()),
        settings: [],
        standalone: false,
        continue: false,
        session: Option.none(),
        fork: false,
        replay: true as never,
        replayLimit: Option.none(),
        model: Option.none(),
        agent: Option.none(),
        prompt: Option.none(),
        demo: false,
      }).pipe(
        Effect.provide(Config.layer),
        Effect.provide(Global.layerWith({ config: configDirectory, state: stateDirectory })),
        Effect.provide(NodeFileSystem.layer),
        Effect.scoped,
      ),
    )
    return { config: await received, printed: printed.join(""), file: path.join(configDirectory, "keybindings.json") }
  } finally {
    stderr.mockRestore()
    server.stop(true)
    mock.restore()
  }
}

test("mini handler passes resolved CLI keybinds to the runtime", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim())

  try {
    const { config } = await runHandler(
      {
        "cli.json": JSON.stringify({
          keybinds: { "composer.subagent.interrupt": "ctrl+i" },
          leader: { timeout: 321 },
        }),
      },
      root,
    )

    expect(config?.leader.timeout).toBe(321)
    expect(config?.keybinds.get("composer.subagent.interrupt")).toMatchObject([{ key: "ctrl+i" }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mini handler applies the keybindings file and prints what it left out before the footer starts", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim())

  try {
    const { config, printed, file } = await runHandler(
      {
        "cli.json": JSON.stringify({ keybinds: { "session.new": "ctrl+n" } }),
        "keybindings.json": JSON.stringify({
          bindings: { "session.new": "ctrl+alt+n", "no.such.command": "ctrl+z" },
          contexts: { mini: { "prompt.clear": "ctrl+alt+x" } },
        }),
      },
      root,
    )

    // The file wins over cli.json, and the mini context reaches the keymap the footer is built on.
    expect(config?.keybinds.get("session.new")).toMatchObject([{ key: "ctrl+alt+n" }])
    expect(config?.keybinds.override("mini", "prompt.clear")).toMatchObject([{ key: "ctrl+alt+x" }])
    expect(printed).toContain(`Keybindings file ${file}:`)
    expect(printed).toContain('"no.such.command" is not a command')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mini handler says nothing about a keybindings file that is not there", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim())

  try {
    const { config, printed } = await runHandler({ "cli.json": JSON.stringify({ leader: { timeout: 321 } }) }, root)

    expect(config?.leader.timeout).toBe(321)
    expect(printed).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
