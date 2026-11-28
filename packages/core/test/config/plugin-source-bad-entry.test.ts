import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 7: one plugin folder that cannot be resolved costs only itself. A tui-only folder (no server entry) whose tui.ts
// is a link to itself must not stop the supervisor from offering the plugins next to it.

const it = testEffect(Layer.empty)

const loader = (root: string, repo: string, filesystem?: Layer.Layer<FSUtil.Service>) =>
  AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node, ConfigPluginSource.node]), [
    ...(filesystem === undefined ? [] : [FSUtil.node.replace(filesystem)]),
    Config.node.replace(Config.configured({ content: "{}" })),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(repo) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(root, "home", ".config", "orbit"), home: path.join(root, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])

describe("a plugin folder with a looping entry", () => {
  it.live("the other plugins are still offered", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "p"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
      })
      const linked = yield* Effect.promise(() =>
        fs.symlink(path.join(plugins, "p", "tui.ts"), path.join(plugins, "p", "tui.ts"), "file").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
      )
      if (!linked) return
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )

  // The catchCause in `leaves`: a folder with a server entry still has its tui entry resolved, and a link that loops
  // there counts as leaving the folder for that plugin only.
  it.live("a server plugin folder whose tui entry loops costs only itself", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "p"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
        await fs.writeFile(path.join(plugins, "p", "server.ts"), "export default 1;")
      })
      const linked = yield* Effect.promise(() =>
        fs.symlink(path.join(plugins, "p", "tui.ts"), path.join(plugins, "p", "tui.ts"), "file").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
      )
      if (!linked) return
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )

  // `entryLinks`: a link that could be an entry is checked even when the resolver took another file for that entry or
  // never asked for it (Bun 1.4.5's resolver passes over a link that loops). The `.mjs` link comes after `.ts` in the
  // resolver's order, so it is never what the resolver returns. A link whose name is not an entry name is not checked.
  // The names are matched without case (Windows and macOS resolve `TUI.ts` for `tui`), and inside a real `server/`,
  // `index/`, `tui/` or `rpc/` folder the links that folder's own entry could be are checked too: its `index`, its
  // `package.json` and each step of the `main` that names (a `./` step names the folder itself, and the `index` is checked
  // when `main` names a file that is not there). The lowercase rows are the controls of the case rows, and the
  // `other` rows and `server/index/index.ts` (the resolver does not look two folders down for an index) are the
  // controls of the names: a link the resolver would never look at keeps its folder offered.
  for (const row of [
    { link: "server.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "index.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "tui.mjs", files: ["server.ts", "tui.ts"], offered: ["good.ts"] },
    { link: "rpc.mjs", files: ["server.ts", "rpc.ts"], offered: ["good.ts"] },
    { link: "other.mjs", files: ["server.ts"], offered: ["good.ts", "p"] },
    { link: "tui.ts", files: ["server.ts"], offered: ["good.ts"] },
    { link: "TUI.ts", files: ["server.ts"], offered: ["good.ts"] },
    { link: "Tui.ts", files: ["server.ts"], offered: ["good.ts"] },
    { link: "Server.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "INDEX.js", files: ["server.ts"], offered: ["good.ts"] },
    { link: "server/index.ts", files: ["index.ts"], offered: ["good.ts"] },
    { link: "Server/Index.ts", files: ["index.ts"], offered: ["good.ts"] },
    { link: "tui/index.ts", files: ["server.ts"], offered: ["good.ts"] },
    { link: "index/index.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "server/other.ts", files: ["index.ts"], offered: ["good.ts", "p"] },
    { link: "other/index.ts", files: ["server.ts"], offered: ["good.ts", "p"] },
    { link: "server/index/index.ts", files: ["index.ts"], offered: ["good.ts", "p"] },
    { link: "server/package.json", files: ["server/index.ts"], offered: ["good.ts"] },
    { link: "server/Package.json", files: ["server/index.ts"], offered: ["good.ts"] },
    { link: "server/main.js", files: ["server/index.ts"], main: "main.js", offered: ["good.ts"] },
    { link: "server/x.ts", files: ["server/index.ts"], main: "x.js", offered: ["good.ts"] },
    { link: "server/lib/x.js", files: ["server/index.ts"], main: "lib/x.js", offered: ["good.ts"] },
    { link: "server/lib/x.js", files: ["server/index.ts"], main: "Lib/X.js", offered: ["good.ts"] },
    { link: "server/lib.ts", files: ["server/index.ts"], main: "lib", offered: ["good.ts"] },
    { link: "server/lib/index.ts", files: ["server/index.ts"], main: "lib", offered: ["good.ts"] },
    { link: "server/lib/other.js", files: ["server/index.ts", "server/lib/x.js"], main: "lib/x.js", offered: ["good.ts", "p"] },
    { link: "server/main.js", files: ["server/index.ts"], main: "../server/main.js", offered: ["good.ts"] },
    { link: "server/main.js", files: ["server/index.ts"], main: "./main.js", offered: ["good.ts"] },
    { link: "server/index.ts", files: ["index.ts"], main: "missing.js", offered: ["good.ts"] },
    { link: "q/x.js", files: ["server/index.ts"], main: "../q/x.js", offered: ["good.ts"] },
  ]) {
    const manifest = row.main === undefined ? "" : ` with main ${row.main}`
    const name = `a server plugin folder with a looping ${row.link}${manifest} beside ${row.files.join(" and ")}`
    it.live(`${name} offers ${row.offered.join(" and ")}`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const repo = path.join(root, "work", "repo")
        const plugins = path.join(root, "home", ".config", "orbit", "plugins")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(path.join(plugins, "p", row.link)), { recursive: true })
          await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
          await Promise.all(
            row.files.map(async (file) => {
              await fs.mkdir(path.dirname(path.join(plugins, "p", file)), { recursive: true })
              await fs.writeFile(path.join(plugins, "p", file), "export default 1;")
            }),
          )
          if (row.main !== undefined)
            await fs.writeFile(path.join(plugins, "p", "server", "package.json"), JSON.stringify({ main: row.main }))
        })
        const linked = yield* Effect.promise(() =>
          fs.symlink(path.join(plugins, "p", row.link), path.join(plugins, "p", row.link), "file").then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "EPERM" || error.code === "UNKNOWN") return false
              throw error
            },
          ),
        )
        if (!linked) return
        const offered = yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
        }).pipe(Effect.provide(loader(root, repo)))
        expect(offered.toSorted()).toEqual(row.offered)
      }),
    )
  }

  // An entry folder, or a folder a step of `main` names, can be a link to a folder (a junction on Windows). The resolver
  // enters it, so what is behind it is checked as in a real folder: the `index` of a linked `server` (rows A) and a
  // `main` step through a linked `lib` (rows B). A `..` of `main` is taken from the link's own path, as Bun 1.4.5 does
  // (rows C), and from the real path it leads to, the stricter answer (rows D). Each row has a control with a real file
  // in place of the looping link, which keeps `p` offered.
  for (const row of [
    { name: "A", link: "server", to: "impl", files: ["index.ts"], entry: "impl/index.ts" },
    {
      name: "B",
      link: "server/lib",
      to: "server/real",
      files: ["server/index.ts"],
      manifest: { file: "server/package.json", main: "lib/x.js" },
      entry: "server/real/x.js",
    },
    {
      name: "C",
      link: "server",
      to: "a/real",
      files: ["index.ts"],
      manifest: { file: "a/real/package.json", main: "../q/x.js" },
      entry: "q/x.js",
    },
    {
      name: "D",
      link: "server",
      to: "a/real",
      files: ["index.ts", "q/x.js"],
      manifest: { file: "a/real/package.json", main: "../q/x.js" },
      entry: "a/q/x.js",
    },
  ].flatMap((row) => [
    { ...row, loops: true, offered: ["good.ts"] },
    { ...row, loops: false, offered: ["good.ts", "p"] },
  ])) {
    const entry = `${row.loops ? "a looping" : "a real"} ${row.entry}`
    const manifest = row.manifest === undefined ? "" : ` and main ${row.manifest.main}`
    const name = `${row.name}: a server plugin folder whose ${row.link} links to ${row.to}, with ${entry}${manifest} beside ${row.files.join(" and ")}`
    it.live(`${name} offers ${row.offered.join(" and ")}`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const repo = path.join(root, "work", "repo")
        const plugins = path.join(root, "home", ".config", "orbit", "plugins")
        const inside = (file: string) => path.join(plugins, "p", file)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(inside(row.entry)), { recursive: true })
          await fs.mkdir(inside(row.to), { recursive: true })
          await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
          await Promise.all(
            row.files.map(async (file) => {
              await fs.mkdir(path.dirname(inside(file)), { recursive: true })
              await fs.writeFile(inside(file), "export default 1;")
            }),
          )
          if (row.manifest !== undefined)
            await fs.writeFile(inside(row.manifest.file), JSON.stringify({ main: row.manifest.main }))
          await fs.symlink(inside(row.to), inside(row.link), "junction")
          if (!row.loops) await fs.writeFile(inside(row.entry), "export default 1;")
        })
        const linked = yield* Effect.promise(() =>
          row.loops
            ? fs.symlink(inside(row.entry), inside(row.entry), "file").then(
                () => true,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "EPERM" || error.code === "UNKNOWN") return false
                  throw error
                },
              )
            : Promise.resolve(true),
        )
        if (!linked) return
        const offered = yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
        }).pipe(Effect.provide(loader(root, repo)))
        expect(offered.toSorted()).toEqual(row.offered)
      }),
    )
  }

  // The resolver follows a `main` that climbs out of the plugin's folder with `..`, with no link on the way, so the entry
  // files it found are checked beside the links (`EntryLinks.escapes` takes them as `files`): the server entry's and the
  // tui entry's, which the server never imports but the terminal UI does (its rows of the same shape are in
  // `packages/tui/test/plugin-trust.test.ts`). The control's `main` climbs only to a file inside the folder, which keeps
  // `p` offered.
  for (const row of [
    { folder: "server", to: ["outside", "x.js"], offered: ["good.ts"] },
    { folder: "server", to: ["home", ".config", "orbit", "plugins", "p", "lib", "x.js"], offered: ["good.ts", "p"] },
    { folder: "tui", to: ["outside", "x.js"], offered: ["good.ts"] },
    { folder: "tui", to: ["home", ".config", "orbit", "plugins", "p", "lib", "x.js"], offered: ["good.ts", "p"] },
  ]) {
    const name = `a server plugin folder whose ${row.folder}/package.json main climbs to ${row.to.join("/")}`
    it.live(`${name} offers ${row.offered.join(" and ")}`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const repo = path.join(root, "work", "repo")
        const plugins = path.join(root, "home", ".config", "orbit", "plugins")
        const folder = path.join(plugins, "p", row.folder)
        const entry = path.join(root, ...row.to)
        yield* Effect.promise(async () => {
          await fs.mkdir(folder, { recursive: true })
          await fs.mkdir(path.dirname(entry), { recursive: true })
          await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
          // A tui entry alone is not offered to the server, so the folder whose tui entry climbs has a server.ts too.
          if (row.folder === "tui") await fs.writeFile(path.join(plugins, "p", "server.ts"), "export default 1;")
          await fs.writeFile(entry, "export default 1;")
          await fs.writeFile(
            path.join(folder, "package.json"),
            JSON.stringify({ main: path.relative(folder, entry).split(path.sep).join("/") }),
          )
        })
        const offered = yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
        }).pipe(Effect.provide(loader(root, repo)))
        expect(offered.toSorted()).toEqual(row.offered)
      }),
    )
  }

  // `entryLinks` lists the folder after the resolver found its entries, and a listing that fails then (the folder was
  // removed, or its permissions changed, in between) costs no other plugin and not the folder's own (class 7). The
  // resolver lists the folder itself, so no folder on disk fails the second listing alone; the row fails it for `p`.
  it.live("a server plugin folder whose listing fails after it was resolved is offered with the others", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      const folder = path.join(plugins, "p")
      yield* Effect.promise(async () => {
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
        await fs.writeFile(path.join(folder, "server.ts"), "export default 1;")
      })
      const refused: string[] = []
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...real,
            readDirectoryEntries: (directory) => {
              if (path.resolve(directory) !== folder) return real.readDirectoryEntries(directory)
              refused.push(directory)
              return Effect.fail(new FSUtil.FileSystemError({ method: "readDirectoryEntries" }))
            },
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo, filesystem)))
      // The control: the failing listing was the one the row is about.
      expect(refused.length).toBeGreaterThan(0)
      expect(offered.toSorted()).toEqual(["good.ts", "p"])
    }),
  )

  // A folder named node_modules is never a plugin; the single-file plugin beside it still is.
  it.live("plugins/node_modules is not offered, and the plugin beside it is", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "node_modules"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
        await fs.writeFile(path.join(plugins, "node_modules", "index.js"), "export default 1;")
        await fs.writeFile(path.join(plugins, "node_modules", "server.ts"), "export default 1;")
      })
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )
})

describe("the time a plugin is stamped with", () => {
  // A plugin is loaded again when its stamp changes, and the `package.json` the runtime reads beside its entry counts:
  // the plugin folder's own for a folder, and the one in the folder that holds it for a single file. Each file gets
  // its own time, so the stamp names the file it came from.
  it.live("is the newest of the entry files and the package.json beside them", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      const times = [
        { file: path.join(plugins, "good.ts"), seconds: 1_000_000 },
        { file: path.join(plugins, "package.json"), seconds: 3_000_000 },
        { file: path.join(plugins, "p", "server.ts"), seconds: 1_000_000 },
        { file: path.join(plugins, "p", "package.json"), seconds: 2_000_000 },
      ]
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "p"), { recursive: true })
        await Promise.all(
          times.map(async (entry) => {
            await fs.writeFile(entry.file, entry.file.endsWith(".json") ? "{}" : "export default 1;")
            await fs.utimes(entry.file, entry.seconds, entry.seconds)
          }),
        )
      })
      const stamps = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) =>
          item.type === "add" ? [[path.basename(item.target), item.mtime]] : [],
        )
      }).pipe(Effect.provide(loader(root, repo)))
      expect(Object.fromEntries(stamps)).toEqual({ "good.ts": 3_000_000_000, p: 2_000_000_000 })
    }),
  )
})
