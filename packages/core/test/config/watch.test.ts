import path from "path"
import { describe, expect, test } from "bun:test"
import { CompatNames } from "@orbit/compat/names"
import type { CompatRoots } from "@orbit/compat/roots"
import type { ConfigDiscovery } from "@orbit/core/config/discovery"
import { ConfigWatch } from "@orbit/core/config/watch"
import { AbsolutePath } from "@orbit/core/schema"

const ignore = ["node_modules", ".git", "**/{node_modules,.git}/**"]
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
const sources: ConfigDiscovery.Sources = { ...level(project, false), compat }

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
})
