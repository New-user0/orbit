export * as CompatDiagnostic from "./diagnostic.js"

import type { Document } from "@orbit/schema/config"

/** A problem found in a file another product keeps: where it is, what it is, and what was done about it. */
export interface Info {
  /** The file the problem is in. */
  readonly source: string
  readonly kind: "invalid" | "unsupported"
  /** The value the problem is about, as keys from the root of the file. `["$"]` is the whole file. */
  readonly path: readonly string[]
  readonly message: string
}

/**
 * What a reader made of its files. A file it can use only in part still yields a document, and a file it cannot use
 * yields none, and each says why here. The caller reports them, so a reader never logs.
 */
export interface Result {
  readonly documents: readonly Document[]
  readonly diagnostics: readonly Info[]
}
