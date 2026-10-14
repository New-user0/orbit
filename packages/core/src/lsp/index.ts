export * as Lsp from "./index.js"

import { isRecord } from "@orbit/ai/utils/record"
import { ConfigLSP } from "@orbit/schema/config/lsp"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"
import { Config } from "../config.js"
import { ConfigEnv } from "../config/env.js"
import { Git } from "../git.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { RelativePath } from "../schema.js"
import { which } from "@orbit/util/which"
import { LspClient } from "./client.js"

/**
 * Language servers for the files a Location edits. Servers come from the `lsp` config and from built-in definitions
 * whose command is already on PATH; nothing is downloaded. Each server starts the first time a matching file needs
 * it and stops with the Location. `lsp: false` turns them all off. None starts while the Location's project is not
 * trusted: a language server reads the folder's own code, and several of them run it. A file outside the project is
 * served only when the folder that owns it is trusted too (`ProjectTrust.trustedAt`). Programs are found on PATH only.
 */

export type Diagnostic = LspClient.Diagnostic

/** `code` is the JSON-RPC error code when the server itself answered with an error. */
export class Error extends Schema.TaggedError<Error>()("Lsp.Error", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.Number),
}) {}

// The server is still working out its project and asks the client to try again.
const CONTENT_MODIFIED = -32801
// Up to three silent retries, 0.5 s, 1 s and 2 s apart.
const retrySchedule = Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(3)])
// A server is only sent files up to this size.
const MAX_FILE_BYTES = 10_000_000

export interface Server {
  readonly id: string
  readonly command: readonly string[]
  readonly extensions: readonly string[]
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

export const BUILT_IN: readonly Server[] = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  },
  { id: "pyright", command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  { id: "gopls", command: ["gopls"], extensions: [".go"] },
  { id: "rust-analyzer", command: ["rust-analyzer"], extensions: [".rs"] },
]

export interface Interface {
  /**
   * Diagnostics for each file that has a language server, keyed by absolute path. With `save`, each server is also told
   * its file was saved; only edits that reached the disk say so, so a read-only query never does.
   */
  readonly diagnostics: (
    files: readonly string[],
    options?: { readonly save?: boolean },
  ) => Effect.Effect<Record<string, Diagnostic[]>>
  /** Sends a request about a file to its language server. The document is added to the params. */
  readonly request: (method: string, file: string, params: Record<string, unknown>) => Effect.Effect<unknown, Error>
  /**
   * Sends a request that names no document, such as a workspace symbol search. The file is opened first, so a
   * project-aware server loads the project it belongs to, and it chooses the server; the params go out as given.
   */
  readonly send: (method: string, file: string, params: Record<string, unknown>) => Effect.Effect<unknown, Error>
  /**
   * The files among these absolute paths that git ignores in the Location's repository. A tracked file is never
   * ignored. A Location outside a repository, and any failure, ignore nothing.
   */
  readonly ignored: (files: readonly string[]) => Effect.Effect<ReadonlySet<string>>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Lsp") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const trust = yield* ProjectTrust.Service
    const spawner = yield* ChildProcessSpawner
    const git = yield* Git.Service
    // One start attempt per server; a server that fails to start stays off until the Location reloads.
    const clients = new Map<string, Promise<LspClient.Client | undefined>>()
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.all(
          [...clients.values()].map((pending) => pending.then((client) => client?.shutdown()).catch(() => undefined)),
        ),
      ),
    )

    const servers = Effect.fn("Lsp.servers")(function* () {
      const configured = Config.latest(yield* config.entries(), "lsp")
      if (configured === false) return []
      const overrides = typeof configured === "object" ? configured : {}
      const custom = Object.entries(overrides).flatMap(([id, entry]) =>
        Schema.is(ConfigLSP.Server)(entry) && !entry.disabled && entry.extensions
          ? [
              {
                id,
                command: entry.command,
                extensions: entry.extensions,
                env: entry.env,
                initialization: entry.initialization,
              },
            ]
          : [],
      )
      // A built-in starts from the path that `which` found on PATH, never from its bare name.
      const builtIn = BUILT_IN.filter((server) => !(server.id in overrides)).flatMap((server) => {
        const found = which(server.command[0]!)
        return found === null ? [] : [{ ...server, command: [found, ...server.command.slice(1)] }]
      })
      return [...custom, ...builtIn]
    })

    const client = Effect.fn("Lsp.client")(function* (file: string) {
      const server = (yield* servers()).find((item) => item.extensions.includes(path.extname(file).toLowerCase()))
      if (!server) return undefined
      const pending =
        clients.get(server.id) ??
        // The settings' `env` sits under the server's own variables.
        LspClient.start({
          ...server,
          env: ConfigEnv.applyTo(
            ConfigEnv.applyTo(
              {},
              location.workspaceID === undefined ? ConfigEnv.resolve(yield* config.entries()) : {},
            ),
            server.env ?? {},
          ),
          root: location.project.directory,
          spawner,
        }).catch((error: unknown) => {
          console.warn(`language server ${server.id} failed to start`, error)
          return undefined
        })
      clients.set(server.id, pending)
      return yield* Effect.promise(() => pending)
    })

    // A server reads the configuration near the file it is told about, and several of them run it, so a file outside the
    // project needs its own folder to be trusted too. A refused file is skipped.
    const allowed = Effect.fnUntraced(function* (file: string) {
      if (yield* trust.trustedAt(file)) return true
      yield* Effect.logWarning("language server skipped a file whose folder is not trusted", { file })
      return false
    })

    // The one path every request takes, so `send` cannot drift from `request` on trust, size or retry.
    const ask = Effect.fnUntraced(function* (
      method: string,
      file: string,
      params: Record<string, unknown>,
      document: boolean,
    ) {
      if (!(yield* trust.trusted()))
        return yield* new Error({ message: "Language servers stay off until this folder is trusted." })
      if (!(yield* allowed(file)))
        return yield* new Error({ message: "Language servers stay off for a file whose folder is not trusted." })
      const target = yield* client(file)
      if (!target) return yield* new Error({ message: `No language server is available for ${path.basename(file)}.` })
      const size = yield* fs.stat(file).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      )
      if (size > MAX_FILE_BYTES)
        return yield* new Error({
          message: `${path.basename(file)} is ${Math.ceil(size / 1_000_000)} MB; language servers are only sent files up to 10 MB.`,
        })
      const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) return yield* new Error({ message: `Cannot read ${file}.` })
      return yield* Effect.tryPromise({
        try: () =>
          document
            ? target.request(method, file, text, params)
            : target.open(file, text).then(() => target.send(method, params)),
        catch: (cause) =>
          new Error({
            message: `${target.id} could not answer: ${String(cause)}`,
            ...(isRecord(cause) && typeof cause.code === "number" ? { code: cause.code } : {}),
          }),
      }).pipe(Effect.retry({ schedule: retrySchedule, while: (error) => error.code === CONTENT_MODIFIED }))
    })

    return Service.of({
      diagnostics: Effect.fn("Lsp.diagnostics")(
        function* (files, options) {
          if (!(yield* trust.trusted())) return {}
          const found = yield* Effect.forEach(
            files,
            (file) =>
              Effect.gen(function* () {
                if (!(yield* allowed(file))) return []
                const target = yield* client(file)
                const text = target
                  ? yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
                  : undefined
                if (!target || text === undefined) return []
                const items = yield* Effect.promise(() => target.diagnostics(file, text, options).catch(() => []))
                return [[file, items] as const]
              }),
            { concurrency: "unbounded" },
          )
          return Object.fromEntries(found.flat())
        },
        Effect.orElseSucceed(() => ({})),
      ),
      request: Effect.fn("Lsp.request")(function* (method, file, params) {
        return yield* ask(method, file, params, true)
      }),
      send: Effect.fn("Lsp.send")(function* (method, file, params) {
        return yield* ask(method, file, params, false)
      }),
      ignored: Effect.fn("Lsp.ignored")(
        function* (files) {
          // git runs in this folder's repository, so the folder has to be trusted first.
          if (!(yield* trust.trusted())) return new Set<string>()
          const repository = yield* git.repo.discover(location.directory)
          if (!repository || files.length === 0) return new Set<string>()
          // git reports the real worktree, while results use the Location's own spelling (a junction, a link or a
          // subst drive). The worktree is re-spelled the way the Location spells it, so a path anywhere in the
          // repository, not only under the Location, is compared in its own spelling.
          const real = yield* fs.resolve(location.directory)
          const spelled = path.resolve(location.directory, path.relative(real, repository.worktree))
          // A path outside the worktree is not asked about: git would refuse the whole batch.
          const inside = files.flatMap((file) => {
            const within = path.relative(spelled, file)
            const relative = outside(within) ? path.relative(repository.worktree, file) : within
            return relative === "" || outside(relative)
              ? []
              : [{ file, relative: RelativePath.make(relative.split(path.sep).join("/")) }]
          })
          const hidden = yield* git.index.ignored({
            repository,
            paths: inside.map((item) => item.relative),
            tracked: "keep",
          })
          return new Set(inside.filter((item) => hidden.has(item.relative)).map((item) => item.file))
        },
        Effect.timeout("5 seconds"),
        // A check that fails shows every result. Defects and interruption still surface.
        Effect.catch((error) =>
          Effect.logDebug("git ignore check failed; showing every result", error).pipe(
            Effect.as(new Set<string>() as ReadonlySet<string>),
          ),
        ),
      ),
    })
  }),
)

// A relative path that leaves its base: `..` itself, `../x`, or another drive. A folder named `..cache` stays inside.
const outside = (relative: string) =>
  relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Git.node, Location.node, ProjectTrust.node, CrossSpawnSpawner.node],
})
