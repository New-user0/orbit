export * as ServerManaged from "./managed"

import { ConfigEnv } from "@orbit/core/config/env"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { McpRestriction } from "@orbit/core/mcp/restriction"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { PluginRestriction } from "@orbit/plugin/restriction"
import type { Mcp } from "@orbit/schema/mcp"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect } from "effect"

export type Snapshot = ManagedSettings.Snapshot

/**
 * Reads the managed settings in a folder without starting a server, for the frontend commands that report on them
 * (`orb doctor`) and may not import Core themselves.
 */
export const read = (directory: string) => ManagedSettings.read(directory).pipe(Effect.provide(FSUtil.layer))

/**
 * Puts the managed `env` into this process's own environment, once at boot. Every later child of a CLI-launched server
 * and the model client's proxy and CA set-up then see it, and a managed file edit applies after a restart. A name the
 * files decode to is never the reserved lookup variable, and `ProgramLookup.install()` runs again after it regardless.
 */
export const applyEnvironment = (directory: string | undefined) =>
  ManagedSettings.bootEnvironment(directory).pipe(
    Effect.provide(LayerNode.compile(FSUtil.node)),
    Effect.map((env) => {
      ConfigEnv.applyTo(process.env, env)
    }),
  )

/**
 * The refusal an `orb mcp add` gets from the organization's MCP lists, or undefined when the server may be added. It
 * asks the same predicate `Mcp.add` uses: when managed settings run only the servers they define it refuses every server,
 * before the lists, and otherwise a server refused here is one that reconcile would drop.
 */
export const mcpRefusal = (directory: string, name: string, server: Mcp.ServerConfig) =>
  read(directory).pipe(
    Effect.map((snapshot) => {
      const checked = McpRestriction.admit(snapshot.restrictions.mcp, name, server)
      if (checked.allowed) return undefined
      if (checked.reason === "managed_only")
        return `MCP server "${name}" was not added: ${snapshot.restrictions.organization === undefined ? "managed settings allow" : `${snapshot.restrictions.organization}'s managed settings allow`} only the MCP servers they define`
      return checked.reason === "denied"
        ? `MCP server "${name}" is blocked by managed settings`
        : `MCP server "${name}" is not on the allow list in managed settings`
    }),
  )

/** The refusal an `orb plugin add` gets from the organization's plugin lists, checked before any download. */
export const pluginRefusal = (directory: string, spec: string) =>
  Effect.gen(function* () {
    const snapshot = yield* read(directory)
    const identity = yield* Effect.promise(() => PluginRestriction.identify(spec))
    const checked = PluginRestriction.check(snapshot.restrictions.plugins ?? {}, identity)
    if (checked.allowed) return undefined
    return checked.reason === "blocked"
      ? `Plugin "${spec}" is blocked by managed settings`
      : `Plugin "${spec}" is not on the allow list in managed settings`
  })

/**
 * What a shell command would meet if the sandbox were on, asked of the runner's own launch so `orb doctor` and the
 * runner cannot disagree about the platform or about which program is found. Starts nothing.
 */
export const sandboxProbe = () =>
  ShellSandbox.launch({ settings: { enabled: true }, shell: "sh", args: [], cwd: process.cwd(), writable: [] })
