import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { removeTree } from "../../../core/test/fixture/remove-tree"

export async function tmpdir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbit-cli-test-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await removeTree(directory)
    },
  }
}
