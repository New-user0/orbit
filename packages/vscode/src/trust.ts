import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import path from "node:path"
import type { TrustView } from "./protocol.js"

// What the extension says about workspace trust. The server decides it; this turns its answer into text for the person.
// Nothing here imports `vscode`, so it is tested without the editor.

/** What trusting `granted` did, for the person to read: the folder, and how long it lasts. */
export interface TrustGrant {
  readonly directory: string
  readonly persistent: boolean
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
 * Whether the folder needs an answer from the person, which is what the question and the indicators are for: it is not
 * trusted, whatever it holds, because nothing a folder supplies loads and no work starts there until it is
 * (trust-first). A trusted folder is never asked about again, whatever changed in it since the grant, as the reference
 * does (D8), and so is one that a server older than this extension still lists changes for.
 */
export function asksTrust(status: TrustStatus | undefined) {
  return status !== undefined && !status.trusted
}

/**
 * What the chat shows for `status`, the answer for the folder that VS Code opened as `opened`. The folder that trust
 * belongs to is the server's: the project's root, which is not always the folder that was opened.
 */
export function view(status: TrustStatus, opened: string): TrustView {
  // Nothing of a folder that is not trusted was read, so nothing is listed.
  return {
    directory: plain(status.directory),
    ...(path.relative(opened, status.directory) === "" ? {} : { opened: plain(opened) }),
    persistent: status.persistent,
    summary: "",
    held: [],
  }
}

/** The question that a modal asks, for a folder that is not trusted. */
export function prompt(trust: TrustView) {
  return {
    message: `Trust ${trust.directory}?`,
    detail: [
      "Do you know where this folder came from? If you are not sure, read through its files before you go on.",
      "Orbit can read, change and run the files here, and nothing here loads until you trust it.",
      ...(trust.opened === undefined
        ? []
        : [
            `VS Code opened ${trust.opened}. Trust belongs to the project's folder, which covers everything under it and its linked worktrees.`,
          ]),
      trust.persistent
        ? "Trust it only if you trust whoever wrote it. It stays trusted until `orb trust --revoke`."
        : "Trust it only if you trust whoever wrote it. Trusting a home directory or filesystem root lasts only until Orbit restarts, or on the background service until the service restarts. End it sooner with `orb trust --revoke`.",
    ].join("\n\n"),
    accept: trust.persistent ? "Trust this folder" : "Trust until Orbit restarts",
  }
}

/** What to tell the person once the folder is trusted. */
export function trusted(grant: TrustGrant) {
  return grant.persistent ? `Trusted ${grant.directory}.` : `Trusted ${grant.directory} until Orbit restarts.`
}

function isWithheld(value: unknown): value is TrustWithheld {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "kinds" in value &&
    Array.isArray(value.kinds) &&
    value.kinds.every((kind) => typeof kind === "string")
  )
}
