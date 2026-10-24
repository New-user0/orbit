export * as MemoryTeam from "./team.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import type { Document, Entry } from "@orbit/schema/config"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { MemoryStore } from "./store.js"

/**
 * Team memory: a second memory folder, `.orbit/team-memory/` at the project's root, that is committed with the
 * repository and so shared with everyone who works in it. It is on for a Location while memory is on, `memory.team` is
 * set, the project is trusted, and the folder really is `.orbit/team-memory` of the real project, with neither part a
 * link. The folder is a repository's, so a clone decides what it is: it is resolved once, a link to a share is refused
 * before anything resolves it (class 6), and a folder that leads anywhere else, out of the project or onto the project
 * itself, `.orbit`, `.git` or `src`, turns team memory off (class 4), because the carve-out drops every ask for what is
 * in it. The one value resolved here is the one the index, the guide, the folder's creation and the permission
 * carve-out all use (class 3).
 */

export interface Folder {
  /** The folder as the project spells it. */
  readonly folder: string
  /** Where it really is once its links are followed; a part that is not there yet keeps its name. */
  readonly real: string
}

/** Whether config turns team memory on: the last config that sets `memory.team`, of any scope that is read. Off by default. */
export function setting(entries: readonly Entry[]) {
  return (
    entries.findLast((entry): entry is Document => entry.type === "document" && entry.info.memory?.team !== undefined)
      ?.info.memory?.team ?? false
  )
}

export interface Interface {
  /** `.orbit/team-memory` under the project's root, as spelled. */
  readonly folder: string
  /**
   * The folder and where it really is, resolved the first time it is asked for and kept for the Location, or undefined
   * when it is refused: its path crosses a link to a share, or once its links are followed it is not `.orbit/team-memory`
   * of the real project. Only links are read; nothing in the folder is.
   */
  readonly resolved: () => Effect.Effect<Folder | undefined>
  /**
   * Where the folder really is when that is a folder below the real project, accepted or not: a link to `shared/` of the
   * project is refused for team memory but still names it, so the secret guard holds a write by that name too (class 3).
   * Undefined for a folder that leads onto the project, out of it, or across a share.
   */
  readonly guarded: () => Effect.Effect<string | undefined>
  /** The folder while team memory is on now (memory on, `memory.team` set, the project trusted, the folder accepted). */
  readonly current: () => Effect.Effect<Folder | undefined>
  /** Where a file that exists really is, when team memory is on and that is in the real team folder (class 4). */
  readonly locate: (file: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryTeam") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const trust = yield* ProjectTrust.Service
    const memory = yield* MemoryStore.Service
    const folder = path.join(location.project.directory, ".orbit", "team-memory")

    // Where the folder and the project really are, each resolved once (class 3).
    const reals = yield* Effect.cached(
      Effect.gen(function* () {
        if (yield* LinkShare.blocked(fs, folder)) return yield* Effect.fail("its path leads to a network share")
        const project = FSUtil.normalizePath(yield* fs.realPath(location.project.directory))
        return { real: yield* MemoryStore.realFolder(fs, folder), project }
      }).pipe(
        // A refused folder costs only team memory, with one line in the log (class 7).
        Effect.catchCause((cause) =>
          Effect.logWarning("team memory is off: its folder is refused", { folder, cause }).pipe(Effect.as(undefined)),
        ),
      ),
    )

    const resolved = yield* Effect.cached(
      Effect.gen(function* () {
        const found = yield* reals
        if (found === undefined) return undefined
        if (same(found.real, path.join(found.project, ".orbit", "team-memory"))) return { folder, real: found.real }
        // The carve-out drops every ask for what is in the folder, so a folder that is a link anywhere else, even inside
        // the project, would carry it there (class 4). It is refused with one line in the log (class 7).
        yield* Effect.logWarning("team memory is off: its folder is a link", { folder, real: found.real })
        return undefined
      }),
    )

    const guarded = Effect.fnUntraced(function* () {
      const found = yield* reals
      if (found === undefined) return undefined
      if (FSUtil.contains(found.real, found.project) || !FSUtil.contains(found.project, found.real)) return undefined
      return found.real
    })

    // Trust first: nothing of the folder is resolved for team memory before the project is trusted (class 1).
    const current = Effect.fn("MemoryTeam.current")(function* () {
      if (!(yield* memory.enabled())) return undefined
      if (!setting(yield* config.entries())) return undefined
      if (!(yield* trust.trusted())) return undefined
      return yield* resolved
    })

    return Service.of({
      folder,
      resolved: () => resolved,
      guarded,
      current,
      locate: (file) =>
        current().pipe(
          Effect.flatMap((team) =>
            team === undefined ? Effect.succeed(undefined) : MemoryStore.locate(fs, team.real, file),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node, ProjectTrust.node, MemoryStore.node],
})

// Two real paths name the same place, as the platform compares them (case on Windows).
const same = (a: string, b: string) => FSUtil.contains(a, b) && FSUtil.contains(b, a)
