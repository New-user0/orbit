import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permissionItem } from "../src/controller"
import type { FormRequest, FromView, Item } from "../src/protocol"

// The glue between the review (`src/review.ts`) and VS Code, which cannot run under Bun. As in `extension-trust.test.ts`
// the extension gets a stand-in `vscode` in which every call answers with another stand-in, except the calls the review
// makes: the file system and text provider it registers, its commands, the diff it opens, the tabs it closes and the
// messages it shows, which are written down. The chat's controller is a stand-in too, which records the replies the
// extension sends (class 12).
const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-glue-")))
const file = path.join(folder, "glue.txt")
const patch = createTwoFilesPatch("glue.txt", "glue.txt", "one\n", "two\n")

type Uri = { scheme: string; path: string; toString(): string }
type Tab = { label: string; input?: unknown }
const filesystems = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
const contents = new Map<string, { provideTextDocumentContent(uri: Uri): string }>()
const commands = new Map<string, (...args: unknown[]) => unknown>()
const executed: unknown[][] = []
const warnings: unknown[][] = []
const informations: unknown[][] = []
const closing: Tab[] = []
const tabs: Tab[] = []
// A second editor group, where a tab the person moves goes.
const moved: Tab[] = []
const documents: Array<{ uri: Uri; isDirty: boolean; save(): Promise<boolean> }> = []
const saved: string[] = []
// Tabs VS Code would not close without asking the person whether to save them first.
const prompts: string[] = []
const listeners: Array<(event: { opened: unknown[]; changed: unknown[]; closed: Tab[] }) => void> = []
const saving: Array<(event: { document: { uri: Uri }; reason: number }) => void> = []
const reasons = { Manual: 1, AfterDelay: 2, FocusOut: 3 }
const providers = new Map<string, unknown>()
// What the next modal question is answered with: the button the person picks, by its title.
const answer: { title?: string } = {}
const picks: unknown[][] = []
const program: { path?: string } = {}
const workspaceFolders = [
  { uri: { scheme: "file", fsPath: folder } },
  { uri: { scheme: "vscode-remote", fsPath: "/x" } },
]

const stub = (overrides: Record<string, unknown> = {}): unknown =>
  new Proxy(function () {}, {
    get: (_, key) => {
      if (typeof key === "symbol" || key === "then") return undefined
      return key in overrides ? overrides[key] : stub()
    },
    apply: () => stub(),
    construct: () => stub() as object,
  })

const uri = (parts: { scheme: string; path: string }): Uri => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` })

class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

const vscode = stub({
  Uri: stub({ from: uri }),
  TabInputTextDiff,
  TextDocumentSaveReason: reasons,
  FileType: { File: 1, Directory: 2 },
  window: stub({
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      providers.set(id, provider)
      return stub()
    },
    showWarningMessage: async (...args: unknown[]) => {
      warnings.push(args)
      return args.slice(1).find((item) => (item as { title?: string })?.title === answer.title)
    },
    showInformationMessage: async (...args: unknown[]) => void informations.push(args),
    // A form's yes-or-no field is answered Yes; the history list's first session is the one picked.
    showQuickPick: async (...args: unknown[]) => {
      picks.push(args)
      const first = Array.isArray(args[0]) ? args[0][0] : undefined
      return typeof first === "object" && first !== null && "id" in first ? first : "Yes"
    },
    tabGroups: stub({
      get all() {
        return [
          { tabs, viewColumn: 1 },
          { tabs: moved, viewColumn: 2 },
        ]
      },
      // As VS Code does, a tab with unsaved edits is not closed but asked about, and the tabs that close are reported.
      close: async (closed: Tab[]) => {
        const dirty = closed.filter((tab) =>
          documents.some(
            (document) =>
              document.isDirty &&
              tab.input instanceof TabInputTextDiff &&
              document.uri.toString() === tab.input.modified.toString(),
          ),
        )
        prompts.push(...dirty.map((tab) => tab.label))
        if (dirty.length > 0) return false
        closing.push(...closed)
        for (const tab of closed) tabs.splice(tabs.indexOf(tab), 1)
        for (const listener of listeners) listener({ opened: [], changed: [], closed })
        return true
      },
      onDidChangeTabs: (listener: (typeof listeners)[number]) => {
        listeners.push(listener)
        return stub()
      },
    }),
  }),
  commands: stub({
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commands.set(id, handler)
      return stub()
    },
    executeCommand: async (...args: unknown[]) => {
      executed.push(args)
      // As VS Code does, a diff whose tab is open already brings that tab forward and adds none.
      if (args[0] === "vscode.diff" && ![...tabs, ...moved].some((tab) => tab.label === String(args[3])))
        tabs.push({ label: String(args[3]), input: new TabInputTextDiff(args[1] as Uri, args[2] as Uri) })
    },
  }),
  workspace: stub({
    textDocuments: documents,
    workspaceFolders,
    onWillSaveTextDocument: (listener: (typeof saving)[number]) => {
      saving.push(listener)
      return stub()
    },
    registerFileSystemProvider: (scheme: string, provider: Record<string, (...args: unknown[]) => unknown>) => {
      filesystems.set(scheme, provider)
      return stub()
    },
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) => {
      contents.set(scheme, provider)
      return stub()
    },
    // The person's own `orbit.executable`, once a test sets one; every other setting is off.
    getConfiguration: () =>
      stub({
        inspect: (key: string) => ({ globalValue: key === "executable" ? program.path : false }),
        get: (_: string, fallback: unknown) => fallback,
      }),
  }),
})

// The chat's private parts that the glue goes through.
type Chat = {
  controller: Promise<unknown> | undefined
  panel: unknown
  items: Item[]
  receive(message: FromView): Promise<unknown>
  apply(update: { type: "item"; item: Item } | { type: "form"; form: FormRequest }): void
  send(text: string): Promise<void>
}
type Extension = typeof import("../src/extension")
let extension: Extension
const replies: unknown[][] = []
const sent: string[] = []
const marked: string[] = []
const unmarked: string[] = []
const resets: string[] = []
const opened: string[] = []
const restored: Array<{ messageID: string; confirmed: boolean }> = []
const answered: unknown[][] = []
const listed: { files: unknown[] | undefined } = { files: [] }
let question = item("per_glue", patch)

function item(id: string, change: string) {
  return permissionItem({
    id,
    sessionID: "ses_glue",
    action: "Edit",
    resources: ["glue.txt"],
    revisable: true,
    metadata: { files: [{ file: "glue.txt", place: file, patch: change }] },
  })
}

beforeAll(async () => {
  await Bun.write(file, "one\n")
  mock.module("vscode", () => ({ default: vscode }))
  extension = await import("../src/extension")
  extension.activate(stub({ subscriptions: [] }) as Parameters<Extension["activate"]>[0])
  // The chat tab is open already, and its controller is the stand-in.
  chat().panel = { reveal() {}, webview: { postMessage: async () => true } }
  chat().controller = Promise.resolve({
    permission: (id: string) => (id === question.id ? question : undefined),
    reply: async (...args: unknown[]) => {
      replies.push(args)
      return "sent"
    },
    folders: async () => ({ folders: [folder] }),
    reviewing: (id: string, open = true) => void (open ? marked : unmarked).push(id),
    reset: () => void resets.push(question.id),
    sessions: async () => [{ id: "ses_old", title: "Old", time: { updated: Date.now() } }],
    open: async (id: string) => (opened.push(id), "build"),
    note: () => {},
    send: async (text: string) => void sent.push(text),
    answer: async (...args: unknown[]) => void answered.push(args),
    changes: async () => listed.files,
    restore: async (messageID: string, confirm: (dry: unknown) => Promise<boolean>) =>
      void restored.push({
        messageID,
        confirmed: await confirm({ canRewind: true, filesChanged: [file], insertions: 1, deletions: 2 }),
      }),
  })
})

beforeEach(() => {
  replies.length = 0
  documents.length = 0
  prompts.length = 0
})

// A review side with unsaved edits, saved as VS Code saves a document: the save is announced as the person's, the side is
// looked up (and when it is not there, the folders above it are made), written, and looked up again. Any step that throws
// fails the save, and the document stays unsaved.
function editing(target: Uri, text: string) {
  const attempt = (run: () => unknown) => Promise.resolve().then(run).then(() => true, () => false)
  const document = {
    uri: target,
    isDirty: true,
    save: async () => {
      saved.push(target.path)
      for (const listener of saving) listener({ document: { uri: target }, reason: reasons.Manual })
      if (!(await attempt(() => system().stat(target)))) {
        const parent = uri({ scheme: target.scheme, path: path.posix.dirname(target.path) })
        if (!(await attempt(() => system().stat(parent))) && !(await attempt(() => system().createDirectory(parent))))
          return false
      }
      const written = await attempt(() =>
        system().writeFile(target, new TextEncoder().encode(text), { create: true, overwrite: true }),
      )
      if (!written || !(await attempt(() => system().stat(target)))) return false
      document.isDirty = false
      return true
    },
  }
  documents.push(document)
  return document
}

afterAll(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const chat = () => providers.get("orbit.chat") as Chat
// The person closes a tab: it leaves its group, and VS Code reports it closed.
const fire = async (label: string) => {
  for (const group of [tabs, moved]) group.splice(0, group.length, ...group.filter((tab) => tab.label !== label))
  for (const listener of listeners) listener({ opened: [], changed: [], closed: [{ label }] })
  await Bun.sleep(50)
}
const lastDiff = () => executed.findLast((call) => call[0] === "vscode.diff") as [string, Uri, Uri, string]
const system = () => filesystems.get("orbit-review")!
const open = async (id: string, change = patch) => {
  question = item(id, change)
  await chat().receive({ type: "diff", id: question.id })
  return lastDiff()
}

test("the extension registers the review file system, opens the diff with the request's sides and title, and a tab the person closes replies once", async () => {
  expect([...filesystems.keys()]).toEqual(["orbit-review"])
  expect([...contents.keys()]).toEqual(["orbit-proposed"])
  const [, left, right, title] = await open("per_glue")
  expect(left.scheme).toBe("orbit-proposed")
  expect(right.scheme).toBe("orbit-review")
  expect(title).toMatch(/^Orbit: glue\.txt \([a-z0-9]{6}\)$/)
  expect(marked).toContain("per_glue")
  // The left side is the text that was read, and the writable side holds the proposal.
  expect(contents.get("orbit-proposed")!.provideTextDocumentContent(left)).toBe("one\n")
  expect(contents.get("orbit-proposed")!.provideTextDocumentContent(uri({ scheme: "orbit-proposed", path: "/x" }))).toBe("")
  expect(new TextDecoder().decode(system().readFile(right) as Uint8Array)).toBe("two\n")
  expect(system().stat(right)).toMatchObject({ size: 4 })

  await fire(title)
  await fire(title)
  expect(replies).toEqual([["per_glue", "once", undefined]])
})

test("a review file system has only the review's sides, and saving one answers with its text", async () => {
  const gone = uri({ scheme: "orbit-review", path: "/nothing" })
  expect(() => system().stat(gone)).toThrow()
  expect(() => system().readFile(gone)).toThrow()
  expect(() => system().createDirectory(gone)).toThrow()
  expect(() => system().delete(gone)).toThrow()
  expect(() => system().rename(gone, gone)).toThrow()
  expect(system().readDirectory(gone)).toEqual([])
  const [, , right] = await open("per_saved")
  await system().writeFile(right, new TextEncoder().encode("mine\n"), { create: false, overwrite: true })
  expect(replies).toEqual([["per_saved", "once", "mine\n"]])
})

test("the Accept and Reject title actions answer through the controller, and Accept saves unsaved edits", async () => {
  const [, , accepted] = await open("per_accept")
  // With unsaved edits, Accept saves them: the save is the answer.
  documents.push({ uri: accepted, isDirty: true, save: async () => (saved.push(accepted.path), true) })
  await commands.get("orbit.review.accept")!(accepted)
  expect(saved).toEqual([accepted.path])
  expect(replies).toEqual([])
  // With none, it accepts the proposal as it stands.
  documents.length = 0
  await commands.get("orbit.review.accept")!(accepted)
  expect(replies).toEqual([["per_accept", "once", undefined]])
  const [, , rejected] = await open("per_reject")
  // A document of another scheme at the review side's own path is not the review's.
  await commands.get("orbit.review.accept")!(uri({ scheme: "file", path: rejected.path }))
  await commands.get("orbit.review.reject")!(uri({ scheme: "file", path: rejected.path }))
  expect(replies).toHaveLength(1)
  await commands.get("orbit.review.reject")!(rejected)
  expect(replies.at(-1)).toEqual(["per_reject", "reject", undefined])
  // Only the review's own documents.
  await commands.get("orbit.review.accept")!(uri({ scheme: "file", path: file }))
  await commands.get("orbit.review.reject")!(uri({ scheme: "file", path: file }))
  expect(replies).toHaveLength(2)
})

test("a folder the window opens over another file system is not one the review reads from", async () => {
  // The only folder that holds the file is a remote one whose path on this machine happens to match.
  workspaceFolders.splice(0, workspaceFolders.length, { uri: { scheme: "vscode-remote", fsPath: folder } })
  try {
    const before = executed.length
    question = item("per_remote", patch)
    await chat().receive({ type: "diff", id: question.id })
    expect(executed.slice(before).filter((call) => call[0] === "vscode.diff")).toEqual([])
  } finally {
    workspaceFolders.splice(
      0,
      workspaceFolders.length,
      { uri: { scheme: "file", fsPath: folder } },
      { uri: { scheme: "vscode-remote", fsPath: "/x" } },
    )
  }
  // The control: the same question opens once the folder is a local one.
  await open("per_local")
  expect(marked).toContain("per_local")
})

test("the changed-since-read warning is shown without the file name", async () => {
  const before = executed.length
  question = item("per_changed", createTwoFilesPatch("glue.txt", "glue.txt", "else\n", "two\n"))
  await chat().receive({ type: "diff", id: question.id })
  expect(executed.slice(before).filter((call) => call[0] === "vscode.diff")).toEqual([])
  const warning = warnings.at(-1)!
  expect(String(warning[0])).not.toContain("glue")
  expect(String(warning[0])).toContain("changed since the agent read it")
})

test("a new question opens for review on its own, and a new prompt closes every Orbit tab without answering", async () => {
  const before = executed.length
  question = item("per_auto", patch)
  chat().apply({ type: "item", item: question })
  await Bun.sleep(50)
  const opened = executed.slice(before).filter((call) => call[0] === "vscode.diff")
  expect(opened).toHaveLength(1)
  const title = String(opened[0]?.[3])
  // An update of the same question opens nothing more.
  chat().apply({ type: "item", item: { ...question, reviewing: true } })
  await Bun.sleep(50)
  expect(executed.slice(before).filter((call) => call[0] === "vscode.diff")).toHaveLength(1)

  await chat().send("next")
  expect(sent).toEqual(["next"])
  expect(closing.map((tab) => tab.label)).toContain(title)
  // The question stays pending, and its card stops saying to answer in a tab that is gone.
  expect(unmarked).toContain("per_auto")
  await fire(title)
  expect(replies).toEqual([])
})

test("New Session and a session picked from history close every Orbit tab without answering", async () => {
  for (const command of ["orbit.newSession", "orbit.history"]) {
    const [, , right, title] = await open(`per_${command}`)
    const before = resets.length
    await commands.get(command)!()
    expect(resets.length).toBe(before + 1)
    expect(closing.map((tab) => tab.label)).toContain(title)
    expect(unmarked).toContain(`per_${command}`)
    // VS Code reports the close; a save of the side it showed, arriving late, answers nothing either.
    await fire(title)
    await system().writeFile(right, new TextEncoder().encode("mine\n"), { create: false, overwrite: true })
    await commands.get("orbit.review.reject")!(right)
    await commands.get("orbit.review.accept")!(right)
    expect(replies).toEqual([])
  }
  expect(opened).toEqual(["ses_old"])
})

test("View changes opens one multi-file diff, and Restore files asks before it restores", async () => {
  listed.files = []
  await chat().receive({ type: "changes", messageID: "msg_1" })
  expect(String(informations.at(-1)?.[0])).toContain("changed no files")
  listed.files = undefined
  const before = executed.length
  await chat().receive({ type: "changes", messageID: "msg_1" })
  expect(executed.length).toBe(before)
  listed.files = [{ file: "glue.txt", status: "modified", patch, additions: 1, deletions: 1 }]
  await chat().receive({ type: "changes", messageID: "msg_1" })
  const view = executed.at(-1)!
  expect(view[0]).toBe("vscode.changes")
  expect(view[1]).toMatch(/^Orbit: changes in this prompt \(1 file\) \([a-z0-9]{6}\)$/)
  expect((view[2] as Uri[][])[0]?.map((side) => side.scheme)).toEqual(["orbit-proposed", "orbit-proposed", "orbit-proposed"])

  answer.title = undefined
  await chat().receive({ type: "restore", messageID: "msg_1" })
  answer.title = "Restore"
  await chat().receive({ type: "restore", messageID: "msg_2" })
  expect(restored).toEqual([
    { messageID: "msg_1", confirmed: false },
    { messageID: "msg_2", confirmed: true },
  ])
  const modal = warnings.at(-1)!
  expect(modal[0]).toBe("Restore 1 file to how they were before this prompt? +1 / −2 lines. This cannot be undone.")
  expect(modal[1]).toEqual({ modal: true, detail: "glue.txt" })
})

test("a form the controller passes on is asked with VS Code's pickers, and the answer goes back through the controller", async () => {
  const form: FormRequest = {
    id: "frm_glue",
    sessionID: "ses_glue",
    title: "Go on?",
    fields: [{ key: "go", type: "boolean", title: "Go on?" }],
  }
  chat().apply({ type: "form", form })
  await Bun.sleep(50)
  expect(picks.at(-1)?.[0]).toEqual(["Yes", "No"])
  expect(answered).toEqual([[form, { go: true }]])
})

test("a review tab moved to another group or window answers nothing, and closing it there replies once", async () => {
  const [, , , title] = await open("per_moved")
  const tab = tabs.find((entry) => entry.label === title)!
  // VS Code moves a tab by opening it in the other group and then closing it in this one.
  const there = { ...tab }
  moved.push(there)
  for (const listener of listeners) listener({ opened: [there], changed: [], closed: [] })
  tabs.splice(tabs.indexOf(tab), 1)
  for (const listener of listeners) listener({ opened: [], changed: [], closed: [tab] })
  await Bun.sleep(50)
  // Should the close be reported before the tab shows in its new group, it still answers nothing.
  moved.splice(moved.indexOf(there), 1)
  for (const listener of listeners) listener({ opened: [], changed: [], closed: [there] })
  moved.push(there)
  for (const listener of listeners) listener({ opened: [there], changed: [], closed: [] })
  await Bun.sleep(50)
  expect(replies).toEqual([])
  // The person closes it in its new group: that answers, once.
  await fire(title)
  await fire(title)
  expect(replies).toEqual([["per_moved", "once", undefined]])
})

test("an auto save of a review answers nothing, and a save by the person replies once with its text", async () => {
  const [, , right] = await open("per_autosave")
  const willSave = (target: Uri, reason: number) => saving.forEach((listener) => listener({ document: { uri: target }, reason }))
  // VS Code's own auto save, after a delay or when the editor loses focus, hands the review a draft.
  for (const reason of [reasons.AfterDelay, reasons.FocusOut]) {
    willSave(right, reason)
    await system().writeFile(right, new TextEncoder().encode("half\n"), { create: false, overwrite: true })
  }
  expect(replies).toEqual([])
  expect(new TextDecoder().decode(system().readFile(right) as Uint8Array)).toBe("half\n")
  // A manual save of another document, even one at the same path, says nothing about the review's.
  willSave(right, reasons.AfterDelay)
  willSave(uri({ scheme: "file", path: right.path }), reasons.Manual)
  await system().writeFile(right, new TextEncoder().encode("still\n"), { create: false, overwrite: true })
  expect(replies).toEqual([])
  willSave(right, reasons.Manual)
  await system().writeFile(right, new TextEncoder().encode("mine\n"), { create: false, overwrite: true })
  expect(replies).toEqual([["per_autosave", "once", "mine\n"]])

  // Accept saves unsaved edits as the person's own save, whatever VS Code last said about the document.
  const [, , accepted] = await open("per_autoaccept")
  willSave(accepted, reasons.AfterDelay)
  documents.push({
    uri: accepted,
    isDirty: true,
    save: async () => {
      await system().writeFile(accepted, new TextEncoder().encode("accepted\n"), { create: false, overwrite: true })
      return true
    },
  })
  await commands.get("orbit.review.accept")!(accepted)
  expect(replies.at(-1)).toEqual(["per_autoaccept", "once", "accepted\n"])
})

test("a save that answers succeeds and its tab closes without a prompt", async () => {
  const [, , right, title] = await open("per_save_closes")
  const document = editing(right, "mine\n")
  expect(await document.save()).toBe(true)
  await Bun.sleep(50)
  expect(replies).toEqual([["per_save_closes", "once", "mine\n"]])
  expect(document.isDirty).toBe(false)
  expect(prompts).toEqual([])
  expect(closing.map((tab) => tab.label)).toContain(title)
  expect(tabs.some((tab) => tab.label === title)).toBe(false)
  // Once VS Code reported the tab closed, its sides are gone, and so are the folders above them.
  expect(() => system().stat(right)).toThrow()
  expect(() => system().stat(uri({ scheme: "orbit-review", path: path.posix.dirname(right.path) }))).toThrow()
})

test("a question answered elsewhere while its tab has unsaved edits closes the tab without a prompt", async () => {
  const [, , right, title] = await open("per_edited_elsewhere")
  const document = editing(right, "edited\n")
  // While the tab is open, the folders above its side are folders.
  expect(system().stat(uri({ scheme: "orbit-review", path: path.posix.dirname(right.path) }))).toMatchObject({ type: 2 })
  chat().apply({ type: "item", item: { ...question, status: "once" } })
  await Bun.sleep(50)
  expect(document.isDirty).toBe(false)
  expect(prompts).toEqual([])
  expect(closing.map((tab) => tab.label)).toContain(title)
  expect(replies).toEqual([])
})

test("Open diff on a question open for review brings its tab forward in its own group and opens no second one", async () => {
  const [, left, right, title] = await open("per_reveal")
  // The person moved the tab to the other group.
  const tab = tabs.find((entry) => entry.label === title)!
  tabs.splice(tabs.indexOf(tab), 1)
  moved.push(tab)
  const before = executed.length
  await chat().receive({ type: "diff", id: question.id })
  expect(executed.slice(before)).toEqual([["vscode.diff", left, right, title, { viewColumn: 2, preview: false }]])
  expect([...tabs, ...moved].filter((entry) => entry.label === title)).toHaveLength(1)
  // A tab VS Code no longer shows is not opened again.
  moved.splice(moved.indexOf(tab), 1)
  await chat().receive({ type: "diff", id: question.id })
  expect(executed.length).toBe(before + 1)
  await fire(title)
  expect(replies).toEqual([["per_reveal", "once", undefined]])
})

test("closing Orbit tabs saves the unsaved edits of a review's own side and of no other document", async () => {
  question = permissionItem({
    id: "per_preview_dirty",
    sessionID: "ses_glue",
    action: "Edit",
    resources: ["glue.txt"],
    revisable: false,
    metadata: { files: [{ file: "glue.txt", place: file, patch }] },
  })
  await chat().receive({ type: "diff", id: question.id })
  const [, , preview, title] = lastDiff()
  expect(preview.scheme).toBe("orbit-proposed")
  // VS Code keeps such a side read-only; were its document ever dirty, the extension still would not save it.
  const document = { uri: preview, isDirty: true, save: async () => (saved.push(preview.path), true) }
  documents.push(document)
  await chat().send("after the preview")
  await Bun.sleep(50)
  expect(saved).not.toContain(preview.path)
  document.isDirty = false
  await fire(title)
  expect(replies).toEqual([])
})

// Last of the review rows: the review is disposed from here on.
test("a tab closed while the extension closes it, or after deactivate, replies nothing", async () => {
  const [, , right, settled] = await open("per_settled")
  // Unsaved edits are handed to the review before the tab closes, so VS Code does not ask; the review answers nothing.
  editing(right, "edited\n")
  // The question is answered elsewhere: the extension closes its tab, and that close answers nothing.
  chat().apply({ type: "item", item: { ...question, status: "once" } })
  await Bun.sleep(50)
  expect(closing.map((tab) => tab.label)).toContain(settled)
  expect(saved).toContain(right.path)
  expect(prompts).toEqual([])
  await fire(settled)

  const [, , , last] = await open("per_deactivated")
  extension.deactivate()
  await fire(last)
  expect(replies).toEqual([])
})

test("the chat starts the orb the person configured, connects to the endpoint it prints, and draws what its controller says", async () => {
  // A stand-in service that knows no route, so the controller cannot read the folder's trust and sends nothing.
  const requests: Array<{ path: string; authorization: string | null }> = []
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
      return new Response("Not Found", { status: 404 })
    },
  })
  const endpoint = { url: `http://127.0.0.1:${service.port}`, auth: { type: "basic", username: "orbit", password: "glue" } }
  // A compiled `orb`, so Windows can start it too: it prints a version, and the endpoint as `orb service start --json` does.
  const bin = path.join(folder, "bin")
  await fs.mkdir(bin, { recursive: true })
  program.path = path.join(bin, process.platform === "win32" ? "orb.exe" : "orb")
  const built = await Bun.build({
    entrypoints: ["/orb.ts"],
    files: {
      "/orb.ts": `console.log(process.argv.includes("--version") ? "orb v0.0.0-glue" : ${JSON.stringify(JSON.stringify(endpoint))})`,
    },
    compile: { outfile: program.path, autoloadBunfig: false, autoloadDotenv: false },
  })
  expect(built.success).toBe(true)
  chat().controller = undefined
  try {
    await chat().send("hello")
    expect(await chat().controller).toBeDefined()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.authorization === `Basic ${btoa("orbit:glue")}`)).toBe(true)
    // The controller's note reached the chat's own list, which is what the panel draws.
    expect(chat().items.some((entry) => entry.type === "note" && entry.text.includes("hello"))).toBe(true)
  } finally {
    const controller = (await chat().controller) as { dispose(): void } | undefined
    controller?.dispose()
    await service.stop(true)
  }
}, 60_000)
