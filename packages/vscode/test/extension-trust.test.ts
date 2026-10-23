import { beforeAll, expect, mock, test } from "bun:test"
import type { TrustView } from "../src/protocol"

// The extension runs in the editor's host, which gives it the `vscode` module. The test gives it a stand-in in which
// every call answers with another stand-in, except the few the trust indicator is read from: the status bar items, which
// keep what is set on them, and the commands, which record what they were called with. The IDE bridge setting is off,
// so activating starts no listener and writes no lock file.
type Item = { tooltip?: string; shown: boolean; show(): void; hide(): void; dispose(): void }
const items: { priority: number; item: Item }[] = []
const executed: unknown[][] = []
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

const vscode = stub({
  window: stub({
    activeTextEditor: undefined,
    createStatusBarItem: (_: unknown, priority: number) => {
      const item: Item = {
        shown: false,
        show() {
          item.shown = true
        },
        hide() {
          item.shown = false
        },
        dispose() {},
      }
      items.push({ priority, item })
      return item
    },
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      providers.set(id, provider)
      return stub()
    },
  }),
  commands: stub({
    executeCommand: async (...args: unknown[]) => void executed.push(args),
  }),
  workspace: stub({
    textDocuments: [],
    workspaceFolders: [],
    getConfiguration: () => stub({ inspect: () => ({ globalValue: false }), get: (_: string, fallback: unknown) => fallback }),
  }),
})

const indicator = () => items.find((entry) => entry.priority === 101)!.item

// What the chat does with a trust update from the controller; it is private to the extension.
type Chat = { trusting(update: { type: "trust"; trust: TrustView | undefined }): void }

beforeAll(async () => {
  mock.module("vscode", () => ({ default: vscode }))
  const extension = await import("../src/extension")
  extension.activate(stub({ subscriptions: [] }) as Parameters<typeof extension.activate>[0])
})

test("the untrusted indicator says that nothing of the folder loads, and offers the trust command", () => {
  const chat = providers.get("orbit.chat") as Chat
  chat.trusting({
    type: "trust",
    trust: { directory: "/work/clone", persistent: true, summary: "", held: [] },
  })
  expect(indicator().shown).toBe(true)
  expect(indicator().tooltip).toBe("Orbit loads nothing from /work/clone until you trust it. Select to review.")
  expect(executed).toContainEqual(["setContext", "orbit.untrusted", true])
})

test("a trusted folder hides the indicator and withdraws the trust command", () => {
  const chat = providers.get("orbit.chat") as Chat
  chat.trusting({ type: "trust", trust: undefined })
  expect(indicator().shown).toBe(false)
  expect(executed.at(-1)).toEqual(["setContext", "orbit.untrusted", false])
})
