// The ACP approval rows of acp/permission-files.subprocess.test.ts through other spellings of the workspace folder and
// of a link's target, and the NotebookEdit row of the approval matrix. Each row has its own folder, model and `orb acp`
// child, and the rows run as many at a time as `--max-concurrency` allows (packages/cli/package.json). The file is not
// beside the first half: CI's `--shard` gives each job a run of files in path order, and the two halves together, each
// starting `orb acp` children at once, overloaded one Windows job until rows timed out.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runProgram } from "../../core/test/fixture/run-program"
import {
  approval,
  canLinkDirectory,
  globMarker,
  keySent,
  linkCheck,
  linkRows,
  linkSetup,
  shownAt,
  toolResult,
  type Run,
} from "./acp/approval-harness"

// A path that names the project through another spelling of its own folder is decided where it really is. Over a real
// `orb acp` in an untrusted folder, a call under such a spelling meets the same folder question and the same rules as
// the plain spelling, and the link of the repository below it is followed in none of them; a share or device spelling is
// refused with no question. The trusted rows are the controls (class 3, class 4, class 8, class 12; permissions-23).
const temporary = os.tmpdir()
const junctions = (
  process.platform === "win32"
    ? [
        {
          name: "Documents and Settings",
          temporary: temporary.replace(/^([A-Za-z]:)\\Users\\/i, "$1\\Documents and Settings\\"),
        },
        {
          name: "Local Settings",
          temporary: temporary.replace(/^(.*?\\Users\\[^\\]+)\\AppData\\Local\\/i, "$1\\Local Settings\\"),
        },
      ]
    : []
).filter((item) => item.temporary !== temporary)
const present = await Promise.all(
  junctions.map((item) =>
    fs.stat(item.temporary).then(
      () => [item],
      () => [],
    ),
  ),
)
// Each spelling of the workspace folder, from the folder the run is made in (`root`, below the temporary folder).
// The 8.3 short name of the workspace folder, as the volume makes it. A volume that makes none fails the row visibly,
// as a short name that equals the long one would decide nothing.
const shortWorkspace = async (root: string) => {
  const folder = path.join(root, "workspace")
  const short = (
    await runProgram(["cmd", "/d", "/c", `for %I in ("${folder}") do @echo %~sI`], { windowsVerbatimArguments: true })
  ).stdout
    .toString()
    .trim()
  if (short === "" || short.toLowerCase() === folder.toLowerCase())
    throw new Error("this volume makes no 8.3 short names")
  return short
}
const realSpellings = [
  { name: "a link to the project", spelled: (root: string) => path.join(root, "wsalias") },
  ...present.flat().map((item) => ({
    name: item.name,
    spelled: (root: string) => path.join(item.temporary, path.basename(root), "workspace"),
  })),
  ...(process.platform === "win32"
    ? [
        {
          name: "the 8.3 short name of the workspace folder",
          spelled: async (root: string) => path.join(root, path.basename(await shortWorkspace(root))),
        },
        { name: "the 8.3 short name of the workspace folder and the ones above it", spelled: shortWorkspace },
      ]
    : []),
]
const refusedSpellings =
  process.platform === "win32"
    ? [
        {
          name: "a UNC admin share",
          spelled: (root: string) => `\\\\localhost\\${root[0]}$\\${root.slice(3)}\\workspace`,
        },
        {
          name: "a \\\\?\\Volume path",
          spelled: (root: string) => `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${root.slice(3)}\\workspace`,
        },
        {
          name: "a \\\\.\\Volume path",
          spelled: (root: string) => `\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\${root.slice(3)}\\workspace`,
        },
      ]
    : []
const spellingLinks = async (root: string) => {
  await linkSetup("junction")(root)
  await Bun.write(path.join(root, "workspace", "secret", "key.txt"), "DENY-MARKER\n")
  await (process.platform === "win32"
    ? fs.symlink(path.join(root, "workspace"), path.join(root, "wsalias"), "junction")
    : fs.symlink(path.join(root, "workspace"), path.join(root, "wsalias"), "dir"))
}
const denyMarkerSent = (run: Run) => run.bodies.some((body) => body.includes("DENY-MARKER"))
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

// The same rows through each real spelling of the workspace folder: the paths a tool is given (Bash workdir, Grep, Write,
// Read) and the words of a command (Bash cat, path words, redirect, PowerShell) meet the folder question that the plain
// spelling meets, nothing is read or written before it, a trusted folder is the control, and a person's deny of the
// config folder means no question and nothing sent (class 3, class 4, class 8, class 12; permissions-23).
const spellArgs = (args: Record<string, unknown>, spelled: string) => {
  const base = spelled.replaceAll("\\", "/")
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== "string") return [key, value]
      if (key === "command") return [key, value.replace(/\bcfg(\/[^\s;]*)?/g, (word) => `"${base}/${word}"`)]
      if (["workdir", "path", "file_path", "cwd"].includes(key)) return [key, `${base}/${value}`]
      return [key, value]
    }),
  )
}
const spellingModes = [
  { trusted: false, reply: "once" },
  { trusted: false, reply: "reject" },
  { trusted: true, reply: "once" },
] as const
for (const row of linkRows)
  for (const spelling of realSpellings) {
    for (const mode of spellingModes)
      test.concurrent(
        `${mode.trusted ? "a trusted" : "an untrusted"} ${row.name} through ${spelling.name} and the repository's link into the config folder, answered ${mode.reply}`,
        () =>
          approval(
            {
              tool: row.tool,
              rule: row.rule,
              shell: "shell" in row ? row.shell : undefined,
              trusted: mode.trusted,
              reply: mode.reply,
              args: async (root) => spellArgs(row.args, await spelling.spelled(root)),
              setup: spellingLinks,
            },
            linkCheck(row, mode),
          ),
        90_000,
      )
    test.concurrent(
      `an untrusted ${row.name} through ${spelling.name} and the repository's link under the person's deny of the config folder is denied with no question`,
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
            args: async (root) => spellArgs(row.args, await spelling.spelled(root)),
            setup: spellingLinks,
          },
          async (run) => {
            expect(run.permissions).toHaveLength(0)
            expect(await row.acted(run.root, run.bodies)).toBe(false)
          },
        ),
      90_000,
    )
  }
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
