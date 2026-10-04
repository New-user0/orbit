import { beforeEach, describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { SessionInbox } from "@orbit/schema/session-inbox"
import { SessionMessage } from "@orbit/schema/session-message"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Command } from "@orbit/core/command"
import { Config } from "@orbit/core/config"
import { ConfigCommandPlugin } from "@orbit/core/config/plugin/command"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Job } from "@orbit/core/job"
import { Location } from "@orbit/core/location"
import { Mcp } from "@orbit/core/mcp/index"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { ShellSelect } from "@orbit/core/shell/select"
import { which } from "@orbit/core/util/which"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { AppProcess } from "@orbit/util/process"
import { tempGlobalLayer } from "../fixture/global"
import { emptyConfigLayer, emptyMcpLayer, testLocationLayer } from "../fixture/mcp"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { host } from "../plugin/host"

const sessionID = Session.ID.make("ses_command_shell")
const decode = Schema.decodeUnknownSync(Info)

// Spawns and permission requests are recorded instead of performed, so every test can prove what did not happen.
const spawned: { command: string; args: readonly string[]; cwd?: string }[] = []
const asserted: Permission.AssertInput[] = []
const denied = new Set<string>()
const printed = new Map<string, string>()

const processes = Layer.mock(AppProcess.Service, {
  run: (command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("expected a standard command")
      spawned.push({ command: command.command, args: command.args, cwd: command.options.cwd })
      const source = command.args.at(-1) ?? ""
      return {
        command: command.command,
        exitCode: 0,
        output: Buffer.from(printed.get(source) ?? `<${source}>`),
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      }
    }),
})

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => asserted.push(input)).pipe(
      Effect.andThen(
        input.resources.some((resource) => denied.has(resource))
          ? Effect.fail(
              new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
            )
          : Effect.void,
      ),
    ),
})

const shell = Layer.succeed(
  ShellSelect.Service,
  ShellSelect.Service.of({
    resolve: () => Effect.succeed("sh"),
    transform: () => Effect.die("unused shell.transform"),
    reload: () => Effect.die("unused shell.reload"),
  }),
)

const nodes = LayerNode.group([
  Command.node,
  Bus.node,
  FSUtil.node,
  AppProcess.node,
  Location.node,
  ShellSelect.node,
  Permission.node,
  Session.node,
  Job.node,
  Agent.node,
])
const replacements = [
  Mcp.node.replace(emptyMcpLayer),
  Config.node.replace(emptyConfigLayer),
  Location.node.replace(testLocationLayer),
  ShellSelect.node.replace(shell),
  AppProcess.node.replace(processes),
  Global.node.replace(tempGlobalLayer),
  SessionExecution.node.replace(SessionExecution.noopLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const it = testEffect(AppNodeBuilder.build(nodes, [...replacements, Permission.node.replace(permission)]))
const real = testEffect(AppNodeBuilder.build(nodes, replacements))

beforeEach(() => {
  spawned.length = 0
  asserted.length = 0
  denied.clear()
  printed.clear()
})

describe("command template shell spans", () => {
  for (const item of [
    {
      name: "$ARGUMENTS",
      template: "Explain $ARGUMENTS.",
      input: "!`touch pwned`",
      expected: "Explain !`touch pwned`.",
    },
    { name: "$1", template: "Explain $1.", input: '"!`touch pwned`"', expected: "Explain !`touch pwned`." },
    {
      name: "an input appended to a template without placeholders",
      template: "Explain.",
      input: "!`touch pwned`",
      expected: "Explain.\n\n!`touch pwned`",
    },
    {
      name: "an input appended after an authored span",
      template: "Explain !`date`.",
      input: "!`touch pwned`",
      expected: "Explain <date>.\n\n!`touch pwned`",
      ran: ["date"],
    },
    {
      name: "$ARGUMENTS beside an authored span",
      template: "Run !`date`: $ARGUMENTS",
      input: "!`touch pwned` and !`rm -rf /`",
      expected: "Run <date>: !`touch pwned` and !`rm -rf /`",
      ran: ["date"],
    },
  ]) {
    it.live(`inserts ${item.name} literally and never runs a span from it`, () =>
      Effect.gen(function* () {
        const ran = item.ran ?? []
        const probe = yield* install(item.template)
        yield* probe.execute(item.input)
        expect(probe.prompts).toEqual([item.expected])
        expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(ran)
        expect(asserted.map((input) => input.resources)).toEqual(ran.map((source) => [source]))
      }),
    )
  }

  it.live("asks for each authored span as a shell action, without a tool source", () =>
    Effect.gen(function* () {
      const probe = yield* install("Status: !`git status`\nLog: !`git log -n 3 && cat notes.txt`")
      yield* probe.execute("")
      expect(asserted).toStrictEqual([
        { action: "shell", resources: ["git status"], save: ["git status *"], sessionID },
        {
          action: "shell",
          resources: ["git log -n 3", "cat notes.txt"],
          save: ["git log *", "cat *"],
          sessionID,
        },
      ])
      expect(spawned).toEqual([
        { command: "sh", args: ["-c", "git status"], cwd: process.cwd() },
        { command: "sh", args: ["-c", "git log -n 3 && cat notes.txt"], cwd: process.cwd() },
      ])
      expect(probe.prompts).toEqual(["Status: <git status>\nLog: <git log -n 3 && cat notes.txt>"])
    }),
  )

  it.live("asks about a span in which the scanner finds no command as the span was written", () =>
    Effect.gen(function* () {
      const probe = yield* install("!`> out.txt`")
      yield* probe.execute("")
      expect(asserted).toStrictEqual([{ action: "shell", resources: ["> out.txt"], save: [], sessionID }])
    }),
  )

  it.live("reads the portable scanner setting and fails closed on a span it cannot analyze", () =>
    Effect.gen(function* () {
      const probe = yield* install('Status: !`git status`\nBroken: !`echo "oops`', {
        experimental: { portable_shell_scanner: true },
      })
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error.message).toBe(
        'Shell interpolation failed for "echo \\"oops": Portable shell scanner cannot analyze command: unterminated-quote',
      )
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )

  it.live("authorizes every span before running any, so one denial runs nothing", () =>
    Effect.gen(function* () {
      denied.add("rm -rf build")
      const probe = yield* install("Status: !`git status`\nClean: !`rm -rf build`")
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error).toBeInstanceOf(Command.ExecutionError)
      expect(error.message).toBe('Shell interpolation failed for "rm -rf build": Permission denied: shell')
      expect(asserted.map((input) => input.resources)).toEqual([["git status"], ["rm -rf build"]])
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )

  it.live("never asks, or runs anything, for a template without spans", () =>
    Effect.gen(function* () {
      const probe = yield* install("Explain $ARGUMENTS")
      yield* probe.execute("this")
      expect(probe.prompts).toEqual(["Explain this"])
      expect(asserted).toEqual([])
      expect(spawned).toEqual([])
    }),
  )

  // Windows has no sandbox tool, so the wrapper is chosen by platform and found on PATH: point this platform at a tool
  // every machine has, which makes the wrapped path observable everywhere.
  const tool = process.platform === "win32" ? "cmd" : "sh"

  it.live("runs an approved span through the sandbox wrapper", () =>
    withSandboxTool(
      tool,
      Effect.gen(function* () {
        const found = which(tool)
        if (!found) return yield* Effect.die(`expected ${tool} on PATH`)
        const probe = yield* install("Status: !`git status`", { sandbox: { enabled: true } })
        yield* probe.execute("")
        expect(spawned).toHaveLength(1)
        expect(spawned[0].command).toBe(found)
        expect(spawned[0].args.length).toBeGreaterThan(3)
        expect(spawned[0].args.slice(-3)).toEqual(["sh", "-c", "git status"])
        expect(probe.prompts).toEqual(["Status: <git status>"])
      }),
    ),
  )

  it.live("fails closed instead of running a span unsandboxed when the sandbox tool is missing", () =>
    withSandboxTool(
      "orbit-missing-sandbox-tool",
      Effect.gen(function* () {
        const probe = yield* install("Status: !`git status`", { sandbox: { enabled: true } })
        const error = yield* probe.execute("").pipe(Effect.flip)
        expect(error.message).toBe(
          'Shell interpolation failed for "git status": Shell sandboxing is enabled but orbit-missing-sandbox-tool is not installed',
        )
        expect(spawned).toEqual([])
        expect(probe.prompts).toEqual([])
      }),
    ),
  )

  it.live("expands $1 and $ARGUMENTS in the prose around a span, but not in the span or its output", () =>
    Effect.gen(function* () {
      const probe = yield* install("Review $1 ($ARGUMENTS): !`git diff $1`")
      yield* probe.execute("src extra")
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git diff $1"])
      expect(probe.prompts).toEqual(["Review src extra (src extra): <git diff $1>"])
    }),
  )

  it.live("treats a span holding only a placeholder as literal shell text and appends the input", () =>
    Effect.gen(function* () {
      const probe = yield* install("Files: !`ls $1`")
      yield* probe.execute("src")
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["ls $1"])
      expect(probe.prompts).toEqual(["Files: <ls $1>\n\nsrc"])
    }),
  )

  it.live("trims only the template's own edges and inserts span output exactly as printed", () =>
    Effect.gen(function* () {
      printed.set("cat notes", "  first\nlast\n")
      const probe = yield* install("\n  !`cat notes`  \n")
      yield* probe.execute("")
      expect(probe.prompts).toEqual(["  first\nlast\n"])
    }),
  )

  it.live("trims a template without spans exactly as before", () =>
    Effect.gen(function* () {
      const probe = yield* install("  Explain $1 and $2  \n")
      yield* probe.execute("this")
      expect(probe.prompts).toEqual(["Explain this and"])
    }),
  )
})

describe("command template shell spans with the permission service", () => {
  real.live("asks once per uncovered span, in template order, and runs only after the last answer", () =>
    Effect.gen(function* () {
      const session = yield* createSession([{ action: "shell", resource: "git status", effect: "allow" }])
      const permission = yield* Permission.Service
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`\nLog: !`git log -n 3`\nDiff: !`git diff`", {}, session.id)
      const running = yield* probe.execute("").pipe(Effect.forkScoped)

      const first = yield* Queue.take(asked)
      expect(first).toMatchObject({
        action: "shell",
        resources: ["git log -n 3"],
        save: ["git log *"],
        sessionID: session.id,
      })
      // Tool grants key on the request's tool source, so a span must not carry one.
      expect(first.source).toBeUndefined()
      expect(spawned).toEqual([])
      yield* permission.reply({ requestID: first.id, reply: "once" })
      const second = yield* Queue.take(asked)
      expect(second.resources).toEqual(["git diff"])
      expect(spawned).toEqual([])
      yield* permission.reply({ requestID: second.id, reply: "once" })
      yield* Fiber.join(running)
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git status", "git log -n 3", "git diff"])
      expect(probe.prompts).toEqual(["Status: <git status>\nLog: <git log -n 3>\nDiff: <git diff>"])
      expect(yield* Queue.size(asked)).toBe(0)
    }),
  )

  real.live("runs nothing and submits nothing when the user rejects a span", () =>
    Effect.gen(function* () {
      const session = yield* createSession([])
      const permission = yield* Permission.Service
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`", {}, session.id)
      const running = yield* probe.execute("").pipe(Effect.forkScoped)

      const request = yield* Queue.take(asked)
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(running)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
      ).toBe(true)
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )

  real.live("fails the command on a deny rule before any approved span runs", () =>
    Effect.gen(function* () {
      const session = yield* createSession([
        { action: "shell", resource: "git *", effect: "allow" },
        { action: "shell", resource: "rm *", effect: "deny" },
      ])
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`\nClean: !`rm -rf build`", {}, session.id)
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error.message).toBe('Shell interpolation failed for "rm -rf build": Permission denied: shell')
      expect(yield* Queue.size(asked)).toBe(0)
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )
})

// The build agent gets exactly these rules; an empty list leaves every shell command to ask.
function createSession(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
      title: "shell spans",
      agent: Agent.ID.make("build"),
    })
    // Creating a session probes the project with git through the same process service; keep only what the spans run.
    spawned.length = 0
    return session
  })
}

const requests = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const queue = yield* Queue.unbounded<Permission.Request>()
  yield* bus.subscribe(Permission.Event.Asked).pipe(
    Stream.runForEach((event) => Queue.offer(queue, event.data)),
    Effect.forkScoped({ startImmediately: true }),
  )
  return queue
})

function install(template: string, settings: Record<string, unknown> = {}, session: Session.ID = sessionID) {
  return Effect.gen(function* () {
    const command = yield* Command.Service
    const prompts: string[] = []
    yield* ConfigCommandPlugin.Plugin.effect(
      host({
        command: {
          list: () => Effect.die("unused command.list"),
          transform: command.transform,
          reload: command.reload,
        },
        session: {
          prompt: (input) =>
            Effect.sync(() => {
              prompts.push(input.text)
              return SessionInbox.User.make({
                id: SessionMessage.ID.make("msg_test"),
                sessionID: input.sessionID,
                time: { created: DateTime.makeUnsafe(0) },
                type: "user",
                payload: { text: input.text },
                delivery: input.delivery ?? "steer",
              })
            }),
        },
      }),
    ).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({ type: "document", info: decode({ commands: { probe: { template } }, ...settings }) }),
        ]),
      ),
    )
    return {
      prompts,
      execute: (text: string) =>
        command.execute({ name: "probe", invocation: { sessionID: session, prompt: { text }, delivery: "queue" } }),
    }
  })
}

function withSandboxTool<A, E, R>(tool: string, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = ShellSandbox.TOOL[process.platform]
      ShellSandbox.TOOL[process.platform] = tool
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete ShellSandbox.TOOL[process.platform]
        else ShellSandbox.TOOL[process.platform] = previous
      }),
  )
}
