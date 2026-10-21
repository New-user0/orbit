import { describe, expect, test } from "bun:test"
import { rawRequest, render, resolveOperation } from "./api"

describe("api response printing", () => {
  const response = (file: string) => JSON.stringify({ data: { status: { files: [{ path: file, kind: "project" }] } } })

  test("writes out the controls a path can carry and still parses as the same JSON", () => {
    const file = "/repo/\u009b2J‮evil/ORBIT.md"
    const printed = render(response(file))

    expect(printed).not.toContain("\u009b")
    expect(printed).not.toContain("‮")
    expect(printed).toContain("\\u009b")
    expect(printed).toContain("\\u202e")
    expect(JSON.parse(printed).data.status.files[0].path).toBe(file)
  })

  test("prints a plain response as the same JSON", () => {
    const text = response("/repo/ORBIT.md")

    expect(JSON.parse(render(text))).toEqual(JSON.parse(text))
    expect(render(text)).not.toContain("\\u")
  })

  test("prints a body that is not JSON as message text, line breaks kept", () => {
    expect(render("data: a\u009b\nid: 1")).toBe("data: a\\x9b\nid: 1")
    expect(render("")).toBe("")
  })
})

describe("api request resolution", () => {
  test("resolves an operation ID with path and query parameters", () => {
    expect(
      resolveOperation(
        {
          paths: {
            "/api/session/{sessionID}": {
              get: { operationId: "session.get" },
            },
          },
        },
        "session.get",
        { sessionID: "ses/a", workspace: "work" },
      ),
    ).toEqual({ method: "GET", path: "/api/session/ses%2Fa?workspace=work" })
  })

  test("rejects a missing path parameter", () => {
    expect(() =>
      resolveOperation(
        { paths: { "/api/session/{sessionID}": { get: { operationId: "session.get" } } } },
        "session.get",
        {},
      ),
    ).toThrow("Missing path parameter: sessionID")
  })

  test("resolves curl-like method and path input", () => {
    expect(rawRequest(["post", "/api/foo"])).toEqual({ method: "POST", path: "/api/foo" })
    expect(rawRequest(["session.list"])).toBeUndefined()
  })
})
