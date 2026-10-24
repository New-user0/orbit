// shell-safety-6: the shell tool's output cap. The tool declares a 30,000-character result limit; a foreground result
// that did not fit keeps the head of its output as stored content, and the step marks it with a saved copy of the whole
// output file in the session's tool-output folder (a hard link, or a copy, cut to 64 MB), which the model sees through
// the standard wrapper. A failing command is never saved. `timeout` takes a decimal string. `background_tasks: false`
// keeps every command in the foreground. Each test names what it does on the base; the class of a security row is in
// its comment (docs/untrusted-repositories.md).
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { Money } from "@orbit/schema/money"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@orbit/util/effect/app-node"
import { filesystem } from "@orbit/util/effect/app-node-platform"
import { Database } from "@orbit/core/database/database"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigTrust } from "@orbit/core/config/trust"
import { Environment } from "@orbit/core/environment/index"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Agent } from "@orbit/core/agent"
import { Job } from "@orbit/core/job"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionStore } from "@orbit/core/session/store"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { Shell } from "@orbit/core/shell"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { ShellSelect } from "@orbit/core/shell/select"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { SubagentTool } from "@orbit/core/tool/plugin/subagent"
import { ToolOutput } from "@orbit/core/tool-output"
import { Tool } from "@orbit/core/tool"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { ID } from "@orbit/schema/shell"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { it, testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_output_cap")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ShellOutputCapTest.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("code"),
          model: sessionModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const shellPluginSupervisor = makeLocationNode({
  name: "test/shell-output-cap-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    FSUtil.node,
    Location.node,
    ManagedPolicy.node,
    Permission.node,
    ProjectTrust.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    PowerShellParse.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
  SdkPlugins.node,
  ManagedPolicy.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const shellIt = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(shellPluginSupervisor)]),
)
// Every built-in plugin, for what the context hooks advertise.
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
// A project that nothing trusts, where the core tests would otherwise trust every folder.
const untrustedIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...replacements,
    PluginSupervisor.node.replace(shellPluginSupervisor),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
  ]),
)

const isWindows = process.platform === "win32"
const helloCommand = isWindows ? "[Console]::Out.Write('hello')" : "printf hello"
// The end marker is assembled as the command runs, so the command text itself never contains it.
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-' + 'end')`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf 'output-''end'`
const overflowBytes = (bytes: number) => "output-start".length + bytes + "output-end".length
const startThenWait = isWindows ? "[Console]::Out.Write('start'); Start-Sleep -Seconds 30" : "printf start; sleep 30"
const startThenDone = isWindows
  ? "[Console]::Out.Write('start'); Start-Sleep -Seconds 1; [Console]::Out.Write('done')"
  : "printf start; sleep 1; printf done"
const floodCommand = isWindows
  ? "while ($true) { [Console]::Out.Write('x' * 10000); Start-Sleep -Milliseconds 10 }"
  : "line=$(head -c 10000 /dev/zero | tr '\\0' 'x'); while :; do printf '%s' \"$line\"; sleep 0.01; done"

const call = (
  input: Record<string, unknown>,
  id = "call-cap",
  messageID: SessionMessage.ID = SessionMessage.ID.create(),
) => ({
  sessionID,
  ...toolIdentity,
  messageID,
  call: { type: "tool-call" as const, id, name: "Bash", input },
})

const text = (result: { content?: ReadonlyArray<{ type: string; text?: string }> }) =>
  (result.content ?? []).map((part) => part.text ?? "").join("\n")

/** A session in a scratch folder whose orbit.json holds `config`. */
const inFolder = <A, E, R>(
  config: object | undefined,
  body: (registry: Tool.Interface, folder: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        if (config) yield* Effect.promise(() => Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify(config)))
        const sessions = yield* Session.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
        yield* sessions.create({ id: sessionID, title: "shell output cap", location, model: sessionModel })
        const locations = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          return yield* body(yield* Tool.Service, tmp.path)
        }).pipe(Effect.provide(locations.get(location)), Effect.ensuring(locations.invalidate(location)))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

/** Executes the call and settles it as the step does, with the limit the tool declares. */
const settled = (registry: Tool.Interface, input: ReturnType<typeof call>) =>
  Effect.gen(function* () {
    const traits = yield* toolTraits(registry, "Bash", input.call.input)
    const tools = yield* registry.snapshot()
    const result = yield* tools.execute(input)
    const toolOutput = yield* ToolOutput.Service
    const outcome = yield* toolOutput.settle({
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.call.id,
      tool: "Bash",
      limit: ToolOutput.threshold(traits.maxResultChars, undefined),
      result,
    })
    const persisted = outcome.metadata?.persisted as (ToolOutput.Persisted & { parts?: number }) | undefined
    return {
      outcome,
      persisted,
      saved: persisted === undefined ? undefined : path.join(toolOutput.root, persisted.session, persisted.name),
      root: toolOutput.root,
    }
  })

describe("ShellTool output cap", () => {
  // Fails on the base, which declares `Infinity` and bounds its own tail.
  shellIt.live("declares a 30,000-character result limit", () =>
    inFolder(undefined, (registry) =>
      Effect.gen(function* () {
        expect((yield* toolTraits(registry, "Bash", { command: helloCommand })).maxResultChars).toBe(30_000)
      }),
    ),
  )

  // Class 4 control. Fails on the base: the tail is stored and nothing is saved.
  shellIt.live(
    "saves output that does not fit and sends the head",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const result = yield* settled(registry, call({ command: overflowCommand(40_000) }))
          const head = text(result.outcome)
          expect(head).toStartWith("output-start")
          expect(head).not.toContain("output-end")
          expect(head.length).toBeLessThanOrEqual(30_000)
          expect(result.persisted).toMatchObject({
            session: sessionID,
            parts: 1,
            size: overflowBytes(40_000),
            format: 1,
          })
          const saved = yield* Effect.promise(() => fs.readFile(result.saved ?? "", "utf8"))
          expect(saved).toStartWith("output-start")
          expect(saved).toEndWith("output-end")
          expect(saved.length).toBe(overflowBytes(40_000))
          // A hard link of the kept shell file, which is on the same volume.
          expect((yield* Effect.promise(() => fs.stat(result.saved ?? ""))).nlink).toBe(2)
        }),
      ),
    { timeout: 30_000 },
  )

  // The control for the small case, which passes on the base.
  shellIt.live(
    "sends output that fits whole",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const result = yield* settled(registry, call({ command: helloCommand }))
          expect(result.persisted).toBeUndefined()
          expect(text(result.outcome)).toBe("hello")
        }),
      ),
    { timeout: 30_000 },
  )

  // Fails on the base, which stores the uncut tail. PowerShell's exit codes are not judged, so this runs where the shell
  // is a POSIX one (Linux CI and the Docker gate).
  if (!isWindows)
    shellIt.live(
      "never saves a failing command's output",
      () =>
        inFolder(undefined, (registry) =>
          Effect.gen(function* () {
            const result = yield* settled(registry, call({ command: `${overflowCommand(40_000)}; exit 3` }))
            expect(result.persisted).toBeUndefined()
            const shown = text(result.outcome)
            expect(shown).toStartWith("output-start")
            expect(shown).not.toContain("output-end")
            expect(shown).toContain("characters cut from the middle")
            expect(shown.length).toBeLessThan(11_000)
            expect(result.outcome.metadata?.error).toBe(true)
          }),
        ),
      { timeout: 30_000 },
    )

  // Fails on the base, whose `timeout` is an integer schema that refuses every string.
  shellIt.live(
    "accepts a timeout written as a decimal string",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const accepted = yield* executeTool(registry, call({ command: helloCommand, timeout: "5000" }))
          expect(accepted.status).toBe("completed")
          if (accepted.status === "completed") expect(text(accepted)).toBe("hello")
          const refused = yield* executeTool(registry, call({ command: helloCommand, timeout: "5s" }))
          expect(refused).toMatchObject({ status: "error", error: { type: "tool.input-invalid" } })
          // The model is still told the timeout is a number.
          const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "Bash")
          expect(definition?.inputSchema).toHaveProperty("properties.timeout.type", "integer")
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 4. Fails on the base only through the head check: nothing is saved there either.
  shellIt.live(
    "refuses a linked session folder and sends the head whole",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (outside) =>
          inFolder(undefined, (registry) =>
            Effect.gen(function* () {
              const toolOutput = yield* ToolOutput.Service
              yield* Effect.promise(() => fs.mkdir(toolOutput.root, { recursive: true }))
              yield* Effect.promise(() => fs.symlink(outside.path, path.join(toolOutput.root, sessionID), "junction"))
              const result = yield* settled(registry, call({ command: overflowCommand(40_000) }))
              expect(result.persisted).toBeUndefined()
              expect(text(result.outcome)).toStartWith("output-start")
              expect(text(result.outcome)).not.toContain("output-end")
              expect(yield* Effect.promise(() => fs.readdir(outside.path))).toEqual([])
            }),
          ),
        (outside) => Effect.promise(() => outside[Symbol.asyncDispose]()),
      ),
    { timeout: 30_000 },
  )

  // Class 5. `msg_tool_test` has an underscore, so it cannot name a file. Fails on the base only through the head check.
  shellIt.live(
    "saves nothing for a message ID that cannot name a file",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const result = yield* settled(
            registry,
            call({ command: overflowCommand(40_000) }, "call-cap", toolIdentity.messageID),
          )
          expect(result.persisted).toBeUndefined()
          expect(text(result.outcome)).toStartWith("output-start")
          expect(text(result.outcome)).not.toContain("output-end")
          expect(yield* Effect.promise(() => fs.readdir(result.root).catch(() => []))).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 5. Fails on the base, which saves nothing.
  shellIt.live(
    "reduces a hostile call ID to one segment",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const result = yield* settled(registry, call({ command: overflowCommand(40_000) }, "../../escape"))
          expect(result.persisted?.name).not.toMatch(/[\\/]/)
          expect(path.dirname(result.saved ?? "")).toBe(path.join(result.root, sessionID))
          expect(yield* Effect.promise(() => fs.readdir(path.dirname(result.root)))).not.toContain("escape")
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 4. Fails on the base, which saves nothing. The copy is cut to 64 MB; the marker keeps the original size.
  shellIt.live(
    "truncates a saved copy to 64 MB and keeps the original size",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const bytes = 64 * 1024 * 1024 + 1_000
          const result = yield* settled(registry, call({ command: overflowCommand(bytes) }))
          expect(result.persisted?.size).toBe(overflowBytes(bytes))
          expect((yield* Effect.promise(() => fs.stat(result.saved ?? ""))).size).toBe(64 * 1024 * 1024)
        }),
      ),
    { timeout: 180_000 },
  )

  // A replay of the same call keeps the copy saved first: the link onto that name fails, and so does the copy after it.
  // Fails when the copy's refusal of an existing name is taken for a failure, which sends the head whole.
  shellIt.live(
    "keeps the first saved copy when the same call is settled again",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const messageID = SessionMessage.ID.create()
          const first = yield* settled(registry, call({ command: overflowCommand(40_000) }, "call-replay", messageID))
          const second = yield* settled(registry, call({ command: overflowCommand(45_000) }, "call-replay", messageID))
          expect(first.persisted?.parts).toBe(1)
          expect(second.persisted?.name).toBe(first.persisted?.name ?? "")
          expect((yield* Effect.promise(() => fs.stat(second.saved ?? ""))).size).toBe(overflowBytes(40_000))
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 7: neither a link nor a copy can be made in a session folder nobody may write to, so the head goes whole and
  // nothing is marked. Fails when a failed copy is ignored, which marks a file that is not there. Permissions do not
  // bind root, and Windows has no mode bits, so this runs on Linux as a person who is not root (CI and the Docker gate).
  if (!isWindows && process.getuid?.() !== 0)
    shellIt.live(
      "sends the head whole when the saved copy cannot be made",
      () =>
        inFolder(undefined, (registry) =>
          Effect.gen(function* () {
            const toolOutput = yield* ToolOutput.Service
            const folder = path.join(toolOutput.root, sessionID)
            yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
            yield* Effect.promise(() => fs.chmod(folder, 0o500))
            const result = yield* settled(registry, call({ command: overflowCommand(40_000) })).pipe(
              Effect.ensuring(Effect.promise(() => fs.chmod(folder, 0o700))),
            )
            expect(result.persisted).toBeUndefined()
            expect(text(result.outcome)).toStartWith("output-start")
            expect(text(result.outcome)).not.toContain("output-end")
            expect(yield* Effect.promise(() => fs.readdir(folder))).toEqual([])
          }),
        ),
      { timeout: 30_000 },
    )

  // Fails on the base, which always writes "When output is large ..." without a number.
  const advertised = (config: object | undefined) =>
    inFolder(config, () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        const event = yield* hooks.trigger("session", "context", {
          sessionID,
          model: sessionModel,
          system: [],
          messages: [],
          options: {},
          agent: toolIdentity.agent,
          tools: {
            Bash: {
              description: "",
              input: {
                type: "object",
                properties: { timeout: { type: "integer" }, run_in_background: { type: "boolean" } },
              },
            },
            Agent: {
              description: SubagentTool.description,
              input: { type: "object", properties: { prompt: { type: "string" }, background: { type: "boolean" } } },
            },
          },
        } as never)
        const shell = event.tools.Bash ?? event.tools.PowerShell
        return {
          shell: {
            description: shell?.description ?? "",
            properties: Object.keys((shell?.input as { properties: object }).properties),
          },
          agent: {
            description: event.tools.Agent?.description ?? "",
            properties: Object.keys((event.tools.Agent?.input as { properties: object }).properties),
          },
        }
      }),
    )

  productionIt.live("states the head limit in the description", () =>
    Effect.gen(function* () {
      expect((yield* advertised(undefined)).shell.description).toMatch(/30,?000/)
      expect((yield* advertised({ tool_output: { max_bytes: 1_000 } })).shell.description).toMatch(/\b1,?000\b/)
    }),
  )

  // Fails on the base, which has no `background_tasks`. The defaults are the control.
  productionIt.live("hides background parameters and guidance when background tasks are off", () =>
    Effect.gen(function* () {
      const defaults = yield* advertised(undefined)
      expect(defaults.shell.properties).toContain("run_in_background")
      expect(defaults.agent.properties).toContain("background")
      const off = yield* advertised({ background_tasks: false })
      expect(off.shell.properties).not.toContain("run_in_background")
      expect(off.shell.description).not.toMatch(/background/i)
      expect(off.agent.properties).not.toContain("background")
      expect(off.agent.description).not.toMatch(/background/i)
    }),
  )

  // Fails on the base, which moves the command to the background at its deadline.
  shellIt.live(
    "kills a command at its timeout when background tasks are off",
    () =>
      inFolder({ background_tasks: false }, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call({ command: startThenWait, timeout: 1_000 }))
          expect(result.status).toBe("completed")
          if (result.status !== "completed") return
          expect(result.metadata).toMatchObject({ timeout: true })
          expect(result.metadata?.status).not.toBe("running")
          expect(text(result)).toContain("Command exceeded timeout of 1000 ms")
        }),
      ),
    { timeout: 30_000 },
  )

  // Fails on the base, which returns at once with a running background command.
  shellIt.live(
    "runs a background request in the foreground when background tasks are off",
    () =>
      inFolder({ background_tasks: false }, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call({ command: helloCommand, run_in_background: true }))
          expect(result.status).toBe("completed")
          if (result.status !== "completed") return
          expect(result.metadata?.status).not.toBe("running")
          expect(text(result)).toBe("hello")
        }),
      ),
    { timeout: 30_000 },
  )

  // Fails on the base, where the session's signal moves the command and the call returns the background notice.
  shellIt.live(
    "keeps a command in the foreground on the session signal when background tasks are off",
    () =>
      inFolder({ background_tasks: false }, (registry) =>
        Effect.gen(function* () {
          const jobs = yield* Job.Service
          const scope = yield* Scope.Scope
          const started = yield* Deferred.make<void>()
          const running = yield* executeTool(registry, {
            ...call({ command: startThenDone }),
            progress: (update) =>
              typeof update.shellID === "string" ? Deferred.succeed(started, undefined) : Effect.void,
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          yield* Deferred.await(started)
          yield* Effect.sleep(Duration.millis(200))
          yield* jobs.backgroundAll({ sessionID })
          const result = yield* Fiber.join(running)
          expect(result.status).toBe("completed")
          if (result.status !== "completed") return
          expect(result.metadata?.status).not.toBe("running")
          expect(text(result)).toContain("done")
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 8, the trusted control is "kills a command at its timeout ...". This passes on the base, where nothing reads the
  // key; it pins that the key stays withheld.
  untrustedIt.live(
    "withholds background_tasks in an untrusted folder",
    () =>
      inFolder({ background_tasks: false }, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call({ command: startThenWait, timeout: 1_000 }))
          expect(result.status).toBe("completed")
          if (result.status !== "completed") return
          expect(result.metadata?.status).toBe("running")
          const shell = yield* Shell.Service
          if (typeof result.metadata?.shellID === "string") yield* shell.kill(ID.make(result.metadata.shellID))
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 8 control. Fails on the base, where `max_bytes` bounds the tail.
  shellIt.live(
    "reads the configured head limit",
    () =>
      inFolder({ tool_output: { max_bytes: 1_000 } }, (registry) =>
        Effect.gen(function* () {
          const shown = text(yield* executeTool(registry, call({ command: overflowCommand(40_000) })))
          expect(shown).toStartWith("output-start")
          expect(shown.length).toBeLessThanOrEqual(1_000)
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 8. The repository's 1,000 is withheld, so the head is the default 30,000. Fails on the base through the head check.
  untrustedIt.live(
    "withholds the head limit in an untrusted folder",
    () =>
      inFolder({ tool_output: { max_bytes: 1_000 } }, (registry) =>
        Effect.gen(function* () {
          const shown = text(yield* executeTool(registry, call({ command: overflowCommand(40_000) })))
          expect(shown).toStartWith("output-start")
          expect(shown).not.toContain("output-end")
          expect(shown.length).toBeGreaterThan(29_000)
        }),
      ),
    { timeout: 30_000 },
  )

  // Class 8. Fails on the base, which has no such key.
  shellIt.live("classifies background_tasks as withheld", () =>
    Effect.sync(() => {
      expect(ConfigTrust.classification.info).toHaveProperty("background_tasks", { type: "withhold", kind: "settings" })
    }),
  )

  // Class 12, a moved command. Fails on the base, whose notification carries the tail.
  shellIt.live(
    "notifies a background command's head and names its file",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const delivered = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
            Stream.map((event) => (event.data.item.payload as { text: string }).text),
            Stream.filter((text) => text.includes('state="completed"')),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          const result = yield* executeTool(
            registry,
            call({ command: overflowCommand(40_000), run_in_background: true }),
          )
          if (result.status !== "completed" || typeof result.metadata?.shellID !== "string")
            throw new Error("Expected a background command")
          const shell = yield* Shell.Service
          const file = (yield* shell.get(ID.make(result.metadata.shellID))).file
          const notice = Array.from(yield* Fiber.join(delivered))[0] ?? ""
          expect(notice).toContain("output-start")
          expect(notice).not.toContain("output-end")
          expect(notice).toContain(file)
        }),
      ),
    { timeout: 30_000 },
  )
})

// A folder on another volume than the test's temporary folder, where the machine has one: tmpfs on Linux, or on Windows
// the drive of the checkout (its ignored `tmp` folder).
const otherVolume = await (async () => {
  const device = (await fs.stat(os.tmpdir())).dev
  const candidate = isWindows ? path.join(import.meta.dir, "..", "tmp") : "/dev/shm"
  if (isWindows) await fs.mkdir(candidate, { recursive: true })
  const stat = await fs.stat(candidate).catch(() => undefined)
  return stat?.isDirectory() && stat.dev !== device ? candidate : undefined
})()

/** The temporary data folder of `tempGlobalLayer`, with its `shell` folder linked to a folder on `volume`. */
const linkedShellGlobal = (volume: string) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const tmp = await tmpdir()
        const shells = await fs.mkdtemp(path.join(volume, "orbit-core-volume-"))
        await fs.mkdir(path.join(tmp.path, "data"), { recursive: true })
        await fs.symlink(shells, path.join(tmp.path, "data", Shell.DIRECTORY), "junction")
        return { tmp, shells }
      }),
      (made) =>
        Effect.promise(async () => {
          await made.tmp[Symbol.asyncDispose]()
          await fs.rm(made.shells, { recursive: true, force: true })
        }),
    ).pipe(
      Effect.map((made) => {
        const data = path.join(made.tmp.path, "data")
        return Global.layerWith({
          data,
          cache: path.join(made.tmp.path, "cache"),
          config: path.join(made.tmp.path, "config"),
          state: path.join(made.tmp.path, "state"),
          tmp: path.join(made.tmp.path, "tmp"),
          bin: path.join(made.tmp.path, "cache", "bin"),
          log: path.join(data, "log"),
          repos: path.join(data, "repos"),
        })
      }),
    ),
  )

// The shell file is on another volume than the session's tool-output folder, so no hard link can be made and the saved
// copy is a copy. Fails when a failed link saves nothing, which sends the head whole. Runs where the machine has a second
// volume: Linux CI, the Docker gate and Windows CI (the checkout's drive is not the temporary folder's).
if (otherVolume !== undefined)
  it.live(
    "copies the output to the session's folder when the shell file is on another volume",
    () =>
      inFolder(undefined, (registry) =>
        Effect.gen(function* () {
          const result = yield* settled(registry, call({ command: overflowCommand(40_000) }))
          expect(text(result.outcome)).toStartWith("output-start")
          expect(result.persisted).toMatchObject({ parts: 1, size: overflowBytes(40_000) })
          const saved = yield* Effect.promise(() => fs.readFile(result.saved ?? "", "utf8"))
          expect(saved).toStartWith("output-start")
          expect(saved).toEndWith("output-end")
          // A copy, not a link: the shell's own file is on the other volume.
          expect((yield* Effect.promise(() => fs.stat(result.saved ?? ""))).nlink).toBe(1)
        }),
      ).pipe(
        Effect.provide(
          AppNodeBuilder.build(nodes, [
            SessionExecution.node.replace(executionNode),
            Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
            Global.node.replace(linkedShellGlobal(otherVolume)),
            offlineModels,
            PluginSupervisor.node.replace(shellPluginSupervisor),
          ]),
        ),
      ),
    { timeout: 60_000 },
  )

// FU-M3-152, class 12: a moved command is watched. Fails on the base, which has no `Shell.nodeWith` (and no watchdog).
// The harness is built inside the test, with a background limit of 256 KiB checked every 50 ms.
it.live(
  "kills a moved command whose output passes the limit",
  () =>
    inFolder(undefined, (registry) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const delivered = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
          Stream.map((event) => (event.data.item.payload as { text: string }).text),
          Stream.filter((text) => !text.includes('state="waiting"')),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* executeTool(registry, call({ command: floodCommand, run_in_background: true }))
        const notice = Array.from(yield* Fiber.join(delivered).pipe(Effect.timeout(Duration.seconds(30))))[0] ?? ""
        expect(notice).toContain("Background command killed: output file exceeded")
      }),
    ).pipe(
      Effect.provide(
        AppNodeBuilder.build(nodes, [
          ...replacements,
          PluginSupervisor.node.replace(shellPluginSupervisor),
          Shell.node.replace(Shell.nodeWith({ backgroundLimit: 256 * 1024, watchInterval: Duration.millis(50) })),
        ]),
      ),
    ),
  { timeout: 60_000 },
)
