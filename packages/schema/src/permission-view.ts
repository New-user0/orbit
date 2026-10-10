export * as PermissionView from "./permission-view.js"

import { ToolNames } from "./tool-names.js"

/**
 * What an approval shows, read from the permission request alone: its action, its resources and its metadata, which the
 * server fills with the values it resolved and the tool acts on. Every client (the terminal UI, Mini, ACP, VS Code) draws
 * these values and no other for a place, a file, a method, a URL or a diff, so a key a model adds to its own input, or a
 * spelling it chooses for a path, changes nothing that a person is shown. The calling tool's raw input is never read here.
 */
export interface File {
  /** The name the server gave the file in its diff. */
  readonly file: string
  /** The absolute place the tool writes the file to, when the server named it. */
  readonly place?: string
  /** The absolute place a moved file is read from. */
  readonly from?: string
  readonly patch: string
}

export interface View {
  /** The files or folders the request acts on, absolute as the server resolved them. */
  readonly places: ReadonlyArray<string>
  /** The folder a command runs in, or a Glob or Grep searches. */
  readonly folder?: string
  /** What a Glob or Grep looks for: its only resource. */
  readonly pattern?: string
  readonly method?: string
  readonly url?: string
  /** One entry per file the request changes, each with its own diff. */
  readonly files: ReadonlyArray<File>
  /** The diff of the whole request, when the server joined one. */
  readonly diff?: string
  /** The arguments of an MCP call, as the tool receives them. */
  readonly arguments?: string
}

export interface Request {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

// A request about files before the server named their places in its metadata (an older server) has them in its
// resources, relative to the project or absolute.
const fileActions = new Set(["read", "edit", "write", "patch", "notebook_edit", "list", "lsp"])
const folderActions = new Set(["glob", "grep"])

export function action(name: string) {
  const old = ToolNames.legacy(name).toLowerCase()
  if (old === "bash") return "shell"
  if (old === "task") return "subagent"
  if (old === "apply_patch") return "patch"
  return old
}

export function of(request: Request): View {
  const kind = action(request.action)
  const metadata = request.metadata ?? {}
  const places = strings(metadata.paths)
  const url = string(metadata.url) ?? request.resources.find(isUrl)
  const method =
    string(metadata.method)?.toUpperCase() ??
    request.resources.find((item) => /^[A-Z][A-Z-]* \S/.test(item))?.split(" ")[0] ??
    (url === undefined ? undefined : "GET")
  return {
    places:
      places.length > 0
        ? places
        : string(metadata.path) !== undefined && !folderActions.has(kind)
          ? [string(metadata.path)!]
          : fileActions.has(kind)
            ? request.resources.filter(isPlace)
            : [],
    folder: string(metadata.workdir) ?? (folderActions.has(kind) ? string(metadata.path) : undefined),
    pattern: folderActions.has(kind) ? request.resources[0] : undefined,
    method: kind === "webfetch" ? method : undefined,
    url: kind === "webfetch" ? url : undefined,
    files: (Array.isArray(metadata.files) ? metadata.files : []).flatMap(file),
    diff: string(metadata.diff),
    arguments: serialize(metadata.arguments),
  }
}

function file(value: unknown): File[] {
  if (typeof value !== "object" || value === null) return []
  const item = value as Record<string, unknown>
  const name = string(item.file)
  const patch = string(item.patch) ?? string(item.diff)
  if (name === undefined || patch === undefined) return []
  return [{ file: name, place: string(item.place), from: string(item.from), patch }]
}

// The whole text: the model picks the key order, so a cap would let it push the deciding value out of sight.
function serialize(value: unknown) {
  if (value === undefined) return undefined
  return JSON.stringify(value) ?? String(value)
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function string(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined
}

function isUrl(resource: string) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resource)
}

function isPlace(resource: string) {
  return resource !== "*" && !isUrl(resource) && !/^[A-Z][A-Z-]* \S/.test(resource)
}
