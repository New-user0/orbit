import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
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

  expect(trustedPluginDirectories(directories, false, [])).toEqual(["/config/plugins"])
  expect(trustedPluginDirectories(directories, true, [])).toEqual([
    "/config/plugins",
    "/project/.orbit/plugins",
    "/project/packages/app/.orbit/plugins",
  ])
})

test("a plugin directory in a folder above the project waits for that folder's own decision", () => {
  // The terminal UI finds its project's root on its own, and here that is /code, while the server's project is the
  // folder the terminal UI was started in, /code/app. The server holds /code back, as a folder above its project.
  const directories = {
    global: ["/config/plugins"],
    project: ["/code/.orbit/plugins", "/code/app/.orbit/plugins", "/code/app/packages/ui/.orbit/plugins"],
  }

  expect(trustedPluginDirectories(directories, true, ["/code"])).toEqual([
    "/config/plugins",
    "/code/app/.orbit/plugins",
    "/code/app/packages/ui/.orbit/plugins",
  ])
  // The project's own directories are not named by what is held back above it, and neither is a folder that only
  // starts with the same letters.
  expect(trustedPluginDirectories(directories, true, ["/code/ap", "/co"])).toEqual([
    "/config/plugins",
    ...directories.project,
  ])
  // Once that folder is trusted the server stops listing it, and the plugins in it load.
  expect(trustedPluginDirectories(directories, true, [])).toEqual(["/config/plugins", ...directories.project])
  // And an untrusted project loads none of its own, whatever is held back.
  expect(trustedPluginDirectories(directories, false, ["/code"])).toEqual(["/config/plugins"])
})

test("a directory whose plugins changed since the folder was trusted waits, and the folder's other directories load", () => {
  const directories = {
    global: ["/config/plugins"],
    project: ["/project/.orbit/plugins", "/project/packages/app/.orbit/plugins"],
  }

  expect(trustedPluginDirectories(directories, true, [], ["/project/packages/app/.orbit"])).toEqual([
    "/config/plugins",
    "/project/.orbit/plugins",
  ])
  // Only the directory named is held, not one whose path merely starts the same way.
  expect(trustedPluginDirectories(directories, true, [], ["/project/.orb"])).toEqual([
    "/config/plugins",
    ...directories.project,
  ])
  // Once the changes are trusted the server stops listing it.
  expect(trustedPluginDirectories(directories, true, [], [])).toEqual(["/config/plugins", ...directories.project])
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
    root: project,
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
    root: root.path,
  })
})

// The startup walk runs before any trust answer. A folder can ship `.git`, `.hg` or a `.orbit` as a link to a share, and a
// stat through it connects to a host the folder chose; a link that loops must cost only itself. Only Windows has links to
// shares, so those rows run there (they need the right to make a link, and skip without it).
const windows = process.platform === "win32"

for (const name of [".git", ".hg", ".orbit"])
  test(
    `${name} that is a link to a share is not followed by the startup walk`,
    async () => {
      if (!windows) return
      await using root = await tmpdir()
      const project = path.join(root.path, "project")
      const app = path.join(project, "app")
      await mkdir(app, { recursive: true })
      if (name !== ".git") await mkdir(path.join(project, ".git"))
      const made = await symlink("\\\\192.0.2.211\\share", path.join(name === ".orbit" ? app : project, name), "dir").then(
        () => true,
        () => false,
      )
      if (!made) return
      const started = Date.now()
      const found = await localPluginDirectories(app, {
        config: path.join(root.path, "c"),
        home: path.join(root.path, "h"),
      })
      // Followed, the link takes about 40 seconds to fail.
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(found.root).toBe(project)
      expect(found.project).not.toContain(path.join(app, ".orbit", "plugins"))
    },
    60_000,
  )

test("a .hg link that loops costs only itself", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  await mkdir(path.join(project, ".git"), { recursive: true })
  const made = await symlink(path.join(project, ".hg"), path.join(project, ".hg"), "dir").then(
    () => true,
    () => false,
  )
  if (!made) return
  const found = await localPluginDirectories(project, {
    config: path.join(root.path, "c"),
    home: path.join(root.path, "h"),
  })
  expect(found.root).toBe(project)
})

test("a plain .hg folder is still a repository marker", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  await mkdir(path.join(project, ".hg"), { recursive: true })
  await mkdir(path.join(project, "app"))
  const found = await localPluginDirectories(path.join(project, "app"), {
    config: path.join(root.path, "c"),
    home: path.join(root.path, "h"),
  })
  expect(found.root).toBe(project)
})
