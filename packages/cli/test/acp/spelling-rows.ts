// The spellings of the workspace folder that the ACP approval rows go through, and the matrix of a repository's link
// rows through each of them, which permission-spellings.subprocess.test.ts and spelling-matrix-*.subprocess.test.ts share.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runProgram } from "../../../core/test/fixture/run-program"
import { approval, linkCheck, linkRows, linkSetup, type Run } from "./approval-harness"

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
export const realSpellings = [
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

/** Registers the matrix for the given link rows: each through every real spelling, answered each way and under a deny. */
export function spellingMatrix(rows: typeof linkRows) {
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
}
