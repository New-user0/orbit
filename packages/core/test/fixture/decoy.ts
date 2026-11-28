import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "./tmpdir"

// Programs for tests about which file Windows starts when Orbit asks for a program by its name. A decoy is a real .exe
// that writes ran.txt next to itself, with its own file name and its arguments, so a test can tell whether something
// started it and which one. Bun compiles a script into an .exe without a compiler in well under a second. The decoy in
// the test's folder goes with that folder, and the one build a run shares (see `sharedBuild`) goes with the run's own.
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
  const shared = process.env.ORBIT_TEST_PROGRAMS
  if (!shared) await build(original)
  if (shared) {
    // A build makes the folder it writes to, so a caller may name one that is not there yet; a link needs it first.
    await fs.mkdir(directory, { recursive: true })
    await linkOrCopy(await sharedBuild(shared), original)
  }
  await Promise.all(others.map((name) => linkOrCopy(original, path.join(directory, `${name}.exe`))))
  return ranIn(directory)
}

// A decoy is a copy of the Bun runtime, about 110 MB. Built for every row, a Windows core run wrote tens of gigabytes to
// the runner's system disk, and while one was written the other worker's file and SQLite work waited on that disk: in
// the ci-measure runs the rows that stalled together in both workers, with their event loops held for seconds, fell in
// the seconds of heavy paging that the builds made. A run of the test runner (tools/test/watchdog.ts) keeps one build
// in its ORBIT_TEST_PROGRAMS folder for every worker and file, and each decoy is a link to it, which still writes its
// ran.txt beside the path it was started by. A file run without the runner builds its own.
async function sharedBuild(folder: string) {
  const program = path.join(folder, `decoy-${Bun.version}-${Bun.hash(source).toString(16)}.exe`)
  if (await Bun.file(program).exists()) return program
  // Workers may build at the same time: each writes a file of its own, and the first one linked to the name is kept.
  const own = path.join(folder, `build-${process.pid}-${crypto.randomUUID()}.exe`)
  await build(own)
  await fs.link(own, program).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await fs.rm(own, { force: true })
  return program
}

async function build(outfile: string) {
  const result = await Bun.build({
    entrypoints: ["/decoy.ts"],
    files: { "/decoy.ts": source },
    // A decoy must not read a bunfig.toml or .env of the folder it runs in, which is the folder under test.
    compile: { outfile, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not build the decoy program")
}

// A link takes no room and no time. A volume that cannot link gets a copy.
const linkOrCopy = (original: string, target: string) =>
  fs.link(original, target).catch(() => fs.copyFile(original, target))

/**
 * `plant` for a test that needs many folders with the same program: compiling one costs a copy of the Bun runtime, which
 * a loaded runner takes seconds over. `original` is a program that `plant` built, and the result is a link to it (or a
 * copy where the volume cannot link) named `<name>.exe` in `directory`, with its own `ran.txt`: the program writes
 * beside the path it was started by, so each folder keeps its own record.
 */
export async function plantFrom(original: string, directory: string, name: string) {
  await linkOrCopy(original, path.join(directory, `${name}.exe`))
  return ranIn(directory)
}

function ranIn(directory: string) {
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

