import { beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Layer, Result } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { Config } from "@orbit/core/config"
import { FileLedger } from "@orbit/core/file-ledger"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FileSystem } from "@orbit/core/filesystem"
import { FSUtil } from "@orbit/util/fs-util"
import { Location } from "@orbit/core/location"
import { Image } from "@orbit/core/image"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Global } from "@orbit/util/global"
import { Token } from "@orbit/core/util/token"
import { FileAccess } from "@orbit/core/file-access"
import { location } from "./fixture/location"
import { Tool } from "@orbit/core/tool"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { SessionInstructions } from "@orbit/core/session/instructions"
import { Environment } from "@orbit/core/environment/index"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

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

const assertions: Permission.AssertInput[] = []
const missingPath = "__missing_read_target__.txt"
const missingAbsolutePath = path.join(process.cwd(), missingPath)
const readCalls: {
  input: AbsolutePath
  page: ReadToolFileSystem.PageInput
}[] = []
const listCalls: AbsolutePath[] = []
let readDefect: unknown
let directoryEntries: string[] = []
let directoryEntryDetails: Environment.DirEntry[] = []
let readResult: ReadToolFileSystem.FileContent | ReadToolFileSystem.TextPage | ReadToolFileSystem.ListPage = {
  type: "file",
  uri: "file:///README.md",
  name: "README.md",
  content: "hello",
  encoding: "utf8",
  mime: "text/plain",
}
let readFailure: ReadToolFileSystem.ReadError | undefined
let readOverride: ReadToolFileSystem.Interface["read"] | undefined
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    list: (input) => {
      listCalls.push(input)
      return Effect.succeed(directoryEntryDetails)
    },
    read: (input, resource, page = {}) => {
      readCalls.push({ input, page })
      if (readDefect !== undefined) return Effect.die(readDefect)
      if (readOverride) return readOverride(input, resource, page)
      if (readFailure !== undefined) return Effect.fail(readFailure)
      return Effect.succeed(readResult)
    },
  }),
)
let allow = true
let deniedResource: string | undefined
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
    }).pipe(
      Effect.andThen(
        allow && !input.resources.some((resource) => resource === deniedResource)
          ? Effect.void
          : Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            ),
      ),
    ),
})
const config = Config.testLayer()
const imageLayer = AppNodeBuilder.build(Image.node)
const testFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) =>
    Effect.succeed(
      FSUtil.Service.of({
        ...fs,
        readDirectory: () => Effect.succeed(directoryEntries),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)
const unavailableImage = Layer.mock(Image.Service, {
  normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
})
const readLayer = (imageLayer: Layer.Layer<Image.Service>) =>
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Tool.node, readToolNode]), [
      ReadToolFileSystem.node.replace(reader),
      Permission.node.replace(permission),
      Config.node.replace(config),
      Image.node.replace(imageLayer),
      FSUtil.node.replace(testFileSystem),
      Location.node.replace(locationLayer),
      Global.node.replace(Global.layerWith({ data: Global.Path.data })),
    ]),
    // Merge by reference so Config.Test and Image.Service resolve to the memoized instances.
    config,
    imageLayer,
  )
const it = testEffect(readLayer(imageLayer))
const itWithoutResizer = testEffect(readLayer(unavailableImage))
const sessionID = Session.ID.make("ses_read_tool_test")

describe("ReadTool", () => {
  beforeEach(() => {
    assertions.length = 0
    readCalls.length = 0
    listCalls.length = 0
    allow = true
    deniedResource = undefined
    readDefect = undefined
    directoryEntries = []
    directoryEntryDetails = []
    readResult = {
      type: "file",
      uri: "file:///README.md",
      name: "README.md",
      content: "hello",
      encoding: "utf8",
      mime: "text/plain",
    }
    readFailure = undefined
    readOverride = undefined
  })

  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "Read")).toMatchObject({
        readOnly: true,
        concurrencySafe: true,
        destructive: false,
        openWorld: false,
        interruptBehavior: "cancel",
        maxResultChars: Infinity,
      })

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["Read", "Execute"])
      expect(
        (yield* toolDefinitions(registry, [{ action: "Read", resource: "*", effect: "deny" }])).map(
          (tool) => tool.name,
        ),
      ).toEqual(["Execute"])
      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-read", name: "Read", input: { file_path: "README.md" } },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.output).toEqual({
        type: "file",
        uri: "file:///README.md",
        name: "README.md",
        content: "hello",
        encoding: "utf8",
        mime: "text/plain",
      })
      expect(execution.content).toEqual([{ type: "text", text: "Read file README.md, lines 1-1\n1: hello" }])
      expect(assertions).toMatchObject([{ sessionID, action: "Read", resources: ["README.md"], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("reads a notebook as its cells and outputs", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-notebook",
          name: "Read",
          input: { file_path: "test/fixtures/notebook/sample.ipynb", offset: 5 },
        },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.content).toEqual([
        {
          type: "text",
          text: [
            "Read file test/fixtures/notebook/sample.ipynb, lines 5-10",
            '5: <cell index="1" id="calc" type="code">',
            "6: print(1 + 1)",
            "7: <outputs>",
            "8: 2",
            "9: </outputs>",
            "10: </cell>",
          ].join("\n"),
        },
      ])
    }),
  )
  it.effect("refuses a device with its own message, asks nothing and opens nothing", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const device = process.platform === "win32" ? "NUL" : "/dev/stdin"

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-read-device", name: "Read", input: { file_path: device } },
      })

      expect(result).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("is a device or stream, not a file") },
      })
      expect(assertions).toEqual([])
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("reads a notebook from its first line when offset and limit are 0", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-notebook-zero",
          name: "Read",
          input: { file_path: "test/fixtures/notebook/sample.ipynb", offset: 0, limit: 0 },
        },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.output).toMatchObject({ type: "text-page", offset: 1 })
    }),
  )

  it.effect("pages a notebook with huge outputs within the budget", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "orbit-notebook-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })))
      const file = path.join(directory, "big.ipynb")
      const outputLines = Array.from({ length: 1_500 }, (_, index) => `${index} ${"o".repeat(80)}`)
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          JSON.stringify({
            cells: [
              {
                cell_type: "code",
                id: "big",
                metadata: {},
                source: ["print('x')"],
                outputs: [
                  { output_type: "stream", name: "stdout", text: outputLines.map((line) => `${line}\n`) },
                  { output_type: "stream", name: "stdout", text: ["z".repeat(500_000)] },
                ],
              },
            ],
            metadata: {},
            nbformat: 4,
            nbformat_minor: 5,
          }),
        ),
      )
      // The real reader, so that the paging of the raw JSON (a few lines) and of the rendering (thousands) are both real.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const environment = Environment.makeFiles(Environment.makeLocalDriver(spawner))
      readOverride = (input, resource, page) => ReadToolFileSystem.read(environment, input, resource, page)

      // Page to the end: each page stays within the budget and starts where the one before said to continue.
      const starts: number[] = []
      let offset: number | undefined
      let finished = false
      for (let index = 0; index < 20 && !finished; index++) {
        const page = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `call-big-notebook-${index}`,
            name: "Read",
            input: offset === undefined ? { file_path: file } : { file_path: file, offset },
          },
        })
        if (page.status !== "completed" || page.output.type !== "text-page") throw new Error("expected a page")
        const text = page.content?.[0]?.type === "text" ? page.content?.[0].text : ""
        expect(Token.estimate(text)).toBeLessThanOrEqual(ReadToolFileSystem.MAX_READ_TOKENS + 100)
        starts.push(page.output.offset)
        if (page.output.next === undefined) finished = true
        else {
          expect(page.output.next).toBeGreaterThan(page.output.offset)
          expect(text).toContain(`Continue reading with offset: ${page.output.next}`)
          offset = page.output.next
        }
      }
      // More than one page, chained to the last: the offsets are lines of the rendering, not of the JSON.
      expect(starts.length).toBeGreaterThan(1)
      expect(starts[0]).toBe(1)
      expect(finished).toBe(true)
    }).pipe(
      Effect.provide(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem]))),
      Effect.scoped,
    ),
  )

  it.effect("fails a notebook read past the end like a text file, and pages a folder named like a notebook", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "orbit-notebook-edge-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })))
      const notebook = path.join(directory, "small.ipynb")
      const folder = path.join(directory, "nb.ipynb")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          notebook,
          JSON.stringify({
            cells: [{ cell_type: "code", id: "a", metadata: {}, source: ["print(1)"], outputs: [] }],
            metadata: {},
            nbformat: 4,
            nbformat_minor: 5,
          }),
        )
        await fs.mkdir(folder)
        await Promise.all(Array.from({ length: 5 }, (_, index) => fs.writeFile(path.join(folder, `f${index}.txt`), "x")))
      })
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const environment = Environment.makeFiles(Environment.makeLocalDriver(spawner))
      readOverride = (input, resource, page) => ReadToolFileSystem.read(environment, input, resource, page)

      const past = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-nb-past", name: "Read", input: { file_path: notebook, offset: 500 } },
      })
      expect(past).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("out of range") },
      })

      const listed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-nb-folder", name: "Read", input: { file_path: folder, offset: 3, limit: 2 } },
      })
      if (listed.status !== "completed" || listed.output.type !== "list-page") throw new Error("expected a list page")
      expect(listed.output.entries).toHaveLength(2)
    }).pipe(
      Effect.provide(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem]))),
      Effect.scoped,
    ),
  )

  it.effect("asks for external_directory approval before reading an external absolute path", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const external = path.join(path.parse(process.cwd()).root, "external-read", "notes.txt")

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-external-read", name: "Read", input: { file_path: external } },
        }),
      ).toMatchObject({ status: "completed" })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "external_directory",
          resources: [path.join(path.dirname(external), "*").replaceAll("\\", "/")],
        },
        { sessionID, action: "Read", resources: [external.replaceAll("\\", "/")], save: ["*"] },
      ])
      expect(readCalls).toEqual([{ input: AbsolutePath.make(external), page: { offset: undefined, limit: undefined } }])
    }),
  )

  it.effect("returns a small PNG as native media instead of durable base64 text", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image", name: "Read", input: { file_path: "pixel.png" } },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "pixel.png" },
      ])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "pixel.png")),
          page: { offset: undefined, limit: undefined },
        },
      ])

      const settled = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image-settle", name: "Read", input: { file_path: "pixel.png" } },
      })
      expect(settled.status).toBe("completed")
      if (settled.status !== "completed") return
      expect(settled.metadata).toEqual({ truncated: false })
      expect(settled.content).toMatchObject([
        { type: "text", text: "Image read successfully" },
        { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}` },
      ])
    }),
  )

  it.effect("preserves a PNG above the generic text limit as native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const pixels = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index * 73 + (index >> 3)) % 256)
      const source = new photon.PhotonImage(pixels, 256, 256)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      expect(Buffer.byteLength(png)).toBeGreaterThan(50 * 1024)
      readResult = {
        type: "file",
        uri: "file:///large.png",
        name: "large.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      const settled = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-image", name: "Read", input: { file_path: "large.png" } },
      })

      expect(settled.status).toBe("completed")
      if (settled.status !== "completed") return
      expect(settled.output).toMatchObject({
        uri: "file:///large.png",
        name: "large.png",
        mime: "image/png",
        encoding: "base64",
      })
      expect(settled.content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "large.png" },
      ])
    }),
  )

  itWithoutResizer.effect("returns the original image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-image-fallback", name: "Read", input: { file_path: "pixel.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [{ type: "text" }, { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png" }],
      })
    }),
  )

  it.effect("drops undecodable image data from the outcome", () =>
    Effect.gen(function* () {
      readResult = {
        type: "file",
        uri: "file:///truncated.png",
        name: "truncated.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-truncated-image", name: "Read", input: { file_path: "truncated.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be decoded.]" },
        ],
      })
    }),
  )

  it.effect("drops oversized images from the outcome when resizing is disabled", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        type: "file",
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ autoResize: false, maxWidth: 4 }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-wide-image", name: "Read", input: { file_path: "wide.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
        ],
      })
    }),
  )

  it.effect("resizes images to configured dimensions before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        type: "file",
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ maxWidth: 4 }))
      const registry = yield* Tool.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-resize-image", name: "Read", input: { file_path: "wide.png" } },
      })

      expect(result.status).toBe("completed")
      if (result.status !== "completed") return
      const media = result.content?.[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.uri.split(",")[1] ?? "", "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("accepts PNG candidates at the exact base64 limit and skips them one byte below", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        Uint8Array.from({ length: 16 * 4 }, () => 255),
        16,
        1,
      )
      const content = {
        uri: "file:///wide.png",
        content: Buffer.from(source.get_bytes()).toString("base64"),
        encoding: "base64" as const,
        mime: "image/png",
      }
      source.free()
      const image = yield* Image.Service

      for (const [maxWidth, padding] of [
        [4, "=="],
        [5, "="],
        [6, ""],
      ] as const) {
        yield* image.transform((editor) => editor.configure({ maxWidth, maxBase64Bytes: 1_024 }))
        const candidate = yield* image.normalize("wide.png", content)
        expect(candidate.mime).toBe("image/png")
        expect(candidate.content.match(/=*$/)?.[0]).toBe(padding)

        yield* image.transform((editor) => editor.configure({ maxBase64Bytes: candidate.content.length }))
        expect(yield* image.normalize("wide.png", content)).toEqual(candidate)

        yield* image.transform((editor) => editor.configure({ maxBase64Bytes: candidate.content.length - 1 }))
        const smaller = yield* image.normalize("wide.png", content)
        expect(smaller.mime).toBe("image/png")
        expect(smaller.content.length).toBeLessThan(candidate.content.length)
      }
    }),
  )

  it.effect("drops images that cannot fit max base64 bytes after resize attempts", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ maxBase64Bytes: 1 }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-max-bytes", name: "Read", input: { file_path: "pixel.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
        ],
      })
    }),
  )

  it.effect("returns supported image contents despite a misleading binary extension", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.bin",
        name: "pixel.bin",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disguised-image", name: "Read", input: { file_path: "pixel.bin" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [{ type: "text" }, { type: "file", mime: "image/png", name: "pixel.bin" }],
      })
    }),
  )

  it.effect("returns PDFs as native media", () =>
    Effect.gen(function* () {
      const pdf = "JVBERi0xLjcK"
      readResult = {
        type: "file",
        uri: "file:///document.pdf",
        name: "document.pdf",
        content: pdf,
        encoding: "base64",
        mime: "application/pdf",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-pdf", name: "Read", input: { file_path: "document.pdf" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "PDF read successfully" },
          { type: "file", uri: `data:application/pdf;base64,${pdf}`, mime: "application/pdf", name: "document.pdf" },
        ],
      })
    }),
  )

  it.effect("returns expected filesystem failures to the model", () =>
    Effect.gen(function* () {
      readFailure = new ReadToolFileSystem.BinaryFileError({ resource: "archive.dat" })
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-binary",
            name: "Read",
            input: { file_path: "archive.dat", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({ status: "error", error: { type: "unknown", message: "Cannot read binary file: archive.dat" } })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "archive.dat")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("preserves actionable read failure messages", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      for (const [error, message] of [
        [
          new ReadToolFileSystem.OffsetOutOfRangeError({ offset: 10, lines: 3 }),
          "Offset 10 is out of range for this file (3 lines)",
        ],
        [
          new ReadToolFileSystem.PathKindError({ resource: "socket", expected: "a file" }),
          "Path is not a file: socket",
        ],
      ] as const) {
        readFailure = error
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: `call-${error._tag}`, name: "Read", input: { file_path: "target" } },
          }),
        ).toEqual({ status: "error", error: { type: "unknown", message } })
      }
    }),
  )

  it.effect("preserves unexpected filesystem defects", () =>
    Effect.gen(function* () {
      readDefect = new Error("unexpected")
      const registry = yield* Tool.Service

      const exit = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-defect", name: "Read", input: { file_path: "README.md" } },
      }).pipe(Effect.exit)
      expect(Result.getOrThrow(Exit.findDefect(exit))).toBe(readDefect)
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "Read", input: { file_path: "README.md" } },
        }),
      ).toEqual({ status: "error", error: { type: "permission.rejected", message: "Permission denied: Read" } })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("returns missing paths as model-visible tool failures", () =>
    Effect.gen(function* () {
      readFailure = new Environment.NotFound({ path: missingAbsolutePath })
      directoryEntries = [
        "__missing_read_target__.txt.bak",
        "copy___missing_read_target__.txt",
        "old___missing_read_target__.txt",
        "other___missing_read_target__.txt",
        "unrelated.txt",
      ]
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-missing-path", name: "Read", input: { file_path: missingPath } },
        }),
      ).toEqual({
        status: "error",
        error: {
          type: "tool.execution",
          message: `File not found: ${missingPath}\n\nDid you mean one of these?\n__missing_read_target__.txt.bak\ncopy___missing_read_target__.txt\nold___missing_read_target__.txt`,
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "Read", resources: [missingPath], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(missingAbsolutePath),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("recovers a unique file whose non-breaking spaces differ", () =>
    Effect.gen(function* () {
      const requested = "Screenshot 2026-08-27 3.15 PM.png"
      const recovered = "Screenshot 2026-08-27 3.15\u202fPM.png"
      const requestedAbsolute = path.join(process.cwd(), requested)
      const recoveredAbsolute = path.join(process.cwd(), recovered)
      directoryEntryDetails = [{ name: recovered, type: "file" }]
      readOverride = (input) =>
        input === requestedAbsolute
          ? Effect.fail(new Environment.NotFound({ path: requestedAbsolute }))
          : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-recovered-path", name: "Read", input: { file_path: requested } },
      })

      expect(result).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: `Read file ${recovered}, lines 1-1\n1: hello` }],
      })
      expect(assertions).toMatchObject([
        { action: "Read", resources: [requested] },
        { action: "Read", resources: [recovered] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([
        AbsolutePath.make(requestedAbsolute),
        AbsolutePath.make(recoveredAbsolute),
      ])
      expect(listCalls).toEqual([AbsolutePath.make(process.cwd())])
    }),
  )

  it.effect("recovers an external filename without repeating directory approval", () =>
    Effect.gen(function* () {
      const directory = path.join(path.parse(process.cwd()).root, "external-read")
      const requested = path.join(directory, "report final.txt")
      const recovered = path.join(directory, "report\u202ffinal.txt")
      directoryEntryDetails = [{ name: path.basename(recovered), type: "file" }]
      readOverride = (input) =>
        input === requested ? Effect.fail(new Environment.NotFound({ path: requested })) : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-external-recovery", name: "Read", input: { file_path: requested } },
        }),
      ).toMatchObject({ status: "completed" })
      expect(assertions).toMatchObject([
        { action: "external_directory", resources: [path.join(directory, "*").replaceAll("\\", "/")] },
        { action: "Read", resources: [requested.replaceAll("\\", "/")] },
        { action: "Read", resources: [recovered.replaceAll("\\", "/")] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([AbsolutePath.make(requested), AbsolutePath.make(recovered)])
    }),
  )

  it.effect("does not read a recovered filename denied by its own read rules", () =>
    Effect.gen(function* () {
      const requested = path.join(process.cwd(), "report final.txt")
      const recovered = path.join(process.cwd(), "report\u202ffinal.txt")
      deniedResource = path.basename(recovered)
      directoryEntryDetails = [{ name: path.basename(recovered), type: "file" }]
      readOverride = (input) =>
        input === requested ? Effect.fail(new Environment.NotFound({ path: requested })) : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-denied-recovery", name: "Read", input: { file_path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { type: "permission.rejected" } })
      expect(assertions).toMatchObject([
        { action: "Read", resources: [path.basename(requested)] },
        { action: "Read", resources: [path.basename(recovered)] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([AbsolutePath.make(requested)])
    }),
  )

  it.effect("does not recover ambiguous files", () =>
    Effect.gen(function* () {
      const requested = "report final.txt"
      const requestedAbsolute = path.join(process.cwd(), requested)
      readFailure = new Environment.NotFound({ path: requestedAbsolute })
      directoryEntryDetails = [
        { name: "report\u00a0final.txt", type: "file" },
        { name: "report\u202ffinal.txt", type: "file" },
      ]
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-ambiguous-path", name: "Read", input: { file_path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { message: `File not found: ${requested}` } })
      expect(assertions).toHaveLength(1)
      expect(readCalls).toHaveLength(1)
    }),
  )

  it.effect("does not recover a directory", () =>
    Effect.gen(function* () {
      const requested = "report final"
      const recovered = "report\u00a0final"
      const requestedAbsolute = path.join(process.cwd(), requested)
      directoryEntryDetails = [{ name: recovered, type: "directory" }]
      readOverride = (input) =>
        input === requestedAbsolute
          ? Effect.fail(new Environment.NotFound({ path: requestedAbsolute }))
          : Effect.succeed(new ReadToolFileSystem.ListPage({ type: "list-page", entries: [], truncated: false }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-directory-recovery", name: "Read", input: { file_path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { message: `File not found: ${requested}` } })
      expect(assertions).toHaveLength(1)
      expect(readCalls).toHaveLength(1)
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.ListPage({
        type: "list-page",
        entries: [
          FileSystem.Entry.make({ path: RelativePath.make("components/"), type: "directory" }),
          FileSystem.Entry.make({ path: RelativePath.make("index.ts"), type: "file" }),
        ],
        truncated: true,
        next: 4,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-directory",
          name: "Read",
          input: { file_path: "src", offset: 2, limit: 10 },
        },
      })
      expect(result).toMatchObject({
        status: "completed",
        output: { entries: readResult.entries, truncated: true, next: 4 },
      })
      if (result.status !== "completed") return
      expect(result.metadata).toEqual({ truncated: true })
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read directory src, entries 2-3\ncomponents/\nindex.ts\n[Output truncated. Continue reading with offset: 4]",
        },
      ])
      expect(assertions).toMatchObject([{ sessionID, action: "Read", resources: ["src"], save: ["*"] }])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "src")), page: { offset: 2, limit: 10 } },
      ])
    }),
  )

  it.effect("normalizes a zero directory offset in the model heading", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.ListPage({
        type: "list-page",
        entries: [FileSystem.Entry.make({ path: RelativePath.make("index.ts"), type: "file" })],
        truncated: true,
        next: 2,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-directory-zero",
          name: "Read",
          input: { file_path: "src", offset: 0, limit: 1 },
        },
      })
      expect(result.status).toBe("completed")
      if (result.status !== "completed") return
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read directory src, entries 1-1\nindex.ts\n[Output truncated. Continue reading with offset: 2]",
        },
      ])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "src")), page: { offset: 0, limit: 1 } },
      ])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "Read", input: { file_path: "src" } },
        }),
      ).toEqual({ status: "error", error: { type: "permission.rejected", message: "Permission denied: Read" } })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("forwards pagination and returns bounded text pages with continuation", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: "hello",
        mime: "text/plain",
        offset: 2,
        truncated: true,
        next: 3,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-large",
          name: "Read",
          input: { file_path: "large.txt", offset: 2, limit: 1 },
        },
      })
      expect(result).toMatchObject({
        status: "completed",
        output: { type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3 },
      })
      if (result.status !== "completed") return
      expect(result.metadata).toEqual({ truncated: true })
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read file large.txt, lines 2-2\n2: hello\n[Output truncated: one read returns at most 2000 lines or about 25000 tokens. Continue reading with offset: 3, or use Grep to find specific content.]",
        },
      ])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "large.txt")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("rejects unsupported binary discovered by a direct read", () =>
    Effect.gen(function* () {
      readResult = {
        type: "file",
        uri: "file:///late-binary",
        name: "late-binary",
        content: "AAECAw==",
        encoding: "base64",
        mime: "application/octet-stream",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-direct-binary", name: "Read", input: { file_path: "late-binary" } },
        }),
      ).toEqual({ status: "error", error: { type: "unknown", message: "Cannot read binary file: late-binary" } })
    }),
  )
})
