import path from "path"
import { createAppFixture } from "./app"
import { directory, json } from "./tui-client"

// A session for the rewind picker (clients-ux-5 part 2): three prompts, each answered, behind a fake server that answers
// the picker's requests and records every request that changes something. Per-prompt stats come from
// `GET …/diff?scope=prompt&from=<prompt>`, what a rewind would change from the dry run of `POST …/revert/files`, and
// each option acts through `revert/stage` or `revert/files`. Nothing here runs a real server: the picker's own logic is
// what is under test, and the server side of these routes is pinned in packages/server/test/session-revert-files.test.ts.

export const location = { directory, project: { id: "project", directory, canonical: directory } }

export const sessionID = "ses_rewind"

const session = {
  id: sessionID,
  title: "Rewind fixture",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

// A file name a clone can give a file: an erase-line sequence and a window-title sequence (class 9).
export const hostileFile = "src/evil\u001b[2K\u001b]0;pwned\u0007name.ts"
// A stored prompt holding the same kind of sequence.
export const hostilePrompt = "Fix the \u001b]0;pwned\u0007 title"

const user = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } })
const assistant = (id: string, created: number, content: unknown[]) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: { created, completed: created + 500 },
  finish: "stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  content,
})

const now = Date.now()

/** Oldest first. The message route answers newest first, as the server does. */
export const conversation = [
  user("msg_0001", "Add the parser", now - 3 * 60 * 60_000),
  assistant("msg_0002", now - 3 * 60 * 60_000 + 1000, [{ type: "text", text: "Added the parser." }]),
  user("msg_0003", "Rename the helper", now - 2 * 60 * 60_000),
  assistant("msg_0004", now - 2 * 60 * 60_000 + 1000, [{ type: "text", text: "Renamed it." }]),
  user("msg_0005", hostilePrompt, now - 5 * 60_000),
  assistant("msg_0006", now - 5 * 60_000 + 1000, [{ type: "text", text: "Fixed the title." }]),
]

/** What `scope=prompt` reports for each prompt's own file-tool edits. */
export const promptStats: Record<string, unknown[]> = {
  msg_0001: [{ file: "src/parser.ts", patch: "", additions: 12, deletions: 0, status: "added" }],
  msg_0003: [
    { file: "src/a.ts", patch: "", additions: 3, deletions: 1, status: "modified" },
    { file: "src/b.ts", patch: "", additions: 2, deletions: 2, status: "modified" },
  ],
  msg_0005: [{ file: hostileFile, patch: "", additions: 1, deletions: 1, status: "modified" }],
}

const absolute = (file: string) => path.join(directory, file)

/** What a dry run reports, per prompt: what a rewind to its checkpoint would change on disk now. */
export const dryRuns: Record<string, unknown> = {
  // Nothing on disk differs from this prompt's checkpoint any more, so code options are not offered.
  msg_0001: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 },
  msg_0003: {
    canRewind: true,
    filesChanged: [absolute("src/a.ts"), absolute("src/b.ts")],
    insertions: 3,
    deletions: 5,
  },
  msg_0005: { canRewind: true, filesChanged: [absolute(hostileFile)], insertions: 1, deletions: 1 },
}

export type Recorded = { method: string; path: string; search: string; body?: any }

export async function rewindApp(input: {
  width?: number
  height?: number
  state: string
  messages?: unknown[]
  /** The session is running: `/api/session/active` names it. */
  running?: boolean
  /** Answers a request before the defaults; `undefined` falls through. A promise holds the answer until it settles. */
  answer?: (request: Recorded) => Response | Promise<Response> | undefined
  /** A revert staged at this message: the session's own `revert` boundary. */
  revert?: string
}) {
  const requests: Recorded[] = []
  const messages = input.messages ?? conversation
  const setup = await createAppFixture({
    width: input.width ?? 120,
    height: input.height ?? 40,
    state: input.state,
    config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
    args: { sessionID },
    fetch: async (url, request) => {
      const body =
        request.method === "GET"
          ? undefined
          : await request.text().then((text) => (text ? JSON.parse(text) : undefined))
      const recorded = { method: request.method, path: url.pathname, search: url.search, body }
      const base = `/api/session/${sessionID}`
      if (url.pathname.startsWith(base) || url.pathname === `/api/experimental/session/${sessionID}/wait`)
        requests.push(recorded)
      const answered = await input.answer?.(recorded)
      if (answered) return answered
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session/active")
        return json({ data: input.running ? { [sessionID]: { type: "running" } } : {} })
      if (url.pathname === base)
        return json({ data: input.revert ? { ...session, revert: { messageID: input.revert } } : session })
      if (url.pathname === `${base}/message`) return json({ data: [...messages].reverse(), cursor: {} })
      if (url.pathname === `${base}/inbox` || url.pathname === `${base}/permission`) return json({ data: [] })
      if (url.pathname === `${base}/diff`) {
        const from = url.searchParams.get("from") ?? ""
        return json({ data: url.searchParams.get("scope") === "prompt" ? (promptStats[from] ?? []) : [] })
      }
      if (url.pathname === `${base}/revert/files`) {
        if (body?.dryRun)
          return json({ data: dryRuns[body.messageID] ?? { canRewind: false, error: "No checkpoint." } })
        return json({ data: { canRewind: true } })
      }
      if (url.pathname === `${base}/revert/stage`) return json({ data: { messageID: body?.messageID, files: [] } })
      if (url.pathname === `${base}/interrupt`) return json({ interrupted: !!input.running })
      if (url.pathname === `/api/experimental/session/${sessionID}/wait`) return new Response(null, { status: 204 })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Fixture Model", variants: [] }] })
      return undefined
    },
  })
  return Object.assign(setup, {
    requests,
    /** The requests that change something, in order: interrupts, waits, stages and real (not dry) rewinds. */
    actions: () =>
      requests.flatMap((request) => {
        if (request.path.endsWith("/interrupt")) return ["interrupt"]
        if (request.path.endsWith("/wait")) return ["wait"]
        if (request.path.endsWith("/revert/stage")) return [`stage ${JSON.stringify(request.body)}`]
        if (request.path.endsWith("/revert/files") && !request.body?.dryRun)
          return [`files ${JSON.stringify(request.body)}`]
        return []
      }),
    dryRunsSent: () =>
      requests.flatMap((request) =>
        request.path.endsWith("/revert/files") && request.body?.dryRun ? [request.body.messageID as string] : [],
      ),
    statsSent: () =>
      requests.flatMap((request) =>
        request.path.endsWith("/diff")
          ? [new URLSearchParams(request.search).get("scope") + " " + new URLSearchParams(request.search).get("from")]
          : [],
      ),
  })
}

/** Polls until `predicate` holds, for up to `ms`; the app renders on its own meanwhile. */
export async function until(predicate: () => boolean, label: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

/** How many lines of a frame hold `text`. */
export function linesWith(frame: string, text: string) {
  return frame.split("\n").filter((line) => line.includes(text)).length
}

/** The picker's list heading: shown while step 1 is up. */
export const listHeading = "Rewind the code, the conversation or both to just before…"

/** No character of Unicode category C on any line of a frame, apart from the line breaks (class 9). */
export function controlFree(frame: string) {
  return !/\p{C}/u.test(frame.replaceAll("\n", ""))
}
