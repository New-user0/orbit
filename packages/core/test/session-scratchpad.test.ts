// The scratchpad of a session lineage: where its folder is, what the baseline says of it, how the folder is made, and
// how it goes with its session. A client chooses the ID of a session it creates, and the ID becomes the name of a
// folder here, so the hostile IDs are tried as each of the three places that name one (class 5).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Logger } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Instance } from "@orbit/core/instance/service"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-services"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEnvironment } from "@orbit/core/session/environment"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelTransport } from "@orbit/core/session/model-transport"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { location } from "./fixture/location"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { readInitial, readUpdate, state } from "./lib/instructions"
import { globalProjectNode } from "./lib/project"
import { insertSession } from "./lib/session-row"

const linkType = process.platform === "win32" ? "junction" : "dir"
const timeout = { timeout: 120_000 }
const project = AbsolutePath.make(path.resolve("/project"))
const place = Location.Ref.make({ directory: project })

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const tmp = path.join(root, "tmp")
  return {
    root,
    tmp,
    sessions: path.join(tmp, "sessions"),
    folder: (key: string) => path.join(tmp, "sessions", key),
    elsewhere: path.join(root, "elsewhere"),
  }
})
type Layout = Effect.Success<typeof layout>

const globalOf = (l: Layout) =>
  Global.layerWith({ tmp: l.tmp, data: path.join(l.root, "data"), config: path.join(l.root, "config") })

// The service and the store it asks about forks, with no instance of the location: a test publishes the deletion itself.
const provide = (l: Layout) =>
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionScratchpad.node]), [
      Global.node.replace(globalOf(l)),
      Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory: project })))),
    ]),
  )

const scenario = <A, E>(
  body: (l: Layout) => Effect.Effect<A, E, SessionScratchpad.Service | Bus.Service | Database.Service>,
) =>
  Effect.gen(function* () {
    const l = yield* layout
    return yield* body(l).pipe(provide(l))
  })

const exists = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )

// The whole tree under `root`, so that "nothing was made anywhere" is told from "nothing was made where it should be".
const tree = (root: string) =>
  Effect.promise(() => fs.readdir(root, { recursive: true }).then((list) => list.toSorted()))

// What the service logs, in order, messages and the values it gives with them.
const logging = (logged: unknown[]) =>
  Effect.provideService(
    Logger.CurrentLoggers,
    new Set([Logger.make((entry) => logged.push(...[entry.message].flat()))]),
  )
const warnings = (logged: readonly unknown[]) =>
  logged.filter((message): message is string => typeof message === "string" && message.startsWith("session scratchpad"))

// A deletion is handled by a fiber of the service, so a test waits for what it should do.
const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (yield* check) return true
      yield* Effect.sleep("20 millis")
    }
    return false
  })

const lineage = (input: { readonly id: string; readonly parentID?: string; readonly fork?: string }) => ({
  id: SessionSchema.ID.make(input.id),
  ...(input.parentID === undefined ? {} : { parentID: SessionSchema.ID.make(input.parentID) }),
  ...(input.fork === undefined
    ? {}
    : {
        fork: {
          sessionID: SessionSchema.ID.make(input.fork),
          boundary: { type: "through" as const, messageID: SessionMessage.ID.make("msg_boundary") },
        },
      }),
})

const deleted = (bus: Bus.Interface, sessionID: string) =>
  bus.publish(SessionEvent.Deleted, { sessionID: SessionSchema.ID.make(sessionID) }, { location: place })

// Deletions are handled in the order they are published, so once the sentinel's folder is gone, every deletion before
// it has been handled too.
const settled = (l: Layout) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const scratchpad = yield* SessionScratchpad.Service
    yield* scratchpad.ensure(lineage({ id: "ses_sentinel" }))
    yield* deleted(bus, "ses_sentinel")
    return yield* eventually(exists(l.folder("ses_sentinel")).pipe(Effect.map((there) => !there)))
  })

// The IDs that no client should send, and where each would put a folder if it were joined as it is.
const hostile = [
  "ses_../x",
  "ses/../../x",
  "ses\\..\\..\\x",
  "ses_..",
  "ses:x",
  "ses_a.",
  `ses_${"a".repeat(300)}`,
] as const

// A marker where a hostile ID would put a folder, planted when this system lets a file be there. The result is the
// marker, or nothing where the name cannot be made (a colon on Windows, a name longer than the system holds).
const plant = (l: Layout, id: string) =>
  Effect.promise(async () => {
    const target = path.join(l.sessions, id)
    const marker = path.join(target, "marker.txt")
    return fs
      .mkdir(target, { recursive: true })
      .then(() => Bun.write(marker, "keep"))
      .then(
        () => marker,
        () => undefined,
      )
  })

describe("the folder of a session's scratchpad", () => {
  it.live(
    "is named after the session that the lineage goes back to, which a subagent and a fork share",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const root = scratchpad.path(lineage({ id: "ses_root" }))
          expect(root).toBe(l.folder("ses_root"))
          expect(scratchpad.path(lineage({ id: "ses_child", parentID: "ses_root" }))).toBe(root)
          expect(scratchpad.path(lineage({ id: "ses_fork", fork: "ses_root" }))).toBe(root)
          // A subagent's subagent goes back only as far as its parent, and so does a fork of a subagent.
          expect(scratchpad.path(lineage({ id: "ses_grand", parentID: "ses_child" }))).toBe(l.folder("ses_child"))
          expect(scratchpad.path(lineage({ id: "ses_forkchild", fork: "ses_child" }))).toBe(l.folder("ses_child"))
        }),
      ),
    timeout,
  )

  it.live(
    "is nothing for an ID that cannot name a folder, whichever of the three places holds it",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          for (const id of hostile) {
            expect(scratchpad.path(lineage({ id }))).toBeUndefined()
            expect(scratchpad.path(lineage({ id: "ses_own", parentID: id }))).toBeUndefined()
            expect(scratchpad.path(lineage({ id: "ses_own", fork: id }))).toBeUndefined()
          }
        }),
      ),
    timeout,
  )
})

describe("the baseline section", () => {
  it.live(
    "names the folder, and reading it makes nothing",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const before = yield* tree(l.root)
          const source = scratchpad.source(lineage({ id: "ses_root" }))
          const initial = yield* readInitial(source)
          const folder = l.folder("ses_root")
          expect(initial.values).toEqual({ "core/scratchpad": folder })
          // What the model reads, and the one claim about approval that `permission-scratchpad.test.ts` pins.
          expect(initial.text).toBe(
            [
              "# Scratchpad",
              "",
              "**Keep every temporary file in this session's scratchpad, not in the system temp folder.**",
              "",
              `\`${folder}\``,
              "",
              "Use it for:",
              "- intermediate results of multi-step work",
              "- throwaway scripts and config files",
              "- notes and working files for analysis",
              "- anything else you would otherwise put in the system temp folder",
              "",
              "Use the system temp folder only when the user asks you to. The scratchpad belongs to this session and its subagents and sits apart from the user's project. Writing files there with the file tools needs no approval.",
            ].join("\n"),
          )
          // A second read, as a preview or a generation makes, and the path itself: still nothing on the disk.
          yield* Instructions.read(source)
          scratchpad.path(lineage({ id: "ses_root" }))
          expect(yield* exists(l.sessions)).toBe(false)
          expect(yield* tree(l.root)).toEqual(before)
        }),
      ),
    timeout,
  )

  it.live(
    "is the same for a subagent and a fork of the session, and says nothing again while the folder is the same",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const root = yield* readInitial(scratchpad.source(lineage({ id: "ses_root" })))
          for (const session of [
            lineage({ id: "ses_child", parentID: "ses_root" }),
            lineage({ id: "ses_fork", fork: "ses_root" }),
          ]) {
            const same = yield* readUpdate(scratchpad.source(session), root)
            expect(same.changed).toBe(false)
            expect(same.text).toBe("")
          }
        }),
      ),
    timeout,
  )

  it.live(
    "reaches a session whose baseline had no scratchpad as one update that holds the section",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const earlier = state({ "core/date": "Wed Jun 03 2026" })
          const update = yield* readUpdate(scratchpad.source(lineage({ id: "ses_root" })), earlier)
          expect(update.changed).toBe(true)
          expect(update.text).toStartWith("# Scratchpad")
          expect(update.text).toContain(`\`${l.folder("ses_root")}\``)
          // And once it is in the baseline there is nothing more to say.
          expect((yield* readUpdate(scratchpad.source(lineage({ id: "ses_root" })), update)).changed).toBe(false)
        }),
      ),
    timeout,
  )

  it.live(
    "says that the folder moved when a session reads another, once",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const root = yield* readInitial(scratchpad.source(lineage({ id: "ses_root" })))
          // A fork of a subagent goes back only as far as the subagent, so it reads the subagent's folder.
          const moved = yield* readUpdate(scratchpad.source(lineage({ id: "ses_forkchild", fork: "ses_child" })), root)
          expect(moved.changed).toBe(true)
          expect(moved.text).toBe(
            [
              "Your scratchpad moved. Keep temporary files in the new folder from now on:",
              "",
              `\`${l.folder("ses_child")}\``,
            ].join("\n"),
          )
        }),
      ),
    timeout,
  )

  it.live(
    "has no section for a session whose ID cannot name a folder, and the source reads removed",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          for (const id of hostile) {
            for (const session of [
              lineage({ id }),
              lineage({ id: "ses_own", parentID: id }),
              lineage({ id: "ses_own", fork: id }),
            ]) {
              const source = scratchpad.source(session)
              expect(yield* Instructions.read(source)).toEqual([
                { key: Instructions.Key.make("core/scratchpad"), value: Instructions.removed },
              ])
              expect((yield* readInitial(source)).text).toBe("")
            }
          }
          // The control: a session whose ID is a name has a section.
          expect((yield* readInitial(scratchpad.source(lineage({ id: "ses_ok" })))).text).toStartWith("# Scratchpad")
        }),
      ),
    timeout,
  )
})

describe("making the folder", () => {
  it.live(
    "makes it, closed to other users where the system has such a thing, and keeps what is in it the second time",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const session = lineage({ id: "ses_root" })
          yield* scratchpad.ensure(session)
          const info = yield* Effect.promise(() => fs.lstat(l.folder("ses_root")))
          expect(info.isDirectory()).toBe(true)
          // Windows has no such mode: its temporary folder is already the person's own.
          if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o700)
          yield* Effect.promise(() => Bun.write(path.join(l.folder("ses_root"), "notes.txt"), "keep"))
          yield* scratchpad.ensure(session)
          expect(yield* Effect.promise(() => Bun.file(path.join(l.folder("ses_root"), "notes.txt")).text())).toBe("keep")
        }),
      ),
    timeout,
  )

  it.live(
    "makes the folder of the lineage and not one named after the subagent or the fork",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          yield* scratchpad.ensure(lineage({ id: "ses_child", parentID: "ses_root" }))
          yield* scratchpad.ensure(lineage({ id: "ses_fork", fork: "ses_root" }))
          expect(yield* Effect.promise(() => fs.readdir(l.sessions))).toEqual(["ses_root"])
        }),
      ),
    timeout,
  )

  it.live(
    "does not use a link that stands where the folder should be, and does not fail",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          yield* Effect.promise(async () => {
            await fs.mkdir(l.sessions, { recursive: true })
            await fs.mkdir(l.elsewhere, { recursive: true })
            await fs.symlink(l.elsewhere, l.folder("ses_root"), linkType)
          })
          const logged: unknown[] = []
          yield* scratchpad.ensure(lineage({ id: "ses_root" })).pipe(logging(logged))
          expect(warnings(logged)).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readdir(l.elsewhere))).toEqual([])
          expect((yield* Effect.promise(() => fs.lstat(l.folder("ses_root")))).isSymbolicLink()).toBe(true)
        }),
      ),
    timeout,
  )

  it.live(
    "logs one line and does not fail when the folder of sessions is a file",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          yield* Effect.promise(() => Bun.write(l.sessions, "not a folder"))
          const logged: unknown[] = []
          yield* scratchpad.ensure(lineage({ id: "ses_root" })).pipe(logging(logged))
          expect(warnings(logged)).toHaveLength(1)
          expect(yield* Effect.promise(() => Bun.file(l.sessions).text())).toBe("not a folder")
        }),
      ),
    timeout,
  )

  // Class 5: the ID is joined into a path only after its shape is checked. Nothing is made anywhere, and each ID
  // that cannot name a folder is told once, with the characters that act on a terminal written out (class 9).
  for (const id of hostile)
    for (const position of ["id", "parentID", "fork"] as const)
      it.live(
        `makes nothing for ${JSON.stringify(id.length > 30 ? `${id.slice(0, 12)}...` : id)} as the ${position}, and logs once`,
        () =>
          scenario((l) =>
            Effect.gen(function* () {
              const scratchpad = yield* SessionScratchpad.Service
              const marker = yield* plant(l, id)
              const before = yield* tree(l.root)
              const logged: unknown[] = []
              const session =
                position === "id"
                  ? lineage({ id })
                  : position === "parentID"
                    ? lineage({ id: "ses_own", parentID: id })
                    : lineage({ id: "ses_own", fork: id })
              yield* scratchpad.ensure(session).pipe(logging(logged))
              expect(yield* tree(l.root)).toEqual(before)
              expect(warnings(logged)).toHaveLength(1)
              if (marker !== undefined) expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("keep")
            }),
          ),
        timeout,
      )

  it.live(
    "writes an ID with control characters out in the line that names it",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const logged: unknown[] = []
          yield* scratchpad.ensure(lineage({ id: "ses_\u001b]0;title\u0007\u001b[31m" })).pipe(logging(logged))
          expect(warnings(logged)).toHaveLength(1)
          const text = JSON.stringify(logged)
          expect(text).not.toContain("\\u001b")
          expect(text).not.toContain("\\u0007")
          expect(text).toContain("\\\\x1b")
        }),
      ),
    timeout,
  )

  it.live(
    "makes the folder of an ID that is a name, as a control for the rows above",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const scratchpad = yield* SessionScratchpad.Service
          const logged: unknown[] = []
          yield* scratchpad.ensure(lineage({ id: "ses_ok" })).pipe(logging(logged))
          expect(warnings(logged)).toEqual([])
          expect((yield* Effect.promise(() => fs.lstat(l.folder("ses_ok")))).isDirectory()).toBe(true)
        }),
      ),
    timeout,
  )
})

describe("removing the folder with its session", () => {
  it.live(
    "removes the folder when the session whose ID names it is deleted",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          yield* insertSession({ id: "ses_root", directory: project })
          yield* scratchpad.ensure(lineage({ id: "ses_root" }))
          yield* Effect.promise(() => Bun.write(path.join(l.folder("ses_root"), "notes.txt"), "scratch"))
          yield* deleted(bus, "ses_root")
          expect(yield* eventually(exists(l.folder("ses_root")).pipe(Effect.map((there) => !there)))).toBe(true)
          // Only that folder: the folder of sessions and its other folders stay.
          expect(yield* exists(l.sessions)).toBe(true)
        }),
      ),
    timeout,
  )

  it.live(
    "keeps the folder when a subagent or a fork is deleted, and removes it with the session that names it",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          yield* insertSession({ id: "ses_root", directory: project })
          yield* insertSession({ id: "ses_child", directory: project, parentID: "ses_root" })
          yield* insertSession({ id: "ses_fork", directory: project, fork: "ses_root" })
          yield* scratchpad.ensure(lineage({ id: "ses_child", parentID: "ses_root" }))
          // The subagent and the fork go first, and nothing is removed that the session of the folder still uses.
          yield* deleted(bus, "ses_child")
          yield* deleted(bus, "ses_fork")
          expect(yield* settled(l)).toBe(true)
          expect(yield* exists(l.folder("ses_root"))).toBe(true)
          yield* deleted(bus, "ses_root")
          expect(yield* eventually(exists(l.folder("ses_root")).pipe(Effect.map((there) => !there)))).toBe(true)
        }),
      ),
    timeout,
  )

  it.live(
    "keeps the folder of a deleted session while a fork of it is left, so the fork keeps its files",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          yield* insertSession({ id: "ses_root", directory: project })
          yield* insertSession({ id: "ses_fork", directory: project, fork: "ses_root" })
          yield* scratchpad.ensure(lineage({ id: "ses_fork", fork: "ses_root" }))
          yield* Effect.promise(() => Bun.write(path.join(l.folder("ses_root"), "notes.txt"), "the fork's"))
          yield* deleted(bus, "ses_root")
          expect(yield* settled(l)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(path.join(l.folder("ses_root"), "notes.txt")).text())).toBe(
            "the fork's",
          )
        }),
      ),
    timeout,
  )

  it.live(
    "removes a link that stands where the folder should be as a link, and not what it points to",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const marker = path.join(l.elsewhere, "marker.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(l.sessions, { recursive: true })
            await fs.mkdir(l.elsewhere, { recursive: true })
            await Bun.write(marker, "keep")
            await fs.symlink(l.elsewhere, l.folder("ses_root"), linkType)
          })
          yield* deleted(bus, "ses_root")
          expect(yield* eventually(exists(l.folder("ses_root")).pipe(Effect.map((there) => !there)))).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("keep")
        }),
      ),
    timeout,
  )

  it.live(
    "removes a link inside the folder as a link, and not what it points to",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          const marker = path.join(l.elsewhere, "marker.txt")
          yield* scratchpad.ensure(lineage({ id: "ses_root" }))
          yield* Effect.promise(async () => {
            await fs.mkdir(l.elsewhere, { recursive: true })
            await Bun.write(marker, "keep")
            await fs.symlink(l.elsewhere, path.join(l.folder("ses_root"), "inner"), linkType)
          })
          yield* deleted(bus, "ses_root")
          expect(yield* eventually(exists(l.folder("ses_root")).pipe(Effect.map((there) => !there)))).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("keep")
        }),
      ),
    timeout,
  )

  // Class 5: a deletion carries only the ID, and a client chose it. Deleting a session with an ID that cannot name a
  // folder, or one whose parent or fork source cannot, leaves a marker at the place that ID would have named.
  for (const id of hostile)
    for (const position of ["id", "parentID", "fork"] as const)
      it.live(
        `leaves what is at ${JSON.stringify(id.length > 30 ? `${id.slice(0, 12)}...` : id)} when its session is deleted, as the ${position}`,
        () =>
          scenario((l) =>
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const scratchpad = yield* SessionScratchpad.Service
              const marker = yield* plant(l, id)
              const own = position === "id" ? id : "ses_own"
              yield* insertSession({ id, directory: project })
              if (position !== "id")
                yield* insertSession({
                  id: own,
                  directory: project,
                  ...(position === "parentID" ? { parentID: id } : { fork: id }),
                })
              yield* scratchpad.ensure(
                position === "id"
                  ? lineage({ id })
                  : position === "parentID"
                    ? lineage({ id: own, parentID: id })
                    : lineage({ id: own, fork: id }),
              )
              yield* deleted(bus, own)
              if (position !== "id") yield* deleted(bus, id)
              expect(yield* settled(l)).toBe(true)
              if (marker !== undefined) expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("keep")
            }),
          ),
        timeout,
      )

  // The control for the rows above: the sentinel's folder is made and removed by the same path, so a row cannot pass
  // because deletions are never handled.
  it.live(
    "removes the folder of an ID that is a name, as a control for the rows above",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          yield* scratchpad.ensure(lineage({ id: "ses_ok" }))
          expect(yield* exists(l.folder("ses_ok"))).toBe(true)
          yield* deleted(bus, "ses_ok")
          expect(yield* eventually(exists(l.folder("ses_ok")).pipe(Effect.map((there) => !there)))).toBe(true)
        }),
      ),
    timeout,
  )
})

// The whole path, through the session service and a booted location, the way a client deletes a session. The service
// of the location handles the deletion, so the folder is gone without the test publishing anything.
describe("deleting a session through the session service", () => {
  const transport = Layer.succeed(
    SessionModelTransport.Service,
    SessionModelTransport.Service.of({
      bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
      close: () => Effect.void,
      closeAll: Effect.void,
    }),
  )
  const instanceLayer = (l: Layout) =>
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        SessionEnvironment.node,
        Session.node,
        Instance.node,
        LocationServiceMap.node,
      ]),
      [
        Global.node.replace(globalOf(l)),
        Project.node.replace(globalProjectNode),
        SessionExecution.node.replace(SessionExecution.noopLayer),
        SessionModelTransport.node.replace(transport),
        offlineModels,
      ],
    )

  it.live(
    "removes the folder with the session whose ID names it, and not with a subagent",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const directory = (yield* tmpdirScoped()).path
        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const locations = yield* LocationServiceMap.Service
          const at = Location.Ref.make({ directory: AbsolutePath.make(directory) })
          const root = yield* sessions.create({ location: at })
          const child = yield* sessions.create({ parentID: root.id })
          const context = yield* Effect.acquireRelease(locations.contextEffect(at), () => locations.invalidate(at))
          const scratchpad = Context.get(context, SessionScratchpad.Service)
          yield* scratchpad.ensure(child)
          const folder = l.folder(root.id)
          expect(yield* exists(folder)).toBe(true)

          yield* sessions.remove(child.id)
          // The subagent shares the folder, so deleting the subagent leaves it.
          yield* Effect.sleep("300 millis")
          expect(yield* exists(folder)).toBe(true)

          yield* sessions.remove(root.id)
          expect(yield* eventually(exists(folder).pipe(Effect.map((there) => !there)))).toBe(true)
        }).pipe(Effect.provide(instanceLayer(l)))
      }),
    timeout,
  )

  it.live(
    "keeps the folder of a deleted session while a fork of it is left",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const directory = (yield* tmpdirScoped()).path
        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const locations = yield* LocationServiceMap.Service
          const at = Location.Ref.make({ directory: AbsolutePath.make(directory) })
          const root = yield* sessions.create({ location: at })
          const context = yield* Effect.acquireRelease(locations.contextEffect(at), () => locations.invalidate(at))
          const scratchpad = Context.get(context, SessionScratchpad.Service)
          // A fork needs a message to fork at, and the row is what the guard reads, so it is stored as a fork is.
          yield* insertSession({ id: "ses_forked_later", directory, fork: root.id })
          yield* scratchpad.ensure(root)
          yield* sessions.remove(root.id)
          yield* Effect.sleep("300 millis")
          expect(yield* exists(l.folder(root.id))).toBe(true)
        }).pipe(Effect.provide(instanceLayer(l)))
      }),
    timeout,
  )
})

// A row keeps a folder only when its lineage goes back to the deleted session: by its parent, or by its fork source
// when it has no parent. A fork that is itself a subagent goes back to its parent.
describe("the rows that keep a folder", () => {
  it.live(
    "does not keep the folder for a fork that has a parent of its own",
    () =>
      scenario((l) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const scratchpad = yield* SessionScratchpad.Service
          yield* insertSession({ id: "ses_root", directory: project })
          yield* insertSession({ id: "ses_parent", directory: project })
          yield* insertSession({ id: "ses_fork", directory: project, parentID: "ses_parent", fork: "ses_root" })
          yield* scratchpad.ensure(lineage({ id: "ses_root" }))
          yield* deleted(bus, "ses_root")
          expect(yield* eventually(exists(l.folder("ses_root")).pipe(Effect.map((there) => !there)))).toBe(true)
        }),
      ),
    timeout,
  )
})
