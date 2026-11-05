import { afterAll, beforeAll, expect, test } from "bun:test"
import type { TrustView } from "../src/protocol"

// The webview runs in the editor's browser, so the test gives it the few document calls it makes and reads the banner
// it draws for a trust answer. Each node keeps its children and text; everything else it is asked to do is a no-op.
class Node {
  children: Node[] = []
  className = ""
  hidden = false
  own: string | undefined
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.own ?? this.children.map((child) => child.textContent).join(" ")
  }
  set textContent(text: string) {
    this.own = text
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: Node[]) {
    this.children = nodes
  }
  remove() {}
  replaceWith() {}
  handlers = new Map<string, () => void>()
  addEventListener(type: string, handler: () => void) {
    this.handlers.set(type, handler)
  }
  setAttribute() {}
  contains() {
    return false
  }
  querySelector() {
    return null
  }
}

const listeners: ((event: { data: unknown }) => void)[] = []
const posted: unknown[] = []
const body = new Node("body")
const saved = { setInterval: globalThis.setInterval }
const timers: ReturnType<typeof setInterval>[] = []

beforeAll(async () => {
  Object.assign(globalThis, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => void posted.push(message) }),
    document: {
      body,
      getElementById: () => null,
      createElement: (tag: string) => new Node(tag),
      createTextNode: (text: string) => Object.assign(new Node("#text"), { own: text }),
      addEventListener() {},
      querySelectorAll: () => [],
    },
    window: { addEventListener: (_: string, listener: (event: { data: unknown }) => void) => listeners.push(listener) },
    // The spinner's timer is kept so that it can be stopped when the file is done.
    setInterval: (handler: () => void, ms: number) => {
      const timer = saved.setInterval(handler, ms)
      timers.push(timer)
      return timer
    },
  })
  await import("../src/webview/main")
  globalThis.setInterval = saved.setInterval
})

// Other files can share this process, so the page's globals go with this one.
afterAll(() => {
  for (const timer of timers) clearInterval(timer)
  Object.assign(globalThis, { acquireVsCodeApi: undefined, document: undefined, window: undefined })
})

const banner = () => body.children.find((node) => node.className === "trust")!
const send = (trust: TrustView | undefined) => {
  for (const listener of listeners) listener({ data: { type: "trust", trust } })
}

test("the webview's banner calls a folder that is not trusted untrusted, and never changed", () => {
  send({ directory: "/work/repo", persistent: true, summary: "", held: [] })
  expect(banner().hidden).toBe(false)
  const [head, note] = banner().children
  expect(head!.children.map((node) => node.textContent)).toEqual(["⊙ Untrusted", "/work/repo"])
  // Nothing of the folder is read, so the banner says so instead of an empty list of what it leaves out.
  expect(note!.textContent).toBe("Nothing in this folder loads, and no work starts here, until you trust it.")
  expect(banner().textContent).not.toContain("held back")
  expect(banner().textContent).not.toContain("leaving out")
  expect(banner().textContent).not.toContain("Changed")
  expect(banner().textContent).not.toContain("changed since you trusted it")
  expect(banner().textContent).not.toContain("stays off")
})

test("the webview's banner goes once the folder is trusted", () => {
  send(undefined)
  expect(banner().hidden).toBe(true)
  expect(banner().children).toEqual([])
})

const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)]
const item = (value: unknown) => {
  for (const listener of listeners) listener({ data: { type: "item", item: value } })
}

test("a prompt with a message ID offers its changes and a restore, and one without offers neither", () => {
  item({ type: "user", id: "user:sent", text: "make it so", messageID: "msg_sent" })
  item({ type: "user", id: "user:waiting", text: "not admitted yet" })
  const [sent, waiting] = all(body)
    .filter((node) => node.className === "user")
    .slice(-2)
  const links = all(sent!).filter((node) => node.className === "link")
  expect(links.map((node) => node.textContent)).toEqual(["View changes", "Restore files"])
  posted.length = 0
  links.forEach((node) => node.handlers.get("click")?.())
  expect(posted).toEqual([
    { type: "changes", messageID: "msg_sent" },
    { type: "restore", messageID: "msg_sent" },
  ])
  expect(all(waiting!).filter((node) => node.className === "user-actions")).toEqual([])
})

test("a card under review says how to answer in the editor, and an answered one says whose version was allowed", () => {
  const card = {
    type: "permission",
    sessionID: "ses_view",
    action: "Edit",
    resources: ["a.txt"],
    canSave: true,
    view: { places: ["/p/a.txt"] },
    files: [{ file: "a.txt", place: "/p/a.txt", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
    revisable: true,
  }
  item({ ...card, id: "per_reviewing", status: "pending", reviewing: true })
  item({ ...card, id: "per_revised", status: "once", revised: true })
  item({ ...card, id: "per_plain", status: "once" })
  // A pending card whose review tab closed unanswered is unmarked, and says nothing about the editor.
  item({ ...card, id: "per_unmarked", status: "pending", reviewing: false })
  const text = all(body).map((node) => node.own ?? "")
  expect(
    text.filter(
      (line) => line === "Opened in the editor: save to accept your version, close to accept as proposed, or Reject.",
    ),
  ).toHaveLength(1)
  expect(text.filter((line) => line.startsWith("Allowed with your changes · "))).toHaveLength(1)
  expect(text.filter((line) => line.startsWith("Allowed · "))).toHaveLength(1)
})
