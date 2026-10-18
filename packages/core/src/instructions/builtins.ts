export * as InstructionBuiltIns from "./builtins.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import os from "os"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { ReminderText } from "../session/reminder-text.js"
import { ShellSelect } from "../shell/select.js"
import { Instructions } from "./index.js"

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
  /** The person's own preferences. Only the main thread of a session carries them, so the caller decides whether to include the list. */
  readonly preferences: () => Effect.Effect<Instructions.List>
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
          `  Main checkout (off limits): ${input.worktree}. This directory is a linked git worktree, so STAY IN IT: NEVER cd out to the main checkout.`,
        ]),
    `  Workspace root folder: ${input.root}`,
    `  Is directory a git repo: ${input.git ? "yes" : "no"}`,
    `  Platform: ${platform === input.platform ? platform : `${platform} (${input.platform})`}`,
    windows && POSIX_SHELLS.has(input.shell)
      ? `  Shell: ${input.shell} (Windows host, but its syntax is Unix: forward slashes in paths, and /dev/null is the null device, not NUL)`
      : `  Shell: ${input.shell}`,
    // On Windows `os.type()` says only `Windows_NT`, and on Linux `os.version()` is the kernel's build banner.
    `  OS version: ${windows ? input.os.version || input.os.type : input.os.type} ${input.os.release}`,
    "</env>",
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const shells = yield* ShellSelect.Service
    const config = yield* Config.Service
    return Service.of({
      preferences: () =>
        Effect.succeed(
          Instructions.combine([
            Instructions.make({
              key: Instructions.Key.make("core/language"),
              codec: Schema.toCodecJson(Schema.String),
              // A value from a file is one line of text: a line break in it must not start a new section.
              read: config.entries().pipe(
                Effect.map((entries) => ReminderText.oneLine(Config.latest(entries, "language") ?? "")),
                Effect.map((value) => (value === "" ? Instructions.removed : value)),
              ),
              render: {
                initial: (language) =>
                  `Preferred reply language: ${language}. Write your replies to the person, including explanations and comments addressed to them, in that language. Code, commands, file paths and technical terms keep their original form.`,
                changed: (_previous, language) =>
                  `The person's preferred reply language is now ${language}. From here on, write replies to the person in it; the same exceptions for code and technical terms apply.`,
                removed: () =>
                  "The person no longer has a preferred reply language. Reply in the language their messages are written in.",
              },
            }),
          ]),
        ),
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
                initial: (block) =>
                  ["Facts about the machine and folder this session runs in:", block].join("\n"),
                changed: (_previous, block) => ["Those machine and folder facts have changed. They now read:", block].join("\n"),
              },
            }),
          ]),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, Location.node, ShellSelect.node] })
