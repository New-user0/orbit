import type { PermissionView } from "@orbit/schema/permission-view"
import { body } from "@orbit/flow/plain"
import type { FileChange } from "../protocol.js"

// What the approval card says, from the request's own values alone: the places, folder, pattern, method, URL, arguments
// and files its view carries. The calling tool's input never reaches the card. Pure, so the webview and its tests share it.

export interface Card {
  readonly title: string
  /** One line per value the card shows beside its title. */
  readonly lines: ReadonlyArray<string>
}

export function approvalCard(item: {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly view: PermissionView.View
  readonly files: ReadonlyArray<FileChange>
}): Card {
  const card = build(item)
  // Every string here can come from a model or a file (a command, an MCP argument), so control characters, including the
  // ones that reorder text, are written out before the card is drawn (class 9).
  return { title: body(card.title), lines: card.lines.map(body) }
}

function build(item: {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly view: PermissionView.View
  readonly files: ReadonlyArray<FileChange>
}): Card {
  const view = item.view
  const verb = verbOf(item.action)
  if (item.files.length > 0)
    return {
      title: `${verb} ${item.files.map((file) => basename(file.place ?? file.file)).join(", ")}`,
      lines: [...new Set([...view.places, ...item.files.flatMap((file) => [file.from, file.place ?? file.file])])]
        .filter((place): place is string => place !== undefined)
        .map((place) => `Path: ${place}`),
    }
  if (view.url !== undefined)
    return {
      title: `${verb} ${view.method && view.method !== "GET" ? `${view.method} ` : ""}${view.url}`,
      lines: [...(view.method ? [`Method: ${view.method}`] : []), `URL: ${view.url}`],
    }
  // The request's resources are what the rule matches: the command of a shell approval, the pattern of a search.
  const resources = item.resources.filter((resource) => resource !== "*")
  const lines = [
    ...resources.filter((resource) => resource !== view.pattern && !view.places.includes(resource)).map((resource) => `Resource: ${resource}`),
    ...view.places.map((place) => `Path: ${place}`),
    ...(view.pattern === undefined ? [] : [`Pattern: ${view.pattern}`]),
    ...(view.folder === undefined ? [] : [`Folder: ${view.folder}`]),
    ...(view.arguments === undefined ? [] : [`Arguments: ${view.arguments}`]),
  ]
  const target = view.places[0] ?? view.pattern ?? (resources.length > 0 ? resources.join(", ") : "")
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
