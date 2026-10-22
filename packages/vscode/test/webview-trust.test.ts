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
  addEventListener() {}
  setAttribute() {}
  contains() {
    return false
  }
  querySelector() {
    return null
  }
}

const listeners: ((event: { data: unknown }) => void)[] = []
const body = new Node("body")
const saved = { setInterval: globalThis.setInterval }
const timers: ReturnType<typeof setInterval>[] = []

beforeAll(async () => {
  Object.assign(globalThis, {
    acquireVsCodeApi: () => ({ postMessage() {} }),
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
  for (const name of ["acquireVsCodeApi", "document", "window"]) Reflect.deleteProperty(globalThis, name)
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
  expect(note!.textContent).toBe("Orbit is leaving out what could run code or reach the network: .")
  expect(banner().textContent).not.toContain("Changed")
  expect(banner().textContent).not.toContain("changed since you trusted it")
  expect(banner().textContent).not.toContain("stays off")
})

test("the webview's banner goes once the folder is trusted", () => {
  send(undefined)
  expect(banner().hidden).toBe(true)
  expect(banner().children).toEqual([])
})
