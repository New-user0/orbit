import { describe, expect } from "bun:test"
import path from "path"
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
    // The rooted NT spellings: Windows opens each as a share or a device, so none is walked part by part.
    "\\??\\UNC\\example.invalid\\share\\skills",
    "\\??\\unc\\example.invalid\\share",
    "\\??\\GLOBALROOT\\Device\\Mup\\example.invalid\\share",
    "\\??\\Global\\UNC\\example.invalid\\share",
    "/??/UNC/example.invalid/share",
    // A dot segment in front of the NT root: the walks resolve it before they read a part, so it is the same share.
    "\\x\\..\\??\\UNC\\example.invalid\\share",
    "\\.\\??\\UNC\\example.invalid\\share",
    "/./??/UNC/example.invalid/share",
    "\\x\\..\\??\\GLOBALROOT\\Device\\Mup\\example.invalid\\share",
  ]

  for (const spelling of spellings) {
    const test = win ? it.live : it.live.skip
    test(`${JSON.stringify(spelling)} is returned as it is, with no file system call`, () =>
      Effect.gen(function* () {
        const recorded = recordedFileSystem()
        const fs = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
        expect(yield* LinkShare.of(fs, spelling)).toBe(spelling)
        expect(LinkShare.ofSync(spelling)).toBe(spelling)
        expect(LinkShare.isShare(spelling)).toBe(true)
        expect(yield* LinkShare.blocked(fs, spelling)).toBe(true)
        expect(yield* LinkShare.scan(fs, spelling, ["**"])).toEqual([])
        expect(recorded.calls).toEqual([])
      }),
    )
  }
})

describe("LinkShare.unresolved", () => {
  // On POSIX a name without a root is read from the working folder, so it would count as inside it.
  it.live("is rooted and outside the working folder on every platform", () =>
    Effect.sync(() => {
      const answer = LinkShare.unresolved("some/link")
      expect(LinkShare.isUnresolved(answer)).toBe(true)
      expect(path.isAbsolute(answer)).toBe(true)
      expect(FSUtil.contains(process.cwd(), answer)).toBe(false)
    }),
  )
})
