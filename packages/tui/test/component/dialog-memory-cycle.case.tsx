import { expect, test } from "bun:test"
import path from "node:path"
import { DialogMemory } from "../../src/component/dialog-memory"
import { tmpdir } from "../fixture/fixture"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

// Run by dialog-memory.test.tsx in a child process with a deadline, never collected on its own (its name is not a test
// file's): a depth that followed a loop of imports would block the event loop, where no timeout of the runner fires.

test("draws a listing whose imports name each other", async () => {
  await using tmp = await tmpdir()
  const a = path.join(tmp.path, "a.md")
  const b = path.join(tmp.path, "b.md")
  const listing = {
    files: [
      { path: a, kind: "project", chars: 1, importedBy: b, exists: true, target: { type: "file", path: a } },
      { path: b, kind: "project", chars: 1, importedBy: a, exists: true, target: { type: "file", path: b } },
    ],
    warnings: [],
    folders: [],
    enabled: true,
    git: false,
    available: true,
  }
  const fetch = async (url: URL) => {
    if (url.pathname === "/api/location")
      return json({ directory: tmp.path, project: { id: "proj_test", directory: tmp.path, canonical: tmp.path } })
    if (url.pathname === "/api/location/memory") return json({ data: listing })
  }
  await using setup = await renderLocal({ directory: tmp.path, url: "http://127.0.0.1:4096", fetch })
  setup.dialog.replace(() => <DialogMemory open={async () => {}} />, undefined, { size: "large" })
  const frame = await setup.waitForFrame((frame) => frame.includes(`.${path.sep}b.md`))
  expect(frame).toContain(`.${path.sep}a.md`)
})
