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
 * The folder of rule files inside a root that the reference vendor keeps config in (`CompatRoots`, kind `vendor`). Like the
 * instruction file, it is read only while compatibility is enabled, and the caller asks the switch first.
 */
export const ruleFolder = CompatNames.vendor.rules

/** The folders of rule files that a project folder can hold, as paths from that folder, while compatibility is enabled. */
export function ruleDirectories(enabled: boolean): readonly string[] {
  return enabled ? [`${CompatNames.vendor.directory}/${CompatNames.vendor.rules}`] : []
}

/**
 * Rule and instruction files that other agent products keep. `/init` reads them for guidance but Orbit never loads
 * them as instructions, and there are none to read while compatibility is disabled.
 */
export function rules(enabled: boolean): readonly string[] {
  return enabled ? Object.values(CompatNames.foreign).flat() : []
}
