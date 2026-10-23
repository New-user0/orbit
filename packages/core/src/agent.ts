export * as Agent from "./agent.js"

import path from "path"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@orbit/schema/agent"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Bus } from "./bus.js"
import { State } from "./state.js"

const SHELL_OUTPUT_GLOB = (data: string) => path.join(data, "shell", "*", "*")
const TOOL_OUTPUT_GLOB = (data: string) => path.join(data, "tool-output", "*")

export const ID = Agent.ID
export type ID = typeof ID.Type
export const Name = Agent.Name
export type Name = Agent.Name
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export { Event } from "@orbit/schema/agent"

/**
 * The folders of Orbit's own that every agent may reach outside the project without a question: shell and tool output,
 * the temporary folder and the global config folder. They never decide a place that a link in a project that is not
 * trusted leads out to (`Permission.AssertInput.escaped`): only the person's own rules and approvals do, so that a link
 * the repository ships into the global config folder is asked about.
 *
 * Each rule is marked where it is made (`isOwnFolder`), not recognised by its value, so a rule of the person's with the
 * very same value is the person's. The mark is the rule object itself: an agent that takes the object over by reference
 * keeps it, and a copy of the object, a stored rule or a decoded one does not carry it, so such a copy counts as the
 * person's.
 */
export const folders = (
  global: Pick<Global.Interface, "data" | "tmp" | "config">,
  real: Pick<Global.Interface, "data" | "tmp" | "config"> = global,
): Info["permissions"] => {
  const allow = (resource: string) => ({ action: "external_directory", resource, effect: "allow" as const })
  const rules = [
    ...places(global.data, real.data).flatMap((data) => [
      allow(SHELL_OUTPUT_GLOB(data)),
      allow(TOOL_OUTPUT_GLOB(data)),
    ]),
    ...places(global.tmp, real.tmp).map((tmp) => allow(path.join(tmp, "*"))),
    ...places(global.config, real.config).map((config) => allow(path.join(config, "*"))),
  ]
  rules.forEach((rule) => orbitOwn.add(rule))
  return rules
}

const orbitOwn = new WeakSet<object>()
export const isOwnFolder = (rule: object) => orbitOwn.has(rule)

// A folder reached through a link is decided by where it really leads, so each allow is also written for the real path.
const places = (spelled: string, leads: string) => (spelled === leads ? [spelled] : [spelled, leads])

/** The folder under the temporary folder that holds the scratchpads, one per session lineage (`SessionScratchpad`). */
export const scratchpadRoot = (tmp: string) => path.join(tmp, "sessions")

/**
 * The scratchpad allows, each with the folders of scratchpads it was written for: the one it names and the other
 * spelling of it, when the temporary folder is reached through a link. The allow is the same kind of rule as Plan's allow
 * for its folder, and it is Orbit's own like `folders`, so it never decides a place that a link leads out to.
 */
const scratchpads = new WeakMap<object, { readonly root: string; readonly roots: readonly string[] }>()

/** The allows that `narrowScratchpad` cut, and the folders of the one scratchpad each is for. */
const narrowed = new WeakMap<object, readonly string[]>()

/**
 * The scratchpad folders that `rule` allows editing in, when `narrowScratchpad` made it: the folder as it is spelled and
 * as it really is. A name is not where a file is: a link inside the folder can point out of it, so `Permission` lets the
 * rule decide only a place whose real path is in one of these folders too.
 */
export const scratchpadFolders = (rule: object) => narrowed.get(rule)

/**
 * The allow that lets an agent edit in its session's scratchpad without a question, written for each spelling of the
 * temporary folder. It sits next to the allows of `folders`, before the rules of the person, so a deny of theirs still
 * wins. As written it names every session's scratchpad; `narrowScratchpad` cuts it to the folder of the session that asks.
 */
export const scratchpad = (
  global: Pick<Global.Interface, "tmp">,
  real: Pick<Global.Interface, "tmp"> = global,
): Info["permissions"] => {
  const roots = places(global.tmp, real.tmp).map(scratchpadRoot)
  return roots.map((root) => {
    const rule = { action: "Edit", resource: path.join(root, "*"), effect: "allow" as const }
    scratchpads.set(rule, { root, roots })
    orbitOwn.add(rule)
    return rule
  })
}

/**
 * `rules` as they apply to the session whose scratchpad folder is `key`: each allow that `scratchpad` made names only
 * that folder, and a session with no scratchpad (`key` is undefined) has none. The order of the rules is kept, so a
 * later rule of the person's still wins. The cut allow is Orbit's own, as the one it came from is.
 */
export const narrowScratchpad = (rules: Info["permissions"], key: string | undefined) =>
  rules.flatMap((rule) => {
    const written = scratchpads.get(rule)
    if (written === undefined) return [rule]
    if (key === undefined) return []
    const cut = { ...rule, resource: path.join(written.root, key, "*") }
    narrowed.set(
      cut,
      written.roots.map((root) => path.join(root, key)),
    )
    orbitOwn.add(cut)
    return [cut]
  })

/** The allow that `memory` writes, which `placeMemory` turns into the allow for the project's memory folder. */
const memoryAllows = new WeakSet<object>()

/** The allows that `placeMemory` made, and the real memory folder each is for. */
const placedMemory = new WeakMap<object, readonly string[]>()

/**
 * The allow of Orbit's own for the project's memory folder, which the file tools reach without a question. As written it
 * names the folder that holds every project's memory and decides nothing: `Permission` puts the folder of its Location in
 * its place (`placeMemory`), since `memory.directory` can move it. It is an `external_directory` allow like the ones of
 * `folders`, so an agent that keeps those after a deny of everything, as Explore does, keeps this one too.
 */
export const memory = (global: Pick<Global.Interface, "data">): Info["permissions"] => {
  const rule = {
    action: "external_directory",
    resource: path.join(global.data, "memory", "*"),
    effect: "allow" as const,
  }
  memoryAllows.add(rule)
  orbitOwn.add(rule)
  return [rule]
}

/**
 * `rules` with each allow that `memory` wrote replaced by allows for the memory folder as it is named and as it really
 * is. The real folder is the only one a call's real place may be in for the allow to decide (`memoryFolders`), so a link
 * inside the folder cannot carry the allow out of it. The order of the rules is kept.
 */
export const placeMemory = (rules: Info["permissions"], folder: { readonly folder: string; readonly real: string }) =>
  rules.flatMap((rule) => {
    if (!memoryAllows.has(rule)) return [rule]
    return places(folder.folder, folder.real).map((place) => {
      const placed = { ...rule, resource: path.join(place, "*") }
      placedMemory.set(placed, [folder.real])
      orbitOwn.add(placed)
      return placed
    })
  })

/** The real memory folder that `rule` allows, when `placeMemory` made it. */
export const memoryFolders = (rule: object) => placedMemory.get(rule)

/**
 * Marks a rule that a mode puts on an agent, such as Plan's deny of every edit, and returns it. The mode decides what the
 * agent's own tools may do; it is not a rule of the person's, so the deny-only probes a shell command makes for the files
 * it names (`Permission.AssertInput.probe`) skip it and the command is asked about as the mode says. The mark is the rule
 * object itself, as for `folders`.
 */
export const modeRule = <A extends object>(rule: A) => {
  orbitMode.add(rule)
  return rule
}
const orbitMode = new WeakSet<object>()
export const isModeRule = (rule: object) => orbitMode.has(rule)

/**
 * Marks the built-in `external_directory * ask` that `Info.default` gives every agent (and Explore's copy of it) and
 * returns it. It is the default question for a place outside the project, not a rule the person wrote, so a managed
 * `allow` lifts it as it lifts the fallthrough ask. The mark is the rule object itself, as for `folders`; the person's
 * own `external_directory` ask, a session's, a grant's lead, the built-in `.env` asks and Plan's mode asks stay explicit.
 */
export const defaultAsk = <A extends object>(rule: A) => {
  orbitDefaultAsk.add(rule)
  return rule
}
const orbitDefaultAsk = new WeakSet<object>()
export const isDefaultAsk = (rule: object) => orbitDefaultAsk.has(rule)

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Editor = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const lead = (folder: string) =>
      fs.resolve(folder).pipe(
        // A folder that is not a link keeps its own spelling, so no second rule is written for it.
        Effect.map((resolved) => (resolved.toLowerCase() === path.resolve(folder).toLowerCase() ? folder : resolved)),
        // Any failure keeps the spelled path: `resolve` dies, not fails, on a link loop at the folder.
        Effect.catchCause(() => Effect.succeed(folder)),
      )
    const real = {
      data: yield* lead(global.data),
      tmp: yield* lead(global.tmp),
      config: yield* lead(global.config),
    }
    const permissions = [...folders(global, real), ...memory(global), ...scratchpad(global, real)]
    const state = State.create<Data, Editor>({
      name: "agent",
      initial: () => ({ agents: new Map() }),
      editor: (editor) => ({
        list: () => Array.fromIterable(editor.agents.values()) as Info[],
        get: (id) => editor.agents.get(id),
        default: (id) => {
          editor.default = id
        },
        update: (id, fn) => {
          const defaults = Info.default(id)
          defaults.permissions.forEach((rule) => {
            if (rule.action === "external_directory" && rule.effect === "ask") defaultAsk(rule)
          })
          const current =
            editor.agents.get(id) ??
            ({
              ...defaults,
              permissions: [...defaults.permissions, ...permissions],
            } as Types.DeepMutable<Info>)
          if (!editor.agents.has(id)) editor.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          editor.agents.delete(id)
        },
      }),
      notify: () => bus.publish(Agent.Event.Updated, {}).pipe(Effect.asVoid),
    })
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("Agent.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      list: Effect.fn("Agent.list")(function* () {
        const agents = Array.fromIterable(state.get().agents.values())
        const selected = selectedDefault()
        if (!selected) return agents
        return [selected, ...agents.filter((agent) => agent.id !== selected.id)]
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Global.node, FSUtil.node] })
