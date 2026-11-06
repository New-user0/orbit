import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { plain } from "@orbit/util/plain"
import { Locale } from "./locale"

export type ContextSuggestion = {
  readonly severity: "warning" | "info"
  readonly title: string
  readonly detail: string
  /** About how many tokens following the suggestion would free. */
  readonly savings?: number
}

// The reference's thresholds: a share of the window in percent, and a floor in tokens.
const NEAR_CAPACITY = 80
const LARGE_TOOL = { share: 15, tokens: 10_000 }
const OTHER_TOOL_SHARE = 20
const READ_RESULTS = { share: 5, tokens: 10_000 }
const INSTRUCTION_FILES = { share: 5, tokens: 5_000 }
const AUTO_OFF_FROM = 50

// What following each piece of advice is likely to save, as a share of what it is about.
const SAVINGS = { shell: 0.5, read: 0.3, grep: 0.3, fetch: 0.4, other: 0.2, files: 0.3 }

/**
 * What a person could do about the context window, worked out from `/context`'s payload alone, as the reference does
 * under its own view: warnings first, then the largest saving first. Tool names and file paths come from the session's
 * history and the folder, so they are written through `plain` (class 9); `display` shortens a file's path for showing,
 * as the view's own list does. With no window there is nothing to be a share of, and so nothing to suggest. Savings round
 * down, as the reference's do.
 */
export function contextSuggestions(
  info: SessionContextUsage.Info,
  display: (path: string) => string = (path) => path,
): ContextSuggestion[] {
  const window = info.window
  if (window === undefined || window === 0) return []
  const percentage = info.percentage ?? 0
  // `tokens` is at least `share` percent of the window, compared in whole numbers.
  const reaches = (tokens: number, share: number) => tokens * 100 >= window * share
  const share = (tokens: number) => ((tokens / window) * 100).toFixed(0)
  const found: ContextSuggestion[] = []

  if (percentage >= NEAR_CAPACITY)
    found.push({
      severity: "warning",
      title: `${percentage}% of the window is in use`,
      detail: info.auto
        ? "/compact runs it at a moment you pick; left alone, Orbit compacts the conversation by itself shortly."
        : "Turning automatic compaction back on, or running /compact yourself, keeps the window from filling up, since with the setting off nothing summarizes the conversation for you.",
    })

  const large = new Set<string>()
  info.messages.tools.forEach((tool) => {
    const tokens = tool.calls + tool.results
    if (!reaches(tokens, LARGE_TOOL.share) || tokens < LARGE_TOOL.tokens) return
    const advice = toolAdvice(tool.name)
    if (advice === undefined && !reaches(tokens, OTHER_TOOL_SHARE)) return
    large.add(tool.name)
    const name = plain(tool.name)
    found.push({
      severity: advice?.severity ?? "info",
      title: `${name} uses ${Locale.number(tokens)} tokens across its calls and results (${share(tokens)}%)`,
      detail: advice?.detail ?? `Call ${name} with tighter inputs, or have each call return less.`,
      savings: Math.floor(tokens * (advice?.savings ?? SAVINGS.other)),
    })
  })

  const read = info.messages.tools.find((tool) => tool.name === "Read")
  if (
    read !== undefined &&
    !large.has("Read") &&
    reaches(read.results, READ_RESULTS.share) &&
    read.results >= READ_RESULTS.tokens
  )
    found.push({
      severity: "info",
      title: `What Read returned holds ${Locale.number(read.results)} tokens (${share(read.results)}%)`,
      detail: "Read a long file in pieces by giving an offset and a limit.",
      savings: Math.floor(read.results * SAVINGS.read),
    })

  const files = info.files.reduce((sum, file) => sum + file.tokens, 0)
  if (reaches(files, INSTRUCTION_FILES.share) && files >= INSTRUCTION_FILES.tokens) {
    const largest = info.files
      .toSorted((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((file) => `${plain(display(file.path))} (${Locale.number(file.tokens)})`)
    found.push({
      severity: "info",
      title: `Instructions hold ${Locale.number(files)} tokens (${share(files)}%)`,
      detail: `Most of it sits in ${largest.join(", ")}, which /memory opens for trimming.`,
      savings: Math.floor(files * SAVINGS.files),
    })
  }

  if (!info.auto && percentage >= AUTO_OFF_FROM && percentage < NEAR_CAPACITY)
    found.push({
      severity: "info",
      title: "Auto-compaction is switched off",
      detail: "A full window will not be summarized for you, so run /compact before it fills.",
    })

  return found.toSorted(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1) || (b.savings ?? 0) - (a.savings ?? 0),
  )
}

/** The reference's advice by tool; any other tool gets general advice, and only from a larger share. */
function toolAdvice(name: string) {
  if (name === "Bash")
    return {
      severity: "warning" as const,
      savings: SAVINGS.shell,
      detail: "Commands that print a lot fill the conversation. Cut their output down in the command itself, for example to the first or last lines or to the lines that match.",
    }
  if (name === "Read")
    return {
      severity: "info" as const,
      savings: SAVINGS.read,
      detail: "Read a long file in pieces by giving an offset and a limit.",
    }
  if (name === "Grep")
    return {
      severity: "info" as const,
      savings: SAVINGS.grep,
      detail: "Narrow what each search covers: a more exact pattern, a single folder or one file type.",
    }
  if (name === "WebFetch")
    return {
      severity: "info" as const,
      savings: SAVINGS.fetch,
      detail: "Whole web pages cost many tokens. Name the part of the page you are after in the request.",
    }
  return undefined
}
