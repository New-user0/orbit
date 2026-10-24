import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { ToolOutput } from "@orbit/core/tool-output"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Identifier } from "@orbit/core/id/id"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const linkType = process.platform === "win32" ? "junction" : "dir"
const big = [{ type: "text" as const, text: "b".repeat(200) }]

const withStore = <A, E, R>(
  body: (output: ToolOutput.Interface, fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
        Global.node.replace(Global.layerWith({ data: tmp.path })),
      ])
      return Effect.gen(function* () {
        const output = yield* ToolOutput.Service
        const fs = yield* FSUtil.Service
        return yield* body(output, fs, tmp.path)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const settle = (output: ToolOutput.Interface, messageID = "msg_0123abc") =>
  output.settle({
    sessionID: "ses_tool_output",
    messageID,
    callID: "call_a",
    tool: "Probe",
    limit: 100,
    result: { content: big },
  })

describe("ToolOutput", () => {
  it.live("saves into the session's folder under the tool-output folder", () =>
    withStore((output, _, root) =>
      Effect.gen(function* () {
        expect(output.root).toBe(path.join(root, ToolOutput.DIRECTORY))
        const result = yield* settle(output)
        expect(result.metadata?.persisted).toMatchObject({ session: "ses_tool_output", size: 200, format: 1 })
        expect(yield* Effect.promise(() => fs.readdir(path.join(output.root, "ses_tool_output")))).toHaveLength(1)
      }),
    ),
  )

  // The message ID names the file too, and a session store can hold any `msg_` spelling (class 5).
  it.live("writes nothing for a message whose ID cannot name a file", () =>
    withStore((output, _, root) =>
      Effect.gen(function* () {
        const result = yield* settle(output, "msg_../../x")
        expect(result).toEqual({ content: big })
        expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([])
      }),
    ),
  )

  // The session folder's own link check is in the step suite; this one is the folder above it (class 4).
  it.live("writes nothing through a tool-output folder that is a link", () =>
    withStore((output, _, root) =>
      Effect.gen(function* () {
        const outside = path.join(root, "outside")
        yield* Effect.promise(async () => {
          await fs.mkdir(outside)
          await fs.symlink(outside, output.root, linkType)
        })
        const result = yield* settle(output)
        expect(result).toEqual({ content: big })
        expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([])
      }),
    ),
  )

  // An offered file stands for the first part of its own call's result, once: settling that call takes the offer, and
  // settling it again finds none. Fails when an offer outlives its settle, which would mark a replayed result with a file
  // offered for an earlier one.
  it.live("takes an offered file for its call's result once", () =>
    withStore((output, _, root) =>
      Effect.gen(function* () {
        const file = path.join(root, "full.out")
        yield* Effect.promise(() => fs.writeFile(file, "the whole output"))
        const call = { sessionID: "ses_tool_output", messageID: "msg_0123abc", callID: "call_offer" }
        const settleCall = output.settle({
          ...call,
          tool: "Bash",
          limit: 100,
          result: { content: [{ type: "text", text: "the" }] },
        })
        yield* output.adopt({ ...call, file })
        expect((yield* settleCall).metadata?.persisted).toMatchObject({ parts: 1, size: "the whole output".length })
        expect((yield* settleCall).metadata?.persisted).toBeUndefined()
      }),
    ),
  )

  // Offers that are never settled are bounded: past 256 the oldest is forgotten, so its call's result goes whole. Fails
  // without the bound, which keeps every offer for the life of the process.
  it.live("forgets the oldest offer past 256 unsettled ones", () =>
    withStore((output, _, root) =>
      Effect.gen(function* () {
        const file = path.join(root, "full.out")
        yield* Effect.promise(() => fs.writeFile(file, "the whole output"))
        const call = (index: number) => ({
          sessionID: "ses_tool_output",
          messageID: "msg_0123abc",
          callID: `call_${index}`,
        })
        yield* Effect.forEach(
          Array.from({ length: 257 }, (_, index) => index),
          (index) => output.adopt({ ...call(index), file }),
          {
            discard: true,
          },
        )
        const settleCall = (index: number) =>
          output.settle({
            ...call(index),
            tool: "Bash",
            limit: 100,
            result: { content: [{ type: "text", text: "the" }] },
          })
        expect((yield* settleCall(0)).metadata?.persisted).toBeUndefined()
        expect((yield* settleCall(1)).metadata?.persisted).toMatchObject({ parts: 1 })
        expect((yield* settleCall(256)).metadata?.persisted).toMatchObject({ parts: 1 })
      }),
    ),
  )

  it.live("removes flat files of earlier versions changed before the cutoff", () =>
    withStore((output, fs, root) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const old = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 - 1))
        const recent = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 + 1))
        yield* fs.ensureDir(directory)
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000))
        yield* ToolOutput.cleanup(output.root, Date.now() - 7 * 24 * 60 * 60 * 1_000)
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    ),
  )
})
