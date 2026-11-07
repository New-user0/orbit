import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Permission } from "../src/permission.js"

// A client reads an approval and its reply through these schemas, so what they drop a client never sees: the mark that
// a question takes the person's own version, and the diff the server approved for that version (class 8).

test("a reply keeps the diff the server approved for the person's version, with its place", () => {
  const files = [
    {
      file: "a.txt",
      place: "/project/a.txt",
      patch: "@@ -1 +1 @@\n-beta\n+REVISED\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    },
  ]
  const data = Schema.decodeUnknownSync(Permission.Event.Replied.data)({
    sessionID: "ses_revise",
    requestID: "per_revise",
    reply: "once",
    files,
  })
  expect(data.files).toEqual(files)
})

test("a request keeps the mark that it takes the person's own version", () => {
  const request = Schema.decodeUnknownSync(Permission.Request)({
    id: "per_revise",
    sessionID: "ses_revise",
    action: "Edit",
    resources: ["a.txt"],
    revisable: true,
  })
  expect(request.revisable).toBe(true)
})
