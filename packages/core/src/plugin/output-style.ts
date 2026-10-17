export * as OutputStylePlugin from "./output-style.js"

import { define } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { Directory } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect } from "effect"
import path from "path"
import { Config } from "../config.js"
import { ConfigMarkdown } from "../config/markdown.js"
import { ProjectTrust } from "../project-trust.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import type { PluginInternal } from "./internal.js"

/**
 * Output styles change how the agent talks, not what it can do. The `output_style` config names a built-in style or a
 * Markdown file in an `output-styles` directory of any Orbit config directory or, while compatibility is enabled, of
 * another agent product's root; the file's body is appended to the system prompt. A style drops the coding sections of
 * Orbit's default prompt (`SessionSystemPrompt.CODING_SECTIONS`) unless its frontmatter sets
 * `keep-coding-instructions` to `true` (a boolean or the string `"true"`); a missing key, `false` and any other value
 * drop them. The built-in styles keep them. While a style applies, the prompt's opening line (`SessionSystemPrompt.INTRO`)
 * is replaced by one that points at the style; a prompt that does not begin with that line keeps its own.
 *
 * The name is one file name, so a repository's config cannot make it climb out of the directory, and a file in a
 * directory whose folder is not trusted is read only when its real path is inside that folder (`ProjectTrust.supplies`).
 * Reading it is all that gate allows: a style from a folder that is not trusted still goes last in the prompt under its
 * own heading, but it does not replace the opening line, because that line says what the agent is for and would pass the
 * clone's text off as Orbit's. The folder is asked at each request (`ProjectTrust.trustedSource`), so a grant or a revoke
 * takes effect at once. Every kind of style leaves the sections that govern approvals as they are.
 */

interface Style {
  readonly name: string
  readonly body: string
  readonly keepCodingInstructions: boolean
  /** Whether the folder that holds the style is trusted. A built-in style is Orbit's own. */
  readonly trusted: boolean
}

const BUILT_IN: Record<string, Style> = {
  explanatory: {
    name: "Explanatory",
    trusted: true,
    keepCodingInstructions: true,
    body: [
      "While you work, help the user understand the codebase and your choices.",
      "- Before or after a meaningful change, add a short insight: why this approach fits this codebase, what pattern it follows, or what trade-off it makes. Mark each one with a line that reads `Insight:`.",
      "- Prefer insights specific to this project over general programming advice.",
      "- Keep insights to two or three sentences, and do not let them crowd out the work itself.",
    ].join("\n"),
  },
  learning: {
    name: "Learning",
    trusted: true,
    keepCodingInstructions: true,
    body: [
      "The user wants to learn by doing, so share the work with them.",
      "- For small, self-contained pieces that teach something (a function body, a condition, a test case), stop and ask the user to write them. Leave a clearly marked `TODO(human)` in the code, explain what it needs to do and why it matters, and wait for them.",
      "- Do the surrounding work yourself so the user's part stays focused.",
      "- After the user contributes, review it kindly and explain anything worth knowing.",
      "- Add short `Insight:` notes about the codebase and your choices, as in the explanatory style.",
    ].join("\n"),
  },
}

/** Takes the place of `SessionSystemPrompt.INTRO` while a style applies. */
export const STYLED_INTRO =
  "You are Orbit. You help the user in the way the output style at the end of this prompt describes, using the tools you are given."

export const Plugin = define({
  id: "orbit.prompt.output-style",
  effect: Effect.fn("OutputStylePlugin")(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const trust = yield* ProjectTrust.Service

    const load = Effect.fn("OutputStylePlugin.load")(function* (name: string) {
      const builtIn = BUILT_IN[name.toLowerCase()]
      if (builtIn) return builtIn
      // A style is a file in an output-styles directory, so its name is one file name. The setting comes from any config,
      // a repository's included, and must not name a file outside the directory it is looked up in.
      if (/[/\\]/.test(name) || name.includes("..")) {
        yield* Effect.logWarning("output style not found", { name, reason: "the name is not one file name" })
        return
      }
      const entries = yield* config.entries()
      const roots = (yield* config.compat()).roots.filter((root) => root.kind === "vendor")
      // Highest-priority config directories first, then the compatibility roots.
      const sources = [
        ...entries.filter((entry): entry is Directory => entry.type === "directory").toReversed(),
        ...roots,
      ]
      for (const source of sources) {
        const file = path.join(source.path, "output-styles", `${name}.md`)
        if (!(yield* trust.supplies(source, file))) continue
        const content = yield* fs.readFileStringSafe(file)
        if (content === undefined) continue
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        const keep = markdown.data["keep-coding-instructions"]
        return {
          name: typeof markdown.data.name === "string" ? markdown.data.name : name,
          body: markdown.content.trim(),
          keepCodingInstructions: keep === true || keep === "true",
          trusted: yield* trust.trustedSource(source),
        } satisfies Style
      }
      yield* Effect.logWarning("output style not found", { name })
    })

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const name = Config.latest(yield* config.entries(), "output_style")
        if (!name || name === "default") return
        const system = event.system[0]
        if (!system) return
        const style = yield* load(name)
        if (!style) return
        const sections = style.keepCodingInstructions
          ? system.text
          : withoutSections(system.text, SessionSystemPrompt.CODING_SECTIONS)
        const base =
          style.trusted && sections.startsWith(SessionSystemPrompt.INTRO)
            ? `${STYLED_INTRO}${sections.slice(SessionSystemPrompt.INTRO.length)}`
            : sections
        event.system[0] = { ...system, text: `${base}${STYLE_HEADING}${style.name}\n${style.body}` }
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("context", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

/** What introduces an output style's text in the system prompt; the text after it is the person's own. */
export const STYLE_HEADING = "\n\n# Output style: "

/** Removes top-level `# Heading` sections by name, up to the next top-level heading. */
export function withoutSections(text: string, names: readonly string[]) {
  return text
    .split(/(?=^# )/m)
    .filter((section) => !names.some((name) => section.startsWith(`# ${name}\n`)))
    .join("")
    .trimEnd()
}
