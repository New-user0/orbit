import { describe, expect } from "bun:test"
import path from "path"
import { Tool } from "@orbit/schema/tool"
import { SessionMessage } from "@orbit/schema/session-message"
import { Agent } from "@orbit/core/agent"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { LspPlugin } from "@orbit/core/lsp/plugin"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const asked: string[][] = []
const lspLayer = Layer.mock(Lsp.Service, {
  diagnostics: (files) =>
    Effect.sync(() => {
      asked.push([...files])
      return Object.fromEntries(
        files.map((file) => [
          file,
          [
            {
              range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
              severity: 1,
              message: "Cannot find name 'foo'.",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              severity: 2,
              message: "unused",
            },
          ],
        ]),
      )
    }),
})
const it = testEffect(Layer.merge(PluginTestLayer, lspLayer))

describe("LspPlugin", () => {
  it.effect("adds language server errors for the files an edit changed", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const location = yield* Location.Service
      yield* LspPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const event = {
        sessionID: Session.ID.make("ses_lsp_plugin"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_lsp_plugin"),
        id: Tool.CallID.make("call_lsp_plugin"),
        tool: "edit",
        input: { path: "src/a.ts" },
        status: "completed" as const,
        result: {
          content: "Edited src/a.ts (1 replacement)",
          metadata: { files: [{ file: "src/a.ts", patch: "", additions: 1, deletions: 1 }] },
        } as Tool.Result,
      }
      yield* hooks.trigger("tool", "execute.after", event)
      const absolute = path.resolve(location.directory, "src/a.ts")
      expect(asked).toEqual([[absolute]])
      expect(event.result.content).toEqual([
        { type: "text", text: "Edited src/a.ts (1 replacement)" },
        {
          type: "text",
          text: `Language server errors after this change:\n${path.join("src", "a.ts")}:\n  5:3 Cannot find name 'foo'.`,
        },
      ])
      expect(Object.keys(event.result.metadata?.diagnostics as object)).toEqual([absolute, "src/a.ts"])

      const read = { ...event, tool: "read", result: { content: "x" } as Tool.Result }
      yield* hooks.trigger("tool", "execute.after", read)
      expect(read.result.content).toBe("x")
    }),
  )
})
