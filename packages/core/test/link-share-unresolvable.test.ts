import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { canLinkFile } from "./fixture/symlink"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Class 7 (M3 verification round 7): off Windows the scan asked the file system to resolve every link, and a loop, a path
// through a file or an unreadable target became a defect that stopped the loaders on a repository that ships one. Such a
// link is not a share and is not followed; the plain entries still load.

setDefaultTimeout(60_000)
const command = "---\ndescription: x\n---\nrun it\n"

describe.skipIf(!canLinkFile)("a link that cannot be resolved", () => {
  for (const folder of ["commands", "agents", "skills"])
    it.live(`${folder}: loops and a path through a file are skipped, and the plain entry is listed`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const dir = path.join(root, ".orbit", folder)
        yield* Effect.promise(async () => {
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(path.join(root, "plain.txt"), "x")
          await fs.writeFile(path.join(dir, "ok.md"), command)
          await fs.symlink("loop", path.join(dir, "loop"), "dir")
          await fs.symlink("b", path.join(dir, "a"), "dir")
          await fs.symlink("a", path.join(dir, "b"), "dir")
          await fs.symlink(path.join("..", "..", "plain.txt", "below"), path.join(dir, "through"), "dir")
        })
        const files = yield* FSUtil.Service.pipe(Effect.provide(recordedFileSystem().layer))
        expect((yield* LinkShare.scan(files, dir, ["*.md"])).map((file) => path.basename(file))).toEqual(["ok.md"])
        if (folder === "commands")
          expect((yield* CommandFile.load(files, path.join(root, ".orbit"))).map((item) => item.name)).toEqual(["ok"])
      }),
    )
})
