import type { OrbitClient } from "@orbit/client/promise"
import { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { jsonLine, plain } from "@orbit/flow/plain"
import { Option, Schema } from "effect"
import { errorMessage } from "../util/error"

// `orb run "/context"` and `orb -p "/context"`: the server's estimate of what the session's next request carries, as the
// reference prints it in its print mode, a Markdown report. Every section is printed for everyone (the reference keeps
// some for its own staff). Every string in the payload is a file's, a config's or a tool server's, so each cell goes
// through `plain`, and a pipe is escaped so that it cannot add a column (classes 5 and 9).

const LABELS: Record<SessionContextUsage.CategoryKind, string> = {
  system: "System prompt",
  tools: "System tools",
  mcp: "MCP tools",
  "mcp-deferred": "MCP tools (deferred)",
  "tools-deferred": "System tools (deferred)",
  agents: "Custom agents",
  instructions: "Instruction files",
  skills: "Skills",
  messages: "Messages",
  "auto-buffer": "Autocompact buffer",
  "compact-buffer": "Compact buffer",
  free: "Free space",
}

const count = new Intl.NumberFormat("en-US")

/** The report, in the reference's section order. With no window, nothing is shown as a share of it. */
export function contextMarkdown(info: SessionContextUsage.Info) {
  const window = info.window === undefined || info.window === 0 ? undefined : info.window
  const tokens = (value: number) => count.format(value)
  const share = (value: number) => (window === undefined ? [] : [`${((value / window) * 100).toFixed(1)}%`])
  const categories = [
    ...info.categories.filter((item) => item.tokens > 0 && item.kind !== "free" && item.kind !== "auto-buffer"),
    ...(["free", "auto-buffer"] as const).flatMap((kind) =>
      info.categories.filter((item) => item.kind === kind && item.tokens > 0),
    ),
  ]
  const deferred = (value: number) => `${tokens(value)} (deferred)`
  return [
    "## Context usage",
    "",
    `**Model:** ${cell(`${info.model.providerID}/${info.model.id}`)}`,
    window === undefined
      ? `**Tokens:** ${tokens(info.total)}`
      : `**Tokens:** ${tokens(info.total)} / ${tokens(window)} (${info.percentage ?? 0}%)`,
    "",
    ...section(
      "Usage by category",
      window === undefined ? ["Category", "Tokens"] : ["Category", "Tokens", "Percentage"],
      categories.map((item) => [LABELS[item.kind], tokens(item.tokens), ...share(item.tokens)]),
    ),
    ...section(
      "MCP tools",
      ["Tool", "Server", "Tokens"],
      info.mcp.map((tool) => [cell(tool.name), cell(tool.server), tool.deferred ? deferred(tool.tokens) : tokens(tool.tokens)]),
    ),
    ...section("System tools", ["Tool", "Tokens"], [
      ...info.systemTools.map((tool) => [cell(tool.name), tokens(tool.tokens)]),
      ...info.deferredTools.map((tool) => [cell(tool.name), deferred(tool.tokens)]),
    ]),
    ...section(
      "System prompt sections",
      ["Section", "Tokens"],
      info.sections.map((item) => [cell(item.name), tokens(item.tokens)]),
    ),
    ...section(
      "Custom agents",
      ["Agent", "Scope", "Tokens"],
      info.agents.map((agent) => [cell(agent.id), cell(agent.scope), tokens(agent.tokens)]),
    ),
    ...section(
      "Instruction files",
      ["Type", "Path", "Tokens"],
      info.files.map((file) => [cell(file.type), cell(file.path), tokens(file.tokens)]),
    ),
    ...section("Skills", ["Skill", "Tokens"], info.skills.map((skill) => [cell(skill.id), tokens(skill.tokens)])),
    ...section("Message breakdown", ["Kind", "Tokens"], [
      ["Tool calls", tokens(info.messages.toolCalls)],
      ["Tool results", tokens(info.messages.toolResults)],
      ["Attachments", tokens(info.messages.attachments)],
      ["Assistant text", tokens(info.messages.assistant)],
      ["User text", tokens(info.messages.user)],
    ]),
    ...section(
      "Top tools",
      ["Tool", "Call tokens", "Result tokens"],
      info.messages.tools.map((tool) => [cell(tool.name), tokens(tool.calls), tokens(tool.results)]),
    ),
    ...section(
      "Top attachments",
      ["Attachment", "Tokens"],
      info.messages.attachmentKinds.map((item) => [cell(item.name), tokens(item.tokens)]),
    ),
  ].join("\n")
}

/** The line `--format json` prints: the payload as it came, with every string escaped as `jsonLine` does (class 9). */
export function contextUsageLine(sessionID: string, usage: SessionContextUsage.Info) {
  return jsonLine({ type: "context_usage", sessionID, usage })
}

/**
 * Asks the server for a session's context usage, and turns each way it can fail into one message: the server's own
 * refusal (an untrusted folder, a child session, a missing session or model), a server older than the route, an answer
 * that is not the payload, and no answer in time (classes 7 and 13).
 */
export async function readContextUsage(
  client: OrbitClient,
  sessionID: string,
  timeout: number,
): Promise<{ readonly info: SessionContextUsage.Info } | { readonly error: string }> {
  const signal = AbortSignal.timeout(timeout)
  const expired = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  )
  return Promise.race([client.session.contextUsage({ sessionID }, { signal }), expired]).then(
    (value) =>
      Option.match(Schema.decodeUnknownOption(SessionContextUsage.Info)(value), {
        onNone: () => ({ error: "The server's answer about context usage could not be read" }),
        onSome: (info) => ({ info }),
      }),
    (error: unknown) => ({ error: failure(error) }),
  )
}

function failure(error: unknown) {
  const named = (value: unknown, name: string) =>
    typeof value === "object" && value !== null && "name" in value && value.name === name
  if (named(error, "TimeoutError") || (error instanceof Error && named(error.cause, "TimeoutError")))
    return "The server did not answer in time"
  // A server from before the route answers 404 with no body. The route declares 404, so the client reads that body as
  // a typed error and finds no content type.
  if (error instanceof Error && error.name === "ClientError" && error.message === "UnsupportedContentType")
    return "The server is older than this client and does not report context usage"
  return errorMessage(error)
}

/** A table under a heading, or nothing when it has no rows. */
function section(title: string, header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) {
  if (rows.length === 0) return []
  return [
    `### ${title}`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ]
}

/**
 * A Markdown table cell: one line without control characters (`plain`), and a pipe that stays in its cell. A table row
 * is split at every pipe that no backslash escapes, so the backslashes right before a pipe are doubled before the pipe
 * gets its own.
 */
function cell(text: string) {
  return plain(text).replace(/(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`)
}
