import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { writePluginConfig } from "../src/commands/handlers/plugin/add"
import { removePluginConfig } from "../src/commands/handlers/plugin/remove"
import { tmpdir } from "../../core/test/fixture/tmpdir"

// `orb plugin add` and `orb plugin remove` write the global config whole, through a temporary file renamed over it. A
// server or TUI that reloads the config holds it open for a moment, and on Windows a rename over an open file fails, so
// the write waits for the reader (packages/util/src/replace-file.ts) instead of failing the command.
test("plugin add and remove write the config whole while a reader still has it open", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "config", "orbit.jsonc")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, '{\n  // kept\n  "shell": "bash"\n}\n')

  const reader = await fs.open(file, "r")
  const released = Bun.sleep(300).then(() => reader.close())
  expect(await writePluginConfig(file, "orbit-plugin-demo")).toBe(true)
  await released
  expect(await fs.readFile(file, "utf8")).toBe('{\n  // kept\n  "shell": "bash",\n  "plugins": [\n    "orbit-plugin-demo"\n  ]\n}\n')
  expect(await writePluginConfig(file, "orbit-plugin-demo")).toBe(false)

  const again = await fs.open(file, "r")
  const freed = Bun.sleep(300).then(() => again.close())
  expect(await removePluginConfig(file, "orbit-plugin-demo")).toBe(true)
  await freed
  expect(await fs.readFile(file, "utf8")).toBe('{\n  // kept\n  "shell": "bash",\n  "plugins": []\n}\n')
  expect(await removePluginConfig(file, "orbit-plugin-demo")).toBe(false)
  expect(await fs.readdir(path.dirname(file))).toEqual(["orbit.jsonc"])
}, 30_000)
