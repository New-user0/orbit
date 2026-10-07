export * as ProjectTrust from "./project-trust.js"

import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import type { Entry, Scope } from "@orbit/schema/config"
import { Trust } from "@orbit/schema/trust"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Config } from "./config.js"
import { AgentFile } from "./config/plugin/agent-file.js"
import { CommandFile } from "./config/plugin/command-file.js"
import { ConfigTrust } from "./config/trust.js"
import { Location } from "./location.js"
import { PluginSourceDirectory } from "./plugin/source-directory.js"
import { AbsolutePath } from "./schema.js"
import { WorkspaceTrust } from "./workspace-trust.js"

/** A config directory, or a root that another product keeps config in, as `Config.entries` and `Config.compat` list it. */
export interface Source {
  readonly path: string
  readonly scope?: Scope
  readonly trusted?: boolean
}

export interface Interface {
  /** Whether this Location's project is trusted now. It reads at most one stored grant, so ask it freely. */
  readonly trusted: () => Effect.Effect<boolean>
  /**
   * Whether this Location's project is trusted, and which config files and directories hold something back now. While
   * the project is untrusted those are its own: the settings its files hold back, and the config directories whose
   * files carry plugins, commands that run shell snippets, or agents that ask for more than deny rules. What a
   * directory holds is read once and kept until a file under a config root changes. A file or directory in a folder
   * above the project is listed too, until the folder that holds it is trusted, which trusting the project does not do,
   * and it names that folder as its `directory`.
   */
  readonly status: () => Effect.Effect<Trust.Status>
  /** Trusts this Location's project; see `WorkspaceTrust.grant`. Config applies what it held back once it reloads. */
  readonly grant: (input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<Trust.Status>
  /** Ends the grants for this Location's project; see `WorkspaceTrust.revoke`. */
  readonly revoke: () => Effect.Effect<Trust.Status>
  /**
   * Whether a file may run the code it carries, such as the hooks in a skill's or an agent's front matter, or any other
   * file that something would execute. Callers must ask this before running any such code; see `ConfigTrust.allows`.
   */
  readonly allows: (file: string) => Effect.Effect<boolean>
  /**
   * Whether the text of a file may go into the prompt as part of this project, such as an instruction file. Any file may
   * while the project is trusted. Until then only a file inside the project's folders whose real path is inside them too
   * may: a link that leaves them is not the repository's to supply, and what it points at, such as an SSH key or a cloud
   * credentials file, would go to the model provider with the first request. A `{file:path}` reference in the config of
   * an untrusted folder is held to the same rule. A file in a folder above the project is outside it, so it waits for
   * the project to be trusted as well. A file that is not there yet counts by where it would be. Ask this, or `supplies`
   * for the files of a config directory, before reading a file that a repository points at into the prompt: the
   * readers that do are listed in `ConfigTrust`.
   */
  readonly reachable: (file: string) => Effect.Effect<boolean>
  /**
   * Where a path in the project's folders really leads, when that is outside them and the project is not trusted yet: a
   * link in the repository, or in a folder of it, that points elsewhere. Unset when the path stays inside, and always
   * once the project is trusted. A path that is not there yet leads where the nearest folder of its name that exists
   * does, and a link that points nowhere leads where it points, so a file that is about to be created through a link is
   * found out as well. The file tools ask this before they count a path as inside the project.
   */
  readonly escapes: (file: string) => Effect.Effect<string | undefined>
  /**
   * Whether a file that a config directory, or a root of another product, holds may be read now: its agents, commands,
   * skills and output styles. Any file may while the folder that holds the source is trusted. Until then only a file
   * whose real path is inside the folders that decision covers may, which are the project's for a source in them and
   * the folder around the source for one above them, so that a link in a repository does not carry a file of the user's
   * into the prompt. A file that is left out is logged once, as a warning that says `config file skipped`.
   */
  readonly supplies: (source: Source, file: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ProjectTrust") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    // Trust is decided for the project's canonical root, so its linked worktrees share the decision.
    const root = location.project.canonical
    // The folders that decision covers.
    const folders = [...new Set([location.directory, location.project.directory, location.project.canonical])]
    // Those folders as the disk has them, for comparing a real path with them however the Location was reached.
    const real = yield* Effect.forEach(folders, fs.resolve)

    // Whether a file is in one of the project's own folders, as against a folder above them.
    const inside = (file: string) => folders.some((folder) => FSUtil.contains(folder, file))

    // Where a path leads once every link in it is followed. `fs.resolve` stops at a part that is not there, which would
    // put a file that is about to be created under a link where the link is, not where it points. A link that points
    // nowhere leads where it points, and that is where a write through it would land. The depth only ends a loop of
    // links, which nothing can open anyway. Whether a path is there is asked of `stat`, which follows links: `access`
    // answers yes for a link that points nowhere on Windows.
    const lead = (file: string, depth = 0): Effect.Effect<string> =>
      Effect.gen(function* () {
        if ((yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))) !== undefined)
          return yield* fs.resolve(file)
        const parent = path.dirname(file)
        if (parent === file) return file
        const named = path.join(yield* lead(parent, depth), path.basename(file))
        const target = depth < 40 ? yield* fs.readLink(named).pipe(Effect.orElseSucceed(() => undefined)) : undefined
        return target === undefined ? named : yield* lead(path.resolve(path.dirname(named), target), depth + 1)
      })

    // Whether a file is inside the folders by its name, and still is once every link in it is followed.
    const stays = Effect.fnUntraced(function* (roots: readonly string[], file: string) {
      const within = (candidate: string) => roots.some((folder) => FSUtil.contains(folder, candidate))
      return within(file) && within(yield* lead(file))
    })

    // Files that were left out, so that one that keeps being asked for is reported once.
    const skipped = new Set<string>()

    const supplies = Effect.fn("ProjectTrust.supplies")(function* (source: Source, file: string) {
      if (source.scope !== "project" && source.scope !== "local") return true
      // The project's own folders follow the decision just made, because a stamp can trail it, and what sits above
      // them follows the decision for the folder that holds it, which only its stamp knows.
      const own = inside(source.path)
      if (own ? (yield* trust.status(root)).trusted : source.trusted !== false) return true
      const holder = ConfigTrust.holder(source.path)
      if (yield* stays(own ? [...folders, ...real] : [holder, yield* fs.resolve(holder)], file)) return true
      if (skipped.has(file)) return false
      skipped.add(file)
      yield* Effect.logWarning("config file skipped", {
        path: file,
        reason: "outside the folder it comes from, which is not trusted",
      })
      return false
    })

    // What a config directory holds that an untrusted folder may not use: its plugins, a command that runs a shell
    // snippet or names an agent, and whatever its agents ask for beyond deny rules. Finding out reads the directory, so
    // the answer is kept by directory until a file under a config root changes: an edit, or a checkout that adds a
    // plugin. It counts what the plugins would read: a file that a link leads out of the folder is not read here either.
    const byDirectory = new Map<string, readonly Trust.Kind[]>()
    yield* config.changes().pipe(
      Stream.runForEach(() => Effect.sync(() => byDirectory.clear())),
      Effect.forkScoped({ startImmediately: true }),
    )
    const inDirectory = Effect.fnUntraced(function* (directory: string) {
      const known = byDirectory.get(directory)
      if (known !== undefined) return known
      const plugins = yield* PluginSourceDirectory.discover(fs, directory)
      const supplied = (file: string) => supplies({ path: directory, scope: "project", trusted: false }, file)
      const commands = yield* CommandFile.load(fs, directory, supplied)
      const agents = yield* AgentFile.load(fs, directory, supplied)
      const place = { roots: folders, directory }
      const held = [
        ...(plugins.length === 0 ? [] : ["plugins" as const]),
        ...ConfigTrust.sanitizeCommands(
          Object.fromEntries(commands.map((command) => [command.name, command.info])),
          place,
        ).withheld,
        ...agents.flatMap((agent) => ConfigTrust.sanitize(agent.info, place).withheld),
      ]
      const kinds = Trust.Kinds.filter((kind) => held.includes(kind))
      byDirectory.set(directory, kinds)
      return kinds
    })

    // What a project or local entry holds back now. The entries are stamped by the last config load, which can trail a
    // decision by a moment, so for the project's own files the decision just made counts: a trusted project holds nothing
    // back, and an entry that is not stamped yet is read for what it would lose. An entry above the project follows the
    // decision for its own folder, which only its stamp knows.
    const heldBack = Effect.fnUntraced(function* (entry: Entry, file: string, trusted: boolean) {
      const untrusted = inside(file) ? !trusted : entry.trusted === false
      if (!untrusted) return []
      // The files of a directory are not part of its entry, so they are read from the disk.
      if (entry.type === "directory") return yield* inDirectory(entry.path)
      if (entry.trusted === false) return entry.withheld ?? []
      return ConfigTrust.sanitize(entry.info, { roots: folders, directory: path.dirname(file) }).withheld
    })

    const report = Effect.fnUntraced(function* (state: WorkspaceTrust.State) {
      const entries = yield* config.entries()
      const listed = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          if (entry.path === undefined) return []
          if (entry.scope !== "project" && entry.scope !== "local") return []
          const kinds = yield* heldBack(entry, entry.path, state.trusted)
          if (kinds.length === 0) return []
          // What the project's own folders hold is lifted by trusting the project. What sits above them is not, so it
          // names the folder whose trust does lift it, which a caller can tell the person to trust.
          const directory = inside(entry.path) ? undefined : ConfigTrust.covered(entry)
          return [
            {
              path: entry.path,
              kinds,
              ...(directory === undefined ? {} : { directory: AbsolutePath.make(directory) }),
            },
          ]
        }),
      )
      return { ...state, withheld: listed.flat() } satisfies Trust.Status
    })

    return Service.of({
      trusted: Effect.fn("ProjectTrust.trusted")(() => trust.status(root).pipe(Effect.map((state) => state.trusted))),
      status: Effect.fn("ProjectTrust.status")(() => trust.status(root).pipe(Effect.flatMap(report))),
      grant: Effect.fn("ProjectTrust.grant")((input) => trust.grant(root, input).pipe(Effect.flatMap(report))),
      revoke: Effect.fn("ProjectTrust.revoke")(() => trust.revoke(root).pipe(Effect.flatMap(report))),
      allows: Effect.fn("ProjectTrust.allows")(function* (file) {
        const state = yield* trust.status(root)
        const compat = yield* config.compat()
        return ConfigTrust.allows(yield* config.entries(), file, {
          roots: folders,
          trusted: state.trusted,
          compat: compat.roots,
        })
      }),
      reachable: Effect.fn("ProjectTrust.reachable")(function* (file) {
        if ((yield* trust.status(root)).trusted) return true
        return yield* stays([...folders, ...real], file)
      }),
      escapes: Effect.fn("ProjectTrust.escapes")(function* (file) {
        if ((yield* trust.status(root)).trusted) return undefined
        const leads = yield* lead(file)
        return [...folders, ...real].some((folder) => FSUtil.contains(folder, leads)) ? undefined : leads
      }),
      supplies,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [WorkspaceTrust.node, Config.node, Location.node, FSUtil.node],
})
