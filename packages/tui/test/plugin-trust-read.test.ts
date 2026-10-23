import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createRoot } from "solid-js"
import { createTrustStatus } from "../src/context/trust"
import { discoverPluginTargets } from "../src/plugin/discovery"
import { pluginTrust } from "../src/util/trust"
import { tmpdir } from "./fixture/fixture"

// The plugin loader decides from the answer of the read it just made, not from the status the context shares: that one
// keeps the last answer when a read fails or times out, and drops an answer that a newer read overtook.

const trusted: TrustStatus = { directory: "/p", trusted: true, persistent: true, withheld: [] }
// The same folder after `orb trust --revoke`.
const revoked: TrustStatus = { ...trusted, trusted: false }

function reading(answers: Array<() => Promise<TrustStatus>>) {
  let index = 0
  const client = {
    api: { location: { trust: { get: () => answers[index++]!() } } },
    event: { on: () => () => {} },
  }
  const warned: unknown[] = []
  return createRoot((dispose) => ({
    dispose,
    warned,
    status: createTrustStatus({
      client: client as never,
      log: { warn: (...rest: unknown[]) => warned.push(rest) } as never,
      directory: () => "/p",
    }),
  }))
}

test("a read returns its own answer, and the shared status follows it", async () => {
  const fixture = reading([async () => trusted, async () => revoked])
  try {
    // The first read is the one the effect on the directory makes.
    expect(await fixture.status.refresh()).toEqual(revoked)
    expect(fixture.status.status()).toEqual(revoked)
  } finally {
    fixture.dispose()
  }
})

test("a read that fails answers nothing, and the status keeps the last answer: the loader must not use that one", async () => {
  const fixture = reading([
    async () => trusted,
    async () => Promise.reject(new Error("connection dropped")),
  ])
  try {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fixture.status.status()).toEqual(trusted)
    expect(await fixture.status.refresh()).toBeUndefined()
    expect(fixture.status.status()).toEqual(trusted)
    expect(fixture.warned.length).toBe(1)
    // With no answer, no project plugin loads.
    expect(pluginTrust(undefined)).toEqual({ trusted: false, root: undefined })
  } finally {
    fixture.dispose()
  }
})

test("a read that a newer one overtook still returns what it read", async () => {
  let release: (status: TrustStatus) => void = () => {}
  const slow = new Promise<TrustStatus>((resolve) => (release = resolve))
  const fixture = reading([async () => trusted, () => slow, async () => trusted])
  try {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const first = fixture.status.refresh()
    // A newer read starts and finishes before the first one answers.
    await fixture.status.refresh()
    release(revoked)
    // The shared status does not take the older answer, but the caller that asked gets it.
    expect(await first).toEqual(revoked)
    expect(fixture.status.status()).toEqual(trusted)
    expect(pluginTrust(await first).trusted).toBe(false)
  } finally {
    fixture.dispose()
  }
})

// D8: a server older than this client can still list the plugins that changed since the grant; they load all the same.
test("what the loader takes from a status is the trust and the folder it was decided for", () => {
  expect(pluginTrust(trusted)).toEqual({ trusted: true, root: "/p" })
  expect(pluginTrust(revoked)).toEqual({ trusted: false, root: "/p" })
  const older = {
    ...trusted,
    withheld: [{ path: "/p/.orbit", kinds: ["plugins"] }],
    changed: [{ path: "/p/.orbit", kinds: ["plugins"] }],
  } as TrustStatus
  expect(pluginTrust(older)).toEqual({ trusted: true, root: "/p" })
})

test("a project plugin that a link leads out of the project is not discovered, and one that stays is", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  const outside = path.join(root.path, "elsewhere", "plug")
  const inside = path.join(project, "tools", "plug")
  const plugins = path.join(project, ".orbit", "plugins")
  await mkdir(outside, { recursive: true })
  await mkdir(inside, { recursive: true })
  await mkdir(plugins, { recursive: true })
  await writeFile(path.join(outside, "server.ts"), "export default 1\n")
  await writeFile(path.join(inside, "server.ts"), "export default 1\n")
  await symlink(outside, path.join(plugins, "out"), "junction")
  await symlink(inside, path.join(plugins, "in"), "junction")

  expect((await discoverPluginTargets([plugins], project)).map((item) => path.basename(item))).toEqual(["in"])
  // Without a bound, which is the user's own directories, both are found.
  expect((await discoverPluginTargets([plugins])).map((item) => path.basename(item))).toEqual(["in", "out"])

  // A plugins folder that is itself a link out leaves all of its plugins out.
  const linked = path.join(project, "other", ".orbit", "plugins")
  await mkdir(path.dirname(linked), { recursive: true })
  await symlink(path.join(root.path, "elsewhere"), linked, "junction")
  expect(await discoverPluginTargets([linked], project)).toEqual([])
})

test("a node_modules folder in a plugins folder is not a plugin, and the folder beside it is", async () => {
  await using root = await tmpdir()
  const plugins = path.join(root.path, "plugins")
  await mkdir(path.join(plugins, "node_modules", "dep"), { recursive: true })
  await mkdir(path.join(plugins, "real"), { recursive: true })
  expect((await discoverPluginTargets([plugins])).map((item) => path.basename(item))).toEqual(["real"])
})
