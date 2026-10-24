import path from "path"
import { describe, expect, test } from "bun:test"
import { CompatNames } from "@orbit/compat/names"
import type { CompatRoots } from "@orbit/compat/roots"
import type { ConfigDiscovery } from "@orbit/core/config/discovery"
import { ConfigWatch } from "@orbit/core/config/watch"
import { AbsolutePath } from "@orbit/core/schema"

const ignore = ["node_modules", ".git", "**/{node_modules,.git}/**", "team-memory", "**/team-memory/**"]
const files = (directory: string, names: string[]) => names.map((name) => AbsolutePath.make(path.join(directory, name)))
// A directory's orbit files and .orbit root, as discovery lists them for the project walk and for home.
const level = (directory: string, present: boolean) =>
  ({
    direct: files(directory, ["orbit.json", "orbit.jsonc"]),
    local: files(directory, ["orbit.local.json", "orbit.local.jsonc"]),
    project: [{ path: AbsolutePath.make(path.join(directory, ".orbit")), present }],
  }) satisfies ConfigDiscovery.Level

const project = path.resolve("watch-plan-project")
const root = AbsolutePath.make(path.join(project, ".orbit"))
// The compatibility roots of other agent products, one of each kind, as discovery lists them.
const compat = [
  { path: AbsolutePath.make(path.join(project, CompatNames.vendor.directory)), kind: "vendor", scope: "project" },
  { path: AbsolutePath.make(path.join(project, CompatNames.agents)), kind: "agents", scope: "project" },
] satisfies CompatRoots.Root[]
// No settings file is watched until its root exists, and no MCP file until discovery lists one.
const sources: ConfigDiscovery.Sources = { ...level(project, false), compat, compatSettings: [] }

describe("ConfigWatch.plan", () => {
  test("groups missing candidates and keeps parent watches when roots appear", () => {
    const missing = ConfigWatch.plan(sources)
    expect(Array.from(missing.values())).toEqual([
      {
        path: project,
        type: "entries",
        names: [
          CompatNames.agents,
          CompatNames.vendor.directory,
          ".orbit",
          "orbit.json",
          "orbit.jsonc",
          "orbit.local.json",
          "orbit.local.jsonc",
        ],
      },
    ])
    const present = ConfigWatch.plan({ ...sources, project: [{ path: root, present: true }] })
    expect(Array.from(present.values())).toEqual([{ path: root, type: "directory", ignore }, ...missing.values()])
  })

  test("adds exact watches for explicit files only when not already covered", () => {
    expect(ConfigWatch.plan({ ...sources, explicit: sources.direct[0] })).toEqual(ConfigWatch.plan(sources))
    const present = { ...sources, project: [{ path: root, present: true }] }
    expect(ConfigWatch.plan({ ...present, explicit: AbsolutePath.make(path.join(root, "custom.json")) })).toEqual(
      ConfigWatch.plan(present),
    )
    const directory = path.resolve("watch-plan-external")
    expect(
      Array.from(
        ConfigWatch.plan({ ...sources, explicit: AbsolutePath.make(path.join(directory, "custom.json")) }).values(),
      ),
    ).toContainEqual({ path: directory, type: "entries", names: ["custom.json"] })
  })

  test("watches the compatibility roots beside the config files, and none when there are no roots", () => {
    expect(Array.from(ConfigWatch.plan({ ...sources, compat: [] }).values())).toEqual([
      {
        path: project,
        type: "entries",
        names: [".orbit", "orbit.json", "orbit.jsonc", "orbit.local.json", "orbit.local.jsonc"],
      },
    ])
    // A root in an outer directory, such as the user's own in home, gets a parent watch of its own.
    const home = path.resolve("watch-plan-home")
    const user = {
      path: AbsolutePath.make(path.join(home, CompatNames.agents)),
      kind: "agents",
      scope: "user",
    } as const
    expect(Array.from(ConfigWatch.plan({ ...sources, compat: [...compat, user] }).values())).toContainEqual({
      path: home,
      type: "entries",
      names: [CompatNames.agents],
    })
  })

  test("watches the direct local files beside the shared ones", () => {
    expect(Array.from(ConfigWatch.plan({ ...sources, local: [] }).values())).toEqual([
      {
        path: project,
        type: "entries",
        names: [CompatNames.agents, CompatNames.vendor.directory, ".orbit", "orbit.json", "orbit.jsonc"],
      },
    ])
    // A local file in an outer directory gets a parent watch of its own.
    const outer = path.resolve("watch-plan-outer")
    const outerLocal = { ...sources, local: [...sources.local, ...files(outer, ["orbit.local.json"])] }
    expect(Array.from(ConfigWatch.plan(outerLocal).values())).toContainEqual({
      path: outer,
      type: "entries",
      names: ["orbit.local.json"],
    })
  })

  test("watches the home directory's orbit files and .orbit root", () => {
    const home = path.resolve("watch-plan-home")
    const homeNames = [".orbit", "orbit.json", "orbit.jsonc", "orbit.local.json", "orbit.local.jsonc"]
    const missing = ConfigWatch.plan({ ...sources, home: level(home, false) })
    expect(Array.from(missing.values())).toEqual([
      ...ConfigWatch.plan(sources).values(),
      { path: home, type: "entries", names: homeNames },
    ])
    // A present root gets its own recursive watch beside the parent watch that sees it come and go.
    const present = ConfigWatch.plan({ ...sources, home: level(home, true) })
    expect(Array.from(present.values())).toEqual([
      { path: AbsolutePath.make(path.join(home, ".orbit")), type: "directory", ignore },
      ...missing.values(),
    ])
  })

  test("leaves home-level files to the global watch when it already covers them", () => {
    const global = AbsolutePath.make(path.resolve("watch-plan-global"))
    const home = level(path.join(global, "home"), false)
    expect(ConfigWatch.plan({ ...sources, global, home })).toEqual(ConfigWatch.plan({ ...sources, global }))
  })

  test("watches the settings files that other products keep, in the root that holds them", () => {
    const vendor = path.join(project, CompatNames.vendor.directory)
    const settings = [CompatNames.vendor.settings.shared, CompatNames.vendor.settings.local].map((name) =>
      AbsolutePath.make(path.join(vendor, name)),
    )
    const planned = Array.from(ConfigWatch.plan({ ...sources, compatSettings: settings }).values())

    // The project's own watch still sees the root come and go, and the root gets one for the files inside it.
    expect(planned).toEqual([
      ...ConfigWatch.plan(sources).values(),
      {
        path: vendor,
        type: "entries",
        names: [CompatNames.vendor.settings.shared, CompatNames.vendor.settings.local].toSorted(),
      },
    ])
    // A root of the user's own, in home, is watched where it is.
    const home = path.resolve("watch-plan-home", CompatNames.vendor.directory)
    expect(
      Array.from(
        ConfigWatch.plan({
          ...sources,
          compatSettings: [AbsolutePath.make(path.join(home, CompatNames.vendor.settings.local))],
        }).values(),
      ),
    ).toContainEqual({ path: home, type: "entries", names: [CompatNames.vendor.settings.local] })
  })

  test("watches the MCP file beside the project's config files", () => {
    const mcp = AbsolutePath.make(path.join(project, CompatNames.mcp))

    expect(Array.from(ConfigWatch.plan({ ...sources, compat: [], compatMcp: mcp }).values())).toEqual([
      {
        path: project,
        type: "entries",
        names: [CompatNames.mcp, ".orbit", "orbit.json", "orbit.jsonc", "orbit.local.json", "orbit.local.jsonc"],
      },
    ])
    // Left out of discovery, it is not watched.
    expect(ConfigWatch.plan({ ...sources, compatMcp: undefined })).toEqual(ConfigWatch.plan(sources))
  })
})
