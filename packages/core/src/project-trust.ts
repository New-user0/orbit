export * as ProjectTrust from "./project-trust.js"

import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import type { Entry } from "@orbit/schema/config"
import { Trust } from "@orbit/schema/trust"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Config } from "./config.js"
import { AgentFile } from "./config/plugin/agent-file.js"
import { CommandFile } from "./config/plugin/command-file.js"
import { ConfigTrust } from "./config/trust.js"
import { Location } from "./location.js"
import { PluginSourceDirectory } from "./plugin/source-directory.js"
import { WorkspaceTrust } from "./workspace-trust.js"

export interface Interface {
  /** Whether this Location's project is trusted now. It reads at most one stored grant, so ask it freely. */
  readonly trusted: () => Effect.Effect<boolean>
  /**
   * Whether this Location's project is trusted, and which config files and directories hold something back now. While
   * the project is untrusted those are its own: the settings its files hold back, and the config directories whose
   * files carry plugins, commands that run shell snippets, or agents that ask for more than deny rules. What a
   * directory holds is read once and kept until a file under a config root changes. A file or directory in a folder
   * above the project is listed too, until the folder that holds it is trusted, which trusting the project does not do.
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

    // What a config directory holds that an untrusted folder may not use: its plugins, a command that runs a shell
    // snippet, and whatever its agents ask for beyond deny rules. Finding out reads the directory, so the answer is kept
    // by directory until a file under a config root changes: an edit, or a checkout that adds a plugin.
    const byDirectory = new Map<string, readonly Trust.Kind[]>()
    yield* config.changes().pipe(
      Stream.runForEach(() => Effect.sync(() => byDirectory.clear())),
      Effect.forkScoped({ startImmediately: true }),
    )
    const inDirectory = Effect.fnUntraced(function* (directory: string) {
      const known = byDirectory.get(directory)
      if (known !== undefined) return known
      const plugins = yield* PluginSourceDirectory.discover(fs, directory)
      const commands = yield* CommandFile.load(fs, directory)
      const agents = yield* AgentFile.load(fs, directory)
      const place = { roots: folders, directory }
      const held = [
        ...(plugins.length === 0 ? [] : ["plugins" as const]),
        ...(commands.some((command) => ConfigTrust.hasShellSnippet(command.info.template))
          ? ["commands" as const]
          : []),
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
      const untrusted = folders.some((folder) => FSUtil.contains(folder, file)) ? !trusted : entry.trusted === false
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
          return kinds.length === 0 ? [] : [{ path: entry.path, kinds }]
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
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [WorkspaceTrust.node, Config.node, Location.node, FSUtil.node],
})
