// Messages between the extension host and the chat webview. Kept free of `vscode` and DOM types so both sides and the
// tests share them.

export interface FileChange {
  readonly file: string
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
