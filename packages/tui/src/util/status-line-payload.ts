export type StatusLinePayloadInput = {
  readonly version: string
  readonly session?: {
    readonly id: string
    readonly title?: string
    readonly cost: number
    readonly created: number
    readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
    readonly agent?: string
  }
  readonly cwd?: string
  readonly projectDir?: string
  readonly modelName?: string
  readonly agent?: string
  readonly outputStyle?: string
  readonly context?: { readonly tokens: number; readonly percent?: number }
  readonly contextLimit?: number
  readonly lines?: { readonly added: number; readonly removed: number }
  readonly permissionsPending: number
  readonly running: boolean
  readonly vimMode?: string
  readonly now: number
}

/** What the status line command reads on stdin. Every key is always present; unknown values are null. */
export function statusLinePayload(input: StatusLinePayloadInput) {
  const session = input.session
  return {
    version: input.version,
    session: session ? { id: session.id, title: session.title ?? null } : null,
    cwd: input.cwd ?? null,
    project_dir: input.projectDir ?? null,
    model: session?.model
      ? {
          provider: session.model.providerID,
          id: session.model.id,
          name: input.modelName ?? session.model.id,
          variant: session.model.variant ?? null,
        }
      : null,
    agent: input.agent ?? session?.agent ?? null,
    output_style: input.outputStyle ?? "default",
    context: input.context
      ? {
          used: input.context.tokens,
          limit: input.contextLimit ?? null,
          percent: input.context.percent ?? null,
        }
      : null,
    cost: {
      usd: session?.cost ?? 0,
      duration_ms: session ? Math.max(0, input.now - session.created) : 0,
      lines_added: input.lines?.added ?? 0,
      lines_removed: input.lines?.removed ?? 0,
    },
    status: input.permissionsPending > 0 ? "waiting" : input.running ? "running" : "idle",
    vim_mode: input.vimMode ?? null,
    // Kept for scripts written against the first payload.
    session_id: session?.id ?? null,
  } as const
}
