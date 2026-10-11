import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Duration, Effect, Layer } from "effect"
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
const facts = (command: string, options: { cwd: string; home?: string; writable?: string[]; shell?: string }) =>
  Effect.gen(function* () {
    const ctx = context(options.cwd, options.home ?? os.homedir(), options.shell)
    const access = yield* FileAccess.Service
    return yield* ShellGuard.facts({
      analysis: yield* analyse(command, ctx),
      text: command,
      ctx,
      cwd: yield* access.resolve({ path: options.cwd, kind: "directory" }),
      directories: [],
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

const repository = async (folder: string) => {
  await fs.mkdir(path.join(folder, ".git"), { recursive: true })
  await fs.writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n")
}

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
      expect(asked).toEqual({ resources: ["Get-ChildItem; Remove-Item x", "Get-ChildItem", "Remove-Item x"], save: [] })
    }),
  )
})

describe("ShellGuard.authorize", () => {
  const asked: Permission.AssertInput[] = []

  // Runs the gate over a project with the given deny rule in force. A request that `denied` matches fails when it is
  // asserted, as a rule would; every other one is recorded as a question.
  // `link` makes `cfg` in the project a link to the folder outside it, which holds a file `s`; the project is then one that
  // nothing trusts, and a link in it that leads out is asked about.
  const run = (
    command: string,
    denied: (input: Permission.AssertInput) => boolean,
    options: { shell?: string; link?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      asked.length = 0
      const { project, outside } = yield* layout
      if (options.link) {
        yield* Effect.promise(() => link(outside, path.join(project, "cfg")))
        yield* Effect.promise(() => fs.writeFile(path.join(outside, "s"), "secret"))
      }
      yield* Effect.gen(function* () {
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
            LayerNode.group([FileAccess.node, Permission.node, ProjectTrust.node, FSUtil.node, Location.node]),
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
              ...(options.link ? untrustedProjectNodes : []),
            ],
          ),
        ),
        Effect.provideService(PowerShellParse.Service, noHost),
        Effect.exit,
      )
    })

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
  )

  // Input over the length limit, or that the shell's parser gives up on, still names its folders and files. Each row asks
  // the same question as its short form (class 3/4); the pad is a comment, so it changes nothing the command does.
  const pad = `#${"x".repeat(10_050)}`
  for (const [name, command, shell, link] of [
    ["bash cd and removal", `cd ../outside && rm s ${pad}`, "sh", false],
    ["bash pushd", `pushd ../outside; rm s ${pad}`, "sh", false],
    ["bash quoted cd", `cd "../outside" && rm s ${pad}`, "sh", false],
    ["PowerShell Set-Location", `Set-Location ../outside; Remove-Item s ${pad}`, "pwsh", false],
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
      }),
    )

  // The control: a short input names the same folder, so the long one is not asked more or less than it.
  it.live("asks for the folder of the short form of those inputs", () =>
    Effect.gen(function* () {
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
    }),
  )
})
