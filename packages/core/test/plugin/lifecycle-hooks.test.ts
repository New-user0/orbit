import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Tool } from "@orbit/schema/tool"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { ShellSelect } from "@orbit/core/shell/select"
import { Config } from "@orbit/core/config"
import { LifecycleHooksPlugin } from "@orbit/core/config/plugin/lifecycle-hooks"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/schema/session-message"
import { Effect, Exit, Layer, Logger, Schema } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

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
        .trigger("tool", "execute.before", { ...base, tool: "shell", input: { command: "ls" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(shell) ? String(shell.cause) : "").toContain("Blocked by a PreToolUse hook: no shell today")
      const write = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "write", input: {} })
        .pipe(Effect.exit)
      expect(Exit.isFailure(write) ? String(write.cause) : "").toContain("read-only checkout")
      const read = yield* registry
        .trigger("tool", "execute.before", { ...base, tool: "read", input: {} })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(read)).toBe(true)

      const after = {
        ...base,
        tool: "read",
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
      const fire = registry.trigger("tool", "execute.before", { ...base, tool: "read", input: {} })
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
      yield* registry.trigger("tool", "execute.before", { ...base, tool: "read", input: {} })
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
        .trigger("tool", "execute.before", { ...base, tool: "shell", input: { command: "ls" } })
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
        tool: "read",
        input: {},
        status: "completed" as const,
        result: { output: "x" } as Tool.Result,
      }
      const fire = Effect.gen(function* () {
        const before = yield* registry
          .trigger("tool", "execute.before", { ...base, tool: "read", input: {} })
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
        .trigger("tool", "execute.before", { ...base, tool: "shell", input: { command: "ls" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("Blocked by a PreToolUse hook: no shell today")
    }),
  )
})
