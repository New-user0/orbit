// The ACP approval rows of permission-files.subprocess.test.ts through other spellings of the workspace folder and of
// a link's target, and the NotebookEdit row of the approval matrix. The rows of a repository's link through each
// spelling are in spelling-matrix-*.subprocess.test.ts. Each row has its own folder, model and `orb acp` child, and the
// rows run as many at a time as `--max-concurrency` allows (packages/cli/package.json).
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  approval,
  canLinkDirectory,
  globMarker,
  keySent,
  linkRows,
  shownAt,
  toolResult,
  type Run,
} from "./approval-harness"
import {
  denyMarkerSent,
  realSpellings,
  refusedSpellings,
  spellArgs,
  spellingLinks,
} from "./spelling-rows"

for (const spelling of realSpellings) {
  const through = async (root: string) => path.join(await spelling.spelled(root), "cfg", "orbit.json")
  test.concurrent(
    `an untrusted Read through ${spelling.name} and the repository's link into the config folder is asked about as the plain spelling is`,
    () =>
      approval(
        { tool: "Read", reply: "reject", args: async (root) => ({ file_path: await through(root) }), setup: spellingLinks },
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
        { tool: "Read", reply: "once", args: async (root) => ({ file_path: await through(root) }), setup: spellingLinks },
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
          setup: spellingLinks,
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
          setup: spellingLinks,
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
          setup: spellingLinks,
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

// A link of the repository whose target is a share, in any spelling of it, including one that names the person's own
// config folder through `\\localhost\C$`. The person's rules name that folder as a drive path, so a question about the
// share's spelling would turn their deny into an ask, and approving it connects to the host. The place the link leads to
// is refused as a share given directly is: `file.spelling`, before any question and before anything is opened, whatever
// the tool. The deny row and the trusted row are the controls, as are the junction rows above (class 4, class 8,
// class 12; permissions-23). A symlink to a share needs Developer Mode, so these rows run on Windows with it.
const shareTargets =
  process.platform === "win32" && canLinkDirectory
    ? [
        {
          name: "a localhost admin share",
          target: (root: string) => `\\\\localhost\\${root[0]}$\\${root.slice(3)}\\config`,
        },
        {
          name: "a 127.0.0.1 admin share",
          target: (root: string) => `\\\\127.0.0.1\\${root[0]}$\\${root.slice(3)}\\config`,
        },
        {
          name: "a \\\\?\\UNC admin share",
          target: (root: string) => `\\\\?\\UNC\\localhost\\${root[0]}$\\${root.slice(3)}\\config`,
        },
        {
          name: "a \\\\?\\Volume path",
          target: (root: string) => `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${root.slice(3)}\\config`,
        },
        {
          name: "a \\\\.\\Volume path",
          target: (root: string) => `\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\${root.slice(3)}\\config`,
        },
        { name: "a share host", target: () => "\\\\orbit-share-host.invalid\\share\\config" },
      ]
    : []
const shareLinkSetup = (target: (root: string) => string) => async (root: string) => {
  await Bun.write(path.join(root, "config", "AGENTS.md"), "The person's own instructions.\n")
  await Bun.write(path.join(root, "config", globMarker), "marker\n")
  await fs.symlink(target(root), path.join(root, "workspace", "cfg"), "dir")
}
const refusedAsShare = async (run: Run, row: (typeof linkRows)[number]) => {
  expect(run.permissions).toHaveLength(0)
  expect(await row.acted(run.root, run.bodies)).toBe(false)
  expect(toolResult(run)).toContain("file.spelling")
}
for (const row of linkRows)
  for (const share of shareTargets) {
    test.concurrent(
      `an untrusted ${row.name} through a repository link to ${share.name} is refused as a share, with no question, answered once`,
      () =>
        approval(
          {
            tool: row.tool,
            rule: row.rule,
            shell: "shell" in row ? row.shell : undefined,
            reply: "once",
            args: () => row.args,
            setup: shareLinkSetup(share.target),
          },
          (run) => refusedAsShare(run, row),
        ),
      90_000,
    )
    if (share !== shareTargets[0]) continue
    test.concurrent(
      `an untrusted ${row.name} through a repository link to ${share.name} under the person's deny of the config folder is refused as a share, not asked about`,
      () =>
        approval(
          {
            tool: row.tool,
            rule: row.rule,
            shell: "shell" in row ? row.shell : undefined,
            permissions: (root) => [
              { action: row.rule, resource: "*", effect: "ask" },
              {
                action: "external_directory",
                resource: `${path.join(root, "config").replaceAll("\\", "/")}/*`,
                effect: "deny",
              },
            ],
            reply: "once",
            args: () => row.args,
            setup: shareLinkSetup(share.target),
          },
          (run) => refusedAsShare(run, row),
        ),
      90_000,
    )
    // The owner trusted the folder (2026-10-13: a trusted folder asks before a tool touches a link to a share): no
    // spelling refuses the call, and one folder question names the share. A reject keeps everything unopened.
    for (const reply of ["once", "reject"] as const)
      test.concurrent(
        `a trusted ${row.name} through a repository link to ${share.name} is not refused and asks one folder question that names the share, answered ${reply} (control)`,
        () =>
          approval(
            {
              tool: row.tool,
              rule: row.rule,
              shell: "shell" in row ? row.shell : undefined,
              trusted: true,
              reply,
              args: () => row.args,
              setup: shareLinkSetup(share.target),
            },
            async (run) => {
              expect(toolResult(run)).not.toContain("file.spelling")
              const folder = run.permissions.filter((item) =>
                String(item.toolCall.title).includes("external directory"),
              )
              expect(folder).toHaveLength(1)
              // The question shows the share as the request resolved it, in forward slashes.
              expect(String(folder[0]?.toolCall.title)).toContain(`//localhost/${run.root[0]}$/`)
              expect(folder[0]?.toolCall.locations?.[0]?.path).toStartWith(`//localhost/${run.root[0]}$/`)
              if (reply === "reject") expect(await row.acted(run.root, run.bodies)).toBe(false)
            },
          ),
        90_000,
      )
  }

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
