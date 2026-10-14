// Messages between the extension host and the chat webview. Kept free of `vscode` and DOM types so both sides and the
// tests share them.

import type { PermissionView } from "@orbit/schema/permission-view"

export interface FileChange {
  readonly file: string
  /** The absolute place the server resolved the file to, and where a moved file came from. */
  readonly place?: string
  readonly from?: string
  readonly patch: string
  readonly status?: string
  readonly additions?: number
  readonly deletions?: number
}

/** One agent a workflow started, as the workflow tool reports it. */
export interface WorkflowAgent {
  readonly sessionID: string
  readonly description: string
  readonly agent: string
  readonly status: "running" | "completed" | "failed"
  readonly phase?: string
  readonly model?: string
  readonly started?: number
  readonly ended?: number
  readonly tokens?: number
}

export type Item =
  | { readonly type: "user"; readonly id: string; readonly text: string }
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string; readonly text: string; readonly seconds?: number }
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly status: "running" | "completed" | "error"
      readonly input?: Readonly<Record<string, unknown>>
      readonly output?: string
      readonly error?: string
      readonly files?: ReadonlyArray<FileChange>
      readonly exit?: number
      readonly agents?: ReadonlyArray<WorkflowAgent>
    }
  | {
      readonly type: "permission"
      readonly id: string
      readonly sessionID: string
      readonly action: string
      readonly resources: ReadonlyArray<string>
      /** Whether an "always" reply would save a grant; managed_permissions_only withholds it. */
      readonly canSave: boolean
      /** What the card shows: the request's own values, never the calling tool's input. */
      readonly view: PermissionView.View
      readonly files: ReadonlyArray<FileChange>
      readonly status: "pending" | "once" | "always" | "reject"
    }
  | { readonly type: "note"; readonly id: string; readonly text: string; readonly tone: "muted" | "error" }

export interface Model {
  readonly providerID: string
  readonly id: string
  readonly name: string
}

export interface Todo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

/** What the empty chat offers, from the editor's current state. */
export interface Workspace {
  readonly folder: string
  readonly selection?: { readonly file: string; readonly startLine: number; readonly endLine: number }
  readonly problems?: { readonly file: string; readonly count: number }
  readonly file?: string
}

export interface Check {
  readonly ok: boolean
  readonly text: string
}

export type Mode = "build" | "plan"

/**
 * What the chat shows about a folder that is not trusted yet and holds something back. Every string came from the
 * server or from a file in the folder, and arrives written out by `plain`, so none carries a control or format character.
 */
export interface TrustView {
  /** The project's folder, which is the one trust is decided for, granted for and worked in. */
  readonly directory: string
  /** The folder VS Code opened, when it is not that folder: a folder inside the project, or a linked worktree. */
  readonly opened?: string
  /** Whether a grant can be kept on disk. A home directory or a filesystem root can only be trusted until Orbit restarts. */
  readonly persistent: boolean
  /** The folder is trusted, and what is listed changed since it was: the question is whether to trust the changes. */
  readonly changed?: boolean
  /** What is left out, as a list of kinds: "hooks, MCP servers". */
  readonly summary: string
  /** The files and directories of the project that hold something back, by path from its folder. */
  readonly held: ReadonlyArray<{ readonly name: string; readonly kinds: string }>
  /** Folders above the project that hold config back until each is trusted on its own. */
  readonly above: ReadonlyArray<string>
}

/** A question the server needs answered: the question tool's questions or a plan to approve. */
export interface FormRequest {
  readonly id: string
  readonly sessionID: string
  readonly title: string
  readonly fields: ReadonlyArray<FormField>
}

export interface FormField {
  readonly key: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
  readonly custom?: boolean
  readonly hidden?: boolean
}

/** From the extension host to the webview. */
export type ToView =
  | { readonly type: "item"; readonly item: Item }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "reset" }
  | { readonly type: "models"; readonly models: ReadonlyArray<Model>; readonly selected?: string }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "setup"; readonly checks: ReadonlyArray<Check> }
  | { readonly type: "workspace"; readonly workspace: Workspace }
  | { readonly type: "mode"; readonly mode: Mode }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "plan"; readonly todos: ReadonlyArray<Todo> }
  | { readonly type: "trust"; readonly trust: TrustView | undefined }

/** From the webview to the extension host. */
export type FromView =
  | { readonly type: "ready" }
  | { readonly type: "send"; readonly text: string; readonly selection: boolean }
  | { readonly type: "starter"; readonly starter: "explain" | "fix" | "review" }
  | { readonly type: "stop" }
  | { readonly type: "permission"; readonly id: string; readonly decision: "once" | "always" | "reject" }
  | { readonly type: "diff"; readonly id: string }
  | { readonly type: "model"; readonly model: string }
  | { readonly type: "mode"; readonly mode: Mode }
  /** Asks whether to trust the folder; the extension host shows the question, so a click here never trusts by itself. */
  | { readonly type: "trust" }
