import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Context, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Formatter } from "@orbit/core/formatter"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const server = path.join(import.meta.dir, "fixtures", "lsp", "fake-server.ts")

// A language server and a formatter read the configuration around the file they are given, and several of them run it.
// The matrix: placements x surfaces. Placements are inside the project, an absolute path outside it (an untrusted owner
// and a trusted one as the control), `..`, a folder link that leads out, a dangling link, and the Windows case of a name.
// Surfaces are ProjectTrust.trustedAt itself, Lsp.diagnostics with and without a save, Lsp.request and Formatter.file.
// `~`, the Git Bash, Cygwin and WSL drive forms and a trailing dot or space are spellings that the tool resolves before
// the file reaches these services; lsp-diagnostics.test.ts pins them through the plugin. UNC and device paths are
// refused earlier still, by FileAccess (file-access.test.ts).
describe("language servers and formatters for a file outside the project", () => {
  const layout = Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    const marker = path.join(root, "opened.txt")
    const project = path.join(root, "project")
    const untrusted = path.join(root, "untrusted")
    const trusted = path.join(root, "trusted")
    yield* Effect.promise(() =>
      Promise.all(
        [project, untrusted, trusted].flatMap((folder) => [
          fs.mkdir(path.join(folder, ".git"), { recursive: true }),
          fs.mkdir(path.join(folder, "sub"), { recursive: true }),
        ]),
      ),
    )
    yield* Effect.promise(() => fs.writeFile(marker, ""))
    const config = Config.testLayer([
      new Document({
        type: "document",
        info: Schema.decodeUnknownSync(Info)({
          lsp: { fake: { command: [process.execPath, server, `--marker=${marker}`], extensions: [".fake"] } },
        }),
      }),
    ])
    const context = yield* Layer.build(
      AppNodeBuilder.build(LayerNode.group([Lsp.node, Formatter.node, ProjectTrust.node, WorkspaceTrust.node]), [
        Config.node.replace(config),
        Global.node.replace(tempGlobalLayer),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
            ),
          ),
        ),
      ]),
    )
    const trust = Context.get(context, WorkspaceTrust.Service)
    yield* trust.grant(project, { persist: false, via: "test" })
    yield* trust.grant(trusted, { persist: false, via: "test" })
    return {
      root,
      marker,
      project,
      untrusted,
      trusted,
      trust,
      services: Layer.succeedContext(context),
    }
  })

  const opened = (marker: string) => Effect.promise(() => Bun.file(marker).text())

  it.live("decides on the real path of the file and the folder that owns it", () =>
    Effect.gen(function* () {
      const { root, project, untrusted, trusted, trust, services } = yield* layout
      const upper = (file: string) => file.toUpperCase()
      // Links: a folder link needs no privilege on Windows (a junction); a dangling file link does.
      yield* Effect.promise(async () => {
        await fs.symlink(untrusted, path.join(project, "link-untrusted"), "junction")
        await fs.symlink(trusted, path.join(project, "link-trusted"), "junction")
        // Links in other folders: the spelling is under one owner and the real path under another.
        await fs.symlink(trusted, path.join(untrusted, "to-trusted"), "junction")
        await fs.symlink(project, path.join(untrusted, "to-project"), "junction")
        await fs.symlink(untrusted, path.join(trusted, "to-untrusted"), "junction")
        await fs.symlink(path.join(project, "sub"), path.join(trusted, "to-project"), "junction")
        // Folders with no marker own themselves: `bare` is not granted, `plain` is.
        await fs.mkdir(path.join(root, "bare"), { recursive: true })
        await fs.mkdir(path.join(root, "plain"), { recursive: true })
        await fs.mkdir(path.join(trusted, "dir"), { recursive: true })
        await fs.symlink(trusted, path.join(root, "bare", "to-trusted"), "junction")
        await fs.symlink(path.join(root, "plain"), path.join(root, "bare", "to-plain"), "junction")
        await fs.symlink(trusted, path.join(root, "plain", "to-trusted"), "junction")
        await fs.symlink(path.join(trusted, "dir"), path.join(root, "plain", "to-trusted-dir"), "junction")
        await fs.symlink(path.join(root, "bare"), path.join(trusted, "to-bare"), "junction")
        await fs.symlink(root, path.join(root, "alias"), "junction")
        await fs.symlink(trusted, path.join(trusted, "self"), "junction")
        if (!canLinkFile) return
        await fs.symlink(path.join(untrusted, "new.fake"), path.join(project, "dangling-untrusted.fake"))
        await fs.symlink(path.join(trusted, "new.fake"), path.join(project, "dangling-trusted.fake"))
      })
      yield* trust.grant(path.join(root, "plain"), { persist: false, via: "test" })
      const rows: ReadonlyArray<readonly [string, string, boolean]> = [
        ["inside", path.join(project, "sub", "a.fake"), true],
        ["inside, not there yet", path.join(project, "new", "deeper", "a.fake"), true],
        ["inside, spelled with ..", path.join(project, "sub", "..", "a.fake"), true],
        ["outside, untrusted owner", path.join(untrusted, "a.fake"), false],
        ["outside, folder below an untrusted owner", path.join(untrusted, "sub", "a.fake"), false],
        ["outside, not there yet", path.join(untrusted, "new", "a.fake"), false],
        ["outside, spelled with ..", `${project}${path.sep}..${path.sep}untrusted${path.sep}a.fake`, false],
        ["outside, trusted owner (control)", path.join(trusted, "a.fake"), true],
        ["outside, folder below a trusted owner", path.join(trusted, "sub", "a.fake"), true],
        ["outside, trusted, spelled with ..", `${project}${path.sep}..${path.sep}trusted${path.sep}a.fake`, true],
        ["a folder link that leads to an untrusted folder", path.join(project, "link-untrusted", "a.fake"), false],
        ["a folder link that leads to a trusted folder", path.join(project, "link-trusted", "a.fake"), true],
        ["a link in an untrusted folder that leads into a trusted folder", path.join(untrusted, "to-trusted", "a.fake"), false],
        ["a link in an untrusted folder that leads into the project", path.join(untrusted, "to-project", "sub", "a.fake"), false],
        ["a link in a trusted folder that leads into an untrusted folder", path.join(trusted, "to-untrusted", "a.fake"), false],
        ["a link in a trusted folder that leads into the project (control)", path.join(trusted, "to-project", "a.fake"), true],
        ["a link in a folder with no marker that leads to a trusted root", path.join(root, "bare", "to-trusted", "t.fake"), false],
        ["a link in a folder with no marker that leads to a granted folder", path.join(root, "bare", "to-plain", "p.fake"), false],
        ["a trusted folder reached through a link in a folder with no marker", path.join(trusted, "to-bare", "to-trusted", "t.fake"), false],
        ["a granted folder with no marker that links to a trusted root", path.join(root, "plain", "to-trusted", "t.fake"), true],
        ["a granted folder with no marker that links into a trusted subfolder", path.join(root, "plain", "to-trusted-dir", "a.fake"), true],
        ["a trusted folder reached through a link above it", path.join(root, "alias", "trusted", "a.fake"), true],
        ["a trusted folder that links to itself", path.join(trusted, "self", "a.fake"), true],
        ["a folder with no marker, beside the project", path.join(root, "a.fake"), false],
        ...(canLinkFile
          ? ([
              ["a dangling link that lands in an untrusted folder", path.join(project, "dangling-untrusted.fake"), false],
              ["a dangling link that lands in a trusted folder", path.join(project, "dangling-trusted.fake"), true],
            ] as const)
          : []),
        ...(process.platform === "win32"
          ? ([
              ["Windows case, untrusted", upper(path.join(untrusted, "a.fake")), false],
              ["Windows case, trusted", upper(path.join(trusted, "a.fake")), true],
              ["Windows case, inside", upper(path.join(project, "sub", "a.fake")), true],
            ] as const)
          : []),
      ]
      const found = yield* Effect.gen(function* () {
        const trust = yield* ProjectTrust.Service
        return yield* Effect.forEach(rows, ([name, file]) =>
          trust.trustedAt(file).pipe(Effect.map((allowed) => [name, allowed] as const)),
        )
      }).pipe(Effect.provide(services))
      expect(found).toEqual(rows.map(([name, , allowed]) => [name, allowed]))
    }),
  )

  // A linked worktree has a `.git` file, not a folder, and is a folder of its own: trusting the repository it was made
  // from does not trust it, and a grant of its own does.
  it.live("a linked worktree of a trusted repository needs a grant of its own", () =>
    Effect.gen(function* () {
      const { root, trust, services } = yield* layout
      const repo = path.join(root, "repo")
      const worktree = path.join(root, "linked")
      yield* Effect.promise(async () => {
        await fs.mkdir(repo, { recursive: true })
        const git = async (...args: string[]) =>
          expect(
            await Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
              cwd: repo,
              stdout: "ignore",
              stderr: "ignore",
            }).exited,
          ).toBe(0)
        await git("init", "-q")
        await git("commit", "-q", "--allow-empty", "-m", "init")
        await git("worktree", "add", "-q", worktree)
        // A worktree's .git is a file; without it the rows below would pass for a missing folder.
        expect((await fs.stat(path.join(worktree, ".git"))).isFile()).toBe(true)
      })
      yield* trust.grant(repo, { persist: false, via: "test" })
      const ask = (file: string) =>
        Effect.gen(function* () {
          return yield* (yield* ProjectTrust.Service).trustedAt(file)
        }).pipe(Effect.provide(services))
      const file = path.join(worktree, "a.fake")
      expect([yield* ask(path.join(repo, "a.fake")), yield* ask(file)]).toEqual([true, false])
      yield* trust.grant(worktree, { persist: false, via: "test" })
      expect(yield* ask(file)).toBe(true)
    }),
  )

  it.live("an untrusted project gates every file, whatever its owner", () =>
    Effect.gen(function* () {
      const { project, trusted, trust, services } = yield* layout
      yield* trust.revoke(project)
      yield* Effect.gen(function* () {
        const projectTrust = yield* ProjectTrust.Service
        expect(yield* projectTrust.trustedAt(path.join(project, "a.fake"))).toBe(false)
        expect(yield* projectTrust.trustedAt(path.join(trusted, "a.fake"))).toBe(false)
      }).pipe(Effect.provide(services))
    }),
  )

  it.live("Lsp.diagnostics, Lsp.request and Lsp.send start nothing for a file whose owner is not trusted", () =>
    Effect.gen(function* () {
      const { marker, project, untrusted, trusted, services } = yield* layout
      const files = [path.join(project, "sub", "in.fake"), path.join(untrusted, "out.fake"), path.join(trusted, "ok.fake")]
      yield* Effect.promise(() => Promise.all(files.map((file) => Bun.write(file, "an ERROR\n"))))
      yield* Effect.gen(function* () {
        const lsp = yield* Lsp.Service
        const hover = (file: string) => lsp.request("textDocument/hover", file, { position: { line: 0, character: 0 } })
        for (const options of [undefined, { save: true }]) {
          const found = yield* lsp.diagnostics(files, options)
          expect(Object.keys(found).sort()).toEqual([files[0]!, files[2]!].sort())
        }
        expect((yield* hover(files[1]!).pipe(Effect.flip)).message).toBe(
          "Language servers stay off for a file whose folder is not trusted.",
        )
        expect(yield* hover(files[2]!)).toEqual({ contents: { kind: "markdown", value: "a fake symbol" } })
        // `send` takes the same gate: no server is told about a file whose owner is not trusted.
        const search = (file: string) => lsp.send("workspace/symbol", file, { query: "" })
        expect((yield* search(files[1]!).pipe(Effect.flip)).message).toBe(
          "Language servers stay off for a file whose folder is not trusted.",
        )
        expect(yield* search(files[2]!)).toBeArray()
      }).pipe(Effect.provide(services))
      const text = yield* opened(marker)
      expect(text).toContain("in.fake")
      expect(text).toContain("ok.fake")
      expect(text).not.toContain("out.fake")
    }),
  )

  // Prettier and others load a config script found by walking up from the file they are given. The marker formatter does
  // the same, so a spelling under an untrusted folder reaches that folder's script even when the real file is elsewhere.
  it.live("Formatter.file runs no config from an untrusted folder through a link, and does from a trusted one", () =>
    Effect.gen(function* () {
      const { root, untrusted, trusted, services } = yield* layout
      const ran = path.join(root, "config-ran.txt")
      const script = `require('fs').appendFileSync(${JSON.stringify(ran)}, 'ran ')`
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(trusted, "dir"), { recursive: true })
        await fs.mkdir(path.join(untrusted, "dir"), { recursive: true })
        await Bun.write(path.join(untrusted, "config.cjs"), script)
        await Bun.write(path.join(trusted, "config.cjs"), script)
        await fs.symlink(path.join(trusted, "dir"), path.join(untrusted, "tlink"), "junction")
        await fs.symlink(path.join(trusted, "dir"), path.join(trusted, "tlink"), "junction")
        // No marker anywhere on the bare spelling: the script of `bare` is the only config the walk meets first.
        await fs.mkdir(path.join(root, "bare"), { recursive: true })
        await Bun.write(path.join(root, "bare", "config.cjs"), script)
        await fs.symlink(trusted, path.join(root, "bare", "tlink"), "junction")
      })
      const walk = `let d = require('path').dirname(process.argv.at(-1)); for (;;) { const c = require('path').join(d, 'config.cjs'); if (require('fs').existsSync(c)) { require(c); break } const n = require('path').dirname(d); if (n === d) break; d = n }`
      const run = (file: string) =>
        Effect.gen(function* () {
          const formatter = yield* Formatter.Service
          yield* formatter.transform((editor) =>
            editor.set({ name: "walker", extensions: [".fake"], enabled: Effect.succeed([process.execPath, "-e", walk, "$FILE"]) }),
          )
          return yield* formatter.file(file)
        }).pipe(Effect.provide(services))
      const ranCount = () => Effect.promise(async () => ((await Bun.file(ran).exists()) ? (await Bun.file(ran).text()).length : 0))
      expect(yield* run(path.join(untrusted, "tlink", "t.fake"))).toBe(false)
      expect(yield* ranCount()).toBe(0)
      expect(yield* run(path.join(root, "bare", "tlink", "t.fake"))).toBe(false)
      expect(yield* ranCount()).toBe(0)
      expect(yield* run(path.join(trusted, "tlink", "t.fake"))).toBe(true)
      expect(yield* ranCount()).toBeGreaterThan(0)
    }),
  )

  it.live("Formatter.file runs no formatter for a file whose owner is not trusted", () =>
    Effect.gen(function* () {
      const { root, untrusted, trusted, services } = yield* layout
      const ran = path.join(root, "formatted.txt")
      yield* Effect.gen(function* () {
        const formatter = yield* Formatter.Service
        yield* formatter.transform((editor) =>
          editor.set({
            name: "marker",
            extensions: [".fake"],
            enabled: Effect.succeed([
              process.execPath,
              "-e",
              `require('fs').appendFileSync(${JSON.stringify(ran)}, process.argv.at(-1) + '\\n')`,
              "$FILE",
            ]),
          }),
        )
        expect(yield* formatter.file(path.join(untrusted, "out.fake"))).toBe(false)
        expect(yield* formatter.file(path.join(trusted, "ok.fake"))).toBe(true)
      }).pipe(Effect.provide(services))
      const text = yield* Effect.promise(() => Bun.file(ran).text())
      expect(text).toContain("ok.fake")
      expect(text).not.toContain("out.fake")
    }),
  )
})
