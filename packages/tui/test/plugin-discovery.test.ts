import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { localPluginDirectories, mergePluginTargets, trustedPluginDirectories } from "../src/plugin/discovery"
import { themeDirectories } from "../src/util/config-directories"
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
    start: "/project/packages/app",
  }

  expect(trustedPluginDirectories(directories, false)).toEqual(["/config/plugins"])
  expect(trustedPluginDirectories(directories, true)).toEqual([
    "/config/plugins",
    "/project/.orbit/plugins",
    "/project/packages/app/.orbit/plugins",
  ])
})

// Class 3: the terminal UI finds its project's root on its own, and here that is /code, while the server decided the
// trust for the folder the terminal UI was started in, /code/app (it rejects a marker the walk accepts). Nothing above the
// server's root is read (D7), so the stricter of the two roots wins.
test("a plugin directory above the folder the server decided the trust for is left out", () => {
  const directories = {
    global: ["/config/plugins"],
    project: ["/code/.orbit/plugins", "/code/app/.orbit/plugins", "/code/app/packages/ui/.orbit/plugins"],
    start: "/code/app/packages/ui",
  }

  expect(trustedPluginDirectories(directories, true, "/code/app")).toEqual([
    "/config/plugins",
    "/code/app/.orbit/plugins",
    "/code/app/packages/ui/.orbit/plugins",
  ])
  // The control: a server root that is the terminal UI's own leaves the walk as it is.
  expect(trustedPluginDirectories(directories, true, "/code")).toEqual(["/config/plugins", ...directories.project])
  // A root that only starts with the same letters bounds nothing, and nor does one that is not above the start folder,
  // such as the main checkout of a linked worktree.
  expect(trustedPluginDirectories(directories, true, "/code/ap")).toEqual(["/config/plugins", ...directories.project])
  expect(trustedPluginDirectories(directories, true, "/main")).toEqual(["/config/plugins", ...directories.project])
  // And an untrusted project loads none of its own.
  expect(trustedPluginDirectories(directories, false, "/code/app")).toEqual(["/config/plugins"])
})

// Class 3, end to end on the disk: a `.git` file that names no repository is a marker to the terminal UI's walk, while the
// server takes the start folder as its project (core `project-git-trust.test.ts`, "stops at a .git file that is no
// good"). With that answer, neither the plugins nor the themes of the folder that holds the `.git` file are read.
test("a .git file that the server rejects does not widen the walk past the server's project", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  const app = path.join(project, "app")
  await mkdir(path.join(project, ".orbit", "plugins"), { recursive: true })
  await mkdir(path.join(app, ".orbit", "plugins"), { recursive: true })
  await Bun.write(path.join(project, ".git"), "garbage\n")
  const folders = { config: path.join(root.path, "config"), home: path.join(root.path, "home") }

  const found = await localPluginDirectories(app, folders)
  // The terminal UI's own walk takes the folder with the `.git` file as the root.
  expect(found.root).toBe(project)
  expect(trustedPluginDirectories(found, true, app)).toEqual([
    path.join(folders.config, "plugins"),
    path.join(app, ".orbit", "plugins"),
  ])
  const themes = await themeDirectories({ ...folders, cwd: app, project: { decided: app } })
  expect(themes).not.toContain(path.join(project, ".orbit"))
  expect(themes).toContain(path.join(app, ".orbit"))
  // The control: without the server's answer, the walk reaches the folder with the `.git` file.
  expect(await themeDirectories({ ...folders, cwd: app, project: {} })).toContain(path.join(project, ".orbit"))
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
    start: app,
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
    start: home,
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
