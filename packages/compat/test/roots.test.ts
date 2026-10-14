import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { CompatRoots } from "../src/roots.js"
import { live } from "./fixture/effect.js"
import { inFixture, services } from "./fixture/services.js"
import { tmpdirScoped, write } from "./fixture/tmpdir.js"

// Each root as `scope:kind:path`, with the path relative to the fixture so expectations read without the temporary
// directory.
const labels = (fixture: string, roots: readonly CompatRoots.Root[]) =>
  roots.map((root) => `${root.scope}:${root.kind}:${path.relative(fixture, root.path).split(path.sep).join("/")}`)

const discover = (fixture: string, home: string, directories: readonly string[], global = true) =>
  CompatRoots.discover({ directories, global }).pipe(Effect.provide(services(fixture, home)))

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )

const link = (target: string, location: string) =>
  Effect.promise(() => fs.symlink(target, location, process.platform === "win32" ? "junction" : undefined))

describe("CompatRoots.discover", () => {
  live("lists the user's roots first, then the project's from the outermost to the innermost", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const repo = path.join(fixture, "repo")
      const app = path.join(repo, "packages", "app")
      yield* write([home, app])

      // Vendor roots rank below .agents roots, and within a kind a later root wins.
      expect(labels(fixture, yield* discover(fixture, home, [app, path.dirname(app), repo]))).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:repo/.claude",
        "project:vendor:repo/packages/.claude",
        "project:vendor:repo/packages/app/.claude",
        "user:agents:home/.agents",
        "project:agents:repo/.agents",
        "project:agents:repo/packages/.agents",
        "project:agents:repo/packages/app/.agents",
      ])
    }),
  )

  live("lists roots that do not exist yet, so a watcher can see them appear", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const repo = path.join(fixture, "repo")
      yield* write([home, repo])

      const roots = yield* discover(fixture, home, [repo])

      expect(labels(fixture, roots)).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:repo/.claude",
        "user:agents:home/.agents",
        "project:agents:repo/.agents",
      ])
      for (const root of roots) expect(yield* exists(root.path)).toBe(false)
    }),
  )

  live("lists no project roots when there is nothing to walk", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      yield* write([home])

      expect(labels(fixture, yield* discover(fixture, home, []))).toEqual([
        "user:vendor:home/.claude",
        "user:agents:home/.agents",
      ])
      expect(yield* discover(fixture, home, [], false)).toEqual([])
    }),
  )

  live("lists the roots in the home directory once when the walk passes through home", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const project = path.join(home, "project")
      yield* write([path.join(home, ".claude"), path.join(home, ".agents"), project])

      // home is the user's own: its roots are user scope however the walk reaches them, and never project scope.
      expect(labels(fixture, yield* discover(fixture, home, [project, home, fixture]))).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:.claude",
        "project:vendor:home/project/.claude",
        "user:agents:home/.agents",
        "project:agents:.agents",
        "project:agents:home/project/.agents",
      ])
    }),
  )

  live("leaves out the home directory's roots, and anything inside them, when global is off", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const project = path.join(home, "project")
      yield* write([path.join(home, ".claude"), path.join(home, ".agents"), project])

      expect(labels(fixture, yield* discover(fixture, home, [project, home, fixture], false))).toEqual([
        "project:vendor:.claude",
        "project:vendor:home/project/.claude",
        "project:agents:.agents",
        "project:agents:home/project/.agents",
      ])
    }),
  )

  live("does not list a project root that is a link to the user's own root", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const repo = path.join(fixture, "repo")
      yield* write([path.join(home, ".claude"), repo])
      yield* link(path.join(home, ".claude"), path.join(repo, ".claude"))

      expect(labels(fixture, yield* discover(fixture, home, [repo]))).toEqual([
        "user:vendor:home/.claude",
        "user:agents:home/.agents",
        "project:agents:repo/.agents",
      ])
      // With global off the linked root is still the user's own, so it stays out.
      expect(labels(fixture, yield* discover(fixture, home, [repo], false))).toEqual(["project:agents:repo/.agents"])
    }),
  )

  live("does not list a project root that is a link to the global config directory", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const repo = path.join(fixture, "repo")
      yield* write([home, repo, path.join(fixture, "config")])
      yield* link(path.join(fixture, "config"), path.join(repo, ".agents"))

      expect(labels(fixture, yield* discover(fixture, home, [repo]))).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:repo/.claude",
        "user:agents:home/.agents",
      ])
      expect(labels(fixture, yield* discover(fixture, home, [repo], false))).toEqual(["project:vendor:repo/.claude"])
    }),
  )

  live("treats a symlinked spelling of home as home, even for roots that do not exist", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const linked = path.join(fixture, "linked")
      yield* write([path.join(home, "project")])
      yield* link(home, linked)

      // The walk spells home as `linked`. Nothing exists there, yet its roots must not come back as project roots.
      const roots = yield* discover(fixture, home, [path.join(linked, "project"), linked, fixture])

      expect(labels(fixture, roots)).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:.claude",
        "project:vendor:linked/project/.claude",
        "user:agents:home/.agents",
        "project:agents:.agents",
        "project:agents:linked/project/.agents",
      ])
    }),
  )

  live("lists the roots of every directory a real upward walk visits", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const project = path.join(home, "project")
      yield* write([path.join(home, ".claude"), path.join(home, ".agents"), project])

      const roots = yield* Effect.gen(function* () {
        const filesystem = yield* FSUtil.Service
        const directories = yield* filesystem.up({ targets: ["."], start: project }).pipe(Effect.orDie)
        return yield* CompatRoots.discover({ directories, global: true })
      }).pipe(Effect.provide(services(fixture, home)))

      // The machine running the test may keep roots of its own above the fixture.
      expect(
        labels(
          fixture,
          roots.filter((root) => inFixture(fixture, root.path)),
        ),
      ).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:.claude",
        "project:vendor:home/project/.claude",
        "user:agents:home/.agents",
        "project:agents:.agents",
        "project:agents:home/project/.agents",
      ])
    }),
  )
})

// Windows ignores path case, but realpath keeps the spelling it is given: a child started with a lowercase cwd walks
// c:\users\om while Global.home says C:\Users\Om. Both spellings must still be recognized as the same home directory.
describe.skipIf(process.platform !== "win32")("CompatRoots.discover with differently cased paths", () => {
  live("recognizes the home directory when the location spells it differently", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      yield* write([path.join(home, ".claude"), path.join(home, ".agents"), path.join(home, "project")])
      const project = path.join(fixture, "HOME", "project")

      expect(labels(fixture, yield* discover(fixture, home, [project, path.dirname(project)]))).toEqual([
        "user:vendor:home/.claude",
        "project:vendor:HOME/project/.claude",
        "user:agents:home/.agents",
        "project:agents:HOME/project/.agents",
      ])
      expect(labels(fixture, yield* discover(fixture, home, [project, path.dirname(project)], false))).toEqual([
        "project:vendor:HOME/project/.claude",
        "project:agents:HOME/project/.agents",
      ])
    }),
  )

  live("recognizes the home directory when Global.home spells it differently", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "HOME")
      yield* write([path.join(fixture, "home", ".claude"), path.join(fixture, "home", ".agents")])
      yield* write([path.join(fixture, "home", "project")])
      const project = path.join(fixture, "home", "project")

      expect(labels(fixture, yield* discover(fixture, home, [project, path.dirname(project)]))).toEqual([
        "user:vendor:HOME/.claude",
        "project:vendor:home/project/.claude",
        "user:agents:HOME/.agents",
        "project:agents:home/project/.agents",
      ])
    }),
  )

  // A run with an isolated home (ORBIT_TEST_HOME) sits in a temporary folder on a machine whose real user keeps
  // settings files of their own above it. The walk stops one folder above the isolated home, so fixtures never see them.
  live("an isolated home keeps the walk from reading foreign settings above the test folders", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const outer = path.join(fixture, "outer")
      const inner = path.join(outer, "inner")
      const home = path.join(inner, "home")
      const repo = path.join(inner, "repo")
      yield* write([
        home,
        repo,
        [path.join(outer, ".claude", "settings.json"), JSON.stringify({ env: { PLANTED: "above" } })],
      ])
      const directories = [repo, inner, outer]
      // The control: without an isolated home the same walk lists the folder above the ceiling.
      const open = yield* discover(fixture, home, directories)
      const before = process.env.ORBIT_TEST_HOME
      process.env.ORBIT_TEST_HOME = home
      const isolated = yield* discover(fixture, home, directories).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (before === undefined) delete process.env.ORBIT_TEST_HOME
            else process.env.ORBIT_TEST_HOME = before
          }),
        ),
      )

      expect(labels(fixture, open)).toContain("project:vendor:outer/.claude")
      expect(labels(fixture, isolated).filter((label) => label.startsWith("project:vendor"))).toEqual([
        "project:vendor:outer/inner/.claude",
        "project:vendor:outer/inner/repo/.claude",
      ])
    }),
  )
})
