import fs from "fs/promises"
import { realpathSync, watch } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { TestClock } from "effect/testing"
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
import { KV } from "@orbit/core/kv"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionStore } from "@orbit/core/session/store"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Plugin } from "@orbit/core/plugin"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Shell } from "@orbit/core/shell"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { define } from "@orbit/plugin/effect/plugin"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { ShellAnalysis } from "@orbit/core/shell/analysis"
import { ShellSelect } from "@orbit/core/shell/select"
import { ToolNames } from "@orbit/core/tool/names"
import { ToolScheduler } from "@orbit/core/session/runner/tool-scheduler"
import { ID } from "@orbit/schema/shell"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { ToolOutput } from "@orbit/core/tool-output"
import { Tool } from "@orbit/core/tool"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { which } from "@orbit/util/which"
import type { ConfigManaged } from "@orbit/schema/config/managed"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { Expected } from "./lib/session-message"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

type ManagedNetwork = NonNullable<ConfigManaged.Restrictions["network"]>

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

// The real job registry, with `block` and `cancel` held back for a set time, so a test can land the deadline in the window
// between a job settling and the call looking at it.
const slow = { block: 0, cancel: 0, stale: false }
const slowJobs = makeGlobalNode({
  service: Job.Service,
  layer: Layer.effect(
    Job.Service,
    Job.make.pipe(
      Effect.map((jobs) =>
        Job.Service.of({
          ...jobs,
          // With `stale` set, a running job reads as already settled, as when it ends just as a notice is due.
          get: (id) =>
            jobs.get(id).pipe(
              Effect.map((info) => (slow.stale && info?.status === "running" ? { ...info, status: "completed" as const } : info)),
            ),
          block: (input) => jobs.block(input).pipe(Effect.tap(() => Effect.sleep(Duration.millis(slow.block)))),
          cancel: (id) => jobs.cancel(id).pipe(Effect.tap(() => Effect.sleep(Duration.millis(slow.cancel)))),
        }),
      ),
    ),
  ),
  deps: [KV.node],
})
const slowIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...replacements,
    Job.node.replace(slowJobs),
    PluginSupervisor.node.replace(shellPluginSupervisor),
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

const noHost = PowerShellParse.Service.of({ parse: () => Effect.succeed({ valid: false, reason: "no-host" }) })
const analyse = (command: string, shell: string) =>
  ShellAnalysis.inspect(command, {
    shell,
    platform: process.platform,
    path: process.platform === "win32" ? path.win32 : path.posix,
    home: os.homedir(),
    cwd: process.cwd(),
    env: {},
  }).pipe(Effect.provideService(PowerShellParse.Service, noHost))

// Runs a command whose approval the saved grants may cover. Input that Orbit cannot analyse is asked about whole, with
// nothing to save, whatever is saved; any other input needs no question. The analysis decides which, and the list of inputs
// that are opaque is pinned in its own test.
const runCovered = (registry: Tool.Interface, command: string, shell: string, marker: string, lifted = false) =>
  Effect.gen(function* () {
    // `lifted`: the whole text and every fragment of this opaque input is covered by the saved grants, which lift it until
    // shell-safety-12 makes such input rule-proof.
    const opaque = !lifted && (yield* analyse(command, shell)).opaque !== undefined
    const result = yield* runPermissionCommand(registry, command, marker, opaque ? ["once"] : [])
    if (!opaque) expect(result.requests).toEqual([])
    else {
      expect(result.requests).toHaveLength(1)
      expect(result.requests[0]?.resources[0]).toBe(command)
      expect(result.requests[0]?.save).toBeUndefined()
    }
    return result
  })

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
          const command = "scanned=$(printf hello); printf hello > marker"
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
              resources: ["printf hello", "printf hello > marker"],
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

    // After an "always" on a plain command behind a wrapper (the scanner saves `env *`), a later command that steers its
    // program with a plain `PATH=`, `LD_*=` or `env` option spelling must still ask: Permission's exact-text filter refuses
    // the wildcard grant for it (class 8). These rows do not pin what the save holds; other spellings, such as a quoted
    // assignment or `env ./prog`, are lifted by `env *` (follow-up). The file it would delete or run is absent.
    for (const [first, later] of [
      ["env A=1 ls", "env PATH=. ls"],
      ["env LD_PRELOAD=./nothing.so A=1 ls", "env LD_PRELOAD=./nothing.so PATH=. ls"],
      ["env -i A=1 ls", "env -i PATH=. ls"],
      ["timeout 5 env A=1 ls", "timeout 5 env PATH=. ls"],
      ["FOO=1 ls", "FOO=1 PATH=. ls"],
      ["FOO=1 ls", "PATH=. ls"],
      ["timeout 5 'r*' x", "rm -rf x"],
      ['timeout 5 "rm -rf" x', "rm -rf x"],
      ["timeout 5 r\\* x", "rm -rf x"],
      ["FOO=1 'r*' x", "rm -rf x"],
      ["nice env A=1 ls", "env PATH=. ls"],
      ["timeout 5 env A=1 ls", "env PATH=. ls"],
      ["env A=1 ls 2>/dev/null", "env PATH=. ls"],
      ["env A=1 ls > out", "env PATH=. ls"],
      ["env A=1 ls < in", "env PATH=. ls"],
      ["env A=1 ls 2>&1 | head", "env PATH=. ls"],
      ["env A=1 \\\nls", "env PATH=. ls"],
      ["timeout 5 FOO=1 ls", "FOO=1 PATH=. ls"],
      ["FOO=* ls", "FOO=1 PATH=. ls"],
      ["FOO='*' ls", "FOO='1' PATH='.' B='' ls"],
      ["env PATTERN='src/*' ls", "env PATTERN='src/x' PATH='.' B='' ls"],
    ] as const)
      test(`${scanner}: always on ${first} does not lift ${later}`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [{ action: "Bash", resource: "*", effect: "ask" }]
              }),
            )
            yield* Effect.promise(() =>
              Promise.all([
                Bun.write(path.join(fixture.active, "x"), "keep"),
                Bun.write(path.join(fixture.active, "ls"), "#!/bin/sh\necho pwned > pwned\n").then(() =>
                  fs.chmod(path.join(fixture.active, "ls"), 0o755),
                ),
              ]),
            )
            const marker = path.join(fixture.active, "marker")
            yield* runPermissionCommand(registry, first, marker, ["always"])
            const asked = yield* runPermissionCommand(registry, later, marker, ["reject"])
            expect(asked.requests).toHaveLength(1)
            expect(yield* Effect.promise(() => Bun.file(path.join(fixture.active, "x")).exists())).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(fixture.active, "pwned")).exists())).toBe(false)
          }),
        ))

    // The control for the rows above: the decoy is executable and does run when the person says yes once.
    test(`${scanner}: the ./ls decoy runs under env PATH=. ls when it is allowed once`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(fixture.active, "ls"), "#!/bin/sh\necho pwned > pwned\n").then(() =>
              fs.chmod(path.join(fixture.active, "ls"), 0o755),
            ),
          )
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "Bash", resource: "*", effect: "ask" }]
            }),
          )
          yield* runPermissionCommand(registry, "env PATH=. ls", path.join(fixture.active, "marker"), ["once"])
          expect(yield* Effect.promise(() => Bun.file(path.join(fixture.active, "pwned")).exists())).toBe(true)
        }),
      ))

    test(`${scanner}: always on env A=1 printf x repeats`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const marker = path.join(fixture.active, "marker")
          yield* runPermissionCommand(registry, "env A=1 printf x", marker, ["always"])
          const repeated = yield* runPermissionCommand(registry, "env A=1 printf x", marker, [])
          expect(repeated.requests).toEqual([])
        }),
      ))

    // "always" on a command that steers its program saves the scanner's prefix, which does not lift that command again
    // and lifts only commands the prefix matches (class 8). An exact-text allow rule is what stops the question.
    for (const [command, save, liftedOther, askedOther] of [
      ["env -i printf x", "env *", "env A=1 printf y", "env -i printf y"],
      ["PATH=/usr/bin printf x", "printf *", "printf z", "env A=1 printf z"],
      ["env PATH=/usr/bin printf x", "env *", "env A=1 printf y", "env PATH=/usr/bin printf y"],
      ["LD_LIBRARY_PATH=/usr/lib printf x", "printf *", "printf z", "env A=1 printf z"],
    ] as const) {
      test(`${scanner}: always on ${command} saves ${save}, asks again, lifts ${liftedOther}, asks ${askedOther}`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const marker = path.join(fixture.active, "marker")
            yield* runPermissionCommand(registry, command, marker, ["always"])
            expect((yield* saved.list()).map((item) => item.resource)).toEqual([save])
            const again = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(again.requests).toHaveLength(1)
            const lifted = yield* runPermissionCommand(registry, liftedOther, marker, [])
            expect(lifted.requests).toEqual([])
            const other = yield* runPermissionCommand(registry, askedOther, marker, ["reject"])
            expect(other.requests).toHaveLength(1)
          }),
        ))
      test(`${scanner}: an exact-text Bash allow rule lifts ${command}`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [
                  { action: "Bash", resource: "*", effect: "ask" },
                  { action: "Bash", resource: command, effect: "allow" },
                ]
              }),
            )
            const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), [])
            expect(result.requests).toEqual([])
            expect(result.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          }),
        ))
    }

    // A wrapper-led command saves the wrapper's pattern, and a plain `IFS=` command is opaque and saves nothing. Neither
    // is lifted again by what it saved: each asks on the next run (class 8).
    for (const [command, save] of [
      ["sudo PATH=/usr/bin printf x", "sudo *"],
      ["timeout 5 env -i printf x", "timeout *"],
      ["nice env PATH=/usr/bin printf x", "nice *"],
      ["PATH=/usr/bin ./prog x", "./prog *"],
      ["IFS=: printf x", undefined],
    ] as const)
      test(`${scanner}: always on ${command} saves ${save ?? "nothing"} and asks again`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const marker = path.join(fixture.active, "marker")
            yield* runPermissionCommand(registry, command, marker, ["always"])
            expect((yield* saved.list()).map((item) => item.resource)).toEqual(save ? [save] : [])
            const again = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(again.requests).toHaveLength(1)
          }),
        ))

    // A declaration that prints the environment is a request beside any other command (class 8): a rule written for it
    // applies, and an allow for the other command does not lift it. The secret is what the model would be shown.
    for (const [command, declaration] of [
      ["export -p; ls", "export *"],
      ["ls; declare -p", "declare *"],
      ["declare -p && printf x", "declare *"],
      ["export -p | cat", "export *"],
    ] as const) {
      test(`${scanner}: ${command} asks, and a deny for the declaration blocks it, though the other command is allowed`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            const rules = (...extra: { action: "Bash"; resource: string; effect: "deny" }[]) =>
              agents.transform((editor) =>
                editor.update(toolIdentity.agent, (agent) => {
                  agent.permissions = [
                    { action: "Bash", resource: "*", effect: "ask" },
                    { action: "Bash", resource: "ls", effect: "allow" },
                    { action: "Bash", resource: "cat", effect: "allow" },
                    { action: "Bash", resource: "printf x", effect: "allow" },
                    ...extra,
                  ]
                }),
              )
            const marker = path.join(fixture.active, "marker")
            yield* rules()
            const asked = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(asked.requests).toHaveLength(1)
            expect(asked.requests[0]?.resources.some((resource) => /^(export|declare)\b/.test(resource))).toBe(true)
            yield* rules({ action: "Bash", resource: declaration, effect: "deny" })
            expectBlocked(yield* runPermissionCommand(registry, command, marker, []))
          }),
        ))
    }

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

    test(`${scanner}: a numeric symlink operand is judged where it leads, and an external-directory deny blocks it`, () =>
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
          // The link leads to the folder outside, which the deny rule names: blocked before any question or write.
          expect(result.requests).toEqual([])
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: external_directory") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))

    test(`${scanner}: a continued directory operand is judged where it leads, and a deny on the destination blocks it`, () =>
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
          // The backslash before the line break joins the words, so the folder is `../outside`. The input is opaque in both
          // modes; the fragments of such input are joined the same way, so the deny on the destination blocks the call.
          expectBlocked(yield* runPermissionCommand(registry, command, marker, []))
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
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
              // Process substitution is beyond what Orbit analyses: the whole input is asked about first, then its
              // fragments, and "always" has nothing to save.
              expect(result.requests).toHaveLength(1)
              expect(result.requests[0]).toMatchObject({ action: "Bash" })
              expect(result.requests[0]?.resources[0]).toBe(command)
              expect(result.requests[0]?.resources).toEqual(
                expect.arrayContaining(["printf reached > marker", 'wait "$!"']),
              )
              expect(result.requests[0]?.save).toBeUndefined()
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
              const repeat = yield* runPermissionCommand(registry, command, marker, ["reject"])
              expect(repeat.requests).toHaveLength(1)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
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
              const result = yield* runCovered(
                registry,
                portable ? fixture.command : fixture.equivalent,
                fixture.shell,
                path.join(directory.active, "marker"),
              )
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
        { name: "ANSI-C quoting", command: "printf %s $'a\\nb'", output: "a\nb", saved: ["printf *"], lifted: true },
      ]) {
        test(`${shell} ${portable ? "native" : "legacy"}: ${fixture.name} reuses existing approvals`, () =>
          withScanner(
            portable,
            (registry, directory) =>
              Effect.gen(function* () {
                const saved = yield* PermissionSaved.Service
                const location = yield* Location.Service
                yield* saved.add({ projectID: location.project.id, action: "Bash", resources: fixture.saved })
                const result = yield* runCovered(
                  registry,
                  fixture.command,
                  shell,
                  path.join(directory.active, "marker"),
                  "lifted" in fixture,
                )
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
    // A statement that is not a pipeline of commands (an assignment, a conditional, a loop, a definition) is asked about by
    // its own text, which no saved grant for the commands inside it covers.
    for (const command of [
      '$value = "hello"; Write-Output $value',
      "if ($true) { Write-Output hello } else { Write-Output other }",
      "foreach ($value in @('hello')) { Write-Output $value }",
      "ForEach-Object { Write-Output hello }",
      "function Show-Value { Write-Output hello }; Show-Value",
    ]) {
      test(
        `PowerShell ${portable ? "native" : "legacy"}: ordinary syntax asks for the statement: ${command}`,
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
                const result = yield* runPermissionCommand(registry, command, path.join(directory.active, "marker"), [
                  "once",
                ])
                expect(result.requests).toHaveLength(1)
                const statement = command.startsWith("$value") ? '$value = "hello"' : command.split("; ")[0]!
                expect(result.requests[0]?.resources).toContain(statement)
                expect(result.exit).toMatchObject({
                  _tag: "Success",
                  value: { status: "completed", metadata: { exit: 0 } },
                })
                if (Exit.isSuccess(result.exit))
                  expect(result.exit.value.content?.[0]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
              }),
            pwsh ?? "pwsh",
          ),
        { timeout: 15_000 },
      )
    }
    for (const command of [
      'Write-Output "$(Write-Output hello)"',
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
    // The grant names the cmdlet, not the spelling: the repeat meets it through the cmdlet's canonical spelling.
    ["Get-Date\t-Format yyyy", "Get-Date *"],
    ["& 'Get-Date' -Format yyyy", "Get-Date *"],
    ["Get-Date `\n  -Format yyyy", "Get-Date *"],
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
            expect(yield* toolTraits(registry, "Bash", { command: "touch x", description: "touch" })).toMatchObject({
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

  // The positive rows need a PATH the read-only analysis trusts (no empty or relative entry); a Windows Path often has
  // one, and Linux runs them (tools/linux-test).
  const cleanPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .every((entry) => entry !== "" && path.isAbsolute(entry))
  const wiring = cleanPath ? it.live : it.live.skip
  const bashOnly = isWindows ? it.live.skip : wiring

  wiring("schedules a call from its command alone, before any hook", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("sh"))
            const hooks = yield* PluginHooks.Service
            yield* hooks.register("tool", "execute.before", (event) =>
              Effect.sync(() => {
                ;(event.input as Record<string, unknown>).command = "touch x"
              }),
            )
            const safe = (input: unknown) => toolTraits(registry, "Bash", input)
            expect(yield* safe({ command: "ls" })).toMatchObject({ concurrencySafe: true, cancelSiblingsOnFailure: true })
            // The background flag, a timeout and a workdir do not change the answer.
            expect(yield* safe({ command: "ls", run_in_background: true })).toMatchObject({ concurrencySafe: true })
            expect(yield* safe({ command: "ls", timeout: 5, workdir: "." })).toMatchObject({ concurrencySafe: true })
            expect(yield* safe({ command: "touch x" })).toMatchObject({
              concurrencySafe: false,
              cancelSiblingsOnFailure: true,
            })
            // Input the schema rejects is conservative, and still cancels its siblings.
            expect(yield* safe({ command: 5 })).toMatchObject({ concurrencySafe: false, cancelSiblingsOnFailure: true })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // Needs a real PowerShell: elsewhere "powershell" falls back to a bash shell, where `ls` is a read-only command.
  ;(isWindows ? it.live : it.live.skip)("schedules a PowerShell call alone, whatever the command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("powershell"))
            for (const command of ["Get-ChildItem", "ls", "Get-Content a.txt"])
              expect(yield* toolTraits(registry, "Bash", { command })).toMatchObject({
                concurrencySafe: false,
                cancelSiblingsOnFailure: true,
              })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // Real `sleep` calls through the real scheduler, with the registry's traits: read-only calls overlap, a write does not.
  bashOnly("runs read-only calls together and a write call alone", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("sh"))
            yield* (yield* Agent.Service).transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = []
              }),
            )
            const events: string[] = []
            const hooks = yield* PluginHooks.Service
            yield* hooks.register("tool", "execute.before", (event) =>
              Effect.sync(() => void events.push(`start ${(event.input as { command: string }).command}`)),
            )
            yield* hooks.register("tool", "execute.after", (event) =>
              Effect.sync(() => void events.push(`end ${(event.input as { command: string }).command}`)),
            )
            const batch = (commands: string[]) =>
              Effect.gen(function* () {
                events.length = 0
                const scheduler = ToolScheduler.make<string>({ maxConcurrency: 10 })
                const entries = commands.map((command, index) => ({
                  command,
                  entry: scheduler.register(`${index}`),
                }))
                const tools = yield* registry.snapshot()
                yield* Effect.forEach(
                  entries,
                  ({ command, entry }, index) => {
                    const item = call({ command }, `call-${index}`)
                    return tools.traits({ call: item.call }).pipe(
                      Effect.flatMap((traits) => scheduler.run(entry, traits, tools.execute(item))),
                      Effect.ensuring(scheduler.release(entry)),
                    )
                  },
                  { concurrency: "unbounded", discard: true },
                )
                return events.map((event) => event.replace(/ \d+$/, ""))
              })
            expect(yield* batch(["sleep 1", "sleep 1"])).toEqual(["start sleep", "start sleep", "end sleep", "end sleep"])
            expect(yield* batch(["sleep 1", "touch x"])).toEqual(["start sleep", "end sleep", "start touch x", "end touch x"])
            expect(yield* batch(["touch y", "sleep 1"])).toEqual(["start touch y", "end touch y", "start sleep", "end sleep"])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
    { timeout: 20_000 },
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
                  // A .NET call is not a command, so PowerShell input asks for it by its own statement text.
                  resources: isWindows
                    ? ["Start-Sleep -Milliseconds 100", "[Console]::Out.Write('hello')"]
                    : [helloCommand],
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-shell" },
                },
              ])
              expect(assertions[0]?.save).toEqual(
                isWindows ? ["[Console]::Out.Write('hello')"] : ["printf *"],
              )
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
                // Windows PowerShell 5.1 has no `&&`, so its parse fails and the input is asked about whole and by fragment,
                // with nothing to save.
                if (isWindows) {
                  expect(assertions[0]?.resources).toEqual(expect.arrayContaining(["printf one", "printf two"]))
                  return
                }
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
                      expect([row.workdir, assertions.find((item) => item.action === "Bash")?.metadata?.workdir]).toEqual([
                        row.workdir,
                        row.runs,
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
      `${trusted ? "a trusted" : "an untrusted"} project's link into the global config folder is asked about and shown as that folder`,
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
              const folder = path.join(config, "*").replaceAll("\\", "/")
              const rows = [
                { input: { command: cwdCommand, workdir: "cfg" }, workdir: config },
                { input: { command: `cd cfg; ${cwdCommand}` }, workdir: active.path },
                // A plain word of the command, and a file it writes to, through the link.
                { input: { command: "cat cfg/marker.txt" }, workdir: active.path },
                { input: { command: "echo planted > cfg/planted.txt" }, workdir: active.path },
                // Windows starts a process in `cfg.` as in `cfg`, while Bun's own `stat` finds no `cfg.`.
                ...(isWindows
                  ? [
                      { input: { command: cwdCommand, workdir: "cfg." }, workdir: config },
                      { input: { command: cwdCommand, workdir: "cfg " }, workdir: config },
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
                    // A link that leads to the global config folder is asked about as that folder, whether it is the
                    // workdir or a path in the command, in either trust state. Only a project that is not trusted marks
                    // the folder as one a link leads to, so that Orbit's own allows do not decide it.
                    expect(assertions.map((item) => item.action)).toEqual(["external_directory", "Bash"])
                    expect(assertions[0]).toMatchObject({ resources: [folder] })
                    if (!trusted) expect(assertions[0]).toMatchObject({ escaped: [folder] })
                    else expect(assertions[0]).not.toHaveProperty("escaped")
                    expect(assertions.at(-1)?.metadata?.workdir).toEqual(row.workdir)
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

  productionIt.live(
    "a create hook that sets the timeout to 0 does not send a foreground call to the background",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const hooks = yield* PluginHooks.Service
              yield* hooks.register("shell", "create.before", (event) =>
                Effect.sync(() => {
                  event.timeout = 0
                }),
              )
              const settled = yield* executeTool(registry, call({ command: helloCommand }, "call-zero-deadline"))
              expect(settled.status).toBe("completed")
              expect(settled.content).toEqual([{ type: "text", text: "hello" }])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

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
                      expect(control.system[0]?.text).toStartWith(
                        `Fall back to ${offered[0]} when a tool cannot do it.\n\n# Git and pull requests\n`,
                      )

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
              expect(event.system[0]?.text).toStartWith(
                `Use ${isWindows ? "PowerShell" : "Bash"} for it.\n\n# Output style: Terse\nPrefer Git Bash.\n\n# Git and pull requests\n`,
              )
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 30_000 },
  )

  it.live("asks about malformed syntax in both scanner modes instead of refusing it", () =>
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
              // Input that cannot be read is asked about, never refused, in both modes: the whole text first, then the
              // fragments, with nothing to save. Once allowed it runs as far as the shell gets.
              expect(settled.status).toBe("completed")
              expect(settled.metadata?.exit).not.toBe(0)
              expect(assertions.map((item) => item.action)).toEqual(["Bash"])
              expect(assertions[0]?.resources[0]).toBe('printf hello > marker\necho "')
              expect(assertions[0]?.save).toBeUndefined()
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
                  // Each run works in its own temporary folder, which the shell's requests name as their workdir.
                  const named = [realpathSync(tmp.path), tmp.path].map((item) => JSON.stringify(item).slice(1, -1))
                  return JSON.parse(
                    named.reduce((text, item) => text.replaceAll(item, "<tmp>"), JSON.stringify(assertions)),
                  ) as unknown
                }),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
            ),
          )
          expect(results[1]).toEqual(results[0])
        }),
      { timeout: 15_000 },
    )
  }

  wiring("declares readOnly, destructive and block from the command text", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("sh"))
            const traits = (input: unknown) => toolTraits(registry, "Bash", input)
            expect(yield* traits({ command: "rm -rf x" })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              destructive: true,
              interruptBehavior: "block",
              cancelSiblingsOnFailure: true,
            })
            for (const command of ["ls", "git status"])
              expect(yield* traits({ command })).toMatchObject({
                readOnly: true,
                concurrencySafe: true,
                destructive: false,
                interruptBehavior: "block",
              })
            // Text the parser rejects is neither read-only nor safe to overlap, and the catalogue still reads the text.
            expect(yield* traits({ command: 'echo "unterminated' })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              destructive: false,
            })
            expect(yield* traits({ command: 'rm -rf "x' })).toMatchObject({ readOnly: false, destructive: true })
            // Input the schema rejects takes the conservative record and keeps what the tool declares.
            expect(yield* traits({ command: 5 })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              destructive: true,
              cancelSiblingsOnFailure: true,
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // `readOnly` is the verdict on the command text alone and relaxes nothing: a read-only `ls` in a folder outside the
  // Location still asks about the external directory.
  bashOnly("still asks about a folder outside the Location for a read-only command", () =>
    Effect.acquireUseRelease(
      Effect.all([Effect.promise(() => tmpdir()), Effect.promise(() => tmpdir())]),
      ([tmp, outside]) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("sh"))
            const input = { command: "ls", workdir: outside.path }
            expect((yield* toolTraits(registry, "Bash", input)).readOnly).toBe(true)
            yield* executeTool(registry, call(input))
            expect(assertions.map((item) => item.action)).toContain("external_directory")
          }),
        )
      },
      ([tmp, outside]) =>
        Effect.all([
          Effect.promise(() => tmp[Symbol.asyncDispose]()),
          Effect.promise(() => outside[Symbol.asyncDispose]()),
        ]),
    ),
  )

  // Needs a real PowerShell: elsewhere "powershell" falls back to a bash shell.
  ;(isWindows ? it.live : it.live.skip)("calls a PowerShell command destructive from the PowerShell catalogue", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("powershell"))
            expect(yield* toolTraits(registry, "Bash", { command: "Remove-Item -Recurse -Force x" })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              destructive: true,
            })
            expect(yield* toolTraits(registry, "Bash", { command: "Get-ChildItem" })).toMatchObject({
              readOnly: false,
              concurrencySafe: false,
              destructive: false,
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // cmd.exe has no catalogue, so no command under it can be called harmless.
  ;(isWindows ? it.live : it.live.skip)("calls every cmd command destructive", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure("cmd"))
            expect(yield* toolTraits(registry, "Bash", { command: "dir" })).toMatchObject({
              readOnly: false,
              destructive: true,
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // Exit codes through the real tool: the metadata of a foreground run says whether the line failed.
  describe("exit codes", () => {
    const posix = isWindows ? it.live.skip : it.live
    const withFiles = <A, E, R>(
      body: (registry: Tool.Interface, run: (input: typeof ShellTool.Input.Type) => Effect.Effect<Record<string, unknown>>) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const selection = yield* ShellSelect.Service
              yield* selection.transform((editor) => editor.configure("sh"))
              yield* Effect.promise(() =>
                Promise.all([Bun.write(path.join(tmp.path, "a"), "x\n"), Bun.write(path.join(tmp.path, "b"), "y\n")]),
              )
              let count = 0
              const run = (input: typeof ShellTool.Input.Type) =>
                executeTool(registry, call(input, `call-exit-${count++}`)).pipe(
                  Effect.map((settled) => (settled.status === "completed" ? (settled.metadata ?? {}) : { failed: true })),
                )
              return yield* body(registry, run)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      )

    const answers = ["grep nomatch a", "diff a b", "test -f missing", "[ -f missing ]", "cat a | grep nomatch"]
    const failures = [
      "grep x missing-file",
      "false",
      "exit 3",
      "sh -c 'exit 7'",
      "grep nomatch a && echo found",
      "[[ -f missing ]]",
    ]

    posix("leaves a no-match, differ or false exit unflagged, and flags any other failing exit", () =>
      withFiles((_registry, run) =>
        Effect.gen(function* () {
          for (const command of answers) {
            const metadata = yield* run({ command })
            expect(metadata.exit).toBe(1)
            expect(metadata.error).toBeUndefined()
          }
          for (const command of failures) {
            const metadata = yield* run({ command })
            expect(metadata.exit).toBeGreaterThan(0)
            expect(metadata.error).toBe(true)
          }
        }),
      ),
    )

    posix("judges the command that ran, after the hooks", () =>
      withFiles((_registry, run) =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          yield* hooks.register("shell", "create.before", (event) =>
            Effect.sync(() => {
              event.command = "false"
            }),
          )
          const metadata = yield* run({ command: "grep nomatch a" })
          expect(metadata.exit).toBe(1)
          expect(metadata.error).toBe(true)
        }),
      ),
    )

    posix("flags nothing for a background run that has not ended", () =>
      withFiles((_registry, run) =>
        Effect.gen(function* () {
          const metadata = yield* run({ command: "grep nomatch a", run_in_background: true })
          expect(metadata.status).toBe("running")
          expect(metadata.error).toBeUndefined()
        }),
      ),
    )

    posix("still flags a timeout", () =>
      withFiles((_registry, run) =>
        Effect.gen(function* () {
          expect((yield* run({ command: "sleep 60", timeout: 50 })).error).toBe(true)
        }),
      ),
    )

    // Under PowerShell an exit code never counts: the call cancels no sibling.
    ;(isWindows ? it.live : it.live.skip)("never flags an exit code under PowerShell", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const selection = yield* ShellSelect.Service
              yield* selection.transform((editor) => editor.configure("powershell"))
              const result = yield* executeTool(registry, call({ command: "cmd /c exit 3" }))
              if (result.status !== "completed") throw new Error("Expected a completed result")
              expect(result.metadata?.exit).toBeGreaterThan(0)
              expect(result.metadata?.error).toBeUndefined()
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )

    // Any other shell takes the default rule: a non-zero exit is a failure.
    ;(isWindows ? it.live : it.live.skip)("flags an exit code under cmd", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const selection = yield* ShellSelect.Service
              yield* selection.transform((editor) => editor.configure("cmd"))
              const result = yield* executeTool(registry, call({ command: "exit /b 1" }))
              if (result.status !== "completed") throw new Error("Expected a completed result")
              expect(result.metadata?.error).toBe(true)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  })

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
              expect(updates.filter((update) => typeof update.shellID === "string")).toHaveLength(1)
              expect(updates.find((update) => typeof update.shellID === "string")?.shellID).toMatch(/^sh_/)
              // The folder the command runs in is reported first, before anything is asked, for a client to name.
              expect(updates[0]?.places).toEqual([FSUtil.resolve(tmp.path)])
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
    // A failing exit cancels siblings except under PowerShell, where an exit code carries no meaning.
    [
      "a non-zero exit",
      { command: bodyExitCommand },
      { settled: "completed", flag: isWindows ? undefined : true },
      true,
    ],
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
  // ordinary exit 1, which PowerShell never flags, so this case runs on POSIX only.
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

  // Both sandbox launch sites (this tool and command spans) go through ShellSandbox.launch; the span site is pinned in
  // config/command-shell.test.ts.
  it.live("refuses to run a command when the sandbox is enabled on WSL1", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          yield* Effect.promise(() =>
            Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify({ sandbox: { enabled: true } })),
          )
          const previous = { ...ShellSandbox.host }
          Object.assign(ShellSandbox.host, { platform: "linux", release: "4.4.0-19041-Microsoft", env: {} })
          const settled = yield* withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: helloCommand }, "call-wsl1")),
          ).pipe(Effect.ensuring(Effect.sync(() => Object.assign(ShellSandbox.host, previous))))
          expect(settled).toMatchObject({ status: "error", error: { message: expect.stringContaining("WSL1") } })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  // `echo` stands in for the sandbox tool, so the command that runs prints the wrapper's own arguments: bubblewrap gets
  // --unshare-net exactly when the network is off.
  const sandboxArguments = (network: ManagedNetwork | undefined) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tmp.path, "orbit.json"),
              JSON.stringify({ sandbox: { enabled: true, network: true } }),
            ),
          )
          const previous = { host: { ...ShellSandbox.host }, tool: ShellSandbox.TOOL.linux }
          Object.assign(ShellSandbox.host, { platform: "linux", release: "6.1.0-generic", env: {}, interop: false })
          ShellSandbox.TOOL.linux = "echo"
          return yield* withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const policy = yield* ManagedPolicy.Service
              yield* policy.set("file", { statements: [], restrictions: network ? { network } : {} })
              const settled = yield* executeTool(registry, call({ command: helloCommand }, "call-offline"))
              expect(settled.status).toBe("completed")
              return (settled.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Object.assign(ShellSandbox.host, previous.host)
                if (previous.tool === undefined) delete ShellSandbox.TOOL.linux
                else ShellSandbox.TOOL.linux = previous.tool
              }),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    )
  const sandboxTest = isWindows ? it.live.skip : it.live
  for (const [name, network, forced] of [
    ["denied_domains", { denied_domains: ["x.example"] }, true],
    ["an empty allowed_domains", { allowed_domains: [] }, true],
    ["allow_managed_domains_only", { allow_managed_domains_only: true }, true],
    ["no domain settings (control)", undefined, false],
  ] as const)
    sandboxTest(`launches a sandboxed command with the network ${forced ? "off" : "on"} under ${name}`, () =>
      Effect.gen(function* () {
        expect((yield* sandboxArguments(network)).includes("--unshare-net")).toBe(forced)
      }),
    )

  // Runs the real thing where bubblewrap works. The sandbox mounts its own /proc, so the interfaces listed there are those
  // of the sandbox's network namespace: only the loopback means the network is off.
  const bwrapTest =
    process.platform === "linux" && which("bwrap") !== null && Bun.spawnSync(["bwrap", "--dev-bind", "/", "/", "true"]).exitCode === 0
      ? it.live
      : it.live.skip
  bwrapTest("has no network interface but the loopback when domain settings force the network off", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify({ sandbox: { enabled: true, network: true } })),
      )
      const settled = yield* withSession(tmp.path, (registry) =>
        Effect.gen(function* () {
          const policy = yield* ManagedPolicy.Service
          yield* policy.set("file", { statements: [], restrictions: { network: { allow_managed_domains_only: true } } })
          return yield* executeTool(registry, call({ command: "ls /proc/net/dev_snmp6" }, "call-bwrap"))
        }),
      )
      expect(settled.content?.map((part) => (part.type === "text" ? part.text.trim() : ""))).toEqual(["lo"])
    }),
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

// The deadline: a foreground command that outlives it moves to the background, except one made only of sleeps.
describe("ShellTool timeouts", () => {
  const releaseLoop = (release: string) =>
    isWindows
      ? `while (-not (Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
      : `while [ ! -f '${release}' ]; do sleep 0.05; done`
  const sleepThenWork = (release: string) =>
    isWindows ? `Start-Sleep -Milliseconds 100; ${releaseLoop(release)}` : `sleep 0.1 && ${releaseLoop(release)}`
  const briefThenDone = (milliseconds: number) =>
    isWindows
      ? `Start-Sleep -Milliseconds ${milliseconds}; [Console]::Out.Write('done')`
      : `sleep ${milliseconds / 1000}; printf done`

  const text = (settled: { content?: ReadonlyArray<{ type: string; text?: string }> }) =>
    (settled.content ?? []).map((part) => part.text ?? "").join("\n")

  /** A scratch folder whose orbit.json holds `config`, with the synthetic notifications of the session collected. */
  const inFolder = <A, E, R>(
    config: object | undefined,
    body: (input: {
      registry: Tool.Interface
      folder: string
      release: string
      notifications: () => ReadonlyArray<{ shellID: unknown; state: unknown }>
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        // Written before the session, which reads the config as its location starts.
        return Effect.promise(() =>
          config ? Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify(config)) : Promise.resolve(0),
        ).pipe(Effect.andThen(inSession(tmp.path, body)))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    )

  const inSession = <A, E, R>(
    directory: string,
    body: (input: {
      registry: Tool.Interface
      folder: string
      release: string
      notifications: () => ReadonlyArray<{ shellID: unknown; state: unknown }>
    }) => Effect.Effect<A, E, R>,
  ) =>
    withSession(directory, (registry) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const seen: Array<{ shellID: unknown; state: unknown }> = []
        yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              const metadata = (event.data.item.payload as { metadata?: Record<string, unknown> }).metadata
              seen.push({ shellID: metadata?.shellID, state: metadata?.state })
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        return yield* body({
          registry,
          folder: directory,
          release: path.join(directory, "release"),
          notifications: () => seen,
        })
      }),
    )

  const untilNotified = (
    notifications: () => ReadonlyArray<unknown>,
    count: number,
    remaining = 3000,
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      if (notifications().length >= count) return
      if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the notification"))
      yield* Effect.promise(() => Bun.sleep(5))
      return yield* untilNotified(notifications, count, remaining - 1)
    })

  const pending = Effect.gen(function* () {
    const jobs = yield* Job.Service
    return yield* jobs.pendingBackground
  })

  it.live(
    "moves a foreground command that outlives its timeout to the background and notifies once",
    () =>
      inFolder(undefined, ({ registry, release, notifications }) =>
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const settled = yield* executeTool(registry, call({ command: releaseLoop(release), timeout: 200 }))
          const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
          expect(shellID).toStartWith("sh_")
          expect(settled.metadata).toMatchObject({ status: "running" })
          expect(settled.metadata).not.toHaveProperty("error")
          expect(settled.metadata).not.toHaveProperty("timeout")
          expect(text(settled)).toStartWith("The command was still running after 200 ms")
          expect(text(settled)).toContain("Command moved to the background")
          if (!shellID) return
          expect((yield* shell.get(ID.make(shellID))).status).toBe("running")
          expect(notifications()).toEqual([])

          yield* Effect.promise(() => Bun.write(release, ""))
          yield* untilNotified(notifications, 1)
          yield* Effect.promise(() => Bun.sleep(300))
          expect(notifications()).toEqual([{ shellID, state: "completed" }])
          expect(yield* pending).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "still kills a command made only of sleeps at its timeout",
    () =>
      inFolder(undefined, ({ registry, notifications }) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(registry, call({ command: idleCommand, timeout: 200 }))
          expect(settled.metadata).toMatchObject({ timeout: true, error: true })
          expect(text(settled)).toContain("Command exceeded timeout of 200 ms")
          yield* Effect.promise(() => Bun.sleep(300))
          expect(notifications()).toEqual([])
          expect(yield* pending).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "moves a sleep that is followed by other work",
    () =>
      inFolder(undefined, ({ registry, release, notifications }) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(registry, call({ command: sleepThenWork(release), timeout: 400 }))
          expect(settled.metadata).toMatchObject({ status: "running" })
          expect(settled.metadata).not.toHaveProperty("timeout")
          yield* Effect.promise(() => Bun.write(release, ""))
          yield* untilNotified(notifications, 1)
        }),
      ),
    { timeout: 30_000 },
  )

  // [config, input timeout, the budget the kill text reports]
  const budgets: ReadonlyArray<readonly [object, number | undefined, number]> = [
    [{ shell_tool: { timeout: 200, max_timeout: 300 } }, 5000, 300],
    [{ shell_tool: { timeout: 200, max_timeout: 300 } }, undefined, 200],
    [{ shell_tool: { timeout: 200, max_timeout: 300 } }, 0, 200],
    // The maximum is never below the default.
    [{ shell_tool: { timeout: 400, max_timeout: 300 } }, 5000, 400],
  ]
  for (const [config, timeout, expected] of budgets) {
    it.live(
      `waits ${expected} ms for ${JSON.stringify(config)} with a timeout of ${timeout}`,
      () =>
        inFolder(config, ({ registry }) =>
          Effect.gen(function* () {
            const settled = yield* executeTool(
              registry,
              call({ command: idleCommand, ...(timeout === undefined ? {} : { timeout }) }),
            )
            expect(text(settled)).toContain(`Command exceeded timeout of ${expected} ms`)
          }),
        ),
      { timeout: 30_000 },
    )
  }

  const shared = Object.freeze({
    type: "object",
    properties: Object.freeze({ timeout: Object.freeze({ type: "integer", minimum: 0 }) }),
  })
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
          tools: { Bash: { description: "", input: shared } },
        } as never)
        // The tool is renamed when the session shell is PowerShell.
        const tool = event.tools.Bash ?? event.tools.PowerShell
        return { tool, input: tool?.input as { properties: { timeout: { maximum?: number; description: string } } } }
      }),
    )

  productionIt.live("advertises the configured default and maximum, for either tool name", () =>
    advertised({ shell_tool: { timeout: 90_000, max_timeout: 300_000 } }).pipe(
      Effect.tap((configured) =>
        Effect.sync(() => {
          expect(configured.input.properties.timeout.maximum).toBe(300_000)
          expect(configured.input.properties.timeout.description).toContain("300000")
          expect(configured.tool?.description).toContain("up to 300000 ms (5 minutes)")
          expect(configured.tool?.description).toContain("waits 90000 ms (1.5 minutes)")
        }),
      ),
    ),
  )

  productionIt.live("advertises the built-in numbers without config, and leaves the shared input alone", () =>
    advertised(undefined).pipe(
      Effect.tap((defaults) =>
        Effect.sync(() => {
          expect(defaults.input.properties.timeout.maximum).toBe(600_000)
          expect(defaults.tool?.description).toContain("up to 600000 ms (10 minutes)")
          expect(defaults.tool?.description).toContain("waits 120000 ms (2 minutes)")
          expect(shared.properties.timeout).not.toHaveProperty("maximum")
        }),
      ),
    ),
  )

  it.live("keeps the registry schema static", () =>
    inFolder(undefined, ({ registry }) =>
      Effect.gen(function* () {
        const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "Bash")
        expect(definition?.inputSchema).not.toHaveProperty("properties.timeout.maximum")
      }),
    ),
  )

  it.live(
    "delivers a command that finishes near its deadline exactly once",
    () =>
      inFolder(undefined, ({ registry, notifications }) =>
        Effect.gen(function* () {
          const jobs = yield* Job.Service
          for (let index = 0; index < 20; index++) {
            const before = notifications().length
            const settled = yield* executeTool(
              registry,
              call({ command: briefThenDone(185 + index * 3), timeout: 200 }, `call-race-${index}`),
            )
            const inline = settled.metadata?.status === "completed"
            if (!inline) yield* untilNotified(notifications, before + 1)
            yield* Effect.promise(() => Bun.sleep(300))
            expect((inline ? 1 : 0) + notifications().length - before).toBe(1)
            expect(yield* jobs.pendingBackground).toEqual([])
          }
        }),
      ),
    { timeout: 120_000 },
  )

  slowIt.live(
    "returns a command that exits as the deadline passes inline, with no notification and no marker",
    () =>
      inFolder(undefined, ({ registry, notifications }) =>
        Effect.gen(function* () {
          slow.block = 1500
          slow.cancel = 0
          const settled = yield* executeTool(registry, call({ command: briefThenDone(50), timeout: 200 }))
          expect(settled.metadata).toMatchObject({ status: "completed" })
          expect(text(settled)).toBe("done")
          yield* Effect.promise(() => Bun.sleep(500))
          expect(notifications()).toEqual([])
          expect(yield* pending).toEqual([])
        }).pipe(Effect.ensuring(Effect.sync(() => void (slow.block = 0)))),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "moves rather than stops a command it cannot read",
    () =>
      inFolder(undefined, ({ registry, release }) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(
            registry,
            call({ command: `${releaseLoop(release)} # ${"x".repeat(12_000)}`, timeout: 300 }),
          )
          expect(settled.metadata).toMatchObject({ status: "running" })
          yield* Effect.promise(() => Bun.write(release, ""))
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "returns a command that finishes before its deadline inline, with no notification and no marker",
    () =>
      inFolder(undefined, ({ registry, notifications }) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(registry, call({ command: briefThenDone(50), timeout: 20_000 }))
          expect(settled.metadata).toMatchObject({ status: "completed", exit: 0 })
          expect(text(settled)).toBe("done")
          yield* Effect.promise(() => Bun.sleep(500))
          expect(notifications()).toEqual([])
          expect(yield* pending).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  slowIt.live(
    "cancels an interrupted call before its deadline and leaves nothing to deliver",
    () =>
      inFolder(undefined, ({ registry, release, notifications }) =>
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const jobs = yield* Job.Service
          slow.block = 0
          slow.cancel = 1000
          const running = yield* executeTool(registry, call({ command: releaseLoop(release), timeout: 300 })).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          // Interrupt only once the job exists, so the interrupt reaches the wait on the job and not the spawn.
          const started = (remaining = 3000): Effect.Effect<void, Error> =>
            Effect.gen(function* () {
              const id = (yield* shell.list())[0]?.id
              if (id && (yield* jobs.get(id))) return
              if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the job"))
              yield* Effect.promise(() => Bun.sleep(5))
              return yield* started(remaining - 1)
            })
          yield* started()
          yield* Effect.promise(() => Bun.sleep(20))
          yield* Fiber.interrupt(running)
          // The cancel outlasts the deadline: a timer that was not stopped first would move the cancelled job.
          yield* Effect.promise(() => Bun.sleep(500))
          expect(notifications()).toEqual([])
          expect(yield* pending).toEqual([])
        }).pipe(Effect.ensuring(Effect.sync(() => void (slow.cancel = 0)))),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "does not move a command the user already moved",
    () =>
      inFolder(undefined, ({ registry, release, notifications }) =>
        Effect.gen(function* () {
          const jobs = yield* Job.Service
          const scope = yield* Scope.Scope
          const waiting = yield* executeTool(registry, call({ command: releaseLoop(release), timeout: 20_000 })).pipe(
            Effect.forkIn(scope, { startImmediately: true }),
          )
          const moveWhenReady = (remaining = 3000): Effect.Effect<void, Error> =>
            Effect.gen(function* () {
              if ((yield* jobs.backgroundAll({ sessionID })).length > 0) return
              if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the foreground job"))
              yield* Effect.promise(() => Bun.sleep(5))
              return yield* moveWhenReady(remaining - 1)
            })
          yield* moveWhenReady()
          const settled = yield* Fiber.join(waiting)
          expect(settled.metadata).toMatchObject({ status: "running" })
          expect(text(settled)).not.toContain("still running after")
          expect(notifications()).toEqual([])
          yield* Effect.promise(() => Bun.write(release, ""))
          yield* untilNotified(notifications, 1)
          yield* Effect.promise(() => Bun.sleep(300))
          expect(notifications()).toHaveLength(1)
          expect(yield* pending).toEqual([])
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "caps the kill deadline of a background command at the maximum",
    () =>
      inFolder({ shell_tool: { timeout: 300, max_timeout: 300 } }, ({ registry }) =>
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const started = Date.now()
          const settled = yield* executeTool(
            registry,
            call({ command: idleCommand, timeout: 5000, run_in_background: true }),
          )
          const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
          if (!shellID) throw new Error("Expected a shell ID")
          expect((yield* shell.wait(ID.make(shellID)).pipe(Effect.timeout("4 seconds"))).status).toBe("timeout")
          expect(Date.now() - started).toBeLessThan(4000)
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "decides what a sleep is after the create hooks have run",
    () =>
      inFolder(undefined, ({ registry, release }) =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          yield* hooks.register("shell", "create.before", (event) =>
            Effect.sync(() => {
              event.command = idleCommand
            }),
          )
          const settled = yield* executeTool(registry, call({ command: releaseLoop(release), timeout: 200 }))
          expect(settled.metadata).toMatchObject({ timeout: true, error: true })
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "uses the deadline a create hook sets",
    () =>
      inFolder(undefined, ({ registry }) =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          yield* hooks.register("shell", "create.before", (event) =>
            Effect.sync(() => {
              event.timeout = 150
            }),
          )
          const settled = yield* executeTool(registry, call({ command: idleCommand, timeout: 5000 }))
          expect(text(settled)).toContain("Command exceeded timeout of 150 ms")
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "moves a command run through Code Mode at its deadline",
    () =>
      inFolder(undefined, ({ registry, release, notifications }) =>
        Effect.gen(function* () {
          yield* registry.transform((editor) =>
            editor.update("Bash", (tool) => {
              tool.options = { ...tool.options, codemode: true }
            }),
          )
          const input = JSON.stringify({ command: releaseLoop(release), timeout: 200 })
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-codemode-deadline",
              name: "Execute",
              input: { code: `return await tools.Bash(${input})` },
            },
          })
          expect(result.status).toBe("completed")
          if (result.status !== "completed") return
          expect(JSON.parse(result.output.output)).toMatchObject({
            status: "running",
            shellID: expect.stringMatching(/^sh_/),
          })
          yield* Effect.promise(() => Bun.write(release, ""))
          yield* untilNotified(notifications, 1)
        }),
      ),
    { timeout: 30_000 },
  )

  // The stall watcher of a background command. The watcher sleeps on the test clock, so each test lets the real
  // command print, then moves the clock instead of waiting 50 seconds.
  describe("stall notice", () => {
    const promptThenIdle = isWindows
      ? "[Console]::Out.Write('Continue? [y/N] '); Start-Sleep -Seconds 600"
      : "printf 'Continue? [y/N] '; sleep 600"
    const quietAndIdle = isWindows ? "Start-Sleep -Seconds 600" : "sleep 600"
    const promptThenExit = isWindows ? "[Console]::Out.Write('Continue? [y/N] ')" : "printf 'Continue? [y/N] '"

    /** The synthetic notifications of the session, with the text and the message ID. */
    const collect = Effect.gen(function* () {
      const bus = yield* Bus.Service
      const seen: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = []
      yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
        Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const payload = event.data.item.payload as { text: string; metadata?: Record<string, unknown> }
            seen.push({ id: event.data.inboxID, text: payload.text, metadata: payload.metadata ?? {} })
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      return seen
    })

    const realWait = (milliseconds: number) => Effect.promise(() => Bun.sleep(milliseconds))

    const untilPrinted = (shellID: string) =>
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        for (let attempt = 0; attempt < 500; attempt++) {
          if ((yield* shell.output(ID.make(shellID), { cursor: Number.MAX_SAFE_INTEGER })).size > 0) return
          yield* realWait(20)
        }
        return yield* Effect.fail(new Error("The command printed nothing"))
      })

    /** Moves the test clock in 5 second checks, letting the watcher and the notification run after each. */
    const advance = (seconds: number) =>
      Effect.forEach(Array.from({ length: seconds / 5 }), () =>
        TestClock.adjust("5 seconds").pipe(Effect.andThen(realWait(30))),
      )

    // Stopping a command waits on the clock too, so the test clock moves while this waits.
    const untilCount = (seen: ReadonlyArray<unknown>, count: number): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 400 && seen.length < count; attempt++) {
          yield* TestClock.adjust("1 second")
          yield* realWait(25)
        }
        if (seen.length < count) return yield* Effect.fail(new Error("Timed out waiting for the notification"))
      })

    // Waits in real time, without moving the clock, until the notification has been admitted.
    const settle = (seen: ReadonlyArray<unknown>, count: number): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 150 && seen.length < count; attempt++) yield* realWait(20)
        if (seen.length < count) return yield* Effect.fail(new Error("Timed out waiting for the notification"))
      })

    /** The ID of the one running shell, once it has printed. */
    const runningShell = Effect.gen(function* () {
      const shell = yield* Shell.Service
      for (let attempt = 0; attempt < 500; attempt++) {
        const id = (yield* shell.list())[0]?.id
        if (id) {
          yield* untilPrinted(id)
          return id
        }
        yield* realWait(20)
      }
      return yield* Effect.fail(new Error("No shell started"))
    })

    const start = (registry: Tool.Interface, command: string, id: string) =>
      Effect.gen(function* () {
        const settled = yield* executeTool(registry, call({ command, run_in_background: true }, id))
        const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : ""
        expect(shellID).toStartWith("sh_")
        yield* untilPrinted(shellID)
        return shellID
      })

    it.effect(
      "posts one waiting notice about 50 seconds after a background command stops at a prompt, then the completion",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const jobs = yield* Job.Service
            const shellID = yield* start(registry, promptThenIdle, "call-stall")
            yield* advance(45)
            expect(seen).toEqual([])
            yield* TestClock.adjust("5 seconds")
            yield* settle(seen, 1)
            expect(seen).toHaveLength(1)
            expect(seen[0]?.metadata).toMatchObject({ source: "shell", shellID, state: "waiting" })
            expect(seen[0]?.metadata).not.toHaveProperty("exit")
            expect(seen[0]?.text).toContain("Continue? [y/N]")
            expect(seen[0]?.text).toContain(`TaskStop`)
            expect(seen[0]?.text).toContain(shellID)
            expect((yield* shell.get(ID.make(shellID))).status).toBe("running")

            // The completion keeps the job's own message ID and marker; the waiting notice has neither.
            const marker = yield* jobs.pendingBackground
            expect(marker).toHaveLength(1)
            expect(JSON.stringify(marker)).not.toContain(seen[0]?.id ?? "missing")

            yield* advance(600)
            expect(seen).toHaveLength(1)

            yield* shell.kill(ID.make(shellID))
            yield* untilCount(seen, 2)
            expect(seen.map((entry) => entry.metadata.state)).toEqual(["waiting", "completed"])
            expect(yield* jobs.pendingBackground).toEqual([])
          }),
        ),
      { timeout: 30_000 },
    )

    it.effect(
      "stays silent for a quiet command that is not at a prompt",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const shellID = yield* start(registry, `${isWindows ? "[Console]::Out.Write('Compiling...'); " : "printf 'Compiling...'; "}${quietAndIdle}`, "call-quiet")
            yield* advance(300)
            expect(seen).toEqual([])
            yield* shell.kill(ID.make(shellID))
            yield* untilCount(seen, 1)
            expect(seen.map((entry) => entry.metadata.state)).toEqual(["completed"])
          }),
        ),
      { timeout: 30_000 },
    )

    it.effect(
      "posts no waiting notice for a command that ends before the threshold",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            yield* start(registry, promptThenExit, "call-short")
            yield* realWait(500)
            yield* advance(120)
            expect(seen.map((entry) => entry.metadata.state)).toEqual(["completed"])
          }),
        ),
      { timeout: 30_000 },
    )

    it.effect(
      "does not watch a foreground call that is still waiting, and watches it once the deadline moves it",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const fiber = yield* Effect.forkChild(
              executeTool(registry, call({ command: promptThenIdle, timeout: 120_000 }, "call-fg")),
              { startImmediately: true },
            )
            const shellID = yield* runningShell
            yield* advance(100)
            expect(seen).toEqual([])
            yield* advance(25)
            const settled = yield* Fiber.join(fiber)
            expect(settled.metadata).toMatchObject({ status: "running" })
            expect(seen).toEqual([])
            yield* advance(50)
            yield* settle(seen, 1)
            expect(seen.map((entry) => entry.metadata.state)).toEqual(["waiting"])
            yield* shell.kill(ID.make(shellID))
          }),
        ),
      { timeout: 30_000 },
    )

    it.effect(
      "watches a foreground command that a client moves to the background",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const jobs = yield* Job.Service
            const fiber = yield* Effect.forkChild(
              executeTool(registry, call({ command: promptThenIdle, timeout: 120_000 }, "call-moved")),
              { startImmediately: true },
            )
            const shellID = yield* runningShell
            yield* jobs.background(shellID)
            const settled = yield* Fiber.join(fiber)
            expect(settled.metadata).toMatchObject({ status: "running" })
            expect(seen).toEqual([])
            yield* advance(50)
            yield* settle(seen, 1)
            expect(seen.map((entry) => entry.metadata.state)).toEqual(["waiting"])
            yield* shell.kill(ID.make(shellID))
          }),
        ),
      { timeout: 30_000 },
    )

    it.effect(
      "reads the end of a long output, not the start",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const shellID = yield* start(
              registry,
              isWindows
                ? "[Console]::Out.Write('HEAD' + 'MARKER' + ('x' * 3000) + \"`nContinue? [y/N] \"); Start-Sleep -Seconds 600"
                : "printf HEAD; printf MARKER; head -c 3000 /dev/zero | tr '\\0' x; printf '\\nContinue? [y/N] '; sleep 600",
              "call-long",
            )
            yield* advance(50)
            yield* settle(seen, 1)
            expect(seen[0]?.text).toContain("Continue? [y/N]")
            expect(seen[0]?.text).not.toContain("HEADMARKER")
            yield* shell.kill(ID.make(shellID))
          }),
        ),
      { timeout: 30_000 },
    )

    slowIt.effect(
      "posts no waiting notice when the job has already settled by the time one is due",
      () =>
        inFolder(undefined, ({ registry }) =>
          Effect.gen(function* () {
            const seen = yield* collect
            const shell = yield* Shell.Service
            const shellID = yield* start(registry, promptThenIdle, "call-stale")
            slow.stale = true
            yield* advance(60)
            expect(seen).toEqual([])
            slow.stale = false
            yield* shell.kill(ID.make(shellID))
          }).pipe(Effect.ensuring(Effect.sync(() => void (slow.stale = false)))),
        ),
      { timeout: 30_000 },
    )
  })
})

const permissions = (rules: Permission.Ruleset) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(toolIdentity.agent, (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

// The call was refused by a rule, before any question: no request, and the model sees the block.
const expectBlocked = (result: { exit: Exit.Exit<unknown, unknown>; requests: ReadonlyArray<Permission.Request> }) => {
  expect(result.requests).toEqual([])
  expect(result.exit).toMatchObject({
    _tag: "Success",
    value: { status: "error", error: { message: expect.stringMatching(/Permission denied|Blocked by/) } },
  })
}

// The person declined the one question that was asked.
const expectDeclined = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(
      exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError),
    ).toBe(true)
}

describe("ShellTool guard", () => {
  const test = isWindows || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live
  const absent = (file: string) => Effect.promise(() => Bun.file(file).exists()).pipe(Effect.map((exists) => !exists))
  for (const portable of [false, true]) {
    const scanner = portable ? "native" : "legacy"

    // A redirect word before the operand of cd is not the folder (class 3/4): the input is opaque (an unknown variable), so
    // the fragment reader is the only source of the folder.
    for (const redirect of ["2>/dev/null", ">|/dev/null", ">| /dev/null", "<> f", "3<> f"])
      test(`${scanner}: a redirect before the folder of cd still asks for the folder, and a reject keeps the file: ${redirect}`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
            yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
            const result = yield* runPermissionCommand(
              registry,
              `cd ${redirect} '${fixture.outside}' && rm s; echo $FOO`,
              path.join(fixture.active, "k"),
              ["reject"],
            )
            expect(result.requests).toMatchObject([
              { action: "external_directory", resources: [path.join(fixture.outside, "*")] },
            ])
            expectDeclined(result.exit)
            expect(yield* absent(path.join(fixture.outside, "s"))).toBe(false)
          }),
        ))

    test(`${scanner}: a redirect with no command asks by its own statement, and a rule governs it`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const marker = path.join(fixture.active, "marker")
          yield* permissions([{ action: "Bash", resource: "*", effect: "ask" }])
          const asked = yield* runPermissionCommand(registry, "> marker", marker, ["reject"])
          expect(asked.requests).toMatchObject([{ action: "Bash", resources: ["> marker"] }])
          expect(asked.requests[0]?.save).toBeUndefined()
          expectDeclined(asked.exit)
          expect(yield* absent(marker)).toBe(true)

          yield* permissions([{ action: "Bash", resource: "*", effect: "deny" }])
          expectBlocked(yield* runPermissionCommand(registry, "> marker", marker, []))
          expect(yield* absent(marker)).toBe(true)
        }),
      ))

    test(`${scanner}: a saved grant for the commands does not lift a redirect with no command`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["printf *"] })
          const marker = path.join(fixture.active, "marker")
          const asked = yield* runPermissionCommand(registry, "printf x; > marker", marker, ["reject"])
          expect(asked.requests).toHaveLength(1)
          expect(asked.requests[0]?.resources).toContain("> marker")
          expectDeclined(asked.exit)
          expect(yield* absent(marker)).toBe(true)
        }),
      ))

    // A file outside the project is asked about before the command, whatever the command does with it.
    for (const [name, command, setup] of [
      ["a write redirect", "printf x > ../outside/f", false],
      ["a copy's source", "cp ../outside/s ./k", true],
      ["a read", "cat ../outside/s", true],
      ["a removal", "rm ../outside/s", true],
      ["a removal after a cd, in input over the length limit", `cd ../outside && rm s #${"x".repeat(10_050)}`, true],
      ["a file the system keeps for everyone", `printf x > ${os.tmpdir()}/orbit-guard-test-f`, false],
    ] as const)
      test(`${scanner}: ${name} outside the project asks about the folder first`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            if (setup) yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
            yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
            const marker = path.join(fixture.active, "k")
            const result = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(result.requests).toHaveLength(1)
            expect(result.requests[0]).toMatchObject({ action: "external_directory" })
            expectDeclined(result.exit)
            expect(yield* absent(path.join(fixture.outside, "f"))).toBe(true)
            expect(yield* absent(path.join(os.tmpdir(), "orbit-guard-test-f"))).toBe(true)
            expect(yield* absent(marker)).toBe(true)
            if (/\brm\b|Remove-Item/.test(command)) expect(yield* absent(path.join(fixture.outside, "s"))).toBe(false)
          }),
        ))

    test(`${scanner}: a link in the project is judged where it leads`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.symlink(fixture.outside, path.join(fixture.active, "cfg")))
          yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
          yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
          const result = yield* runPermissionCommand(registry, "cat cfg/s", path.join(fixture.active, "none"), ["reject"])
          expect(result.requests).toMatchObject([
            { action: "external_directory", resources: [path.join(fixture.outside, "*")] },
          ])
          expectDeclined(result.exit)
        }),
      ))

    // Decision 6: a deny anywhere beats every question, so the person is not asked about a call a rule blocks.
    test(`${scanner}: a deny on the command, a path or a read blocks the call before any question`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const marker = path.join(fixture.outside, "f")
          const ask = { action: "external_directory", resource: "*", effect: "ask" } as const
          yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }, { action: "Bash", resource: "printf *", effect: "deny" }, ask])
          expectBlocked(yield* runPermissionCommand(registry, "printf x > ../outside/f", marker, []))

          // The person's Edit rule on the file stops a shell command that writes it, under a broad shell allow.
          yield* permissions([
            { action: "Bash", resource: "*", effect: "allow" },
            { action: "Edit", resource: marker.replaceAll("\\", "/"), effect: "deny" },
            ask,
          ])
          expectBlocked(yield* runPermissionCommand(registry, "printf x > ../outside/f", marker, []))
          expectBlocked(yield* runPermissionCommand(registry, "tee ../outside/f", marker, []))
          expect(yield* absent(marker)).toBe(true)

          yield* Effect.promise(() => Bun.write(path.join(fixture.active, "secret.txt"), "secret"))
          yield* permissions([
            { action: "Bash", resource: "*", effect: "allow" },
            { action: "Read", resource: "secret.txt", effect: "deny" },
          ])
          expectBlocked(yield* runPermissionCommand(registry, "cat secret.txt", marker, []))
          expectBlocked(yield* runPermissionCommand(registry, "cp secret.txt copy.txt", marker, []))
          expect(yield* absent(path.join(fixture.active, "copy.txt"))).toBe(true)
        }),
      ))

    // Plan mode denies every edit and asks about every shell command. The deny is the mode's, so the probes for the files a
    // command names skip it and the person is asked about the command; the same deny written by the person blocks it.
    for (const command of ["printf x > notes.md", "touch f", "rm a", "cp a b", "cat a"])
      test(`${scanner}: Plan mode's deny of edits leaves ${command} to the question`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => Bun.write(path.join(fixture.active, "a"), "keep"))
            const marker = path.join(fixture.active, "k")
            yield* permissions([
              { action: "*", resource: "*", effect: "allow" },
              Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const }),
              { action: "Bash", resource: "*", effect: "ask" },
            ])
            const asked = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(asked.requests).toMatchObject([{ action: "Bash" }])
            expectDeclined(asked.exit)
            expect(yield* absent(path.join(fixture.active, "a"))).toBe(false)

            if (command === "cat a") return
            yield* permissions([
              { action: "*", resource: "*", effect: "allow" },
              { action: "Edit", resource: "*", effect: "deny" },
              { action: "Bash", resource: "*", effect: "ask" },
            ])
            expectBlocked(yield* runPermissionCommand(registry, command, marker, []))
            expect(yield* absent(path.join(fixture.active, "a"))).toBe(false)
          }),
        ))

    // Input Orbit cannot analyse is asked about whole, with nothing to save, and is never refused.
    test(`${scanner}: malformed syntax asks about the whole text and a deny rule blocks it`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const marker = path.join(fixture.active, "marker")
          const command = 'printf hello > marker\necho "'
          const asked = yield* runPermissionCommand(registry, command, marker, ["reject"])
          expect(asked.requests).toHaveLength(1)
          expect(asked.requests[0]?.resources[0]).toBe(command)
          expect(asked.requests[0]?.save).toBeUndefined()
          expectDeclined(asked.exit)
          expect(yield* absent(marker)).toBe(true)

          yield* permissions([{ action: "Bash", resource: "printf *", effect: "deny" }])
          expectBlocked(yield* runPermissionCommand(registry, command, marker, []))
          expect(yield* absent(marker)).toBe(true)
        }),
      ))

    for (const command of [
      "if (true) then echo y; fi",
      "while (true) do echo; done",
      "echo $((1; printf 2))",
      "((echo a); echo b)",
      "printf x; echo $(rm -rf ~)",
    ])
      test(`${scanner}: asks about ${JSON.stringify(command)} and runs nothing when declined`, () =>
        withScanner(portable, (registry, fixture) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const location = yield* Location.Service
            yield* saved.add({ projectID: location.project.id, action: "Bash", resources: ["printf *", "echo *"] })
            const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), ["reject"])
            expect(result.requests).toHaveLength(1)
            expect(result.requests[0]?.save).toBeUndefined()
            expectDeclined(result.exit)
          }),
        ))

    test(`${scanner}: input that does nothing asks nothing`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(fixture.active, "sub")))
          for (const command of ["export A=1; cd sub", "# note", "", "A=1"]) {
            const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), [])
            expect([command, result.requests]).toEqual([command, []])
            expect(result.exit).toMatchObject({ _tag: "Success", value: { status: "completed" } })
          }
          const substitution = yield* runPermissionCommand(registry, "A=$(printf x)", path.join(fixture.active, "marker"), ["reject"])
          expect(substitution.requests).toHaveLength(1)
        }),
      ))
  }
})

describe("ShellTool guard (PowerShell)", () => {
  const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh ? permissionIt.live : permissionIt.live.skip
  // Rule matching is case-insensitive only on Windows (Orbit's wildcard), so the rows that write a rule in one case for a
  // command written in another run there.
  const windows = pwsh && isWindows ? permissionIt.live : permissionIt.live.skip
  const options = { timeout: 30_000 }
  const absent = (file: string) => Effect.promise(() => Bun.file(file).exists()).pipe(Effect.map((exists) => !exists))
  const ask = <E, R>(
    body: (registry: Tool.Interface, fixture: { active: string; outside: string }) => Effect.Effect<void, E, R>,
  ) => withScanner(false, body, pwsh ?? "pwsh")

  test(
    "resources and saves come from PowerShell's own parse",
    () =>
      ask((registry, fixture) =>
        Effect.gen(function* () {
          const result = yield* runPermissionCommand(
            registry,
            "Get-ChildItem; Remove-Item x",
            path.join(fixture.active, "marker"),
            ["reject"],
          )
          expect(result.requests).toMatchObject([
            { resources: ["Get-ChildItem", "Remove-Item x"], save: ["Get-ChildItem *", "Remove-Item *"] },
          ])
        }),
      ),
    options,
  )

  for (const [command, save] of [
    ["git status -s", ["git status *"]],
    ["git", undefined],
    ["git.exe status", undefined],
    ["git 'push origin'", undefined],
    ["& $c x", undefined],
    ["Invoke-Expression 'x'", undefined],
    ["iex 'x'", undefined],
    ["pwsh -c x", undefined],
    ["node x.js", undefined],
    ["ForEach-Object { }", undefined],
    // Cmdlets whose script-block and member-access arguments run code, under every spelling of their names: a saved
    // `Where-Object *` would lift each of them.
    ...[
      "Where-Object { 1 }",
      "where { 1 }",
      "? { 1 }",
      "Select-Object Name",
      "select Name",
      "Sort-Object Name",
      "sort Name",
      "Group-Object Name",
      "group Name",
      "Measure-Object",
      "measure",
      "Format-Table",
      "ft",
      "Format-List",
      "fl",
      "Format-Wide",
      "fw",
      "Format-Custom",
      "fc",
      "Out-String",
      "Out-Host",
      "oh",
      "Write-Output x",
      "echo x",
      "write x",
      "Write-Host x",
      "Start-Sleep 1",
      "sleep 1",
      "iwmi Win32_Process Create",
      "icim Win32_Process Create",
      "ipconfig /all",
      "ipconfig",
      "route print",
      "hostname",
    ].map((command) => [command, undefined] as const),
    // Spawners and runners: a saved `ssh *` would lift `ssh -o ProxyCommand=... x`, which runs a local command.
    ["ssh host ls", undefined],
    ["py x.py", undefined],
    ["python2 x.py", undefined],
    ["tsx x.ts", undefined],
    ["lua x.lua", undefined],
    ["bunx pkg", undefined],
    ["New-Object System.Object", undefined],
    ["New-PSSession host", undefined],
    ["Start-ThreadJob { 1 }", undefined],
    ["Register-ObjectEvent $o E", undefined],
    ["New-PSDrive -Name Q -PSProvider FileSystem -Root C:\\Windows", undefined],
  ] as const)
    test(
      `offers ${save ? JSON.stringify(save) : "nothing to save"} for ${command}`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), ["reject"])
            expect(result.requests).toHaveLength(1)
            expect(result.requests[0]?.save).toEqual(save)
          }),
        ),
      options,
    )

  for (const command of ["'x' > marker", "[IO.File]::WriteAllText('marker','x')"])
    test(
      `asks by the statement for ${command}, and writes nothing when declined`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            const marker = path.join(fixture.active, "marker")
            const result = yield* runPermissionCommand(registry, command, marker, ["reject"])
            expect(result.requests).toHaveLength(1)
            expect(result.requests[0]?.resources).toContain(command)
            expectDeclined(result.exit)
            expect(yield* absent(marker)).toBe(true)
          }),
        ),
      options,
    )

  for (const [rule, commands] of [
    ["Remove-Item *", ["rm x", "del x", "& 'Remove-Item' x", "Microsoft.PowerShell.Management\\Remove-Item x", "Remove-Item\tx"]],
    ["rm *", ["Remove-Item x"]],
  ] as const)
    windows(
      `a deny written as ${rule} meets ${commands.join(" | ")}`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            yield* permissions([
              { action: "Bash", resource: "*", effect: "allow" },
              { action: "Bash", resource: rule, effect: "deny" },
            ])
            yield* Effect.promise(() => Bun.write(path.join(fixture.active, "x"), "keep"))
            for (const command of commands)
              expectBlocked(yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), []))
            expect(yield* absent(path.join(fixture.active, "x"))).toBe(false)
          }),
        ),
      options,
    )

  // Padded past the parse limit the input is opaque, and its fragments must still answer to every spelling of the cmdlet.
  for (const [rule, commands] of [
    [
      "Remove-Item *",
      ["rm x", "del x", "ri x", "Microsoft.PowerShell.Management\\Remove-Item x", "Remove-Item\tx", "& 'rm' x", "Remove-Item x"],
    ],
    ["rm *", ["Remove-Item x", "del x"]],
    ["Invoke-Expression *", ["iex 'Remove-Item x'"]],
  ] as const)
    windows(
      `a deny written as ${rule} meets ${commands.join(" | ")} when the input is too long to parse`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            yield* permissions([
              { action: "Bash", resource: "*", effect: "allow" },
              { action: "Bash", resource: rule, effect: "deny" },
            ])
            yield* Effect.promise(() => Bun.write(path.join(fixture.active, "x"), "keep"))
            for (const command of commands)
              expectBlocked(
                yield* runPermissionCommand(
                  registry,
                  `${command}; #${"x".repeat(20_000)}`,
                  path.join(fixture.active, "marker"),
                  [],
                ),
              )
            expect(yield* absent(path.join(fixture.active, "x"))).toBe(false)
          }),
        ),
      { timeout: 60_000 },
    )

  windows(
    "an application is denied by the rule for its cmdlet name and never lifted by an allow for it",
    () =>
      ask((registry, fixture) =>
        Effect.gen(function* () {
          yield* permissions([
            { action: "Bash", resource: "*", effect: "ask" },
            { action: "Bash", resource: "Remove-VM *", effect: "deny" },
          ])
          expectBlocked(yield* runPermissionCommand(registry, "Hyper-V\\Remove-VM x", path.join(fixture.active, "m"), []))

          yield* permissions([
            { action: "Bash", resource: "*", effect: "ask" },
            { action: "Bash", resource: "Remove-VM *", effect: "allow" },
            { action: "Bash", resource: "Get-Content *", effect: "allow" },
          ])
          for (const command of ["Hyper-V\\Remove-VM x", ".\\scripts\\Get-Content x"]) {
            const asked = yield* runPermissionCommand(registry, command, path.join(fixture.active, "m"), ["reject"])
            expect(asked.requests).toHaveLength(1)
          }
        }),
      ),
    options,
  )

  // Input too long to parse that starts with a path to a program of the repository is never lifted by an allow written for the
  // cmdlet of the same name (class 8): the program is not the cmdlet. Its stripped spelling still answers to a deny.
  for (const [rule, command] of [
    ["rm *", ".\\rm x"],
    ["rm *", "scripts\\rm x"],
    ["rm *", "&.\\rm x"],
    ["rm *", "& '.\\rm' x"],
    ["Remove-Item *", ".\\Remove-Item x"],
  ] as const)
    windows(
      `an allow for ${rule} does not lift ${command} when the input is too long to parse, and a deny still blocks it`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            const ran = path.join(fixture.active, "ran.txt")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(fixture.active, "scripts"))
              const body = `@echo off\r\necho ran> "${ran}"\r\n`
              await Promise.all(
                ["rm.cmd", "Remove-Item.cmd", "scripts\\rm.cmd"].map((file) => Bun.write(path.join(fixture.active, file), body)),
              )
            })
            const padded = `${command} #${"x".repeat(20_000)}`
            yield* permissions([
              { action: "Bash", resource: "*", effect: "ask" },
              { action: "Bash", resource: rule, effect: "allow" },
            ])
            const asked = yield* runPermissionCommand(registry, padded, path.join(fixture.active, "marker"), ["reject"])
            expect(asked.requests).toHaveLength(1)
            expect(yield* Effect.promise(() => Bun.file(ran).exists())).toBe(false)

            yield* permissions([
              { action: "Bash", resource: "*", effect: "allow" },
              { action: "Bash", resource: rule, effect: "deny" },
            ])
            expectBlocked(yield* runPermissionCommand(registry, padded, path.join(fixture.active, "marker"), []))
            expect(yield* Effect.promise(() => Bun.file(ran).exists())).toBe(false)
          }),
        ),
      { timeout: 60_000 },
    )

  // New-PSDrive makes a drive, which can be a network share with a connection to any host: it is a command like any other,
  // not a change of location that the guard sets aside.
  for (const drive of [
    "New-PSDrive -Name Q -PSProvider FileSystem -Root C:\\Windows",
    "New-PSDrive -Name Q -PSProvider FileSystem -Root \\\\10.255.255.1\\s -Persist",
  ])
    test(
      `New-PSDrive is denied by a deny rule and asked by its own text: ${drive}`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            const marker = path.join(fixture.active, "marker")
            yield* permissions([{ action: "Bash", resource: "*", effect: "deny" }])
            expectBlocked(yield* runPermissionCommand(registry, drive, marker, []))

            yield* permissions([{ action: "Bash", resource: "*", effect: "ask" }])
            const asked = yield* runPermissionCommand(registry, drive, marker, ["reject"])
            expect(asked.requests).toHaveLength(1)
            expect(asked.requests[0]?.resources).toEqual([drive])
            expect(asked.requests[0]?.save).toBeUndefined()
            expectDeclined(asked.exit)

            // Beside another command, both are listed.
            const both = yield* runPermissionCommand(registry, `${drive}; Get-ChildItem`, marker, ["reject"])
            expect(both.requests[0]?.resources).toEqual([drive, "Get-ChildItem"])
          }),
        ),
      options,
    )

  test(
    "PowerShell the parser rejects is asked about whole and by fragment, and a deny meets a fragment",
    () =>
      ask((registry, fixture) =>
        Effect.gen(function* () {
          const command = "Write-Output \"unterminated; iex 'calc'"
          const asked = yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), ["reject"])
          expect(asked.requests).toHaveLength(1)
          expect(asked.requests[0]?.resources[0]).toBe(command)
          expect(asked.requests[0]?.save).toBeUndefined()

          yield* permissions([
            { action: "Bash", resource: "*", effect: "allow" },
            { action: "Bash", resource: "iex *", effect: "deny" },
          ])
          expectBlocked(yield* runPermissionCommand(registry, command, path.join(fixture.active, "marker"), []))

          // The folder change inside input that cannot be read is still asked about.
          yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
          const location = yield* runPermissionCommand(registry, 'Set-Location ..\\outside; "', path.join(fixture.active, "m"), ["reject"])
          expect(location.requests).toMatchObject([{ action: "external_directory" }])
        }),
      ),
    options,
  )

  // A folder change that the shell's parser cannot analyse (the pad makes the input too long) is asked about as its short
  // form is, and a rejected question keeps the file. Each spelling is one that PowerShell accepts for the same folder.
  for (const spelling of [
    "Set-Location ../out\"side\"",
    "Set-Location -Path:../outside",
    "Push-Location -LiteralPath:../outside",
    "Push-Location -StackName st ../outside",
    "Set-Location -PSPath:../outside",
    "Set-Location $env:ORBIT_TOOL_OUT",
    "Set-Location <# c #> ../outside",
    "Write-Output '<#'; Set-Location ../outside",
    "Write-Output \"<#\"; Set-Location ../outside",
    "Write-Output ok # note <#\nSet-Location ../outside",
    "Write-Output x<#\nSet-Location ../outside",
    "$h = @'\nit's <#\n'@\nSet-Location ../outside",
    "Set-Location ../outside # see HKLM:\\Software",
  ])
    for (const padded of [false, true])
      test(
        `a removal after ${spelling} asks for the folder first${padded ? ", in input over the length limit" : ""}`,
        () =>
          ask((registry, fixture) =>
            Effect.gen(function* () {
              process.env.ORBIT_TOOL_OUT = fixture.outside
              yield* Effect.addFinalizer(() => Effect.sync(() => void delete process.env.ORBIT_TOOL_OUT))
              yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
              yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
              const command = `${spelling}; Remove-Item s${padded ? ` #${"x".repeat(10_050)}` : ""}`
              const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "k"), ["reject"])
              expect(result.requests).toHaveLength(1)
              expect(result.requests[0]).toMatchObject({ action: "external_directory", resources: [path.join(fixture.outside, "*").replaceAll("\\", "/")] })
              expectDeclined(result.exit)
              expect(yield* absent(path.join(fixture.outside, "s"))).toBe(false)
            }),
          ),
        options,
      )

  // PowerShell 7 goes home for a location change with no path: an empty one, or only parameters that take none (class 8).
  for (const spelling of ["Set-Location", "cd", "Set-Location ''", 'cd ""', "sl -Path ''", "cd -Path:''", "cd -PassThru", "cd -ErrorAction Stop", "cd --", "cd -PassThru --", "cd -Verbose --", "cd -ea Stop <#p#>", "Write-Output '<#'; cd -PassThru"])
    for (const padded of [false, true])
      test(
        `a removal after ${spelling} asks for the home folder first${padded ? ", in input over the length limit" : ""}`,
        () =>
          ask((registry, fixture) =>
            Effect.gen(function* () {
              yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
              const command = `${spelling}; Remove-Item orbit-no-such-file${padded ? ` #${"x".repeat(10_050)}` : ""}`
              const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "k"), ["reject"])
              expect(result.requests).toHaveLength(1)
              expect(result.requests[0]).toMatchObject({
                action: "external_directory",
                resources: [path.join(os.homedir(), "*").replaceAll("\\", "/")],
              })
              expectDeclined(result.exit)
            }),
          ),
        options,
      )

  // A misread that drops the folder must not drop the one after it (class 3/4/8): the raw reading is the text as written,
  // so a trailing backslash does not join the next line, and a block comment between the cmdlet and its folder is blanks.
  for (const opener of ["Write-Output x<#", "$h = @'\nit's <#\n'@"])
    for (const [name, line, folder] of [
      ["a trailing backslash", "Set-Location ..\\\nRemove-Item outside\\s", (fixture: { active: string }) => path.dirname(fixture.active)],
      [
        "a block comment before the folder",
        "Set-Location <# c #> ../outside\nRemove-Item s",
        (fixture: { outside: string }) => fixture.outside,
      ],
    ] as const)
      test(
        `a removal after ${opener} and ${name} asks for the folder, and a reject keeps the file`,
        () =>
          ask((registry, fixture) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
              yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
              const command = `${opener}\n${line} #${"x".repeat(10_050)}`
              const result = yield* runPermissionCommand(registry, command, path.join(fixture.active, "k"), ["reject"])
              expect(result.requests).toHaveLength(1)
              expect(result.requests[0]).toMatchObject({
                action: "external_directory",
                resources: [path.join(folder(fixture as { active: string; outside: string }), "*").replaceAll("\\", "/")],
              })
              expectDeclined(result.exit)
              expect(yield* absent(path.join(fixture.outside, "s"))).toBe(false)
            }),
          ),
        options,
      )

  // A `<#` inside a word or quotes is not a comment opener (class 3/4/8): the raw reading keeps the text as written too.
  for (const [name, line, home] of [
    ["a word that ends in the opener", "Set-Location -ErrorVariable e<# ../outside #>\nRemove-Item s", true],
    ["a stack name that ends in the opener", "Push-Location -StackName a<# ../outside #>\nRemove-Item s", false],
    ["quoted openers", "Write-Output x<#\nSet-Location -ErrorVariable '<#' ../outside -OutVariable '#>'\nRemove-Item s", false],
  ] as const)
    test(
      `a removal after ${name} asks for the folder, and a reject keeps the file`,
      () =>
        ask((registry, fixture) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => Bun.write(path.join(fixture.outside, "s"), "secret"))
            yield* permissions([{ action: "Bash", resource: "*", effect: "allow" }])
            const result = yield* runPermissionCommand(
              registry,
              `${line} #${"x".repeat(10_050)}`,
              path.join(fixture.active, "k"),
              ["reject"],
            )
            expect(result.requests).toHaveLength(1)
            expect(result.requests[0]).toMatchObject({
              action: "external_directory",
              // The comment-blanked reading of the first row is a parameter-only Set-Location, which asks for home first.
              resources: [...(home ? [path.join(os.homedir(), "*")] : []), path.join(fixture.outside, "*")].map((item) => item.replaceAll("\\", "/")),
            })
            expectDeclined(result.exit)
            expect(yield* absent(path.join(fixture.outside, "s"))).toBe(false)
          }),
        ),
      options,
    )
})

// A path spelling of a location cmdlet is a program of the repository, not the cmdlet. Under the default ask every such
// call is asked about and, with each question rejected, the decoy never runs. The control is an ordinary command.
describe("ShellTool: a location cmdlet spelled as a path", () => {
  const pwsh = Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh && isWindows ? permissionIt.live : permissionIt.live.skip
  for (const row of [
    { command: String.raw`scripts\Set-Location .`, decoy: "Set-Location.bat" },
    { command: String.raw`scripts\Pop-Location`, decoy: "Pop-Location.cmd" },
    { command: String.raw`& 'scripts\Set-Location' .`, decoy: "Set-Location.bat" },
    { command: String.raw`scripts\Push-Location .`, decoy: "Push-Location.ps1" },
  ])
    test(
      `asks before running ${row.command}`,
      () =>
        withScanner(
          false,
          (registry, fixture) =>
            Effect.gen(function* () {
              const marker = path.join(fixture.active, "marker.txt")
              yield* Effect.promise(() => fs.mkdir(path.join(fixture.active, "scripts")))
              const body = row.decoy.endsWith(".ps1")
                ? "Set-Content -Path (Join-Path $PSScriptRoot '..\\marker.txt') -Value ran\r\n"
                : '@echo off\r\necho ran> "%~dp0..\\marker.txt"\r\n'
              yield* Effect.promise(() => Bun.write(path.join(fixture.active, "scripts", row.decoy), body))
              const permission = yield* Permission.Service
              const bus = yield* Bus.Service
              const asked: Permission.Request[] = []
              yield* bus.subscribe(Permission.Event.Asked).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    asked.push(event.data)
                    yield* permission.reply({ requestID: event.data.id, reply: "reject" })
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              )
              yield* executeTool(registry, call({ command: "Write-Output hi" }, "call-control")).pipe(Effect.exit)
              expect(asked).toHaveLength(1)
              yield* executeTool(registry, call({ command: row.command }, "call-decoy")).pipe(Effect.exit)
              expect(asked).toHaveLength(2)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            }).pipe(Effect.scoped),
          pwsh ?? "powershell",
        ),
      { timeout: 120_000 },
    )
})
