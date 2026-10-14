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

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
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
      const previous = trusted ? yield* cached(store) : undefined
      const id = previous ?? (trusted ? yield* hgRoot(worktree) : undefined)
      return {
        previous,
        // An untrusted folder is its own project, as a folder without version control is, and not `ID.global`: saved
        // "always allow" answers are keyed by project ID, so every untrusted folder that shared `global` would share them.
        id: id ?? (trusted ? ID.global : ID.make(Hash.fast(`directory:${worktree}`))),
        directory: worktree,
        vcs: { type: "hg" as const, store },
      }
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const directory = AbsolutePath.make(yield* fs.resolve(input))
      const native = yield* fs.up({ targets: [".git", ".hg"], start: directory, mode: "first" }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.orElseSucceed(() => undefined),
      )
      const repo =
        native && path.basename(native) === ".git"
          ? yield* git.repo.discover(AbsolutePath.make(path.dirname(native)))
          : undefined
      if (repo) {
        const previous = (yield* trust.status(repo.worktree)).trusted ? yield* cached(repo.commonDirectory) : undefined
        const id = (yield* remote(repo)) ?? previous ?? (yield* rootCommit(repo))
        const canonical = repo.gitDirectory === repo.commonDirectory ? repo.worktree : yield* mainCheckout(repo)
        return yield* persist({
          previous,
          id: id ?? ID.global,
          directory: repo.worktree,
          canonical,
          vcs: { type: "git" as const, store: repo.commonDirectory },
        })
      }

      const hg = native && path.basename(native) === ".hg" ? yield* hgDiscover(AbsolutePath.make(native)) : undefined
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
