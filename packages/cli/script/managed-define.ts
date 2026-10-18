/**
 * Build-time replacements that make a released CLI ignore the environment's managed-folder override. They are kept in
 * a module of their own so that the build and its test use the same list.
 */
export const managedDefine = {
  "process.env.ORBIT_MANAGED_DIR": "undefined",
} as const
