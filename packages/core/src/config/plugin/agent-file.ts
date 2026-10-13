export * as AgentFile from "./agent-file.js"

import { Document, Info } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { FSUtil } from "@orbit/util/fs-util"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AbsolutePath } from "../../schema.js"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigMarkdown } from "../markdown.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Info)
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])

/**
 * The agents that the Markdown files under `{agent,agents,mode,modes}` in a config directory define, as one document
 * each, in path order within each pattern. A file that cannot be read or decoded defines none, and neither does one that
 * `supplies` says may not be read, which is asked before the file is. This is read for the agents plugin and for what
 * trust holds back, so both see the same agents. Keep it in sync with `sourceDirectories` in that plugin.
 */
export const load = Effect.fn("AgentFile.load")(function* (
  fs: FSUtil.Interface,
  directory: string,
  supplies: (file: string) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  const files = yield* Effect.filter(yield* discover(fs, directory), (file) => supplies(file.filepath))
  const documents = yield* Effect.forEach(files, (file) =>
    fs.readFileStringSafe(file.filepath).pipe(
      Effect.map((content) => (content ? decode(file, content) : undefined)),
      Effect.orElseSucceed(() => undefined),
    ),
  )
  return documents.filter((document): document is Document => document !== undefined)
})

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    LinkShare.scan(fs, directory, [source.pattern]).pipe(
      Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
    ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof markdown.data.model === "string" &&
    !markdown.data.model.includes("#") &&
    typeof markdown.data.variant === "string" &&
    /^[^#]+$/.test(markdown.data.variant)
      ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` }
      : markdown.data
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        ),
      )
    : Option.getOrUndefined(decodeAgent({ ...data, system: body }, { errors: "all", propertyOrder: "original" }))
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
}
