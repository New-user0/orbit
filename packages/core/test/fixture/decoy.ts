import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "./tmpdir"

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

/** The name that the shared decoy rows give their program. */
export const decoyName = "orbit-fake-prog"
const name = decoyName

// Decoys of every kind Windows runs, in the folder, with a mark that each leaves when run. `plant` also records the
// arguments, so a decoy that ran shows up as a line.
// With `exe: false` the folder holds only the .bat and .cmd decoys: an .exe of the same name would be found first and
// hide whether the lookup through cmd.exe reaches the batch files.
export const decoys = (directory: string, options: { readonly exe?: boolean } = {}) =>
  Effect.gen(function* () {
    const ran = options.exe === false ? async () => [] : yield* Effect.promise(() => plant(directory, name))
    const marks = path.join(directory, "batch-ran.txt")
    yield* Effect.promise(() =>
      Promise.all(
        [".bat", ".cmd"].map((extension) =>
          fs.writeFile(path.join(directory, `${name}${extension}`), `@echo off\r\necho ran> "${marks}"\r\n`),
        ),
      ),
    )
    return async () => [...(await ran()), ...((await Bun.file(marks).exists()) ? ["batch"] : [])]
  })

// A folder first on PATH while `body` runs.
export const onPath = <A, E, R>(bin: string, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = process.env.PATH
      process.env.PATH = `${bin}${path.delimiter}${before}`
      return before
    }),
    () => body,
    (before) =>
      Effect.sync(() => {
        process.env.PATH = before
      }),
  )

/**
 * One row: `start` runs the surface in `directory` with the program's name as its command. First with the real program
 * nowhere on PATH, where only a decoy could start; then with it on PATH, where only the real one may.
 */
export const row = <E, R, S>(
  directory: Effect.Effect<string, unknown, R>,
  start: (directory: string) => Effect.Effect<unknown, E, S>,
  options: { readonly exe?: boolean } = {},
) =>
  Effect.gen(function* () {
    const project = yield* directory
    const bin = (yield* tmpdirScoped()).path
    const projectRan = yield* decoys(project, options)
    const binRan = yield* Effect.promise(() => plant(bin, name))
    yield* withCurrentDirectoryOnPath(
      Effect.gen(function* () {
        yield* start(project)
        expect(yield* Effect.promise(projectRan)).toEqual([])
        expect(yield* Effect.promise(binRan)).toEqual([])

        yield* onPath(bin, start(project))
        expect(yield* Effect.promise(binRan)).toHaveLength(1)
        expect(yield* Effect.promise(projectRan)).toEqual([])
      }),
    )
  })

