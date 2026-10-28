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
      title: `Context is ${percentage}% full`,
      detail: info.auto
        ? "Automatic compaction will summarize the conversation soon; run /compact now to choose when."
        : "Automatic compaction is off, so run /compact before the window fills, or turn it back on.",
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
      title: `${name} calls and results take ${Locale.number(tokens)} tokens (${share(tokens)}%)`,
      detail: advice?.detail ?? `Ask for narrower ${name} calls, or for less of what each one returns.`,
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
      title: `Read results take ${Locale.number(read.results)} tokens (${share(read.results)}%)`,
      detail: "Read the part of a file you need, with an offset and a limit, instead of the whole file.",
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
      title: `Instruction files take ${Locale.number(files)} tokens (${share(files)}%)`,
      detail: `The largest are ${largest.join(", ")}. Trim them with /memory.`,
      savings: Math.floor(files * SAVINGS.files),
    })
  }

  if (!info.auto && percentage >= AUTO_OFF_FROM && percentage < NEAR_CAPACITY)
    found.push({
      severity: "info",
      title: "Automatic compaction is off",
      detail: "Nothing will summarize the conversation when the window fills; run /compact before then.",
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
      detail: "Filter long command output, with head, tail or grep, before it reaches the conversation.",
    }
  if (name === "Read")
    return {
      severity: "info" as const,
      savings: SAVINGS.read,
      detail: "Read the part of a file you need, with an offset and a limit, instead of the whole file.",
    }
  if (name === "Grep")
    return {
      severity: "info" as const,
      savings: SAVINGS.grep,
      detail: "Narrow the pattern, or limit the search to a folder or a file type.",
    }
  if (name === "WebFetch")
    return {
      severity: "info" as const,
      savings: SAVINGS.fetch,
      detail: "Web pages are large; ask for the part of a page you need.",
    }
  return undefined
}
