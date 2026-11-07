export * as SkillInstructions from "./instructions.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "../permission.js"
import { Skill } from "../skill.js"
import { Instructions } from "../instructions/index.js"
import { ReminderText } from "../session/reminder-text.js"

/** The longest description a listing entry shows, in characters. */
export const DESCRIPTION_CAP = 250
/** Below this description width the listing gives names only. */
const MIN_DESCRIPTION_WIDTH = 20
/** Characters of the listing per token of the context window, and the share of the window the listing may take. */
const CHARACTERS_PER_TOKEN = 4
const WINDOW_SHARE = 0.01

// An absent description means the listing shows the name alone.
const Summary = Schema.Struct({
  id: Skill.ID,
  description: Schema.optionalKey(Schema.String),
})
type Summary = typeof Summary.Type

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cuts `text` to at most `width` display columns on a grapheme boundary, ending in an ellipsis inside that width. */
const shorten = (text: string, width: number) => {
  if (Bun.stringWidth(text) <= width) return text
  let kept = ""
  for (const { segment } of segmenter.segment(text)) {
    if (Bun.stringWidth(kept + segment + "…") > width) break
    kept += segment
  }
  return kept + "…"
}

/** Caps a description at `DESCRIPTION_CAP` characters: the first 249 plus one ellipsis, never splitting a grapheme. */
const cap = (text: string) => {
  if (text.length <= DESCRIPTION_CAP) return text
  let kept = ""
  for (const { segment } of segmenter.segment(text)) {
    if (kept.length + segment.length > DESCRIPTION_CAP - 1) break
    kept += segment
  }
  return kept + "…"
}

export const line = (skill: { readonly id: string; readonly description?: string }) =>
  skill.description === undefined ? `- ${skill.id}` : `- ${skill.id}: ${skill.description}`

/**
 * Fits the listing to `budget` display columns, newlines included: every line in full when they fit, else one
 * maximum description width for all of them, else names only. The names-only form is never cut, so no skill is dropped.
 */
export function budgeted(
  skills: ReadonlyArray<{ readonly id: Skill.ID; readonly description: string }>,
  budget: number,
): ReadonlyArray<Summary> {
  // Ids and descriptions can come from a project's files: each entry stays one line and cannot pose as an envelope.
  const full = skills.map((skill) => ({
    id: Skill.ID.make(ReminderText.oneLine(skill.id)),
    description: cap(ReminderText.oneLine(skill.description)),
  }))
  const fits =
    full.reduce((sum, skill) => sum + Bun.stringWidth(line(skill)), 0) + Math.max(0, full.length - 1) <= budget
  if (fits) return full
  const overhead = full.reduce((sum, skill) => sum + Bun.stringWidth(skill.id) + 4, 0) + full.length - 1
  const max = Math.floor((budget - overhead) / full.length)
  if (max < MIN_DESCRIPTION_WIDTH) return full.map((skill) => ({ id: skill.id }))
  return full.map((skill) => ({ id: skill.id, description: shorten(skill.description, max) }))
}

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the Skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the Skill tool returns. A skill that is already present this way does not need to be invoked again.",
    "",
    "Available skills:",
    ...skills.map(line),
  ].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (skill) => skill.id,
    (before, after) => before.description !== after.description,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return [
      "The available skills have changed. This list supersedes the previous available skills list.",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New skills are available in addition to those previously listed:", ...diff.added.map(line)]),
    ...(diff.removed.length === 0
      ? []
      : [
          `The following skill IDs are no longer available and must not be used: ${diff.removed.map((skill) => skill.id).join(", ")}.`,
        ]),
  ].join("\n")
}

export interface Interface {
  /**
   * Lists skills the given ruleset does not deny, fitted to a share of `contextWindow` tokens; callers pass the
   * merged agent and Session permissions, and `enabled` when the request offers the Skill tool.
   */
  readonly load: (
    permissions: Permission.Ruleset,
    options: { readonly contextWindow: number; readonly enabled: boolean },
  ) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SkillInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* Skill.Service

    return Service.of({
      load: Effect.fn("SkillInstructions.load")(function* (permissions, options) {
        const available = !options.enabled
          ? []
          : Skill.available(yield* skills.list(), permissions)
              .flatMap((skill) =>
                skill.description === undefined || skill.autoinvoke === false
                  ? []
                  : [{ id: skill.id, description: skill.description }],
              )
              .toSorted((a, b) => a.id.localeCompare(b.id))
        const listed = budgeted(available, Math.floor(options.contextWindow * CHARACTERS_PER_TOKEN * WINDOW_SHARE))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(listed.length === 0 ? Instructions.removed : listed),
          render: {
            initial: render,
            changed: update,
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Skill.node] })
