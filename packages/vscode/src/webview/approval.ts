import { PermissionView } from "@orbit/schema/permission-view"
import { body, plainPath } from "@orbit/flow/plain"
import type { FileChange } from "../protocol.js"
import { excerpt } from "./present.js"

// What the approval card says, from the request's own values alone: the places, folder, pattern, method, URL, arguments
// and files its view carries. The calling tool's input never reaches the card. Pure, so the webview and its tests share it.

export interface Card {
  readonly title: string
  /** Where the request's links lead: each on its own line, after their count when there are several. */
  readonly warnings: ReadonlyArray<string>
  /** One line per value the card shows beside its title. */
  readonly lines: ReadonlyArray<string>
  /** The first changed lines of every file's diff, written out like the rest of the card. */
  readonly changes: ReadonlyArray<{ readonly kind: "add" | "del"; readonly text: string }>
}

export function approvalCard(item: {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly view: PermissionView.View
  readonly files: ReadonlyArray<FileChange>
}): Card {
  const card = build(item)
  const links = item.view.links
  const warnings = links.map((link) => PermissionView.linkWarning(link, plainPath))
  // Every string here can come from a model or a file (a command, an MCP argument), so control characters, including the
  // ones that reorder text, are written out before the card is drawn (class 9).
  return {
    title: body(card.title),
    warnings: links.length > 1 ? [PermissionView.linkSummary(links)!, ...warnings] : warnings,
    lines: card.lines.map(body),
    changes: item.files.flatMap((file) => excerpt(file.patch, 6)).map((line) => ({ ...line, text: body(line.text) })),
  }
}

/**
 * What an answered card says. "With your changes" comes from the server's answer, which names the files only when it
 * approved the person's own version, and never from what the extension sent (class 8).
 */
export function answeredLabel(item: { readonly status: "pending" | "once" | "always" | "reject"; readonly revised?: boolean }) {
  if (item.status === "once" && item.revised) return "Allowed with your changes"
  return { pending: "Waiting", once: "Allowed", always: "Always allowed", reject: "Rejected" }[item.status]
}

function build(item: {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly view: PermissionView.View
  readonly files: ReadonlyArray<FileChange>
}): Omit<Card, "changes" | "warnings"> {
  const view = item.view
  const verb = verbOf(item.action)
  if (item.files.length > 0)
    return {
      // Each name is one line: a break in one starts no line that reads as a link warning (class 9).
      title: `${verb} ${item.files.map((file) => plainPath(basename(file.place ?? file.file))).join(", ")}`,
      lines: [...new Set([...view.places, ...item.files.flatMap((file) => [file.from, file.place ?? file.file])])]
        .filter((place): place is string => place !== undefined)
        .map((place) => `Path: ${plainPath(place)}`),
    }
  if (view.url !== undefined)
    return {
      title: `${verb} ${view.method && view.method !== "GET" ? `${view.method} ` : ""}${view.url}`,
      lines: [...(view.method ? [`Method: ${view.method}`] : []), `URL: ${view.url}`],
    }
  // The request's resources are what the rule matches: the command of a shell approval, the pattern of a search.
  const resources = item.resources.filter((resource) => resource !== "*")
  // Those of a question about files or folders are names and are each one line (class 9). A command keeps its lines.
  const named =
    PermissionView.action(item.action) === "external_directory" || view.places.length > 0
      ? plainPath
      : (value: string) => value
  const lines = [
    ...resources
      .filter((resource) => resource !== view.pattern && !view.places.includes(resource))
      .map((resource) => `Resource: ${named(resource)}`),
    ...view.places.map((place) => `Path: ${plainPath(place)}`),
    ...(view.pattern === undefined ? [] : [`Pattern: ${view.pattern}`]),
    ...(view.folder === undefined ? [] : [`Folder: ${plainPath(view.folder)}`]),
    ...(view.arguments === undefined ? [] : [`Arguments: ${view.arguments}`]),
  ]
  const target =
    (view.places[0] === undefined ? view.pattern : plainPath(view.places[0])) ?? resources.map(named).join(", ")
  return {
    title: `${verb} ${target}`.trim(),
    lines: lines.length > 0 ? lines : item.resources,
  }
}

function verbOf(action: string) {
  return (
    { edit: "Edit", write: "Write", shell: "Run", read: "Read", webfetch: "Fetch", grep: "Search", glob: "Search" }[
      action.toLowerCase()
    ] ?? action
  )
}

function basename(file: string) {
  return file.split(/[\\/]/).at(-1) ?? file
}
