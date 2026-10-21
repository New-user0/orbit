import { describe, expect, test } from "bun:test"
import { makeSession, rpcError, startWire } from "./wire-fixture"

// trust-first over the wire, in this process: the editor picks the folder of each ACP session, and no session opens in a
// folder that is not trusted (class 12). `trust-first.subprocess.test.ts` runs the same doors against a real server; these
// pin how the agent carries the refusal to the editor: a JSON-RPC error whose data says what it is and names the folder,
// so the editor can tell it from a failure (class 13).
const refusal = {
  _tag: "UntrustedFolderError",
  directory: "/workspace",
  persistent: true,
  message: "/workspace is not trusted. Trust it with `orb trust`, or start `orb` there and answer the question.",
}

describe("acp trust-first over the wire", () => {
  test("session/new carries the server's refusal of an untrusted folder to the editor as a typed error", async () => {
    await using acp = await startWire({
      fetch: (request) =>
        request.method === "POST" && request.path === "/api/session"
          ? Response.json(refusal, { status: 403 })
          : undefined,
    })
    await acp.initialize()

    const error = await rpcError(acp.request("session/new", { cwd: "/workspace", mcpServers: [] }))

    expect(error).toMatchObject({
      code: -32600,
      data: { type: "untrusted_folder", directory: "/workspace", persistent: true },
    })
    expect(error.message).toContain("/workspace is not trusted")
    expect(acp.server.sessions.size).toBe(0)
  })

  test("session/load and session/resume ask about the session's own folder and open nothing in one that is not trusted", async () => {
    const asked: string[] = []
    await using acp = await startWire({
      fetch: (request) => {
        if (request.path !== "/api/location/trust") return undefined
        asked.push(request.query["location[directory]"] ?? "")
        return Response.json({
          directory: "/projects/app\u001b]0;owned\u0007",
          trusted: false,
          persistent: false,
          withheld: [],
          changed: [],
        })
      },
    })
    acp.server.sessions.set("ses_saved", makeSession("ses_saved"))
    await acp.initialize()

    for (const method of ["session/load", "session/resume"] as const) {
      const before = acp.server.requests.length
      const error = await rpcError(acp.request(method, { cwd: "/workspace", sessionId: "ses_saved", mcpServers: [] }))
      expect({ method, error }).toMatchObject({
        method,
        error: {
          code: -32600,
          data: { type: "untrusted_folder", directory: "/projects/app\u001b]0;owned\u0007", persistent: false },
        },
      })
      // The folder's name reaches the editor's text without what would act on a terminal (class 9).
      expect(error.message).toContain("/projects/app")
      expect(error.message).toContain("is not trusted")
      expect(error.message).not.toContain("\u001b")
      // Nothing was attached or replayed after the answer.
      const after = acp.server.requests.slice(before)
      expect(after.at(-1)?.path).toBe("/api/location/trust")
    }
    // Each asked about the folder the saved session works in.
    expect(asked).toEqual(["/workspace", "/workspace"])
  })

  test("session/load opens a session in a trusted folder: the control for the row above", async () => {
    await using acp = await startWire()
    acp.server.sessions.set("ses_saved", makeSession("ses_saved"))
    await acp.initialize()

    await acp.request("session/load", { cwd: "/workspace", sessionId: "ses_saved", mcpServers: [] })
    expect(acp.server.requests.some((request) => request.path === "/api/location/trust")).toBe(true)
  })
})
