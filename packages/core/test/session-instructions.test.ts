import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { DateTime, Deferred, Effect, Layer, Logger } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Agent } from "@orbit/core/agent"
import { FileLedger } from "@orbit/core/file-ledger"
import { Environment } from "@orbit/core/environment/index"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { Bus } from "@orbit/core/bus"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Model } from "@orbit/core/model"
import { Permission } from "@orbit/core/permission"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Provider } from "@orbit/core/provider"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInstructions } from "@orbit/core/session/instructions"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { Session } from "@orbit/core/session"
import { toLLMMessages } from "@orbit/core/session/runner/to-llm-message"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Tool } from "@orbit/core/tool"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Document, Info } from "@orbit/schema/config"
import { scriptedMarkdown } from "./fixture/front-matter"
import { location, tempLocationLayer } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/read-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileLedger.node,
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
  ],
})

const asserted: Permission.AssertInput[] = []
const permission = permissionLayer({ assert: (input) => Effect.sync(() => void asserted.push(input)) })

// Every folder is trusted, as the core tests run, unless `trusted` is false.
const sessionLayer = (
  config: ReturnType<typeof Config.testLayer>,
  trusted = true,
  filesystem?: Layer.Layer<FSUtil.Service>,
  // The home folder is the project: a Location in a folder below it, as a downloaded folder is.
  place?: { readonly home: string; readonly directory: string },
) => {
  const imageLayer = AppNodeBuilder.build(Image.node, [Config.node.replace(config)])
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Location.node,
      FSUtil.node,
      FileAccess.node,
      ReadToolFileSystem.node,
      readToolNode,
      FileLedger.node,
      Tool.node,
      PluginHooks.node,
      ProjectTrust.node,
      SessionInstructions.node,
      Global.node,
      Image.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(
        place
          ? Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make(place.directory) }, { projectDirectory: AbsolutePath.make(place.home) }),
              ),
            )
          : tempLocationLayer,
      ),
      ...(place ? [Global.node.replace(Global.layerWith({ home: place.home }))] : []),
      Permission.node.replace(permission),
      Config.node.replace(config),
      Image.node.replace(imageLayer),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: trusted })),
      ...(filesystem ? [FSUtil.node.replace(filesystem)] : []),
    ],
  )
}

// Compatibility is on by default; the second harness switches it off. The third is in a project that is not trusted.
const it = testEffect(sessionLayer(Config.testLayer()))
const compatOff = testEffect(sessionLayer(Config.testLayer([], { enabled: false, roots: [] })))
const untrusted = testEffect(sessionLayer(Config.testLayer(), false))

const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_nearby"),
}
const readCall = (
  sessionID: Session.ID,
  id: string,
  readPath: string,
  page: ReadToolFileSystem.PageInput = {},
): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name: "Read", input: { file_path: readPath, ...page } },
})

const writeAgents = (file: string, content: string) => Effect.promise(() => fs.writeFile(file, content))
const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const synthetics = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return (yield* store.context(sessionID)).filter((message) => message.type === "synthetic")
  })

// Seed a prior synthetic message with an instruction dedup ledger, simulating a prior turn
// after the Location layer was reopened (in-memory set empty).
const seedSynthetic = (sessionID: Session.ID, paths: string[]) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Synthetic, {
      sessionID,
      text: `Instructions from: ${paths[0]}\nprior`,
      description: `Loaded ${paths[0]}`,
      metadata: { instruction: { paths } },
    })
  })

// A package with the reference vendor's instruction file, and one with a native file beside it.
const nestedVendorFixture = Effect.gen(function* () {
  const location = yield* Location.Service
  const dir = location.directory
  const vendorPath = path.resolve(dir, "vendor", CompatNames.vendor.instructions)
  const nativePath = path.resolve(dir, "native", "AGENTS.md")
  yield* mkdir(path.resolve(dir, "vendor"))
  yield* mkdir(path.resolve(dir, "native"))
  yield* writeAgents(vendorPath, "vendor-instructions")
  yield* writeAgents(nativePath, "native-instructions")
  yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "vendor", "file.txt"), "content"))
  yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "native", "file.txt"), "content"))
  const session = yield* Session.Service
  const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id
  return { dir, sessionID, vendorPath, nativePath }
})

describe("SessionInstructions", () => {
  it.live("injects the reference vendor's instruction file above a read while compatibility is on", () =>
    Effect.gen(function* () {
      const fixture = yield* nestedVendorFixture
      const registry = yield* Tool.Service

      yield* executeTool(registry, readCall(fixture.sessionID, "call-vendor", "vendor/file.txt"))

      const injected = yield* synthetics(fixture.sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${fixture.vendorPath}\nvendor-instructions`)
    }),
  )

  compatOff.live("ignores the reference vendor's instruction file above a read when compatibility is off", () =>
    Effect.gen(function* () {
      const fixture = yield* nestedVendorFixture
      const registry = yield* Tool.Service

      yield* executeTool(registry, readCall(fixture.sessionID, "call-vendor", "vendor/file.txt"))
      expect(yield* synthetics(fixture.sessionID)).toHaveLength(0)

      // The native files still load.
      yield* executeTool(registry, readCall(fixture.sessionID, "call-native", "native/file.txt"))
      const injected = yield* synthetics(fixture.sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${fixture.nativePath}\nnative-instructions`)
    }),
  )

  it.live("injects AGENTS.md files above a read, excludes the Location root, and dedups across reads", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      const deepPath = path.resolve(dir, "sub", "deep", "AGENTS.md")
      const otherPath = path.resolve(dir, "sub", "other", "AGENTS.md")
      yield* mkdir(path.dirname(deepPath))
      yield* mkdir(path.dirname(otherPath))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* writeAgents(deepPath, "deep-instructions")
      yield* writeAgents(otherPath, "other-instructions\nmore rules")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "deep", "file.txt"), "file content"))
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "other", "file2.txt"), "file content 2"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // A read deep under sub/ discovers deep and sub AGENTS.md, walking up to but
      // excluding the Location root (already supplied by core initial instructions).
      yield* executeTool(registry, readCall(sessionID, "call-deep", "sub/deep/file.txt"))

      const firstInjected = yield* synthetics(sessionID)
      expect(firstInjected).toHaveLength(1)
      expect(firstInjected[0]!.text).toBe(
        `Instructions from: ${deepPath}\ndeep-instructions\n\nInstructions from: ${subPath}\nsub-instructions`,
      )
      expect(firstInjected[0]!.description).toBe(
        `Loaded ${path.relative(dir, deepPath)}, ${path.relative(dir, subPath)}`,
      )
      // The synthetic's metadata carries the durable dedup ledger.
      expect(firstInjected[0]!.metadata).toEqual({ instruction: { paths: [deepPath, subPath] } })
      expect(firstInjected[0]!.text).not.toContain("root-instructions")

      // Neither a full nor a partial read adds an automatic copy of the file itself.
      const read = yield* executeTool(registry, readCall(sessionID, "call-direct", "sub/other/AGENTS.md"))
      expect(read.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("more rules") })
      const partial = yield* executeTool(
        registry,
        readCall(sessionID, "call-partial", "sub/other/AGENTS.md", { limit: 1 }),
      )
      expect(partial.metadata).toEqual({ truncated: true })
      expect(yield* synthetics(sessionID)).toHaveLength(1)

      // A sibling read under sub/other discovers only the new AGENTS.md; sub is already
      // injected for this session so it is not re-emitted, and the root is still excluded.
      yield* executeTool(registry, readCall(sessionID, "call-other", "sub/other/file2.txt"))

      const secondInjected = yield* synthetics(sessionID)
      expect(secondInjected).toHaveLength(2)
      expect(secondInjected[1]!.text).toBe(`Instructions from: ${otherPath}\nother-instructions\nmore rules`)
      expect(secondInjected[1]!.description).toBe(`Loaded ${path.relative(dir, otherPath)}`)
      expect(secondInjected[1]!.metadata).toEqual({ instruction: { paths: [otherPath] } })
      expect(secondInjected.some((message) => message.text.includes("root-instructions"))).toBe(false)
    }),
  )

  it.live("does not re-inject paths already recorded in durable session history", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // Seed the durable history with a prior synthetic that already claims sub's AGENTS.md
      // via the instruction metadata ledger.
      yield* seedSynthetic(sessionID, [subPath])
      expect(yield* synthetics(sessionID)).toHaveLength(1)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      // The durable claim on the prior synthetic prevents re-injection; no new synthetic.
      expect(yield* synthetics(sessionID)).toHaveLength(1)
    }),
  )

  it.live(
    "discovers AGENTS.md on a directory listing, including the listed directory's own, and dedups with a later file read",
    () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const dir = location.directory
        const rootPath = path.resolve(dir, "AGENTS.md")
        const pkgPath = path.resolve(dir, "packages", "foo", "AGENTS.md")
        yield* mkdir(path.resolve(dir, "packages", "foo"))
        yield* writeAgents(rootPath, "root-instructions")
        yield* writeAgents(pkgPath, "pkg-instructions")
        yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "packages", "foo", "file.txt"), "content"))

        const session = yield* Session.Service
        const registry = yield* Tool.Service
        const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

        // Listing packages/foo/ discovers its own AGENTS.md, walking up to but excluding
        // the Location root (already supplied by core initial instructions).
        yield* executeTool(registry, readCall(sessionID, "call-list", "packages/foo"))

        const firstInjected = yield* synthetics(sessionID)
        expect(firstInjected).toHaveLength(1)
        expect(firstInjected[0]!.text).toBe(`Instructions from: ${pkgPath}\npkg-instructions`)
        expect(firstInjected[0]!.description).toBe(`Loaded ${path.relative(dir, pkgPath)}`)
        expect(firstInjected[0]!.metadata).toEqual({ instruction: { paths: [pkgPath] } })
        expect(firstInjected[0]!.text).not.toContain("root-instructions")

        // A subsequent file read under the listed directory is a dedup: pkg's AGENTS.md is
        // already injected for this session, so nothing new is emitted.
        yield* executeTool(registry, readCall(sessionID, "call-file", "packages/foo/file.txt"))

        expect(yield* synthetics(sessionID)).toHaveLength(1)
      }),
  )

  it.live("re-injects nested instructions dropped from history by compaction", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(path.resolve(dir, "AGENTS.md"), "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* executeTool(registry, readCall(sessionID, "call-before", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(1)

      // A completed compaction truncates model-visible history at its boundary, dropping
      // the synthetic that carried sub's instructions.
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary", recent: "" })
      expect(yield* synthetics(sessionID)).toHaveLength(0)

      // The model no longer has the rules, so the next read under the subtree must
      // re-inject them rather than trusting a stale in-memory claim.
      yield* executeTool(registry, readCall(sessionID, "call-after", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(1)
    }),
  )

  it.live("listing the Location root directory injects no instructions", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // The walk starts and stops at the Location root: the root AGENTS.md is searched but
      // dropped by the dirname filter, and up() only walks upward so nested dirs are unseen.
      yield* executeTool(registry, readCall(sessionID, "call-root-list", "."))

      expect(yield* synthetics(sessionID)).toHaveLength(0)
    }),
  )

  it.live("loads instructions directly without a read", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(subPath, "sub-instructions")

      const session = yield* Session.Service
      const sessionInstructions = yield* SessionInstructions.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* sessionInstructions.load({ sessionID, paths: [subPath] })

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${subPath}\nsub-instructions`)
      expect(injected[0]!.description).toBe(`Loaded ${path.relative(dir, subPath)}`)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath] } })
    }),
  )

  test("toLLMMessages does not forward synthetic metadata to the provider", () => {
    const created = DateTime.makeUnsafe(0)
    const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
    const synthetic = SessionMessage.Synthetic.make({
      id: SessionMessage.ID.make("msg_synthetic"),
      type: "synthetic",
      text: "Instructions from: /repo/sub/AGENTS.md\ncontent",
      description: "Loaded /repo/sub/AGENTS.md",
      metadata: { instruction: { paths: ["/repo/sub/AGENTS.md"] } },
      time: { created },
    })
    const messages = toLLMMessages([synthetic], model)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("user")
    expect(messages[0]!.content).toEqual([{ type: "text", text: "Instructions from: /repo/sub/AGENTS.md\ncontent" }])
    // Metadata is bookkeeping for the dedup ledger; the model must not see it.
    expect(messages[0]!.metadata).toBeUndefined()
  })
})

// A project that is not trusted yet supplies only what is inside it. A clone recreates the links a repository ships, so
// one can lead the walk for instruction files out of the project, or be named like an instruction file itself.
describe("SessionInstructions in a project that is not trusted", () => {
  const skippedNotices = () => {
    const skipped: Array<{ path: unknown; reason: unknown }> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "instruction file skipped") return
      skipped.push(entry.message[1])
    })
    return { skipped, logger: Logger.layer([logger]) }
  }

  untrusted.live("does not inject an instruction file that a link in the project leads to, before or after it is trusted", () => {
    const { skipped, logger } = skippedNotices()
    return Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const outside = (yield* tmpdirScoped()).path
      const outsideFile = path.resolve(outside, "AGENTS.md")
      yield* writeAgents(outsideFile, "outside-instructions")
      yield* Effect.promise(async () => {
        await fs.writeFile(path.resolve(outside, "file.txt"), "content")
        // A junction reads as a symlink to a directory, and needs no privilege on Windows.
        await fs.symlink(outside, path.resolve(dir, "linked"), "junction")
      })

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const trust = yield* ProjectTrust.Service
      const instructions = yield* SessionInstructions.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // A read through the link is outside the project, so it asks about the folder first, and the walk for instruction
      // files does not start from it: external reads are skipped.
      asserted.length = 0
      yield* executeTool(registry, readCall(sessionID, "call-linked", "linked/file.txt"))
      yield* executeTool(registry, readCall(sessionID, "call-again", "linked/file.txt"))
      expect(asserted.map((input) => input.action)).toEqual([
        "external_directory",
        "Read",
        "external_directory",
        "Read",
      ])
      expect(asserted[0]).toMatchObject({ resources: [path.join(outside, "*").replaceAll("\\", "/")] })
      expect(yield* synthetics(sessionID)).toHaveLength(0)
      expect(skipped).toEqual([])

      // What that walk would hand over, were the read inside the project, is left out. The file is reported once, however
      // often the model's reads find it.
      yield* instructions.load({ sessionID, paths: [outsideFile] })
      yield* instructions.load({ sessionID, paths: [outsideFile] })
      expect(yield* synthetics(sessionID)).toHaveLength(0)
      expect(skipped).toMatchObject([{ path: outsideFile, reason: expect.stringContaining("not trusted") }])

      // The grant changes what is asked, not what is injected.
      yield* trust.grant({ persist: false, via: "test" })
      asserted.length = 0
      yield* executeTool(registry, readCall(sessionID, "call-trusted", "linked/file.txt"))
      // The link is the project's own now, but the folder it leads to is still asked about, as the shell asks.
      expect(asserted.map((input) => input.action)).toEqual(["external_directory", "Read"])
      // Like a read of that folder by its own name, it is outside the project, so the walk for instruction files does not
      // start from it: nothing is injected, and the file stays out in a trusted project as in one that is not trusted.
      expect(yield* synthetics(sessionID)).toHaveLength(0)
    }).pipe(Effect.provide(logger))
  })

  const linked = canLinkFile ? untrusted.live : untrusted.live.skip
  linked("does not inject a file that an instruction file is a symlink to, until the project is trusted", () => {
    const { skipped, logger } = skippedNotices()
    return Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const outside = (yield* tmpdirScoped()).path
      const secret = path.resolve(outside, "secret.txt")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(secret, "TOP SECRET")
      yield* Effect.promise(async () => {
        await fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content")
        await fs.symlink(secret, subPath)
      })

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const trust = yield* ProjectTrust.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(0)
      expect(skipped).toMatchObject([{ path: secret }])

      yield* trust.grant({ persist: false, via: "test" })
      yield* executeTool(registry, readCall(sessionID, "call-trusted", "sub/file.txt"))
      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${secret}\nTOP SECRET`)
    }).pipe(Effect.provide(logger))
  })

  untrusted.live("still injects the instruction files that the project holds itself", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(subPath, "sub-instructions")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${subPath}\nsub-instructions`)
    }),
  )
})

// A nested file that the model's reads find goes through the same processing as the files that a session starts with
// (`ConfigInstructionFile`), and is left out by the same `instructions_exclude`.
const excluding = (patterns: string[], scope: "user" | "project" = "user") =>
  new Document({ type: "document", scope, info: new Info({ instructions_exclude: patterns }) })

// A folder with a nested instruction file, and a file to read in it.
const nested = (directory: string, name: string, text: string, folder = "sub") =>
  Effect.gen(function* () {
    const file = path.resolve(directory, folder, name)
    yield* mkdir(path.resolve(directory, folder))
    yield* writeAgents(file, text)
    yield* Effect.promise(() => fs.writeFile(path.resolve(directory, folder, "file.txt"), "content"))
    return file
  })

const sessionIn = (directory: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return (yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(directory) }) })).id
  })

const excludesSub = Config.testLayer([excluding(["**/excluded/**", "**/sub/ORBIT.md"])])
// The same harness with the settings in hand, to change them between two reads.
const excluded = testEffect(Layer.mergeAll(sessionLayer(excludesSub), excludesSub))

// The files that the file system was asked to read, for the harness that watches them.
const reads: string[] = []
const recordingFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({ ...fs, readFileStringSafe: (target) => (reads.push(target), fs.readFileStringSafe(target)) }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const watched = testEffect(sessionLayer(Config.testLayer([excluding(["**/excluded/**"])]), true, recordingFS))

describe("SessionInstructions processes what it injects", () => {
  it.live("injects a nested file without its comments and front matter", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(
        dir,
        "AGENTS.md",
        "---\ntitle: x\n---\n<!-- private note -->\n\n# Sub rules\n\nUse tabs.\n<!-- tail -->\n",
      )
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${subPath}\n# Sub rules\n\nUse tabs.\n`)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath] } })
    }),
  )

  it.live("injects nothing for a nested file that holds only comments or front matter, and looks at it again later", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(dir, "AGENTS.md", "---\ntitle: x\n---\n<!-- nothing yet -->\n")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-before", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(0)

      // Nothing was recorded for it, so a later read finds it again once it has something to say.
      yield* writeAgents(subPath, "# Now it does\n")
      yield* executeTool(registry, readCall(sessionID, "call-after", "sub/file.txt"))
      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${subPath}\n# Now it does\n`)
    }),
  )

  it.live("sends a large nested file whole, and flags nothing", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const large = `# Rules\n${"x".repeat(40_000)}\n`
      const subPath = yield* nested(dir, "AGENTS.md", large)
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-large", "sub/file.txt"))
      expect((yield* synthetics(sessionID))[0]!.text).toBe(`Instructions from: ${subPath}\n${large}`)
    }),
  )

  // The model's own reads decide when an instruction file is injected, and that must never count as a read of the file:
  // the edit tools ask the ledger, and a file whose comments were taken off the copy must be read for real before it changes.
  it.live("does not count the injection as a read of the file, so that changing it still needs a real read", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(dir, "AGENTS.md", "# Rules\n<!-- hidden from the model -->\nUse tabs.\n")
      const registry = yield* Tool.Service
      const ledger = yield* FileLedger.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))
      expect((yield* synthetics(sessionID))[0]!.text).toBe(`Instructions from: ${subPath}\n# Rules\nUse tabs.\n`)

      const failure = yield* ledger.assertFresh(sessionID, subPath, "sub/AGENTS.md").pipe(Effect.flip)
      expect(failure.code).toBe("file.unread")
      expect(failure.message).toContain("has not been read in this session")

      // The control: a real read of the file is what makes it fresh.
      yield* executeTool(registry, readCall(sessionID, "call-direct", "sub/AGENTS.md"))
      yield* ledger.assertFresh(sessionID, subPath, "sub/AGENTS.md")
    }),
  )

  // A nested file is a reader of front matter too: it is never evaluated, and a language after the opening dashes makes
  // the text plain, as the reference keeps it.
  for (const language of ["js", "javascript", "JS", "JavaScript", " js", "coffee"])
    it.live(`injects front matter that opens with ---${language} as text, and runs nothing`, () =>
      Effect.gen(function* () {
        const dir = (yield* Location.Service).directory
        const marker = path.resolve(dir, "ran")
        const text = scriptedMarkdown(marker, language)
        const subPath = yield* nested(dir, "AGENTS.md", text)
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))
        expect((yield* synthetics(sessionID))[0]!.text).toBe(`Instructions from: ${subPath}\n${text}`)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    )

  it.live("removes a bare block that a script fills, with CRLF line endings, and runs nothing", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const marker = path.resolve(dir, "ran")
      const script = `{ description: (require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), "x") }`
      const subPath = yield* nested(dir, "AGENTS.md", `---\r\n${script}\r\n---\r\nRules.\r\n`)
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))
      expect((yield* synthetics(sessionID))[0]!.text).toBe(`Instructions from: ${subPath}\nRules.\r\n`)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )
})

describe("SessionInstructions applies instructions_exclude", () => {
  excluded.live("injects nothing for an excluded nested file, records nothing, and reads it again once it is allowed", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(dir, "AGENTS.md", "excluded rules", "excluded")
      const registry = yield* Tool.Service
      const settings = yield* Config.Test
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-before", "excluded/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(0)

      yield* settings.setEntries([])
      yield* executeTool(registry, readCall(sessionID, "call-after", "excluded/file.txt"))
      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath] } })
    }),
  )

  watched.live("never opens an excluded nested file", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const excludedPath = yield* nested(dir, "AGENTS.md", "excluded rules", "excluded")
      const allowedPath = yield* nested(dir, "AGENTS.md", "allowed rules", "allowed")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)
      reads.length = 0

      yield* executeTool(registry, readCall(sessionID, "call-excluded", "excluded/file.txt"))
      yield* executeTool(registry, readCall(sessionID, "call-allowed", "allowed/file.txt"))

      expect((yield* synthetics(sessionID)).map((message) => message.text)).toEqual([
        `Instructions from: ${allowedPath}\nallowed rules`,
      ])
      // The control: the file that is not excluded was opened.
      expect(reads).toContain(allowedPath)
      expect(reads).not.toContain(excludedPath)
    }),
  )

  watched.live("never opens an excluded path that it is given", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const excludedPath = yield* nested(dir, "AGENTS.md", "excluded rules", "excluded")
      const allowedPath = yield* nested(dir, "AGENTS.md", "allowed rules", "allowed")
      const instructions = yield* SessionInstructions.Service
      const sessionID = yield* sessionIn(dir)
      reads.length = 0

      yield* instructions.load({ sessionID, paths: [excludedPath, allowedPath] })

      expect((yield* synthetics(sessionID)).map((message) => message.text)).toEqual([
        `Instructions from: ${allowedPath}\nallowed rules`,
      ])
      expect(reads).toContain(allowedPath)
      expect(reads).not.toContain(excludedPath)
    }),
  )

  excluded.live("asks again for every path it is given, so that no caller loads a file the settings exclude", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const excludedPath = yield* nested(dir, "AGENTS.md", "excluded rules", "excluded")
      const allowedPath = yield* nested(dir, "AGENTS.md", "allowed rules", "allowed")
      const instructions = yield* SessionInstructions.Service
      const sessionID = yield* sessionIn(dir)

      yield* instructions.load({ sessionID, paths: [excludedPath, allowedPath] })

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${allowedPath}\nallowed rules`)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [allowedPath] } })
    }),
  )

  excluded.live("hands a folder to its next name when the first is excluded, as the session start does", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      yield* nested(dir, "ORBIT.md", "orbit rules")
      const agentsPath = yield* nested(dir, "AGENTS.md", "agents rules")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${agentsPath}\nagents rules`)
    }),
  )

  // The settings are read as the config stamped them: the document of a project that is not trusted has lost its list, and
  // the same document in a project that is trusted keeps it.
  const projectDocument = (info: Info) =>
    new Document({ type: "document", scope: "project", path: AbsolutePath.make(path.resolve("/repo/orbit.json")), info })
  const listed = new Info({ instructions_exclude: ["**/sub/**"] })
  const place = { roots: [path.resolve("/repo")], directory: path.resolve("/repo") }
  const stamped = ConfigTrust.stamp(projectDocument(listed), place)
  const projectList = testEffect(sessionLayer(Config.testLayer([projectDocument(listed)])))
  const withheld = testEffect(sessionLayer(Config.testLayer([stamped])))

  for (const [harness, name, injects] of [
    [projectList, "a project that is trusted", false],
    [withheld, "a project that is not trusted, whose list was withheld", true],
  ] as const)
    harness.live(`${injects ? "injects" : "leaves out"} the nested file that the list of ${name} names`, () =>
      Effect.gen(function* () {
        expect(stamped).toMatchObject({ trusted: false, withheld: ["settings"] })
        expect(stamped.type === "document" && stamped.info.instructions_exclude).toBeUndefined()
        const dir = (yield* Location.Service).directory
        const subPath = yield* nested(dir, "AGENTS.md", "sub rules")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

        const injected = yield* synthetics(sessionID)
        expect(injected.map((message) => message.text)).toEqual(injects ? [`Instructions from: ${subPath}\nsub rules`] : [])
      }),
    )
})

describe("SessionInstructions follows @imports in the files it injects", () => {
  const slashed = (value: string) => value.replaceAll("\\", "/")

  it.live("injects the imports of a nested file after it, and records every path in the ledger", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(dir, "AGENTS.md", "sub rules @./more.md")
      const morePath = path.resolve(dir, "sub", "more.md")
      const deeperPath = path.resolve(dir, "sub", "deeper.md")
      yield* writeAgents(morePath, "more rules @./deeper.md")
      yield* writeAgents(deeperPath, "deeper rules")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(
        [
          `Instructions from: ${subPath}\nsub rules @./more.md`,
          `Instructions from: ${morePath}\nmore rules @./deeper.md`,
          `Instructions from: ${deeperPath}\ndeeper rules`,
        ].join("\n\n"),
      )
      expect(injected[0]!.description).toBe(
        `Loaded ${[subPath, morePath, deeperPath].map((file) => path.relative(dir, file)).join(", ")}`,
      )
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath, morePath, deeperPath] } })
    }),
  )

  // A file that the model's read loads never imports from outside the project, even when the project is trusted: only the
  // files found at the start do (`ProjectTrust.outward`).
  it.live("does not inject an import from outside the project that a nested file names, in a project that is trusted", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const outside = path.join((yield* tmpdirScoped()).path, "outside.md")
      yield* writeAgents(outside, "OUTSIDE MARKER")
      const subPath = yield* nested(dir, "AGENTS.md", `sub rules @${slashed(outside)} @./more.md`)
      const morePath = path.resolve(dir, "sub", "more.md")
      yield* writeAgents(morePath, "more rules")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath, morePath] } })
      expect(injected[0]!.text).not.toContain("OUTSIDE MARKER")
    }),
  )

  it.live("injects a file that two nested files import once, and again after compaction drops it", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const first = yield* nested(dir, "AGENTS.md", "first @../shared.md", "first")
      const second = yield* nested(dir, "AGENTS.md", "second @../shared.md", "second")
      const sharedPath = path.resolve(dir, "shared.md")
      yield* writeAgents(sharedPath, "shared rules")
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const sessionID = yield* sessionIn(dir)

      yield* executeTool(registry, readCall(sessionID, "call-first", "first/file.txt"))
      yield* executeTool(registry, readCall(sessionID, "call-second", "second/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected.map((message) => message.text)).toEqual([
        `Instructions from: ${first}\nfirst @../shared.md\n\nInstructions from: ${sharedPath}\nshared rules`,
        `Instructions from: ${second}\nsecond @../shared.md`,
      ])
      expect(injected[1]!.metadata).toEqual({ instruction: { paths: [second] } })

      // The model no longer has the rules once the synthetic that carried them goes, so the next read puts them back.
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary", recent: "" })
      yield* executeTool(registry, readCall(sessionID, "call-again", "second/file.txt"))
      expect((yield* synthetics(sessionID)).map((message) => message.text)).toEqual([
        `Instructions from: ${second}\nsecond @../shared.md\n\nInstructions from: ${sharedPath}\nshared rules`,
      ])
    }),
  )

  // A file system that holds the first read of the shared file until a second read of it starts or the other load has
  // finished. With the claim made before the read, the other load finishes without reading it; without the claim both
  // reads happen before either load has committed anything, so the file is injected twice, on every run.
  const gate: { shared?: string; finished?: Deferred.Deferred<void> } = {}
  const gated = testEffect(
    sessionLayer(
      Config.testLayer(),
      true,
      Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const base = yield* FSUtil.Service
          const second = yield* Deferred.make<void>()
          let reads = 0
          const is = (target: string, wanted?: string) => wanted !== undefined && path.resolve(target) === path.resolve(wanted)
          return FSUtil.Service.of({
            ...base,
            readFileStringSafe: (target) =>
              Effect.gen(function* () {
                if (!is(target, gate.shared)) return yield* base.readFileStringSafe(target)
                reads += 1
                if (reads === 2) yield* Deferred.succeed(second, undefined)
                if (reads === 1 && gate.finished) yield* Effect.raceFirst(Deferred.await(second), Deferred.await(gate.finished))
                return yield* base.readFileStringSafe(target)
              }),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
    ),
  )

  gated.live("injects an import once when two loads that share it run together", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const first = yield* nested(dir, "AGENTS.md", "first @../shared.md", "first")
      const second = yield* nested(dir, "AGENTS.md", "second @../shared.md", "second")
      const sharedPath = path.resolve(dir, "shared.md")
      yield* writeAgents(sharedPath, "shared rules")
      const finished = yield* Deferred.make<void>()
      Object.assign(gate, { shared: sharedPath, finished })
      const instructions = yield* SessionInstructions.Service
      const sessionID = yield* sessionIn(dir)

      yield* Effect.all(
        [
          instructions.load({ sessionID, paths: [first] }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
          instructions.load({ sessionID, paths: [second] }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
        ],
        { concurrency: 2 },
      )

      const text = (yield* synthetics(sessionID)).map((message) => message.text).join("\n")
      expect(text.split("shared rules")).toHaveLength(2)
      expect(text).toContain(`Instructions from: ${first}`)
      expect(text).toContain(`Instructions from: ${second}`)
    }),
  )

  const linked = canLinkFile ? it.live : it.live.skip
  for (const [harness, name] of [
    [it, "a project that is trusted"],
    [untrusted, "a project that is not trusted"],
  ] as const) {
    harness.live(`skips an import that leaves the project, in ${name}, and still injects the one inside`, () =>
      Effect.gen(function* () {
        const dir = (yield* Location.Service).directory
        const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.md`)
        yield* writeAgents(outside, "OUTSIDE MARKER")
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { force: true })))
        const subPath = yield* nested(dir, "AGENTS.md", `sub @./inside.md @${slashed(outside)} @../../${path.basename(outside)}`)
        const insidePath = path.resolve(dir, "sub", "inside.md")
        yield* writeAgents(insidePath, "INSIDE MARKER")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

        const injected = yield* synthetics(sessionID)
        expect(injected).toHaveLength(1)
        expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath, insidePath] } })
        expect(injected[0]!.text).toContain("INSIDE MARKER")
        expect(injected[0]!.text).not.toContain("OUTSIDE MARKER")
      }),
    )

    ;(canLinkFile ? harness.live : harness.live.skip)(`skips an import that is a link out of the project, in ${name}`, () =>
      Effect.gen(function* () {
        const dir = (yield* Location.Service).directory
        const outside = path.join(path.dirname(dir), `secret-${path.basename(dir)}.txt`)
        yield* writeAgents(outside, "TOP SECRET MARKER")
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { force: true })))
        const subPath = yield* nested(dir, "AGENTS.md", "sub @./notes.md @./inside.md")
        yield* Effect.promise(() => fs.symlink(outside, path.resolve(dir, "sub", "notes.md")))
        yield* writeAgents(path.resolve(dir, "sub", "inside.md"), "INSIDE MARKER")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

        const text = (yield* synthetics(sessionID)).map((message) => message.text).join("\n")
        expect(text).toContain(`Instructions from: ${subPath}`)
        expect(text).toContain("INSIDE MARKER")
        expect(text).not.toContain("TOP SECRET MARKER")
      }),
    )
  }

  watched.live("never opens an import that instructions_exclude names", () =>
    Effect.gen(function* () {
      const dir = (yield* Location.Service).directory
      const subPath = yield* nested(dir, "AGENTS.md", "sub @./excluded/skip.md @./allowed.md")
      yield* mkdir(path.resolve(dir, "sub", "excluded"))
      const skipPath = path.resolve(dir, "sub", "excluded", "skip.md")
      const allowedPath = path.resolve(dir, "sub", "allowed.md")
      yield* writeAgents(skipPath, "SKIPPED")
      yield* writeAgents(allowedPath, "allowed rules")
      const registry = yield* Tool.Service
      const sessionID = yield* sessionIn(dir)
      reads.length = 0

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      const injected = yield* synthetics(sessionID)
      expect(injected.map((message) => message.metadata)).toEqual([{ instruction: { paths: [subPath, allowedPath] } }])
      expect(reads).not.toContain(skipPath)
    }),
  )
})

// A repository at the home folder is the project of every folder below it that has no repository of its own, and the home
// folder is never trusted. What an import may reach is then the folder the session started in, and no more.
describe("SessionInstructions keeps a project at the home folder from opening the home folder to an import", () => {
  // Home is never trusted implicitly, so a row that wants it trusted grants it for the session, and says so first.
  const harness = (place: (home: string) => { home: string; directory: string }) =>
    testEffect(
      Layer.unwrap(
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ).pipe(
          Effect.map((tmp) =>
            sessionLayer(Config.testLayer(), false, undefined, place(tmp.path)),
          ),
        ),
      ),
    )

  const settle = (granted: boolean) =>
    Effect.gen(function* () {
      const trust = yield* ProjectTrust.Service
      if (granted) yield* trust.grant({ persist: false, via: "test" })
      expect(yield* trust.trusted()).toBe(granted)
    })

  for (const [name, granted] of [
    ["trusted for the session", true],
    ["not trusted", false],
  ] as const) {
    const home = harness((root) => ({ home: root, directory: path.join(root, "Downloads", "x") }))
    const slashed = (value: string) => value.replaceAll("\\", "/")

    home.live(`sends no home file named by ~, by .. or by an absolute path, and sends the one beside it, in a project that is ${name}`, () =>
      Effect.gen(function* () {
        yield* settle(granted)
        const dir = (yield* Location.Service).directory
        const folder = (yield* Global.Service).home
        const key = path.join(folder, ".ssh", "id_rsa")
        yield* mkdir(path.dirname(key))
        yield* writeAgents(key, "PRIVATE KEY MARKER")
        const subPath = yield* nested(
          dir,
          "AGENTS.md",
          [
            "@~/.ssh/id_rsa",
            `@${slashed(path.relative(path.join(dir, "sub"), key))}`,
            `@${slashed(key)}`,
            "@./notes.md",
          ].join("\n"),
        )
        const notes = path.resolve(dir, "sub", "notes.md")
        yield* writeAgents(notes, "NOTES MARKER")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

        const injected = yield* synthetics(sessionID)
        expect(injected).toHaveLength(1)
        expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath, notes] } })
        expect(injected[0]!.text).toContain("NOTES MARKER")
        expect(injected[0]!.text).not.toContain("PRIVATE KEY MARKER")
      }),
    )

    ;(canLinkFile ? home.live : home.live.skip)(`sends no home file that a link names, in a project that is ${name}`, () =>
      Effect.gen(function* () {
        yield* settle(granted)
        const dir = (yield* Location.Service).directory
        const folder = (yield* Global.Service).home
        const key = path.join(folder, ".ssh", "id_rsa")
        yield* mkdir(path.dirname(key))
        yield* writeAgents(key, "PRIVATE KEY MARKER")
        yield* nested(dir, "AGENTS.md", "@./link @./notes.md")
        yield* Effect.promise(() => fs.symlink(key, path.resolve(dir, "sub", "link")))
        yield* writeAgents(path.resolve(dir, "sub", "notes.md"), "NOTES MARKER")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(dir)

        yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

        const text = (yield* synthetics(sessionID)).map((message) => message.text).join("\n")
        expect(text).toContain("NOTES MARKER")
        expect(text).not.toContain("PRIVATE KEY MARKER")
      }),
    )
  }

  // The session itself starts at the home folder, so no folder below it is bounded until a person trusts it.
  for (const [name, granted] of [
    ["trusted for the session", true],
    ["not trusted", false],
  ] as const) {
    const atHome = harness((root) => ({ home: root, directory: root }))
    const slashed = (value: string) => value.replaceAll("\\", "/")

    atHome.live(`with the session at the home folder, a downloaded folder's imports of home files are ${granted ? "sent" : "left out"} in a project that is ${name}`, () =>
      Effect.gen(function* () {
        yield* settle(granted)
        const folder = (yield* Global.Service).home
        const key = path.join(folder, ".ssh", "id_rsa")
        yield* mkdir(path.dirname(key))
        yield* writeAgents(key, "PRIVATE KEY MARKER")
        const downloaded = path.join(folder, "Downloads", "x")
        yield* nested(
          folder,
          "AGENTS.md",
          ["@~/.ssh/id_rsa", "@../../.ssh/id_rsa", `@${slashed(key)}`, "@./notes.md"].join("\n"),
          path.join("Downloads", "x"),
        )
        yield* writeAgents(path.join(downloaded, "notes.md"), "NOTES MARKER")
        const registry = yield* Tool.Service
        const sessionID = yield* sessionIn(folder)

        yield* executeTool(registry, readCall(sessionID, "call-downloaded", "Downloads/x/file.txt"))

        const text = (yield* synthetics(sessionID)).map((message) => message.text).join("\n")
        // Granted, the home folder is the boundary, as an accepted trust dialog makes it; ungranted, nothing is sent.
        expect(text.includes("PRIVATE KEY MARKER")).toBe(granted)
        expect(text.includes("NOTES MARKER")).toBe(granted)
      }),
    )
  }
})
