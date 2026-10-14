export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { InvalidError } from "../v1/config/error.js"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
  /**
   * Set for the config of a folder that is not trusted: the folders its references may reach. Nothing is read from the
   * environment, and a file is read only when it is inside one of them, so the folder cannot pull a secret, or a file
   * from another machine, into a value that is sent on to a model provider. A reference that is not expanded stays in
   * the text as it was written.
   */
  within?: readonly string[]
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const text = input.within
    ? input.text
    : input.text.replace(
        /\{env:([^}]+)\}/g,
        (_, varName: string) => (input.env?.[varName] ?? process.env[varName]) || "",
      )
  if (!text.includes("{file:")) return text
  return yield* substituteFiles(input, text)
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configSource = input.type === "path" ? input.path : input.source
  const sourceDir = input.type === "path" ? path.dirname(input.path) : input.dir
  // Real paths on both sides, so that a folder reached through a link is still inside the folders it was checked against.
  const configDir = input.within ? (yield* LinkShare.resolve(fs, sourceDir)) ?? sourceDir : sourceDir
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    if (input.within && !(yield* reachable(fs, input.within, filePath, resolvedPath))) {
      out += token
      cursor = index + token.length
      continue
    }
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((error) => {
        if (input.missing === "empty") return Effect.succeed("")

        const message = `bad file reference: "${token}"`
        return Effect.fail(
          new InvalidError(
            {
              path: configSource,
              message:
                error._tag === "PlatformError" && error.reason._tag === "NotFound"
                  ? `${message} ${resolvedPath} does not exist`
                  : message,
            },
            { cause: error },
          ),
        )
      }),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})

/**
 * Whether a reference may be read for a folder that is not trusted. A reference that names a network share, as
 * `{file://host/share/name}` does on Windows, is refused before anything touches the disk, and so is a path outside
 * the folders. A file that is inside them but only through a link to somewhere else is refused once the link is followed.
 */
const reachable = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  within: readonly string[],
  reference: string,
  file: string,
) {
  if (/^[\\/]{2}/.test(reference)) return false
  const inside = (candidate: string) => within.some((folder) => FSUtil.contains(folder, candidate))
  if (!inside(file) || (yield* LinkShare.blocked(fs, file))) return false
  return inside(yield* fs.resolve(file))
})
