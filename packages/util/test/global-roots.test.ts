import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { runProgram } from "../../core/test/fixture/run-program.js"

const module = pathToFileURL(path.join(import.meta.dir, "../src/global-roots.ts")).href

describe("global roots", () => {
  test("uses XDG overrides", async () => {
    const root = path.join(os.tmpdir(), "orbit-xdg-overrides")
    const env = {
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    }

    expect(await run(env)).toEqual({
      data: path.join(env.XDG_DATA_HOME, "orbit"),
      cache: path.join(env.XDG_CACHE_HOME, "orbit"),
      config: path.join(env.XDG_CONFIG_HOME, "orbit"),
      state: path.join(env.XDG_STATE_HOME, "orbit"),
      tmp: path.join(os.tmpdir(), "orbit"),
    })
  })

  test("empty XDG overrides use home directory defaults", async () => {
    const home = path.join(os.tmpdir(), "orbit-xdg-home")

    expect(
      await run({
        XDG_DATA_HOME: "",
        XDG_CACHE_HOME: "",
        XDG_CONFIG_HOME: "",
        XDG_STATE_HOME: "",
        ...(process.platform === "win32" ? { USERPROFILE: home } : { HOME: home }),
      }),
    ).toEqual({
      data: path.join(home, ".local", "share", "orbit"),
      cache: path.join(home, ".cache", "orbit"),
      config: path.join(home, ".config", "orbit"),
      state: path.join(home, ".local", "state", "orbit"),
      tmp: path.join(os.tmpdir(), "orbit"),
    })
  })
})

async function run(env: Record<string, string>) {
  const result = await runProgram(
    [
      process.execPath,
      "-e",
      `const { roots } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(roots("orbit")))`,
    ],
    { env: { ...process.env, ...env } },
  )

  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString())
}
