import { Locale } from "./locale"
import { bodyText } from "./renderer"
import { canonicalToolName, finiteNumber, legacyToolInput, webSearchProviderLabel } from "./tool-display"

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
  const metadata = { ...(owned ? dict(source.toolMetadata) : {}), ...dict(source.metadata) }
  const resources = source.resources.filter((item): item is string => typeof item === "string")

  if (action === "edit") {
    const files = (Array.isArray(metadata.files) ? metadata.files : []).map(dict)
    const first = files[0] ?? {}
    const file = text(input.path) || text(first.file) || resources[0] || ""
    // A patch asks once for every file it changes, so the prompt names all of them and shows every file's diff: showing
    // only the first would hide part of what is approved.
    const named = files.map((item) => text(item.file)).filter(Boolean)
    const targets = named.length > 1 ? named : resources.length > 1 ? resources : []
    if (targets.length > 1) {
      const diffs = files.map((item) => ({ file: text(item.file), diff: text(item.patch) || text(item.diff) }))
      const each = named.length > 1 && diffs.every((item) => item.file && item.diff)
      return {
        icon: "→",
        title: `Edit ${targets.length} files: ${targets.map(formatPath).join(", ")}`,
        lines: targets.map((target) => `Path: ${formatPath(target)}`),
        // The diff view draws one file's patch, so each file keeps its own; without them the joined text is shown as
        // plain text, never through the diff view.
        diffs: each ? diffs.map((item) => ({ file: formatPath(item.file), diff: item.diff })) : undefined,
        patch: each
          ? undefined
          : text(metadata.diff) ||
            diffs
              .map((item) => item.diff)
              .filter(Boolean)
              .join("\n") ||
            undefined,
        file,
      }
    }
    const diff = text(first.patch) || text(first.diff) || text(metadata.diff) || undefined
    return {
      icon: "→",
      title: `Edit ${formatPath(file)}`,
      lines: [],
      diff,
      patch: diff ? undefined : text(input.patchText) || undefined,
      file,
    }
  }

  if (action === "read" || action === "list") {
    const value = text(input.path) || resources[0] || ""
    const title = action === "read" ? "Read" : "List"
    return {
      icon: "→",
      title: `${title} ${formatPath(value)}`,
      lines: value ? [`Path: ${formatPath(value)}`] : [],
    }
  }

  if (action === "glob" || action === "grep") {
    const pattern = text(input.pattern) || resources[0] || ""
    const title = action === "glob" ? "Glob" : "Grep"
    return {
      icon: "✱",
      title: `${title} "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (action === "shell") {
    const command = text(input.command)
    return {
      icon: "#",
      title: "Shell command",
      lines: command ? [`$ ${command}`] : resources.map((item) => `- ${item}`),
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
    // The request's own URL is what gets fetched, so it comes before anything the calling input says.
    const url = text(dict(source.metadata).url) || resources[0] || text(input.url) || text(metadata.url)
    return {
      icon: "%",
      title: `WebFetch ${url}`,
      lines: url ? [`URL: ${url}`] : [],
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

  if (action === "lsp") {
    const file = text(input.path)
    const operation = text(input.operation) || "request"
    const line = finiteNumber(input.line)
    const character = finiteNumber(input.character)
    const position = line !== undefined && character !== undefined ? `${line}:${character}` : undefined
    return {
      icon: "→",
      title: `LSP ${operation}${file ? ` ${formatPath(file)}${position ? `:${position}` : ""}` : ""}`,
      lines: [
        ...(input.operation ? [`Operation: ${operation}`] : []),
        ...(file ? [`Path: ${formatPath(file)}`] : []),
        ...(position ? [`Position: ${position}`] : []),
      ],
    }
  }

  if (action === "external_directory") {
    const raw = text(metadata.parentDir) || text(metadata.filepath) || resources[0] || ""
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
    lines: [`Tool: ${source.action}`],
  }
}

// The tools whose own input describes a request of this action; LSP asks as Read and Write, NotebookEdit as Edit.
const owners: Record<string, string[]> = {
  edit: ["edit", "write", "notebook_edit", "multiedit"],
  read: ["read", "lsp"],
  list: ["list", "glob"],
  glob: ["glob"],
  grep: ["grep"],
  shell: ["shell"],
  subagent: ["subagent", "task"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  lsp: ["lsp"],
}

function ownsAction(action: string, tool?: string) {
  if (tool === undefined) return true
  return (owners[action] ?? [action]).includes(canonicalToolName(tool).toLowerCase())
}

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
  const path = text(input.path) || text(input.filePath) || text(input.filepath)
  const agent = text(input.agent) || text(input.subagent_type)
  return {
    ...input,
    ...(["read", "edit", "list", "lsp"].includes(action) && path ? { path } : {}),
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
