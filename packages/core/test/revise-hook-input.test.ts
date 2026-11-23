// m5-quality, FU-M5-001: a person may approve an Edit or Write with their own version of the file. What runs is then
// that version, and a PostToolUse hook is told about what ran: the reference rebuilds the call's input from the person's
// version before its post-tool hooks run, so a hook that checks or formats what was written reads the written text. A
// Write's `content` is the person's version; an Edit is one edit of the whole file, from the file as it was to the
// person's version, with `replace_all` false. A reply that keeps the proposal leaves the model's input as it was.
// Through the real Permission service, the real file tools and the real lifecycle hooks plugin running a command hook
// that saves its payload.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer, Schema } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Mcp } from "@orbit/core/mcp/index"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { ShellSelect } from "@orbit/core/shell/select"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { AppProcess } from "@orbit/util/process"
import { Global } from "@orbit/util/global"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"
import { trustedProject } from "./fixture/project-trust"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"
import { host } from "./plugin/host"

const sessionID = Session.ID.make("ses_revise_hook")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_revise_hook") }
const it = testEffect(Layer.empty)
const decode = (value: unknown) => new Document({ type: "document", info: Schema.decodeUnknownSync(Info)(value) })

const plugins = makeLocationNode({
  name: "test/revise-hook-input-plugins",
  layer: Layer.effectDiscard(Effect.all([registerToolPlugin(EditTool.Plugin), registerToolPlugin(WriteTool.Plugin)])),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

// Runs one call of `name` with `input` in a project at `directory`, whose agent asks about everything, with a
// PostToolUse hook on every tool that saves its stdin to `payload`; each question is answered once with `content` as
// the person's version (or with the proposal kept when `content` is undefined).
const run = (directory: string, payload: string, name: string, input: Record<string, unknown>, content?: string) =>
  Effect.gen(function* () {
    yield* seed(directory)
    const registry = yield* PluginHooks.Service
    yield* LifecycleHooksPlugin.Plugin.effect(
      host({
        tool: {
          transform: () => Effect.die("unused tool.transform"),
          reload: () => Effect.die("unused tool.reload"),
          list: () => Effect.die("unused tool.list"),
          hook: (hookName, callback) => registry.register("tool", hookName, callback),
        },
        session: { hook: (hookName, callback) => registry.register("session", hookName, callback) },
      }),
    )
    const tools = yield* Tool.Service
    const permission = yield* Permission.Service
    const fiber = yield* (yield* tools.snapshot())
      .execute({ sessionID, ...identity, call: { type: "tool-call", id: `call-${name}`, name, input } })
      .pipe(Effect.forkScoped)
    const answer = (): Effect.Effect<Exit.Exit<unknown, unknown>> =>
      Effect.gen(function* () {
        const done = fiber.pollUnsafe()
        if (done) return done
        const [request] = yield* permission.list()
        if (!request) {
          yield* Effect.sleep("2 millis")
          return yield* answer()
        }
        yield* permission
          .reply({
            requestID: request.id,
            reply: "once",
            ...(content === undefined ? {} : { content }),
          } as Permission.ReplyInput)
          .pipe(Effect.orDie)
        return yield* answer()
      })
    const exit = yield* answer()
    expect(Exit.isSuccess(exit)).toBe(true)
    return JSON.parse(yield* Effect.promise(() => fs.readFile(payload, "utf8"))) as {
      tool_name: string
      tool_input: Record<string, unknown>
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          Bus.node,
          SessionStore.node,
          PermissionSaved.node,
          Agent.node,
          PluginHooks.node,
          ManagedPolicy.node,
          Permission.node,
          Tool.node,
          FileAccess.node,
          FileMutation.node,
          FileLedger.node,
          ShellSelect.node,
          AppProcess.node,
          Config.node,
          Mcp.node,
          ProjectTrust.node,
          Location.node,
          plugins,
        ]),
        [
          FileLedger.node.replace(FileLedger.permissiveLayer),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Image.node.replace(imagePassthrough),
          Config.node.replace(
            Config.testLayer([
              decode({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: `cat > '${payload}'` }] }] } }),
            ]),
          ),
          Mcp.node.replace(emptyMcpLayer),
          ProjectTrust.node.replace(trustedProject),
          Global.node.replace(tempGlobalLayer),
        ],
      ),
    ),
  )

// The session the call belongs to, in the project at `directory`, and an agent that asks about every action.
const seed = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "revise-hook",
        directory,
        title: "revise-hook",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(identity.agent, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
  })

const withProject = <A, E>(body: (directory: string, payload: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (project) => body(path.join(project.path, "project"), path.join(project.path, "payload.json")),
    (project) => Effect.promise(() => project[Symbol.asyncDispose]()),
  )

const prepare = (directory: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    await fs.mkdir(directory, { recursive: true })
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, name), text)
  })

// The hooks run through a shell, as the lifecycle hooks tests run them.
describe.skipIf(process.platform === "win32")("a PostToolUse hook after an approval answered with a revision", () => {
  it.live("a revised Write tells the hook the person's content, for a new file and over an existing one", () =>
    withProject((directory, payload) =>
      Effect.gen(function* () {
        yield* prepare(directory, { "old.txt": "before\n" })
        for (const name of ["old.txt", "new.txt"]) {
          const hook = yield* run(directory, payload, "Write", { file_path: name, content: "proposed\n" }, "revised\n")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, name), "utf8"))).toBe("revised\n")
          expect(hook.tool_input).toMatchObject({ content: "revised\n" })
        }
      }),
    ),
  )

  it.live("a revised Edit tells the hook one edit of the whole file, from what it was to the person's version", () =>
    withProject((directory, payload) =>
      Effect.gen(function* () {
        yield* prepare(directory, { "a.txt": "alpha\nbeta\n" })
        const hook = yield* run(
          directory,
          payload,
          "Edit",
          { file_path: "a.txt", old_string: "beta", new_string: "BETA", replace_all: true },
          "alpha\nREVISED\n",
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("alpha\nREVISED\n")
        expect(hook.tool_input).toMatchObject({
          old_string: "alpha\nbeta\n",
          new_string: "alpha\nREVISED\n",
          replace_all: false,
        })
      }),
    ),
  )

  // The control: a reply that approves the proposal as it is leaves the model's input, which is what ran.
  it.live("an approval without a revision tells the hook the model's input", () =>
    withProject((directory, payload) =>
      Effect.gen(function* () {
        yield* prepare(directory, { "a.txt": "alpha\nbeta\n" })
        const edit = yield* run(directory, payload, "Edit", {
          file_path: "a.txt",
          old_string: "beta",
          new_string: "BETA",
        })
        expect(edit.tool_input).toMatchObject({ old_string: "beta", new_string: "BETA" })
        const write = yield* run(directory, payload, "Write", { file_path: "b.txt", content: "proposed\n" })
        expect(write.tool_input).toMatchObject({ content: "proposed\n" })
      }),
    ),
  )

  // Saving the proposal unchanged is no change of the person's (Orbit's rule for what the model is told), so the hook
  // reads the model's input, which is what was written.
  it.live("a revision equal to the proposal tells the hook the model's input", () =>
    withProject((directory, payload) =>
      Effect.gen(function* () {
        yield* prepare(directory, { "a.txt": "alpha\nbeta\n" })
        const edit = yield* run(
          directory,
          payload,
          "Edit",
          { file_path: "a.txt", old_string: "beta", new_string: "BETA" },
          "alpha\nBETA\n",
        )
        expect(edit.tool_input).toMatchObject({ old_string: "beta", new_string: "BETA" })
        expect(edit.tool_input.replace_all).toBeUndefined()
        // A Write's input rebuilt with the same content would read alike, so the model's call carries a key the tool's
        // schema drops: the hook still reads it, since it is told the model's own input and not a rebuilt one.
        const write = yield* run(
          directory,
          payload,
          "Write",
          { file_path: "b.txt", content: "proposed\n", note: "the model's own key" },
          "proposed\n",
        )
        expect(write.tool_input).toMatchObject({ content: "proposed\n", note: "the model's own key" })
      }),
    ),
  )
})
