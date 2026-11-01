import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permissionItem } from "../src/controller"
import type { FromView, Item } from "../src/protocol"

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
const documents: Array<{ uri: Uri; isDirty: boolean; save(): Promise<boolean> }> = []
const saved: string[] = []
const listeners: Array<(event: { opened: unknown[]; changed: unknown[]; closed: Tab[] }) => void> = []
const providers = new Map<string, unknown>()
// What the next modal question is answered with: the button the person picks, by its title.
const answer: { title?: string } = {}

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
    tabGroups: stub({
      get all() {
        return [{ tabs }]
      },
      close: async (closed: Tab[]) => {
        closing.push(...closed)
        for (const tab of closed) tabs.splice(tabs.indexOf(tab), 1)
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
      if (args[0] === "vscode.diff")
        tabs.push({ label: String(args[3]), input: new TabInputTextDiff(args[1] as Uri, args[2] as Uri) })
    },
  }),
  workspace: stub({
    textDocuments: documents,
    workspaceFolders: [{ uri: { scheme: "file", fsPath: folder } }, { uri: { scheme: "vscode-remote", fsPath: "/x" } }],
    registerFileSystemProvider: (scheme: string, provider: Record<string, (...args: unknown[]) => unknown>) => {
      filesystems.set(scheme, provider)
      return stub()
    },
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) => {
      contents.set(scheme, provider)
      return stub()
    },
    getConfiguration: () =>
      stub({ inspect: () => ({ globalValue: false }), get: (_: string, fallback: unknown) => fallback }),
  }),
})

// The chat's private parts that the glue goes through.
type Chat = {
  controller: Promise<unknown> | undefined
  panel: unknown
  receive(message: FromView): Promise<unknown>
  apply(update: { type: "item"; item: Item }): void
  send(text: string): Promise<void>
}
type Extension = typeof import("../src/extension")
let extension: Extension
const replies: unknown[][] = []
const sent: string[] = []
const marked: string[] = []
const restored: Array<{ messageID: string; confirmed: boolean }> = []
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
    reviewing: (id: string) => void marked.push(id),
    note: () => {},
    send: async (text: string) => void sent.push(text),
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
})

afterAll(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const chat = () => providers.get("orbit.chat") as Chat
const fire = async (label: string) => {
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
  await commands.get("orbit.review.reject")!(rejected)
  expect(replies.at(-1)).toEqual(["per_reject", "reject", undefined])
  // Only the review's own documents.
  await commands.get("orbit.review.accept")!(uri({ scheme: "file", path: file }))
  await commands.get("orbit.review.reject")!(uri({ scheme: "file", path: file }))
  expect(replies).toHaveLength(2)
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
  await fire(title)
  expect(replies).toEqual([])
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
  expect(view[1]).toBe("Orbit: changes in this prompt (1 file)")
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

test("a tab closed while the extension closes it, or after deactivate, replies nothing", async () => {
  const [, , right, settled] = await open("per_settled")
  // Unsaved edits are handed to the review before the tab closes, so VS Code does not ask; the review answers nothing.
  documents.push({
    uri: right,
    isDirty: true,
    save: async () => {
      saved.push(right.path)
      await system().writeFile(right, new TextEncoder().encode("edited\n"), { create: false, overwrite: true })
      return true
    },
  })
  // The question is answered elsewhere: the extension closes its tab, and that close answers nothing.
  chat().apply({ type: "item", item: { ...question, status: "once" } })
  await Bun.sleep(50)
  expect(closing.map((tab) => tab.label)).toContain(settled)
  expect(saved).toContain(right.path)
  await fire(settled)

  const [, , , last] = await open("per_deactivated")
  extension.deactivate()
  await fire(last)
  expect(replies).toEqual([])
})
