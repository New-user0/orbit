import { PermissionView } from "@orbit/schema/permission-view"
import { ToolNames } from "@orbit/schema/tool-names"
import { Locale } from "./locale"
import { bodyText } from "./renderer"
import { canonicalToolName, legacyToolInput, webSearchProviderLabel } from "./tool-display"

type Dict = Record<string, unknown>

export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  // One entry per file when a single request edits several.
  diffs?: { file: string; diff: string }[]
  patch?: string
  file?: string
}

export type PermissionPresentationInput = {
  action: string
  resources: ReadonlyArray<unknown>
  metadata?: unknown
  input?: unknown
  toolMetadata?: unknown
  // The tool that asks, when known. Its own field names decide which key names the file: NotebookEdit asks as Edit,
  // and a decoy `path` beside its `notebook_path` must not be what the prompt shows.
  tool?: string
}

// Every string here can come from a model (a shell command, a path, a diff), so the one exit writes control
// characters out for both clients.
export function permissionPresentation(
  source: PermissionPresentationInput,
  formatPath: (value: string) => string = (value) => value,
): PermissionPresentation {
  const presented = present(source, formatPath)
  return {
    ...presented,
    title: bodyText(presented.title),
    lines: presented.lines.map(bodyText),
    diff: presented.diff === undefined ? undefined : bodyText(presented.diff),
    diffs: presented.diffs?.map((item) => ({ file: bodyText(item.file), diff: bodyText(item.diff) })),
    patch: presented.patch === undefined ? undefined : bodyText(presented.patch),
  }
}

function present(source: PermissionPresentationInput, formatPath: (value: string) => string): PermissionPresentation {
  const action = canonicalToolName(source.action)
  // The source call is not always the call the request is about: a Code Mode fetch, a Workflow agent and a Patch edit
  // all ask under their caller's ID, so a caller's own input is shown only when the caller is the tool that asks.
  const owned = ownsAction(action, source.tool)
  const input = owned ? normalizeInput(action, source.input, source.tool) : {}
  // The calling tool's recorded progress is its own, and only a web search reads it (its provider).
  const metadata = { ...(owned ? dict(source.toolMetadata) : {}), ...dict(source.metadata) }
  const resources = source.resources.filter((item): item is string => typeof item === "string")
  // The place, file, method, URL and diff come from the request as the server resolved them and the tool acts on them:
  // the caller's input can spell another place (`~/..` is not a folder in the project, filename recovery reads a
  // sibling) and can carry keys the model added.
  const view = PermissionView.of({ action: source.action, resources, metadata: dict(source.metadata) })

  if (action === "edit") {
    const files = view.files
    const file = view.places[0] ?? files[0]?.place ?? files[0]?.file ?? ""
    // A patch asks once for every file it changes, so the prompt names all of them and shows every file's diff: showing
    // only the first would hide part of what is approved. A moved file's source is only in the places, and each
    // per-file entry carries the destination, so the names come from both.
    const targets = [...new Set([...view.places, ...files.map((item) => item.place ?? item.file)])]
    if (targets.length > 1) {
      const each = files.length > 0
      return {
        icon: "→",
        title: `Edit ${targets.length} files: ${targets.map(formatPath).join(", ")}`,
        lines: targets.map((target) => `Path: ${formatPath(target)}`),
        // The diff view draws one file's patch, so each file keeps its own; without them the joined text is shown as
        // plain text, never through the diff view.
        diffs: each
          ? files.map((item) => ({ file: formatPath(item.place ?? item.file), diff: item.patch }))
          : undefined,
        patch: each ? undefined : view.diff,
        file,
      }
    }
    const diff = files[0]?.patch || view.diff || undefined
    return {
      icon: "→",
      title: `Edit ${formatPath(file)}`,
      lines: [],
      diff,
      file,
    }
  }

  if (action === "read" || action === "list") {
    const value = view.places[0] ?? ""
    const title = action === "read" ? "Read" : "List"
    return {
      icon: "→",
      title: `${title} ${formatPath(value)}`,
      lines: value ? [`Path: ${formatPath(value)}`] : [],
    }
  }

  if (action === "glob" || action === "grep") {
    const pattern = view.pattern ?? ""
    const title = action === "glob" ? "Glob" : "Grep"
    return {
      icon: "✱",
      title: `${title} "${pattern}"`,
      lines: [
        ...(pattern ? [`Pattern: ${pattern}`] : []),
        ...(view.folder ? [`Folder: ${formatPath(view.folder)}`] : []),
      ],
    }
  }

  if (action === "shell") {
    const command = text(input.command)
    return {
      icon: "#",
      title: "Shell command",
      lines: [
        ...(command ? [`$ ${command}`] : resources.map((item) => `- ${item}`)),
        ...(view.folder ? [`Folder: ${formatPath(view.folder)}`] : []),
      ],
    }
  }

  if (action === "subagent") {
    const agent = text(input.agent) || (owned ? "" : resources[0]) || "general"
    const description = text(input.description)
    return {
      icon: "#",
      title: `${Locale.titlecase(agent)} Subagent`,
      lines: description ? [`◉ ${description}`] : [],
    }
  }

  if (action === "webfetch") {
    // A Code Mode fetch can write, and its prompt must not read like the read the person allowed: the method is part of
    // what is approved. Both come from the request, which names the URL that gets fetched.
    const url = view.url ?? ""
    const method = view.method ?? ""
    const writes = method !== "" && method !== "GET" && method !== "HEAD"
    return {
      icon: "%",
      title: writes ? `WebFetch ${method} ${url}` : `WebFetch ${url}`,
      lines: [...(writes ? [`Method: ${method}`] : []), ...(url ? [`URL: ${url}`] : [])],
    }
  }

  if (action === "websearch") {
    const query = text(input.query) || text(metadata.query)
    const title = webSearchProviderLabel(metadata.provider)
    return {
      icon: "◈",
      title: query ? `${title} "${query}"` : title,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (action === "external_directory") {
    const raw = text(dict(source.metadata).parentDir) || text(dict(source.metadata).filepath) || resources[0] || ""
    const directory = wildcardDirectory(raw)
    return {
      icon: "←",
      title: `Access external directory ${formatPath(directory)}`,
      lines: resources.map((item) => `- ${item}`),
    }
  }

  if (action === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  return {
    icon: "⚙",
    title: `Call tool ${source.action}`,
    lines: [`Tool: ${source.action}`, ...(view.arguments ? [`Arguments: ${view.arguments}`] : [])],
  }
}

const ownsAction = ToolNames.owns

function wildcardDirectory(value: string) {
  const wildcard = value.indexOf("*")
  if (wildcard === -1) return value
  const prefix = value.slice(0, wildcard)
  if (/^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix)) return prefix
  return prefix.replace(/[\\/]+$/, "")
}

export function permissionAlwaysLines(input: { action: string; save?: ReadonlyArray<string> }): string[] {
  const save = input.save ?? []
  if (save.length === 1 && save[0] === "*") {
    return [bodyText(`This will always allow ${input.action} for this project.`)]
  }
  return [
    "This will always allow the following patterns for this project.",
    ...save.map((item) => bodyText(`- ${item}`)),
  ]
}

export function permissionOptionLabel(option: "once" | "always" | "reject" | "confirm" | "cancel") {
  if (option === "once") return "Allow once"
  if (option === "always") return "Always allow"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

function normalizeInput(action: string, value: unknown, tool?: string): Dict {
  const input = dict(legacyToolInput(tool ?? action, value))
  const agent = text(input.agent) || text(input.subagent_type)
  return {
    ...input,
    ...(action === "subagent" && agent ? { agent } : {}),
  }
}

function dict(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Dict
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}
