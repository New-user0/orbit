export * as InstructionDiscovery from "./instruction-discovery.js"

import { Context, Effect, Layer, Schema, Types } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { createPatch } from "diff"
import { Bus } from "./bus.js"
import { Instructions } from "./instructions/index.js"
import { AbsolutePath, PositiveInt } from "./schema.js"
import { State } from "./state.js"

/** An instruction file, with the text the model reads: what is left of it once it is processed (`ConfigInstructionFile`). */
export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

/**
 * Something a person should know about a loaded instruction file. A warning is not part of `File` and never reaches the
 * model: it is not in the value the instructions source stores, so one that appears or goes changes no hash and starts no
 * instruction update.
 */
export class Warning extends Schema.Class<Warning>("InstructionDiscovery.Warning")({
  path: AbsolutePath,
  /** The file is longer than `limit` characters, and is sent whole all the same. */
  kind: Schema.Literal("size"),
  characters: PositiveInt,
  limit: PositiveInt,
}) {}

const Files = Schema.Array(File)
const key = Instructions.Key.make("core/instructions")

export const Event = {
  Updated: Bus.ephemeral({ type: "instruction-discovery.updated", schema: {} }),
}

export type Data = {
  files: Map<AbsolutePath, Types.DeepMutable<File>>
  warnings: Types.DeepMutable<Warning>[]
  available: boolean
}

export type Editor = {
  list: () => readonly Types.DeepMutable<File>[]
  // Map insertion order is render order: config adds global then nearest-to-farthest project files;
  // sibling contributors interleave by transform registration order.
  add: (file: File) => void
  warn: (warning: Warning) => void
  update: (path: string, update: (file: Types.DeepMutable<File>) => void) => void
  remove: (path: string) => void
  unavailable: () => void
}

export interface Interface extends State.Transformable<Editor> {
  // Discovery policy lives here because internal plugins have no per-composition options channel.
  // Move it into plugin config once plugins can consume their own options.
  readonly project: boolean
  readonly global: boolean
  readonly list: () => Effect.Effect<File[] | Instructions.Unavailable>
  /** What is worth telling a person about the files that `list` returns. Nothing here reaches the model. */
  readonly warnings: () => Effect.Effect<readonly Warning[]>
  readonly load: () => Effect.Effect<Instructions.List>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@orbit/InstructionDiscovery") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const state = State.create<Data, Editor>({
        name: "instruction-discovery",
        initial: () => ({ files: new Map(), warnings: [], available: true }),
        editor: (editor) => ({
          list: () => Array.from(editor.files.values()),
          add: (file) => editor.files.set(file.path, new File(file) as Types.DeepMutable<File>),
          warn: (warning) => editor.warnings.push(new Warning(warning) as Types.DeepMutable<Warning>),
          update: (path, update) => {
            const current = editor.files.get(AbsolutePath.make(path))
            if (!current) return
            update(current)
            current.path = AbsolutePath.make(path)
          },
          remove: (path) => {
            editor.files.delete(AbsolutePath.make(path))
            editor.warnings = editor.warnings.filter((warning) => warning.path !== path)
          },
          unavailable: () => {
            editor.available = false
          },
        }),
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      const source = (value: ReadonlyArray<File> | Instructions.Unavailable | Instructions.Removed) =>
        Instructions.make<ReadonlyArray<File>>({
          key,
          codec: Schema.toCodecJson(Files),
          read: Effect.succeed(value),
          render: {
            initial: render,
            changed: renderUpdate,
            removed: () => "Previously loaded instructions no longer apply.",
          },
        })

      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      return Service.of({
        project: options?.project !== false,
        global: options?.global !== false,
        transform: state.transform,
        reload: state.reload,
        list,
        warnings: Effect.fn("InstructionDiscovery.warnings")(function* () {
          return Array.from(state.get().warnings)
        }),
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          const files = yield* list()
          if (!Array.isArray(files)) return source(files)
          return source(files.length === 0 ? Instructions.removed : files)
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Bus.node],
  })
}

// `orb run --bare` starts its server with instruction files switched off.
export const node = configured(
  process.env.ORBIT_DISABLE_INSTRUCTIONS === "1" ? { project: false, global: false } : undefined,
)

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

function renderUpdate(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  return [
    ...changes.removed.map((file) => `The instructions from ${file.path} no longer apply.`),
    ...changes.added.map((file) => `New instructions apply from:\n${render([file])}`),
    ...changes.changed.map(({ previous: before, current: after }) => {
      const patch = createPatch(after.path, before.content, after.content, "", "", { context: 3 })
      const diff = [
        `The instructions from ${after.path} changed. Here's the diff:`,
        "```diff",
        patch.slice(patch.indexOf("@@")).trimEnd(),
        "```",
      ].join("\n")
      const replacement = `The instructions changed:\n${render([after])}`
      return diff.length < replacement.length ? diff : replacement
    }),
  ].join("\n\n")
}
