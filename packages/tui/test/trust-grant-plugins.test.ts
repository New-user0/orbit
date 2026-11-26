import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect, Exit, Scope } from "effect"
import { startServer } from "../../server/test/fixture/server"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json, type FetchHandler } from "./fixture/tui-client"
import { waitForFrame } from "./fixture/frame"

// Class 3, the terminal UI's cell: the trust dialog grants, and the folder's providers and plugins start again after a
// grant. The server's grant answers once they have (server/test/trust-grant-models.test.ts), and the dialog closes on
// that answer, so from the moment it closes the folder's plugin runs and its models are listed. The trust routes reach a
// real server for a real repository; the rest of the app is scripted as in trust-first.test.ts. The plugin takes 1.5 s
// to start and the plugin list answers from what runs now, so a grant that answered before the plugins started shows.
test("when the trust dialog closes on its grant, the folder's plugin runs and its models are listed", async () => {
  await using state = await tmpdir()
  await using tmp = await tmpdir()
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

    // The app's own folder is the scripted one; its trust reads and its grant are asked of the server for the repository.
    const proxy: FetchHandler = async (url, request) => {
      if (url.pathname !== "/api/location/trust") return undefined
      const target = new URL(`${url.pathname}${url.search}`, server.base)
      target.searchParams.set("location[directory]", folders.repo)
      const response = await fetch(target, {
        method: request.method,
        headers: { ...server.headers, "content-type": "application/json" },
        body: request.method === "POST" ? await request.text() : undefined,
      })
      return json(await response.json(), { status: response.status })
    }
    await using setup = await createAppFixture({ state: state.path, fetch: proxy })
    await waitForFrame(setup, (frame) => frame.includes("Trust this folder?"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("Trust this folder?"))

    expect(await read()).toEqual({ runs: true, lists: true })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}, 60_000)
