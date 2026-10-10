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
      const { root, project, untrusted, trusted, services } = yield* layout
      const upper = (file: string) => file.toUpperCase()
      // Links: a folder link needs no privilege on Windows (a junction); a dangling file link does.
      yield* Effect.promise(async () => {
        await fs.symlink(untrusted, path.join(project, "link-untrusted"), "junction")
        await fs.symlink(trusted, path.join(project, "link-trusted"), "junction")
        if (!canLinkFile) return
        await fs.symlink(path.join(untrusted, "new.fake"), path.join(project, "dangling-untrusted.fake"))
        await fs.symlink(path.join(trusted, "new.fake"), path.join(project, "dangling-trusted.fake"))
      })
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
        const git = (...args: string[]) =>
          Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
            cwd: repo,
            stdout: "ignore",
            stderr: "ignore",
          }).exited
        await git("init", "-q")
        await git("commit", "-q", "--allow-empty", "-m", "init")
        await git("worktree", "add", "-q", worktree)
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

  it.live("Lsp.diagnostics and Lsp.request start nothing for a file whose owner is not trusted", () =>
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
      }).pipe(Effect.provide(services))
      const text = yield* opened(marker)
      expect(text).toContain("in.fake")
      expect(text).toContain("ok.fake")
      expect(text).not.toContain("out.fake")
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
