export * as OutputStylePlugin from "./output-style.js"

import { define } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect } from "effect"
import path from "path"
import { Config } from "../config.js"
import { ConfigMarkdown } from "../config/markdown.js"
import type { PluginInternal } from "./internal.js"

/**
 * Output styles change how the agent talks, not what it can do. The `output_style` config names a built-in style or a
 * Markdown file in an `output-styles` directory of any Orbit config directory or, while compatibility is enabled, of
 * another agent product's root; the file's body is appended to the system prompt. Frontmatter
 * `keep-coding-instructions: false` also drops the coding sections of Orbit's default prompt, for styles meant for
 * work other than writing code.
 */

interface Style {
  readonly name: string
  readonly body: string
  readonly keepCodingInstructions: boolean
}

const BUILT_IN: Record<string, Style> = {
  explanatory: {
    name: "Explanatory",
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

// Sections of the default prompt about writing code, dropped for styles that replace coding work.
const CODING_SECTIONS = ["Doing tasks", "Code style", "Verification"]

export const Plugin = define({
  id: "orbit.prompt.output-style",
  effect: Effect.fn("OutputStylePlugin")(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service

    const load = Effect.fn("OutputStylePlugin.load")(function* (name: string) {
      const builtIn = BUILT_IN[name.toLowerCase()]
      if (builtIn) return builtIn
      const entries = yield* config.entries()
      const roots = (yield* Config.compatOf(config)).roots.filter((root) => root.kind === "vendor")
      // Highest-priority config directories first, then the compatibility roots.
      const directories = [
        ...entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : [])).toReversed(),
        ...roots.map((root) => root.path),
      ]
      for (const directory of directories) {
        const content = yield* fs.readFileStringSafe(path.join(directory, "output-styles", `${name}.md`))
        if (content === undefined) continue
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        return {
          name: typeof markdown.data.name === "string" ? markdown.data.name : name,
          body: markdown.content.trim(),
          keepCodingInstructions: markdown.data["keep-coding-instructions"] !== false,
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
        const base = style.keepCodingInstructions ? system.text : withoutSections(system.text, CODING_SECTIONS)
        event.system[0] = { ...system, text: `${base}\n\n# Output style: ${style.name}\n${style.body}` }
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("context", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

/** Removes top-level `# Heading` sections by name, up to the next top-level heading. */
export function withoutSections(text: string, names: readonly string[]) {
  return text
    .split(/(?=^# )/m)
    .filter((section) => !names.some((name) => section.startsWith(`# ${name}\n`)))
    .join("")
    .trimEnd()
}
