import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permissionItem } from "../src/controller"
import type { FromView, Item } from "../src/protocol"

// The glue between the review (`src/review.ts`) and VS Code, which cannot run under Bun. As in `extension-trust.test.ts`
// the extension gets a stand-in `vscode` in which every call answers with another stand-in, except the calls the review
// makes: the file system it registers, the diff it opens, the tabs it closes and the warning it shows, which are written
// down. The chat's controller is a stand-in too, which records the replies the extension sends (class 12).
const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-glue-")))
const file = path.join(folder, "glue.txt")
const patch = createTwoFilesPatch("glue.txt", "glue.txt", "one\n", "two\n")

const filesystems = new Map<string, unknown>()
const executed: unknown[][] = []
const warnings: unknown[][] = []
const closing: unknown[] = []
const tabs: Array<{ label: string }> = []
const listeners: Array<(event: { opened: unknown[]; changed: unknown[]; closed: Array<{ label: string }> }) => void> = []
const providers = new Map<string, unknown>()

const stub = (overrides: Record<string, unknown> = {}): unknown =>
  new Proxy(function () {}, {
    get: (_, key) => {
      if (typeof key === "symbol" || key === "then") return undefined
      return key in overrides ? overrides[key] : stub()
    },
    apply: () => stub(),
    construct: () => stub() as object,
  })

const uri = (parts: { scheme: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` })

const vscode = stub({
  Uri: stub({ from: uri, file: (fsPath: string) => ({ ...uri({ scheme: "file", path: fsPath }), fsPath }) }),
  window: stub({
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      providers.set(id, provider)
      return stub()
    },
    showWarningMessage: async (...args: unknown[]) => void warnings.push(args),
    tabGroups: stub({
      get all() {
        return [{ tabs }]
      },
      close: async (closed: Array<{ label: string }>) => {
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
    executeCommand: async (...args: unknown[]) => {
      executed.push(args)
      if (args[0] === "vscode.diff") tabs.push({ label: String(args[3]) })
    },
  }),
  workspace: stub({
    textDocuments: [],
    workspaceFolders: [{ uri: { scheme: "file", fsPath: folder } }],
    registerFileSystemProvider: (scheme: string, provider: unknown) => {
      filesystems.set(scheme, provider)
      return stub()
    },
    getConfiguration: () =>
      stub({ inspect: () => ({ globalValue: false }), get: (_: string, fallback: unknown) => fallback }),
  }),
})

// The chat's private parts that the glue goes through.
type Chat = {
  controller: Promise<unknown> | undefined
  receive(message: FromView): Promise<unknown>
  apply(update: { type: "item"; item: Item }): void
}
type Extension = typeof import("../src/extension")
let extension: Extension
const replies: unknown[][] = []
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
  const chat = providers.get("orbit.chat") as Chat
  chat.controller = Promise.resolve({
    permission: (id: string) => (id === question.id ? question : undefined),
    reply: async (...args: unknown[]) => {
      replies.push(args)
      return "sent"
    },
    folders: async () => ({ folders: [folder] }),
    reviewing: () => {},
    note: () => {},
  })
})

afterAll(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const chat = () => providers.get("orbit.chat") as Chat
const fire = async (label: string) => {
  for (const listener of listeners) listener({ opened: [], changed: [], closed: [{ label }] })
  await Bun.sleep(50)
}

test("the extension registers the review file system, opens the diff with the request's sides and title, and a tab the person closes replies once", async () => {
  expect([...filesystems.keys()]).toEqual(["orbit-review"])
  await chat().receive({ type: "diff", id: question.id })
  const diff = executed.find((call) => call[0] === "vscode.diff")!
  expect(diff).toBeDefined()
  const [, left, right, title] = diff as [string, { scheme: string; path: string }, { scheme: string; path: string }, string]
  expect(left.scheme).toBe("orbit-proposed")
  expect(right.scheme).toBe("orbit-review")
  expect(title).toMatch(/^Orbit: glue\.txt \([a-z0-9]{6}\)$/)
  // The writable side holds the proposal, from the file system the extension registered.
  const system = filesystems.get("orbit-review") as { readFile(uri: unknown): Uint8Array }
  expect(new TextDecoder().decode(system.readFile(right))).toBe("two\n")

  await fire(title)
  await fire(title)
  expect(replies).toEqual([["per_glue", "once", undefined]])
})

test("the changed-since-read warning is shown without the file name", async () => {
  question = item("per_changed", createTwoFilesPatch("glue.txt", "glue.txt", "else\n", "two\n"))
  const before = executed.length
  await chat().receive({ type: "diff", id: question.id })
  expect(executed.slice(before).filter((call) => call[0] === "vscode.diff")).toEqual([])
  expect(warnings).toHaveLength(1)
  expect(String(warnings[0]?.[0])).not.toContain("glue")
  expect(String(warnings[0]?.[0])).toContain("changed since the agent read it")
})

test("a tab closed while the extension closes it, or after deactivate, replies nothing", async () => {
  replies.length = 0
  question = item("per_settled", patch)
  await chat().receive({ type: "diff", id: question.id })
  const settled = String(executed.findLast((call) => call[0] === "vscode.diff")?.[3])
  // The question is answered elsewhere: the extension closes its tab, and that close answers nothing.
  chat().apply({ type: "item", item: { ...question, status: "once" } })
  await Bun.sleep(50)
  expect(closing).toContainEqual({ label: settled })
  await fire(settled)

  question = item("per_deactivated", patch)
  await chat().receive({ type: "diff", id: question.id })
  const last = String(executed.findLast((call) => call[0] === "vscode.diff")?.[3])
  extension.deactivate()
  await fire(last)
  expect(replies).toEqual([])
})
