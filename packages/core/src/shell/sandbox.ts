export * as ShellSandbox from "./sandbox.js"

import type { ConfigSandbox } from "@orbit/schema/config/sandbox"

/**
 * Wraps a shell command in the operating system's sandbox so it can read the whole filesystem but write only where it
 * should, and reach the network only when allowed. Linux uses bubblewrap; macOS uses sandbox-exec with a generated
 * profile. Windows has no equivalent, so its commands run unwrapped.
 */

export interface Input {
  readonly platform: NodeJS.Platform
  readonly settings: ConfigSandbox.Info
  readonly shell: string
  readonly args: readonly string[]
  readonly cwd: string
  /** Directories the command may write to, in addition to the configured ones. */
  readonly writable: readonly string[]
  /** Resolved path of bwrap or sandbox-exec, when installed. */
  readonly tool?: string
}

export type Result =
  | { readonly type: "wrapped"; readonly command: string; readonly args: readonly string[] }
  | { readonly type: "unwrapped" }
  | { readonly type: "missing"; readonly tool: string }

export const TOOL: Partial<Record<NodeJS.Platform, string>> = { linux: "bwrap", darwin: "sandbox-exec" }

export function wrap(input: Input): Result {
  if (!input.settings.enabled) return { type: "unwrapped" }
  const tool = TOOL[input.platform]
  if (!tool) return { type: "unwrapped" }
  if (!input.tool) return { type: "missing", tool }
  const writable = [...new Set([...input.writable, ...(input.settings.write ?? [])])]
  if (input.platform === "darwin")
    return {
      type: "wrapped",
      command: input.tool,
      args: ["-p", profile(writable, input.settings.network === true), input.shell, ...input.args],
    }
  return {
    type: "wrapped",
    command: input.tool,
    args: [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      ...writable.flatMap((directory) => ["--bind", directory, directory]),
      ...(input.settings.network ? [] : ["--unshare-net"]),
      "--die-with-parent",
      "--chdir",
      input.cwd,
      "--",
      input.shell,
      ...input.args,
    ],
  }
}

function profile(writable: readonly string[], network: boolean) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${[...writable.map((directory) => `(subpath ${quote(directory)})`), '(literal "/dev/null")', '(regex #"^/dev/tty")'].join(" ")})`,
    ...(network ? [] : ["(deny network*)", "(allow network* (remote unix-socket))"]),
  ].join("\n")
}

const quote = (value: string) => JSON.stringify(value)
