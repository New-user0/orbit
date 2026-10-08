import type { TrustKind, TrustStatus, TrustWithheld } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import path from "node:path"
import type { TrustView } from "./protocol.js"

// What the extension says about workspace trust. The server decides it; this turns its answer into text for the person.
// Nothing here imports `vscode`, so it is tested without the editor.

// Typed by kind, so a kind that the protocol adds does not compile until it has words here.
const labels: Record<TrustKind, string> = {
  hooks: "hooks",
  mcp: "MCP servers",
  plugins: "plugins",
  commands: "shell snippets",
  permissions: "permission rules",
  providers: "providers",
  shell: "shell",
  formatter: "formatters",
  lsp: "language servers",
  sandbox: "sandbox",
  network: "network access",
  settings: "other settings",
}

/** How many of the held-back files the question lists before it says how many more there are. */
const listed = 6

/** What trusting `granted` did, for the person to read: the folder, how long it lasts, and what stays off above it. */
export interface TrustGrant {
  readonly directory: string
  readonly persistent: boolean
  readonly above: ReadonlyArray<string>
}

/**
 * The trust status in whatever the server sent, or undefined when it has not the shape of one. The client hands over
 * what arrived, so it is checked here once. A withheld entry that does not fit costs only itself: the server still
 * withholds it, and the rest of the answer stands.
 */
export function readStatus(value: unknown): TrustStatus | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("directory" in value) ||
    typeof value.directory !== "string" ||
    !("trusted" in value) ||
    typeof value.trusted !== "boolean" ||
    !("persistent" in value) ||
    typeof value.persistent !== "boolean" ||
    !("withheld" in value) ||
    !Array.isArray(value.withheld)
  )
    return undefined
  return { ...(value as TrustStatus), withheld: value.withheld.filter(isWithheld) }
}

/**
 * What trusting the project turns on, apart from what it does not. A file or directory in a folder above the project
 * names that folder as its `directory`, because each folder is trusted on its own: trusting the project lifts `own` and
 * leaves `above` held back.
 */
export function groupWithheld(items: ReadonlyArray<TrustWithheld>) {
  return {
    own: items.filter((item) => item.directory === undefined),
    above: items.filter((item) => item.directory !== undefined),
  }
}

/**
 * Whether the folder is untrusted and so holds something of its own back, which is what the question and the
 * indicators are for. Config in a folder above it follows that folder's own decision, so a folder whose only held-back
 * config sits above it has nothing that trusting it would turn on.
 */
export function holdsBack(status: TrustStatus | undefined) {
  return status !== undefined && !status.trusted && groupWithheld(status.withheld).own.length > 0
}

/**
 * What the chat shows for `status`, the answer for the folder that VS Code opened as `opened`. The folder that trust
 * belongs to is the server's: the project's root, which is not always the folder that was opened.
 */
export function view(status: TrustStatus, opened: string): TrustView {
  const held = groupWithheld(status.withheld)
  return {
    directory: plain(status.directory),
    ...(path.relative(opened, status.directory) === "" ? {} : { opened: plain(opened) }),
    persistent: status.persistent,
    summary: [...new Set(held.own.flatMap((item) => item.kinds.map(label)))].join(", "),
    held: held.own.map((item) => ({
      name: plain(fromFolder(status.directory, item.path)),
      kinds: item.kinds.map(label).join(", "),
    })),
    above: aboveFolders(status),
  }
}

/** The folders above the project that still hold config back, which trusting the project does not turn on. */
export function aboveFolders(status: TrustStatus) {
  return [...new Set(groupWithheld(status.withheld).above.flatMap((item) => item.directory ?? []))].map(plain)
}

/** The question that a modal asks, for a folder that holds something back. */
export function prompt(trust: TrustView) {
  const shown = trust.held.slice(0, listed)
  return {
    message: `Trust ${trust.directory}?`,
    detail: [
      "Orbit is leaving out what could run code or reach the network:",
      [
        ...shown.map((item) => `${item.name}: ${item.kinds}`),
        ...(trust.held.length > shown.length ? [`and ${trust.held.length - shown.length} more`] : []),
      ].join("\n"),
      ...(trust.opened === undefined
        ? []
        : [
            `VS Code opened ${trust.opened}. Trust belongs to the project's folder, which covers everything under it and its linked worktrees.`,
          ]),
      trust.persistent
        ? "Trust it only if you trust whoever wrote it. It stays trusted until `orb trust --revoke`."
        : "Trust it only if you trust whoever wrote it. Trusting a home directory or filesystem root lasts only until Orbit restarts, or on the background service until the service restarts. End it sooner with `orb trust --revoke`.",
      ...(trust.above.length === 0 ? [] : [aboveNote(trust.above)]),
    ].join("\n\n"),
    accept: trust.persistent ? "Trust this folder" : "Trust until Orbit restarts",
  }
}

/** What to tell the person once the folder is trusted. */
export function trusted(grant: TrustGrant) {
  return [
    grant.persistent ? `Trusted ${grant.directory}.` : `Trusted ${grant.directory} until Orbit restarts.`,
    ...(grant.above.length === 0 ? [] : [aboveNote(grant.above)]),
  ].join(" ")
}

// Config above the project stays off, and no command is offered for it: a grant always goes to the project's root,
// which is not always the folder the config sits in, so advice to trust that folder would not always work.
function aboveNote(folders: ReadonlyArray<string>) {
  return `Config in ${folders.join(", ")} stays off: each folder is trusted on its own.`
}

function isWithheld(value: unknown): value is TrustWithheld {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "kinds" in value &&
    Array.isArray(value.kinds) &&
    value.kinds.every((kind) => typeof kind === "string") &&
    (!("directory" in value) || value.directory === undefined || typeof value.directory === "string")
  )
}

// A kind the protocol has no words for yet is written out as it came.
function label(kind: string) {
  return Object.hasOwn(labels, kind) ? labels[kind as TrustKind] : plain(kind)
}

// A file or directory named from the project's folder when it lies inside it, else by its full path.
function fromFolder(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative === "" || path.isAbsolute(relative) || relative.split(path.sep)[0] === ".." ? file : relative
}
