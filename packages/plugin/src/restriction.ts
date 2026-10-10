export * as PluginRestriction from "./restriction.js"

import path from "path"
import { Npm } from "@orbit/util/npm"

export interface Restrictions {
  readonly allow?: readonly string[]
  readonly block?: readonly string[]
}

export interface Subject {
  /** A package name without its version, an absolute real path, or the raw spec when no name can be determined. */
  readonly target?: string
  /** A plugin ID, known only after the module is imported. It is checked against `block` alone. */
  readonly id?: string
  /** False when `target` is a raw spec whose package could not be named. While `allow` is set it is not allowed. */
  readonly verified?: boolean
}

export type Result = { readonly allowed: true } | { readonly allowed: false; readonly reason: "blocked" | "not_allowed" }

/**
 * Whether a plugin may run. A selector is `*` (everything), `prefix.*` / `@scope/*` (every name that starts with the prefix) or exact;
 * an absolute path selector matches only the same absolute path, so compare real paths. `block` wins and an empty one
 * does nothing. With no `allow` nothing is held back, an empty `allow` allows no external plugin, and otherwise a target
 * must match an entry. An ID is checked against `block` only. The caller decides what is exempt (built-in, SDK and
 * instance plugins never come here) and passes in the identity of the target; this function stays pure.
 */
export function check(restrictions: Restrictions, subject: Subject): Result {
  const subjects = [subject.target, subject.id].filter((item): item is string => item !== undefined)
  if (subjects.some((item) => (restrictions.block ?? []).some((selector) => selects(selector, item))))
    return { allowed: false, reason: "blocked" }
  const allow = restrictions.allow
  const target = subject.target
  if (allow === undefined || target === undefined) return { allowed: true }
  if (subject.verified === false) return { allowed: false, reason: "not_allowed" }
  return allow.some((selector) => selects(selector, target))
    ? { allowed: true }
    : { allowed: false, reason: "not_allowed" }
}

/**
 * The identity a package spec is checked by: the package name for a registry spec (`@corp/x@^1` is `@corp/x`), an
 * absolute path as it is, and for any other spec (git, alias, tarball) the raw spec, unverified.
 */
export async function identify(spec: string): Promise<Required<Pick<Subject, "target" | "verified">>> {
  if (path.isAbsolute(spec)) return { target: spec, verified: true }
  const name = await Npm.registryName(spec)
  return name === undefined ? { target: spec, verified: false } : { target: name, verified: true }
}

/**
 * Whether a selector that holds a `*` is one the matcher understands: the whole entry, or the end of a `.*` or `/*`
 * prefix (`corp.*`, `@corp/*`). Any other `*` would match nothing, so the caller reports it instead of loading it.
 */
export function wildcard(selector: string) {
  return selector === "*" || ((selector.endsWith(".*") || selector.endsWith("/*")) && !selector.slice(0, -1).includes("*"))
}

/**
 * The lists with every absolute path selector made real, so a selector written through a link (a Windows junction, macOS
 * `/tmp`) meets the real path that a target is identified by. Call it once per activation, not once per target.
 */
export async function real(restrictions: Restrictions, resolve: (file: string) => Promise<string>): Promise<Restrictions> {
  const each = (selectors: readonly string[] | undefined) =>
    selectors && Promise.all(selectors.map((selector) => (path.isAbsolute(selector) ? resolve(selector) : selector)))
  const [allow, block] = await Promise.all([each(restrictions.allow), each(restrictions.block)])
  return { ...(allow ? { allow } : {}), ...(block ? { block } : {}) }
}

function selects(selector: string, subject: string) {
  if (selector === "*") return true
  if (path.isAbsolute(selector) || path.isAbsolute(subject))
    return path.isAbsolute(selector) && path.isAbsolute(subject) && normalize(selector) === normalize(subject)
  return selector.endsWith(".*") || selector.endsWith("/*")
    ? subject.startsWith(selector.slice(0, -1))
    : selector === subject
}

function normalize(file: string) {
  const text = file.replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? text.toLowerCase() : text
}
