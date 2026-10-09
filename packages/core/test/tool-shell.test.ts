import fs from "fs/promises"
import { realpathSync, watch } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { Money } from "@orbit/schema/money"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@orbit/util/effect/app-node"
import { filesystem } from "@orbit/util/effect/app-node-platform"
import { Database } from "@orbit/core/database/database"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
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
import { PermissionSaved } from "@orbit/core/permission/saved"
import { Plugin } from "@orbit/core/plugin"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Shell } from "@orbit/core/shell"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { define } from "@orbit/plugin/effect/plugin"
import { ShellSelect } from "@orbit/core/shell/select"
import { ToolNames } from "@orbit/core/tool/names"
import { ID } from "@orbit/schema/shell"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { ToolOutput } from "@orbit/core/tool-output"
import { Tool } from "@orbit/core/tool"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { Expected } from "./lib/session-message"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })
const assertions: Permission.AssertInput[] = []
let denyAction: string | undefined
let hideShell = false
let activeGuard = ""
let afterPermission = (_input: Permission.AssertInput): Effect.Effect<void> => Effect.void

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(Effect.suspend(() => afterPermission(input))),
      Effect.andThen(
        input.action === denyAction
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  hideShell = false
  afterPermission = () => Effect.void
}

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ShellTest.complete")(function* (id: Session.ID) {
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
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
          text: "ok",
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
  name: "test/shell-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
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
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Permission.node.replace(permission),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(shellPluginSupervisor)]),
)
// A project that nothing trusts, where the core tests would otherwise trust every folder.
const untrustedIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...replacements,
    PluginSupervisor.node.replace(shellPluginSupervisor),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
  ]),
)
const permissionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, PermissionSaved.node]), [
    SessionExecution.node.replace(executionNode),
    Global.node.replace(tempGlobalLayer),
    PluginSupervisor.node.replace(shellPluginSupervisor),
    offlineModels,
  ]),
)

const call = (input: typeof ShellTool.Input.Type, id = "call-shell") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "Bash", input },
})

const isWindows = process.platform === "win32"
const cwdCommand = isWindows ? "(Get-Location).Path; Start-Sleep -Milliseconds 100" : "pwd"
const helloCommand = isWindows ? "[Console]::Out.Write('hello'); Start-Sleep -Milliseconds 100" : "printf hello"
const stderrCommand = isWindows
  ? "[Console]::Error.Write('stderr only'); Start-Sleep -Milliseconds 100"
  : "printf 'stderr only' >&2"
const mixedOutputCommand = isWindows
  ? "[Console]::Out.Write('stdout'); Start-Sleep -Milliseconds 50; [Console]::Error.Write('stderr'); Start-Sleep -Milliseconds 100"
  : "printf stdout; sleep 0.05; printf stderr >&2"
const idleCommand = isWindows ? "Start-Sleep -Seconds 60" : "sleep 60"
const bodyExitCommand = isWindows
  ? "[Console]::Out.Write('body'); Start-Sleep -Milliseconds 100; exit 7"
  : "printf body && exit 7"
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-end'); Start-Sleep -Milliseconds 100`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf output-end`
const lineOverflowCommand = isWindows
  ? "[Console]::Out.Write('one' + [Environment]::NewLine + 'two' + [Environment]::NewLine + 'three')"
  : "printf 'one\\ntwo\\nthree'"
const progressOverflowCommand = (bytes: number, release: string) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'; while [ ! -e '${release}' ]; do sleep 0.05; done`

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({
      id: sessionID,
      title: "shell test",
      location,
      model: sessionModel,
    })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const withScanner = <A, E, R>(
  portable: boolean,
  body: (registry: Tool.Interface, fixture: { active: string; outside: string }) => Effect.Effect<A, E, R>,
  shell = "sh",
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const fixture = { active: path.join(tmp.path, "active"), outside: path.join(tmp.path, "outside") }
        yield* Effect.promise(() => Promise.all([fs.mkdir(fixture.active), fs.mkdir(fixture.outside)]))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(fixture.active, "orbit.json"),
            JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
          ),
        )
        return yield* withSession(fixture.active, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure(shell))
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = []
              }),
            )
            return yield* body(registry, fixture)
          }),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

const runPermissionCommand = (
  registry: Tool.Interface,
  command: string,
  marker: string,
  replies: ReadonlyArray<Permission.Reply>,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const queue = yield* Queue.unbounded<Permission.Request>()
    yield* bus.subscribe(Permission.Event.Asked).pipe(
      Stream.runForEach((event) => Queue.offer(queue, event.data)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const execution = yield* executeTool(registry, call({ command }, `call-${Permission.ID.create()}`)).pipe(
      Effect.forkScoped,
    )
    const requests = yield* Effect.forEach(replies, (reply) =>
      Effect.gen(function* () {
        const request = yield* Queue.take(queue)
        expect(yield* permission.forSession(sessionID)).toEqual([request])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        yield* permission.reply({ requestID: request.id, reply })
        return request
      }),
    )
    const exit = yield* Fiber.await(execution)
    expect(yield* permission.list()).toEqual([])
    expect(yield* Queue.size(queue)).toBe(0)
    return { exit, requests }
    // A guard against a hung command, not a speed check: PowerShell's cold start alone can take most of five seconds.
  }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(15)))

// Directory cases still document inherited limitations; fixed scanner cases require matching behavior.
describe("ShellTool scanner permissions", () => {
  const test = isWindows || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live
  for (const portable of [false, true]) {
    const scanner = portable ? "native" : "legacy"

    test(`${scanner}: declarations reuse approvals while substitutions retain reject/once/always behavior`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["printf *"] })
          const marker = path.join(fixture.active, "marker")
          const approved = yield* runPermissionCommand(
            registry,
            "export SCAN_TEST=hello; unset SCAN_TEST; printf hello > marker",
            marker,
            [],
          )
          expect(approved.requests).toEqual([])
          expect(approved.exit).toMatchObject({
            _tag: "Success",
            value: { status: "completed", metadata: { exit: 0 } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
          expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

          yield* Effect.forEach(yield* saved.list(), (item) => saved.remove(item.id))
          const command = 'export SCAN_TEST=$(printf hello); printf %s "$SCAN_TEST" > marker'
          const prompts: Permission.Request[] = []
          for (const reply of ["reject", "once", "always", undefined] as const) {
            yield* Effect.promise(() => fs.rm(marker, { force: true }))
            const result = yield* runPermissionCommand(registry, command, marker, reply ? [reply] : [])
            prompts.push(...result.requests)
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
            if (reply === "once") expect(yield* saved.list()).toEqual([])
          }
          expect(prompts).toHaveLength(3)
          for (const request of prompts) {
            expect(request).toMatchObject({
              action: "Bash",
              resources: ["printf hello", 'printf %s "$SCAN_TEST" > marker'],
              save: ["printf *", "printf *"],
            })
          }
          expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "Bash", resource: "printf hello", effect: "deny" }]
            }),
          )
          yield* Effect.promise(() => fs.rm(marker))
          const denied = yield* runPermissionCommand(registry, command, marker, [])
          expect(denied.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: Bash") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))

    test(`${scanner}: pipeline redirect preserves exact approval and denial despite broad saved approval`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["printf hello", "cat"] })
          const marker = path.join(fixture.active, "marker")
          const command = "printf hello | cat > marker"
          const exact = yield* runPermissionCommand(registry, command, marker, [])
          expect(exact.requests).toEqual([])
          expect(exact.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

          yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["printf *", "cat *"] })
          yield* Effect.promise(() => fs.rm(marker))
          const broad = yield* runPermissionCommand(registry, command, marker, [])
          expect(broad.requests).toEqual([])
          expect(broad.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "Bash", resource: "cat", effect: "deny" }]
            }),
          )
          yield* Effect.promise(() => fs.rm(marker))
          const denied = yield* runPermissionCommand(registry, command, marker, [])
          expect(denied.requests).toEqual([])
          expect(denied.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: Bash") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))

    test(`${scanner}: external-directory rejection stops execution before a workspace marker is written`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "Bash", resource: "*", effect: "allow" }]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const command = `cd '${fixture.outside}' && pwd -P && printf reached > '${marker}'`
          for (const reply of ["reject", "once"] as const) {
            const result = yield* runPermissionCommand(registry, command, marker, [reply])
            expect(result.requests).toMatchObject([
              { action: "external_directory", resources: [path.join(fixture.outside, "*")] },
            ])
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: {
                status: "completed",
                metadata: { exit: 0 },
                content: [{ type: "text", text: `${fixture.outside}\n` }],
              },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          }
        }),
      ))

    test(`${scanner}: a numeric symlink operand still reaches outside without an external-directory prompt`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.symlink(fixture.outside, path.join(fixture.active, "123")))
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "Bash", resource: "*", effect: "allow" },
                { action: "external_directory", resource: "*", effect: "deny" },
              ]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const result = yield* runPermissionCommand(
            registry,
            `cd 123 && pwd -P && printf reached > '${marker}'`,
            marker,
            [],
          )
          expect(result.requests).toEqual([])
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: {
              status: "completed",
              metadata: { exit: 0 },
              content: [{ type: "text", text: `${fixture.outside}\n` }],
            },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
        }),
      ))

    test(`${scanner}: a continued directory operand asks for the wrong path and misses the destination deny`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "Bash", resource: "*", effect: "allow" },
                { action: "external_directory", resource: path.join(fixture.outside, "*"), effect: "deny" },
              ]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const command = `cd ../out\\\nside && pwd -P && printf reached > '${marker}'`
          for (const reply of ["reject", "once"] as const) {
            const result = yield* runPermissionCommand(registry, command, marker, [reply])
            expect(result.requests).toMatchObject([
              {
                action: "external_directory",
                resources: [
                  path.join(fixture.active, "..", portable ? "out\\\nside" : "out", "*").replaceAll("\\", "/"),
                ],
              },
            ])
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: {
                status: "completed",
                metadata: { exit: 0 },
                content: [{ type: "text", text: `${fixture.outside}\n` }],
              },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          }
        }),
      ))
  }
})

describe("ShellTool conditional process substitution", () => {
  const test = isWindows || !Bun.which("bash") ? permissionIt.live.skip : permissionIt.live
  for (const portable of [false, true]) {
    test(`${portable ? "native" : "legacy"}: a nested deny prevents the substitution from running`, () =>
      withScanner(
        portable,
        (registry, directory) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [
                  { action: "Bash", resource: "*", effect: "allow" },
                  { action: "Bash", resource: "printf *", effect: "deny" },
                ]
              }),
            )
            const marker = path.join(directory.active, "marker")
            const result = yield* runPermissionCommand(
              registry,
              '[[ -n <(printf reached > marker) ]]; wait "$!"',
              marker,
              [],
            )
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "error", error: { message: expect.stringContaining("Permission denied: Bash") } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          }),
        "bash",
      ))

    for (const reply of ["reject", "once", "always"] as const) {
      test(`${portable ? "native" : "legacy"}: conditional substitutions respect ${reply}`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["wait *"] })
              const marker = path.join(directory.active, "marker")
              const command = '[[ -n <(printf reached > marker) ]]; wait "$!"'
              const result = yield* runPermissionCommand(registry, command, marker, [reply])
              expect(result.requests).toMatchObject([
                { action: "Bash", resources: ["printf reached > marker", 'wait "$!"'], save: ["printf *", "wait *"] },
              ])
              if (reply === "reject") {
                expect(Exit.isFailure(result.exit)).toBe(true)
                expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
                return
              }
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: { status: "completed", metadata: { exit: 0 } },
              })
              expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
              yield* Effect.promise(() => fs.unlink(marker))
              const repeat = yield* runPermissionCommand(
                registry,
                command,
                marker,
                reply === "always" ? [] : ["reject"],
              )
              expect(repeat.requests).toHaveLength(reply === "always" ? 0 : 1)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(reply === "always")
            }),
          "bash",
        ))
    }
  }
})

describe("ShellTool compound syntax approval compatibility", () => {
  for (const fixture of [
    {
      shell: "zsh",
      command: 'for value (a b) printf %s "$value"',
      equivalent: 'for value in a b; do printf %s "$value"; done',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value (a b) { printf %s "$value"; }',
      equivalent: 'for value in a b; do printf %s "$value"; done',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value ($(printf a)) do printf %s "$value"; done',
      equivalent: 'for value in $(printf a); do printf %s "$value"; done',
      output: "a",
      saved: ["printf *"],
    },
    {
      shell: "bash",
      command: 'probe() for value in a b; do printf %s "$value"; done; probe',
      equivalent: 'probe() { for value in a b; do printf %s "$value"; done; }; probe',
      output: "ab",
      saved: ["printf *", "probe *"],
    },
    {
      shell: "bash",
      command: 'printf %s "$(probe() case value in value) printf hello;; esac; probe)"',
      equivalent: 'printf %s "$(probe() { case value in value) printf hello;; esac; }; probe)"',
      output: "hello",
      saved: ["printf *", "probe *"],
    },
  ]) {
    const test = isWindows || !Bun.which(fixture.shell) ? permissionIt.live.skip : permissionIt.live
    for (const portable of [false, true]) {
      test(`${fixture.shell} ${portable ? "native" : "legacy equivalent"}: ${fixture.command}`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({ projectID: location.project.id, action: "Bash", resources: fixture.saved })
              const result = yield* runPermissionCommand(
                registry,
                portable ? fixture.command : fixture.equivalent,
                path.join(directory.active, "marker"),
                [],
              )
              expect(result.requests).toEqual([])
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: {
                  status: "completed",
                  metadata: { exit: 0 },
                  content: [{ type: "text", text: fixture.output }],
                },
              })
            }),
          fixture.shell,
        ))
    }
  }
})

describe("ShellTool ordinary shell syntax", () => {
  for (const shell of ["bash", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? permissionIt.live.skip : permissionIt.live
    for (const portable of [false, true]) {
      for (const fixture of [
        { name: "quoted heredoc", command: "cat <<'EOF'\nhello\nEOF", output: "hello\n", saved: ["cat *"] },
        {
          name: "heredoc substitution",
          command: "cat <<EOF\n$(printf hello)\nEOF",
          output: "hello\n",
          saved: ["cat *", "printf *"],
        },
        {
          name: "loop with a conditional",
          command: 'for value in a b; do if test -n "$value"; then printf %s "$value"; fi; done',
          output: "ab",
          saved: ["test *", "printf *"],
        },
        {
          name: "function and case",
          command: 'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
          output: "hello",
          saved: ["greet *", "printf *"],
        },
        {
          name: "parameter fallback",
          command: 'value=; printf %s "${value:-fallback}"',
          output: "fallback",
          saved: ["printf *"],
        },
        {
          name: "arithmetic statement",
          command: 'count=1; ((count += 1)); printf %s "$count"',
          output: "2",
          saved: ["((count += 1)) *", "printf *"],
        },
        { name: "ANSI-C quoting", command: "printf %s $'a\\nb'", output: "a\nb", saved: ["printf *"] },
      ]) {
        test(`${shell} ${portable ? "native" : "legacy"}: ${fixture.name} reuses existing approvals`, () =>
          withScanner(
            portable,
            (registry, directory) =>
              Effect.gen(function* () {
                const saved = yield* PermissionSaved.Service
                const location = yield* Location.Service
                yield* saved.add({ projectID: location.project.id, action: "Bash", resources: fixture.saved })
                const result = yield* runPermissionCommand(
                  registry,
                  fixture.command,
                  path.join(directory.active, "marker"),
                  [],
                )
                expect(result.requests).toEqual([])
                expect(result.exit).toMatchObject({
                  _tag: "Success",
                  value: {
                    status: "completed",
                    metadata: { exit: 0 },
                    content: [{ type: "text", text: fixture.output }],
                  },
                })
              }),
            shell,
          ))
      }

      test(`${shell} ${portable ? "native" : "legacy"}: a loop body deny prevents execution`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const agents = yield* Agent.Service
              yield* agents.transform((editor) =>
                editor.update(toolIdentity.agent, (agent) => {
                  agent.permissions = [
                    { action: "Bash", resource: "*", effect: "allow" },
                    { action: "Bash", resource: "printf *", effect: "deny" },
                  ]
                }),
              )
              const marker = path.join(directory.active, "marker")
              const result = yield* runPermissionCommand(
                registry,
                "for value in a; do printf body > marker; done",
                marker,
                [],
              )
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: { status: "error", error: { message: expect.stringContaining("Permission denied: Bash") } },
              })
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            }),
          shell,
        ))
    }
  }

  const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh ? permissionIt.live : permissionIt.live.skip
  for (const portable of [false, true]) {
    for (const command of [
      'Write-Output "$(Write-Output hello)"',
      '$value = "hello"; Write-Output $value',
      "if ($true) { Write-Output hello } else { Write-Output other }",
      "foreach ($value in @('hello')) { Write-Output $value }",
      "ForEach-Object { Write-Output hello }",
      "function Show-Value { Write-Output hello }; Show-Value",
      "Write-Output `\n  hello",
      "Write-Output @'\nhello\n'@",
    ]) {
      test(
        `PowerShell ${portable ? "native" : "legacy"}: ordinary syntax reuses approvals: ${command}`,
        () =>
          withScanner(
            portable,
            (registry, directory) =>
              Effect.gen(function* () {
                const saved = yield* PermissionSaved.Service
                const location = yield* Location.Service
                yield* saved.add({
                  projectID: location.project.id,
                  action: "Bash",
                  resources: ["Write-Output *", "Show-Value *"],
                })
                const result = yield* runPermissionCommand(registry, command, path.join(directory.active, "marker"), [])
                expect(result.requests).toEqual([])
                expect(result.exit).toMatchObject({
                  _tag: "Success",
                  value: { status: "completed", metadata: { exit: 0 } },
                })
                if (Exit.isSuccess(result.exit))
                  expect(result.exit.value.content?.[0]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
              }),
            pwsh ?? "pwsh",
          ),
        // The first command pays for PowerShell's cold start, which alone can exceed the default five seconds.
        { timeout: 15_000 },
      )
    }
  }

  for (const [command, pattern] of [
    ["Write-Output\thello", "Write-Output\t*"],
    ["& 'Write-Output' hello", "& 'Write-Output' *"],
    ["Write-Output `\n  hello", "Write-Output *"],
  ]) {
    test(
      `PowerShell native: always allow covers repeat execution and preserves exact deny: ${command}`,
      () =>
        withScanner(
          true,
          (registry, directory) =>
            Effect.gen(function* () {
              const marker = path.join(directory.active, "marker")
              const first = yield* runPermissionCommand(registry, command, marker, ["always"])
              expect(first.requests).toMatchObject([{ action: "Bash", resources: [command], save: [pattern] }])
              expect(first.exit).toMatchObject({
                _tag: "Success",
                value: { status: "completed", metadata: { exit: 0 } },
              })
              const repeat = yield* runPermissionCommand(registry, command, marker, [])
              expect(repeat.requests).toEqual([])
              expect(repeat.exit).toMatchObject({
                _tag: "Success",
                value: { status: "completed", metadata: { exit: 0 } },
              })

              const agents = yield* Agent.Service
              yield* agents.transform((editor) =>
                editor.update(toolIdentity.agent, (agent) => {
                  agent.permissions = [{ action: "Bash", resource: command, effect: "deny" }]
                }),
              )
              const denied = yield* runPermissionCommand(registry, command, marker, [])
              expect(denied.exit).toMatchObject({
                _tag: "Success",
                value: { status: "error", error: { message: expect.stringContaining("Permission denied: Bash") } },
              })
            }),
          pwsh ?? "pwsh",
        ),
      { timeout: 15_000 },
    )
  }
})

describe("ShellTool", () => {
  it.live("runs alone and cancels its siblings when it fails, until the shell analysis answers the rest", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* toolTraits(registry, "Bash", { command: "echo", description: "echo" })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              cancelSiblingsOnFailure: true,
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns both parallel CodeMode shell results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* registry.transform((editor) =>
              editor.update("Bash", (tool) => {
                tool.options = { ...tool.options, codemode: true }
              }),
            )
            const command = isWindows ? helloCommand : `${helloCommand}; sleep 0.1`
            const inputs = ["one", "two"].map((text) => JSON.stringify({ command: command.replace("hello", text) }))
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-parallel-shells",
                name: "Execute",
                input: { code: `return await Promise.all([tools.Bash(${inputs[0]}), tools.Bash(${inputs[1]})])` },
              },
            }).pipe(Effect.timeout("3 seconds"))
            expect(result.status).toBe("completed")
            expect(JSON.parse(result.output.output)).toEqual([
              { output: "one", exit: 0, truncated: false, status: "completed" },
              { output: "two", exit: 0, truncated: false, status: "completed" },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  productionIt.live(
    "registers and returns real successful output from the active Location",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const definitions = yield* toolDefinitions(registry)
              const definition = definitions.find((tool) => tool.name === "Bash")
              expect(definition?.description).toStartWith("Execute a shell command and return its output.")
              expect(definition?.inputSchema).not.toHaveProperty("properties.timeout.maximum")
              // Code Mode receives the declared output schema, including the command output text.
              expect(definition?.outputSchema).toHaveProperty("properties.output")
              expect(
                (yield* toolDefinitions(registry, [{ action: "Bash", resource: "*", effect: "deny" }])).map(
                  (tool) => tool.name,
                ),
              ).not.toContain("Bash")

              const settled = yield* executeTool(registry, call({ command: helloCommand }))
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(settled.content).toEqual([{ type: "text", text: "hello" }])
              expect(assertions).toMatchObject([
                {
                  sessionID,
                  action: "Bash",
                  resources: [isWindows ? "Start-Sleep -Milliseconds 100" : helloCommand],
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-shell" },
                },
              ])
              expect(assertions[0]?.save).toEqual([isWindows ? "Start-Sleep *" : "printf *"])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "uses the session environment instead of the server environment",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { ORBIT_SESSION_ENV_TEST: "from-session" },
              })
              const command = isWindows
                ? "[Console]::Out.Write($env:ORBIT_SESSION_ENV_TEST)"
                : 'printf %s "$ORBIT_SESSION_ENV_TEST"'

              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[0]).toEqual({ type: "text", text: "from-session" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "identifies agent shell commands without inheriting a stale session ID",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { AGENT: "0", ORBIT: "0", AI_AGENT: "", ORBIT_SESSION_ID: "stale" },
              })
              const command = isWindows
                ? '[Console]::Out.Write("$env:AGENT|$env:ORBIT|$env:AI_AGENT|$env:ORBIT_SESSION_ID")'
                : 'printf %s "$AGENT|$ORBIT|$AI_AGENT|$ORBIT_SESSION_ID"'
              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[0]).toEqual({ type: "text", text: `1|1|orbit|${sessionID}` })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "preserves an outer AI_AGENT marker in agent shell commands",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({ sessionID, variables: { AI_AGENT: "outer-agent" } })
              const command = isWindows ? "[Console]::Out.Write($env:AI_AGENT)" : 'printf %s "$AI_AGENT"'
              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[0]).toEqual({ type: "text", text: "outer-agent" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled.content?.[0]).toMatchObject(
                Expected.text(expect.stringContaining(realpathSync(path.join(tmp.path, "src")))),
              ),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("reports a missing workdir", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: cwdCommand, workdir: "missing" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled).toEqual({
                status: "error",
                error: {
                  type: "unknown",
                  message: `Working directory does not exist: ${path.join(tmp.path, "missing")}`,
                },
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "permissions compound commands separately",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: "printf one && printf two" }, "call-compound")),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions).toHaveLength(1)
                expect(assertions[0]).toMatchObject({
                  resources: ["printf one", "printf two"],
                  save: ["printf *", "printf *"],
                })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "captures stderr-only and mixed stdout/stderr output",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const stderr = yield* executeTool(registry, call({ command: stderrCommand }, "call-stderr"))
              expect(stderr.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(stderr.content?.[0]).toEqual({ type: "text", text: "stderr only" })

              const mixed = yield* executeTool(registry, call({ command: mixedOutputCommand }, "call-mixed"))
              expect(mixed.metadata).toMatchObject({ exit: 0, truncated: false })
              const output = mixed.content?.[0]?.type === "text" ? mixed.content[0].text : ""
              expect(output).toContain("stdout")
              expect(output).toContain("stderr")
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "Bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled).toMatchObject({
                status: "error",
                error: { message: `Working directory is not a directory: ${workdir}` },
              })
              expect(assertions.map((input) => input.action)).toEqual(["Bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "approves an explicit external workdir before shell execution",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          reset()
          return withSession(active.path, (registry) =>
            executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "Bash"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  // A client shows the folder a command runs in from the request, so the request names it as resolved here, whatever
  // spelling the call used: `~` is the home folder (class 8, approval display).
  const spellings = (active: string, outside: string) => [
    { workdir: `~/${path.relative(Global.Path.home, outside)}`, runs: outside },
    { workdir: `../${path.basename(outside)}`, runs: outside },
    { workdir: outside, runs: outside },
    { workdir: "src", runs: path.join(active, "src") },
    ...(isWindows
      ? [{ workdir: `/${outside[0]!.toLowerCase()}${outside.slice(2).replaceAll("\\", "/")}`, runs: outside }]
      : []),
  ]
  it.live(
    "names the resolved folder on the shell approval for each workdir spelling",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.promise(() => fs.mkdir(path.join(active.path, "src"))).pipe(
            Effect.andThen(
              Effect.forEach(spellings(active.path, outside.path), (row) => {
                reset()
                return withSession(active.path, (registry) =>
                  executeTool(registry, call({ command: cwdCommand, workdir: row.workdir })),
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() =>
                      expect([row.workdir, assertions.find((item) => item.action === "Bash")?.metadata]).toEqual([
                        row.workdir,
                        { workdir: row.runs },
                      ]),
                    ),
                  ),
                )
              }),
            ),
          ),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 60_000 },
  )

  it.live(
    "deduplicates external directory approvals across workdir and directory-change commands",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          const command = isWindows
            ? `Set-Location -LiteralPath '${outside.path}'; (Get-Location).Path`
            : `cd '${outside.path}' && pwd`
          return withSession(active.path, (registry) =>
            Effect.forEach([{ command }, { command, workdir: outside.path }], (input) =>
              Effect.gen(function* () {
                reset()
                const settled = yield* executeTool(registry, call(input, "call-external-cd"))
                expect(settled).toMatchObject({ status: "completed" })
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "Bash"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                  sessionID,
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-external-cd" },
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("approves an expanded external home directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const command = isWindows ? "Set-Location $HOME; (Get-Location).Path" : "cd ~ && pwd"
        return withSession(tmp.path, (registry) => executeTool(registry, call({ command }, "call-external-home"))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "Bash"])
              expect(assertions[0]?.resources[0]).toStartWith(os.homedir().replaceAll("\\", "/"))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  // A repository that is not trusted can ship a link into a folder that Orbit lets every agent reach by itself, here the
  // global config folder. A command that runs there, or changes into it, asks about the real folder, marked as one a
  // link leads to so that only the person's own rules decide it, and the approval names that folder. A trusted project's
  // link is its own (class 4, class 8).
  for (const trusted of [false, true])
    (trusted ? it : untrustedIt).live(
      `${trusted ? "a trusted" : "an untrusted"} project's link into the global config folder ${trusted ? "is the project's own" : "is asked about and shown as that folder"}`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (active) =>
            Effect.gen(function* () {
              const global = yield* Global.Service
              yield* Effect.promise(async () => {
                await fs.writeFile(path.join(global.config, "marker.txt"), "marker\n")
                await fs.symlink(global.config, path.join(active.path, "cfg"), "junction")
              })
              const config = FSUtil.resolve(global.config)
              const linked = path.join(active.path, "cfg")
              const folder = path.join(config, "*").replaceAll("\\", "/")
              const rows = [
                { input: { command: cwdCommand, workdir: "cfg" }, workdir: trusted ? linked : config },
                { input: { command: `cd cfg; ${cwdCommand}` }, workdir: active.path },
                // A plain word of the command, and a file it writes to, through the link.
                { input: { command: "cat cfg/marker.txt" }, workdir: active.path },
                { input: { command: "echo planted > cfg/planted.txt" }, workdir: active.path },
                // Windows starts a process in `cfg.` as in `cfg`, while Bun's own `stat` finds no `cfg.`.
                ...(isWindows
                  ? [
                      { input: { command: cwdCommand, workdir: "cfg." }, workdir: trusted ? linked : config },
                      { input: { command: cwdCommand, workdir: "cfg " }, workdir: trusted ? linked : config },
                    ]
                  : []),
              ]
              yield* withSession(active.path, (registry) =>
                Effect.forEach(rows, (row) =>
                  Effect.gen(function* () {
                    reset()
                    expect(yield* executeTool(registry, call(row.input, "call-link"))).toMatchObject({
                      status: "completed",
                    })
                    expect(assertions.map((item) => item.action)).toEqual(
                      trusted ? ["Bash"] : ["external_directory", "Bash"],
                    )
                    if (!trusted) expect(assertions[0]).toMatchObject({ resources: [folder], escaped: [folder] })
                    expect(assertions.at(-1)?.metadata).toEqual({ workdir: row.workdir })
                  }),
                ),
              )
            }),
          (active) => Effect.promise(() => active[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 30_000 },
    )

  it.live(
    "does not execute after external-directory or shell denial",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.gen(function* () {
            reset()
            denyAction = "external_directory"
            yield* withSession(active.path, (registry) =>
              executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
            )
            expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

            reset()
            denyAction = "Bash"
            yield* withSession(active.path, (registry) => executeTool(registry, call({ command: cwdCommand })))
            expect(assertions.map((item) => item.action)).toEqual(["Bash"])
          }),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  // Read from the registry the model's tool list is built from, so a name built from a variable or registered by a
  // plugin elsewhere is seen too.
  productionIt.live("advertises no built-in tool under a name the alias table lists as an old one", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
            // The control: the registry is the full set, and the old names are in the table.
            expect(names).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent"]))
            expect(Object.keys(ToolNames.tools)).toContain("shell")
            expect(names.filter((name) => Object.hasOwn(ToolNames.tools, name))).toEqual([])
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  // A plugin guard written before the rename reads `input.background`; the call carries `run_in_background`.
  productionIt.live(
    "a plugin hook reads the old field names of the call it is shown, and the tool still gets the real input",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const hooks = yield* PluginHooks.Service
              const seen: unknown[] = []
              yield* hooks.register("tool", "execute.before", (event) =>
                Effect.sync(() => {
                  const input = event.input as Record<string, unknown>
                  seen.push({
                    old: input.background,
                    current: input.run_in_background,
                    keys: Object.keys(input).sort(),
                  })
                  input.background = false
                }),
              )
              const settled = yield* executeTool(
                registry,
                call({ command: helloCommand, run_in_background: true }, "call-view"),
              )
              expect(seen).toEqual([{ old: true, current: true, keys: ["command", "run_in_background"] }])
              // The guard's write under the old name reached the real field: the command ran in the foreground.
              expect(settled.status).toBe("completed")
              expect(settled.content).toEqual([{ type: "text", text: "hello" }])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  // A hook that confines a call by returning a copy of the input with the old field, or that clones the input, is not ignored.
  for (const replace of [
    (input: Record<string, unknown>) => ({ ...input, background: false }),
    (input: Record<string, unknown>) => ({ ...structuredClone(input), background: false }),
  ]) {
    productionIt.live(
      "a hook that replaces the input with a copy that uses an old field name changes the call",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const hooks = yield* PluginHooks.Service
                yield* hooks.register("tool", "execute.before", (event) =>
                  Effect.sync(() => {
                    event.input = replace(event.input as Record<string, unknown>)
                  }),
                )
                const settled = yield* executeTool(
                  registry,
                  call({ command: helloCommand, run_in_background: true }, "call-replaced"),
                )
                // The background flag the hook turned off reached the tool: the command ran in the foreground.
                expect(settled.status).toBe("completed")
                expect(settled.content).toEqual([{ type: "text", text: "hello" }])
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )
  }

  productionIt.live("offers the tool as PowerShell only when the session shell is PowerShell", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const offered = (shell: string) =>
            withSession(tmp.path, () =>
              Effect.gen(function* () {
                const selection = yield* ShellSelect.Service
                yield* selection.transform((editor) => editor.configure(shell))
                const hooks = yield* PluginHooks.Service
                const event = yield* hooks.trigger("session", "context", {
                  sessionID,
                  model: sessionModel,
                  system: [],
                  messages: [],
                  options: {},
                  agent: toolIdentity.agent,
                  tools: { Bash: { description: "", input: {} } },
                } as never)
                return Object.keys(event.tools)
              }),
            )
          // Not every machine has both shells; a missing one falls back to the default, which is still one of the two.
          const sh = yield* offered("sh")
          expect(sh).toHaveLength(1)
          expect(["Bash", "PowerShell"]).toContain(sh[0])
          if (isWindows) expect(yield* offered("powershell")).toEqual(["PowerShell"])
          else expect(sh).toEqual(["Bash"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  // The shell has three names: `shell` (before the rename), `Bash` and `PowerShell`. A hook written for any of the first two
  // must reach the tool whichever shell the session has, because the model is offered it as `PowerShell` only at the end.
  for (const shell of ["sh", "powershell"]) {
    for (const plugin of [
      { kind: "a plugin written for the old names", toolNames: undefined, guard: "shell" },
      { kind: "a plugin that opted in to the reference names", toolNames: "reference" as const, guard: "Bash" },
    ]) {
      for (const spelling of ["shell", "Bash"]) {
        productionIt.live(
          `session shell ${shell}: ${plugin.kind} hides the tool with ${spelling} and blocks it as ${plugin.guard}`,
          () =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (tmp) =>
                Effect.gen(function* () {
                  reset()
                  const sdk = yield* SdkPlugins.Service
                  const pluginID = `test.shell-guard.${shell}.${plugin.guard}.${spelling}`
                  activeGuard = pluginID
                  yield* sdk.register(
                    define({
                      id: pluginID,
                      ...(plugin.toolNames ? { toolNames: plugin.toolNames } : {}),
                      effect: (ctx) =>
                        Effect.gen(function* () {
                          yield* ctx.session.hook("context", (event) =>
                            Effect.sync(() => {
                              if (hideShell && activeGuard === pluginID) delete event.tools[spelling]
                            }),
                          )
                          yield* ctx.tool.hook("execute.before", (event) =>
                            activeGuard === pluginID && event.tool === plugin.guard
                              ? Effect.fail(new Tool.Error({ message: `blocked by ${pluginID}` }))
                              : Effect.void,
                          )
                        }),
                    }),
                  )
                  yield* withSession(tmp.path, (registry) =>
                    Effect.gen(function* () {
                      const selection = yield* ShellSelect.Service
                      yield* selection.transform((editor) => editor.configure(shell))
                      const hooks = yield* PluginHooks.Service
                      const request = () =>
                        hooks.trigger("session", "context", {
                          sessionID,
                          model: sessionModel,
                          system: [{ type: "text", text: "Fall back to Bash when a tool cannot do it." }],
                          messages: [],
                          options: {},
                          agent: toolIdentity.agent,
                          // As `SessionModelRequest` hands them over: a name written before the rename reaches the entry.
                          tools: ToolNames.aliased({ Bash: { description: "", input: {} } }),
                        } as never)
                      // Control: without the hide, the tool is offered under exactly one of its two names.
                      hideShell = false
                      const control = yield* request()
                      const offered = Object.keys(control.tools)
                      expect(offered).toHaveLength(1)
                      expect(["Bash", "PowerShell"]).toContain(offered[0])
                      // The prompt names the tool the model is offered.
                      expect(control.system[0]?.text).toBe(`Fall back to ${offered[0]} when a tool cannot do it.`)

                      hideShell = true
                      expect(Object.keys((yield* request()).tools)).toEqual([])

                      // The call comes in under the name it was offered with, and the guard still sees the tool.
                      const snapshot = yield* registry.snapshot()
                      const bash = snapshot.definitions.find((tool) => tool.name === "Bash")
                      if (!bash) return yield* Effect.die(new Error("Bash is not registered"))
                      const failure = yield* snapshot
                        .execute({
                          ...call({ command: helloCommand }, "call-guarded"),
                          call: { ...call({ command: helloCommand }, "call-guarded").call, name: offered[0]! },
                          definitions: new Map([[offered[0]!, bash]]),
                        })
                        .pipe(Effect.flip)
                      expect(failure.message).toBe(`blocked by ${pluginID}`)
                    }),
                  )
                }),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
            ),
          { timeout: 30_000 },
        )
      }
    }
  }

  // An output style is the person's own text and is appended to the base prompt before the tool is offered as PowerShell.
  productionIt.live(
    "rewrites the shell name in the base prompt and leaves an output style as written",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withSession(tmp.path, () =>
            Effect.gen(function* () {
              const selection = yield* ShellSelect.Service
              yield* selection.transform((editor) => editor.configure("powershell"))
              const hooks = yield* PluginHooks.Service
              const event = yield* hooks.trigger("session", "context", {
                sessionID,
                model: sessionModel,
                system: [{ type: "text", text: "Use Bash for it.\n\n# Output style: Terse\nPrefer Git Bash." }],
                messages: [],
                options: {},
                agent: toolIdentity.agent,
                tools: ToolNames.aliased({ Bash: { description: "", input: {} } }),
              } as never)
              // Only a machine that has PowerShell offers it; elsewhere the session falls back to the default shell.
              expect(event.system[0]?.text).toBe(
                `Use ${isWindows ? "PowerShell" : "Bash"} for it.\n\n# Output style: Terse\nPrefer Git Bash.`,
              )
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 30_000 },
  )

  it.live("exposes malformed native syntax without fallback or partial execution", () =>
    Effect.gen(function* () {
      if (isWindows) return
      for (const portable of [false, true]) {
        yield* Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              reset()
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(tmp.path, "orbit.json"),
                  JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
                ),
              )
              const settled = yield* withSession(tmp.path, (registry) =>
                Effect.gen(function* () {
                  const selection = yield* ShellSelect.Service
                  yield* selection.transform((editor) => editor.configure("sh"))
                  return yield* executeTool(
                    registry,
                    call({ command: 'printf hello > marker\necho "' }, "call-portable-malformed"),
                  )
                }),
              )
              if (portable) {
                expect(settled).toMatchObject({
                  status: "error",
                  error: { message: expect.stringContaining("unterminated-quote") },
                })
                expect(assertions).toEqual([])
                expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker")).exists())).toBe(false)
                return
              }
              expect(settled.status).toBe("completed")
              expect(settled.metadata?.exit).not.toBe(0)
              expect(assertions.map((item) => item.action)).toEqual(["Bash"])
              expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker")).text())).toBe("hello")
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        )
      }
    }),
  )

  for (const shell of ["sh", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? it.live.skip : it.live
    test(
      `preserves arithmetic and directory permissions with scanner flag on and off in ${shell}`,
      () =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach([false, true], (portable) =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (tmp) =>
                Effect.gen(function* () {
                  reset()
                  yield* Effect.promise(() =>
                    Bun.write(
                      path.join(tmp.path, "orbit.json"),
                      JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
                    ),
                  )
                  yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "one", "two"), { recursive: true }))
                  yield* withSession(tmp.path, (registry) =>
                    Effect.gen(function* () {
                      const selection = yield* ShellSelect.Service
                      yield* selection.transform((editor) => editor.configure(shell))
                      for (const [command, output] of [
                        ["echo $((1 + 1))", "2\n"],
                        ["cd ~ && pwd", `${realpathSync(os.homedir())}\n`],
                        ["cd one&&cd two&&pwd", `${path.join(tmp.path, "one", "two")}\n`],
                      ]) {
                        const settled = yield* executeTool(registry, call({ command }, `call-parity-${command}`))
                        expect(settled.status).toBe("completed")
                        expect(settled.metadata).toMatchObject({ exit: 0 })
                        expect(settled.content?.[0]).toMatchObject({ type: "text", text: output })
                      }
                    }),
                  )
                  expect(assertions.map((item) => item.action)).toEqual(["Bash", "external_directory", "Bash", "Bash"])
                  expect(assertions[1]?.resources).toEqual([path.join(realpathSync(os.homedir()), "*")])
                  expect(assertions[0]).toMatchObject({ resources: ["echo $((1 + 1))"], save: ["echo *"] })
                  expect(assertions[2]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
                  expect(assertions[3]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
                  return assertions.slice()
                }),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
            ),
          )
          expect(results[1]).toEqual(results[0])
        }),
      { timeout: 15_000 },
    )
  }

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: bodyExitCommand }, "call-nonzero")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 7, truncated: false })
              expect(settled.content?.[0]).toEqual({ type: "text", text: "body" })
              expect(settled.content?.[1]).toMatchObject(Expected.text(expect.stringContaining("Exited with code 7")))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "truncates the model view and points at the saved output file when output overflows",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const bytes = ToolOutput.MAX_BYTES + 1024
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: overflowCommand(bytes) }, "call-overflow")),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
                const content = settled.content?.[0]
                if (!content || content.type !== "text") throw new Error("Expected text content")
                expect(content.text.includes("output-start")).toBe(false)
                expect(content.text.includes("output-end")).toBe(true)
                expect(content).toMatchObject(Expected.text(expect.stringContaining("full output saved to ")))
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("uses configured line limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tmp.path, "orbit.json"),
              JSON.stringify({ tool_output: { max_lines: 2, max_bytes: 1_000 } }),
            ),
          )
          const settled = yield* withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: lineOverflowCommand }, "call-line-overflow")),
          )
          expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
          const content = settled.content?.[0]
          if (!content || content.type !== "text") throw new Error("Expected text content")
          expect(content.text).not.toContain("one")
          // Windows shells emit CRLF; the assertion targets line limits, not line endings.
          expect(content.text.replaceAll("\r\n", "\n")).toStartWith("two\nthree")
          expect(content.text).toContain("full output saved to ")
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "reports the shell ID for a running command",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const release = "shell-progress-release"
          const releasePath = path.join(tmp.path, release)
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const observed = yield* Deferred.make<string>()
              yield* executeTool(registry, {
                ...call({ command: progressOverflowCommand(ToolOutput.MAX_BYTES + 1024, release) }, "call-progress"),
                progress: (update) =>
                  Effect.gen(function* () {
                    if (typeof update.shellID !== "string") return
                    yield* Deferred.succeed(observed, update.shellID)
                    yield* Effect.promise(() => fs.writeFile(releasePath, ""))
                  }),
              })

              expect(yield* Deferred.await(observed)).toMatch(/^sh_/)
            }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(releasePath, "")).pipe(Effect.ignore))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "reports shell ID progress once",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const updates: Tool.Metadata[] = []
              yield* executeTool(registry, {
                ...call({ command: helloCommand }, "call-shell-id-progress"),
                progress: (update) => Effect.sync(() => updates.push(update)),
              })
              expect(updates).toHaveLength(1)
              expect(updates[0]?.shellID).toMatch(/^sh_/)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("returns the shell id for a background command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(
              registry,
              call({ command: idleCommand, timeout: 50, run_in_background: true }),
            )
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content).toEqual([
              {
                type: "text",
                text: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${info.file}`,
              },
              {
                type: "text",
                text: "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.",
              },
            ])
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            expect((yield* shell.wait(id)).status).toBe("timeout")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Timed out before completion"),
              description: idleCommand,
              metadata: {
                source: "shell",
                shellID,
                state: "completed",
                timeout: true,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("preserves a background command's non-zero exit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(
              registry,
              call({ command: bodyExitCommand, run_in_background: true }, "call-background-nonzero"),
            )
            const shellID = settled.metadata?.shellID
            expect(typeof shellID).toBe("string")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Exited with code 7"),
              description: bodyExitCommand,
              metadata: {
                source: "shell",
                jobID: shellID,
                shellID,
                state: "completed",
                exit: 7,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("persists a silent command that finishes before backgrounding", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const jobs = yield* Job.Service
            const shell = yield* Shell.Service
            const persisted = yield* Deferred.make<readonly Job.Background[]>()
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              event.data.sessionID === sessionID && event.data.item.type === "synthetic"
                ? jobs.pendingBackground.pipe(
                    Effect.flatMap((background) => Deferred.succeed(persisted, background)),
                    Effect.asVoid,
                  )
                : Effect.void,
            )
            const settled = yield* executeTool(registry, {
              ...call({ command: "exit 7", run_in_background: true }, "call-background-silent-nonzero"),
              // The command can finish while its initial progress update is being published.
              progress: (update) =>
                typeof update.shellID === "string"
                  ? shell.wait(ID.make(update.shellID)).pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
            })

            expect(yield* Deferred.await(persisted)).toMatchObject([
              {
                id: settled.metadata?.shellID,
                status: "completed",
                output: "(no output)\n\nExited with code 7",
              },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "updates and clears a running shell timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const timed = yield* executeTool(
                registry,
                call({ command: idleCommand, run_in_background: true }, "call-updated-timeout"),
              )
              const timedID = timed.metadata?.shellID
              expect(typeof timedID).toBe("string")
              if (typeof timedID !== "string") return
              const timedShellID = ID.make(timedID)
              yield* shell.timeout(timedShellID, 50)
              expect((yield* shell.wait(timedShellID)).status).toBe("timeout")

              const cleared = yield* executeTool(
                registry,
                call({ command: idleCommand, timeout: 50, run_in_background: true }, "call-cleared-timeout"),
              )
              const clearedID = cleared.metadata?.shellID
              expect(typeof clearedID).toBe("string")
              if (typeof clearedID !== "string") return
              const clearedShellID = ID.make(clearedID)
              yield* shell.timeout(clearedShellID, 0)
              yield* Effect.sleep(Duration.millis(100))
              expect((yield* shell.get(clearedShellID)).status).toBe("running")
              yield* shell.remove(clearedShellID)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  const signalTest = isWindows ? it.live.skip : it.live
  signalTest(
    "escalates a shell timeout when the ready process ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const ready = yield* Deferred.make<void>()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(tmp.path, (_event, filename) => {
              if (filename === "ready") Deferred.doneUnsafe(ready, Exit.void)
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        )
        yield* withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            yield* Effect.acquireUseRelease(
              // Arm the timeout only after the child announces that SIGTERM is ignored.
              shell.create({
                shell: "/bin/sh",
                command: "trap '' TERM; : > ready; while :; do sleep 60; done",
                timeout: 0,
              }),
              (info) =>
                Effect.gen(function* () {
                  yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
                  yield* shell.timeout(info.id, 1)
                  // Completion must reap the process, not only mark the command as timed out.
                  expect((yield* shell.wait(info.id).pipe(Effect.timeout("10 seconds"))).status).toBe("timeout")
                  const pid = info.pid
                  if (pid === undefined) throw new Error("Expected shell PID")
                  expect(() => process.kill(pid, 0)).toThrow()
                }),
              (info) =>
                Effect.try(() => {
                  if (info.pid !== undefined) process.kill(-info.pid, "SIGKILL")
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(shell.remove(info.id)),
                ),
            )
          }),
        )
      }),
    { timeout: 30_000 },
  )

  if (!isWindows) {
    it.live("settles a shell terminated by an external signal", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const settled = yield* executeTool(
                registry,
                call({ command: idleCommand, run_in_background: true }, "call-external-signal"),
              )
              const shellID = settled.metadata?.shellID
              expect(typeof shellID).toBe("string")
              if (typeof shellID !== "string") return
              const id = ID.make(shellID)
              const info = yield* shell.get(id)
              expect(typeof info.pid).toBe("number")
              if (info.pid === undefined) return

              process.kill(-info.pid, "SIGTERM")
              const result = yield* shell.wait(id).pipe(Effect.timeoutOption(Duration.seconds(1)))
              expect(result._tag).toBe("Some")
              if (result._tag === "Some") expect(result.value).toMatchObject({ status: "exited", signal: "SIGTERM" })
              expect((yield* shell.list()).map((item) => item.id)).not.toContain(id)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  }

  it.live("backgrounds a foreground command when the session is signaled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const waiting = yield* executeTool(
              registry,
              call({ command: idleCommand, timeout: 50 }, "call-background-signal"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))

            const backgroundWhenReady = (remaining = 1000): Effect.Effect<Job.Info[], Error> =>
              Effect.gen(function* () {
                const backgrounded = yield* jobs.backgroundAll({ sessionID })
                if (backgrounded.length > 0) return backgrounded
                if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for foreground shell job"))
                yield* Effect.promise(() => Bun.sleep(1))
                return yield* backgroundWhenReady(remaining - 1)
              })
            const backgrounded = yield* backgroundWhenReady()
            const settled = yield* Fiber.join(waiting)
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(backgrounded).toMatchObject([{ id: shellID, type: "shell" }])
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content?.[0]).toEqual({
              type: "text",
              text: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${info.file}`,
            })
            expect(settled.content?.[1]).toEqual({
              type: "text",
              text: "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.",
            })
            yield* Effect.sleep(Duration.millis(100))
            expect((yield* shell.get(id)).status).toBe("running")
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            yield* shell.remove(id)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  // What a scheduler reads to decide that a shell call failed: `metadata.error`, on the result or on the failure.
  const failureFlag = (registry: Tool.Interface, input: ReturnType<typeof call>) =>
    registry.snapshot().pipe(
      Effect.flatMap((tools) => tools.execute(input)),
      Effect.match({
        onFailure: (error) => ({ settled: "failed" as const, flag: error.metadata?.error }),
        onSuccess: (result) => ({ settled: "completed" as const, flag: result.metadata?.error }),
      }),
    )

  const killCommand = "kill -9 $$"
  const flagCases = [
    ["a timeout", { command: idleCommand, timeout: 50 }, { settled: "completed", flag: true }, true],
    ["a signal kill", { command: killCommand }, { settled: "completed", flag: true }, !isWindows],
    ["a non-zero exit", { command: bodyExitCommand }, { settled: "completed", flag: undefined }, true],
    ["a clean exit", { command: helloCommand }, { settled: "completed", flag: undefined }, true],
    ["a missing workdir", { command: cwdCommand, workdir: "missing" }, { settled: "failed", flag: undefined }, true],
  ] as const
  for (const [name, input, expected, enabled] of flagCases) {
    const flagTest = enabled ? it.live : it.live.skip
    flagTest(`flags ${name} for sibling cancellation as ${expected.flag === true ? "a failure" : "no failure"}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) => failureFlag(registry, call(input))).pipe(
            Effect.andThen((result) => Effect.sync(() => expect(result).toEqual(expected))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  }

  // A foreground call whose command record disappears while it waits ends through the job-error path. A client's
  // shell.remove is a deliberate stop, and it counts as a failure here (unlike shell.kill, which settles "killed").
  it.live(
    "flags a foreground command removed while it runs as a failure",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const running = yield* failureFlag(registry, call({ command: idleCommand }, "call-removed")).pipe(
                Effect.forkChild({ startImmediately: true }),
              )
              const first = (remaining = 1000): Effect.Effect<Shell.Info, Error> =>
                Effect.gen(function* () {
                  const listed = yield* shell.list()
                  if (listed[0]) return listed[0]
                  if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the shell"))
                  yield* Effect.promise(() => Bun.sleep(5))
                  return yield* first(remaining - 1)
                })
              yield* shell.remove((yield* first()).id)
              expect(yield* Fiber.join(running)).toEqual({ settled: "failed", flag: true })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  // Only Shell.create raises AppProcessError (spawn failure, missing sandbox). On Windows a missing program is an
  // ordinary exit 1 until tool-runtime-11, so this case runs on POSIX only.
  const spawnTest = isWindows ? it.live.skip : it.live
  spawnTest("flags a shell that cannot be started as a failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const hooks = yield* PluginHooks.Service
            yield* hooks.register("shell", "create.before", (event) =>
              Effect.sync(() => {
                event.shell = path.join(tmp.path, "missing-shell")
              }),
            )
            expect(yield* failureFlag(registry, call({ command: helloCommand }))).toEqual({
              settled: "failed",
              flag: true,
            })
          }).pipe(Effect.scoped),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("flags no failure for a permission denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "Bash"
        return withSession(tmp.path, (registry) => failureFlag(registry, call({ command: cwdCommand }))).pipe(
          Effect.andThen((result) => Effect.sync(() => expect(result).toEqual({ settled: "failed", flag: undefined }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "cancels the job of a foreground command that is interrupted",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const running = yield* executeTool(registry, call({ command: idleCommand }, "call-interrupted")).pipe(
                Effect.forkChild({ startImmediately: true }),
              )
              const until = (done: (count: number) => boolean, remaining = 1000): Effect.Effect<void, Error> =>
                Effect.gen(function* () {
                  if (done((yield* shell.list()).length)) return
                  if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the shell"))
                  yield* Effect.promise(() => Bun.sleep(5))
                  return yield* until(done, remaining - 1)
                })
              yield* until((count) => count > 0)
              yield* Fiber.interrupt(running)
              // The job is cancelled on interrupt, so its shell goes away without the test removing it.
              yield* until((count) => count === 0)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )
})
