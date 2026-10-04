import { Database } from "bun:sqlite"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CompatZed } from "../src/zed.js"
import { live } from "./fixture/effect.js"
import { tmpdirScoped, write } from "./fixture/tmpdir.js"

// The default locations, relative to the home directory, in the order they are tried.
const macos = path.join("Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite")
const linux = path.join(".local", "share", "zed", "db", "0-stable", "db.sqlite")

describe("CompatZed.databasePath", () => {
  live("prefers the file ORBIT_ZED_DB names over the default locations", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const named = path.join(fixture, "named.sqlite")
      yield* write([
        [named, ""],
        [path.join(home, macos), ""],
        [path.join(home, linux), ""],
      ])

      expect(CompatZed.databasePath({ ORBIT_ZED_DB: named }, home)).toBe(named)
    }),
  )

  live("falls back to the default locations, macOS first, when ORBIT_ZED_DB names no file", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home")
      const missing = path.join(fixture, "missing.sqlite")
      // A directory is not a database either.
      const directory = path.join(fixture, "directory")
      yield* write([directory, [path.join(home, linux), ""]])

      expect(CompatZed.databasePath({ ORBIT_ZED_DB: missing }, home)).toBe(path.join(home, linux))
      expect(CompatZed.databasePath({ ORBIT_ZED_DB: directory }, home)).toBe(path.join(home, linux))
      expect(CompatZed.databasePath({}, home)).toBe(path.join(home, linux))

      yield* write([[path.join(home, macos), ""]])
      expect(CompatZed.databasePath({}, home)).toBe(path.join(home, macos))
    }),
  )

  live("finds nothing on a machine without Zed", () =>
    Effect.gen(function* () {
      const home = path.join(yield* tmpdirScoped(), "home")
      yield* write([home])

      expect(CompatZed.databasePath({}, home)).toBeUndefined()
      expect(CompatZed.databasePath({ ORBIT_ZED_DB: "" }, home)).toBeUndefined()
    }),
  )
})

// The tables and columns the reader asks for, as Zed lays them out.
const schema = `
  create table workspaces (workspace_id integer primary key, paths text, timestamp text);
  create table panes (pane_id integer primary key, workspace_id integer, active integer);
  create table items (item_id integer, workspace_id integer, pane_id integer, kind text, active integer);
  create table editors (item_id integer, workspace_id integer, buffer_path text, contents text);
  create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer);
`

interface Fixture {
  readonly workspace: number
  readonly paths: string
  readonly timestamp?: string
  /** What the workspace's active pane has focused: an editor, or another kind of item. */
  readonly item: { readonly kind: "Editor" | "Terminal"; readonly file?: string; readonly contents?: string }
  /** Selections as [start, end] byte offsets into the file. */
  readonly selections?: readonly (readonly [number, number])[]
}

// A Zed database with one active pane and one active item in each workspace.
const database = (file: string, workspaces: readonly Fixture[]) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(file)),
    (db) =>
      Effect.sync(() => {
        db.exec(schema)
        for (const item of workspaces) {
          db.run("insert into workspaces values (?, ?, ?)", [
            item.workspace,
            item.paths,
            item.timestamp ?? "2026-01-01 00:00:00",
          ])
          db.run("insert into panes values (?, ?, 1)", [item.workspace, item.workspace])
          db.run("insert into items values (?, ?, ?, ?, 1)", [
            item.workspace,
            item.workspace,
            item.workspace,
            item.item.kind,
          ])
          if (item.item.kind === "Editor")
            db.run("insert into editors values (?, ?, ?, ?)", [
              item.workspace,
              item.workspace,
              item.item.file ?? null,
              item.item.contents ?? null,
            ])
          for (const [start, end] of item.selections ?? [])
            db.run("insert into editor_selections values (?, ?, ?, ?)", [item.workspace, item.workspace, start, end])
        }
      }),
    (db) => Effect.sync(() => db.close()),
  )

const select = (file: string, cwd: string) => Effect.promise(() => CompatZed.activeSelection(file, cwd))

describe("CompatZed.activeSelection", () => {
  // "héllo wörld\nsecond line\n" with é and ö two bytes long: "wörld" is bytes 7 to 13 and "second" bytes 14 to 20.
  const contents = "héllo wörld\nsecond line\n"

  live("reads the cursors of the focused editor in the workspace that best contains the directory", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const repo = path.join(fixture, "repo")
      const app = path.join(repo, "packages", "app")
      const file = path.join(app, "src", "main.ts")
      const outer = path.join(repo, "README.md")
      yield* write([app])
      const db = path.join(fixture, "db.sqlite")
      yield* database(db, [
        // The outer workspace was used more recently, but the inner one names a closer directory.
        {
          workspace: 1,
          paths: repo,
          timestamp: "2026-02-01 00:00:00",
          item: { kind: "Editor", file: outer, contents: "outer" },
          selections: [[0, 5]],
        },
        {
          workspace: 2,
          paths: [path.join(fixture, "elsewhere"), app].join("\n"),
          item: { kind: "Editor", file, contents },
          // The second cursor was dragged backwards, and they are not stored in order.
          selections: [
            [20, 14],
            [7, 13],
          ],
        },
      ])

      expect(yield* select(db, path.join(app, "src"))).toEqual({
        type: "selection",
        selection: {
          filePath: file,
          source: "zed",
          ranges: [
            { text: "wörld", selection: { start: { line: 1, character: 7 }, end: { line: 1, character: 12 } } },
            { text: "second", selection: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } } },
          ],
        },
      })
      // From the repository itself only the outer workspace contains the directory.
      expect(yield* select(db, repo)).toMatchObject({ type: "selection", selection: { filePath: outer } })
    }),
  )

  live("reads the file when the database holds no contents for the editor", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const file = path.join(fixture, "repo", "notes.txt")
      yield* write([[file, contents]])
      const db = path.join(fixture, "db.sqlite")
      yield* database(db, [
        { workspace: 1, paths: path.dirname(file), item: { kind: "Editor", file }, selections: [[14, 20]] },
      ])

      expect(yield* select(db, path.dirname(file))).toEqual({
        type: "selection",
        selection: {
          filePath: file,
          source: "zed",
          ranges: [{ text: "second", selection: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } } }],
        },
      })
    }),
  )

  live("is unavailable when the file is neither in the database nor on disk", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const repo = path.join(fixture, "repo")
      yield* write([repo])
      const db = path.join(fixture, "db.sqlite")
      yield* database(db, [
        {
          workspace: 1,
          paths: repo,
          item: { kind: "Editor", file: path.join(repo, "deleted.ts") },
          selections: [[0, 1]],
        },
      ])

      expect(yield* select(db, repo)).toEqual({ type: "unavailable" })
    }),
  )

  live("is empty when no workspace contains the directory", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const repo = path.join(fixture, "repo")
      const db = path.join(fixture, "db.sqlite")
      yield* database(db, [
        {
          workspace: 1,
          paths: repo,
          item: { kind: "Editor", file: path.join(repo, "a.ts"), contents },
          selections: [[0, 1]],
        },
      ])

      expect(yield* select(db, path.join(fixture, "other"))).toEqual({ type: "empty" })
      // A workspace whose name merely starts with the directory's does not contain it.
      expect(yield* select(db, `${repo}-copy`)).toEqual({ type: "empty" })
    }),
  )

  live("is empty when the focused editor has no file, and unavailable when it has no cursors", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const repo = path.join(fixture, "repo")
      const scratch = path.join(fixture, "scratch.sqlite")
      yield* database(scratch, [{ workspace: 1, paths: repo, item: { kind: "Editor" } }])
      const cursorless = path.join(fixture, "cursorless.sqlite")
      yield* database(cursorless, [
        { workspace: 1, paths: repo, item: { kind: "Editor", file: path.join(repo, "a.ts"), contents } },
      ])

      expect(yield* select(scratch, repo)).toEqual({ type: "empty" })
      expect(yield* select(cursorless, repo)).toEqual({ type: "unavailable" })
    }),
  )

  live("is unavailable when the focused item is not an editor", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const repo = path.join(fixture, "repo")
      const db = path.join(fixture, "db.sqlite")
      yield* database(db, [{ workspace: 1, paths: repo, item: { kind: "Terminal" } }])

      expect(yield* select(db, repo)).toEqual({ type: "unavailable" })
    }),
  )

  live("is unavailable without a database, or when the file is not one of Zed's", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const text = path.join(fixture, "not-a-database.sqlite")
      const unrelated = path.join(fixture, "unrelated.sqlite")
      yield* write([[text, "this is not SQLite"]])
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(unrelated)),
        (db) => Effect.sync(() => db.exec("create table notes (body text)")),
        (db) => Effect.sync(() => db.close()),
      )

      expect(yield* Effect.promise(() => CompatZed.activeSelection(undefined, fixture))).toEqual({
        type: "unavailable",
      })
      for (const file of [path.join(fixture, "missing.sqlite"), text, unrelated])
        expect(yield* select(file, fixture)).toEqual({ type: "unavailable" })
    }),
  )
})
