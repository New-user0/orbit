import { expect, test } from "bun:test"
import { ConfigOverlay } from "../src/config-overlay"
import { ServerProcess } from "../src/server-process"

test("a private or foreground server trusts folders only when its environment asks it to", () => {
  for (const mode of ["default", "stdio"] as const) {
    expect(ServerProcess.trustOptions(mode, {})).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "TRUE" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "0" })).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "" })).toEqual({ implicit: false })
  }
})

test("the background service never takes its trust from the environment, which belongs to its first client", () => {
  expect(ServerProcess.trustOptions("service", {})).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: false })
})

test("a server that orb starts puts the managed env into its own environment, and reads the folder the environment names", () => {
  expect(ServerProcess.managedOptions({})).toEqual({ directory: undefined, applyEnv: true })
  expect(ServerProcess.managedOptions({ ORBIT_MANAGED_DIR: "" })).toEqual({ directory: undefined, applyEnv: true })
  expect(ServerProcess.managedOptions({ ORBIT_MANAGED_DIR: "/etc/orbit" })).toEqual({
    directory: "/etc/orbit",
    applyEnv: true,
  })
})

// The CLI hands a private server its run-scoped config in a file. The shared service must never take it, and no server
// leaves the variable in the environment of the processes it starts.
test("a private server reads the overlay file once, deletes it, and removes the variable from its environment", async () => {
  const written = await ConfigOverlay.write({ content: '{"agents":{}}' })
  try {
    for (const mode of ["default", "stdio"] as const) {
      const again = await ConfigOverlay.write({ content: '{"agents":{}}' })
      const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT_FILE: again.file }

      expect(await ServerProcess.takeOverlay(mode, env)).toEqual({ content: '{"agents":{}}', file: undefined })
      expect(env).toEqual({})
      expect(await Bun.file(again.file).exists()).toBe(false)
      await again.remove()
    }
  } finally {
    await written.remove()
  }
})

test("the background service ignores the overlay file, leaves it alone, and does not keep the variable", async () => {
  const written = await ConfigOverlay.write({ content: '{"agents":{"leaked":{"system":"x"}}}' })
  try {
    const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT_FILE: written.file }

    expect(await ServerProcess.takeOverlay("service", env)).toBeUndefined()
    expect(env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
    expect(await Bun.file(written.file).exists()).toBe(true)
  } finally {
    await written.remove()
  }
})

test("a server started without an overlay file takes none", async () => {
  const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT: "{}" }

  expect(await ServerProcess.takeOverlay("default", env)).toBeUndefined()
  expect(env).toEqual({ ORBIT_CONFIG_CONTENT: "{}" })
})
