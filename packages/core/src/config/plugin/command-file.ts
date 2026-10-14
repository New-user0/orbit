export * as CommandFile from "./command-file.js"

import { ConfigCommand } from "@orbit/schema/config/command"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect, Option, Schema } from "effect"
import path from "path"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigMarkdown } from "../markdown.js"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

/**
 * The commands that the Markdown files under `{command,commands}` in a config directory define, in path order. A file
 * that cannot be read, or whose front matter is not a command, defines none, and neither does one that `supplies` says
 * may not be read, which is asked before the file is. This is read for the commands plugin and for what trust holds
 * back, so both see the same commands. Keep it in sync with `sourceDirectories` in that plugin.
 */
export function load(
  fs: FSUtil.Interface,
  directory: string,
  supplies: (file: string) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  return Effect.gen(function* () {
    const found = yield* LinkShare.scan(fs, directory, ["{command,commands}/**/*.md"])
    const files = yield* Effect.filter(found.toSorted(), supplies)
    return yield* Effect.forEach(files, (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}
