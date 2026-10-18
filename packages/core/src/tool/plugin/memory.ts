export * as MemoryTool from "./memory.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Hash } from "@orbit/util/hash"
import { Effect, Schema } from "effect"
import path from "path"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

/**
 * Notes the agent keeps about a project across sessions: facts learned, user preferences, decisions. Each memory is
 * a Markdown file under the data directory, never in the project, and an index of them loads as an instruction
 * source so every new session starts with it. Everything stays on this machine.
 */

export const name = "Memory"
const INDEX = "MEMORY.md"
const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).annotate({
  description: 'Short kebab-case name for the memory, such as "test-commands"',
})

export const Input = Schema.Struct({
  action: Schema.Literals(["save", "read", "delete", "list"]).annotate({
    description:
      '"save" writes or replaces a memory, "read" shows one, "delete" removes one, and "list" shows the index.',
  }),
  name: Schema.optionalKey(Name),
  content: Schema.optionalKey(Schema.String).annotate({
    description: "For save: the memory in Markdown. Its first line is its summary in the index.",
  }),
})

export const Plugin = {
  id: "orbit.tool.memory",
  effect: Effect.fn("MemoryTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const discovery = yield* InstructionDiscovery.Service
    const directory = path.join(global.data, "memory", location.project.id)
    const indexPath = path.join(directory, INDEX)
    const read = (file: string) => fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    // The index joins the session's instructions through IndexPlugin; reload whenever a save or delete changes it.
    const index = shared(discovery)
    index.path = indexPath
    index.current = yield* read(indexPath)

    const rebuild = Effect.fn("MemoryTool.rebuild")(function* () {
      const files = (yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[])))
        .filter((file) => file.endsWith(".md") && file !== INDEX)
        .toSorted()
      const lines = yield* Effect.forEach(files, (file) =>
        read(path.join(directory, file)).pipe(
          Effect.map((text) => `- [${file.slice(0, -3)}](${file}): ${summary(text ?? "")}`),
        ),
      )
      index.current =
        lines.length === 0
          ? undefined
          : [
              "# Project memory",
              "Notes saved in earlier sessions with the Memory tool. Read one with Memory read before relying on details.",
              "",
              ...lines,
            ].join("\n")
      yield* index.current ? fs.writeWithDirs(indexPath, index.current) : fs.remove(indexPath).pipe(Effect.ignore)
      yield* discovery.reload()
    })

    // A repository with no remote is named by its path until it is trusted and by its first commit afterwards, and a
    // Location keeps the ID it was bound with, so notes can sit under the path-named folder. Move them over; a note that
    // already has the name here wins, and the index is rebuilt from the files.
    const moved = yield* Effect.forEach(
      [...new Set([location.project.directory, location.project.canonical])]
        .map((folder) => path.join(global.data, "memory", Hash.fast(`directory:${folder}`)))
        .filter((legacy) => legacy !== directory),
      (legacy) =>
        Effect.gen(function* () {
          const names = (yield* fs.readDirectory(legacy)).filter((file) => file.endsWith(".md") && file !== INDEX)
          if (names.length === 0) return false
          yield* fs.ensureDir(directory)
          yield* Effect.forEach(
            names,
            (file) =>
              fs
                .existsSafe(path.join(directory, file))
                .pipe(
                  Effect.flatMap((exists) =>
                    exists ? Effect.void : fs.rename(path.join(legacy, file), path.join(directory, file)),
                  ),
                ),
            { discard: true },
          )
          yield* fs.remove(path.join(legacy, INDEX)).pipe(Effect.ignore)
          return true
        }).pipe(Effect.orElseSucceed(() => false)),
    )
    if (moved.includes(true)) yield* rebuild()

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name,
        options: { codemode: false },
        traits: {
          readOnly: (input) => input.action === "read" || input.action === "list",
          concurrencySafe: (input) => input.action === "read" || input.action === "list",
          destructive: (input) => input.action === "delete",
        },
        description:
          "Keep notes about this project that later sessions will see: commands that work, conventions, user preferences, and decisions with their reasons. Save a memory when you learn something you would otherwise have to rediscover; update it when it changes; delete it when it is wrong. Do not save secrets or anything the code itself makes obvious.",
        input: Input,
        execute: (input) =>
          Effect.gen(function* () {
            if (input.action === "list") return { content: index.current ?? "No memories saved for this project yet." }
            if (!input.name) return yield* new ToolFailure({ message: `"${input.action}" needs a name.` })
            const file = path.join(directory, `${input.name}.md`)
            if (input.action === "read") {
              const text = yield* read(file)
              return { content: text ?? `There is no memory named ${input.name}.` }
            }
            if (input.action === "delete") {
              yield* fs.remove(file).pipe(Effect.ignore)
              yield* rebuild()
              return { content: `Deleted the memory ${input.name}.` }
            }
            if (!input.content?.trim()) return yield* new ToolFailure({ message: "save needs content." })
            yield* fs.writeWithDirs(file, input.content.endsWith("\n") ? input.content : `${input.content}\n`)
            yield* rebuild()
            return { content: `Saved the memory ${input.name}. New sessions in this project will see it in the index.` }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to update memory", error }),
            ),
          ),
      })
    })
  }),
}

/**
 * Offers the memory index as an instruction file. It is a separate plugin that activates after the instruction files, so
 * the index renders last (the later a file, the more it outranks) while the tool itself activates with the other tools
 * and stays replaceable by a plugin. The tool plugin owns the text and reloads discovery when it changes.
 */
export const IndexPlugin = {
  id: "orbit.tool.memory.index",
  effect: Effect.fn("MemoryTool.IndexPlugin")(function* (_ctx: Context) {
    const discovery = yield* InstructionDiscovery.Service
    const index = shared(discovery)
    yield* discovery.transform((editor) => {
      if (discovery.project && index.path && index.current?.trim())
        editor.add(new InstructionDiscovery.File({ path: AbsolutePath.make(index.path), content: index.current }))
    })
  }),
}

// The discovery service is one per location, so it keys the index text the two plugins share.
const indexes = new WeakMap<object, { path?: string; current?: string }>()

function shared(discovery: object) {
  const existing = indexes.get(discovery)
  if (existing) return existing
  const created: { path?: string; current?: string } = {}
  indexes.set(discovery, created)
  return created
}

function summary(text: string) {
  const line = text.split("\n").find((item) => item.trim()) ?? ""
  return line
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 150)
}
