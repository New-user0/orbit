import path from "path"
import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { SessionInbox } from "@orbit/schema/session-inbox"
import { SessionMessage } from "@orbit/schema/session-message"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Command } from "@orbit/core/command"
import { Config } from "@orbit/core/config"
import { ConfigCommandPlugin } from "@orbit/core/config/plugin/command"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Instance } from "@orbit/core/instance/service"
import { Job } from "@orbit/core/job"
import { Location } from "@orbit/core/location"
import { Mcp } from "@orbit/core/mcp/index"
import { Permission } from "@orbit/core/permission"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ProjectTrust } from "@orbit/core/project-trust"
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
import { trustedProject } from "../fixture/project-trust"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { host } from "../plugin/host"

const sessionID = Session.ID.make("ses_command_shell")
const decode = Schema.decodeUnknownSync(Info)

// Spawns and permission requests are recorded instead of performed, so every test can prove what did not happen.
const spawned: { command: string; args: readonly string[]; cwd?: string }[] = []
const spawnedEnv: (Record<string, string | undefined> | undefined)[] = []
const asserted: Permission.AssertInput[] = []
const denied = new Set<string>()
const failing = new Set<string>()
const printed = new Map<string, string>()

const processes = Layer.mock(AppProcess.Service, {
  run: (command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("expected a standard command")
      spawned.push({ command: command.command, args: command.args, cwd: command.options.cwd })
      spawnedEnv.push(command.options.env)
      const source = command.args.at(-1) ?? ""
      if (failing.has(source))
        return yield* new AppProcess.AppProcessError({
          command: `${command.command} -c ${source}`,
          cause: new Error("spawn failed"),
        })
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

// The two priorities answer differently, as they do for a user whose configured shell is one the scanner cannot read.
const shell = Layer.succeed(
  ShellSelect.Service,
  ShellSelect.Service.of({
    resolve: (input) => Effect.succeed(input.priority === "compat" ? "sh" : "fish"),
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
  ProjectTrust.node,
  ManagedPolicy.node,
])
const replacements = [
  Mcp.node.replace(emptyMcpLayer),
  ProjectTrust.node.replace(trustedProject),
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
// Real project config, plugins and permissions, so a command the user types is driven through Session.command.
const routed = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, Instance.node, Bus.node]), [
    AppProcess.node.replace(processes),
    ShellSelect.node.replace(shell),
    Global.node.replace(tempGlobalLayer),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Watcher.node.replace(Watcher.configured({ enabled: false })),
    offlineModels,
  ]),
)

beforeEach(() => {
  spawned.length = 0
  spawnedEnv.length = 0
  asserted.length = 0
  denied.clear()
  failing.clear()
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

  it.live("never expands $ARGUMENTS inside a span, so argument text cannot reach the shell", () =>
    Effect.gen(function* () {
      const probe = yield* install("Log: !`git log $ARGUMENTS`")
      yield* probe.execute("; touch pwned")
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git log $ARGUMENTS"])
      expect(asserted.map((input) => input.resources)).toEqual([["git log $ARGUMENTS"]])
      expect(probe.prompts).toEqual(["Log: <git log $ARGUMENTS>\n\n; touch pwned"])
    }),
  )

  it.live("asks for each authored span as a shell action, without a tool source", () =>
    Effect.gen(function* () {
      const probe = yield* install("Status: !`git status`\nLog: !`git log -n 3 && cat notes.txt`")
      yield* probe.execute("")
      expect(asserted).toStrictEqual([
        {
          action: "Bash",
          resources: ["git status"],
          save: ["git status *"],
          metadata: { command: "git status" },
          sessionID,
        },
        {
          action: "Bash",
          resources: ["git log -n 3", "cat notes.txt"],
          save: ["git log *", "cat *"],
          metadata: { command: "git log -n 3 && cat notes.txt" },
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
      expect(asserted).toStrictEqual([
        { action: "Bash", resources: ["> out.txt"], save: [], metadata: { command: "> out.txt" }, sessionID },
      ])
    }),
  )

  it.live("asks about a span that changes directory as written, beside its commands", () =>
    Effect.gen(function* () {
      const probe = yield* install("Keys: !`cd keys && cat id_rsa`")
      yield* probe.execute("")
      // The commands alone would show `cat id_rsa` and hide that it reads somewhere else; a saved `cat *` never covers
      // the whole span, so a later `cd` elsewhere still asks.
      expect(asserted).toStrictEqual([
        {
          action: "Bash",
          resources: ["cat id_rsa", "cd keys && cat id_rsa"],
          save: ["cat *"],
          metadata: { command: "cd keys && cat id_rsa" },
          sessionID,
        },
      ])
    }),
  )

  it.live("runs spans in a shell the scanner can read, not the configured one", () =>
    Effect.gen(function* () {
      const probe = yield* install("Status: !`git status`")
      yield* probe.execute("")
      expect(spawned.map((spawn) => spawn.command)).toEqual(["sh"])
    }),
  )

  // A span starts like the shell tool does: the settings' `env` is over the process environment, and a name taken out
  // of the settings stops applying to the next span.
  it.live("starts a span with the settings' env, managed last, and without a name the settings dropped", () =>
    Effect.gen(function* () {
      const document = (env: Record<string, string>, scope: Document["scope"]) =>
        new Document({ type: "document", scope, info: decode({ commands: { probe: { template: "!`env`" } }, env }) })
      yield* (yield* installEntries([
        document({ ZZ_SNIPPET_A: "user", ZZ_SNIPPET_B: "user" }, "user"),
        document({ ZZ_SNIPPET_B: "managed" }, "managed"),
      ])).execute("")
      yield* (yield* installEntries([document({ ZZ_SNIPPET_A: "user" }, "user")])).execute("")

      expect(spawnedEnv).toEqual([{ ZZ_SNIPPET_A: "user", ZZ_SNIPPET_B: "managed" }, { ZZ_SNIPPET_A: "user" }])
    }),
  )

  it.live("fails the command, without a prompt, when a span's process cannot run", () =>
    Effect.gen(function* () {
      failing.add("git status")
      const probe = yield* install("Status: !`git status`")
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error).toBeInstanceOf(Command.ExecutionError)
      expect(error.message).toBe(
        'Shell interpolation failed for "git status": Command failed: sh -c git status: spawn failed',
      )
      expect(probe.prompts).toEqual([])
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
      expect(error.message).toBe('Shell interpolation failed for "rm -rf build": Permission denied: Bash')
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

  // The wrapper's arguments tell whether the span may reach the network: bubblewrap gets --unshare-net only without it.
  const offline = (args: readonly string[]) => args.includes("--unshare-net") || args.some((arg) => arg.includes("(deny network*)"))
  const networkCases = [
    ["domain lists", { denied_domains: ["x.example"] }, true],
    ["an allow list, even an empty one", { allowed_domains: [] }, true],
    ["allow_managed_domains_only", { allow_managed_domains_only: true }, true],
    ["no domain settings at all (control)", undefined, false],
    ["an empty deny list alone (control)", { denied_domains: [] }, false],
  ] as const
  for (const [name, network, forced] of networkCases)
    it.live(`runs a span with the network ${forced ? "off" : "on"} under ${name}`, () =>
      withSandboxTool(
        tool,
        Effect.gen(function* () {
          const policy = yield* ManagedPolicy.Service
          yield* policy.set("file", { statements: [], restrictions: network ? { network } : {} })
          const probe = yield* install("Status: !`git status`", { sandbox: { enabled: true, network: true } })
          yield* probe.execute("")
          expect(spawned).toHaveLength(1)
          expect(offline(spawned[0].args)).toBe(forced)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const policy = yield* ManagedPolicy.Service
              yield* policy.set("file", { statements: [] })
            }),
          ),
        ),
      ),
    )

  it.live("leaves a span that asked for no network offline whatever the domain settings", () =>
    withSandboxTool(
      tool,
      Effect.gen(function* () {
        const probe = yield* install("Status: !`git status`", { sandbox: { enabled: true, network: false } })
        yield* probe.execute("")
        expect(offline(spawned[0].args)).toBe(true)
      }),
    ),
  )

  it.live("fails closed instead of running a span unsandboxed on WSL1", () =>
    Effect.gen(function* () {
      const previous = { ...ShellSandbox.host }
      Object.assign(ShellSandbox.host, { platform: "linux", release: "4.4.0-19041-Microsoft", env: {} })
      yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(ShellSandbox.host, previous)))
      const probe = yield* install("Status: !`git status`", { sandbox: { enabled: true } })
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error.message).toContain("WSL1")
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }).pipe(Effect.scoped),
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

// A folder that is not trusted may define commands, but nothing it defines may start a process. Config stamps the
// entries of such a folder, and these tests use the stamps it would put on them.
describe("command template shell spans from a folder that is not trusted", () => {
  // What the refusal says. It names the folder to trust when the entry knows where it came from.
  const refusal =
    'The "probe" command runs shell commands, and the folder it comes from is not trusted. Trust the folder, then run it again.'
  const refusalFor = (folder: string) =>
    `The "probe" command runs shell commands, and the folder it comes from (${folder}) is not trusted. Trust the folder, then run it again.`

  // A directory that holds the command `probe` as a Markdown file, as `.orbit/commands/probe.md` would, and the folder
  // around it, which is the one whose trust decides it.
  const directory = (template: string, trusted: boolean) =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const orbit = path.join(tmp.path, ".orbit")
      yield* Effect.promise(() => Bun.write(path.join(orbit, "commands", "probe.md"), template))
      const entry = new Directory({ type: "directory", path: AbsolutePath.make(orbit), scope: "project" })
      return {
        folder: tmp.path,
        entry: trusted ? entry : ConfigTrust.stamp(entry, { roots: [tmp.path], directory: orbit }),
      }
    })

  // A document of orbit.json, which defines the commands `probe` and `other` inline. It comes from no file unless it
  // is given one.
  const document = (templates: Record<string, string>, trusted: boolean, file?: string) => {
    const commands = Object.fromEntries(Object.entries(templates).map(([name, template]) => [name, { template }]))
    const entry = new Document({
      type: "document",
      scope: "project",
      ...(file === undefined ? {} : { path: AbsolutePath.make(file) }),
      info: decode({ commands }),
    })
    return trusted ? entry : ConfigTrust.stamp(entry, { roots: [process.cwd()], directory: process.cwd() })
  }

  // Nothing was scanned, asked about or started, and no prompt was submitted.
  const refused = (entries: Entry[], message: string, text = "") =>
    Effect.gen(function* () {
      const probe = yield* installEntries(entries)
      const error = yield* probe.execute(text).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Command.ExecutionError)
      expect(error.message).toBe(message)
      expect(asserted).toEqual([])
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    })

  for (const template of [
    "Status: !`git status`",
    "Review $ARGUMENTS\n\nBranch: !`git branch --show-current`",
    "!`one` and !`two`",
  ]) {
    it.live(`refuses ${JSON.stringify(template)} from a document, before it asks or starts anything`, () =>
      refused([document({ probe: template }, false)], refusal, "src"),
    )

    it.live(`refuses ${JSON.stringify(template)} from a directory, before it asks or starts anything`, () =>
      Effect.gen(function* () {
        const found = yield* directory(template, false)
        yield* refused([found.entry], refusalFor(found.folder), "src")
      }),
    )
  }

  // Trust is decided for the folder that holds the config, and that can be a folder above the project, so the refusal
  // has to say which one.
  it.live("names the folder around the config file that defines the command", () =>
    Effect.gen(function* () {
      const folder = (yield* tmpdirScoped()).path
      for (const file of [path.join(folder, "orbit.json"), path.join(folder, ".orbit", "orbit.json")]) {
        yield* refused([document({ probe: "Status: !`git status`" }, false, file)], refusalFor(folder))
      }
    }),
  )

  it.live("runs the same span once its folder is trusted", () =>
    Effect.gen(function* () {
      for (const entry of [
        document({ probe: "Status: !`git status`" }, true),
        (yield* directory("Status: !`git status`", true)).entry,
      ]) {
        spawned.length = 0
        asserted.length = 0
        const probe = yield* installEntries([entry])
        yield* probe.execute("")
        expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git status"])
        expect(asserted.map((input) => input.resources)).toEqual([["git status"]])
        expect(probe.prompts).toEqual(["Status: <git status>"])
      }
    }),
  )

  it.live("still runs a template that holds no span, whatever its folder", () =>
    Effect.gen(function* () {
      const templates = ["Explain $ARGUMENTS.", "Say `hello` and !not-a-span for $1"]
      const directories = yield* Effect.forEach(templates, (template) => directory(template, false))
      for (const entry of [
        ...templates.map((template) => document({ probe: template }, false)),
        ...directories.map((found) => found.entry),
      ]) {
        const probe = yield* installEntries([entry])
        // Argument text that looks like a span is only text, in an untrusted folder as in any other.
        yield* probe.execute("!`touch pwned`")
        expect(probe.prompts.at(-1)).toContain("!`touch pwned`")
      }
      expect(asserted).toEqual([])
      expect(spawned).toEqual([])
    }),
  )

  it.live("decides for each entry, so a command from a trusted folder still runs its span", () =>
    Effect.gen(function* () {
      const probe = yield* installEntries([
        document({ other: "Status: !`git status`" }, true),
        document({ probe: "Log: !`git log`" }, false),
      ])
      yield* probe.execute("", "other")
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git status"])
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error.message).toBe(refusal)
      expect(spawned.map((spawn) => spawn.args.at(-1))).toEqual(["git status"])
      expect(probe.prompts).toEqual(["Status: <git status>"])
    }),
  )
})

describe("command template shell spans with the permission service", () => {
  real.live("asks once per uncovered span, in template order, and runs only after the last answer", () =>
    Effect.gen(function* () {
      const session = yield* createSession([{ action: "Bash", resource: "git status", effect: "allow" }])
      const permission = yield* Permission.Service
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`\nLog: !`git log -n 3`\nDiff: !`git diff`", {}, session.id)
      const running = yield* probe.execute("").pipe(Effect.forkScoped)

      const first = yield* Queue.take(asked)
      expect(first).toMatchObject({
        action: "Bash",
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

  real.live("fails the command with the user's feedback when a span is rejected with a message", () =>
    Effect.gen(function* () {
      const session = yield* createSession([])
      const permission = yield* Permission.Service
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`", {}, session.id)
      const running = yield* probe.execute("").pipe(Effect.flip, Effect.forkScoped)

      const request = yield* Queue.take(asked)
      expect(request.metadata).toEqual({ command: "git status" })
      yield* permission.reply({ requestID: request.id, reply: "reject", message: "Read the log instead" })
      const error = yield* Fiber.join(running)
      expect(error).toBeInstanceOf(Command.ExecutionError)
      expect(error.message).toBe('Shell interpolation failed for "git status": Read the log instead')
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )

  real.live("fails the command on a deny rule before any approved span runs", () =>
    Effect.gen(function* () {
      const session = yield* createSession([
        { action: "Bash", resource: "git *", effect: "allow" },
        { action: "Bash", resource: "rm *", effect: "deny" },
      ])
      const asked = yield* requests
      const probe = yield* install("Status: !`git status`\nClean: !`rm -rf build`", {}, session.id)
      const error = yield* probe.execute("").pipe(Effect.flip)
      expect(error.message).toBe('Shell interpolation failed for "rm -rf build": Permission denied: Bash')
      expect(yield* Queue.size(asked)).toBe(0)
      expect(spawned).toEqual([])
      expect(probe.prompts).toEqual([])
    }),
  )
})

// The built-in Plan agent asks before every shell command, so a template with a span prompts with no configuration.
describe("command template shell spans through Session.command", () => {
  routed.live("fails with a typed error when the user rejects a span, and runs and submits nothing", () =>
    Effect.gen(function* () {
      const session = yield* planSession("Status: !`echo declined`")
      const sessions = yield* Session.Service
      const asked = yield* requests
      const running = yield* sessions
        .command({ sessionID: session.id, command: "probe", text: "" })
        .pipe(Effect.flip, Effect.forkScoped)

      const request = yield* Queue.take(asked)
      expect(request).toMatchObject({ action: "Bash", resources: ["echo declined"], sessionID: session.id })
      yield* answer(session, request, "reject")
      const error = yield* Fiber.join(running)
      expect(error).toBeInstanceOf(Command.ExecutionError)
      expect(error.message).toBe("Shell interpolation was declined")
      expect(spawned.filter((spawn) => spawn.args.at(-1) === "echo declined")).toEqual([])
      expect(yield* submitted(session)).toEqual([])
    }),
  )

  // The same path with an approval, so the empty inbox above means the command stopped rather than went unobserved.
  routed.live("runs the span and submits the prompt once the user approves it", () =>
    Effect.gen(function* () {
      const session = yield* planSession("Status: !`echo approved`")
      const sessions = yield* Session.Service
      const asked = yield* requests
      const running = yield* sessions
        .command({ sessionID: session.id, command: "probe", text: "" })
        .pipe(Effect.forkScoped)

      yield* answer(session, yield* Queue.take(asked), "once")
      yield* Fiber.join(running)
      expect(spawned.filter((spawn) => spawn.args.at(-1) === "echo approved")).toHaveLength(1)
      expect(yield* submitted(session)).toEqual(["Status: <echo approved>"])
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

// A project whose one command is `probe`, and a session on the Plan agent.
function planSession(template: string) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify({ commands: { probe: { template } } })),
    )
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
      title: "Plan session",
      agent: Agent.ID.make("plan"),
    })
  })
}

// Permission requests live in the session's location, so the reply goes through that location's services.
function answer(session: Session.Info, request: Permission.Request, reply: Permission.Reply) {
  return Effect.gen(function* () {
    const instances = yield* Instance.Service
    yield* Permission.Service.use((permission) => permission.reply({ requestID: request.id, reply })).pipe(
      instances.provide(session),
    )
  })
}

// Nothing delivers inbox items here, so the user prompts waiting in it are exactly what the command submitted.
function submitted(session: Session.Info) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    return (yield* sessions.inbox(session.id)).flatMap((item) => (item.type === "user" ? [item.payload.text] : []))
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
  return installEntries(
    [new Document({ type: "document", info: decode({ commands: { probe: { template } }, ...settings }) })],
    session,
  )
}

// The command plugin over the given config entries, which may define `probe` in a document or in a directory.
function installEntries(entries: Entry[], session: Session.ID = sessionID) {
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
    ).pipe(Effect.provide(Config.testLayer(entries)))
    return {
      prompts,
      execute: (text: string, name = "probe") =>
        command.execute({ name, invocation: { sessionID: session, prompt: { text }, delivery: "queue" } }),
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
