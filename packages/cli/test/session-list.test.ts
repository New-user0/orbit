import { expect, test } from "bun:test"
import path from "node:path"
import { ORBIT_VERSION } from "../src/version"

const status = () => Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp/orbit" } })

// A session title is shown on the terminal by `orb session list`. It can come from a model, or from a workflow that an
// older release ran, so one can hold a set-title sequence, one that erases the line, a C1 control sequence introducer, DEL
// and a right-to-left override.
const evil = "\u001b]0;pwned\u0007x\u001b[2K\u009b\u007f\u{202e}"
const shown = "\\x1b]0;pwned\\x07x\\x1b[2K\\x9b\\x7f\\u{202e}"
const sessions = [
  { id: "ses_hostile", title: `odd${evil}\tend`, time: { created: 1, updated: 2 } },
  { id: "ses_plain", title: "Fix the build", time: { created: 1, updated: 1 } },
].map((session) => ({
  ...session,
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  location: { directory: "/project" },
}))

function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
}

async function list(...args: string[]) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === "/api/location")
        return Response.json({
          directory: "/project",
          project: { id: "global", directory: "/project", canonical: "/project" },
        })
      if (url.pathname === "/api/session") return Response.json({ data: sessions, cursor: {} })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    return await run(["session", "list", "--server", server.url.toString(), ...args])
  } finally {
    await server.stop(true)
  }
}

// No character of category C but the line breaks that the output puts between its lines.
const expectNoControl = (text: string) => expect(text.replace(/\r?\n/g, "")).not.toMatch(/\p{C}/u)

test("session list writes out the control characters of a title instead of printing them", async () => {
  const [stdout, stderr, exitCode] = await list()

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  // A tab still becomes a space, because the columns are separated by tabs.
  expect(stdout).toContain(`ses_hostile\todd${shown} end\t`)
  expect(stdout).toContain("ses_plain\tFix the build\t")
  // The tabs are the ones between the columns.
  expectNoControl(stdout.replaceAll("\t", ""))
}, 30_000)

test("session list --format json writes the control characters of a title as \\u escapes that parse back", async () => {
  const [stdout, stderr, exitCode] = await list("--format", "json")

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  expectNoControl(stdout)
  expect(JSON.parse(stdout).map((session: { id: string; title: string }) => [session.id, session.title])).toEqual([
    ["ses_hostile", `odd${evil}\tend`],
    ["ses_plain", "Fix the build"],
  ])
}, 30_000)
