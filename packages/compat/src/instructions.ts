export * as CompatInstructions from "./instructions.js"

import { CompatNames } from "./names.js"

/**
 * The instruction files to look for in each directory, in priority order. Only the first that exists in a directory
 * loads, so a project that keeps the same notes under several names is not instructed twice. The reference vendor's
 * file is one of them only while compatibility is enabled.
 */
export function filenames(enabled: boolean): readonly string[] {
  return ["ORBIT.md", "AGENTS.md", ...(enabled ? [CompatNames.vendor.instructions] : [])]
}

/**
 * The private variants of the instruction files, in priority order. They follow the same first-of rule as `filenames`,
 * but in a slot of their own, so a shared file never hides a person's local notes for the same directory.
 */
export function localFilenames(enabled: boolean): readonly string[] {
  return ["ORBIT.local.md", ...(enabled ? [CompatNames.vendor.localInstructions] : [])]
}

/**
 * Rule and instruction files that other agent products keep. `/init` reads them for guidance but Orbit never loads
 * them as instructions, and there are none to read while compatibility is disabled.
 */
export function rules(enabled: boolean): readonly string[] {
  return enabled ? Object.values(CompatNames.foreign).flat() : []
}
