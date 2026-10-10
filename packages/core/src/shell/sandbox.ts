export * as ShellSandbox from "./sandbox.js"

import type { ConfigSandbox } from "@orbit/schema/config/sandbox"
import { SandboxPlatform } from "@orbit/util/sandbox-platform"
import { release } from "node:os"
import { which } from "../util/which.js"

/**
 * Wraps a shell command in the operating system's sandbox so it can read the whole filesystem but write only where it
 * should, and reach the network only when allowed. Linux uses bubblewrap; macOS uses sandbox-exec with a generated
 * profile. Windows has no equivalent, so its commands run unwrapped.
 */

export interface Input {
  readonly platform: NodeJS.Platform
  /** `os.release()`; tells WSL1 and WSL2 apart on Linux. */
  readonly release?: string
  readonly env?: Readonly<Record<string, string | undefined>>
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
  | { readonly type: "unsupported"; readonly reason: string }

export const TOOL: Partial<Record<NodeJS.Platform, string>> = { linux: "bwrap", darwin: "sandbox-exec" }

export function wrap(input: Input): Result {
  if (!input.settings.enabled) return { type: "unwrapped" }
  // WSL1 has no namespaces, so bubblewrap cannot work there; WSL2 is a real Linux kernel and takes the Linux path.
  if (SandboxPlatform.platform({ platform: input.platform, release: input.release ?? "", env: input.env ?? {} }) === "wsl1")
    return {
      type: "unsupported",
      reason: "Shell sandboxing is enabled but WSL1 cannot sandbox commands. Upgrade the distribution to WSL2 (wsl --set-version) or turn the sandbox off",
    }
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

/** The machine commands run on. Mutable only so a test can stand in for another platform, as it does for `TOOL`. */
export const host: { platform: NodeJS.Platform; release: string; env: Readonly<Record<string, string | undefined>> } = {
  platform: process.platform,
  release: release(),
  env: process.env,
}

/**
 * The one sandbox launch both shell entry points (the shell tool and command interpolation spans) go through, so a
 * platform rule such as the WSL1 refusal cannot be added to one and missed in the other.
 */
export function launch(input: Pick<Input, "settings" | "shell" | "args" | "cwd" | "writable">): Result {
  const tool = TOOL[host.platform]
  return wrap({
    ...input,
    platform: host.platform,
    release: host.release,
    env: host.env,
    tool: input.settings.enabled && tool ? (which(tool) ?? undefined) : undefined,
  })
}
