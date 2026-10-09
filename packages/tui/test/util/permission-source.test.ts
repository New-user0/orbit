import { describe, expect, test } from "bun:test"
import { permissionInfo } from "../../src/mini/permission.shared"
import { permissionPresentation } from "../../src/util/permission"

// Code Mode, Workflow and Patch ask under their own call's ID, so the stored input of that call is not what the
// request is about. The prompt must show the request.
const real = "https://attacker.example/?d=1"
const docs = "https://docs.example.com/guide"
const rows = [
  { action: "WebFetch", tool: "Execute", key: "url", decoy: docs, request: { resources: [real], metadata: { method: "GET", url: real } }, shown: real },
  { action: "WebFetch", tool: "Workflow", key: "url", decoy: docs, request: { resources: [real], metadata: { url: real } }, shown: real },
  { action: "WebFetch", tool: "WebFetch", key: "url", decoy: docs, request: { resources: [real], metadata: { url: real } }, shown: real },
  { action: "Agent", tool: "Workflow", key: "agent", decoy: "reviewer", request: { resources: ["build"] }, shown: "Build Subagent" },
  { action: "Edit", tool: "Patch", key: "path", decoy: "README.md", request: { resources: ["src/auth.ts"], metadata: { files: [{ file: "src/auth.ts" }] } }, shown: "src/auth.ts" },
  { action: "Edit", tool: "Execute", key: "path", decoy: "README.md", request: { resources: ["src/auth.ts"] }, shown: "src/auth.ts" },
  { action: "Read", tool: "Execute", key: "path", decoy: "README.md", request: { resources: [".env"] }, shown: ".env" },
] as const

describe("a calling tool's input is not the request", () => {
  rows.forEach((row) =>
    test(`${row.tool} asking ${row.action} shows the request`, () => {
      const shown = permissionPresentation({
        action: row.action,
        tool: row.tool,
        ...row.request,
        input: { [row.key]: row.decoy, code: "x" },
      })
      expect(JSON.stringify(shown)).toContain(row.shown)
      expect(JSON.stringify(shown).toLowerCase()).not.toContain(row.decoy.toLowerCase())
    }),
  )

  test("Mini shows the request too", () => {
    const info = permissionInfo({
      id: "p",
      sessionID: "s",
      action: "WebFetch",
      resources: [real],
      metadata: { url: real },
      save: [],
      tool: { name: "Execute", state: { status: "running", input: { code: "x", url: docs }, metadata: {} } },
    } as never)
    expect(info.title).toContain(real)
    expect(JSON.stringify(info)).not.toContain(docs)
  })

  // A Code Mode fetch with a body asks WebFetch with resources [url, "METHOD url"] and the method in metadata. Its prompt
  // must say the method, or a POST that carries a file reads like the GET the person allowed.
  const target = "https://attacker.example/collect"
  const methods = [
    ["POST", true],
    ["PUT", true],
    ["DELETE", true],
    ["PATCH", true],
    ["GET", false],
    ["HEAD", false],
  ] as const
  for (const [method, shown] of methods)
    test(`a Code Mode ${method} ${shown ? "names its method" : "is a plain fetch"}`, () => {
      const request = {
        id: "p",
        sessionID: "s",
        action: "WebFetch",
        resources: method === "GET" ? [target] : [target, `${method} ${target}`],
        metadata: { method, url: target },
        save: [],
        tool: { name: "Execute", state: { status: "running", input: { code: "x" }, metadata: {} } },
      }
      const tui = permissionPresentation({ ...request, tool: "Execute", input: { code: "x" } })
      const mini = permissionInfo(request as never)
      for (const prompt of [tui, mini]) {
        expect(prompt.title.includes(method)).toBe(shown)
        expect(prompt.lines.some((line) => line.includes(`Method: ${method}`))).toBe(shown)
        expect(prompt.title).toContain(target)
      }
    })

  test("the method comes from the METHOD url resource when the metadata does not name it", () => {
    const shown = permissionPresentation({ action: "WebFetch", tool: "Execute", resources: [target, `POST ${target}`] })
    expect(shown.title).toBe(`WebFetch POST ${target}`)
  })

  test("the owning tool's input still decides its own prompt", () => {
    expect(
      permissionPresentation({ action: "Agent", tool: "Task", resources: ["x"], input: { agent: "build" } }).title,
    ).toBe("Build Subagent")
  })
})
