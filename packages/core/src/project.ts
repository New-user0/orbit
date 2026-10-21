export * as Project from "./project.js"

import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm"
import path from "path"
import { AbsolutePath } from "./schema.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { Worktree } from "@orbit/schema/worktree"
import { FSUtil } from "@orbit/util/fs-util"
import { Git } from "./git.js"
import { GitAccess } from "./git/access.js"
import { GitLayout } from "./git/layout.js"
import { AppProcess } from "@orbit/util/process"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Hash } from "@orbit/util/hash"
import { ProjectSchema } from "./project/schema.js"
import { ProjectTable, upsertProject } from "./project/sql.js"
import { WorkspaceTrust } from "./workspace-trust.js"
import { WorktreeTable } from "./worktree/sql.js"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export const Current = ProjectSchema.Current
export type Current = ProjectSchema.Current

export const Info = ProjectSchema.Info
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const UpdateInput = ProjectSchema.UpdateInput
export type UpdateInput = ProjectSchema.UpdateInput

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Project.NotFoundError", {
  projectID: ID,
}) {}

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  // This checkout's main directory; the stored project canonical may be another clone.
  readonly canonical: AbsolutePath
  readonly vcs?: Vcs
}

// Keep this filesystem-only; permission checks use it and should not execute VCS commands.
export const root = Effect.fn("Project.root")(function* (
  fs: FSUtil.Interface,
  input: AbsolutePath,
  markers: readonly string[] = [".git", ".hg"],
) {
  return yield* fs.up({ targets: [...markers], start: input, mode: "first" }).pipe(
    Effect.map((matches) => (matches[0] ? AbsolutePath.make(path.dirname(matches[0])) : undefined)),
    Effect.orElseSucceed(() => undefined),
  )
})

const ACTIVATE_INTERVAL = 60_000

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  /** Records Project activity for recency ordering, at most once per minute per Project. */
  readonly activate: (projectID: ID) => Effect.Effect<void>
  /** Resolves and persists the owning Project. */
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Project") {}

function fromRow(row: typeof ProjectTable.$inferSelect): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    canonical: row.worktree,
    vcs: row.vcs ?? undefined,
    name: row.name ?? undefined,
    icon,
    commands: row.commands ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      active: row.time_active,
    },
    sandboxes: row.sandboxes,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const proc = yield* AppProcess.Service
    const trust = yield* WorkspaceTrust.Service
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db

    const announcing = new Set<string>()
    const persist = Effect.fnUntraced(function* (project: Resolved) {
      const previous = yield* db
        .select({ canonical: ProjectTable.worktree })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, project.id))
        .get()
        .pipe(Effect.orDie)
      yield* upsertProject(db, project).pipe(Effect.orDie)
      // Clones share a project ID; only replace a canonical directory that is gone.
      if (
        previous &&
        previous.canonical !== project.canonical &&
        !(yield* fs.exists(previous.canonical).pipe(Effect.orElseSucceed(() => true)))
      ) {
        const row = yield* db
          .update(ProjectTable)
          .set({ worktree: project.canonical })
          .where(eq(ProjectTable.id, project.id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(row))
      }
      if (!project.vcs) return project
      const directories: Array<{ projectID: ID; directory: AbsolutePath; strategy?: string }> = [
        { projectID: project.id, directory: project.canonical },
      ]
      if (project.directory !== project.canonical)
        directories.push({
          projectID: project.id,
          directory: project.directory,
          strategy: project.vcs.type === "git" ? "git" : undefined,
        })
      // A missing directory row means this directory's resolution is a new durable
      // fact. The row insert commits atomically with the event, so a crash between
      // checks retries on the next resolve instead of stranding the announcement.
      // The in-flight set keeps concurrent resolves from publishing the same fact
      // twice.
      for (const item of directories) {
        const key = item.projectID + "\u0000" + item.directory
        if (announcing.has(key)) continue
        announcing.add(key)
        yield* Effect.gen(function* () {
          const stored = yield* db
            .select({ directory: WorktreeTable.directory })
            .from(WorktreeTable)
            .where(and(eq(WorktreeTable.project_id, item.projectID), eq(WorktreeTable.directory, item.directory)))
            .get()
            .pipe(Effect.orDie)
          if (stored) return
          const directory = AbsolutePath.make(yield* fs.resolve(item.directory))
          const markerless = yield* db
            .select({ id: ProjectTable.id, directory: ProjectTable.worktree })
            .from(ProjectTable)
            .where(
              and(
                isNull(ProjectTable.vcs),
                gte(ProjectTable.worktree, directory),
                lte(ProjectTable.worktree, AbsolutePath.make(directory + "\uffff")),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const adopted = yield* Effect.filter(markerless, (candidate) =>
            Effect.gen(function* () {
              if (candidate.id === item.projectID) return false
              if (!FSUtil.contains(directory, candidate.directory)) return false
              const found = yield* fs
                .up({ targets: [".git", ".hg"], start: candidate.directory, stop: directory, mode: "first" })
                .pipe(Effect.orElseSucceed(() => []))
              if (!found[0]) return false
              return (yield* fs.resolve(path.dirname(found[0]))) === directory
            }),
          )
          yield* bus.publish(
            Worktree.Event.Resolved,
            {
              projectID: item.projectID,
              directory: item.directory,
              previous: project.previous ?? ID.global,
              ...(adopted.length ? { adopted: adopted.map((candidate) => candidate.id) } : {}),
            },
            {
              commit: () =>
                db
                  .insert(WorktreeTable)
                  .values({ project_id: item.projectID, directory: item.directory, strategy: item.strategy })
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie, Effect.asVoid),
            },
          )
        }).pipe(Effect.ensuring(Effect.sync(() => announcing.delete(key))))
      }
      return project
    })

    const list = Effect.fn("Project.list")(function* () {
      const rows = yield* db
        .select()
        .from(ProjectTable)
        .orderBy(desc(ProjectTable.time_active), asc(ProjectTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const row = yield* db
        .update(ProjectTable)
        .set({
          worktree: input.canonical,
          name: input.name === undefined ? undefined : input.name || null,
          icon_url_override: input.icon?.override === undefined ? undefined : input.icon.override || null,
          icon_color: input.icon?.color === undefined ? undefined : input.icon.color || null,
          commands:
            input.commands?.start === undefined
              ? undefined
              : input.commands.start
                ? { start: input.commands.start }
                : null,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, input.projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ projectID: input.projectID })
      const project = fromRow(row)
      yield* bus.publish(ProjectSchema.Event.Updated, project)
      return project
    })

    const activated = new Map<ID, number>()
    const activate = Effect.fn("Project.activate")(function* (projectID: ID) {
      const now = Date.now()
      if (now - (activated.get(projectID) ?? 0) < ACTIVATE_INTERVAL) return
      activated.set(projectID, now)
      const row = yield* db
        .update(ProjectTable)
        // Activity is not a metadata edit, so keep time_updated out of the implicit bump.
        .set({ time_active: now, time_updated: sql`${ProjectTable.time_updated}` })
        .where(eq(ProjectTable.id, projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(row))
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "orbit")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.orElseSucceed(() => undefined),
        // The file is the folder's to write: Orbit never creates it. An ID is a commit hash or the hash of a name, and
        // anything else (`global`, a path) is dropped, because the ID is later joined into data-folder paths (class 5).
        Effect.flatMap((id) => {
          if (!id || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) return Effect.succeed(id)
          return Effect.logWarning("ignored a project ID of an unknown shape in " + dir).pipe(Effect.as(undefined))
        }),
      )
    })

    const remoteID = (origin: string | undefined) => {
      const normalized = origin ? url(origin) : undefined
      return normalized ? ID.make(Hash.fast(`git-remote:${normalized}`)) : undefined
    }

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      return remoteID(yield* git.remote.get(repo))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      const parsed = URL.parse(value)
      if (parsed) {
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      }
      const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
      if (scp) return parts(scp[2], scp[3])
      return undefined
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const rootCommit = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    // A linked worktree shares the project, and the trust decision, of the main checkout it was added from. A `.git` file
    // can name any git directory, and that directory's `commondir` can name another repository's, which git then reports
    // as the main checkout of a folder that was never added to it. So the main checkout counts only when its repository
    // lists this folder as a worktree, which `git worktree add` does and a file in the folder cannot.
    const mainCheckout = Effect.fnUntraced(function* (repo: Git.Repository) {
      const items = yield* git.worktree.list(repo).pipe(Effect.orElseSucceed(() => []))
      const main = items.find((item) => item.kind === "main")
      const here = yield* fs.resolve(repo.worktree)
      const linked = yield* Effect.forEach(
        items.filter((item) => item.kind === "linked"),
        (item) => fs.resolve(item.directory),
      )
      return main && linked.some((directory) => path.relative(directory, here) === "") ? main.directory : repo.worktree
    })

    // One ID per repository across the trust decision: a folder that is not trusted and names no remote reuses the git
    // project that Orbit already holds for its main checkout, so what it did before and after trust stays together.
    const stored = Effect.fnUntraced(function* (canonical: AbsolutePath) {
      const rows = yield* db
        .select({ id: ProjectTable.id, vcs: ProjectTable.vcs })
        .from(ProjectTable)
        .where(eq(ProjectTable.worktree, canonical))
        .orderBy(asc(ProjectTable.time_created), asc(ProjectTable.id))
        .all()
        .pipe(Effect.orDie)
      // A row whose ID is the path hash of one of its own checkouts is what Orbit made before trust; a row that is not is
      // the git project that trust made, and it wins over the older path-hash row, so revoking trust again does not move
      // a checkout back to the empty project it had before. Which checkout was resolved first decides which path hash the
      // old row holds, so every directory listed under the row counts, not only this folder's.
      const git = rows.filter((row) => row.vcs === "git" && row.id !== ID.global)
      const listed = yield* Effect.forEach(git, (row) =>
        db
          .select({ directory: WorktreeTable.directory })
          .from(WorktreeTable)
          .where(eq(WorktreeTable.project_id, row.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((items) => [canonical, ...items.map((item) => item.directory)]),
          ),
      )
      const made = git.filter((row, index) => !listed[index].some((directory) => Hash.fast(`directory:${directory}`) === row.id))
      // `pretrust` is the oldest row Orbit made before trust: the sessions from before trust sit under it, whichever row wins.
      const pretrust = git.find((row) => !made.includes(row))
      return { preferred: (made[0] ?? git[0])?.id, pretrust: pretrust?.id }
    })

    const known = Effect.fnUntraced(function* (id: ID) {
      const row = yield* db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      return row !== undefined
    })

    // Mercurial identity uses the cached ID or the first root changeset; remote-derived
    // identity (the git `remote()` path) is a follow-up.
    const hgRoot = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      // Mercurial loads the `[extensions]` (Python) and `[hooks]` of the folder's own `.hg/hgrc` into any command it runs
      // there, and this runs before anyone has been asked about the folder (class 1). It is the same folder that the
      // trust decision is asked for, and no `hg` is started in one that is not trusted: the project is then identified
      // without a first changeset, as it is when `hg` is not installed.
      const result = yield* proc
        .run(
          ChildProcess.make("hg", ["log", "-r", "roots(all())", "-T", "{node}\n"], {
            cwd: worktree,
            env: { HGPLAIN: "1" },
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!result || result.exitCode !== 0) return undefined
      const node = result.stdout
        .toString("utf8")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()[0]
      return node ? ID.make(node) : undefined
    })

    const hgDiscover = Effect.fnUntraced(function* (dotHg: AbsolutePath) {
      const worktree = AbsolutePath.make(path.dirname(dotHg))
      const store = AbsolutePath.make(dotHg)
      const trusted = (yield* trust.status(worktree)).trusted
      // A folder that is not trusted does not choose its own ID by shipping `.hg/orbit` (class 5, class 3).
      const cachedID = trusted ? yield* cached(store) : undefined
      const id = cachedID ?? (trusted ? yield* hgRoot(worktree) : undefined)
      // The ID the folder had while it was untrusted, so the sessions made then follow it into the trusted project.
      const earlier = ID.make(Hash.fast(`directory:${worktree}`))
      const resolved = id ?? earlier
      return {
        previous: trusted && earlier !== resolved && (yield* known(earlier)) ? earlier : cachedID,
        // A folder with no changeset to name it by (untrusted, or hg missing or failing) is its own project, as a folder
        // without version control is, before and after the grant, and not `ID.global`: saved "always allow" answers are
        // keyed by project ID, so every such folder that shared `global` would share them.
        id: resolved,
        directory: worktree,
        vcs: { type: "hg" as const, store },
      }
    })

    // The nearest `.git` or `.hg`. Git passes over a `.git` directory that it does not take for a repository and looks in
    // the folder above, and stops at a `.git` file that is no good, so a `.git` directory counts when `GitLayout` finds a
    // layout in it, and the folder named here is the one git uses.
    const marker = (
      start: string,
    ): Effect.Effect<
      | { readonly type: "git"; readonly holder: AbsolutePath; readonly layout?: GitLayout.Layout }
      | { readonly type: "hg"; readonly native: AbsolutePath }
      | undefined
    > =>
      Effect.gen(function* () {
        const native = yield* fs.up({ targets: [".git", ".hg"], start, mode: "first" }).pipe(
          Effect.map((matches) => matches[0]),
          Effect.orElseSucceed(() => undefined),
        )
        if (!native) return undefined
        if (path.basename(native) === ".hg") return { type: "hg" as const, native: AbsolutePath.make(native) }
        const holder = AbsolutePath.make(path.dirname(native))
        const layout = yield* GitLayout.locate(fs, holder)
        const above = path.dirname(holder)
        if (layout || !(yield* fs.isDir(native)) || above === holder) return { type: "git" as const, holder, layout }
        return yield* marker(above)
      })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const directory = AbsolutePath.make(yield* fs.resolve(input))
      const found = yield* marker(directory)
      const holder = found?.type === "git" ? found.holder : undefined
      const layout = found?.type === "git" ? found.layout : undefined
      // Git applies the config of the folder it runs in, and a clone chooses that file: it can name a program for git to
      // run, and a project is resolved when a client opens the folder, before anyone is asked about it (class 1). So git
      // starts only for a folder that is trusted. The decision is the main checkout's for a linked worktree, as
      // `ProjectTrust` takes it, and the layout says which that is without asking git. Any other folder is read from its
      // files, and is its own project when they name no remote, as an untrusted Mercurial folder is. Git follows what the
      // folder's `.git` names, so once the folder is trusted git is first asked which repository it uses, and is used no
      // further unless that repository's folders are trusted too (`GitAccess`).
      const decision = layout?.canonical ?? holder
      const access: GitAccess.Answer =
        holder && decision
          ? yield* GitAccess.check({ fs, trust }, { decision, folders: [holder, decision], used: git.repo.used(holder, holder) })
          : {}
      if (holder && access.refused) yield* GitAccess.log(holder, access.refused)
      const repo = access.repository
      // A trusted folder that git gives no answer for (git on no PATH, a config or an owner that git refuses), or whose
      // repository is in a folder that is not trusted, is read from its files as well, as it was before the grant, so that
      // its project, its folders and the decision that covers them stay what they were (class 3).
      if (layout && !repo) {
        return yield* persist({
          id:
            remoteID(yield* GitLayout.remote(fs, layout)) ??
            (yield* stored(layout.canonical)).preferred ??
            ID.make(Hash.fast(`directory:${layout.worktree}`)),
          directory: layout.worktree,
          canonical: layout.canonical,
          vcs: { type: "git" as const, store: layout.commonDirectory },
        })
      }
      if (repo) {
        const cachedID = (yield* trust.status(repo.worktree)).trusted ? yield* cached(repo.commonDirectory) : undefined
        const id = (yield* remote(repo)) ?? cachedID ?? (yield* rootCommit(repo))
        // The ID this folder had while it was untrusted (above), so its sessions follow it into the trusted project.
        const pretrust = layout ? (yield* stored(layout.canonical)).pretrust : undefined
        const earlier = layout
          ? (remoteID(yield* GitLayout.remote(fs, layout)) ??
            pretrust ??
            ID.make(Hash.fast(`directory:${layout.worktree}`)))
          : undefined
        // A repository that git cannot name, with no remote and no commit yet, keeps the name it had before the grant and is
        // never put in `global`, the project that every such folder would share with its sessions and memory.
        const named = id ?? earlier ?? ID.global
        // The sessions follow the repository from the ID it had before (above), or from the one its folder named it by
        // while it had no name, which a remote added since then no longer leads to. A shipped `.git/orbit` names the ID
        // but does not drop the sessions made before trust.
        const [moved] = yield* Effect.filter(
          [...new Set([earlier, pretrust])].filter(
            (candidate): candidate is ID => candidate !== undefined && candidate !== named,
          ),
          known,
        )
        const previous = moved ?? cachedID
        const canonical = repo.gitDirectory === repo.commonDirectory ? repo.worktree : yield* mainCheckout(repo)
        return yield* persist({
          previous,
          id: named,
          directory: repo.worktree,
          canonical,
          vcs: { type: "git" as const, store: repo.commonDirectory },
        })
      }

      const hg = found?.type === "hg" ? yield* hgDiscover(found.native) : undefined
      if (hg) {
        return yield* persist({
          ...hg,
          canonical: hg.directory,
        })
      }

      return yield* persist({
        id: ID.make(Hash.fast(`directory:${directory}`)),
        directory,
        canonical: directory,
        vcs: undefined,
      })
    })

    return Service.of({ list, update, activate, resolve })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Bus.node, Database.node, FSUtil.node, Git.node, AppProcess.node, WorkspaceTrust.node],
})
