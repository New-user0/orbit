// "What is shown is what runs", ACP's half. The rows are the requests the tools really asked
// (`packages/core/test/fixture/approval-matrix.json`, pinned by `packages/core/test/approval-values.test.ts`), each with
// the calling tool's input as the model wrote it, decoy keys included, plus the requests of the tools whose rows are
// pinned by their own core tests. Each goes through the real ACP translation over the wire. The approval shows the
// request's places, files, method, URL and arguments and no decoy outside the labelled raw input, and the call's later
// updates name the place the server resolved (class 8, class 14).
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/tmpdir"
import {
  delivered,
  permissionAsked,
  startWire,
  succeeded,
  toolCalled,
  toolProgress,
  toolStarted,
  toolSucceeded,
} from "./wire-fixture"

type Row = {
  id: string
  tool: string
  input: Record<string, unknown>
  request: { action: string; resources: string[]; metadata?: Record<string, unknown> }
  truth: { places?: string[]; folder?: string; method?: string; url?: string; arguments?: string }
}

const fixture = path.join(import.meta.dir, "../../../core/test/fixture")
const load = async (name: string) => (await Bun.file(path.join(fixture, name)).json()) as Row[]
const all = [...(await load("approval-matrix.json")), ...(await load("approval-matrix-pinned.json"))]

// The calling tool's input also spells the change itself, and here it spells another change than the request carries: an
// approval or a call update that built a diff from it would show a decoy.
const decoyChange = { old_string: "DECOY-OLD", new_string: "DECOY-NEW", content: "DECOY-CONTENT", patchText: "DECOY-PATCH" }

function rows(world: { project: string; outside: string }): Row[] {
  return all.map((row): Row => {
    const result: Row = JSON.parse(
      JSON.stringify(row)
        .replaceAll("{project}", world.project)
        .replaceAll("{outsideName}", path.basename(world.outside))
        .replaceAll("{outside}", world.outside),
    )
    return { ...result, input: { ...result.input, ...decoyChange } }
  })
}

// One session folder for the module, so a row's relative spellings resolve where the server resolved them.
await using dir = await tmpdir()
const world = {
  project: dir.path.replaceAll("\\", "/"),
  outside: path.join(dir.path, "..", "approval-matrix-outside").replaceAll("\\", "/"),
}
// The input's own spelling of the file, when it names another place than the request does (a link, a spelling that
// leads elsewhere): read lexically against the project. Nothing drawn outside the raw input may contain it.
const slashed = (value: string) => value.replaceAll("\\", "/").toLowerCase()
const misleading = (row: Row) => {
  const raw = [row.input.file_path, row.input.notebook_path, row.input.path].find(
    (item): item is string => typeof item === "string" && !item.includes("DECOY"),
  )
  if (raw === undefined) return undefined
  const lexical = slashed(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(world.project, raw))
  return (row.truth.places ?? []).some((place) => slashed(path.resolve(place)) === lexical) ? undefined : raw
}
const same = (items: ReadonlyArray<{ path: string }> | null | undefined) =>
  (items ?? []).map((item) => path.resolve(item.path))

describe("acp approvals show what the request carries", () => {
  for (const row of rows(world))
    test(row.id, async () => {
      await using acp = await startWire({
        onPrompt: ({ sessionID, id }) => [
          delivered(sessionID, id),
          toolStarted(sessionID, "call_matrix", row.tool),
          toolCalled(sessionID, "call_matrix", row.input),
          permissionAsked(sessionID, "perm_matrix", {
            action: row.request.action,
            resources: row.request.resources,
            metadata: row.request.metadata,
            source: { type: "tool", messageID: "msg_matrix", id: "call_matrix" },
          }),
        ],
        onPermissionReply: ({ sessionID }) => [
          toolProgress(sessionID, "call_matrix", {}),
          toolSucceeded(sessionID, "call_matrix", {}, "done"),
          succeeded(sessionID),
        ],
        permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) as const,
      })
      await acp.initialize()
      const session = await acp.newSession(dir.path)
      await acp.prompt(session.sessionId, "hello")

      const call = acp.permissions[0]!.toolCall
      // The raw input is the one place the model's own keys may appear, labelled as such.
      const drawn = JSON.stringify({ ...call, rawInput: undefined })
      expect(drawn).not.toContain("DECOY")
      const own = misleading(row)
      if (own !== undefined) expect(drawn).not.toContain(own)

      const places = row.truth.places ?? (row.truth.folder ? [row.truth.folder] : [])
      if (places.length > 0 || row.truth.folder)
        expect(same(call.locations)).toEqual(places.map((item) => path.resolve(item)))
      if (row.truth.url) {
        expect(String(call.title)).toContain(row.truth.url)
        if (row.truth.method && row.truth.method !== "GET") expect(String(call.title)).toContain(row.truth.method)
        expect(call.locations ?? []).toHaveLength(0)
      }
      if (row.truth.arguments) {
        const text = (call.content ?? []).flatMap((item) =>
          item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
        )
        expect(text.join("\n")).toContain(row.truth.arguments)
      }
      // A diff is the request's, at the place the request names.
      for (const item of call.content ?? [])
        if (item.type === "diff") expect(places.map((place) => path.resolve(place))).toContain(path.resolve(item.path))
      const files = (row.request.metadata?.files ?? []) as { patch: string }[]
      const diffs = (call.content ?? []).flatMap((item) => (item.type === "diff" ? [item] : []))
      expect(diffs).toHaveLength(files.length)
      // Each diff is its file's patch: every removed or context line is in the old text, every added or context line in the
      // new one, and nothing else is.
      diffs.forEach((item, index) => {
        const lines = files[index]!.patch.split("\n")
        const body = lines.slice(lines.findIndex((line) => line.startsWith("@@")) + 1)
        const kept = (text: string | null | undefined) => (text ?? "").split("\n").filter((line) => line !== "")
        const wanted = (pattern: RegExp) =>
          body.filter((line) => pattern.test(line)).map((line) => line.slice(1)).filter((line) => line !== "")
        expect(kept(item.oldText)).toEqual(wanted(/^[- ]/))
        expect(kept(item.newText)).toEqual(wanted(/^[+ ]/))
      })

      // After the ask, the call's own updates name the same place.
      const later = acp.updates
        .map((item) => item.update)
        .flatMap((update) =>
          update.sessionUpdate === "tool_call_update" && update.toolCallId === "call_matrix" ? [update] : [],
        )
        .filter((update) => update.status === "in_progress" || update.status === "completed")
        .slice(-2)
      expect(later.length).toBeGreaterThan(0)
      for (const update of later) {
        // The finished call of an Edit draws the Edit's own old and new text (not an approval); no other tool draws a diff
        // from its input, so a key added to it shows nothing.
        const drawn = { ...update, rawInput: undefined, content: row.tool === "Edit" ? undefined : update.content }
        expect(JSON.stringify(drawn)).not.toContain("DECOY")
        if (own !== undefined) expect(JSON.stringify(drawn)).not.toContain(own)
        if (places.length > 0) expect(same(update.locations)).toEqual(places.map((item) => path.resolve(item)))
      }
    })
})
