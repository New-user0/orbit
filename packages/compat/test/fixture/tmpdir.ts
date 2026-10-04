import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"

/** A temporary directory in its canonical spelling, removed when the scope closes. */
export const tmpdirScoped = () =>
  Effect.acquireRelease(
    Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-compat-test-")))),
    // Windows holds directories open a moment longer than other platforms do.
    (directory) =>
      Effect.promise(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )

/** Creates every directory, and every file given as a [path, text] pair, with its parents. */
export const write = (entries: readonly (string | readonly [string, string])[]) =>
  Effect.promise(() =>
    Promise.all(
      entries.map(async (entry) => {
        if (typeof entry === "string") return fs.mkdir(entry, { recursive: true })
        await fs.mkdir(path.dirname(entry[0]), { recursive: true })
        return fs.writeFile(entry[0], entry[1])
      }),
    ),
  )
