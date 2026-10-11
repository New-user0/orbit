export * as EnvConfig from "./env-config.js"

/**
 * Decodes the raw `env` value of a settings document entry by entry, so one bad variable costs only itself. A number or
 * a boolean becomes its text. An empty name, a name with "=" or NUL (an "=" would set another variable, and a NUL fails
 * every spawn), and a value that is not text are dropped, each with a diagnostic at its own path. Key order is kept,
 * because on Windows a later spelling of a name replaces an earlier one.
 *
 * It lives beside the schema, not in Core, because the compatibility readers decode other products' settings files the
 * same way and may not depend on Core.
 */

export interface Diagnostic {
  readonly kind: "invalid" | "unsupported"
  readonly path: readonly string[]
  readonly message: string
}

export interface Result {
  /** The surviving variables, or undefined when the value is not an object at all. */
  readonly env: Readonly<Record<string, string>> | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Orbit sets this variable itself, so no setting may remove or change it, in any spelling. A child is handed it after
 * every setting, and the parent copy is what the runtime's own program lookup reads.
 */
export function isReserved(name: string) {
  return name.toLowerCase() === "nodefaultcurrentdirectoryinexepath"
}

export function decode(input: unknown): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return {
      env: undefined,
      diagnostics: [{ kind: "invalid", path: ["env"], message: "skipped malformed recognized value" }],
    }
  const diagnostics: Diagnostic[] = []
  const env: Record<string, string> = {}
  Object.entries(input).forEach(([name, raw]) => {
    const at = ["env", name]
    const value = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "boolean" ? String(raw) : raw
    if (!name || name.includes("=") || name.includes("\0") || typeof value !== "string" || value.includes("\0")) {
      diagnostics.push({ kind: "invalid", path: at, message: "skipped malformed recognized value" })
      return
    }
    if (isReserved(name)) {
      diagnostics.push({ kind: "unsupported", path: at, message: "ignored a variable that Orbit sets itself" })
      return
    }
    // A defined property, so a name such as `__proto__` stays a variable and does not reach the prototype.
    Object.defineProperty(env, name, { value, enumerable: true, configurable: true, writable: true })
  })
  return { env, diagnostics }
}
