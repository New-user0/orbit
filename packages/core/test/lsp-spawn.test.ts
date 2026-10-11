import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { AbsolutePath } from "@orbit/core/schema"
import { expectOneSpelling, filterSource, spellingEnv, withLookupVariable } from "./fixture/child-env"
import { plant, withCurrentDirectoryOnPath } from "./fixture/decoy"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const server = path.join(import.meta.dir, "fixtures", "lsp", "fake-server.ts")

// Class 10: a language server is started by the spawner, which looks a program up on PATH only. The matrix: a
// configured bare name and a built-in, each with decoys of every kind Windows runs (.exe, .bat, .cmd) in the project
// folder and the server on PATH as the control; the variable that turns the working-folder lookup off removed from this
// process. What the config's `env` can do to the variable is pinned separately, by the child's own environment.
describe("starting a language server", () => {
  // A program on PATH that runs the fake server, in a folder of its own put first on PATH while `body` runs.
  const onPath = <A, E, R>(name: string, body: (bin: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const bin = (yield* tmpdirScoped()).path
      const windows = process.platform === "win32"
      const shim = path.join(bin, windows ? `${name}.cmd` : name)
      yield* Effect.promise(async () => {
        await Bun.write(
          shim,
          windows
            ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
            : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`,
        )
        await fs.chmod(shim, 0o755)
      })
      const before = process.env.PATH
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.PATH = `${bin}${path.delimiter}${before}`
        }),
        () => body(bin),
        () =>
          Effect.sync(() => {
            process.env.PATH = before
          }),
      )
    })

  const withLsp = <A, E>(
    directory: string,
    lsp: unknown,
    body: (service: Lsp.Interface) => Effect.Effect<A, E>,
    env: Record<string, string> = {},
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* Lsp.Service)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Lsp.node, [
          Config.node.replace(
            Config.testLayer([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ lsp, env }) })]),
          ),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
            ),
          ),
        ]),
      ),
    )

  // Decoys named like the server, of every kind that Windows runs, in the project folder. Each leaves a mark when run.
  const decoys = (directory: string, name: string) =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return async () => [] as string[]
      const ran = yield* Effect.promise(() => plant(directory, name))
      const marks = path.join(directory, "batch-ran.txt")
      yield* Effect.promise(() =>
        Promise.all(
          [".bat", ".cmd"].map((extension) =>
            fs.writeFile(path.join(directory, `${name}${extension}`), `@echo off\r\necho ran> "${marks}"\r\n`),
          ),
        ),
      )
      return async () => [...(await ran()), ...((await Bun.file(marks).exists()) ? ["batch"] : [])]
    })

  const file = (directory: string, name: string) =>
    Effect.promise(async () => {
      const target = path.join(directory, name)
      await Bun.write(target, "an ERROR\n")
      return target
    })

  it.live(
    "does not run a program of the project's folder for a configured bare name, and finds the one on PATH",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const ran = yield* decoys(directory, "orbit-fake-lsp")
        const target = yield* file(directory, "main.fake")
        // The config's env tries to remove the protection; the spawner sets it after the config's values.
        const lsp = {
          fake: {
            command: ["orbit-fake-lsp", "--stdio"],
            extensions: [".fake"],
            env: { NoDefaultCurrentDirectoryInExePath: "" },
          },
        }
        yield* withCurrentDirectoryOnPath(
          withLsp(directory, lsp, (service) =>
            service.diagnostics([target]).pipe(
              Effect.tap((found) => Effect.sync(() => expect(found).toEqual({}))),
            ),
          ),
        )
        expect(yield* Effect.promise(ran)).toEqual([])

        // The same name on PATH is the control: it starts and answers, and the decoys still do not run.
        yield* onPath("orbit-fake-lsp", () =>
          withCurrentDirectoryOnPath(
            withLsp(directory, lsp, (service) =>
              service.diagnostics([target]).pipe(
                Effect.tap((found) => Effect.sync(() => expect(Object.keys(found)).toEqual([target]))),
              ),
            ),
          ),
        )
        expect(yield* Effect.promise(ran)).toEqual([])
      }),
    // The test compiles its decoy program, which takes longer on a slow disk.
    30_000,
  )

  // Class 10, one spelling. A server never sees a lookup variable the config blanked, and it gets one PATH: the config's
  // `path` and the server's own `Path` reach it as a single variable, whatever order the spawner merges them in. (Decoys
  // cannot pin this: Windows stops the working-folder lookup for any value of the variable, so only an absent variable
  // runs one, and nothing in `env` can remove it.)
  if (process.platform === "win32")
    it.live(
      "starts a server with one spelling of PATH and the lookup variable at 1, whatever the top-level env says",
      () =>
        withLookupVariable(
          Effect.gen(function* () {
            const directory = (yield* tmpdirScoped()).path
            const target = yield* file(directory, "main.fake")
            const seen = path.join(directory, "seen.json")
            const probe = path.join(directory, "probe.ts")
            yield* Effect.promise(() =>
              Bun.write(
                probe,
                `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(${filterSource}))\nprocess.exit(0)\n`,
              ),
            )
            const lsp = {
              fake: { command: [process.execPath, probe], extensions: [".fake"], env: { Path: spellingEnv.path } },
            }
            yield* withLsp(directory, lsp, (service) => service.diagnostics([target]).pipe(Effect.ignore), spellingEnv)
            expectOneSpelling(JSON.parse(yield* Effect.promise(() => Bun.file(seen).text())))
          }),
        ),
      30_000,
    )

  it.live(
    "starts a server with the top-level env under the server's own env",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const target = yield* file(directory, "main.fake")
        const seen = path.join(directory, "seen.txt")
        const probe = path.join(directory, "probe.ts")
        yield* Effect.promise(() =>
          Bun.write(
            probe,
            `import fs from "node:fs"
fs.writeFileSync(${JSON.stringify(seen)}, [process.env.ZZ_ENV_A, process.env.ZZ_ENV_B].join("|"))
process.exit(0)
`,
          ),
        )
        const lsp = {
          fake: {
            command: [process.execPath, probe],
            extensions: [".fake"],
            env: { ZZ_ENV_B: "server" },
          },
        }
        yield* withLsp(directory, lsp, (service) => service.diagnostics([target]).pipe(Effect.ignore), {
          ZZ_ENV_A: "from-settings",
          ZZ_ENV_B: "from-settings",
        })
        expect(yield* Effect.promise(() => Bun.file(seen).text())).toBe("from-settings|server")
      }),
    30_000,
  )

  it.live(
    "runs a built-in server found on PATH, never a program of the project folder",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const ran = yield* decoys(directory, "gopls")
        const target = yield* file(directory, "main.go")
        yield* onPath("gopls", () =>
          withCurrentDirectoryOnPath(
            withLsp(directory, {}, (service) =>
              service.diagnostics([target]).pipe(
                Effect.tap((found) => Effect.sync(() => expect(Object.keys(found)).toEqual([target]))),
              ),
            ),
          ),
        )
        expect(yield* Effect.promise(ran)).toEqual([])
      }),
    30_000,
  )
})
