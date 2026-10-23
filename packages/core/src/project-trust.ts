export * as ProjectTrust from "./project-trust.js"

import path from "path"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import type { Scope } from "@orbit/schema/config"
import { Trust } from "@orbit/schema/trust"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Bus } from "./bus.js"
import { Config } from "./config.js"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigTrust } from "./config/trust.js"
import { Git } from "./git.js"
import { GitAccess } from "./git/access.js"
import { Location } from "./location.js"
import { Project } from "./project.js"
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
   * Whether this Location's project is trusted. `withheld` is always empty: nothing of an untrusted project is read, a
   * trusted project's config applies as it is, and nothing above the project is a source.
   */
  readonly status: () => Effect.Effect<Trust.Status>
  /**
   * Trusts this Location's project; see `WorkspaceTrust.grant`. When the project was not trusted, the config is read
   * again before this returns, so what the project holds applies by the time the answer arrives.
   */
  readonly grant: (input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<Trust.Status>
  /** Ends the grants for this Location's project; see `WorkspaceTrust.revoke`. */
  readonly revoke: () => Effect.Effect<Trust.Status>
  /**
   * Whether code that reads the folder around a file, such as a language server or a formatter, may run for that file.
   * Both must hold: this Location's project is trusted, and the file's real path is inside the project's folders or the
   * folder that owns it is trusted in its own right. The owner is found as `Project.root` finds one, from the folder the
   * file really lives in (the nearest folder above it that holds `.git` or `.hg`, else its own folder). A link in the
   * project that leads out is decided by where it leads, and a link that points nowhere by where a write through it
   * would land. A link on the spelling that is not on that real path's walk must lead inside the project or to a
   * folder with a trusted owner too, since a program walking up the spelling reads config there. A linked worktree of a trusted repository, reached as an outside file, needs a grant of its own.
   */
  readonly trustedAt: (file: string) => Effect.Effect<boolean>
  /**
   * Whether a file may run the code it carries, such as the hooks in a skill's or an agent's front matter, or any other
   * file that something would execute. Callers must ask this before running any such code; see `ConfigTrust.allows`.
   * The decision is the store's at this moment, never the stamp of the last config load, which trails a revoke.
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
   * Where a path really leads once every link in it is followed, whether or not the project is trusted. A path that is not
   * there yet leads where the nearest folder of its name that exists does, with the missing tail kept, and a link that
   * points nowhere leads where it points. A link to a network share is named as the share, without opening it. It decides
   * nothing by itself: a caller compares the result with folders that are real too (`FSUtil.contains`).
   */
  readonly leads: (file: string) => Effect.Effect<string>
  /**
   * Whether an instruction file may import a file: `real` is where the import really leads, and `spelling` is how it was
   * written. The import must lie inside the folder the session started in or inside a project folder, the first
   * counted only when it can be trusted for good or is trusted now and the second only when it can be trusted for good,
   * so a session or project at the home directory or a filesystem root that nobody trusted does not open everything below
   * it to a downloaded folder's `@~/.ssh/id_rsa`. And `reachable` must accept the
   * spelling, so an untrusted project supplies only what is inside it.
   */
  readonly importable: (spelling: string, real: string) => Effect.Effect<boolean>
  /**
   * Whether the folder that holds an instruction file lets it import from outside the folders `importable` accepts, and
   * the folder a person would trust to make it so (`directory`, unset when no grant made from this session could). Ask it
   * only after `importable` refused, with the importing file's real path. A file in the project's folders is held by the
   * project, whose decision is the canonical root's: it opens when that is trusted now and either can be trusted for good
   * or is the folder the session started in, so a session below the home directory stays bounded even when the home
   * project is trusted for the session. A file outside them is held by the folder that owns it, found as `trustedAt`
   * finds an owner, which must be trusted now and able to be trusted for good as well as the project opening: a chain does
   * not inherit, and the stricter answer wins. Files that the model's reads load never ask this.
   */
  readonly outward: (importer: string) => Effect.Effect<{ readonly open: boolean; readonly directory?: string }>
  /**
   * Whether a file that a config directory, or a root of another product, holds may be read now: its agents, commands,
   * skills and output styles. Any file may while the project is trusted. Until then only a file whose real path is
   * inside the project's folders may, so that a link in a repository does not carry a file of the user's into the
   * prompt. For a project that is the home directory or a filesystem root those folders are the source's own, the
   * session's started folder and any folder that can be trusted for good, and a decision for the project does not widen
   * them. A file that is left out is logged once, as a warning that says `config file skipped`.
   */
  readonly supplies: (source: Source, file: string) => Effect.Effect<boolean>
  /**
   * Whether the folder that holds a config source is trusted now, which is what `supplies` asks before it lets a file that
   * stays inside the folder be read. A source that is not a project's or a local one is the person's own and always is. A
   * project's or a local source follows the decision just made for the project. `supplies` only says that a file may be
   * read: ask this before text that a source holds speaks for Orbit or for the person, as the opening line of an output
   * style does.
   */
  readonly trustedSource: (source: Source) => Effect.Effect<boolean>
  /**
   * Whether Orbit may run git in `directory` (the Location's folder when not given): this Location's project is trusted,
   * and git, asked which repository it works in there without looking above the project's folder, names a work tree, a
   * git directory and a common directory that this decision covers or whose own folder is trusted (`GitAccess.check`).
   * Ask it before any git command that can run a program the repository's config names. Git's answer is kept until
   * trust changes, and the trust of each folder is read at every call. A refusal is logged once.
   */
  readonly git: (directory?: string) => Effect.Effect<boolean>
  /**
   * Whether a folder other than this Location's is trusted now, such as the working folder that a config names for a
   * program it starts, decided as it would be for a Location there: by its project's canonical folder. `directory` is
   * absolute, read by the caller from the folder it is relative to (`FileAccess.resolveNamed`), and the caller acts in
   * that same folder (class 3).
   */
  readonly folder: (directory: AbsolutePath) => Effect.Effect<WorkspaceTrust.State>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ProjectTrust") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const projects = yield* Project.Service
    // Trust is decided for the project's canonical root, so its linked worktrees share the decision.
    const root = location.project.canonical
    // The folders that decision covers.
    const folders = [...new Set([location.directory, location.project.directory, location.project.canonical])]
    // Those folders as the disk has them, for comparing a real path with them however the Location was reached.
    const real = yield* Effect.forEach(folders, fs.resolve)

    // The repository git works in from each folder that Orbit starts it in, as git answered, until trust changes. The
    // question runs in a fiber of the layer, so a caller that is interrupted leaves no interrupt behind for the next one.
    const vcs = yield* Git.Service
    const bus = yield* Bus.Service
    const scope = yield* Effect.scope
    const used = new Map<string, Fiber.Fiber<Git.Repository | undefined>>()
    // The refusals already logged, so that a refusal is logged once.
    const refused = new Set<string>()
    // On the live channel, which the bus makes when it starts. The channel of one event is made by its first subscriber,
    // and two that start at the same moment can each make one, so that one of them hears nothing.
    yield* bus.subscribe([Trust.Event.Updated]).pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          used.clear()
          refused.clear()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const repositoryOf = (directory: string) =>
      Effect.suspend(() => {
        const known = used.get(directory)
        if (known !== undefined) return Fiber.join(known)
        return vcs.repo.used(AbsolutePath.make(directory), AbsolutePath.make(location.project.directory)).pipe(
          Effect.forkIn(scope),
          Effect.tap((fiber) => Effect.sync(() => used.set(directory, fiber))),
          Effect.flatMap(Fiber.join),
        )
      })

    // The folders an instruction file may import from, as the disk has them: each project folder that can be trusted for
    // good, and the folder the session started in when it can be too or is trusted now. The home directory and a
    // filesystem root cannot be trusted for good and contain everything below them, so they bound nothing until a person
    // has trusted that folder for the session. A project folder never gets that second way in: a project at home, trusted
    // for the session, still leaves a session below it bounded by its own folder.
    const importRoots = Effect.fnUntraced(function* () {
      const bounded = (folder: string, now: boolean) =>
        trust.status(folder).pipe(Effect.map((state) => state.persistent || (now && state.trusted)))
      const projects = yield* Effect.filter(
        [...new Set([location.project.directory, location.project.canonical])],
        (folder) => bounded(folder, false),
      )
      const started = (yield* bounded(location.directory, true)) ? [location.directory] : []
      return yield* Effect.forEach([...started, ...projects], fs.resolve)
    })

    // Whether a file is in one of the project's own folders, as against a folder above them.
    const inside = (file: string) => folders.some((folder) => FSUtil.contains(folder, file))

    // Where a path leads once every link in it is followed. `fs.resolve` stops at a part that is not there, which would
    // put a file that is about to be created under a link where the link is, not where it points. A link that points
    // nowhere leads where it points, and that is where a write through it would land. The depth ends a loop of links or a
    // chain longer than any system follows, and is answered as unresolved, not as the name reached. Whether a path is there is asked of `stat`, which follows links: `access`
    // answers yes for a link that points nowhere on Windows.
    const follow = (file: string, depth = 0): Effect.Effect<string> =>
      Effect.gen(function* () {
        if ((yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))) !== undefined)
          return yield* fs.resolve(file)
        const parent = path.dirname(file)
        if (parent === file) return file
        const named = path.join(yield* follow(parent, depth), path.basename(file))
        // A walk that reaches the limit has not found where the path lands. It is answered as unresolved, which is outside
        // every folder, and never as the name it got to: that name is inside the project.
        if (depth >= LinkShare.LIMIT) return LinkShare.unresolved(named)
        const target = yield* fs.readLink(named).pipe(Effect.orElseSucceed(() => undefined))
        return target === undefined ? named : yield* follow(path.resolve(path.dirname(named), target), depth + 1)
      })

    // The share that a link on the way to a file names, when one does, is not connected to: see `LinkShare`.
    const share = (file: string) => LinkShare.of(fs, file)
    const lead = (file: string) =>
      share(file).pipe(Effect.flatMap((shared) => (shared === undefined ? follow(file) : Effect.succeed(shared))))

    // Whether a file is inside the folders by its name, and still is once every link in it is followed.
    const stays = Effect.fnUntraced(function* (roots: readonly string[], file: string) {
      const within = (candidate: string) => roots.some((folder) => FSUtil.contains(folder, candidate))
      return within(file) && within(yield* lead(file))
    })

    // Files that were left out, so that one that keeps being asked for is reported once.
    const skipped = new Set<string>()

    const trustedSource = Effect.fn("ProjectTrust.trustedSource")(function* (source: Source) {
      if (source.scope !== "project" && source.scope !== "local") return true
      // The decision just made, because a stamp can trail it. Every project and local source is in the project's folders:
      // nothing above them is read (D7).
      return (yield* trust.status(root)).trusted
    })

    // The real path of a config folder, as a root, when the folder is not a link out of the one that holds it.
    const ownFolder = Effect.fnUntraced(function* (folder: string) {
      const real = yield* fs.resolve(folder)
      return FSUtil.contains(yield* fs.resolve(path.dirname(folder)), real) ? [real] : []
    })

    const supplies = Effect.fn("ProjectTrust.supplies")(function* (source: Source, file: string) {
      // A project that is the home directory or a filesystem root contains everything below it, so being inside it proves
      // nothing about a link: its config may supply a file from its own config folder, the folder the session started in
      // and a folder that can be trusted for good, as an import may, and a decision for the project does not widen that.
      // Only a project's or a local source is bounded this way: the person's own sources (the global config folder, the
      // home entries, a vendor's user root) and the administrator's are theirs wherever the session starts.
      const wide =
        (source.scope === "project" || source.scope === "local") &&
        inside(source.path) &&
        (yield* Effect.forEach([location.project.directory, location.project.canonical], (folder) => trust.status(folder))).some(
          (state) => !state.persistent,
        )
      if (!wide && (yield* trustedSource(source))) return true
      // The config folder stands for itself only where it is a folder of the project's own: one that is a link leads
      // to wherever its target is, so its real path is not admitted (the import roots are already real).
      const own = wide ? yield* ownFolder(source.path) : []
      const roots = wide ? [...(yield* importRoots()), source.path, ...own] : folders
      if (yield* stays(wide ? roots : [...roots, ...(yield* Effect.forEach(roots, fs.resolve))], file)) return true
      if (skipped.has(file)) return false
      skipped.add(file)
      yield* Effect.logWarning("config file skipped", {
        path: file,
        reason: "outside the folder it comes from, which is not trusted",
      })
      return false
    })

    // Nothing of an untrusted project is read, a trusted project's config applies as it is (D8), and nothing above the
    // project is a source (D7), so nothing is ever held back.
    const report = (state: WorkspaceTrust.State) => Effect.succeed({ ...state, withheld: [] } satisfies Trust.Status)

    return Service.of({
      trusted: Effect.fn("ProjectTrust.trusted")(() => trust.status(root).pipe(Effect.map((state) => state.trusted))),
      status: Effect.fn("ProjectTrust.status")(() => trust.status(root).pipe(Effect.flatMap(report))),
      folder: Effect.fn("ProjectTrust.folder")(function* (directory) {
        return yield* trust.status((yield* projects.resolve(directory)).canonical)
      }),
      grant: Effect.fn("ProjectTrust.grant")(function* (input) {
        const fresh = !(yield* trust.status(root)).trusted
        const state = yield* trust.grant(root, { persist: input.persist, via: input.via })
        // Nothing of a folder that was not trusted had been read, so the config reads it before the answer goes back.
        const reload = config.reload
        if (fresh && reload !== undefined) yield* reload()
        return yield* report(state)
      }),
      revoke: Effect.fn("ProjectTrust.revoke")(() => trust.revoke(root).pipe(Effect.flatMap(report))),
      // The decision is the store's now, for every entry that the file could be under: an entry's stamp is the last
      // load's, and a revoke it has not seen yet must not let the file run.
      allows: Effect.fn("ProjectTrust.allows")(function* (file) {
        const state = yield* trust.status(root)
        const compat = yield* config.compat()
        const entries = yield* config.entries()
        // Every project and local entry is in the project's folders, so the decision for each is the project's now.
        const verdicts = new Map(
          entries.flatMap((entry) =>
            entry.scope === "project" || entry.scope === "local" ? [[entry, { trusted: state.trusted }] as const] : [],
          ),
        )
        return ConfigTrust.allows(entries, file, { roots: folders, trusted: state.trusted, compat: compat.roots, verdicts })
      }),
      reachable: Effect.fn("ProjectTrust.reachable")(function* (file) {
        if ((yield* trust.status(root)).trusted) return true
        return yield* stays([...folders, ...real], file)
      }),
      leads: Effect.fn("ProjectTrust.leads")((file) => lead(file)),
      importable: Effect.fn("ProjectTrust.importable")(function* (spelling, real) {
        const roots = yield* importRoots()
        if (!roots.some((folder) => FSUtil.contains(folder, real))) return false
        if ((yield* trust.status(root)).trusted) return true
        return yield* stays([...folders, ...(yield* Effect.forEach(folders, fs.resolve))], spelling)
      }),
      outward: Effect.fn("ProjectTrust.outward")(function* (importer) {
        const project = yield* trust.status(root)
        const top = yield* fs.resolve(root)
        const start = yield* fs.resolve(location.directory)
        const reachable = project.persistent || (FSUtil.contains(top, start) && FSUtil.contains(start, top))
        if (real.some((folder) => FSUtil.contains(folder, importer)))
          return reachable ? { open: project.trusted, directory: root } : { open: false }
        const owner = (yield* Project.root(fs, AbsolutePath.make(path.dirname(importer)))) ?? path.dirname(importer)
        const holder = yield* trust.status(owner)
        // A home directory or a filesystem root never stands for the files below it, as for config above the project.
        if (!holder.persistent) return { open: false }
        if (!reachable) return { open: false }
        return project.trusted ? { open: holder.trusted, directory: owner } : { open: false, directory: root }
      }),
      escapes: Effect.fn("ProjectTrust.escapes")(function* (file) {
        if ((yield* trust.status(root)).trusted) return undefined
        const leads = yield* lead(file)
        return [...folders, ...real].some((folder) => FSUtil.contains(folder, leads)) ? undefined : leads
      }),
      // The stricter answer wins: a tool and a spawned program act on the spelling they were given, and a link can
      // lead somewhere else. The real path needs a trusted owner. A program also walks up the spelling looking for
      // config, so each folder on the spelling that is a link, and is not on the real path's own walk, must lead to
      // a folder inside the project or to one with a trusted owner: a link in a folder with no marker, which owns
      // itself, cannot lend it a trusted folder's `.git`.
      trustedAt: Effect.fn("ProjectTrust.trustedAt")(function* (file) {
        if (!(yield* trust.status(root)).trusted) return false
        const spelled = path.resolve(file)
        const leads = yield* lead(file)
        // The owner is the nearest folder above that holds `.git` or `.hg`, else the folder itself.
        const ownerTrusted = Effect.fnUntraced(function* (folder: string) {
          if ([...folders, ...real].some((item) => FSUtil.contains(item, folder))) return true
          const owner = yield* Project.root(fs, AbsolutePath.make(folder))
          return (yield* trust.status(owner ?? folder)).trusted
        })
        const walk = path.dirname(leads)
        if (!(yield* ownerTrusted(walk))) return false
        if (FSUtil.contains(spelled, leads) && FSUtil.contains(leads, spelled)) return true
        for (let folder = path.dirname(spelled); ; folder = path.dirname(folder)) {
          const led = yield* lead(folder)
          // Folders above the project are reached by the real walk as well; they do not own what is below.
          const above = [...folders, ...real].some((item) => FSUtil.contains(led, item))
          if (!above && !FSUtil.contains(led, walk) && !(yield* ownerTrusted(led))) return false
          if (path.dirname(folder) === folder) return true
        }
      }),
      supplies,
      trustedSource,
      git: Effect.fn("ProjectTrust.git")(function* (directory = location.directory) {
        const answer = yield* GitAccess.check({ fs, trust }, { decision: root, folders, used: repositoryOf(directory) })
        if (answer.repository !== undefined) return true
        const key = `${directory}\0${answer.refused?.reason}`
        if (answer.refused === undefined || refused.has(key)) return false
        refused.add(key)
        yield* GitAccess.log(directory, answer.refused)
        return false
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [WorkspaceTrust.node, Config.node, Location.node, FSUtil.node, Git.node, Bus.node, Project.node],
})
