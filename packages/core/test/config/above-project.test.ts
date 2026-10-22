import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// trust-first part 2, D7 (owner, 2026-10-21: "match refrence"): as the reference reads project settings only from the
// project it starts in, Orbit reads `orbit.json`, `orbit.local.json`, `.orbit` and other products' project roots only from
// the folders between the working folder and the project's root, never from a folder above the project. A grant for a
// folder above covers the project below it (the parent walk of part 1), and still none of that folder's config is read.
// Instruction files are not config: their own walk is unchanged, and they are not part of these rows.
const folders = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const real = yield* Effect.promise(() => fs.realpath(tmp))
  const work = path.join(real, "work")
  const repo = path.join(work, "repo")
  // A folder inside the project, between the working folder and the project's root, whose config is the project's own.
  const inner = path.join(repo, "packages", "app")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(work, ".orbit", "plugins"), { recursive: true })
    await fs.mkdir(inner, { recursive: true })
    await Bun.write(path.join(work, "orbit.json"), JSON.stringify({ username: "ABOVE-USER" }))
    await Bun.write(path.join(work, "orbit.local.json"), JSON.stringify({ username: "ABOVE-LOCAL-USER" }))
    await Bun.write(path.join(work, ".orbit", "plugins", "above.ts"), `export default { id: "above", async setup() {} }\n`)
    // Another product's project root above the project, with a hook in its settings file.
    await Bun.write(
      path.join(work, CompatNames.vendor.directory, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo ABOVE" }] }] } }),
    )
    await Bun.write(path.join(repo, "orbit.json"), JSON.stringify({ username: "REPO-USER" }))
    await Bun.write(path.join(inner, "orbit.json"), JSON.stringify({ username: "INNER-USER" }))
  })
  return { home: path.join(real, "home"), globalConfig: path.join(real, "home", "config"), work, repo, inner }
})

// The Location opens at `directory` inside the project whose root is `repo`.
function loader(input: {
  readonly home: string
  readonly globalConfig: string
  readonly repo: string
  readonly directory: string
}) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make(input.directory) }, { projectDirectory: AbsolutePath.make(input.repo) }),
        ),
      ),
    ),
    Global.node.replace(Global.layerWith({ config: input.globalConfig, home: input.home })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
}

const listed = Effect.gen(function* () {
  const config = yield* Config.Service
  return (yield* config.entries()).flatMap((entry): string[] => (entry.path === undefined ? [] : [entry.path]))
})

// Reads the config again now, so the entries are those of a load that saw the latest grant.
const reread = Effect.gen(function* () {
  const config = yield* Config.Service
  const reload = config.reload
  expect(reload).toBeDefined()
  if (reload !== undefined) yield* reload()
})

describe("config above the project", () => {
  it.live("is never read, not even once a grant for its own folder covers the project below it", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      const above = [
        path.join(layout.work, "orbit.json"),
        path.join(layout.work, "orbit.local.json"),
        path.join(layout.work, ".orbit"),
        path.join(layout.work, CompatNames.vendor.directory, "settings.json"),
      ]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service

        // The grant for the folder above covers the project, so the project's own config is read.
        yield* trust.grant(layout.work, { persist: true, via: "test" })
        expect(yield* trust.status(layout.repo)).toMatchObject({ trusted: true, granted: layout.work })
        yield* reread
        const read = yield* listed
        expect(read).toContain(path.join(layout.repo, "orbit.json"))
        // None of the folder above is: not its documents, not its `.orbit` directory, not another product's root there.
        expect(read.filter((item) => above.includes(item))).toEqual([])
        expect(read.filter((item) => item.startsWith(layout.work) && !item.startsWith(layout.repo))).toEqual([])
      }).pipe(Effect.provide(loader({ ...layout, directory: layout.repo })))
    }),
  )

  it.live("leaves the folders between the working folder and the project's root read, as the project's own", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(layout.repo, { persist: true, via: "test" })
        yield* reread
        const read = yield* listed
        // The control: the project's root and the folder the session works in are both read.
        expect(read).toContain(path.join(layout.repo, "orbit.json"))
        expect(read).toContain(path.join(layout.inner, "orbit.json"))
        // And nothing above the root, which no grant here covers anyway.
        expect(read.filter((item) => item.startsWith(layout.work) && !item.startsWith(layout.repo))).toEqual([])

        // A grant for the folder above changes nothing about what is read: the walk ends at the project's root.
        yield* trust.grant(layout.work, { persist: true, via: "test" })
        yield* reread
        const after = yield* listed
        expect(after).toContain(path.join(layout.inner, "orbit.json"))
        expect(after.filter((item) => item.startsWith(layout.work) && !item.startsWith(layout.repo))).toEqual([])
      }).pipe(Effect.provide(loader({ ...layout, directory: layout.inner })))
    }),
  )
})

describe("config sources that are skipped", () => {
  // A source of an untrusted project is reported once (class 7), not again at every reload while its folder stays
  // untrusted. A folder above the project is not a source at all, so it is never reported.
  it.live("are logged once, however often the config is read again, and a folder above the project is not one", () => {
    const logged: string[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "config source skipped") return
      const details: unknown = entry.message[1]
      if (typeof details === "object" && details !== null && "path" in details) logged.push(String(details.path))
    })
    return Effect.gen(function* () {
      const layout = yield* folders
      yield* Effect.gen(function* () {
        yield* reread
        yield* reread
      }).pipe(Effect.provide(loader({ ...layout, directory: layout.repo })))
      const above = path.join(layout.work, "orbit.json")
      const own = path.join(layout.repo, "orbit.json")
      expect(logged.filter((item) => item === own)).toEqual([own])
      expect(logged.filter((item) => item === above)).toEqual([])
    }).pipe(Effect.provide(Logger.layer([logger])))
  })
})
