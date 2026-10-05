import path from "node:path"

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    HOME: root,
    ORBIT_CLI_CONFIG_CONTENT: undefined,
    ORBIT_CONFIG_CONTENT: "{}",
    ORBIT_CONFIG_DIR: path.join(root, "config"),
    ORBIT_DB: path.join(root, "orbit.db"),
    ORBIT_DISABLE_FILEWATCHER: "true",
    ORBIT_DISABLE_MODELS_FETCH: "true",
    ORBIT_TEST_HOME: root,
    // Private servers trust the folders they run in, as before; trust tests override this with undefined.
    ORBIT_TRUST_PROJECT: "1",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}
