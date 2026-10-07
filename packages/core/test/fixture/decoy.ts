import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"

// Programs for tests about which file Windows starts when Orbit asks for a program by its name. A decoy is a real .exe
// that writes ran.txt next to itself, with its own file name and its arguments, so a test can tell whether something
// started it and which one. Bun compiles a script into an .exe without a compiler in well under a second, and the
// folder of the test owns the result, so nothing is left behind when the test removes its folder.
const source = `
import { appendFileSync } from "node:fs"
import path from "node:path"
appendFileSync(
  path.join(path.dirname(process.execPath), "ran.txt"),
  [path.basename(process.execPath), ...process.argv.slice(2)].join(" ") + "\\n",
)
`

/**
 * Puts a decoy named `<name>.exe` into `directory` for each name, and returns what the decoys have run so far as one
 * line each: the file name followed by the arguments, so `[]` means that none was started.
 */
export async function plant(directory: string, first: string, ...others: ReadonlyArray<string>) {
  const original = path.join(directory, `${first}.exe`)
  const result = await Bun.build({
    entrypoints: ["/decoy.ts"],
    files: { "/decoy.ts": source },
    // A decoy must not read a bunfig.toml or .env of the folder it runs in, which is the folder under test.
    compile: { outfile: original, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not build the decoy program")
  await Promise.all(
    others.map((name) => {
      const target = path.join(directory, `${name}.exe`)
      // A link takes no room and no time. A volume that cannot link gets a copy.
      return fs.link(original, target).catch(() => fs.copyFile(original, target))
    }),
  )
  const marker = path.join(directory, "ran.txt")
  return async () =>
    (await Bun.file(marker).exists()) ? (await Bun.file(marker).text()).split(/\r?\n/).filter(Boolean) : []
}

/**
 * Removes NoDefaultCurrentDirectoryInExePath from this process until the result is disposed, then puts back what was
 * there. Windows looks in the working folder before PATH for a program that is started by its name, unless this variable
 * is in the environment of the process that starts it. The shell that runs the tests may set it, and an Orbit entry or
 * the spawner sets it once it ran, which hides what these tests are about.
 */
export function currentDirectoryOnPath() {
  const before = process.env.NoDefaultCurrentDirectoryInExePath
  delete process.env.NoDefaultCurrentDirectoryInExePath
  return {
    [Symbol.dispose]() {
      if (before === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
      else process.env.NoDefaultCurrentDirectoryInExePath = before
    },
  }
}

/** `currentDirectoryOnPath` for the time that `effect` runs. */
export const withCurrentDirectoryOnPath = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(currentDirectoryOnPath),
    () => effect,
    (guard) => Effect.sync(() => guard[Symbol.dispose]()),
  )
