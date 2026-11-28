import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { removeTree } from "./remove-tree"

type TempDir = { readonly path: string }

export const tmpdir = async (prefix = "orbit-core-test-") => {
  const dir = await make(prefix)
  return {
    path: dir,
    [Symbol.asyncDispose]() {
      return remove(dir)
    },
  }
}

// `parent` is the folder to make it in, the temporary folder when it is not given.
export const tmpdirScoped = (prefix = "orbit-core-test-", parent?: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => make(prefix, parent)),
    (dir) => Effect.tryPromise(() => remove(dir)).pipe(Effect.orDie),
  ).pipe(Effect.map((path) => ({ path })))

export const withTempDir = <A, E, R>(body: (tmp: TempDir) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => make("orbit-core-test-")),
    (path) => body({ path }),
    (dir) => Effect.tryPromise(() => remove(dir)).pipe(Effect.orDie),
  )

const make = async (prefix: string, parent = os.tmpdir()) => fs.realpath(await fs.mkdtemp(path.join(parent, prefix)))

// A program the test ran can hold the folder for a moment after it exits on Windows.
const remove = (dir: string) => removeTree(dir)
