// The ACP approval rows of permission-files.subprocess.test.ts through other spellings of the workspace folder and of
// a link's target, and the NotebookEdit row of the approval matrix. The rows of a repository's link through each
// spelling are in spelling-matrix-*.subprocess.test.ts. Each row has its own folder, model and `orb acp` child, and the
// rows run as many at a time as `--max-concurrency` allows (packages/cli/package.json).
import { expect, test } from "bun:test"
import path from "node:path"
import {
  approval,
  keySent,
  linkRows,
  shownAt,
  toolResult,
} from "./approval-harness"
import {
  denyMarkerSent,
  realSpellings,
  refusedSpellings,
  spellArgs,
  spellingLinks,
  spellingPresence,
} from "./spelling-rows"

spellingPresence()

for (const spelling of realSpellings) {
  const through = async (root: string) => path.join(await spelling.spelled(root), "cfg", "orbit.json")
  test.concurrent(
    `an untrusted Read through ${spelling.name} and the repository's link into the config folder is asked about as the plain spelling is`,
    () =>
      approval(
        { tool: "Read", reply: "reject", args: async (root) => ({ file_path: await through(root) }), base: spelling.base, setup: spellingLinks },
        async (run) => {
          expect(String(run.permissions[0]?.toolCall.title)).toContain("external directory")
          expect(shownAt(run.permissions[0]?.toolCall.locations)).toContain(path.join(run.root, "config"))
          expect(run.permissions).toHaveLength(1)
          expect(keySent(run.root, run.bodies)).toBe(false)
        },
      ),
    90_000,
  )
  test.concurrent(
    `an untrusted Read through ${spelling.name} and the repository's link, after the folder is allowed, names the folder it reads`,
    () =>
      approval(
        { tool: "Read", reply: "once", args: async (root) => ({ file_path: await through(root) }), base: spelling.base, setup: spellingLinks },
        async (run) => {
          expect(run.permissions).toHaveLength(2)
          expect(shownAt(run.permissions[1]?.toolCall.locations)).toEqual([path.join(run.root, "config", "orbit.json")])
        },
      ),
    90_000,
  )
  test.concurrent(
    `an untrusted Read of secret/key.txt through ${spelling.name} under the person's deny of secret/* is denied`,
    () =>
      approval(
        {
          tool: "Read",
          permissions: [
            { action: "Read", resource: "*", effect: "ask" },
            { action: "Read", resource: "secret/*", effect: "deny" },
          ],
          reply: "once",
          args: async (root) => ({ file_path: path.join(await spelling.spelled(root), "secret", "key.txt") }),
          base: spelling.base, setup: spellingLinks,
        },
        async (run) => {
          expect(run.permissions).toHaveLength(0)
          expect(denyMarkerSent(run)).toBe(false)
          expect(toolResult(run)).toContain("denied")
        },
      ),
    90_000,
  )
  test.concurrent(
    `an untrusted Read of secret/key.txt through ${spelling.name} under the person's ask of secret/* asks about secret/key.txt`,
    () =>
      approval(
        {
          tool: "Read",
          permissions: [{ action: "Read", resource: "secret/*", effect: "ask" }],
          reply: "reject",
          args: async (root) => ({ file_path: path.join(await spelling.spelled(root), "secret", "key.txt") }),
          base: spelling.base, setup: spellingLinks,
        },
        async (run) => {
          expect(run.permissions).toHaveLength(1)
          expect(shownAt(run.permissions[0]?.toolCall.locations)).toEqual([
            path.join(run.workspace, "secret", "key.txt"),
          ])
          expect(denyMarkerSent(run)).toBe(false)
        },
      ),
    90_000,
  )
  test.concurrent(
    `a trusted Read through ${spelling.name} and the repository's link is the project's own, with no folder question (control)`,
    () =>
      approval(
        {
          tool: "Read",
          trusted: true,
          reply: "once",
          args: async (root) => ({ file_path: await through(root) }),
          base: spelling.base, setup: spellingLinks,
        },
        async (run) => {
          expect(run.permissions.filter((item) => String(item.toolCall.title).includes("external directory"))).toEqual(
            [],
          )
          expect(keySent(run.root, run.bodies)).toBe(true)
        },
      ),
    90_000,
  )
}
for (const spelling of refusedSpellings)
  for (const trusted of [false, true])
    test.concurrent(
      `${trusted ? "a trusted" : "an untrusted"} Read through ${spelling.name} is refused before any question`,
      () =>
        approval(
          {
            tool: "Read",
            trusted,
            reply: "once",
            args: async (root) => ({ file_path: path.join(await spelling.spelled(root), "cfg", "orbit.json") }),
            setup: spellingLinks,
          },
          async (run) => {
            expect(run.permissions).toHaveLength(0)
            expect(keySent(run.root, run.bodies)).toBe(false)
            expect(toolResult(run)).toContain("file.spelling")
          },
        ),
      90_000,
    )

// A share or device spelling is refused before any question whatever the tool, trusted or not.
const refusedRows = linkRows.filter((row) => ["Bash workdir", "Grep path", "Write file_path"].includes(row.name))
for (const row of refusedRows)
  for (const spelling of refusedSpellings)
    for (const trusted of [false, true])
      test.concurrent(
        `${trusted ? "a trusted" : "an untrusted"} ${row.name} through ${spelling.name} is refused before any question`,
        () =>
          approval(
            {
              tool: row.tool,
              rule: row.rule,
              shell: "shell" in row ? row.shell : undefined,
              trusted,
              reply: "once",
              args: async (root) => spellArgs(row.args, await spelling.spelled(root)),
              setup: spellingLinks,
            },
            async (run) => {
              expect(run.permissions).toHaveLength(0)
              expect(await row.acted(run.root, run.bodies)).toBe(false)
              expect(toolResult(run)).toContain("file.spelling")
            },
          ),
        90_000,
      )

// The matrix row of `clients-ux-61` over a real `orb acp` process: a NotebookEdit asks as an Edit, and its approval and
// its later updates name the notebook its request resolved, whatever keys the model adds beside `notebook_path`. Each row
// runs in an untrusted folder and again in a trusted one as the control. The notebook is read first, as the tool requires.
const notebook = JSON.stringify({
  cells: [{ cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["print(1)"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
})
for (const trusted of [false, true])
  test.concurrent(
    `${trusted ? "a trusted" : "an untrusted"} NotebookEdit is shown at the notebook its request resolved, whatever keys the model adds`,
    () =>
      approval(
        {
          tool: "Read",
          args: () => ({ file_path: "nb.ipynb" }),
          then: {
            tool: "NotebookEdit",
            args: () => ({
              notebook_path: "nb.ipynb",
              mode: "replace",
              cellId: "calc",
              source: "print(2)",
              file_path: "DECOY/elsewhere.ipynb",
              filePath: "DECOY/other.ipynb",
              path: "DECOY/dir",
            }),
          },
          permissions: [{ action: "Edit", resource: "*", effect: "ask" }],
          trusted,
          reply: "once",
          setup: (root) => Bun.write(path.join(root, "workspace", "nb.ipynb"), notebook),
        },
        async (run) => {
          const place = path.join(run.workspace, "nb.ipynb")
          const asked = run.permissions.filter((item) => item.toolCall.toolCallId === "call_2")
          expect(asked).toHaveLength(1)
          const call = asked[0].toolCall
          // The raw input is the one place the model's own keys appear, labelled as such.
          expect(JSON.stringify({ ...call, rawInput: undefined })).not.toContain("DECOY")
          expect((call.locations as { path: string }[]).map((item) => path.resolve(item.path))).toEqual([place])
          for (const item of call.content ?? []) if (item.type === "diff") expect(path.resolve(item.path)).toBe(place)
          const later = run.updates.filter(
            (item) => item.sessionUpdate === "tool_call_update" && item.toolCallId === "call_2" && item.locations?.length,
          )
          expect(later.map((item) => item.status)).toContain("completed")
          for (const item of later) {
            expect(JSON.stringify({ ...item, rawInput: undefined })).not.toContain("DECOY")
            expect(item.locations.map((entry: { path: string }) => path.resolve(entry.path))).toEqual([place])
          }
          // The runner acted where the approval said.
          expect(await Bun.file(place).text()).toContain("print(2)")
        },
      ),
    120_000,
  )
