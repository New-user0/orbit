import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LinkShare } from "@orbit/util/link-share"
import { FSUtil } from "@orbit/util/fs-util"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { it } from "./lib/effect"

// A path that already names a share or a device is the answer. Its root is not a folder to read a link from: reading it
// would connect to the host (class 6). Share spellings are shares on Windows only.
const win = process.platform === "win32"

describe("LinkShare", () => {
  const spellings = [
    "\\\\example.invalid\\share",
    "\\\\example.invalid\\share\\",
    "//example.invalid/share",
    "//example.invalid/share/dir/file",
    "\\\\?\\UNC\\example.invalid\\share",
    "\\\\.\\pipe\\probe",
    "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\",
    "\\\\localhost\\C$\\Windows",
    "\\\\example.invalid@8765\\x\\",
  ]

  for (const spelling of spellings) {
    const test = win ? it.live : it.live.skip
    test(`${JSON.stringify(spelling)} is returned as it is, with no file system call`, () =>
      Effect.gen(function* () {
        const recorded = recordedFileSystem()
        const fs = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
        expect(yield* LinkShare.of(fs, spelling)).toBe(spelling)
        expect(recorded.calls).toEqual([])
        expect(LinkShare.ofSync(spelling)).toBe(spelling)
      }),
    )
  }
})
