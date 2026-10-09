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

  test("the owning tool's input still decides its own prompt", () => {
    expect(
      permissionPresentation({ action: "Agent", tool: "Task", resources: ["x"], input: { agent: "build" } }).title,
    ).toBe("Build Subagent")
  })
})
