import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { OrbitTools } from "@orbit/core/tool/plugin/orbit"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Effect, Schedule } from "effect"
import { testEffect } from "../lib/effect"
import { executeTool, toolIdentity } from "../lib/tool"
import { pluginTestNodes, pluginTestReplacements } from "./fixture"

// The real ProjectTrust over a store that trusts no folder by itself, as in `session-trust.test.ts`.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([pluginTestNodes, WorkspaceTrust.node]), [
    ...pluginTestReplacements,
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
  ]),
)

// A plugin's move and the model's `session_move` tool (which goes through the same door) read the destination from the
// session's own folder, never from the process's, and the folder that is checked is the folder the session moves to
// (class 3). Every spelling of an untrusted folder is refused, naming the folder as it really is, and the session stays;
// every spelling of a trusted folder moves it there.
it.live(
  "a plugin's move and the session_move tool read the destination from the session's folder, however it is spelled",
  () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const sessions = yield* Session.Service
      const trust = yield* WorkspaceTrust.Service
      const registry = yield* Tool.Service
      const context = yield* PluginHost.make(plugins)
      yield* OrbitTools.Plugin.effect(context)
      const made = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(Global.Path.home, "orbit-move-spellings-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      )
      const real = yield* Effect.promise(() => fs.realpath(made))
      // Accented names in Unicode's composed form, so that a name sent decomposed is read as the same folder.
      const names = { other: "othér", trusted: "trustéd" }
      const folders = {
        repo: path.join(real, "repo"),
        other: path.join(real, names.other),
        trusted: path.join(real, names.trusted),
      }
      yield* Effect.promise(async () => {
        for (const folder of Object.values(folders)) await fs.mkdir(folder, { recursive: true })
        const kind = process.platform === "win32" ? "junction" : "dir"
        await fs.symlink(folders.other, path.join(folders.repo, "into-other"), kind)
        await fs.symlink(folders.trusted, path.join(folders.repo, "into-trusted"), kind)
      })
      yield* trust.grant(folders.repo, { persist: false, via: "test" })
      yield* trust.grant(folders.trusted, { persist: false, via: "test" })
      const spellings = (name: "other" | "trusted") => {
        const target = folders[name]
        const drive = /^([A-Za-z]):\\(.*)$/.exec(target)
        return [
          ["absolute", target],
          ["relative", path.relative(folders.repo, target)],
          ["home", `~/${path.relative(Global.Path.home, path.join(made, names[name])).replaceAll("\\", "/")}`],
          ["link", path.join(folders.repo, `into-${name}`)],
          ["decomposed", target.normalize("NFD")],
          ...(process.platform === "win32" && drive
            ? [["git bash", `/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`]]
            : []),
        ] as const
      }
      const session = () =>
        sessions.create({ title: "Mover", location: Location.Ref.make({ directory: AbsolutePath.make(folders.repo) }) })
      const tool = (sessionID: Session.ID, directory: string) =>
        executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `call-${sessionID}`,
            name: "Execute",
            input: { code: `return await tools.orbit.session_move(${JSON.stringify({ directory })})` },
          },
        })
      // Where the session works now, as the disk has it.
      const where = (sessionID: Session.ID) =>
        sessions
          .get(sessionID)
          .pipe(Effect.flatMap((info) => Effect.promise(() => fs.realpath(info.location.directory))))

      for (const [spelling, value] of spellings("other")) {
        const moved = yield* session()
        expect({
          spelling,
          refused: yield* context.session
            .move({ sessionID: moved.id, directory: AbsolutePath.make(value) })
            .pipe(Effect.flip),
        }).toMatchObject({
          spelling,
          refused: { _tag: "WorkspaceTrust.UntrustedError", directory: folders.other },
        })
        expect(yield* where(moved.id)).toBe(folders.repo)
        const asked = yield* session()
        const result = yield* tool(asked.id, value)
        expect({ spelling, result: JSON.stringify(result) }).toEqual({
          spelling,
          result: expect.stringContaining(`${JSON.stringify(folders.other).slice(1, -1)} is not trusted`),
        })
        expect(yield* where(asked.id)).toBe(folders.repo)
      }

      // The trusted control: each spelling moves the session there.
      for (const [spelling, value] of spellings("trusted")) {
        const moved = yield* session()
        yield* context.session.move({ sessionID: moved.id, directory: AbsolutePath.make(value) })
        const asked = yield* session()
        const result = yield* tool(asked.id, value)
        expect({ spelling, status: result.status }).toEqual({ spelling, status: "completed" })
        // A move is delivered at the session's next boundary, which an idle session reaches at once.
        for (const id of [moved.id, asked.id])
          expect({
            spelling,
            at: yield* where(id).pipe(
              Effect.filterOrFail((at) => at === folders.trusted),
              Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
              Effect.catch(() => where(id)),
            ),
          }).toEqual({ spelling, at: folders.trusted })
      }
    }),
  60_000,
)
