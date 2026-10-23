import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Orbit } from "@orbit/client/promise"
import { runMiniFrontend } from "../../src/mini/index"
import type { MiniHost } from "../../src/mini/types"
import { createApi, json } from "../fixture/tui-client"
import { createFooterApiFixture } from "./fixture/footer-api"
import { stubCatalogLists } from "./fixture/catalog"

afterEach(() => {
  mock.restore()
})

// trust-first: `orb mini` stops in a folder that is not trusted before it hands the terminal over (class 12). The refusal
// goes to stderr, nothing goes to stdout, no session is looked up or created, and the Mini ends with status 1, which
// `orb mini` exits with. `trust-first.shared.test.ts` pins the words of the refusal; this pins what the Mini does with it.
function host(written: { stdout: string[]; stderr: string[] }): MiniHost {
  return {
    version: "local",
    terminal: { stdin: process.stdin },
    platform: "linux",
    stdout: { write: (value) => void written.stdout.push(value) },
    stderr: { write: (value) => void written.stderr.push(value) },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: "/home/test" },
    signals: {
      sigint: { subscribe: () => () => {} },
      sigusr2: { subscribe: () => () => {} },
    },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: {
      resolveVariant: async () => undefined,
      saveVariant: async () => {},
    },
  }
}

test("an untrusted folder ends the Mini with status 1 and the refusal on stderr, before any session", async () => {
  const written = { stdout: [] as string[], stderr: [] as string[] }
  const looked: string[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      looked.push(url.pathname)
      if (url.pathname === "/api/location/trust")
        return json({ directory: "/projects/app", trusted: false, persistent: true, withheld: [], changed: [] })
      return new Response("not found", { status: 404 })
    },
    { preconnect: () => {} },
  )
  const targets: string[] = []

  const result = await runMiniFrontend({
    host: host(written),
    sdk: createApi(fetch),
    directory: "/projects/app",
    target: async () => {
      targets.push("target")
      throw new Error("no session is looked up in a folder that is not trusted")
    },
    agent: undefined,
    model: undefined,
    variant: undefined,
    files: [],
  })

  expect(result).toEqual({ exitCode: 1 })
  expect(written.stderr.join("")).toContain("/projects/app is not trusted")
  expect(written.stderr.join("")).toEndWith("\n")
  expect(written.stdout).toEqual([])
  expect(targets).toEqual([])
  expect(looked).toEqual(["/api/location/trust"])
})

// Class 3: in a trusted folder the Mini starts, and the folder the server decided trust for reaches the lifecycle, which
// bounds the theme walk by it (`theme-project.test.ts`). The server's folder is not the one the Mini asked about here, as
// when its own walk would take a marker the server rejects.
test("a trusted folder starts the Mini, with the folder the server decided trust for", async () => {
  const written = { stdout: [] as string[], stderr: [] as string[] }
  const sdk = Orbit.make({ baseUrl: "https://orbit.test" })
  stubCatalogLists(sdk)
  spyOn(sdk.location.trust, "get").mockResolvedValue({
    directory: "/projects/app/packages",
    trusted: true,
    persistent: true,
    source: "saved",
    withheld: [],
  } as never)
  const api = createFooterApiFixture({ events: [] }).api
  const roots: Array<string | undefined> = []

  const result = await runMiniFrontend(
    {
      host: host(written),
      sdk,
      directory: "/projects/app/packages/web",
      target: async () => ({
        sessionID: "ses_root",
        location: {
          directory: "/projects/app/packages/web",
          project: { id: "pro-1", directory: "/projects/app/packages", canonical: "/projects/app/packages" },
        },
        agent: "build",
        model: undefined,
        variant: undefined,
        resume: false,
      }),
      agent: "build",
      model: undefined,
      variant: undefined,
      files: [],
    },
    {
      createRuntimeLifecycle: async (input) => {
        roots.push(input.root)
        return {
          footer: api,
          onResize: () => () => {},
          refreshTheme: () => {},
          setTitle: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }
      },
      streamTransport: Promise.resolve({
        createSessionTransport: async () => {
          api.close()
          return {
            runPromptTurn: async () => {},
            admitPromptTurn: async () => {},
            waitForIdle: async () => {},
            interruptActiveTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }
        },
        formatUnknownError: (error: unknown) => String(error),
      }),
    },
  )

  expect(result).toEqual({ exitCode: 0 })
  expect(written.stderr).toEqual([])
  expect(roots).toEqual(["/projects/app/packages"])
})
