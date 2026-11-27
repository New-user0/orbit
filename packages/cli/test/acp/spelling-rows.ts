// The spellings of the workspace folder that the ACP approval rows go through, and the matrix of a repository's link
// rows through each of them, which permission-spellings.subprocess.test.ts and spelling-matrix-*.subprocess.test.ts share.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { junctionSpellings, junctionTemporary } from "../../../core/test/fixture/legacy-junction"
import { runProgram } from "../../../core/test/fixture/run-program"
import {
  approval,
  canLinkDirectory,
  globMarker,
  linkCheck,
  linkRows,
  linkSetup,
  toolResult,
  type Run,
} from "./approval-harness"

// A path that names the project through another spelling of its own folder is decided where it really is. Over a real
// `orb acp` in an untrusted folder, a call under such a spelling meets the same folder question and the same rules as
// the plain spelling, and the link of the repository below it is followed in none of them; a share or device spelling is
// refused with no question. The trusted rows are the controls (class 3, class 4, class 8, class 12; permissions-23).
// Windows' legacy junctions name a folder only below a profile's AppData\Local, so the rows through them make their run
// folder there (`base`), which on Windows CI is the runner's own temporary folder on C: (fixture/legacy-junction.ts).
const temporary = junctionTemporary()
const present = await Promise.all(
  (temporary === undefined ? [] : junctionSpellings(temporary)).map((item) =>
    fs.stat(item.spelled).then(
      () => [{ name: item.name, temporary: item.spelled, base: temporary }],
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
// `base` is the folder a row's run folder is made in, the temporary folder when it is not given.
export const realSpellings: ReadonlyArray<{
  name: string
  base?: string
  spelled: (root: string) => string | Promise<string>
}> = [
  { name: "a link to the project", spelled: (root: string) => path.join(root, "wsalias") },
  ...present.flat().map((item) => ({
    name: item.name,
    base: item.base,
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
export const refusedSpellings =
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
export const spellingLinks = async (root: string) => {
  await linkSetup("junction")(root)
  await Bun.write(path.join(root, "workspace", "secret", "key.txt"), "DENY-MARKER\n")
  await (process.platform === "win32"
    ? fs.symlink(path.join(root, "workspace"), path.join(root, "wsalias"), "junction")
    : fs.symlink(path.join(root, "workspace"), path.join(root, "wsalias"), "dir"))
}
export const denyMarkerSent = (run: Run) => run.bodies.some((body) => body.includes("DENY-MARKER"))

// The same rows through each real spelling of the workspace folder: the paths a tool is given (Bash workdir, Grep, Write,
// Read) and the words of a command (Bash cat, path words, redirect, PowerShell) meet the folder question that the plain
// spelling meets, nothing is read or written before it, a trusted folder is the control, and a person's deny of the
// config folder means no question and nothing sent (class 3, class 4, class 8, class 12; permissions-23).
export const spellArgs = (args: Record<string, unknown>, spelled: string) => {
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

/**
 * Registers a Windows row that fails when the rows cannot make their folder below a profile's AppData\Local, where the
 * legacy junctions lead, rather than registering fewer rows (fixture/legacy-junction.ts; class 3, class 4). CI runs the
 * files that register rows from `realSpellings` in different jobs, so each of them registers this row.
 */
export function spellingPresence() {
  ;(process.platform === "win32" ? test : test.skip)(
    "the rows go through the Documents and Settings and Local Settings spellings of the workspace folder",
    () => {
      expect(realSpellings.map((item) => item.name).filter((name) => name.endsWith(" Settings"))).toEqual([
        "Documents and Settings",
        "Local Settings",
      ])
    },
  )
}

/** Registers the matrix for the given link rows: each through every real spelling, answered each way and under a deny. */
export function spellingMatrix(rows: typeof linkRows) {
  spellingPresence()
  for (const row of rows)
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
                base: spelling.base,
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
              base: spelling.base,
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
}

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
/** Registers the share-target rows for the given link rows: each through every share spelling, refused before a question. */
export function shareMatrix(rows: typeof linkRows) {
  for (const row of rows)
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
}
