export type StatusLinePayloadInput = {
  readonly version: string
  readonly session?: {
    readonly id: string
    readonly title?: string
    readonly cost: number
    readonly created: number
    readonly agent?: string
  }
  readonly cwd?: string
  readonly projectDir?: string
  /** The model the person has selected, which is the one the next prompt uses. */
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly modelName?: string
  readonly agent?: string
  readonly outputStyle?: string
  readonly context?: { readonly tokens: number; readonly percent?: number }
  readonly contextLimit?: number
  readonly lines?: { readonly added: number; readonly removed: number }
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
    model: input.model
      ? {
          provider: input.model.providerID,
          id: input.model.id,
          name: input.modelName ?? input.model.id,
          variant: input.model.variant ?? null,
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
      lines_added: input.lines?.added ?? null,
      lines_removed: input.lines?.removed ?? null,
    },
    status: input.running ? "running" : "idle",
    vim_mode: input.vimMode ?? null,
    // Kept for scripts written against the first payload.
    session_id: session?.id ?? null,
  } as const
}
