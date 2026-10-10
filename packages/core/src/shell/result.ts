export * as ShellResult from "./result.js"

import type { Shell } from "@orbit/schema/shell"
import { Duration } from "effect"
import { ShellStall } from "./stall.js"

export type Result = {
  info: Shell.Info
  capture: { output: string; truncated: boolean } | undefined
}

type Output = { output: string; truncated: boolean; exit?: number; signal?: string; timeout?: boolean }

const missing = "Shell command output is no longer available."
export const unavailable: Shell.Output = {
  output: missing,
  cursor: Buffer.byteLength(missing),
  size: Buffer.byteLength(missing),
  truncated: false,
}

export function output(result: Result): Output {
  return {
    output: result.capture?.output ?? unavailable.output,
    truncated: result.capture?.truncated ?? false,
    ...(result.info.exit !== undefined ? { exit: result.info.exit } : {}),
    ...(result.info.signal !== undefined ? { signal: result.info.signal } : {}),
    ...(result.info.status === "timeout" ? { timeout: true } : {}),
  }
}

export function notice(output: Pick<Output, "exit" | "signal" | "timeout">) {
  if (output.timeout) return "Timed out before completion"
  if (output.signal !== undefined) return `Killed by ${output.signal}`
  if (output.exit !== undefined && output.exit !== 0) return `Exited with code ${output.exit}`
}

/** Why a foreground command that was still running came back as a background one. Holds only a number. */
export function deadlineNotice(budget: number) {
  return `The command was still running after ${budget} ms, so it keeps running in the background instead of being stopped. Use TaskStop with this shell ID to stop it.`
}

/** The text of a notice that a background command seems to wait for an answer. Holds the output tail and the shell ID. */
export function stallNotice(input: { shellID: string; tail: string }) {
  return [
    `The command has printed nothing new for ${Duration.toSeconds(ShellStall.QUIET)} seconds and its last line looks like a question. Commands run with no input, so it cannot be answered.`,
    `The output ends with:\n${input.tail}`,
    `It is probably blocked on that prompt. Stop it with TaskStop and shell ID ${input.shellID}, then run it again with the answer supplied in the command (for example piped in) or with its non-interactive option.`,
  ].join("\n\n")
}

export function metadata(output: Output) {
  return {
    truncated: output.truncated,
    ...(output.exit !== undefined ? { exit: output.exit } : {}),
    ...(output.signal !== undefined ? { signal: output.signal } : {}),
    ...(output.timeout !== undefined ? { timeout: output.timeout } : {}),
  }
}

export function notification(input: {
  shellID: string
  jobID?: string
  command: string
  state: "completed" | "cancelled" | "error" | "waiting"
  text: string
  output?: Output
}) {
  return {
    text: `<shell id="${input.jobID ?? input.shellID}" state="${input.state}" command="${input.command}">\n${input.text}\n</shell>`,
    metadata: {
      source: "shell",
      shellID: input.shellID,
      ...(input.jobID !== undefined ? { jobID: input.jobID } : {}),
      state: input.state,
      ...(input.output ? metadata(input.output) : {}),
    },
  }
}

export function userNotification(result: Result) {
  const captured = output(result)
  const status =
    result.info.status === "killed"
      ? "Cancelled"
      : captured.exit === 0
        ? undefined
        : (notice(captured) ?? "Exited with code unknown")
  const message = notification({
    shellID: result.info.id,
    command: result.info.command,
    state: result.info.status === "killed" ? "cancelled" : "completed",
    text: [captured.output, status].filter((item) => item !== undefined && item !== "").join("\n\n"),
    output: captured,
  })
  return { ...message, text: `The following shell command was executed by the user:\n${message.text}` }
}
