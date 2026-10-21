import { expect, test } from "bun:test"
import { ClientError, isUntrustedFolderError, Orbit, type SessionImportInput } from "../src/promise/index"

// trust-first: every route that starts work in a folder answers 403 with `UntrustedFolderError` while the folder is not
// trusted, and the client hands that refusal to its caller as the typed error it is, with the folder to trust (class 13),
// not as an unexpected status. A route that does not declare the refusal still reports a 403 as unexpected: the control.
const refusal = {
  _tag: "UntrustedFolderError",
  directory: "/projects/app",
  persistent: true,
  message: "/projects/app is not trusted. Trust it with `orb trust`, or start `orb` there and answer the question.",
}
const client = Orbit.make({
  baseUrl: "http://localhost:3000",
  fetch: async () => Response.json(refusal, { status: 403 }),
})
const sessionID = "ses_test"
const location = { directory: "/projects/app" }

test.each([
  ["session.create", () => client.session.create({ location })],
  ["session.fork", () => client.session.fork({ sessionID })],
  ["session.move", () => client.session.move({ sessionID, directory: "/projects/app" })],
  ["session.prompt", () => client.session.prompt({ sessionID, text: "hello" })],
  ["session.command", () => client.session.command({ sessionID, name: "review", text: "" })],
  ["session.skill", () => client.session.skill({ sessionID, id: "skill" })],
  ["session.synthetic", () => client.session.synthetic({ sessionID, text: "hello" })],
  ["session.shell", () => client.session.shell({ sessionID, command: "ls" })],
  ["session.compact", () => client.session.compact({ sessionID })],
  [
    "session.import",
    // The server refuses before it reads the session, so an empty record stands in for one.
    () => client.session.import({ info: {} as SessionImportInput["info"], messages: [], location }),
  ],
  ["session.update", () => client.session.update({ sessionID, title: "" })],
  ["session.generate", () => client.session.generate({ sessionID, prompt: "hello" })],
  ["session.instructions.preview", () => client.session.instructions.preview({ sessionID })],
  ["shell.create", () => client.shell.create({ location, command: "ls" })],
  [
    "persistentPty.create",
    () => client.experimental.persistentPty.create({ sessionID, args: [], title: "Terminal", env: {} }),
  ],
  ["pty.create", () => client.pty.create({ location })],
  ["mcp.connect", () => client.mcp.connect({ server: "docs", location })],
  ["fs.write", () => client.file.write({ location, path: "a.txt", payload: new TextEncoder().encode("a") })],
  ["worktree.create", () => client.worktree.create({ projectID: "prj_test" })],
  ["worktree.remove", () => client.worktree.remove({ projectID: "prj_test", directory: "/projects/app-wt" })],
  ["worktree.refresh", () => client.worktree.refresh({ projectID: "prj_test" })],
  ["instruction.note.add", () => client.location.instruction.note.add({ location, scope: "project", text: "note" })],
] as const)("%s hands a refusal of an untrusted folder to the caller as UntrustedFolderError", async (_, call) => {
  const error: unknown = await call().then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(isUntrustedFolderError(error)).toBe(true)
  expect(error).toMatchObject(refusal)
})

test("a route that does not declare the refusal reports a 403 as an unexpected status: the control", async () => {
  const error: unknown = await client.session.get({ sessionID }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(isUntrustedFolderError(error)).toBe(false)
  expect(error).toBeInstanceOf(ClientError)
  expect(error).toMatchObject({ reason: "UnexpectedStatus" })
})
