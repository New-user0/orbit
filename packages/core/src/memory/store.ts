export * as MemoryStore from "./store.js"

import path from "path"
import { Context, Effect, Layer, Option } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LinkShare } from "@orbit/util/link-share"
import { envelope } from "@orbit/util/reminder-text"
import type { Document, Entry } from "@orbit/schema/config"
import { Config } from "../config.js"
import { ConfigMarkdown } from "../config/markdown.js"
import { Location } from "../location.js"

/**
 * The project's memory: Markdown files the model writes with the ordinary file tools into one folder per project, and
 * the index of them (`MEMORY.md`) that the model keeps and that loads into every session. This module holds the rules
 * that need no session: the caps of the index, the front matter of a memory file, the `memory` config, the scan of the
 * folder and the staleness note of a read. `Service` is the folder of one Location, which the permission layer, the file
 * tools and the instruction sources share.
 */

export const ENTRYPOINT = "MEMORY.md"
export const MAX_INDEX_LINES = 200
export const MAX_INDEX_CHARACTERS = 25_000
export const MAX_SCAN_FILES = 200
export const FRONT_MATTER_LINES = 30
export const TYPES = ["user", "feedback", "project", "reference"] as const
export type Type = (typeof TYPES)[number]

/**
 * The index as the model reads it: trimmed, cut to `MAX_INDEX_LINES` lines and then to `MAX_INDEX_CHARACTERS` at the
 * last line break before the cap (or at the cap when there is none), with a warning after a blank line when a cap
 * fired. The size is measured before the line cut, so the warning does not understate an index of long lines.
 */
export function truncateIndex(raw: string) {
  const trimmed = raw.trim()
  const all = trimmed.split("\n")
  const lines = all.length
  const characters = trimmed.length
  const lineTruncated = lines > MAX_INDEX_LINES
  const characterTruncated = characters > MAX_INDEX_CHARACTERS
  const byLines = lineTruncated ? all.slice(0, MAX_INDEX_LINES).join("\n") : trimmed
  const cut = byLines.lastIndexOf("\n", MAX_INDEX_CHARACTERS)
  const kept = byLines.length <= MAX_INDEX_CHARACTERS ? byLines : byLines.slice(0, cut > 0 ? cut : MAX_INDEX_CHARACTERS)
  if (!lineTruncated && !characterTruncated)
    return { content: kept, lines, characters, lineTruncated, characterTruncated }
  const over = [
    ...(lineTruncated ? [`${lines} lines long (the limit is ${MAX_INDEX_LINES})`] : []),
    ...(characterTruncated
      ? [
          `${characters.toLocaleString("en-US")} characters long (the limit is ${MAX_INDEX_CHARACTERS.toLocaleString("en-US")})`,
        ]
      : []),
  ].join(" and ")
  const warning = `Only the start of ${ENTRYPOINT} was loaded: it is ${over}. Keep each entry of the index to one short line that points to a memory file, and move the details into the memory files.`
  return { content: `${kept}\n\n${warning}`, lines, characters, lineTruncated, characterTruncated }
}

/** One of the four kinds of memory by exact name, or undefined: a file of another kind still works, without one. */
export function parseType(raw: unknown): Type | undefined {
  return TYPES.find((type) => type === raw)
}

/**
 * The `name`, `description` and `type` of a memory file, read only through `ConfigMarkdown`, which runs no code (class
 * 11). Only text values are kept. A file without front matter, or with front matter that is refused, has none of them.
 */
export function frontMatter(text: string): { name?: string; description?: string; type?: Type } {
  const data = ConfigMarkdown.parseOption(text)?.data ?? {}
  const type = parseType(data.type)
  return {
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    ...(type ? { type } : {}),
  }
}

/**
 * The folder `memory.directory` names, or undefined when it is refused. `~/` (and `~\` on Windows) is the home folder,
 * but not home itself or a folder above it. A relative path, a share or device path (two leading separators), a NUL, a
 * path shorter than 3 characters and a root are refused, and on Windows also a path without a drive letter, which names
 * whichever drive is current. Nothing here touches the disk, so a share is never contacted (class 4).
 */
export function validateDirectory(raw: string | undefined, home: string) {
  if (!raw || raw.includes("\0") || raw === "~") return undefined
  const tilde = raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"))
  // `normalize` keeps a trailing separator (`./` stays `./`), so it is dropped before the remainder is judged; a remainder
  // of only `..` parts names home's parent or a folder further up.
  const rest = tilde ? path.normalize(raw.slice(2)).replace(/[\\/]+$/, "") || "." : ""
  if (tilde && (rest === "." || rest.split(/[\\/]/).every((part) => part === ".."))) return undefined
  const value = tilde ? path.join(home, rest) : raw
  if (/^[\\/]{2}/.test(value) || !path.isAbsolute(value)) return undefined
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(value)) return undefined
  const normalized = path.normalize(value)
  const trimmed = normalized.replace(/[\\/]+$/, "") || normalized
  if (trimmed.length < 3 || path.parse(normalized).root === normalized) return undefined
  return trimmed.normalize("NFC")
}

// A repository could point the folder at `~/.ssh` and have the agent write there without a question, so only the
// person's own documents and the administrator's choose it; a remote one is served by a host.
const DIRECTORY_SCOPES = ["user", "local", "flag", "managed"]

/** The `memory.directory` that the highest of the person's own scopes sets, validated; undefined keeps the default. */
export function directorySetting(entries: readonly Entry[], home: string) {
  return validateDirectory(directoryRaw(entries), home)
}

function directoryRaw(entries: readonly Entry[]) {
  return entries.findLast(
    (entry): entry is Document =>
      entry.type === "document" &&
      DIRECTORY_SCOPES.includes(entry.scope ?? "user") &&
      entry.info.memory?.directory !== undefined,
  )?.info.memory?.directory
}

/**
 * Whether memory is on: `ORBIT_DISABLE_AUTO_MEMORY` decides when it is set to a yes or a no, then `orb run --bare`
 * (which sets `ORBIT_DISABLE_INSTRUCTIONS=1`) turns it off, then the last config that sets `memory.enabled`, of any scope.
 */
export function enabled(env: Readonly<Record<string, string | undefined>>, entries: readonly Entry[]) {
  const switched = env.ORBIT_DISABLE_AUTO_MEMORY?.trim().toLowerCase() ?? ""
  if (["1", "true", "yes", "on"].includes(switched)) return false
  if (["0", "false", "no", "off"].includes(switched)) return true
  if (env.ORBIT_DISABLE_INSTRUCTIONS === "1") return false
  return (
    entries.findLast(
      (entry): entry is Document => entry.type === "document" && entry.info.memory?.enabled !== undefined,
    )?.info.memory?.enabled ?? true
  )
}

const DAY = 86_400_000

/** Whole days since `mtimeMs`; a time in the future counts as 0. */
export function ageDays(mtimeMs: number, now: number) {
  return Math.max(0, Math.floor((now - mtimeMs) / DAY))
}

/** The note a read of a memory file more than a day old starts with, in a reminder envelope; empty otherwise. */
export function freshnessNote(mtimeMs: number, now: number) {
  const days = ageDays(mtimeMs, now)
  if (days <= 1) return ""
  return `${envelope(
    `This memory was last changed ${days} days ago. It records what was true then, and the code may have changed since: check what it says against the current code before you rely on it or state it as fact.`,
  )}\n`
}

export interface Header {
  /** The file's name below the folder, with `/` between folders on every platform. */
  readonly file: string
  readonly path: string
  readonly mtimeMs: number
  readonly description?: string
  readonly type?: Type
}

/**
 * The memory files below `folder`, newest first and at most `MAX_SCAN_FILES`, each with the description and type of the
 * front matter in its first `FRONT_MATTER_LINES` lines. Every `MEMORY.md` and every file that is not Markdown is left
 * out, and so is a file whose real path is not in the folder's real path, since a link inside the folder can lead
 * anywhere (class 4), and a link that leads to a share, which is left unresolved (class 6): a link entry is asked about
 * before it is resolved, since resolving a link to a share connects to its host, and one set of link answers serves the
 * whole scan, so the parts above the folder are read once. Each file is read at the real path that was checked, not at
 * the spelled one, which a link could lead elsewhere. A file that cannot be read is left out; a folder that is not there
 * gives none.
 */
export const scan = Effect.fn("MemoryStore.scan")(function* (folder: string) {
  const fs = yield* FSUtil.Service
  const root = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => undefined))
  if (root === undefined) return []
  const listed = yield* walk(fs, folder, [])
  const reads: LinkShare.Reads = new Map()
  const dated = yield* Effect.forEach(
    listed,
    (item) =>
      Effect.gen(function* () {
        const file = path.join(folder, ...item.parts)
        if (item.link && (yield* LinkShare.blocked(fs, file, reads))) return []
        const real = yield* fs.realPath(file)
        if (!FSUtil.contains(root, real)) return []
        const info = yield* fs.stat(real)
        return [
          { file: item.parts.join("/"), path: file, real, mtimeMs: Option.getOrUndefined(info.mtime)?.getTime() ?? 0 },
        ]
      }).pipe(Effect.orElseSucceed(() => [])),
    { concurrency: 16 },
  )
  const newest = dated
    .flat()
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SCAN_FILES)
  const read = yield* Effect.forEach(
    newest,
    (item) =>
      fs.readFileString(item.real).pipe(
        Effect.map((text): Header[] => [
          { ...item, ...frontMatter(text.split("\n").slice(0, FRONT_MATTER_LINES).join("\n")) },
        ]),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 16 },
  )
  return read.flat().map(
    (item): Header => ({
      file: item.file,
      path: item.path,
      mtimeMs: item.mtimeMs,
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.type === undefined ? {} : { type: item.type }),
    }),
  )
})

// Folders are entered only when they are folders, not links to one, so a link cannot make the walk loop; a link to a
// file is listed and then judged by its real path.
const walk = (fs: FSUtil.Interface, folder: string, parts: string[]): Effect.Effect<Listed[]> =>
  fs.readDirectoryEntries(path.join(folder, ...parts)).pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((entries) => Effect.forEach(entries, (entry) => entryFiles(fs, folder, parts, entry))),
    Effect.map((lists) => lists.flat()),
  )

type Listed = { readonly parts: string[]; readonly link: boolean }

// A folder is walked; a Markdown file that is not an index is listed, and so is a link named like one.
const entryFiles = (fs: FSUtil.Interface, folder: string, parts: string[], entry: FSUtil.DirEntry) =>
  entry.type === "directory"
    ? walk(fs, folder, [...parts, entry.name])
    : Effect.succeed(
        memoryFile(entry.name) && entry.type !== "other"
          ? [{ parts: [...parts, entry.name], link: entry.type === "symlink" }]
          : [],
      )

const memoryFile = (name: string) => name.toLowerCase().endsWith(".md") && name !== ENTRYPOINT

/** One line per memory file: its type, name, time of the last change and description, each left out when absent. */
export function manifest(headers: readonly Header[]) {
  return headers
    .map(
      (item) =>
        `- ${item.type ? `[${item.type}] ` : ""}${item.file} (${new Date(item.mtimeMs).toISOString()})${item.description ? `: ${item.description}` : ""}`,
    )
    .join("\n")
}

export interface Interface {
  /** The project's memory folder: a valid `memory.directory`, else `<data>/memory/<project ID>`. */
  readonly folder: string
  /** Where the folder really is once each link on its way is followed; a part that is not there yet keeps its name. */
  readonly real: string
  /** Whether memory is on now (`enabled`), read from the environment and the current config. */
  readonly enabled: () => Effect.Effect<boolean>
  /**
   * Where a file that exists really is, once its links are followed, when that is in the folder; undefined otherwise. A
   * caller reads or writes the path this returns, so the place it acts on is the place that was checked (class 4).
   */
  readonly locate: (file: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const entries = yield* config.entries()
    const chosen = directorySetting(entries, global.home)
    const raw = directoryRaw(entries)
    if (raw !== undefined && chosen === undefined)
      yield* Effect.logWarning("memory.directory not used: it must be an absolute local folder", { directory: raw })
    // The folder is decided once for the Location, and so is its real path, which every decision then compares a real
    // place against (the doors of M4: one resolved value, checked and used).
    const folder = chosen ?? path.join(global.data, "memory", location.project.id)
    const real = yield* realFolder(fs, folder)
    return Service.of({
      folder,
      real,
      enabled: () => config.entries().pipe(Effect.map((current) => enabled(process.env, current))),
      // A path whose links lead to a share is answered before it is resolved, which would connect to the host (class 6).
      locate: (file) =>
        LinkShare.blocked(fs, file).pipe(
          Effect.flatMap((stop) =>
            stop
              ? Effect.succeed(undefined)
              : fs.realPath(file).pipe(
                  Effect.map(FSUtil.normalizePath),
                  Effect.map((found) => (FSUtil.contains(real, found) ? found : undefined)),
                  Effect.orElseSucceed(() => undefined),
                ),
          ),
        ),
    })
  }),
)

// The nearest part of the folder that exists, with its links followed, and the rest of the name as written. A part that
// cannot be resolved (a link that points nowhere, a loop) counts as not there, which only makes the real folder a name no
// real place is in: a file below such a part is then asked about, never allowed.
const realFolder = (fs: FSUtil.Interface, folder: string): Effect.Effect<string> =>
  fs.stat(folder).pipe(
    Effect.flatMap(() => fs.realPath(folder)),
    Effect.map(FSUtil.normalizePath),
    Effect.catchCause(() => {
      const parent = path.dirname(folder)
      if (parent === folder) return Effect.succeed(folder)
      return realFolder(fs, parent).pipe(Effect.map((real) => path.join(real, path.basename(folder))))
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Global.node, Location.node, FSUtil.node],
})
