export * as MemoryListing from "./listing.js"

import { relative } from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { Instruction } from "@orbit/schema/instruction"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Agent } from "../agent.js"
import { Config } from "../config.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { InstructionNotes } from "../instruction-notes.js"
import { Location } from "../location.js"
import { Plugin } from "../plugin.js"
import { MemoryAgent } from "./agent.js"
import { MemoryStore } from "./store.js"
import { MemoryTeam } from "./team.js"

/**
 * What `/memory` shows and makes. The listing is the Location's start-up list of instruction files (no nested file that
 * loads on demand and no conditional rule, as the reference's dialog has neither), the user and project files a note
 * would go to, and, while memory is on, the memory folders. Making one rebuilds it from the server's own state: a client
 * names a row, never a place, so no string it sends is joined into a path (class 5). A file is one the listing holds and
 * is made only as a note's file is (class 3); a folder is the value its own service checked (`MemoryStore`, `MemoryTeam`,
 * `MemoryAgent`), asked about a share before anything resolves it (class 6), made at its real path and checked again once
 * it is made, so a link or a file planted there is refused (class 4).
 */

/** A target that was refused. Nothing was made. */
export class TargetError extends Schema.TaggedError<TargetError>()("MemoryListing.TargetError", {
  reason: Instruction.MemoryRefusal,
  message: Schema.String,
}) {}

/** The file or folder could not be made: a permission, a read-only volume, a folder where the file should be. */
export class WriteError extends Schema.TaggedError<WriteError>()("MemoryListing.WriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Reads the instruction files again, then lists them, the user and project files, and the memory folders. Makes nothing. */
  readonly list: () => Effect.Effect<Instruction.MemoryListing>
  /** Makes the file or folder a listed row names when it is not there, and answers where it really is. */
  readonly ensure: (
    target: Instruction.MemoryTarget,
  ) => Effect.Effect<Instruction.MemoryEnsured, TargetError | WriteError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryListing") {}

type Folder = { readonly folder: string; readonly real: string }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const memoryAgent = yield* MemoryAgent.Service
    const notes = yield* InstructionNotes.Service
    const plugins = yield* Plugin.Service
    const store = yield* MemoryStore.Service
    const team = yield* MemoryTeam.Service

    // The agents that keep a memory folder: a memory scope, and an id that can be a folder's name.
    const remembering = Effect.fnUntraced(function* () {
      return (yield* agents.list()).flatMap((agent) =>
        agent.memory !== undefined && ConfigAgent.isName(agent.id) ? [{ id: agent.id, scope: agent.memory }] : [],
      )
    })

    // Each folder as the service that owns it checked it. An agent whose folder is refused costs only its row (class 7).
    const folders = Effect.fnUntraced(function* () {
      const shared = yield* team.current()
      const own = yield* Effect.forEach(yield* remembering(), (agent) =>
        memoryAgent.folder(agent.id, agent.scope).pipe(
          Effect.map((folder) =>
            folder === undefined
              ? []
              : [{ type: "agent" as const, agent: agent.id, scope: agent.scope, target: { type: "agent" as const, agent: agent.id }, folder }],
          ),
        ),
      )
      return [
        { type: "memory" as const, target: { type: "memory" as const }, folder: { folder: store.folder, real: store.real } },
        ...(shared === undefined ? [] : [{ type: "team" as const, target: { type: "team" as const }, folder: shared }]),
        ...own.flat(),
      ]
    })

    // Whether a checked folder is there, asked of its real path. A path that crosses a link to a share is never statted.
    const present = (folder: Folder) =>
      LinkShare.blocked(fs, folder.folder).pipe(
        Effect.flatMap((blocked) => (blocked ? Effect.succeed(false) : fs.isDir(folder.real))),
      )

    const list = Effect.fn("MemoryListing.list")(function* () {
      // `targets` waits for the plugins and reads the instruction files again, so the status is what the disk holds now.
      const targets = (yield* notes.targets()).flatMap((item) => (item.scope === "local" ? [] : [{ ...item, scope: item.scope }]))
      const status = yield* discovery.status()
      const roles = yield* Effect.forEach(targets, (target) =>
        Effect.gen(function* () {
          // Only a loaded file is resolved: one that did not load may be a link to a share (class 6).
          if (!target.loaded) return { target, file: undefined }
          const real = yield* fs.resolve(target.path)
          return { target, file: status.files.find((file) => same(file.path, real)) }
        }),
      )
      const files = [
        ...status.files.map((file) => {
          const role = roles.find((item) => item.file === file)?.target.scope
          return new Instruction.MemoryFile({
            path: file.path,
            kind: file.kind,
            chars: file.chars,
            ...(file.importedBy === undefined ? {} : { importedBy: file.importedBy }),
            ...(role === undefined ? {} : { role }),
            exists: true,
            target: { type: "file", path: file.path },
          })
        }),
        ...roles.flatMap((role) =>
          role.file !== undefined
            ? []
            : [
                new Instruction.MemoryFile({
                  path: role.target.path,
                  kind: role.target.scope,
                  chars: 0,
                  role: role.target.scope,
                  exists: role.target.exists,
                  target: { type: "scope", scope: role.target.scope },
                }),
              ],
        ),
      ]
      const enabled = yield* store.enabled()
      const rows = enabled ? yield* folders() : []
      return new Instruction.MemoryListing({
        files,
        warnings: status.warnings,
        folders: yield* Effect.forEach(rows, (row) =>
          present(row.folder).pipe(
            Effect.map(
              (exists) =>
                new Instruction.MemoryFolder({
                  type: row.type,
                  ...(row.type === "agent" ? { agent: row.agent, scope: row.scope } : {}),
                  path: row.folder.folder,
                  exists,
                  target: row.target,
                }),
            ),
          ),
        ),
        enabled,
        git: location.vcs?.type === "git",
        available: status.available,
      })
    })

    const ensure = Effect.fn("MemoryListing.ensure")(function* (target: Instruction.MemoryTarget) {
      yield* plugins.awaitActivation
      if (target.type === "file") return yield* listedFile(target.path)
      if (target.type === "scope") return yield* scopeFile(target.scope)
      return yield* make(yield* checked(target))
    })

    // A file the instruction status lists now, which must still be a plain file at that very place: a folder or a link
    // swapped in since it was listed is refused (class 4). The status is not read again, so it is the listed one.
    const listedFile = Effect.fnUntraced(function* (path: string) {
      if (!(yield* discovery.status()).files.some((file) => file.path === path)) return yield* unknown()
      if (yield* LinkShare.blocked(fs, path)) return yield* refused(`${path} leads to a network share.`)
      const real = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => undefined))
      const info = real === undefined ? undefined : yield* fs.stat(real).pipe(Effect.orElseSucceed(() => undefined))
      if (real === undefined || relative(real, path) !== "" || info?.type !== "File")
        return yield* refused(`${path} is no longer a plain file at the place it was listed.`)
      return new Instruction.MemoryEnsured({ path, created: false, type: "file" })
    })

    // The user and project files are a note's files, made by the same code, so the two never pick different files
    // (class 3). Local gets no row, as the reference adds none.
    const scopeFile = Effect.fnUntraced(function* (scope: Instruction.NoteScope) {
      if (scope === "local") return yield* unknown()
      const made = yield* notes.ensure(scope).pipe(
        Effect.catchTags({
          "InstructionNotes.TargetError": (error) => new TargetError({ reason: error.reason, message: error.message }),
          "InstructionNotes.WriteError": (error) => new WriteError({ path: error.path, message: error.message }),
        }),
      )
      return new Instruction.MemoryEnsured({ path: made.path, created: made.created, type: "file" })
    })

    // The folder a row names, as its own service checked it now; a row that is not listed is unknown (class 5).
    const checked = Effect.fnUntraced(function* (target: Exclude<Instruction.MemoryTarget, { readonly type: "file" | "scope" }>) {
      if (!(yield* store.enabled())) return yield* unknown()
      if (target.type === "memory") return { folder: store.folder, real: store.real } satisfies Folder
      if (target.type === "team") {
        if (!MemoryTeam.setting(yield* config.entries())) return yield* unknown()
        const shared = yield* team.current()
        if (shared === undefined) return yield* refused("The team memory folder is refused: it is a link, or its project is not trusted.")
        return shared
      }
      const agent = (yield* remembering()).find((item) => item.id === target.agent)
      if (agent === undefined) return yield* unknown()
      const folder = yield* memoryAgent.folder(agent.id, agent.scope)
      if (folder === undefined) return yield* refused(`The memory folder of ${agent.id} is refused: a part of it is a link.`)
      return folder
    })

    // Makes the checked real path, never the spelling, and checks afterwards that a folder really is there (class 4).
    const make = Effect.fnUntraced(function* (folder: Folder) {
      // Resolving or making a path that crosses a link to a share connects to its host (class 6).
      if (yield* LinkShare.blocked(fs, folder.folder)) return yield* refused(`${folder.folder} leads to a network share.`)
      const before = yield* fs.isDir(folder.real)
      // Something already at the place is judged by the check below, which refuses a link or a file there. Any other
      // failure (a permission, a read-only volume) is a write that did not happen, not a refusal (class 7).
      yield* fs.makeDirectory(folder.real, { recursive: true }).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        Effect.mapError((error) => new WriteError({ path: folder.real, message: error.message })),
      )
      const real = yield* fs.realPath(folder.real).pipe(Effect.orElseSucceed(() => undefined))
      const info = real === undefined ? undefined : yield* fs.stat(real).pipe(Effect.orElseSucceed(() => undefined))
      if (real === undefined || !same(real, folder.real) || info?.type !== "Directory")
        return yield* refused(`${folder.folder} is not a folder at the place that was checked.`)
      return new Instruction.MemoryEnsured({ path: folder.real, created: !before, type: "folder" })
    })

    return Service.of({ list, ensure })
  }),
)

const unknown = () =>
  Effect.fail(new TargetError({ reason: "unknown", message: "The memory listing holds no such file or folder." }))
const refused = (message: string) => Effect.fail(new TargetError({ reason: "refused", message }))

// Two real paths name the same place, as the platform compares them (case on Windows).
const same = (a: string, b: string) => FSUtil.contains(a, b) && FSUtil.contains(b, a)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Config.node,
    InstructionDiscovery.node,
    InstructionNotes.node,
    FSUtil.node,
    Location.node,
    MemoryAgent.node,
    MemoryStore.node,
    MemoryTeam.node,
    Plugin.node,
  ],
})
