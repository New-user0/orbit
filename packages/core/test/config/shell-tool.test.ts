import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { ConfigTrust } from "@orbit/core/config/trust"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Document, Info } from "@orbit/schema/config"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

function normalized(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result
}

describe("shell_tool normalization", () => {
  test("keeps both fields", () => {
    const result = normalized({ shell_tool: { timeout: 30_000, max_timeout: 90_000 } })
    expect(result.encoded.shell_tool).toEqual({ timeout: 30_000, max_timeout: 90_000 })
    expect(result.diagnostics).toEqual([])
    expect(Schema.decodeUnknownSync(Info)(result.encoded).shell_tool).toMatchObject({
      timeout: 30_000,
      max_timeout: 90_000,
    })
  })

  for (const field of ["timeout", "max_timeout"]) {
    for (const value of [0, -1, 1.5, "x"]) {
      test(`reports and drops ${field} ${JSON.stringify(value)}`, () => {
        const result = normalized({ shell_tool: { [field]: value } })
        expect(result.encoded.shell_tool).toBeUndefined()
        expect(result.diagnostics.map((item) => item.kind)).toContain("invalid")
      })
    }
  }

  test("is replaced whole by a document of higher precedence", () => {
    const user = new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ shell_tool: { timeout: 1000, max_timeout: 5000 } }) })
    const project = new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ shell_tool: { timeout: 2000 } }) })
    expect(Config.latest([user], "shell_tool")).toEqual({ timeout: 1000, max_timeout: 5000 })
    expect(Config.latest([user, project], "shell_tool")).toEqual({ timeout: 2000 })
  })
})

describe("shell_tool under trust", () => {
  const repo = path.resolve("/trust-fixture/repo")
  const place = { roots: [repo], directory: repo }

  test("is classified as a withheld shell setting", () => {
    expect(ConfigTrust.classification.info.shell_tool).toEqual({ type: "withhold", kind: "providers" })
    const result = ConfigTrust.sanitize(Schema.decodeUnknownSync(Info)({ shell_tool: { timeout: 1 } }), place)
    expect(result.info).not.toHaveProperty("shell_tool")
    expect(result.withheld).toEqual(["providers"])
  })

  const it = testEffect(Layer.empty)

  const loader = (home: string, work: string, implicit: boolean) =>
    AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
      Config.node.replace(Config.configured({ content: "{}" })),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(work) }))),
      ),
      Global.node.replace(Global.layerWith({ config: path.join(home, ".config", "orbit"), home })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ])

  const run = (implicit: boolean) =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const home = path.join(root, "home")
      const work = path.join(root, "work", "repo")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(home, ".config", "orbit"), { recursive: true })
        await fs.mkdir(work, { recursive: true })
        await Bun.write(
          path.join(home, ".config", "orbit", "orbit.json"),
          JSON.stringify({ shell_tool: { timeout: 50_000 } }),
        )
        await Bun.write(path.join(work, "orbit.json"), JSON.stringify({ shell_tool: { timeout: 1 } }))
      })
      return yield* Effect.gen(function* () {
        const config = yield* Config.Service
        return Config.latest(yield* config.entries(), "shell_tool")
      }).pipe(Effect.provide(loader(home, work, implicit)))
    })

  it.live("keeps the user's value over a project's in an untrusted folder", () =>
    run(false).pipe(Effect.tap((value) => Effect.sync(() => expect(value).toEqual({ timeout: 50_000 })))),
  )

  it.live("applies the project's value once the folder is trusted", () =>
    run(true).pipe(Effect.tap((value) => Effect.sync(() => expect(value).toEqual({ timeout: 1 })))),
  )
})
