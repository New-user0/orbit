import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { announceTrust } from "../../src/mini/trust.shared"
import { createApi, json } from "../fixture/tui-client"

const untrusted: TrustStatus = {
  directory: "/projects/app",
  trusted: false,
  persistent: true,
  withheld: [
    { path: "/projects/app/.orbit", kinds: ["plugins", "hooks"] },
    { path: "/projects/app/orbit.json", kinds: ["hooks", "mcp"] },
  ],
}

async function announced(respond: (url: URL) => Response) {
  const written: string[] = []
  const requests: string[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url.pathname + url.search)
      return respond(url)
    },
    { preconnect: () => {} },
  )
  await announceTrust({
    sdk: createApi(fetch),
    directory: "/projects/app/packages",
    write: (text) => written.push(text),
  })
  return { written, requests }
}

test("says in one line that the folder is untrusted, what is held back and that orb trust trusts it", async () => {
  const result = await announced(() => json(untrusted))

  expect(result.requests).toEqual(["/api/location/trust?location%5Bdirectory%5D=%2Fprojects%2Fapp%2Fpackages"])
  expect(result.written).toEqual([
    "/projects/app is not trusted, so its project config is held back (plugins, hooks, mcp). " +
      "Run `orb trust` to trust it.\n",
  ])
})

test("names the folder that holds config above the project, which trusting the project does not turn on", async () => {
  const result = await announced(() =>
    json({
      ...untrusted,
      withheld: [
        { path: "/projects/orbit.json", kinds: ["hooks"], directory: "/projects" },
        { path: "/projects/shared/.orbit", kinds: ["plugins", "hooks"], directory: "/projects/shared" },
        ...untrusted.withheld,
      ],
    }),
  )

  expect(result.written).toEqual([
    "/projects/app is not trusted, so its project config is held back (plugins, hooks, mcp). " +
      "Run `orb trust` to trust it. " +
      "Config in a folder above /projects/app stays off until that folder is trusted too (hooks, plugins): " +
      "`orb trust /projects`, `orb trust /projects/shared`.\n",
  ])
})

test("says only what is above the project when the project has no config of its own held back", async () => {
  const withheld = [{ path: "/projects/orbit.json", kinds: ["hooks"], directory: "/projects" }]

  // Whether the project is trusted or not, as neither one turns that config on.
  for (const trusted of [false, true]) {
    const result = await announced(() => json({ ...untrusted, trusted, withheld }))

    expect(result.written).toEqual([
      "Config in a folder above /projects/app stays off until that folder is trusted too (hooks): `orb trust /projects`.\n",
    ])
  }
})

test("quotes a folder whose name has a space in it, as it has to be typed", async () => {
  const result = await announced(() =>
    json({
      ...untrusted,
      trusted: true,
      withheld: [{ path: "/my work/orbit.json", kinds: ["hooks"], directory: "/my work" }],
    }),
  )

  expect(result.written[0]).toContain('`orb trust "/my work"`')
})

test("points a home directory, which orb trust refuses, at the full terminal UI", async () => {
  const result = await announced(() => json({ ...untrusted, directory: "/home/kit", persistent: false }))

  expect(result.written).toHaveLength(1)
  expect(result.written[0]).toContain("/home/kit is not trusted")
  expect(result.written[0]).toContain("`orb trust` refuses this folder; start `orb` to trust it until Orbit restarts.")
})

test.each([
  ["a trusted folder", () => json({ ...untrusted, trusted: true, source: "saved", withheld: [] })],
  ["an untrusted folder that holds nothing back", () => json({ ...untrusted, withheld: [] })],
  ["a server older than workspace trust", () => new Response("not found", { status: 404 })],
  ["a server that fails", () => new Response("unavailable", { status: 503 })],
])("says nothing for %s", async (_, respond) => {
  expect((await announced(respond)).written).toEqual([])
})
