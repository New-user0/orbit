import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Git } from "@orbit/core/git"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { initRepo } from "./fixture/git"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Lsp.ignored: which of these absolute paths does git ignore in the Location's repository?
// The matrix: Location spelling (the real folder, a junction to it) x path (ignored, tracked despite a pattern, plain,
// an ignored `..cache` folder that only looks like `..`, outside the worktree) x failure (none, git fails, untrusted).
const repository = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const real = path.join(root, "real")
  const link = path.join(root, "link")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(real, "ignored"), { recursive: true })
    await fs.mkdir(path.join(real, "..cache"), { recursive: true })
    await fs.mkdir(path.join(real, "src"), { recursive: true })
    await initRepo(real)
    await Bun.write(path.join(real, ".gitignore"), "ignored/\n..cache/\n")
    await Bun.write(path.join(real, "ignored", "tracked.fake"), "x")
    await Bun.write(path.join(real, "ignored", "a.fake"), "x")
    await Bun.write(path.join(real, "..cache", "c.fake"), "x")
    await Bun.write(path.join(real, "src", "b.fake"), "x")
    const add = Bun.spawn(["git", "add", "-f", "ignored/tracked.fake"], { cwd: real })
    await add.exited
    await fs.symlink(real, link, "junction")
  })
  return { root, real, link }
})

const lsp = (directory: string, options?: { readonly untrusted?: boolean; readonly git?: Layer.Layer<Git.Service> }) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AppNodeBuilder.build(Lsp.node, [
        ...(options?.untrusted
          ? [
              Global.node.replace(tempGlobalLayer),
              WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
            ]
          : []),
        ...(options?.git ? [Git.node.replace(options.git)] : []),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
          ),
        ),
      ]),
    )
    return Context.get(context, Lsp.Service)
  })

const names = (base: string, outside: string) => ({
  ignored: path.join(base, "ignored", "a.fake"),
  tracked: path.join(base, "ignored", "tracked.fake"),
  plain: path.join(base, "src", "b.fake"),
  dots: path.join(base, "..cache", "c.fake"),
  outside: path.join(outside, "elsewhere.fake"),
})

describe("Lsp.ignored", () => {
  for (const spelling of ["real", "link"] as const)
    it.live(`hides ignored files and only those, Location at the ${spelling} folder`, () =>
      Effect.gen(function* () {
        const { root, real, link } = yield* repository
        const base = spelling === "real" ? real : link
        const service = yield* lsp(base)
        const file = names(base, root)
        const hidden = yield* service.ignored(Object.values(file))
        // The outside file is not asked about, so it cannot fail the batch and hide the others.
        expect([...hidden].sort()).toEqual([file.dots, file.ignored].sort())
      }),
    )

  it.live("a path in the real spelling is handled when the Location is the junction", () =>
    Effect.gen(function* () {
      const { root, real, link } = yield* repository
      const service = yield* lsp(link)
      const hidden = yield* service.ignored([names(real, root).ignored, names(link, root).ignored])
      expect([...hidden].sort()).toEqual([names(real, root).ignored, names(link, root).ignored].sort())
    }),
  )

  // The Location is a subfolder, so the ignored file at the repository root is outside the Location.
  for (const spelling of ["real", "link"] as const)
    it.live(`hides an ignored file outside the Location, Location at the ${spelling} subfolder`, () =>
      Effect.gen(function* () {
        const { real, link } = yield* repository
        yield* Effect.promise(() => fs.mkdir(path.join(real, "sub"), { recursive: true }))
        const base = spelling === "real" ? real : link
        const service = yield* lsp(path.join(base, "sub"))
        const file = path.join(base, "ignored", "a.fake")
        // In the link Location, the real spelling of the same file is handled too.
        const other = path.join(real, "ignored", "a.fake")
        expect([...(yield* service.ignored([file, other, path.join(base, "src", "b.fake")]))].sort()).toEqual(
          [...new Set([file, other])].sort(),
        )
      }),
    )

  it.live("a failing git check shows every result", () =>
    Effect.gen(function* () {
      const { root, real } = yield* repository
      const actual = Context.get(yield* Layer.build(AppNodeBuilder.build(Git.node, [])), Git.Service)
      const failing = Layer.succeed(
        Git.Service,
        Git.Service.of({
          ...actual,
          index: {
            ...actual.index,
            ignored: () =>
              Effect.fail(new Git.OperationError({ operation: "list_files", directory: AbsolutePath.make(real), message: "forced" })),
          },
        }),
      )
      const service = yield* lsp(real, { git: failing })
      expect([...(yield* service.ignored(Object.values(names(real, root))))]).toEqual([])
    }),
  )

  it.live("asks nothing while the folder is untrusted", () =>
    Effect.gen(function* () {
      const { root, real } = yield* repository
      const service = yield* lsp(real, { untrusted: true })
      expect([...(yield* service.ignored(Object.values(names(real, root))))]).toEqual([])
    }),
  )
})
