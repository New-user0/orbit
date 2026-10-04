import { describe, expect } from "bun:test"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { AbsolutePath } from "@orbit/core/schema"
import { location } from "./fixture/location"
import { Layer } from "effect"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const server = path.join(import.meta.dir, "fixtures", "lsp", "fake-server.ts")
const configured = (lsp: unknown) =>
  Config.testLayer([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ lsp }) })])

const withLsp = <A, E>(directory: string, lsp: unknown, body: (service: Lsp.Interface) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* body(yield* Lsp.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(Lsp.node, [
        Config.node.replace(configured(lsp)),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
      ]),
    ),
  )

describe("Lsp", () => {
  it.live("reports a configured server's diagnostics after each change, and answers requests", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "main.fake")
      yield* withLsp(directory, { fake: { command: [process.execPath, server], extensions: [".fake"] } }, (lsp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(file, "fine\nhere is an ERROR\n"))
          const first = yield* lsp.diagnostics([file, path.join(directory, "other.txt")])
          expect(Object.keys(first)).toEqual([file])
          expect(first[file]).toEqual([
            expect.objectContaining({
              message: "found ERROR",
              range: expect.objectContaining({ start: { line: 1, character: 11 } }),
            }),
          ])

          yield* Effect.promise(() => Bun.write(file, "all fine now\n"))
          expect((yield* lsp.diagnostics([file]))[file]).toEqual([])

          expect(yield* lsp.request("textDocument/hover", file, { position: { line: 0, character: 0 } })).toEqual({
            contents: { kind: "markdown", value: "a fake symbol" },
          })
        }),
      )
      yield* withLsp(directory, false, (lsp) =>
        lsp.diagnostics([file]).pipe(Effect.map((found) => expect(found).toEqual({}))),
      )
    }),
  )
})
