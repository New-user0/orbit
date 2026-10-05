import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { localPluginDirectories, mergePluginTargets, trustedPluginDirectories } from "../src/plugin/discovery"
import { tmpdir } from "./fixture/fixture"

test("deduplicates equivalent local plugin targets while retaining the final source", () => {
  const directory = "/project"
  const discovered = { entry: "/project/.orbit/plugins/example", install: true, optional: true }
  const server = { entry: "./.orbit/plugins/example", install: false, optional: true }

  expect(mergePluginTargets([discovered, server], directory)).toEqual([server])
})

test("preserves the first target position when a later source overrides it", () => {
  const first = { entry: "example", install: true, optional: true }
  const other = { entry: "other", install: true, optional: true }
  const configured = { entry: { package: "example", options: { enabled: true } }, install: true, optional: false }

  expect(mergePluginTargets([first, other, configured], "/project")).toEqual([configured, other])
})

test("a project's plugin directories wait for its folder to be trusted and the user's never do", () => {
  const directories = {
    global: ["/config/plugins"],
    project: ["/project/.orbit/plugins", "/project/packages/app/.orbit/plugins"],
  }

  expect(trustedPluginDirectories(directories, false)).toEqual(["/config/plugins"])
  expect(trustedPluginDirectories(directories, true)).toEqual([
    "/config/plugins",
    "/project/.orbit/plugins",
    "/project/packages/app/.orbit/plugins",
  ])
})

test("plugin directories are the user's global config directory and the project's own .orbit directories", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  const app = path.join(project, "packages", "app")
  await mkdir(path.join(project, ".git"), { recursive: true })
  await mkdir(path.join(app, ".orbit"), { recursive: true })

  expect(
    await localPluginDirectories(app, { config: path.join(root.path, "config"), home: path.join(root.path, "home") }),
  ).toEqual({
    global: [path.join(root.path, "config", "plugins")],
    // The project's root is always watched, so a plugins directory created there later is seen; one further down only
    // when it exists, and packages has none.
    project: [path.join(project, ".orbit", "plugins"), path.join(app, ".orbit", "plugins")],
  })
})

test("the .orbit directory in the home directory is the user's own, even inside a project's walk", async () => {
  await using root = await tmpdir()
  const home = path.join(root.path, "home")
  await mkdir(path.join(root.path, ".git"), { recursive: true })
  await mkdir(path.join(home, ".orbit"), { recursive: true })

  expect(await localPluginDirectories(home, { config: path.join(root.path, "config"), home })).toEqual({
    global: [path.join(root.path, "config", "plugins"), path.join(home, ".orbit", "plugins")],
    project: [path.join(root.path, ".orbit", "plugins")],
  })
})
