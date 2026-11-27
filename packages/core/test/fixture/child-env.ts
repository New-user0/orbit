import { expect } from "bun:test"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// Class 10, "one spelling": Windows treats `Path` and `PATH` as one variable, but a plain object keeps two keys and the
// programs that read them disagree on which one counts. These helpers look at the environment a child really received.

/** A user config `env` that spells PATH differently from the inherited `Path` and tries to blank the lookup variable. */
export const spellingEnv = { path: "C:\\orbit-env-spelling", nodefaultcurrentdirectoryinexepath: "" }

/** The entries of the process environment that are PATH or the lookup variable, in any spelling. */
export const filterSource = `Object.entries(process.env).filter(([name]) => /^(path|nodefaultcurrentdirectoryinexepath)$/i.test(name))`

/** Runs a program with `options` as given and returns the PATH and lookup-variable entries that it received. */
export const received = (options: ChildProcess.CommandOptions) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(
      ChildProcess.make(process.execPath, ["-e", `process.stdout.write(JSON.stringify(${filterSource}))`], options),
    ),
  ).pipe(Effect.map((text) => JSON.parse(text) as Array<[string, string]>))

/** Exactly one PATH, holding the config value, and exactly the lookup variable at 1. */
export function expectOneSpelling(entries: ReadonlyArray<readonly [string, string | undefined]>) {
  expect(entries.filter(([name]) => /^path$/i.test(name)).map(([, value]) => value)).toEqual([spellingEnv.path])
  expect(entries.filter(([name]) => /^nodefaultcurrentdirectoryinexepath$/i.test(name))).toEqual([
    ["NoDefaultCurrentDirectoryInExePath", "1"],
  ])
}

/** Makes sure the parent has the variable set, as `ProgramLookup.install()` does, and puts it back afterwards. */
export const withLookupVariable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.NoDefaultCurrentDirectoryInExePath
      process.env.NoDefaultCurrentDirectoryInExePath = "1"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
        else process.env.NoDefaultCurrentDirectoryInExePath = previous
      }),
  )

/**
 * Bun keeps its transpiler cache under XDG_CACHE_HOME, so a child given a cache folder of its own transpiles everything
 * it imports before it does anything, every run: the OTLP fallback child took 0.4 s alone and over 5 s on a loaded
 * Windows runner. The test runner gives its run one cache (ORBIT_TEST_TRANSPILER_CACHE, tools/test/watchdog.ts) that a
 * child shares through this; without the runner the child keeps its own.
 */
export function sharedTranspilerCache() {
  return { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.ORBIT_TEST_TRANSPILER_CACHE }
}
