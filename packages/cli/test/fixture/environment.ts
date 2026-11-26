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
    // No real /etc/orbit or %ProgramFiles%\Orbit: the managed settings point at a folder that does not exist.
    ORBIT_MANAGED_DIR: path.join(root, "managed-missing"),
    ORBIT_TEST_HOME: root,
    // Private servers trust the folders they run in, as before; trust tests override this with undefined.
    ORBIT_TRUST_PROJECT: "1",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...sharedTranspilerCache(),
    ...overrides,
  }
}

/**
 * Bun keeps its transpiler cache under XDG_CACHE_HOME, so a child with a cache folder of its own transpiled and wrote the
 * whole source tree (about a thousand files) before it answered, which made each start on a Windows runner several times
 * slower. The test runner gives its run one cache that every child shares; without the runner, the child keeps its own as
 * before. A test that builds the environment of a child by hand adds this too.
 */
export function sharedTranspilerCache() {
  return { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.ORBIT_TEST_TRANSPILER_CACHE }
}
