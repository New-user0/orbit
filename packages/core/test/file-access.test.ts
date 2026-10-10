import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { AbsolutePath } from "@orbit/core/schema"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location, tempLocationLayer } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { shortName } from "./fixture/short-name"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity } from "./lib/tool"

const invocation = {
  ...toolIdentity,
  sessionID: Session.ID.make("ses_file_access"),
  id: Tool.CallID.make("call-read"),
}
const slash = (file: string) => file.replaceAll("\\", "/")

function provide(requests: Permission.AssertInput[], denied?: string) {
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node]), [
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(
        permissionLayer({
          assert: (input) =>
            Effect.gen(function* () {
              requests.push(input)
              if (input.action === denied)
                yield* new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                })
            }),
        }),
      ),
    ]),
  )
}

describe("FileAccess.authorizeRead", () => {
  it.live("returns an absolute target and preserves invocation identity on the read assertion", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const target = yield* access.authorizeRead("src/../README.md", invocation)
      const absolute: AbsolutePath = target.absolute

      expect(absolute).toBe(AbsolutePath.make(path.join(location.directory, "README.md")))
      expect(target.externalDirectory).toBeUndefined()
      expect(requests).toEqual([
        {
          action: "Read",
          resources: ["README.md"],
          save: ["*"],
          // The absolute place, which a client shows rather than the path as the input spelled it.
          metadata: { paths: [absolute] },
          sessionID: invocation.sessionID,
          agent: invocation.agent,
          source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
        },
      ])
    }).pipe(provide(requests))
  })

  // A device is refused from its resolved path, before the external-directory question and the read rules.
  const devices =
    process.platform === "win32"
      ? ["NUL", "nul.txt", "COM1", "src/con.txt", "AUX"]
      : ["/dev/zero", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0", "/dev/./urandom", "/dev/pts/0"]
  for (const device of devices)
    it.live(`refuses the device ${device} without asking`, () => {
      const requests: Permission.AssertInput[] = []
      return Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const error = yield* access.authorizeRead(device, invocation).pipe(Effect.flip)

        expect(error).toBeInstanceOf(FileAccess.DeviceError)
        expect(error.message).toContain("device or stream")
        expect(requests).toEqual([])
      }).pipe(provide(requests))
    })

  it.live("still authorizes a file whose name only starts like a device", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      yield* access.authorizeRead("console.log", invocation)
      yield* access.authorizeRead("con-notes.md", invocation)

      expect(requests.map((request) => request.action)).toEqual(["Read", "Read"])
    }).pipe(provide(requests))
  })

  it.live("authorizes an external directory before the file's read rules", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const target = yield* access.authorizeRead("../notes.txt", invocation)

      expect(requests).toMatchObject([
        { action: "external_directory", resources: [slash(path.join(path.dirname(target.absolute), "*"))] },
        { action: "Read", resources: [slash(target.absolute)] },
      ])
      for (const request of requests) {
        expect(request).toMatchObject({
          sessionID: invocation.sessionID,
          agent: invocation.agent,
          source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
        })
      }
    }).pipe(provide(requests))
  })

  for (const action of ["external_directory", "Read"]) {
    it.live(`propagates ${action} denial without continuing authorization`, () => {
      const requests: Permission.AssertInput[] = []
      return Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const error = yield* access.authorizeRead("../notes.txt", invocation).pipe(Effect.flip)

        expect(error).toBeInstanceOf(Permission.BlockedError)
        expect(requests.map((request) => request.action)).toEqual(
          action === "external_directory" ? ["external_directory"] : ["external_directory", "Read"],
        )
      }).pipe(provide(requests, action))
    })
  }

  it.live("reuses a sibling's directory approval only for the supplied recovery call", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const requested = yield* access.authorizeRead("../report final.txt", invocation)
      const recovered = yield* access.authorizeRead("../report\u202ffinal.txt", invocation, { siblingOf: requested })
      yield* access.authorizeRead("../notes.txt", invocation)

      expect(requests.map((request) => request.action)).toEqual([
        "external_directory",
        "Read",
        "Read",
        "external_directory",
        "Read",
      ])
      expect(requests[2].resources).toEqual([slash(recovered.absolute)])
    }).pipe(provide(requests))
  })

  it.live("checks the external directory for a target that is not a sibling", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const requested = yield* access.authorizeRead("README.md", invocation)
      yield* access.authorizeRead("../notes.txt", invocation, { siblingOf: requested })

      expect(requests.map((request) => request.action)).toEqual(["Read", "external_directory", "Read"])
    }).pipe(provide(requests))
  })

  it.live("batches external resources in first-seen order and preserves broader repository saves", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const git = path.join(external.path, "git")
      const hg = path.join(external.path, "hg")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(git, ".git"), { recursive: true })
        await fs.mkdir(path.join(git, "nested"))
        await fs.mkdir(path.join(hg, ".hg"), { recursive: true })
        await fs.mkdir(path.join(hg, "nested"))
      })
      const access = yield* FileAccess.Service
      const first = yield* access.resolve({ path: path.join(git, "nested", "a.txt"), kind: "file" })
      const second = yield* access.resolve({ path: path.join(git, "nested", "b.txt"), kind: "file" })
      const third = yield* access.resolve({ path: path.join(hg, "nested", "c.txt"), kind: "file" })
      const internal = yield* access.resolve({ path: "README.md" })
      const metadata = { filepath: first.absolute, parentDir: path.dirname(first.absolute) }

      yield* access.authorizeExternal([first, internal, second, third, first], invocation, metadata)

      expect(requests).toEqual([
        {
          action: "external_directory",
          resources: [slash(path.join(git, "nested", "*")), slash(path.join(hg, "nested", "*"))],
          save: [slash(path.join(git, "*")), slash(path.join(hg, "*"))],
          metadata,
          sessionID: invocation.sessionID,
          agent: invocation.agent,
          source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
        },
      ])

      yield* access.authorizeExternal([internal], invocation)
      expect(requests).toHaveLength(1)
      yield* access.authorizeExternal([second], invocation)
      expect(requests).toHaveLength(2)
      expect(requests[1].resources).toEqual([slash(path.join(git, "nested", "*"))])
      expect(Object.hasOwn(requests[1], "metadata")).toBe(false)
    }).pipe(provide(requests))
  })
})

// The repository ships its links, and a clone recreates them. Until the project is trusted a link in it that leads out
// does not make its target the project's own: reading or writing through one asks first, as for any file outside, where
// the default rules ask about the folder. A junction stands for the link, since it needs no privilege on Windows.
describe("FileAccess in a project that is not trusted", () => {
  const provideProject = (directory: string, requests: Permission.AssertInput[], trusted: boolean) =>
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node, ProjectTrust.node]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Permission.node.replace(permissionLayer({ assert: (input) => Effect.sync(() => void requests.push(input)) })),
        ...(trusted ? [] : untrustedProjectNodes),
      ]),
    )

  // A project with a file of its own, and a folder inside it that is a link to a folder outside.
  const layout = Effect.gen(function* () {
    const tmp = (yield* tmpdirScoped()).path
    const project = path.join(tmp, "project")
    const outside = path.join(tmp, "outside")
    yield* Effect.promise(async () => {
      await fs.mkdir(project)
      await fs.mkdir(path.join(outside, "sub"), { recursive: true })
      await fs.writeFile(path.join(project, "own.md"), "own")
      await fs.writeFile(path.join(outside, "notes.md"), "outside")
      await fs.symlink(outside, path.join(project, "docs"), "junction")
    })
    return { project, outside }
  })

  it.live(
    "counts a target that a link leads out of the project as outside, with the real folder as the resource",
    () => {
      const requests: Permission.AssertInput[] = []
      return Effect.gen(function* () {
        const { project, outside } = yield* layout
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const trust = yield* ProjectTrust.Service
          const outsideAt = (target: FileAccess.Target, file: string, directory: string, resource: string) => {
            expect(target.absolute).toBe(AbsolutePath.make(path.join(project, ...file.split("/"))))
            // The place the tool acts on, which a request names: where the link leads, not the link.
            expect(target.place).toBe(AbsolutePath.make(path.join(outside, resource)))
            expect(target.resource).toBe(slash(path.join(outside, resource)))
            expect(target.externalDirectory).toMatchObject({
              action: "external_directory",
              directory: path.join(outside, directory),
              resource: slash(path.join(outside, directory, "*")),
              escaped: true,
            })
          }
          const paths = () =>
            Effect.all([
              access.resolve({ path: "own.md" }),
              access.resolve({ path: "docs/notes.md" }),
              // A file that is not there yet, which a write would create beside the others, and one in a folder that is not.
              access.resolve({ path: "docs/new.txt", kind: "file" }),
              access.resolve({ path: "docs/deeper/new.txt", kind: "file" }),
              access.resolve({ path: "docs/sub", kind: "directory" }),
              access.resolve({ path: "docs" }),
            ])

          const untrusted = yield* paths()
          expect(untrusted[0]).toEqual({
            absolute: AbsolutePath.make(path.join(project, "own.md")),
            place: AbsolutePath.make(path.join(project, "own.md")),
            resource: "own.md",
          })
          outsideAt(untrusted[1], "docs/notes.md", ".", "notes.md")
          outsideAt(untrusted[2], "docs/new.txt", ".", "new.txt")
          outsideAt(untrusted[3], "docs/deeper/new.txt", "deeper", path.join("deeper", "new.txt"))
          outsideAt(untrusted[4], "docs/sub", "sub", "sub")
          outsideAt(untrusted[5], "docs", ".", ".")

          // Trusting the project follows links as before, and ending the trust holds them again.
          yield* trust.grant({ persist: false, via: "test" })
          const trusted = yield* paths()
          for (const target of trusted) expect(target.externalDirectory).toBeUndefined()
          for (const target of trusted) expect(target.place).toBe(target.absolute)
          expect(trusted[1].resource).toBe("docs/notes.md")
          yield* trust.revoke()
          expect((yield* paths())[1].externalDirectory).toBeDefined()
        }).pipe(provideProject(project, requests, false))
      })
    },
  )

  // Windows opens `docs.`, `docs ` and the 8.3 name of a link as the link, and a shell or ripgrep given one follows it,
  // while Bun's own `stat` does not find `docs.`. Each spelling is seen as the link, so it is asked about as one.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "sees a link through each Windows spelling of its name",
    () => {
      const requests: Permission.AssertInput[] = []
      return Effect.gen(function* () {
        const { project, outside } = yield* layout
        yield* Effect.promise(() => fs.symlink(outside, path.join(project, "linked folder"), "junction"))
        const short = shortName(project, "linked folder")
        expect(short).toEqual(expect.stringContaining("~"))
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          for (const spelling of [
            "linked folder.",
            "linked folder ",
            "linked folder. ",
            "LINKED FOLDER",
            short!,
            `\\\\?\\${path.join(project, "linked folder")}`,
            "docs.",
          ]) {
            const target = yield* access.resolve({ path: spelling, kind: "directory" })
            expect([spelling, target.place, target.externalDirectory?.escaped]).toEqual([spelling, outside, true])
          }
          for (const spelling of ["linked folder.\\notes.md", `${short}\\notes.md`, "docs.\\notes.md"]) {
            const target = yield* access.resolve({ path: spelling })
            expect([spelling, target.place, target.externalDirectory?.escaped]).toEqual([
              spelling,
              path.join(outside, "notes.md"),
              true,
            ])
          }
        }).pipe(provideProject(project, requests, false))
      })
    },
  )

  // The paths a shell command names in its text: only one that a link leads out of the project counts, and nothing about
  // the others is asked or refused, a path outside by name included.
  it.live("names only the paths of a command that a link leads out of the project", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const { project, outside } = yield* layout
      const files = [
        path.join(project, "own.md"),
        path.join(project, "docs", "notes.md"),
        path.join(project, "docs", "new.txt"),
        path.join(outside, "notes.md"),
        path.join(project, "https:", "evil.example"),
      ]
      const escaped = Effect.gen(function* () {
        const access = yield* FileAccess.Service
        return yield* access.escaped(files)
      })
      const untrusted = yield* escaped.pipe(provideProject(project, requests, false))
      expect(untrusted.map((target) => ({ place: target.place, escaped: target.externalDirectory?.escaped }))).toEqual([
        { place: AbsolutePath.make(path.join(outside, "notes.md")), escaped: true },
        { place: AbsolutePath.make(path.join(outside, "new.txt")), escaped: true },
      ])
      const trusted = yield* escaped.pipe(provideProject(project, requests, true))
      expect(trusted).toEqual([])
      expect(requests).toEqual([])
    })
  })

  it.live("asks about the outside folder before a read through a link, and not once the project is trusted", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const { project, outside } = yield* layout
      yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        yield* access.authorizeRead("docs/notes.md", invocation)
        // The folder is marked as one a link leads to, so Orbit's own allows do not decide it (Permission).
        expect(requests).toMatchObject([
          {
            action: "external_directory",
            resources: [slash(path.join(outside, "*"))],
            escaped: [slash(path.join(outside, "*"))],
          },
          { action: "Read", resources: [slash(path.join(outside, "notes.md"))] },
        ])

        yield* access.authorizeExternal([yield* access.resolve({ path: "docs/new.txt", kind: "file" })], invocation)
        expect(requests.at(-1)).toMatchObject({
          action: "external_directory",
          resources: [slash(path.join(outside, "*"))],
          escaped: [slash(path.join(outside, "*"))],
        })

        // The same folder named directly and through the link in one call is still the link's.
        requests.length = 0
        yield* access.authorizeExternal(
          [
            yield* access.resolve({ path: path.join(outside, "notes.md"), kind: "file" }),
            yield* access.resolve({ path: "docs/notes.md", kind: "file" }),
          ],
          invocation,
        )
        expect(requests).toMatchObject([
          { resources: [slash(path.join(outside, "*"))], escaped: [slash(path.join(outside, "*"))] },
        ])
        // A folder named directly carries no mark.
        requests.length = 0
        yield* access.authorizeExternal(
          [yield* access.resolve({ path: path.join(outside, "notes.md"), kind: "file" })],
          invocation,
        )
        expect(requests).toHaveLength(1)
        expect(requests[0]).not.toHaveProperty("escaped")
      }).pipe(provideProject(project, requests, false))

      requests.length = 0
      yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        yield* access.authorizeRead("docs/notes.md", invocation)
        yield* access.authorizeExternal([yield* access.resolve({ path: "docs/new.txt", kind: "file" })], invocation)
        expect(requests).toMatchObject([{ action: "Read", resources: ["docs/notes.md"] }])
      }).pipe(provideProject(project, requests, true))
    })
  })
})
