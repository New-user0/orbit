// clients-ux-15 part 2: the VS Code chat's in-diff review, in the module that knows nothing of VS Code
// (`src/review.ts`). Open diff reads a file only when its real path is inside the asking session's own folder and inside
// a workspace root, and it reads that same real path. A share or device spelling is refused before any disk access
// (classes 3, 4 and 6; the door rule). Every disk access goes through the `Disk` the review is given, so the tests record
// it over the real file system. A review tab answers its request at most once, and a tab the extension closes itself
// answers nothing (class 8). A prompt's changes are rebuilt from the server's patches alone. Every file name a person
// reads is written out (class 9).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTwoFilesPatch, formatPatch, structuredPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permissionItem } from "../src/controller"
import type { FileChange } from "../src/protocol"

// The contract of `src/review.ts`, which part 2 adds. Until it exists the import below fails and so does every test here;
// typed through this contract, the file typechecks before and after the build. The build may replace the dynamic import
// with a plain one.
type Disk = {
  realpath(file: string): Promise<string>
  lstat(file: string): Promise<unknown>
  readFile(file: string): Promise<string>
}
type Folders = { readonly session: string | undefined; readonly roots: ReadonlyArray<string> }
type Review =
  | { kind: "diff"; file: string; before: string; after: string; editable: boolean }
  | { kind: "text"; file: string; patch: string; reason: "untrusted" | "outside" | "changed" }
type Answer = { sessionID: string; requestID: string; decision: "once" | "reject"; content?: string }
type Rewind = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }
type Contract = {
  disk: Disk
  review(item: ReturnType<typeof permissionItem>, folders: Folders, disk?: Disk): Promise<Review[]>
  notice(review: Extract<Review, { kind: "text" }>): string
  tabName(file: string, suffix?: string): string
  Reviews: new () => {
    open(input: { file: string; request?: { id: string; sessionID: string }; editable: boolean }): string
    saved(name: string, text: string): Answer | undefined
    closed(name: string): Answer | undefined
    rejected(name: string): Answer | undefined
    answered(requestID: string): string[]
    closeAll(): string[]
  }
  changes(
    diffs: ReadonlyArray<{ file: string; status: string; patch: string }>,
  ): Array<
    { file: string; status: string; before: string; after: string } | { file: string; status: string; patch: string }
  >
  restoreQuestion(dryRun: Rewind): { ok: true; message: string; detail: string } | { ok: false; text: string }
}
const { changes, disk, notice, restoreQuestion, review, Reviews, tabName }: Contract = await import(
  `../src/${"review"}`
)

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-diff-review-")))
const session = path.join(root, "session")
const outside = path.join(root, "outside")
const other = path.join(root, "other")
const marker = path.join(outside, "marker.txt")
const inside = path.join(session, "a.txt")
const host = "orbit-test.invalid"
// The same text inside and outside, so a patch would apply to either: a refusal is never because the patch failed.
const text = "alpha\nbeta\n"
const proposal = "alpha\nBETA\n"
const patch = createTwoFilesPatch("a.txt", "a.txt", text, proposal)
const added = createTwoFilesPatch("new.txt", "new.txt", "", "fresh\n")
const linkType = process.platform === "win32" ? "junction" : "dir"

beforeAll(async () => {
  await Promise.all([fs.mkdir(session), fs.mkdir(outside), fs.mkdir(other), fs.mkdir(path.join(root, "removed"))])
  await Promise.all([
    Bun.write(inside, text),
    Bun.write(marker, text),
    Bun.write(path.join(session, "bom.txt"), `\uFEFF${text}`),
    Bun.write(path.join(session, "changed.txt"), "something else\n"),
  ])
  // A link in the session's folder to a folder outside it, and one that leads nowhere.
  await fs.symlink(outside, path.join(session, "link"), linkType)
  await fs.symlink(path.join(root, "removed"), path.join(session, "gone"), linkType)
  await fs.rm(path.join(root, "removed"), { recursive: true })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// The real file system, with every access the review makes written down.
function recorded() {
  const calls: string[] = []
  const recorder: Disk = {
    realpath: (file) => {
      calls.push(`realpath ${file}`)
      return disk.realpath(file)
    },
    lstat: (file) => {
      calls.push(`lstat ${file}`)
      return disk.lstat(file)
    },
    readFile: (file) => {
      calls.push(`read ${file}`)
      return disk.readFile(file)
    },
  }
  return { calls, recorder, reads: () => calls.filter((call) => call.startsWith("read ")).map((call) => call.slice(5)) }
}

function item(files: ReadonlyArray<unknown>, revisable = true) {
  // The request as the server lists it, `revisable` included (part 1).
  const request = {
    id: "per_review",
    sessionID: "ses_review",
    action: "Edit",
    resources: ["a.txt"],
    revisable,
    metadata: { files },
  }
  return permissionItem(request)
}

const folders: Folders = { session, roots: [root] }

describe("a path that is not really inside the session's folder is shown as text and never read", () => {
  type Row = {
    name: string
    file: Partial<FileChange> & { patch: string }
    folders?: Folders
    platform?: NodeJS.Platform
    expect: "diff" | "outside" | "untrusted"
  }
  const rows: Row[] = [
    { name: "inside", file: { file: "a.txt", place: inside, patch }, expect: "diff" },
    {
      name: "inside, other case",
      file: { file: "a.txt", place: path.join(session.toUpperCase(), "a.txt"), patch },
      platform: "win32",
      expect: "diff",
    },
    { name: "absolute outside", file: { file: "marker.txt", place: marker, patch }, expect: "outside" },
    {
      name: "dot-dot",
      file: { file: "marker.txt", place: [session, "..", "outside", "marker.txt"].join(path.sep), patch },
      expect: "outside",
    },
    {
      name: "link out",
      file: { file: "link/marker.txt", place: path.join(session, "link", "marker.txt"), patch },
      expect: "outside",
    },
    {
      name: "dangling link",
      file: { file: "gone/new.txt", place: path.join(session, "gone", "new.txt"), patch: added, status: "added" },
      expect: "outside",
    },
    { name: "UNC", file: { file: "a.txt", place: `\\\\${host}\\share\\a.txt`, patch }, expect: "outside" },
    { name: "forward-slash UNC", file: { file: "a.txt", place: `//${host}/share/a.txt`, patch }, expect: "outside" },
    {
      name: "device UNC",
      file: { file: "a.txt", place: `\\\\?\\UNC\\${host}\\share\\a.txt`, patch },
      expect: "outside",
    },
    { name: "device drive", file: { file: "a.txt", place: `\\\\?\\${inside}`, patch }, expect: "outside" },
    { name: "dot device", file: { file: "a.txt", place: `\\\\.\\${inside}`, patch }, expect: "outside" },
    { name: "NT prefix", file: { file: "a.txt", place: `\\??\\UNC\\${host}\\share\\a.txt`, patch }, expect: "outside" },
    {
      name: "Git Bash spelling",
      file: { file: "a.txt", place: `/${inside[0]?.toLowerCase()}${inside.slice(2).replaceAll("\\", "/")}`, patch },
      platform: "win32",
      expect: "outside",
    },
    { name: "relative, no place", file: { file: "a.txt", patch }, expect: "outside" },
    {
      name: "move from outside",
      file: { file: "moved.txt", place: path.join(session, "moved.txt"), from: marker, patch },
      expect: "outside",
    },
    {
      name: "untrusted",
      file: { file: "a.txt", place: inside, patch },
      folders: { session: undefined, roots: [root] },
      expect: "untrusted",
    },
  ]
  for (const row of rows)
    test.skipIf(row.platform !== undefined && row.platform !== process.platform)(row.name, async () => {
      const disk = recorded()
      const [shown, ...rest] = await review(item([row.file]), row.folders ?? folders, disk.recorder)
      expect(rest).toEqual([])
      // Nothing outside the session's folder is read, and a share's host is never named to the file system.
      expect(disk.reads().filter((file) => !file.startsWith(session))).toEqual([])
      expect(
        disk.calls.filter((call) => call.includes(host) || call.includes("\\\\?\\") || call.includes("\\\\.\\")),
      ).toEqual([])
      if (row.expect === "diff") {
        expect(shown).toMatchObject({ kind: "diff", before: text, after: proposal, editable: true })
        // Read once, by its real path.
        expect(disk.reads()).toEqual([await fs.realpath(inside)])
        return
      }
      expect(shown).toMatchObject({ kind: "text", reason: row.expect, patch: row.file.patch })
      expect(disk.reads()).toEqual([])
      if (row.expect === "untrusted") expect(disk.calls).toEqual([])
    })
})

test.skipIf(process.platform !== "win32")(
  "a link that leads to a share is refused before any real path is taken",
  async () => {
    const link = path.join(session, "share")
    const made = await fs.symlink(`\\\\${host}\\share`, link, "dir").then(
      () => true,
      () => false,
    )
    // Making a link needs Developer Mode or an elevated shell on Windows; the row must pass where it can be made.
    if (!made) return
    const disk = recorded()
    const [shown] = await review(
      item([{ file: "a.txt", place: path.join(link, "a.txt"), patch }]),
      folders,
      disk.recorder,
    )
    expect(shown).toMatchObject({ kind: "text", reason: "outside" })
    expect(disk.calls.filter((call) => call.includes(path.join(link, "a.txt")) || call.includes(host))).toEqual([])
    await fs.rm(link, { force: true, recursive: true })
  },
)

describe("containment needs the session's folder and a workspace root", () => {
  for (const row of [
    { name: "second root", roots: [other, session], expect: "diff" as const },
    { name: "no root", roots: [other], expect: "text" as const },
  ])
    test(row.name, async () => {
      const disk = recorded()
      const [shown] = await review(
        item([{ file: "a.txt", place: inside, patch }]),
        { session, roots: row.roots },
        disk.recorder,
      )
      expect(shown?.kind).toBe(row.expect)
      expect(disk.reads()).toEqual(row.expect === "diff" ? [await fs.realpath(inside)] : [])
    })
})

test("only a pending Edit or Write approval of one file gets a review that can answer", async () => {
  const one = { file: "a.txt", place: inside, patch }
  expect((await review(item([one]), folders))[0]).toMatchObject({ kind: "diff", editable: true })
  // Patch and NotebookEdit questions are not revisable: their diffs are previews.
  expect((await review(item([one], false), folders))[0]).toMatchObject({ kind: "diff", editable: false })
  expect((await review({ ...item([one]), status: "once" }, folders))[0]).toMatchObject({
    kind: "diff",
    editable: false,
  })
  const two = await review(item([one, { ...one }]), folders)
  expect(two.map((entry) => entry.kind === "diff" && entry.editable)).toEqual([false, false])
})

test("a file with a byte order mark is reviewed without it", async () => {
  const [shown] = await review(item([{ file: "bom.txt", place: path.join(session, "bom.txt"), patch }]), folders)
  // The server's diffs carry no byte order mark, and the server keeps the file's own when it writes.
  expect(shown).toMatchObject({ kind: "diff", before: text, after: proposal, editable: true })
})

test("a move is read from where it came from and proposed where it goes", async () => {
  const disk = recorded()
  const moved = createTwoFilesPatch("a.txt", "moved.txt", text, proposal)
  const [shown] = await review(
    item([{ file: "moved.txt", place: path.join(session, "moved.txt"), from: inside, patch: moved }], false),
    folders,
    disk.recorder,
  )
  expect(shown).toMatchObject({ kind: "diff", before: text, after: proposal })
  expect(disk.reads()).toEqual([await fs.realpath(inside)])
})

test("an added file has an empty left side and reads nothing", async () => {
  const disk = recorded()
  const [shown] = await review(
    item([{ file: "new.txt", place: path.join(session, "new.txt"), patch: added, status: "added" }]),
    folders,
    disk.recorder,
  )
  expect(shown).toMatchObject({ kind: "diff", before: "", after: "fresh\n", editable: true })
  expect(disk.reads()).toEqual([])
})

test("a file that changed since it was read is shown as text, with its name written out", async () => {
  const name = "dir/sa‮fe\u001b[2K.txt"
  const [shown] = await review(item([{ file: name, place: path.join(session, "changed.txt"), patch }]), folders)
  expect(shown).toMatchObject({ kind: "text", reason: "changed", patch })
  if (shown?.kind !== "text") throw new Error("not text")
  const line = notice(shown)
  expect(line).toContain("changed")
  expect(line).not.toContain("‮")
  expect(line).not.toContain("\u001b")
  expect(line).toContain("\\u{202e}")
})

test("a malformed file entry costs only itself", async () => {
  const shown = await review(
    item([{ file: "a.txt", place: inside, patch }, { file: 3 }, "junk", { place: inside }]),
    folders,
  )
  expect(shown).toHaveLength(1)
  expect(shown[0]).toMatchObject({ kind: "diff", after: proposal })
})

test("tab names are Orbit's label, the base name written out and six hex characters", () => {
  expect(tabName("src/a.txt")).toMatch(/^Orbit: a\.txt \([0-9a-f]{6}\)$/)
  expect(tabName("src/a.txt")).not.toBe(tabName("src/a.txt"))
  expect(tabName("C:\\work\\a.txt", "abc123")).toBe("Orbit: a.txt (abc123)")
  const odd = tabName("dir/sa‮fe\u001b[2K.txt", "abc123")
  expect(odd).not.toContain("‮")
  expect(odd).not.toContain("\u001b")
  expect(odd).toContain("\\u{202e}")
  expect(new Reviews().open({ file: "src/a.txt", editable: false })).toMatch(/^Orbit: a\.txt \([0-9a-f]{6}\)$/)
})

test("a review tab answers its request once: save sends the text, close sends once, Reject rejects", () => {
  const reviews = new Reviews()
  const request = { id: "per_1", sessionID: "ses_1" }
  const first = reviews.open({ file: "a.txt", request, editable: true })
  const second = reviews.open({ file: "a.txt", request, editable: true })
  expect(first).not.toBe(second)
  expect(reviews.saved(first, "mine\n")).toEqual({
    sessionID: "ses_1",
    requestID: "per_1",
    decision: "once",
    content: "mine\n",
  })
  // The first answer wins: every later save, close or reject of that request's tabs answers nothing.
  expect(reviews.saved(first, "again\n")).toBeUndefined()
  expect(reviews.closed(second)).toBeUndefined()
  expect(reviews.rejected(second)).toBeUndefined()

  const closed = reviews.open({ file: "b.txt", request: { id: "per_2", sessionID: "ses_1" }, editable: true })
  expect(reviews.closed(closed)).toEqual({ sessionID: "ses_1", requestID: "per_2", decision: "once" })
  const rejected = reviews.open({ file: "c.txt", request: { id: "per_3", sessionID: "ses_1" }, editable: true })
  expect(reviews.rejected(rejected)).toEqual({ sessionID: "ses_1", requestID: "per_3", decision: "reject" })
  expect(reviews.saved("Orbit: unknown.txt (000000)", "x")).toBeUndefined()
})

test("tabs closed for an answer or a prompt answer nothing", () => {
  const reviews = new Reviews()
  const answered = reviews.open({ file: "a.txt", request: { id: "per_5", sessionID: "ses_1" }, editable: true })
  const waiting = reviews.open({ file: "b.txt", request: { id: "per_6", sessionID: "ses_1" }, editable: true })
  const view = reviews.open({ file: "changes", editable: false })

  // The card, a review tab or another client answered per_5: its tab closes and that close is no answer.
  expect(reviews.answered("per_5")).toEqual([answered])
  expect(reviews.closed(answered)).toBeUndefined()
  // A prompt, or Stop, closes every tab, a waiting one included, and none of those closes answers.
  expect(reviews.closeAll().sort()).toEqual([waiting, view].sort())
  expect(reviews.closed(waiting)).toBeUndefined()
  expect(reviews.saved(waiting, "x\n")).toBeUndefined()
  expect(reviews.closeAll()).toEqual([])
  // The question is still pending, so Open diff can open it again, and that tab answers.
  const again = reviews.open({ file: "b.txt", request: { id: "per_6", sessionID: "ses_1" }, editable: true })
  expect(reviews.closed(again)).toEqual({ sessionID: "ses_1", requestID: "per_6", decision: "once" })
})

test("a preview tab answers nothing", () => {
  const reviews = new Reviews()
  const preview = reviews.open({ file: "a.txt", request: { id: "per_7", sessionID: "ses_1" }, editable: false })
  expect(reviews.saved(preview, "x\n")).toBeUndefined()
  expect(reviews.rejected(preview)).toBeUndefined()
  expect(reviews.closed(preview)).toBeUndefined()
  const view = reviews.open({ file: "changes", editable: false })
  expect(reviews.closed(view)).toBeUndefined()
})

test("a prompt's changes are rebuilt from the server's patches alone", () => {
  // The server's per-prompt diff with no `context` gives whole-file patches.
  const whole = (file: string, before: string, after: string) =>
    formatPatch(structuredPatch(file, file, before, after, "", "", { context: 2_147_483_647 }))
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n"
  const shown = changes([
    { file: "a.txt", status: "modified", patch: whole("a.txt", long, long.replace("line 20", "LINE 20")) },
    { file: "new.txt", status: "added", patch: whole("new.txt", "", "fresh\n") },
    { file: "old.txt", status: "deleted", patch: whole("old.txt", "gone\n", "") },
    { file: "tail.txt", status: "modified", patch: whole("tail.txt", "a\nb", "a\nc") },
    // A name outside the folder is only a name: both sides come from its patch, and the marker is not read.
    { file: "../outside/marker.txt", status: "modified", patch: whole("../outside/marker.txt", "one\n", "two\n") },
    // One that cannot be rebuilt costs only itself.
    { file: "image.bin", status: "modified", patch: "Binary files a/image.bin and b/image.bin differ\n" },
    { file: "sa‮fe.txt", status: "added", patch: whole("sa‮fe.txt", "", "x\n") },
  ])
  expect(shown.slice(0, 5)).toEqual([
    { file: "a.txt", status: "modified", before: long, after: long.replace("line 20", "LINE 20") },
    { file: "new.txt", status: "added", before: "", after: "fresh\n" },
    { file: "old.txt", status: "deleted", before: "gone\n", after: "" },
    { file: "tail.txt", status: "modified", before: "a\nb", after: "a\nc" },
    { file: "../outside/marker.txt", status: "modified", before: "one\n", after: "two\n" },
  ])
  expect(shown[5]).toEqual({
    file: "image.bin",
    status: "modified",
    patch: "Binary files a/image.bin and b/image.bin differ\n",
  })
  expect(shown[6]).toMatchObject({ status: "added", before: "", after: "x\n" })
  expect(shown[6]?.file).not.toContain("‮")
  expect(shown[6]?.file).toContain("\\u{202e}")
})

test("the restore question lists the files written out, with the line totals", () => {
  const question = restoreQuestion({
    canRewind: true,
    filesChanged: ["/p/a.txt", "/p/sa‮fe\u001b[2K.txt"],
    insertions: 3,
    deletions: 1,
  })
  expect(question.ok).toBe(true)
  if (!question.ok) throw new Error("refused")
  const shown = `${question.message}\n${question.detail}`
  expect(question.message).toContain("2 files")
  expect(shown).toContain("a.txt")
  expect(shown).toContain("\\u{202e}")
  expect(shown).not.toContain("‮")
  expect(shown).not.toContain("\u001b")
  expect(shown).toMatch(/\+3\b/)
  expect(shown).toMatch(/[-−]1\b/)
  expect(shown).toContain("cannot be undone")

  const one = restoreQuestion({ canRewind: true, filesChanged: ["/p/a.txt"], insertions: 0, deletions: 2 })
  expect(one.ok && one.message).toContain("1 file")
  expect(one.ok && one.message).not.toContain("1 files")

  const refused = restoreQuestion({ canRewind: false, error: "No checkpoint for this message\u001b[2K" })
  expect(refused).toMatchObject({ ok: false })
  if (refused.ok) throw new Error("not refused")
  expect(refused.text).toContain("No checkpoint for this message")
  expect(refused.text).not.toContain("\u001b")
})

// "What is shown is what runs", the Open diff half: every request the tools really asked (the approval matrix), each with
// keys a model added to its input. The review reads only the request's own places, and nothing outside the session's
// folder; the tool input is not even on the item.
type MatrixRow = { id: string; request: { action: string; resources: string[]; metadata?: Record<string, unknown> } }
const world = {
  project: path.join(root, "matrix-project").replaceAll("\\", "/"),
  outside: path.join(root, "matrix-outside").replaceAll("\\", "/"),
}
const load = async (name: string) =>
  ((await Bun.file(path.join(import.meta.dir, "../../core/test/fixture", name)).json()) as MatrixRow[]).map(
    (row): MatrixRow =>
      JSON.parse(
        JSON.stringify(row)
          .replaceAll("{project}", world.project)
          .replaceAll("{outsideName}", "matrix-outside")
          .replaceAll("{outside}", world.outside),
      ),
  )
const rows = [...(await load("approval-matrix.json")), ...(await load("approval-matrix-pinned.json"))].filter(
  (row) => ((row.request.metadata?.files as unknown[] | undefined) ?? []).length > 0,
)

describe("the review of each approval-matrix row reads only the request's places, never the tool input", () => {
  beforeAll(async () => {
    for (const folder of [world.project, world.outside]) {
      await fs.mkdir(path.join(folder, "src"), { recursive: true })
      await Bun.write(path.join(folder, "src", "file.txt"), "alpha\n")
      await Bun.write(path.join(folder, "file.txt"), "alpha\n")
    }
  })

  test("the matrix has rows with files inside and outside the project", () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => JSON.stringify(row.request).includes(world.outside))).toBe(true)
    expect(rows.some((row) => JSON.stringify(row.request).includes(`${world.project}/src`))).toBe(true)
  })

  for (const row of rows)
    test(row.id, async () => {
      const disk = recorded()
      const request = permissionItem({ id: "per_matrix", sessionID: "ses_matrix", ...row.request })
      const shown = await review(request, { session: world.project, roots: [root] }, disk.recorder)
      expect(disk.calls.filter((call) => call.includes("DECOY"))).toEqual([])
      const project = await fs.realpath(world.project)
      expect(disk.reads().filter((file) => !file.startsWith(project))).toEqual([])
      request.files.forEach((file, index) => {
        if ([file.place, file.from].some((place) => place?.startsWith(world.outside)))
          expect(shown[index]).toMatchObject({ kind: "text", reason: "outside", patch: file.patch })
      })
    })
})
