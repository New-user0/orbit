export * as MemoryAgent from "./agent.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LinkShare } from "@orbit/util/link-share"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { MemoryStore } from "./store.js"

/**
 * Agent memory: an agent whose definition names a memory scope keeps its notes in a folder of its own, as the
 * reference's agents do. The user scope's folders are the person's (`<data>/memory/agents/<id>`, which
 * `memory.directory` does not move); the project scope's are committed with the repository
 * (`<dir>/.orbit/agent-memory/<id>`) and the local scope's stay out of it (`<dir>/.orbit/agent-memory-local/<id>`),
 * where `<dir>` is the Location's own folder, so a worktree keeps its own. The two roots inside the folder are the
 * repository's, so a clone decides what they are: each is resolved once for the Location and only after the project is
 * trusted (class 1), a link to a share is refused before anything resolves it (class 6), and a root that is not exactly
 * that folder of the real Location folder, because `.orbit` or the root is a link, turns its scope off (class 4), since
 * the carve-out drops every ask for what is in it. An agent id becomes a folder only when it is a plain name (class 5).
 * A refused root or id costs only itself, with one line in the log (class 7). The value resolved here is the one the
 * block names, the folder that is made, the index that is read and the carve-out all use (class 3).
 */

export type Scope = typeof ConfigAgent.Memory.Type

export interface Folder {
  /** The folder as it is spelled. */
  readonly folder: string
  /** Where it really is once its links are followed; a part that is not there yet keeps its name. */
  readonly real: string
}

export interface Interface {
  /**
   * The roots the carve-out covers now: the user root always, the project and local roots once the project is trusted
   * and each is accepted. It does not ask whether memory is on, as the reference's carve-out does not.
   */
  readonly current: () => Effect.Effect<readonly Folder[]>
  /**
   * The folder of `agent` in `scope`, or undefined when the id is not a plain name, the scope's root is refused or not
   * trusted yet, or a part of the id is a link that leads out of the root or nowhere. Nothing is made.
   */
  readonly folder: (agent: string, scope: Scope) => Effect.Effect<Folder | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryAgent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const trust = yield* ProjectTrust.Service
    const userFolder = path.join(global.data, "memory", "agents")
    // The data folder is the person's own and may be a link, so the user root is taken where it really is, once, when it
    // is first asked for: nothing is read while the Location's services are being built.
    const user = yield* Effect.cached(
      MemoryStore.realFolder(fs, userFolder).pipe(Effect.map((real): Folder => ({ folder: userFolder, real }))),
    )

    const repository = (name: string) =>
      Effect.cached(
        Effect.gen(function* () {
          const folder = path.join(location.directory, ".orbit", name)
          // Resolving a link to a share connects to the host it names, so the share question comes first (class 6).
          if (yield* LinkShare.blocked(fs, folder)) return yield* refuse(folder, "its path leads to a network share")
          const directory = FSUtil.normalizePath(yield* fs.realPath(location.directory))
          const real = yield* MemoryStore.realFolder(fs, folder)
          // `realFolder` keeps the name of a part it cannot follow, so an `.orbit` or a root that is a link to nothing,
          // or a loop, would pass for the plain folder: each of the two that is a link must lead somewhere (class 4).
          if (yield* dangling(fs, [path.dirname(folder), folder]))
            return yield* refuse(folder, "its folder is a link that leads nowhere")
          // A root that is a link anywhere else, out of the project or onto its own files, would carry the carve-out
          // there (class 4).
          if (!same(real, path.join(directory, ".orbit", name))) return yield* refuse(folder, "its folder is a link")
          return { folder, real } satisfies Folder
        }).pipe(Effect.catchCause((cause) => refuse(path.join(location.directory, ".orbit", name), String(cause)))),
      )
    const project = yield* repository("agent-memory")
    const local = yield* repository("agent-memory-local")

    // Trust first: nothing of the repository's roots is resolved before the project is trusted (class 1).
    const root = Effect.fnUntraced(function* (scope: Scope) {
      if (scope === "user") return yield* user
      if (!(yield* trust.trusted())) return undefined
      return yield* scope === "project" ? project : local
    })

    const current = Effect.fn("MemoryAgent.current")(function* () {
      const roots = [yield* user, yield* root("project"), yield* root("local")]
      return roots.filter((item): item is Folder => item !== undefined)
    })

    const named = new Set<string>()
    const folder = Effect.fn("MemoryAgent.folder")(function* (agent: string, scope: Scope) {
      // The `Agent.ID` brand is not checked, so an id that a plugin gives an agent is checked here, before it becomes a
      // path (class 5), with one line for each id however often it is asked (class 7).
      if (!ConfigAgent.isName(agent)) {
        if (!named.has(agent)) {
          named.add(agent)
          yield* Effect.logWarning("agent memory not used: the agent's id is not a plain name", { agent })
        }
        return undefined
      }
      const base = yield* root(scope)
      if (base === undefined) return undefined
      const segments = agent.split("/")
      const target = path.join(base.folder, ...segments)
      if (yield* LinkShare.blocked(fs, target)) return undefined
      // Each part of the id that is a link must lead somewhere, and the folder must really be inside the real root, so
      // nothing is made or read through a link out of it (class 4).
      const parts = segments.map((_, index) => path.join(base.folder, ...segments.slice(0, index + 1)))
      if (yield* dangling(fs, parts)) return undefined
      const real = yield* MemoryStore.realFolder(fs, target)
      if (!FSUtil.contains(base.real, real)) return undefined
      return { folder: target, real } satisfies Folder
    })

    return Service.of({ current, folder })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, Location.node, FSUtil.node, ProjectTrust.node],
})

// A refused root turns its scope off for the Location, with one line in the log (class 7).
const refuse = (folder: string, reason: string) =>
  Effect.logWarning(`agent memory is off for ${path.basename(folder)}: ${reason}`, { folder }).pipe(
    Effect.as(undefined),
  )

// Whether one of `parts` is a link that cannot be followed: it points at nothing, or it is part of a loop.
const dangling = (fs: FSUtil.Interface, parts: readonly string[]) =>
  Effect.forEach(parts, (part) =>
    Effect.isSuccess(fs.readLink(part)).pipe(
      Effect.flatMap((link) => (link ? Effect.isFailure(fs.realPath(part)) : Effect.succeed(false))),
    ),
  ).pipe(Effect.map((found) => found.some(Boolean)))

// Two real paths name the same place, as the platform compares them (case on Windows).
const same = (a: string, b: string) => FSUtil.contains(a, b) && FSUtil.contains(b, a)
