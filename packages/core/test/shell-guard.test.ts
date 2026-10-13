import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Duration, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { ShellAnalysis } from "@orbit/core/shell/analysis"
import { ShellGuard } from "@orbit/core/shell/guard"
import { ShellParse } from "@orbit/core/shell/parse"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { recordedFileSystem, sharesTouched } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

// The guard over a real disk: FileAccess, ProjectTrust and FSUtil are the production services, in a project that is
// trusted (as the core tests run) and in one that nothing trusts. Bash is analysed with the platform's own path rules, so
// the same rows run on Windows and elsewhere; the rows that need a link to a missing place or a symlink to a file skip
// where the account cannot make one.

const win = process.platform === "win32"
const noHost = PowerShellParse.Service.of({ parse: () => Effect.succeed({ valid: false, reason: "no-host" }) })
const slash = (file: string) => file.replaceAll("\\", "/")

const requests: Permission.AssertInput[] = []
const sessionID = Session.ID.make("ses_shell_guard")

const provide = (directory: string, trusted: boolean) =>
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, ProjectTrust.node, FSUtil.node, Location.node]), [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ),
      Permission.node.replace(permissionLayer({ assert: (input) => Effect.sync(() => void requests.push(input)) })),
      ...(trusted ? [] : untrustedProjectNodes),
    ]),
  )

const context = (cwd: string, home: string, shell = "sh"): ShellAnalysis.Context => ({
  shell,
  platform: process.platform,
  path: win ? path.win32 : path.posix,
  home,
  cwd,
  env: {},
})

const analyse = (command: string, ctx: ShellAnalysis.Context) =>
  ShellAnalysis.inspect(command, ctx, { nested: true }).pipe(Effect.provideService(PowerShellParse.Service, noHost))

// The facts of a command run in `cwd`, which is a folder of the project unless a row says otherwise.
const facts = (command: string, options: { cwd: string; home?: string; writable?: string[]; shell?: string; loose?: string[] }) =>
  Effect.gen(function* () {
    const ctx = context(options.cwd, options.home ?? os.homedir(), options.shell)
    const access = yield* FileAccess.Service
    return yield* ShellGuard.facts({
      analysis: yield* analyse(command, ctx),
      text: command,
      ctx,
      cwd: yield* access.resolve({ path: options.cwd, kind: "directory" }),
      directories: [],
      loose: options.loose,
      writable: options.writable,
    })
  })

const directories = (found: ShellGuard.Facts) => found.external.map((target) => target.externalDirectory?.directory)

// A link to a folder. A junction on Windows, which needs no privilege.
const link = (target: string, name: string) => fs.symlink(target, name, win ? "junction" : "dir")

const layout = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const project = path.join(tmp, "project")
  const outside = path.join(tmp, "outside")
  const home = path.join(tmp, "home")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(project, "a"), { recursive: true })
    await fs.mkdir(path.join(project, "sub"))
    await fs.mkdir(outside)
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true })
  })
  return { tmp, project, outside, home }
})

describe("ShellGuard.facts: places", () => {
  for (const trusted of [true, false]) {
    const label = trusted ? "trusted" : "untrusted"

    it.live(`names the real folder of a place outside the project (${label})`, () =>
      Effect.gen(function* () {
        const { project, outside } = yield* layout
        yield* Effect.gen(function* () {
          const inside = yield* facts("touch a/b", { cwd: project })
          expect(inside.external).toEqual([])
          expect(inside.places.map((place) => place.status)).toEqual(["internal"])

          const out = yield* facts("touch ../outside/b", { cwd: project })
          expect(directories(out)).toEqual([AbsolutePath.make(outside)])

          // A directory change is judged where it leads, and what the command then writes is judged from there.
          expect((yield* facts("cd sub && touch f", { cwd: project })).external).toEqual([])
          expect(directories(yield* facts("cd ../outside && touch f", { cwd: project }))).toEqual([
            AbsolutePath.make(outside),
            AbsolutePath.make(outside),
          ])
        }).pipe(provide(project, trusted))
      }),
    )

    it.live(`judges a file below a link where the link leads (${label})`, () =>
      Effect.gen(function* () {
        const { project, outside } = yield* layout
        yield* Effect.promise(async () => {
          await link(outside, path.join(project, "cfg"))
          await link(outside, path.join(project, "123"))
        })
        yield* Effect.gen(function* () {
          // Both a file that exists under the link and one that is about to be created.
          expect(directories(yield* facts("rm cfg/x", { cwd: project }))).toEqual([AbsolutePath.make(outside)])
          expect(directories(yield* facts("touch cfg/new.txt", { cwd: project }))).toEqual([AbsolutePath.make(outside)])
          expect(directories(yield* facts("printf x > cfg/new.txt", { cwd: project }))).toEqual([
            AbsolutePath.make(outside),
          ])
          // A numeric link is still a link.
          expect(directories(yield* facts("cd 123", { cwd: project }))).toEqual([AbsolutePath.make(outside)])
        }).pipe(provide(project, trusted))
      }),
    )

    it.live(`keeps a spelling that climbs out of the project and back in inside it (${label})`, () =>
      Effect.gen(function* () {
        const { project } = yield* layout
        yield* Effect.gen(function* () {
          const found = yield* facts(`touch ../${path.basename(project)}/f`, { cwd: project })
          expect(found.external).toEqual([])
          expect(found.places[0]?.status).toBe("internal")
        }).pipe(provide(project, trusted))
      }),
    )

    // A dangling link needs a link to a place that is not there, which Windows allows only to a privileged account.
    it.live(`judges a write through a dangling link where it would land (${label})`, () =>
      Effect.gen(function* () {
        if (win) return
        const { project, outside } = yield* layout
        yield* Effect.promise(() => fs.symlink(path.join(outside, "missing"), path.join(project, "new")))
        yield* Effect.gen(function* () {
          const found = yield* facts("printf x > new", { cwd: project })
          expect(directories(found)).toEqual([AbsolutePath.make(outside)])
        }).pipe(provide(project, trusted))
      }),
    )
  }

  it.live("takes the real place of a removal, so a link to the home folder is critical and a removed link is not", () =>
    Effect.gen(function* () {
      const { project, home } = yield* layout
      yield* Effect.promise(() => link(home, path.join(project, "h")))
      yield* Effect.gen(function* () {
        const reasons = (found: ShellGuard.Facts) => found.findings.map((finding) => finding.reason)
        expect(reasons(yield* facts("rm -rf h/", { cwd: project, home }))).toContain("critical-place")
        // `rm h` removes the link, not what it points to.
        expect(reasons(yield* facts("rm h", { cwd: project, home }))).not.toContain("critical-place")
      }).pipe(provide(project, true))
    }),
  )

  // Class 9: what a person reads of a finding is Orbit's fixed sentence and the place with control characters replaced, so
  // the escape sequence in the command does not reach a terminal through the approval.
  it.live("shows no control character from the command in a finding", () =>
    Effect.gen(function* () {
      const { project, home } = yield* layout
      yield* Effect.gen(function* () {
        for (const command of [
          `rm -rf "${home}/\u001b[2J\u0007"`,
          `rm -rf "/\u001b]0;x\u0007"`,
          `cd a; cd sub; rm "x\u001b[31m"`,
          `rm -rf ~/\u001b[2J`,
        ]) {
          const found = yield* facts(command, { cwd: project, home })
          expect(found.findings.length).toBeGreaterThan(0)
          expect(JSON.stringify(found.findings)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
        }
      }).pipe(provide(project, true))
    }),
  )

  // Windows keeps the case of a name and has two more spellings of a file: its 8.3 name and the `\\?\` form. All of them
  // reach the place they name, so a project spelled any of these ways is still the project (class 4).
  const windows = win ? it.live : it.live.skip
  windows("judges the case, 8.3 and \\\\?\\ spellings of a place by where it is (Windows)", () =>
    Effect.gen(function* () {
      const { project, outside } = yield* layout
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "a long file name.txt"), "x"))
      const short = (file: string) =>
        Bun.spawnSync(["cmd.exe", "/d", "/c", `for %I in ("${file}") do @echo %~sI`]).stdout.toString().trim()
      const shortName = short(path.join(outside, "a long file name.txt"))
      yield* Effect.gen(function* () {
        expect((yield* facts(`cat ${slash(project.toUpperCase())}/a/x`, { cwd: project })).external).toEqual([])
        expect((yield* facts(`cat //?/${slash(project)}/a/x`, { cwd: project })).external).toEqual([])
        expect((yield* facts(`cat ${slash(project.toLowerCase())}/sub/x`, { cwd: project })).external).toEqual([])
        // Where the volume keeps no short names there is nothing to check.
        if (shortName.includes("~"))
          expect(directories(yield* facts(`cat ${slash(shortName)}`, { cwd: project }))).toHaveLength(1)
        expect(directories(yield* facts(`cat ${slash(outside.toUpperCase())}/x`, { cwd: project }))).toHaveLength(1)
      }).pipe(provide(project, true))
    }),
  )

  it.live("counts a sandbox root as inside only for a write and only while the call is sandboxed", () =>
    Effect.gen(function* () {
      const { project, outside } = yield* layout
      yield* Effect.gen(function* () {
        const root = path.dirname(outside)
        const write = `printf x > ../outside/f`
        expect((yield* facts(write, { cwd: project, writable: [root] })).external).toEqual([])
        expect(directories(yield* facts(write, { cwd: project }))).toEqual([AbsolutePath.make(outside)])
        // A read is outside whatever the sandbox allows to be written, and so is a source.
        expect(directories(yield* facts("cat ../outside/f", { cwd: project, writable: [root] }))).toEqual([
          AbsolutePath.make(outside),
        ])
        expect(directories(yield* facts("cp ../outside/f ./k", { cwd: project, writable: [root] }))).toEqual([
          AbsolutePath.make(outside),
        ])
      }).pipe(provide(project, true))
    }),
  )

  it.live("reads the operands of a nested script", () =>
    Effect.gen(function* () {
      const { project, home } = yield* layout
      yield* Effect.gen(function* () {
        const found = yield* facts("bash -c 'cat ~/.ssh/id_rsa'", { cwd: project, home })
        expect(directories(found)).toEqual([AbsolutePath.make(path.join(home, ".ssh"))])
      }).pipe(provide(project, true))
    }),
  )

  // A name FileAccess refuses (a data stream) is a place the guard cannot place, not a failure of the call; a folder to change to
  // that FileAccess refuses is a refusal, as the file tools give.
  it.live("leaves a data stream unresolved", () =>
    Effect.gen(function* () {
      if (!win) return
      const { project } = yield* layout
      yield* Effect.gen(function* () {
        const found = yield* facts("cat notes.txt:payload", { cwd: project })
        expect(found.places.map((place) => [place.status, place.why])).toEqual([["unresolved", "stream"]])
      }).pipe(provide(project, true))
    }),
  )

  // A share is never opened to find out where it is: the place is unresolved, with a finding, and nothing waits on the network.
  it.live("leaves a share unresolved without touching it", () =>
    Effect.gen(function* () {
      if (!win) return
      const { project } = yield* layout
      yield* Effect.gen(function* () {
        const started = Date.now()
        const found = yield* facts("cat //10.255.255.1/s/x", { cwd: project }).pipe(Effect.timeout(Duration.seconds(3)))
        expect(Date.now() - started).toBeLessThan(3000)
        expect(found.places.map((place) => [place.status, place.why])).toEqual([["unresolved", "share"]])
        expect(found.external).toEqual([])
        expect(found.probes).toEqual([])
      }).pipe(provide(project, true))
    }),
  )
})

// A place FileAccess refuses is reported as unresolved, not looked up and not counted inside the sandbox's writable roots
// (class 6): a link of the project that leads to a share is refused by name, and the writable root must not make it
// internal. Only such a link reaches the guard's check, so the row needs a privileged account on Windows.
describe("ShellGuard.facts: a place FileAccess refuses", () => {
  for (const trusted of [true, false])
    for (const command of ["touch lnk/x", "cat lnk/x", "rm lnk/x", "printf x > lnk/x"])
      it.live(
        `${command} through a link to a share stays unresolved inside a writable root (${trusted ? "trusted" : "untrusted"})`,
        () =>
          Effect.gen(function* () {
            if (!win) return
            const { project } = yield* layout
            const made = yield* Effect.promise(() =>
              fs.symlink("\\\\localhost\\C$\\orbit-no-such-folder", path.join(project, "lnk"), "dir").then(
                () => true,
                () => false,
              ),
            )
            if (!made) return
            yield* Effect.gen(function* () {
              const found = yield* facts(command, { cwd: project, writable: [project] })
              // A trusted project's link to a share is asked about, as a folder outside the project is, and not read to
              // draw the question; an untrusted one is refused before anything is asked.
              if (trusted) {
                expect(found.places.map((place) => place.status)).toEqual(["external"])
                expect(
                  found.external.map((target) => target.externalDirectory?.directory.startsWith("\\\\")),
                ).toEqual([true])
                return
              }
              expect(found.places.map((place) => place.status)).toEqual(["unresolved"])
              // Reported as written: the early return skips the lookup that would name the share the link leads to.
              expect(found.places[0]?.real).toEqual([path.join(project, "lnk", "x")])
              expect(found.external).toEqual([])
            }).pipe(provide(project, trusted))
          }),
      )
})

const repository = async (folder: string) => {
  await fs.mkdir(path.join(folder, ".git"), { recursive: true })
  await fs.writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n")
}

describe("ShellGuard.facts: a folder only the raw reading found", () => {
  // The drive name is not a disk, so FileAccess refuses it: the call goes on, and the finding says so.
  ;(win ? it.live : it.live.skip)("says an unresolved loose folder as a finding and does not fail the call", () =>
    Effect.gen(function* () {
      const { project } = yield* layout
      yield* Effect.gen(function* () {
        const found = yield* facts("Get-Date", { cwd: project, shell: "pwsh", loose: ["HKCU:\\Software"] })
        expect(found.places.map((place) => place.status)).toEqual(["unresolved"])
        expect(found.findings.map((finding) => finding.reason)).toContain("unresolved-path")
      }).pipe(provide(project, true))
    }),
  )
})

describe("ShellGuard.facts: the bare-repository probe", () => {
  const probe = (command: string, cwd: string, root: string) => facts(command, { cwd }).pipe(provide(root, true))
  const why = (found: ShellGuard.Facts) => found.bare.map((item) => item.why)

  it.live("finds nothing in a normal repository, at its root or below it", () =>
    Effect.gen(function* () {
      const { project } = yield* layout
      yield* Effect.promise(async () => {
        await repository(project)
        await fs.mkdir(path.join(project, "a", "b"))
      })
      expect((yield* probe("git status", project, project)).bare).toEqual([])
      expect((yield* probe("git status", path.join(project, "a", "b"), project)).bare).toEqual([])
    }),
  )

  for (const indicator of ["HEAD", "objects", "refs"])
    it.live(`flags a folder that holds only ${indicator}`, () =>
      Effect.gen(function* () {
        const { project } = yield* layout
        yield* Effect.promise(() =>
          indicator === "HEAD"
            ? fs.writeFile(path.join(project, "HEAD"), "ref: x\n")
            : fs.mkdir(path.join(project, indicator)),
        )
        expect(why(yield* probe("git status", project, project))).toEqual(["indicators"])
      }),
    )

  it.live("flags a folder whose .git has no HEAD, and one whose .git/HEAD is a directory", () =>
    Effect.gen(function* () {
      const { project, tmp } = yield* layout
      const other = path.join(tmp, "other")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(project, ".git"))
        await fs.mkdir(path.join(project, "refs"))
        await fs.mkdir(path.join(other, ".git", "HEAD"), { recursive: true })
        await fs.mkdir(path.join(other, "objects"))
      })
      expect(why(yield* probe("git status", project, project))).toEqual(["indicators"])
      expect(why(yield* probe("git status", other, project))).toEqual(["indicators"])
    }),
  )

  it.live("flags a bare-looking ancestor of a nested working folder, as git discovery would find it", () =>
    Effect.gen(function* () {
      const { project, tmp } = yield* layout
      const bare = path.join(tmp, "bare")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(bare, "objects"), { recursive: true })
        await fs.mkdir(path.join(bare, "refs"))
        await fs.mkdir(path.join(bare, "sub"))
        await fs.writeFile(path.join(bare, "HEAD"), "ref: x\n")
      })
      const found = yield* probe("git status", path.join(bare, "sub"), project)
      expect(found.bare).toEqual([{ base: bare, why: "indicators" }])
    }),
  )

  it.live("trusts the .git file of a linked worktree and of a submodule, and no other", () =>
    Effect.gen(function* () {
      const { project, tmp } = yield* layout
      const common = path.join(tmp, "common")
      const worktree = path.join(tmp, "worktree")
      const stray = path.join(tmp, "stray")
      const super_ = path.join(tmp, "super")
      const share = path.join(tmp, "share")
      yield* Effect.promise(async () => {
        await repository(common)
        await fs.mkdir(path.join(common, ".git", "worktrees", "x"), { recursive: true })
        await fs.mkdir(worktree)
        await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(common, ".git", "worktrees", "x")}\n`)
        await fs.writeFile(path.join(common, ".git", "worktrees", "x", "gitdir"), `${path.join(worktree, ".git")}\n`)
        // A file in a repository can name any folder; only git's own back pointer makes a worktree.
        await fs.mkdir(stray)
        await fs.writeFile(path.join(stray, ".git"), `gitdir: ${common}\n`)
        await repository(super_)
        await fs.mkdir(path.join(super_, ".git", "modules", "m"), { recursive: true })
        await fs.mkdir(path.join(super_, "m"))
        await fs.writeFile(path.join(super_, "m", ".git"), "gitdir: ../.git/modules/m\n")
        await fs.mkdir(share)
        await fs.writeFile(path.join(share, ".git"), "gitdir: //10.255.255.1/s\n")
      })
      expect((yield* probe("git status", worktree, project)).bare).toEqual([])
      expect((yield* probe("git status", path.join(super_, "m"), project)).bare).toEqual([])
      expect(why(yield* probe("git status", stray, project))).toEqual(["unverified-gitdir"])
      // A share named by a .git file is judged by its text, with no connection made.
      const started = Date.now()
      expect(why(yield* probe("git status", share, project))).toEqual(["unverified-gitdir"])
      expect(Date.now() - started).toBeLessThan(3000)
    }),
  )

  it.live("probes the folders a command names: -C, --git-dir and GIT_DIR", () =>
    Effect.gen(function* () {
      const { project, tmp } = yield* layout
      const other = path.join(tmp, "other")
      yield* Effect.promise(async () => {
        await repository(project)
        await fs.mkdir(path.join(other, "objects"), { recursive: true })
        await fs.mkdir(path.join(other, "refs"))
        await fs.writeFile(path.join(other, "HEAD"), "ref: x\n")
      })
      const run = (command: string) => probe(command, project, project)
      expect((yield* run("git -C ../other status")).bare).toEqual([{ base: other, why: "indicators" }])
      // The folder a command changes to is where the next git starts.
      expect((yield* run("cd ../other && git status")).bare).toEqual([{ base: other, why: "indicators" }])
      expect(why(yield* run("git --git-dir=../other/.git status"))).toEqual(["git-dir"])
      expect(why(yield* run("git --git-dir ../other status"))).toEqual(["git-dir"])
      expect(why(yield* run(`GIT_DIR=${slash(other)} git status`))).toEqual(["git-dir"])
      // The repository's own git directory is no finding.
      expect((yield* run("git --git-dir=.git status")).bare).toEqual([])
      const dynamic = yield* run("G=$(mktemp); GIT_DIR=$G; export GIT_DIR; git status")
      expect(dynamic.findings.map((finding) => finding.reason)).toContain("dynamic-git-dir")
    }),
  )

  it.live("reads nothing when the command does not run git", () =>
    Effect.gen(function* () {
      const { project } = yield* layout
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(project, "objects"))
        await fs.mkdir(path.join(project, "refs"))
        await fs.writeFile(path.join(project, "HEAD"), "ref: x\n")
      })
      expect((yield* probe("ls", project, project)).bare).toEqual([])
      expect(why(yield* probe("git status", project, project))).toEqual(["indicators"])
      expect(why(yield* probe("xargs git status", project, project))).toEqual(["indicators"])
    }),
  )
})

// What the shell request holds, from the analysis and the scanner.
describe("ShellGuard.request", () => {
  const request = (command: string, shell = "sh") =>
    Effect.gen(function* () {
      const ctx = context(process.cwd(), os.homedir(), shell)
      const analysis = yield* analyse(command, ctx)
      const scanned =
        shell === "sh"
          ? { ...(yield* ShellParse.scan(command, shell, ctx.cwd)), bare: yield* ShellParse.bare(command) }
          : undefined
      return { analysis, request: ShellGuard.request(analysis, command, scanned, []) }
    })

  it.live("asks about a redirect with no command by its own statement, with nothing to save", () =>
    Effect.gen(function* () {
      expect((yield* request("> marker")).request).toEqual({ resources: ["> marker"], save: [] })
      // The statement, not the whole text: a saved `printf *` does not cover `> marker`.
      const mixed = (yield* request("printf x; > marker")).request
      expect(mixed?.resources).toEqual(["printf x", "> marker"])
      expect(mixed?.save).toEqual(["printf *"])
    }),
  )

  // A declaration that prints the environment is a request beside any other command, with no save (class 8).
  for (const [command, resources] of [
    ["export -p; ls", ["ls", "export -p"]],
    ["ls; declare -p", ["ls", "declare -p"]],
    ["declare -p && git status", ["git status", "declare -p"]],
    ["export -p | cat", ["cat", "export -p"]],
  ] as const)
    it.live(`holds the printing declaration of ${command} as a request of its own`, () =>
      Effect.gen(function* () {
        const asked = (yield* request(command)).request
        expect(asked?.resources).toEqual([...resources])
        expect(asked?.save).toHaveLength(1)
      }),
    )

  // A leading assignment or a wrapper is also judged in the spelling of the program it runs, as a request of its own, so a
  // deny or ask for the program meets it and an allow for it cannot lift the command as written (class 8).
  for (const [command, resources] of [
    ["FOO=1 rm x", ["FOO=1 rm x", "rm x"]],
    ["timeout 5 rm x", ["timeout 5 rm x", "rm x"]],
    ["nice -n 5 rm x", ["nice -n 5 rm x", "rm x"]],
    ["nohup rm x", ["nohup rm x", "rm x"]],
    ["env A=1 rm x", ["env A=1 rm x", "rm x"]],
    ["FOO=1 timeout 5 nice rm x", ["FOO=1 timeout 5 nice rm x", "timeout 5 nice rm x", "nice rm x", "rm x"]],
    ["rm x", ["rm x"]],
  ] as const)
    it.live(`holds ${command} in the spelling of the program it runs`, () =>
      Effect.gen(function* () {
        const asked = (yield* request(command)).request
        expect(asked?.resources).toEqual([...resources])
      }),
    )

  it.live("skips only input that does nothing", () =>
    Effect.gen(function* () {
      for (const command of ["export A=1; cd sub", "# note", "", "A=1", "unset A", "declare -x B=2"])
        expect([command, (yield* request(command)).request]).toEqual([command, undefined])
      // A substitution runs a command, so it is asked about.
      expect((yield* request("A=$(printf x)")).request?.resources).toEqual(["printf x"])
    }),
  )

  it.live("asks about input it cannot read as the whole text and its fragments, with nothing to save", () =>
    Effect.gen(function* () {
      const { analysis, request: asked } = yield* request('printf hello > marker\necho "')
      expect(analysis.opaque).toBeDefined()
      expect(asked?.resources[0]).toBe('printf hello > marker\necho "')
      expect(asked?.save).toEqual([])
      // Wrappers and assignments in front of a fragment do not hide the program from a rule written for it.
      const wrapped = (yield* request("FOO=1 nohup timeout 5 rm x; echo $(true")).request
      expect(wrapped?.resources).toContain("rm x")
    }),
  )

  // Valid bash that the portable scanner once called a syntax error, and input the analysis cannot read: all of it is
  // asked about, and none of it is an error.
  for (const command of [
    "if (true) then echo y; fi",
    "while (true) do echo; done",
    "echo $((1; printf 2))",
    "((echo a); echo b)",
    "printf x; echo $(rm -rf ~)",
  ])
    it.live(`asks about ${JSON.stringify(command)}`, () =>
      Effect.gen(function* () {
        const { request: asked } = yield* request(command)
        expect(asked?.resources[0]).toBe(command)
        expect(asked?.save).toEqual([])
      }),
    )

  // The upgrading note names these as inputs that ask each time; this pins that the analysis reads them as opaque.
  for (const command of [
    "cat <<EOF\n$(printf hello)\nEOF",
    "for f in a b; do printf %s $f; done",
    'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
    '[[ -n <(printf reached > marker) ]]; wait "$!"',
  ])
    it.live(`reads ${JSON.stringify(command)} as opaque, so it asks`, () =>
      Effect.gen(function* () {
        const { analysis, request: asked } = yield* request(command)
        expect(analysis.opaque).toBeDefined()
        expect(asked?.save).toEqual([])
      }),
    )

  it.live("asks about PowerShell the host could not parse as the whole text, without a save", () =>
    Effect.gen(function* () {
      const { analysis, request: asked } = yield* request("Get-ChildItem; Remove-Item x", "pwsh")
      expect(analysis.opaque).toBeDefined()
      expect(asked).toMatchObject({ resources: ["Get-ChildItem; Remove-Item x", "Get-ChildItem", "Remove-Item x"], save: [] })
      // Each fragment also answers to the cmdlet's aliases, so a rule written with one still meets it.
      expect(asked?.aliases?.["Remove-Item x"]).toEqual(expect.arrayContaining(["del x", "ri x"]))
    }),
  )
})

describe("ShellGuard.authorize", () => {
  const asked: Permission.AssertInput[] = []
  // The rows that read PowerShell's own parse need a host; they skip where there is none.
  const host = Bun.which("pwsh") ?? Bun.which("powershell") ?? undefined
  const real = host ? it.live : it.live.skip

  // Runs the gate over a project with the given deny rule in force. A request that `denied` matches fails when it is
  // asserted, as a rule would; every other one is recorded as a question.
  // `link` makes `cfg` in the project a link to the folder outside it, which holds a file `s`; the project is then one that
  // nothing trusts, and a link in it that leads out is asked about.
  const run = (
    command: string,
    denied: (input: Permission.AssertInput) => boolean,
    options: { shell?: string; link?: boolean; real?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      asked.length = 0
      const { project, outside } = yield* layout
      process.env.ORBIT_GUARD_OUT = outside
      if (options.link) {
        yield* Effect.promise(() => link(outside, path.join(project, "cfg")))
        yield* Effect.promise(() => fs.writeFile(path.join(outside, "s"), "secret"))
      }
      return yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        return yield* ShellGuard.authorize({
          command,
          shell: options.shell ?? "sh",
          cwd: yield* access.resolve({ path: project, kind: "directory" }),
          env: {},
          portable: true,
          base: { sessionID },
        })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              FileAccess.node,
              Permission.node,
              ProjectTrust.node,
              FSUtil.node,
              Location.node,
              PowerShellParse.node,
            ]),
            [
              Location.node.replace(
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                ),
              ),
              Permission.node.replace(
                permissionLayer({
                  assert: (input) =>
                    denied(input)
                      ? Effect.fail(
                          new Permission.BlockedError({
                            rules: [],
                            permission: input.action,
                            resources: input.resources,
                          }),
                        )
                      : Effect.sync(() => void asked.push(input)),
                  denied: (input) => Effect.succeed(denied(input)),
                }),
              ),
              ...(options.real ? [] : [PowerShellParse.node.replace(Layer.succeed(PowerShellParse.Service, noHost))]),
              ...(options.link ? untrustedProjectNodes : []),
            ],
          ),
        ),
        Effect.ensuring(Effect.sync(() => void delete process.env.ORBIT_GUARD_OUT)),
        Effect.exit,
      )
    })

  // A path or module spelling of a location cmdlet names a program or script of the folder, and code in a location
  // cmdlet's arguments runs, so neither drops out of the shell request (a person's or an organization's `Bash * deny` sees
  // it). The plain cmdlet and its aliases are the control: they run no program and make no request.
  const anyBash = (input: Permission.AssertInput) => input.action === "Bash"
  for (const command of [
    String.raw`scripts\Set-Location .`,
    String.raw`scripts\Push-Location .`,
    String.raw`scripts\Pop-Location`,
    String.raw`& 'scripts\Set-Location' .`,
    String.raw`. 'scripts\Push-Location'`,
    String.raw`Some.Module\Set-Location .`,
  ])
    real(`a location spelling that runs code is denied by a Bash deny: ${command}`, () =>
      Effect.gen(function* () {
        const exit = yield* run(command, anyBash, { shell: host!, real: true })
        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toEqual([])
      }),
    )
  // Code in a location cmdlet's own arguments: the other command of the input (`Get-Item .`) is harmless and could be
  // covered by a saved grant, so a deny that names only the location command must still meet it.
  const namesLocation = (input: Permission.AssertInput) =>
    input.action === "Bash" && input.resources.some((resource) => /location/i.test(resource))
  for (const command of [
    String.raw`Get-Item . | Set-Location -Path { [System.IO.File]::WriteAllText('m.txt', 'x'); '.' }`,
    String.raw`Get-Item .; Set-Location ([System.IO.File]::WriteAllText('m.txt', 'y'))`,
    String.raw`Get-Item .; Push-Location (& .\evil.bat)`,
    "Get-Item .; Set-Location $(Get-Date)",
    "Get-Item .; Set-Location -Path:(Get-Date)",
  ])
    real(`code in a location cmdlet's arguments stays in the request: ${command}`, () =>
      Effect.gen(function* () {
        const exit = yield* run(command, namesLocation, { shell: host!, real: true })
        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toEqual([])
      }),
    )
  real("the harmless command of that input alone is not denied by that rule", () =>
    Effect.gen(function* () {
      const exit = yield* run("Get-Item .", namesLocation, { shell: host!, real: true })
      expect(Exit.isFailure(exit)).toBe(false)
    }),
  )
  for (const command of ["Set-Location .", "cd ..", "Push-Location sub", "Pop-Location", "Set-Location -Path:sub", "sl sub"])
    real(`a plain location change makes no shell request: ${command}`, () =>
      Effect.gen(function* () {
        const exit = yield* run(command, anyBash, { shell: host!, real: true })
        expect(Exit.isFailure(exit)).toBe(false)
        expect(asked.filter(anyBash)).toEqual([])
      }),
    )

  // Declarations that print every variable (and so the environment's credentials) are commands a Bash rule must see; the
  // ones that only set named variables stay inert. `printenv` is the control that always asks.
  for (const [command, inert] of [
    ["export -p", false],
    ["declare -p", false],
    ["declare", false],
    ["typeset -p", false],
    ["readonly", false],
    ["export", false],
    ["declare -fx", false],
    ["declare -x -p A", false],
    ["export -f fn", false],
    ["local", false],
    ["export A=1; declare -x B=2", true],
    ["export A", true],
    ["unset A", true],
    ["printenv", false],
  ] as const)
    it.live(`${command} ${inert ? "makes no shell request" : "is denied by a Bash deny"}`, () =>
      Effect.gen(function* () {
        const exit = yield* run(command, anyBash)
        expect(Exit.isFailure(exit)).toBe(!inert)
        expect(asked.filter(anyBash)).toEqual([])
      }),
    )

  it.live("checks every request for a deny before the first question", () =>
    Effect.gen(function* () {
      // The shell request is denied, the folder request would be asked: nothing is asked.
      yield* run("printf x > ../outside/f", (input) => input.action === "Bash")
      expect(asked).toEqual([])
      // An Edit rule on the file blocks it, though both Bash and the folder would be allowed.
      yield* run("printf x > ../outside/f", (input) => input.action === "Edit")
      expect(asked).toEqual([])
      yield* run("cat secret.txt", (input) => input.action === "Read")
      expect(asked).toEqual([])
      // The control: with no deny, both questions are asked, the folder first.
      yield* run("printf x > ../outside/f", () => false)
      expect(asked.map((input) => input.action)).toEqual(["external_directory", "Bash"])
    }),
  )

  // A read-class command that names an output file writes it: an Edit rule decides it, and a file outside the project is
  // asked about as a folder, whichever spelling of the option the command uses (class 8, the shell-paths round).
  for (const command of [
    "sort -o OUT f",
    "sort -oOUT f",
    "sort --output=OUT f",
    "sort --out OUT f",
    "uniq f OUT",
    "find . -fprint OUT",
    "find . -fprintf OUT %p",
    "tree -o OUT",
    "git diff --output=OUT",
    "git format-patch -o OUT",
    "sed -n 'w OUT' f",
    "sed -n 's/a/b/w OUT' f",
  ])
    it.live(`${command}: an Edit deny on the output file stops it, and an outside one asks`, () =>
      Effect.gen(function* () {
        const denied = yield* run(command.replaceAll("OUT", "out"), (input) => input.action === "Edit")
        expect(Exit.isFailure(denied)).toBe(true)
        expect(asked).toEqual([])
        const control = yield* run(command.replaceAll("OUT", "out"), () => false)
        expect(Exit.isSuccess(control)).toBe(true)
        const outside = yield* run(command.replaceAll("OUT", "../outside/out"), () => false)
        expect(Exit.isSuccess(outside)).toBe(true)
        expect(asked.map((input) => input.action)).toContain("external_directory")
      }),
    )

  // The portable scanner is quadratic on some inputs (`echo a[ a[ ...`); the analysis' length limit keeps such an input
  // from ever reaching it. The legacy scan and the fragment split still read it for its folders, and the scan alone can
  // take seconds on this input, so the time bound is generous.
  it.live("asks about a very long unreadable input whole and quickly, in portable mode", () =>
    Effect.gen(function* () {
      const long = `cd ../outside; echo ${"a[ ".repeat(21_000)}`
      const started = Date.now()
      yield* run(long, () => false)
      // The folder it changes to is asked about first, though the input is too long to analyse.
      expect(asked.map((input) => input.action)).toEqual(["external_directory", "Bash"])
      expect(asked[0]?.resources).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      expect(asked[1]?.resources[0]).toBe(long.trim())
      expect(asked[1]?.save).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(15_000)
    }),
    // The test's own bound above is 15 s; the runner's default of 5 s would cut the scan short on a busy machine.
    20_000,
  )

  // Input over the length limit, or that the shell's parser gives up on, still names its folders and files. Each row asks
  // the same question as its short form (class 3/4); the pad is a comment, so it changes nothing the command does.
  const pad = `#${"x".repeat(10_050)}`
  for (const [name, command, shell, link] of [
    ["bash cd and removal", `cd ../outside && rm s ${pad}`, "sh", false],
    ["bash pushd", `pushd ../outside; rm s ${pad}`, "sh", false],
    ["bash quoted cd", `cd "../outside" && rm s ${pad}`, "sh", false],
    ["PowerShell Set-Location", `Set-Location ../outside; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell colon-bound Set-Location", `Set-Location -Path:../outside; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell colon-bound LiteralPath", `Set-Location -LiteralPath:../outside; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell colon-bound Push-Location", `Push-Location -LiteralPath:../outside; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell abbreviated parameter", `sl -l:../outside; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell quote inside the target", `Set-Location ../out"side"; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell quoted colon-bound target", `Set-Location -Path:'../outside'; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell target built after a folder", `Set-Location ../outside/$env:NOPE; Remove-Item s ${pad}`, "pwsh", false],
    ["PowerShell read with -Path:", `Get-Content -Path:cfg/s ${pad}`, "pwsh", true],
    ["PowerShell read with a quote inside", `Get-Content cfg"/"s ${pad}`, "pwsh", true],
    ["PowerShell read of an array element", `Get-Content x,cfg/s ${pad}`, "pwsh", true],
    ["bash read through a link", `cat cfg/s ${pad}`, "sh", true],
    ["PowerShell read through a link", `Get-Content cfg/s ${pad}`, "pwsh", true],
    ["bash read of a quoted word", `cat "cfg/s" ${pad}`, "sh", true],
    ["bash redirect target", `printf x > cfg/s ${pad}`, "sh", true],
  ] as const)
    it.live(`asks for the folder of input it cannot analyse: ${name}`, () =>
      Effect.gen(function* () {
        yield* run(command, () => false, { shell, link })
        expect(command.length).toBeGreaterThan(10_000)
        expect(asked.find((input) => input.action === "external_directory")?.resources).toEqual([
          expect.stringMatching(/\/outside\/\*$/),
        ])
        // The folder shown is the one the command acts on, with no quote character of the spelling in it.
        expect(asked.filter((input) => input.action === "external_directory").flatMap((input) => input.resources).join("")).not.toMatch(/["']/)
      }),
    )

  // The spellings that PowerShell accepts for the same folder (class 3/4): each is asked about as the folder it names, in
  // input too long to analyse (a pad comment) and, with PowerShell's own parser, in its short form.
  const out = "$env:ORBIT_GUARD_OUT"
  const spellings = [
    ["an environment variable", `Set-Location ${out}`],
    ["a braced environment variable", "Set-Location ${env:ORBIT_GUARD_OUT}"],
    ["a quoted environment variable", `Set-Location "${out}"`],
    ["a variable in a colon-bound path", `Set-Location -Path:${out}`],
    ["a stack name before the folder", "Push-Location -StackName st ../outside"],
    ["-PSPath bound with a colon", "Set-Location -PSPath:../outside"],
    ["-PSPath abbreviated", "Set-Location -ps:../outside"],
    ["-PSPath with a space", "Set-Location -PSPath ../outside"],
    ["a switch bound before the folder", "Set-Location -PassThru: $true ../outside"],
    ["a block comment before the folder", "Set-Location <# c #> ../outside"],
    ["a block comment with a line break", "Set-Location <# c\n d #> ../outside"],
    ["an en dash before the parameter", "Set-Location –Path:../outside"],
    ["an em dash before the parameter", "Set-Location —LiteralPath:../outside"],
    ["a module qualifier", "Microsoft.PowerShell.Management\\Set-Location ../outside"],
    ["a quote inside the folder", 'Set-Location ../out"side"'],
  ] as const
  const folders = () =>
    asked.filter((input) => input.action === "external_directory").flatMap((input) => input.resources.map(slash))
  for (const [name, spelling] of spellings)
    it.live(`asks for the folder of padded input: ${name}`, () =>
      Effect.gen(function* () {
        const command = `${spelling}; Remove-Item s ${pad}`
        yield* run(command, () => false, { shell: "pwsh" })
        expect(command.length).toBeGreaterThan(10_000)
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )
  for (const [name, spelling] of spellings)
    real(`asks for the same folder with PowerShell's parser, short: ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}; Remove-Item s`, () => false, { shell: host!, real: true })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )
  for (const [name, spelling] of [
    ["$HOME", "Set-Location $HOME"],
    ["$HOME with a subfolder", 'Set-Location "$HOME\\.ssh"'],
    ["a variable in a colon-bound path", "Set-Location -Path:$HOME"],
    ["a braced USERPROFILE", "Set-Location ${env:USERPROFILE}"],
  ] as const)
    for (const padded of [true, false])
      real(`asks for the home folder${padded ? " in padded input" : ""}: ${name}`, () =>
        Effect.gen(function* () {
          yield* run(padded ? `${spelling}; Remove-Item s ${pad}` : spelling, () => false, { shell: host!, real: !padded })
          expect(folders().length).toBe(1)
          expect(folders()[0]!.toLowerCase().startsWith(slash(os.homedir()).toLowerCase())).toBe(true)
        }),
      )
  real("asks one folder, with no quote character, for a quote inside the target", () =>
    Effect.gen(function* () {
      yield* run('Set-Location ../out"side"; Remove-Item s', () => false, { shell: host!, real: true })
      expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      expect(folders().join("")).not.toMatch(/["']/)
    }),
  )

  // Text that only looks like the start of a comment or a braced variable (class 3/4/8): a quoted `<#`, a `<#` in a line
  // comment, a quoted `${` must not hide the folder change after it, padded and short.
  const hiding = [
    ["a single-quoted block-comment opener", "Write-Output '<#'; Set-Location ../outside"],
    ["a double-quoted block-comment opener", 'Write-Output "<#"; Set-Location ../outside'],
    ["a curly-quoted block-comment opener", "Write-Output “<#”; Set-Location ../outside"],
    ["a line comment holding an opener", "Write-Output ok # note <#\nSet-Location ../outside"],
    ["a quoted brace opener", "Write-Output '${'; Set-Location ../outside; Write-Output '}a'"],
  ] as const
  for (const [name, spelling] of hiding) {
    it.live(`asks for the folder after ${name}, padded`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}; Remove-Item s ${pad}`, () => false, { shell: "pwsh" })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )
    real(`asks for the folder after ${name}, short`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}; Remove-Item s`, () => false, { shell: host!, real: true })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )
  }
  it.live("asks for a link's folder after a quoted block-comment opener, padded", () =>
    Effect.gen(function* () {
      yield* run(`Write-Output '<#'; Get-Content cfg/s ${pad}`, () => false, { shell: "pwsh", link: true })
      expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
    }),
  )
  // Comment words after a folder change are not folders (a colon in one is refused as a data stream on Windows).
  it.live("asks for the folder, not the comment words, of a folder change with a comment", () =>
    Effect.gen(function* () {
      yield* run("cd ../outside # note: build\necho $FOO", () => false)
      expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      asked.length = 0
      yield* run(`Set-Location ../outside # see HKLM:\\Software; Remove-Item s #${pad}`, () => false, { shell: "pwsh" })
      expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
    }),
  )
  // PowerShell 7 goes home for a location change to nothing, on every host; Windows PowerShell 5.1 fails there, so home is
  // the stricter reading. Each spelling is read in the raw reading and the plain one, on both host kinds.
  it.live("asks for the home folder when a location change names nothing", () =>
    Effect.sync(() => {
      for (const platform of ["win32", "linux"] as const)
        for (const raw of [false, true])
          for (const text of [
            ...(raw ? [] : ["Set-Location", "cd"]),
            "Set-Location $null",
            // The raw reading does not unbrace a name; the plain one is always read as well.
            ...(raw ? [] : ["Set-Location ${env:ORBIT_NO_SUCH_VARIABLE}"]),
            "Set-Location $env:ORBIT_NO_SUCH_VARIABLE",
            "Set-Location -Path:$null",
            // An empty path is home on PowerShell 7, whatever the quotes or the name that was used.
            ...["Set-Location", "cd", "chdir", "sl", "Microsoft.PowerShell.Management\\Set-Location"].flatMap((name) => [
              `${name} ''`,
              `${name} ""`,
              `${name} -Path ''`,
              `${name} -Path:''`,
              `${name} -Path ""`,
            ]),
            // A parameter that is not a path, with no path after it, leaves the location at home.
            ...(raw
              ? []
              : [
                  "Set-Location -PassThru",
                  "cd -PassThru",
                  "sl -ErrorAction:Stop",
                  "cd -Verbose -PassThru",
                  // The end-of-parameters marker names nothing, alone or after parameters, and a block comment pad or a
                  // quoted opener before the command does not hide it (class 3/4/8).
                  ...["cd --", "cd -PassThru --", "cd -Verbose --", "Set-Location -ErrorAction:Stop --"].flatMap((spelling) => [
                    spelling,
                    `${spelling} <#xxx#>`,
                    `${spelling} #xxx`,
                    `Write-Output '<#'; ${spelling} #xxx`,
                  ]),
                  ...["cd -PassThru", "sl -ea:Stop", "cd -Verbose", "cd -ErrorAction:Stop"].flatMap((spelling) => [
                    `${spelling} <#xxx#>`,
                    `Write-Output '<#'; ${spelling} #xxx`,
                  ]),
                ]),
          ])
            expect([platform, raw, text, ShellGuard.locations(text, "pwsh", platform, "", "", raw)]).toEqual([
              platform,
              raw,
              text,
              [os.homedir()],
            ])
      // A parameter that reads a word leaves home named too; the word it reads shows as a folder beside it, inside the project.
      for (const platform of ["win32", "linux"] as const)
        for (const text of ["cd -ErrorAction Stop", "cd -ea Stop", "Set-Location -ErrorVariable ev"])
          expect([text, ShellGuard.locations(text, "pwsh", platform)[0]]).toEqual([text, os.homedir()])
      // A name that is set, and a folder that is written out, are not home.
      expect(ShellGuard.locations("Set-Location ../a", "pwsh", "linux")).toEqual(["../a"])
      for (const text of ["Set-Location -PassThru ../a", "cd -Path ../a -PassThru"])
        expect([text, ShellGuard.locations(text, "pwsh", "linux")]).toEqual([text, ["../a"]])
      expect(ShellGuard.locations("cd -ErrorAction Stop ../a", "pwsh", "linux")).not.toContain(os.homedir())
    }),
  )
  it.live("keeps text that only looks like an opener out of the split", () =>
    Effect.sync(() => {
      for (const text of [
        "Write-Output '<#'; Set-Location ../a",
        'Write-Output "<#"; Set-Location ../a',
        "echo x # <#\nSet-Location ../a",
        "Write-Output '${'; Set-Location ../a; echo '}a'",
      ])
        expect(ShellGuard.locations(text, "pwsh", "win32")).toEqual(["../a"])
      expect(ShellGuard.locations("cd ../a # b: c", "bash", "linux")).toEqual(["../a"])
      expect(ShellGuard.locations("cd ../a ../b", "bash", "linux")).toEqual(["../a"])
      expect(ShellGuard.locations("Set-Location ../a # see HKLM:\\x", "pwsh", "win32")).toEqual(["../a"])
    }),
  )

  // Text that PowerShell does not read as a block comment, which psText once did (class 3/4/8): the raw reading adds the
  // folder, whatever psText made of the text. Seven spellings, the quote characters it missed, and a quote-first word.
  const misread = [
    ["a word that ends in the opener", "Write-Output x<#\nSet-Location ../outside"],
    ["an apostrophe in a here-string", "$h = @'\nit's <#\n'@\nSet-Location ../outside"],
    ["a nested string", 'Write-Output "$("<#")";\nSet-Location ../outside'],
    ["low double quotes", "Write-Output „<#“;\nSet-Location ../outside"],
    ["a low single quote", "Write-Output ‚<#’;\nSet-Location ../outside"],
    ["a high-reversed single quote", "Write-Output ‛<#‛;\nSet-Location ../outside"],
    ["a comment after a closing quote", "Write-Output 'a'# <#\nSet-Location ../outside"],
    ["a comment after a number", "$a = 1# <#\nSet-Location ../outside"],
    ["a double-quoted here-string", '$h = @"\nsay "hi <#\n"@\nSet-Location ../outside'],
    ["a low double quote around the folder", "Set-Location „../outside“"],
    ["a low single quote around the folder", "Set-Location ‚../outside’"],
    ["a comment right after the quoted folder", "Set-Location '../outside'#x"],
  ] as const
  for (const [name, spelling] of misread)
    it.live(`asks for the folder of padded input after ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}\nRemove-Item s ${pad}`, () => false, { shell: "pwsh" })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
        expect(folders().join("")).not.toMatch(/["'„“‚’‛#]/)
      }),
    )
  for (const [name, spelling] of [misread[0], misread[1]] as const)
    it.live(`asks for a link's folder in padded input after ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}\nGet-Content cfg/s ${pad}`, () => false, { shell: "pwsh", link: true })
        expect(folders()).toContainEqual(expect.stringMatching(/\/outside\/\*$/))
      }),
    )
  // A misread must not drop the folder change after it (class 3/4/8): the raw reading is PowerShell's text as written,
  // where a backslash before a line break joins nothing, and a block comment that closes is blanks.
  for (const [opener, name] of [
    ["Write-Output x<#", misread[0][0]],
    ["$h = @'\nit's <#\n'@", misread[1][0]],
  ] as const)
    for (const [line, why, folder] of [
      ["Set-Location ..\\outside\\\nRemove-Item s", "a trailing backslash", /\/outside\/\*$/],
      ["Set-Location ..\\\nRemove-Item outside\\s", "a bare trailing backslash", /^[^]*\/\*$/],
      ["Set-Location <# c #> ../outside\nRemove-Item s", "a block comment before the folder", /\/outside\/\*$/],
    ] as const)
      it.live(
        `asks for the folder of padded input after ${name} and ${why}`,
        () =>
          Effect.gen(function* () {
            yield* run(`${opener}\n${line} ${pad}`, () => false, { shell: "pwsh" })
            expect(folders()).toEqual([expect.stringMatching(folder)])
            expect(folders().join("")).not.toMatch(/Remove-Item/)
          }),
      )
  it.live("reads PowerShell's raw text as written and blanks a block comment that closes", () =>
    Effect.sync(() => {
      const raw = (text: string) => ShellGuard.locations(text, "pwsh", "win32", "", "", true)
      expect(raw("Write-Output x<#\nSet-Location ..\\\nRemove-Item outside\\s")).toEqual(["..\\"])
      expect(raw("Write-Output x<#\nSet-Location ..\\outside\\\nRemove-Item s")).toEqual(["..\\outside\\"])
      expect(raw("Set-Location <# c #> ../outside")).toEqual(["../outside"])
      expect(raw("Set-Location ../a <# ../b #>")).toEqual(["../a"])
      // A block comment that does not close in its fragment ends the words at its opener.
      expect(raw("Set-Location ../a <# ../b")).toEqual(["../a"])
      expect(ShellGuard.fragmentWords("Get-Content a <# b", true, true)).toEqual(["a"])
      // A word that starts with a quote ends at its closing quote, and a `#` right after it starts a comment.
      expect(ShellGuard.locations("Write-Output 'a'# <#\nSet-Location ../a", "pwsh", "win32")).toEqual(["../a"])
    }),
  )
  // A `<#` inside a word or quotes is not a comment opener (class 3/4/8): the raw reading takes the union of the text as
  // written and the text with closed block comments blanked, so neither reading can lose the folder.
  for (const [name, spelling] of [
    ["a word that ends in the opener", "Set-Location -ErrorVariable e<# ../outside #>"],
    ["a stack name that ends in the opener", "Push-Location -StackName a<# ../outside #>"],
    ["quoted openers", "Write-Output x<#\nSet-Location -ErrorVariable '<#' ../outside -OutVariable '#>'"],
  ] as const)
    it.live(`asks for the folder of padded input with ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling}\nRemove-Item s ${pad}`, () => false, { shell: "pwsh" })
        expect(folders()).toContainEqual(expect.stringMatching(/\/outside\/\*$/))
        expect(folders().join("")).not.toMatch(/Remove-Item/)
      }),
    )
  for (const [name, spelling] of [
    ["a word that ends in the opener", "Get-Content -ErrorVariable e<# cfg/s #>"],
    ["quoted openers", "Get-Content -ErrorVariable '<#' cfg/s -OutVariable '#>'"],
  ] as const)
    it.live(`asks for a link's folder in padded input with ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${spelling} ${pad}`, () => false, { shell: "pwsh", link: true })
        expect(folders()).toContainEqual(expect.stringMatching(/\/outside\/\*$/))
      }),
    )
  it.live("reads an opener inside a word as written", () =>
    Effect.sync(() => {
      expect(ShellGuard.locations("Set-Location -ErrorVariable e<# ../a #>", "pwsh", "win32", "", "", true)).toContain("../a")
      expect(ShellGuard.fragmentWords("Get-Content -ErrorVariable e<# cfg/s #>", true, true)).toContain("cfg/s")
    }),
  )
  // The blanking is one linear pass: a regex over openers that never close is quadratic.
  it.live("reads a megabyte of openers within a deadline", () =>
    Effect.promise(async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { ShellGuard } from "@orbit/core/shell/guard"
const text = "Set-Location ../a " + "<#a ".repeat(262_144)
ShellGuard.locations(text, "pwsh", "win32", "", "", true)
ShellGuard.fragmentWords(text, true, true)
console.log("done")`,
        ],
        { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
      )
      const timer = setTimeout(() => child.kill(), 10_000)
      const out = await new Response(child.stdout).text()
      await child.exited
      clearTimeout(timer)
      expect(out.trim()).toBe("done")
    }),
  )
  it.live("does not fail the call for block-commented code that holds a refused spelling", () =>
    Effect.gen(function* () {
      const exit = yield* run(`<# Set-Location HKLM:\\Software #>\nRemove-Item s ${pad}`, () => false, { shell: "pwsh" })
      expect(exit._tag).toBe("Success")
    }),
  )
  it.live("keeps the folder with the quotes read as PowerShell reads them", () =>
    Effect.sync(() => {
      expect(ShellGuard.locations("Set-Location '../a'#x", "pwsh", "win32")).toEqual(["../a"])
      expect(ShellGuard.locations("Set-Location „../a“", "pwsh", "win32")).toEqual(["../a"])
      expect(ShellGuard.fragmentWords("Get-Content a'b'c", true)).toEqual(["abc"])
      // The raw reading finds what psText drops.
      expect(ShellGuard.locations("Write-Output x<#\nSet-Location ../a", "pwsh", "win32")).toEqual([])
      expect(ShellGuard.locations("Write-Output x<#\nSet-Location ../a", "pwsh", "win32", "", "", true)).toEqual(["../a"])
    }),
  )
  // Comment text that holds a separator is not a folder change, whatever it says (decision 1).
  it.live("does not fail the call for a separator inside comment text", () =>
    Effect.gen(function* () {
      for (const [command, shell] of [
        [`Set-Location ../outside # old; Set-Location HKLM:\\Software\nRemove-Item s ${pad}`, "pwsh"],
        ["cd ../outside # note; cd C:x:y\necho $FOO", undefined],
        [`cd ../outside # note; cd C:x:y\necho $FOO ${pad}`, undefined],
      ] as const) {
        asked.length = 0
        const exit = yield* run(command, () => false, shell ? { shell } : {})
        expect(exit._tag).toBe("Success")
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }
    }),
  )
  // A redirect word is not the operand of a bash cd (class 3/4).
  for (const command of [
    "cd 2>/dev/null ../outside",
    "cd 2> /dev/null ../outside",
    "cd >/dev/null ../outside",
    "cd &>/dev/null ../outside",
    "pushd 2>/dev/null ../outside",
    "cd <> f ../outside",
    "cd 3<> f ../outside",
    "cd >|/dev/null ../outside",
    "cd >| /dev/null ../outside",
    "cd <<- EOF ../outside",
  ])
    for (const padded of [false, true])
      it.live(`asks for the folder after a redirect${padded ? ", padded" : ""}: ${command}`, () =>
        Effect.gen(function* () {
          // A heredoc operator takes its body from the lines after the command.
          const body = command.includes("<<") ? "\nbody\nEOF" : ""
          yield* run(`${command} && rm s; echo $FOO${padded ? ` ${pad}` : ""}${body}`, () => false)
          expect(folders()).toContainEqual(expect.stringMatching(/\/outside\/\*$/))
          expect(folders()).toHaveLength(1)
        }),
      )
  it.live("picks the folder of a bash cd past redirects and flags", () =>
    Effect.sync(() => {
      for (const text of ["cd 2>/dev/null ../a", "cd 2> /dev/null ../a", "cd >/dev/null ../a", "cd &>/dev/null ../a", "cd <&3 ../a",
        "cd <> f ../a",
        "cd 3<> f ../a",
        "cd <<- EOF ../a",
        "cd >|/dev/null ../a",
        "cd >| /dev/null ../a",
      ])
        expect(ShellGuard.locations(text, "bash", "linux")).toEqual(["../a"])
      expect(ShellGuard.locations("cd ../a ../b", "bash", "linux")).toEqual(["../a"])
      expect(ShellGuard.locations("cd -P ../a 2>&1", "bash", "linux")).toEqual(["../a"])
    }),
  )

  // A word that a link in an untrusted project leads out of: the elements of an array and a colon-bound value come from
  // PowerShell's parser; a block comment before the word and a Unicode dash come from the fragment split.
  for (const command of [
    "Get-Content x,cfg/s",
    "Get-Content -Path:cfg/s",
    "Get-Content -LiteralPath:'cfg/s'",
    "Get-Content cfg/s, x",
    // A cmdlet that no path table knows: the words alone name the file.
    "Invoke-Thing -Path:cfg/s",
    "Invoke-Thing x,cfg/s",
  ])
    real(`asks for a link's folder with PowerShell's parser: ${command}`, () =>
      Effect.gen(function* () {
        yield* run(command, () => false, { shell: host!, link: true, real: true })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )
  for (const [name, command] of [
    ["a block comment before the word", "Get-Content <# c #> cfg/s"],
    ["an en dash before a parameter", "Get-Content –Force cfg/s"],
    ["a block comment closing like a line comment", "Get-Content x <# #> cfg/s"],
  ] as const)
    it.live(`asks for a link's folder in padded input: ${name}`, () =>
      Effect.gen(function* () {
        yield* run(`${command} ${pad}`, () => false, { shell: "pwsh", link: true })
        expect(folders()).toEqual([expect.stringMatching(/\/outside\/\*$/)])
      }),
    )

  // The control: a short input names the same folder, so the long one is not asked more or less than it.
  it.live("asks for the folder of the short form of those inputs", () =>
    Effect.gen(function* () {
      for (const command of [
        "Get-Content x,cfg/s",
        "Get-Content -Path:cfg/s",
        'Get-Content cfg"/"s',
        "Get-Content -LiteralPath:'cfg/s'",
      ]) {
        asked.length = 0
        yield* run(command, () => false, { shell: "pwsh", link: true })
        expect(asked.map((input) => input.action)).toContain("external_directory")
      }
      yield* run("cd ../outside && rm s", () => false)
      expect(asked.map((input) => input.action)).toContain("external_directory")
      yield* run("cat cfg/s", () => false, { link: true })
      expect(asked.map((input) => input.action)).toContain("external_directory")
    }),
  )

  it.live("splits input that cannot be analysed into folders and words, with comments and expansions left out", () =>
    Effect.sync(() => {
      expect(
        ShellGuard.locations('cd ../a && pushd "b c"; cd -P "d"; cd $X; echo cd z', "bash", process.platform),
      ).toEqual(["../a", "b c", "d"])
      expect(ShellGuard.locations("cd x; Set-Location y; ls z", "pwsh", "win32")).toEqual(["x", "y"])
      expect(ShellGuard.locations("New-PSDrive -Name Q -Root z; Pop-Location y", "pwsh", "win32")).toEqual([])
      expect(ShellGuard.fragmentWords('cat a "b c" -n --file=d $E x # e f\nls g')).toEqual(["a", "b c", "d", "x", "g"])
      // PowerShell spellings: a colon-bound parameter gives its value, quotes inside a word are joined and never shown.
      expect(
        ShellGuard.locations("Set-Location -Path:../a; Push-Location -LiteralPath: ../b; sl -pa:c; pushd -l:d", "pwsh", "win32"),
      ).toEqual(["../a", "../b", "c", "d"])
      expect(ShellGuard.locations(`Set-Location ../o"u"t; Set-Location 'a b'x; Set-Location -Path:"../q"`, "pwsh", "win32")).toEqual([
        "../out",
        "a b",
        "x",
        "../q",
      ])
      expect(ShellGuard.locations("Set-Location -PassThru:$true; Set-Location ../x/$Y/z; cd $Y", "pwsh", "win32")).toEqual([
        // -PassThru names no place, so the first command goes home.
        os.homedir(),
        "../x/",
      ])
      // Every word that is not a parameter, and the variables the shell defines for folders.
      expect(ShellGuard.locations("Push-Location -StackName st ../o", "pwsh", "win32")).toEqual(["st", "../o"])
      expect(ShellGuard.locations("Set-Location -PSPath:../a; sl -ps:../b; sl -PSPath ../c; sl -LP:../d", "pwsh", "win32")).toEqual([
        "../a",
        "../b",
        "../c",
        "../d",
      ])
      expect(
        ShellGuard.locations("Set-Location <# c #> ../a; sl –Path:../b; sl —LiteralPath ../c; Microsoft.PowerShell.Management\\sl ../d", "pwsh", "win32"),
      ).toEqual(["../a", "../b", "../c", "../d"])
      process.env.ORBIT_LOCATION_TEST = "/elsewhere"
      expect(
        ShellGuard.locations(
          'sl $env:ORBIT_LOCATION_TEST; sl ${env:ORBIT_LOCATION_TEST}; sl "$env:ORBIT_LOCATION_TEST/x"; sl -Path:$env:ORBIT_LOCATION_TEST; sl $PWD/q',
          "pwsh",
          "win32",
          "/work",
          "/bin/pwsh",
        ),
      ).toEqual(["/elsewhere", "/elsewhere/x", "/work/q"])
      delete process.env.ORBIT_LOCATION_TEST
      expect(ShellGuard.fragmentWords("Get-Content <# a b #> c –Force d #> e\nls f", true)).toEqual(["c", "d", "f"])
      expect(ShellGuard.locations("cd ../out/$X; cd $Y/z", "bash", process.platform)).toEqual(["../out/"])
      expect(ShellGuard.fragmentWords('Get-Content -Path:a/b -LiteralPath: "c d" x"y"z -Force `$q # w', true)).toEqual([
        "a/b",
        "c d",
        "xyz",
      ])
    }),
  )
})

// Input the analysis cannot read is searched as raw text for folders a command might change to, comments included. A
// share named there is asked about and never opened: no file system call may name it before the question (class 6, task
// permissions-23). The FSUtil is the recording one, so the rows pin the calls, not how fast the answer came. Share
// spellings are shares on Windows only.
describe("ShellGuard.authorize: a share named in input the analysis cannot read", () => {
  const host = Bun.which("pwsh") ?? Bun.which("powershell") ?? undefined
  const rows: { name: string; command: string; shell: string; needsHost: boolean }[] = [
    ...["//example.invalid/share", "\\\\example.invalid\\share"].flatMap((share) => [
      { name: "bash opaque input", command: `echo $UNSET_R2 #; cd ${share}`, shell: "sh", needsHost: false },
      { name: "bash command substitution", command: `echo \`true\` #; cd ${share}`, shell: "sh", needsHost: false },
      {
        name: "PowerShell parse error",
        command: `Write-Output (1 #; Set-Location ${share}`,
        shell: "pwsh",
        needsHost: true,
      },
    ]),
  ]

  for (const trusted of [true, false])
    for (const row of rows) {
      const test = win && (!row.needsHost || host) ? it.live : it.live.skip
      test(
        `${row.name} ${JSON.stringify(row.command)} touches no share and still asks (${trusted ? "trusted" : "untrusted"})`,
        () =>
          Effect.gen(function* () {
            const { project } = yield* layout
            const recorded = recordedFileSystem()
            const asked: Permission.AssertInput[] = []
            const result = yield* Effect.gen(function* () {
              const access = yield* FileAccess.Service
              return yield* ShellGuard.authorize({
                command: row.command,
                shell: row.shell,
                cwd: yield* access.resolve({ path: project, kind: "directory" }),
                env: {},
                portable: true,
                base: { sessionID },
              })
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(
                  LayerNode.group([
                    FileAccess.node,
                    Permission.node,
                    ProjectTrust.node,
                    FSUtil.node,
                    Location.node,
                    PowerShellParse.node,
                  ]),
                  [
                    Location.node.replace(
                      Layer.succeed(
                        Location.Service,
                        Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                      ),
                    ),
                    Permission.node.replace(
                      permissionLayer({ assert: (input) => Effect.sync(() => void asked.push(input)) }),
                    ),
                    FSUtil.node.replace(recorded.layer),
                    ...(trusted ? [] : untrustedProjectNodes),
                  ],
                ),
              ),
              Effect.exit,
            )
            expect(result._tag).toBe("Success")
            
            expect(sharesTouched(recorded.touched)).toEqual([])
            // The input is still asked about, as the whole text.
            expect(asked.some((input) => input.action === "Bash")).toBe(true)
          }),
      )
    }
})

// The bare-repository probe stats HEAD, objects, refs and `.git` of every folder git could start in. A repository can ship
// any of them as a link to a share, and a stat through it connects to a host the repository chose, before anyone is asked
// (class 6). The FSUtil is the recording one, so the rows pin which paths were stat-ed, not how long the answer took.
describe("ShellGuard.facts: the bare-repository probe and links to shares", () => {
  const rows = [
    { name: "cwd in the folder", command: "git status", cwd: "sub" },
    { name: "cd into the folder", command: "cd sub && git log", cwd: "" },
    { name: "git -C the folder", command: "git -C sub status", cwd: "" },
  ]
  const shares = { HEAD: "file", objects: "dir", refs: "dir" } as const

  for (const trusted of [true, false])
    for (const row of rows)
      for (const [name, kind] of Object.entries(shares))
        (win ? it.live : it.live.skip)(
          `${name} linked to a share is flagged and never stat-ed: ${row.name} (${trusted ? "trusted" : "untrusted"})`,
          () =>
            Effect.gen(function* () {
              const { project } = yield* layout
              const recorded = recordedFileSystem()
              const made = yield* Effect.promise(async () => {
                await repository(project)
                return fs.symlink("\\\\192.0.2.201\\share\\x", path.join(project, "sub", name), kind).then(
                  () => true,
                  () => false,
                )
              })
              // Without the right to make a link there is nothing to probe.
              if (!made) return
              const started = Date.now()
              const found = yield* facts(row.command, { cwd: path.join(project, row.cwd) }).pipe(
                Effect.provide(
                  AppNodeBuilder.build(
                    LayerNode.group([FileAccess.node, ProjectTrust.node, FSUtil.node, Location.node]),
                    [
                      Location.node.replace(
                        Layer.succeed(
                          Location.Service,
                          Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                        ),
                      ),
                      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
                      FSUtil.node.replace(recorded.layer),
                      ...(trusted ? [] : untrustedProjectNodes),
                    ],
                  ),
                ),
              )
              expect(Date.now() - started).toBeLessThan(15_000)
              expect(found.bare.map((item) => item.why)).toEqual(["indicators"])
              expect(
                recorded.calls.filter((call) => call.startsWith("stat ") && call.endsWith(path.join("sub", name))),
              ).toEqual([])
              // The control: other paths of the walk are stat-ed as before.
              expect(recorded.calls.some((call) => call.startsWith("stat "))).toBe(true)
            }),
          60_000,
        )
})
