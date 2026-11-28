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

/** An end of a file change that is reached through a link, as the server found it. */
export interface Link {
  /** The place the request names for that end, or where the link leads when it names none. */
  readonly file: string
  /** Where the link really leads. */
  readonly place: string
  readonly outside: boolean
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
  /** One per linked end of the request's files, the ones that end outside the project first. */
  readonly links: ReadonlyArray<Link>
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
  const files: unknown[] = Array.isArray(metadata.files) ? metadata.files : []
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
    files: files.flatMap(file),
    links: links(files),
    diff: string(metadata.diff),
    arguments: serialize(metadata.arguments),
  }
}

/**
 * The warning of one link. `show` is the client's: it formats a path and writes it out with `plainPath` (class 9). Where
 * the link ends is said before any path, so a line that is cut still says it.
 */
export function linkWarning(link: Link, show: (path: string) => string) {
  if (link.file === link.place) return `${ending(link)}, at ${show(link.place)}`
  return `${ending(link)}: ${show(link.file)} leads to ${show(link.place)}`
}

/** The one line that says a request has links, for where there is no room to name each. */
export function linkSummary(all: ReadonlyArray<Link>) {
  if (all.length < 2) return all[0] && ending(all[0])
  const outside = all.filter((link) => link.outside).length
  return `${all.length} linked paths, ${outside === 0 ? "all inside" : `${outside} outside`} the project`
}

/** The summary for a screen too narrow for it. It keeps the word that matters: outside, or inside. */
export function linkShort(all: ReadonlyArray<Link>) {
  if (all.length < 2) return all[0] && `Link ends ${side(all[0])}`
  const outside = all.filter((link) => link.outside).length
  return `${all.length} links, ${outside === 0 ? "all inside" : `${outside} outside`}`
}

function ending(link: Link) {
  return `Link ends ${side(link)} the project`
}

function side(link: Link) {
  return link.outside ? "outside" : "inside"
}

// Read from every entry, also one the diff list drops for having no patch. A bad link costs only itself (class 7).
function links(files: ReadonlyArray<unknown>) {
  const ends = files.flatMap((value) => {
    if (typeof value !== "object" || value === null) return []
    const item = value as Record<string, unknown>
    return [...end(item.link, string(item.place) ?? string(item.file)), ...end(item.fromLink, string(item.from))]
  })
  const seen = new Set<string>()
  // Outside comes first, so where two entries disagree about one end the one that is kept says outside (class 3).
  return [...ends.filter((link) => link.outside), ...ends.filter((link) => !link.outside)].filter((link) => {
    const key = JSON.stringify([link.file, link.place])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function end(value: unknown, named: string | undefined): Link[] {
  if (typeof value !== "object" || value === null) return []
  const link = value as Record<string, unknown>
  const place = string(link.place)
  if (place === undefined || typeof link.outside !== "boolean") return []
  return [{ file: named ?? place, place, outside: link.outside }]
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
