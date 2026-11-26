import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect, Exit, Scope } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { startServer } from "../../server/test/fixture/server"
import { isolatedEnv } from "./fixture/environment"
import { startSlot } from "./fixture/start-gate"

// Class 3, the `orb trust` cell: a folder's providers and plugins start again after a grant, and the server's grant
// answers once they have (server/test/trust-grant-models.test.ts). `orb trust` prints "Trusted" when that answer
// arrives, so from the moment it says so the folder's plugin runs and its models are listed. The server runs in this
// process, so both are read as soon as the line is written, before `orb trust` has even ended. The plugin list answers
// from what runs now without waiting for an activation under way, and the plugin takes 1.5 s to start, so a grant that
// answered before the plugins started shows.
test("when orb trust says Trusted, the folder's plugin runs and its models are listed", async () => {
  await using tmp = await tmpdir("orbit-cli-trust-grant-models-")
  const folders = { config: path.join(tmp.path, "config"), repo: path.join(tmp.path, "repo") }
  await fs.mkdir(folders.config, { recursive: true })
  await Bun.write(
    path.join(folders.repo, "orbit.json"),
    JSON.stringify({
      providers: {
        clone: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "secret", baseURL: "http://127.0.0.1:9/v1" },
          models: { "clone-model": {} },
        },
      },
    }),
  )
  await Bun.write(
    path.join(folders.repo, ".orbit/plugins/greeter.ts"),
    `export default { id: "greeter", async setup() { await new Promise((resolve) => setTimeout(resolve, 1500)) } }`,
  )
  const scope = await Effect.runPromise(Scope.make())
  try {
    const server = await Effect.runPromise(
      startServer(folders.config, { trust: { implicit: false } }).pipe(Scope.provide(scope)),
    )
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    const read = async () => ({
      runs: (await api.plugin.list({ location })).data.some(
        (plugin) => plugin.id === "greeter" && plugin.state.status === "active",
      ),
      lists: (await api.model.list({ location })).data.some(
        (model) => model.providerID === "clone" && model.id === "clone-model",
      ),
    })
    // The control: before the grant the folder's plugin and provider are held back.
    expect(await read()).toEqual({ runs: false, lists: false })

    const run = await startSlot(async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../src/index.ts"),
          "trust",
          folders.repo,
          "--server",
          server.base,
        ],
        {
          // The CLI's own folder, whose bunfig and tsconfig run src/index.ts; the folder to trust is the argument.
          cwd: path.join(import.meta.dir, ".."),
          env: isolatedEnv(tmp.path, { ORBIT_PASSWORD: "secret", ORBIT_TRUST_PROJECT: undefined }),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 60_000,
        },
      )
      const stderr = new Response(child.stderr).text()
      const decoder = new TextDecoder()
      let stdout = ""
      let state: { runs: boolean; lists: boolean } | undefined
      for await (const chunk of child.stdout) {
        stdout += decoder.decode(chunk, { stream: true })
        if (state === undefined && stdout.includes("Trusted")) state = await read()
      }
      return { stdout, stderr: await stderr, code: await child.exited, state }
    })
    expect(run).toMatchObject({ code: 0, state: { runs: true, lists: true } })
    expect(run.stdout).toContain(`Trusted ${folders.repo}`)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}, 120_000)
