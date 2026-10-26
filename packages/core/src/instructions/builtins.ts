export * as InstructionBuiltIns from "./builtins.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import os from "os"
import { NonNegativeInt } from "@orbit/schema/schema"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { SessionMicrocompaction } from "../session/microcompaction.js"
import { ReminderText } from "../session/reminder-text.js"
import { ShellSelect } from "../shell/select.js"
import { Instructions } from "./index.js"

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
  /** The person's own preferences. Only the main thread of a session carries them, so the caller decides whether to include the list. */
  readonly preferences: () => Effect.Effect<Instructions.List>
  /**
   * The note about tool output that the default prompt's main thread carries. `clearing` is the setting the runner clears
   * by, so the notice and the clearing read one value. The caller decides whether the default prompt applies.
   */
  readonly toolResults: (clearing: Effect.Effect<boolean>) => Instructions.List
}

export class Service extends Context.Service<Service, Interface>()("@orbit/InstructionBuiltIns") {}

export interface EnvironmentInput {
  readonly directory: string
  /** The project's folder, which is not always the working directory. */
  readonly root: string
  readonly git: boolean
  /** The main checkout, when `directory` is a linked git worktree of the project. */
  readonly worktree?: string
  readonly platform: NodeJS.Platform
  /** What `os.type()`, `os.release()` and `os.version()` say. Taken as input so each platform's text is testable anywhere. */
  readonly os: { readonly type: string; readonly release: string; readonly version: string }
  /** The shell the shell tool runs, by name (`ShellSelect.name`): that function cannot read a Windows path on Linux. */
  readonly shell: string
}

// Shells whose syntax is not Windows syntax. PowerShell and cmd belong to Windows and need no note.
const POSIX_SHELLS = new Set(["bash", "sh", "dash", "ksh", "zsh"])

/** The `<env>` block of the baseline. Every platform dependent value is an input, so the Windows text runs on Linux. */
export function environment(input: EnvironmentInput) {
  const windows = input.platform === "win32"
  const platform = ShellSelect.platformName(input.platform)
  return [
    "<env>",
    `  Working directory: ${input.directory}`,
    ...(input.worktree === undefined
      ? []
      : [
          `  Main checkout (off limits): ${input.worktree}. This directory is a linked git worktree; run commands and make edits here, not in the main checkout.`,
        ]),
    `  Workspace root folder: ${input.root}`,
    `  Git repository: ${input.git ? "yes" : "no"}`,
    `  Platform: ${platform === input.platform ? platform : `${platform} (${input.platform})`}`,
    windows && POSIX_SHELLS.has(input.shell)
      ? `  Shell: ${input.shell} (runs on Windows but takes POSIX syntax)`
      : `  Shell: ${input.shell}`,
    // On Windows `os.type()` says only `Windows_NT`, and on Linux `os.version()` is the kernel's build banner.
    `  OS version: ${windows ? input.os.version || input.os.type : input.os.type} ${input.os.release}`,
    "</env>",
  ].join("\n")
}

const ADVICE =
  "Tool output can be cleared later on, so when a result holds something you will need again, note it in your reply."

const clearedNote = (keep: number) =>
  `the output of older tool calls is replaced with a short note saying it was cleared, and the output of the ${keep} latest calls is never cleared`

/**
 * The tool-results section: a notice that older tool output is cleared while clearing is on, then the advice, which holds
 * either way. The stored value is the keep count (`null` when clearing is off), so a release that changes the count shows
 * as an update instead of rewriting a stored baseline.
 */
export const toolResultsSource = (clearing: Effect.Effect<boolean>) =>
  Instructions.make({
    key: Instructions.Key.make("core/tool-results"),
    codec: Schema.toCodecJson(Schema.NullOr(NonNegativeInt)),
    read: clearing.pipe(Effect.map((on) => (on ? SessionMicrocompaction.KEEP : null))),
    render: {
      initial: (keep) =>
        keep === null
          ? ADVICE
          : [
              "# Clearing of old tool output",
              `To keep the conversation within its context limit, ${clearedNote(keep)}.`,
              ADVICE,
            ].join("\n\n"),
      changed: (_previous, keep) =>
        keep === null
          ? "Clearing of old tool output is now off: tool output is no longer cleared automatically. Output that was cleared earlier stays cleared."
          : `Clearing of old tool output is now on: ${clearedNote(keep)}.`,
    },
  })

export interface Options {
  /** True on the minimal instances (`--bare`, vanilla): they carry neither the reply-language preference nor the tool-results section. */
  readonly minimal: boolean
}

const layerOf = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const shells = yield* ShellSelect.Service
      const config = yield* Config.Service
      return Service.of({
        preferences: () =>
          Effect.succeed(
            options.minimal
              ? Instructions.empty
              : Instructions.make({
                  key: Instructions.Key.make("core/language"),
                  codec: Schema.toCodecJson(Schema.String),
                  // A value from a file is one line of text: a line break in it must not start a new section.
                  read: config.entries().pipe(
                    Effect.map((entries) => ReminderText.oneLine(Config.latest(entries, "language") ?? "")),
                    Effect.map((value) => (value === "" ? Instructions.removed : value)),
                  ),
                  render: {
                    initial: (language) =>
                      `Preferred reply language: ${language}. Write prose for the person in that language; code, commands, paths, identifiers and technical terms stay as they are.`,
                    changed: (_previous, language) =>
                      `The person's preferred reply language is now ${language}. From here on, write replies to the person in it; the same exceptions for code and technical terms apply.`,
                    removed: () =>
                      "The person no longer has a preferred reply language. Reply in the language their messages are written in.",
                  },
                }),
          ),
        toolResults: (clearing) => (options.minimal ? Instructions.empty : toolResultsSource(clearing)),
        load: () =>
          Effect.succeed(
            Instructions.combine([
              Instructions.make({
                key: Instructions.Key.make("core/date"),
                codec: Schema.toCodecJson(Schema.String),
                read: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
                render: {
                  initial: (date) => `Today's date: ${date}`,
                  changed: (_previous, date) => `Today's date is now: ${date}`,
                },
              }),
              Instructions.make({
                key: Instructions.Key.make("core/environment"),
                codec: Schema.toCodecJson(Schema.String),
                // The shell the shell tool will run, which is not always the login shell: the tool skips shells it cannot drive.
                read: shells.resolve({ priority: "compat" }).pipe(
                  Effect.map((shell) =>
                    environment({
                      directory: location.directory,
                      root: location.project.directory,
                      git: location.vcs?.type === "git",
                      // A linked worktree is its own project directory, and the main checkout is the canonical one.
                      worktree:
                        location.project.directory === location.project.canonical
                          ? undefined
                          : location.project.canonical,
                      platform: process.platform,
                      os: { type: os.type(), release: os.release(), version: os.version() },
                      shell: ShellSelect.name(shell),
                    }),
                  ),
                ),
                render: {
                  initial: (block) => ["Facts about the machine and folder this session runs in:", block].join("\n"),
                  changed: (_previous, block) =>
                    ["Those machine and folder facts have changed. They now read:", block].join("\n"),
                },
              }),
            ]),
          ),
      })
    }),
  )

/** A node with explicit options; the minimal instances replace the default node with their own. */
export const configured = (options: Options) =>
  makeLocationNode({ service: Service, layer: layerOf(options), deps: [Config.node, Location.node, ShellSelect.node] })

/** `orb run --bare` switches instruction files off through this variable, and the reply language and the tool-results section go with them. */
export const node = configured({ minimal: process.env.ORBIT_DISABLE_INSTRUCTIONS === "1" })
