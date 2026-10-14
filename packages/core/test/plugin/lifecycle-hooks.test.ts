import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { CompatNames } from "@orbit/compat/names"
import { Document, Event, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { AbsolutePath } from "@orbit/core/schema"
import { ShellSelect } from "@orbit/core/shell/select"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { SessionMessage } from "@orbit/schema/session-message"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, Exit, Fiber, Layer, Logger, Schema, Stream } from "effect"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { grantWithRecords } from "../fixture/grant"
import { location, tempLocationLayer } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { ProjectTrust } from "@orbit/core/project-trust"

// The shared plugin fixture has no shell selection; hooks need it to pick the shell their commands run in.
const it = testEffect(
  Layer.mergeAll(
    PluginTestLayer,
    Config.testLayer(),
    AppNodeBuilder.build(ShellSelect.node, [Location.node.replace(tempLocationLayer)]),
  ),
)
const decode = Schema.decodeUnknownSync(Info)
const hooks = (value: unknown) => new Document({ type: "document", info: decode({ hooks: value }) })
const command = (text: string) => ({ hooks: [{ type: "command", command: text }] })

/** A logger layer that collects the details of every warning logged with `message`. */
const collectWarnings = (message: string, details: unknown[]) =>
  Logger.layer([
    Logger.map(Logger.formatStructured, (entry) => {
      if (Array.isArray(entry.message) && entry.message[0] === message) details.push(entry.message[1])
    }),
  ])

const base = {
  sessionID: Session.ID.make("ses_hooks_test"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_hooks_test"),
  id: Tool.CallID.make("call_hooks_test"),
}

describe("LifecycleHooksPlugin", () => {
  if (process.platform === "win32") return
  it.live("blocks tool calls, adds tool feedback and prompt context, and passes the event on stdin", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      const directory = (yield* tmpdirScoped()).path
      const payload = path.join(directory, "payload.json")
      yield* config.setEntries([
        hooks({
          PreToolUse: [
            { matcher: "shell", ...command("echo 'no shell today' >&2; exit 2") },
            { matcher: "write|edit", ...command(`echo '{"decision":"block","reason":"read-only checkout"}'`) },
          ],
          PostToolUse: [{ matcher: "read", ...command(`cat > '${payload}'; echo 'lint: clean'`) }],
          UserPromptSubmit: [command("echo 'Current branch: main'")],
        }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))

      const shell = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Bash", input: { command: "ls" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(shell) ? String(shell.cause) : "").toContain("Blocked by a PreToolUse hook: no shell today")
      const write = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Write", input: {} })
        .pipe(Effect.exit)
      expect(Exit.isFailure(write) ? String(write.cause) : "").toContain("read-only checkout")
      const read = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Read", input: {} })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(read)).toBe(true)

      const after = {
        ...base,
        tool: "Read",
        input: { path: "a.ts" },
        status: "completed" as const,
        result: { output: "1: x", content: "Read file a.ts" } as Tool.Result,
      }
      yield* registry.trigger("tool", "execute.after", after)
      expect(after.result.content).toEqual([
        { type: "text", text: "Read file a.ts" },
        { type: "text", text: "PostToolUse hook:\nlint: clean" },
      ])
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(payload, "utf8")))).toMatchObject({
        hook_event_name: "PostToolUse",
        session_id: "ses_hooks_test",
        tool_name: "read",
        tool_input: { path: "a.ts" },
        tool_response: "1: x",
      })

      const prompt = {
        sessionID: base.sessionID,
        messageID: base.messageID,
        prompt: { text: "Fix the build" },
        delivery: "steer" as const,
      }
      yield* registry.trigger("session", "prompt", prompt)
      expect(prompt.prompt.text).toBe("Fix the build\n\nCurrent branch: main")
    }),
  )

  it.live("starts a hook with the settings' env under Orbit's own variables, and a removed name stops applying", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      const settings = (env: Record<string, string>) =>
        new Document({
          type: "document",
          info: decode({
            env,
            hooks: { UserPromptSubmit: [command(`echo "$ZZ_ENV_A|$ORBIT_PROJECT_DIR"`)] },
          }),
        })
      yield* config.setEntries([settings({ ZZ_ENV_A: "from-settings", ORBIT_PROJECT_DIR: "/evil" })])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const prompt = () => ({
        sessionID: base.sessionID,
        messageID: base.messageID,
        prompt: { text: "go" },
        delivery: "steer" as const,
      })

      const first = prompt()
      yield* registry.trigger("session", "prompt", first)
      expect(first.prompt.text).toStartWith("go\n\nfrom-settings|")
      expect(first.prompt.text).not.toContain("/evil")

      yield* config.setEntries([settings({})])
      const second = prompt()
      yield* registry.trigger("session", "prompt", second)
      expect(second.prompt.text).toStartWith("go\n\n|")
    }),
  )

  for (const item of [
    { name: "nothing set", restrictions: {}, ran: ["user", "managed"] },
    { name: "managed_hooks_only", restrictions: { managed_hooks_only: true }, ran: ["managed"] },
    { name: "disable_hooks", restrictions: { disable_hooks: true }, ran: [] },
    { name: "both set", restrictions: { disable_hooks: true, managed_hooks_only: true }, ran: [] },
    {
      name: "hooks.managed_only in the managed file",
      restrictions: {},
      managedHooks: { managed_only: true },
      ran: ["managed"],
    },
    { name: "hooks.disabled in the managed file", restrictions: {}, managedHooks: { disabled: true }, ran: [] },
  ] as { name: string; restrictions: object; managedHooks?: object; ran: string[] }[]) {
    it.live(`runs ${item.ran.length === 0 ? "no" : item.ran.join(" and ")} hooks with ${item.name}`, () =>
      Effect.gen(function* () {
        const registry = yield* PluginHooks.Service
        const config = yield* Config.Test
        const policy = yield* ManagedPolicy.Service
        yield* policy.set("file", { statements: [], restrictions: item.restrictions })
        const entry = (scope: "user" | "managed") =>
          new Document({
            type: "document",
            scope,
            info: decode({
              hooks: {
                UserPromptSubmit: [command(`echo ${scope}-hook`)],
                ...(scope === "managed" ? item.managedHooks : {}),
              },
            }),
          })
        yield* config.setEntries([entry("user"), entry("managed")])
        yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))

        const prompt = {
          sessionID: base.sessionID,
          messageID: base.messageID,
          prompt: { text: "go" },
          delivery: "steer" as const,
        }
        yield* registry.trigger("session", "prompt", prompt)
        const context = item.ran.map((scope) => `${scope}-hook`).join("\n")
        expect(prompt.prompt.text).toBe(context === "" ? "go" : `go\n\n${context}`)
      }),
    )
  }

  it.live("gives the reason of the highest-ranked document that blocks, and of the first of its hooks", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      const blockedBy = (tool: string) =>
        registry.trigger("tool", "execute.before", { ...base, tool, input: {} }).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : "")),
        )
      const block = (reason: string) => ({ type: "command", command: `echo '${reason}' >&2; exit 2` })
      // Documents come lowest priority first, so a later one outranks an earlier one.
      yield* config.setEntries([
        hooks({ PreToolUse: [{ matcher: "shell|read", hooks: [block("from the user")] }] }),
        hooks({
          PreToolUse: [{ matcher: "shell", hooks: [block("first of the project"), block("second of the project")] }],
        }),
        hooks({ PreToolUse: [{ matcher: "shell|read", hooks: [{ type: "command", command: "echo 'checked'" }] }] }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))

      // Every blocking hook runs, but only one reason reaches the model.
      expect(yield* blockedBy("shell")).toContain("Blocked by a PreToolUse hook: first of the project")
      expect(yield* blockedBy("shell")).not.toContain("second of the project")
      // A document that does not block cannot outrank one that does.
      expect(yield* blockedBy("read")).toContain("Blocked by a PreToolUse hook: from the user")
      expect(yield* blockedBy("grep")).toBe("")
    }),
  )
})

describe("LifecycleHooksPlugin with settings it does not honor yet", () => {
  const unenforced = "hook policy is not enforced yet and is ignored"

  it.live("warns once for each policy that is set and would change what runs", () => {
    const output: unknown[] = []
    return Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([
        hooks({ disabled: true, managed_only: false, http: { allowed_urls: [] } }),
        hooks({ disabled: true, managed_only: true }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const fire = registry.trigger("tool", "execute.before", { ...base, tool: "Read", input: {} })
      yield* fire
      yield* fire
      expect(output).toEqual([
        { setting: "hooks.disabled" },
        { setting: "hooks.http" },
        { setting: "hooks.managed_only" },
      ])
    }).pipe(Effect.provide(collectWarnings(unenforced, output)))
  })

  it.live("stays quiet about policies that are off", () => {
    const output: unknown[] = []
    return Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([hooks({ disabled: false, managed_only: false })])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      yield* registry.trigger("tool", "execute.before", { ...base, tool: "Read", input: {} })
      expect(output).toEqual([])
    }).pipe(Effect.provide(collectWarnings(unenforced, output)))
  })

  if (process.platform === "win32") return
  it.live("warns once for each command setting it ignores, and still runs the command", () => {
    const output: unknown[] = []
    return Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([
        hooks({
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo 'no shell today' >&2; exit 2",
                  shell: "bash",
                  async: true,
                  async_rewake: true,
                  once: true,
                  if: "shell(git *)",
                  status_message: "Checking",
                },
                // Settings that are off ask for nothing, so they are not reported.
                { type: "command", command: "true", async: false, async_rewake: false, once: false },
                // timeout is honored.
                { type: "command", command: "true", timeout: 5 },
              ],
            },
          ],
        }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const fire = registry
        .trigger("tool", "execute.before", { ...base, tool: "Bash", input: { command: "ls" } })
        .pipe(Effect.exit)
      const exit = yield* fire
      yield* fire
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("Blocked by a PreToolUse hook: no shell today")
      expect(output).toEqual([
        { event: "PreToolUse", field: "shell" },
        { event: "PreToolUse", field: "async" },
        { event: "PreToolUse", field: "async_rewake" },
        { event: "PreToolUse", field: "once" },
        { event: "PreToolUse", field: "if" },
        { event: "PreToolUse", field: "status_message" },
      ])
    }).pipe(Effect.provide(collectWarnings("hook field is not supported yet and is ignored", output)))
  })
})

describe("LifecycleHooksPlugin with hooks of other types", () => {
  const unsupported = "hook type is not supported yet and is skipped"

  it.live("skips prompt, agent and http hooks and logs each type once", () => {
    const output: unknown[] = []
    return Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([
        hooks({
          PreToolUse: [
            {
              hooks: [
                { type: "prompt", prompt: "Is this safe?" },
                { type: "agent", prompt: "Verify the change" },
                { type: "http", url: "https://hooks.example.com/event" },
                { type: "prompt", prompt: "Is it still safe?" },
              ],
            },
          ],
          PostToolUse: [{ hooks: [{ type: "agent", prompt: "Verify the result" }] }],
        }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))

      const after = {
        ...base,
        tool: "Read",
        input: {},
        status: "completed" as const,
        result: { output: "x" } as Tool.Result,
      }
      const fire = Effect.gen(function* () {
        const before = yield* registry
          .trigger("tool", "execute.before", { ...base, tool: "Read", input: {} })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(before)).toBe(true)
        yield* registry.trigger("tool", "execute.after", after)
      })
      yield* fire
      yield* fire

      expect(output).toEqual([
        { event: "PreToolUse", type: "prompt" },
        { event: "PreToolUse", type: "agent" },
        { event: "PreToolUse", type: "http" },
      ])
      expect(after.result).toEqual({ output: "x" })
    }).pipe(Effect.provide(collectWarnings(unsupported, output)))
  })

  if (process.platform === "win32") return
  it.live("still runs the command hooks that sit next to them", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHooks.Service
      const config = yield* Config.Test
      yield* config.setEntries([
        hooks({
          PreToolUse: [
            {
              hooks: [
                { type: "prompt", prompt: "Is this safe?" },
                { type: "command", command: "echo 'no shell today' >&2; exit 2" },
              ],
            },
          ],
        }),
      ])
      yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const exit = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "Bash", input: { command: "ls" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("Blocked by a PreToolUse hook: no shell today")
    }),
  )
})

describe("LifecycleHooksPlugin under workspace trust", () => {
  // The real configuration loader for a project in a home of its own, in a folder that nothing trusts on its own.
  const projectConfig = (home: string, project: string) => {
    const place = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(project) })),
    )
    return Layer.mergeAll(
      AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
        Config.node.replace(Config.configured()),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
        Location.node.replace(place),
        Global.node.replace(Global.layerWith({ config: path.join(home, ".config", "orbit"), home })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(emptyWellknownNode),
        Watcher.node.replace(Watcher.testLayer),
      ]),
      place,
    )
  }

  // Exit code 2 blocks the call it reaches, in bash and in PowerShell alike.
  const block = (matcher: string) => ({ PreToolUse: [{ matcher, hooks: [{ type: "command", command: "exit 2" }] }] })

  // The next config.updated, so that a change is waited for rather than polled for.
  const nextUpdate = Bus.Service.use((bus) =>
    bus
      .subscribe(Event.Updated)
      .pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("10 seconds"),
        Effect.forkScoped({ startImmediately: true }),
      ),
  )

  it.live("runs no hook until the folder is trusted: not the user's, the project's nor another product's", () =>
    Effect.gen(function* () {
      const home = (yield* tmpdirScoped()).path
      const project = path.join(home, "work", "repo")
      const write = (file: string, contents: unknown) =>
        fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(contents)))
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(home, ".config", "orbit", "orbit.json"), { hooks: block("read") }),
          write(path.join(project, "orbit.json"), { hooks: block("shell") }),
          // The other product's name for the grep tool, so this one only ever runs through the compatibility reader.
          write(path.join(project, CompatNames.vendor.directory, "settings.json"), { hooks: block("Grep") }),
        ]),
      )

      yield* Effect.gen(function* () {
        const registry = yield* PluginHooks.Service
        const trust = yield* WorkspaceTrust.Service
        yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
        const blocked = (tool: string) =>
          registry
            .trigger("tool", "execute.before", { ...base, tool, input: {} })
            .pipe(Effect.exit, Effect.map(Exit.isFailure))
        const everything = Effect.all({ read: blocked("read"), shell: blocked("shell"), grep: blocked("grep") })

        // Untrusted, nothing runs: a hook starts in the project's folder, whoever wrote it.
        // The user's guard on `read` is not read as "no guard", so the call it applies to is refused. The project's and
        // the other product's documents are withheld from an untrusted folder, so nothing applies to the others.
        expect(yield* everything).toEqual({ read: true, shell: false, grep: false })

        const granted = yield* nextUpdate
        yield* grantWithRecords(project, { persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect(yield* everything).toEqual({ read: true, shell: true, grep: true })

        const revoked = yield* nextUpdate
        yield* trust.revoke(project)
        yield* Fiber.join(revoked)
        expect(yield* everything).toEqual({ read: true, shell: false, grep: false })
      }).pipe(Effect.provide(projectConfig(home, project)))
    }),
  )

  // The attack as a marker file: the person's own hook runs a program in the clone's folder, and the clone's file is
  // what the program would read first. Here the hook only writes a file into its working folder, which is where a bunfig
  // preload, a local .bin or a repository config would be picked up. The control is the same hook once trusted.
  it.live("starts no hook of the user's in an untrusted folder, and starts it once granted", () =>
    Effect.gen(function* () {
      const home = (yield* tmpdirScoped()).path
      const project = path.join(home, "work", "repo")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(home, ".config", "orbit"), { recursive: true })
        await fs.mkdir(project, { recursive: true })
        await fs.writeFile(
          path.join(home, ".config", "orbit", "orbit.json"),
          JSON.stringify({
            hooks: {
              PreToolUse: [{ matcher: "read", hooks: [{ type: "command", command: "bun -e \"require('fs').writeFileSync('marker.txt','ran')\"" }] }],
              UserPromptSubmit: [{ hooks: [{ type: "command", command: "bun -e \"require('fs').writeFileSync('prompt-marker.txt','ran')\"" }] }],
            },
          }),
        )
      })
      const ran = (file: string) => Effect.promise(() => Bun.file(path.join(project, file)).exists())
      yield* Effect.gen(function* () {
        const registry = yield* PluginHooks.Service
        yield* LifecycleHooksPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
        const fire = Effect.gen(function* () {
          yield* registry.trigger("tool", "execute.before", { ...base, tool: "read", input: {} }).pipe(Effect.ignore)
          yield* registry
            .trigger("session", "prompt", { sessionID: base.sessionID, messageID: base.messageID, prompt: { text: "go" }, delivery: "steer" as const })
            .pipe(Effect.ignore)
        })
        yield* fire
        expect([yield* ran("marker.txt"), yield* ran("prompt-marker.txt")]).toEqual([false, false])

        // Nothing in the folder is held back, so the grant moves no config: the gate reads the trust when a hook fires.
        yield* grantWithRecords(project, { persist: false, via: "test" })
        yield* fire
        expect([yield* ran("marker.txt"), yield* ran("prompt-marker.txt")]).toEqual([true, true])
      }).pipe(Effect.provide(projectConfig(home, project)))
    }),
  )
})
