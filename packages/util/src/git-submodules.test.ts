import { expect, test } from "bun:test"
import { GitSubmodules } from "./git-submodules.js"

// Where the switch lands for each shape of command line that Orbit's git builds: the options before the command (with and
// without a value of their own), a command that compares the work tree and one that does not. What the switch does to
// git is pinned by the rows in packages/core/test/git-gitlink.test.ts and packages/flow/test/git-gitlink.test.ts.
const SETTING = ["-c", "diff.ignoreSubmodules=all"]
const SWITCH = "--ignore-submodules=all"

test.each([
  { args: ["status", "--short"], expected: ["status", SWITCH, "--short"] },
  {
    args: ["--no-optional-locks", "status", "--short"],
    expected: ["--no-optional-locks", "status", SWITCH, "--short"],
  },
  {
    args: ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "--numstat", "HEAD", "--", "."],
    expected: ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", SWITCH, "--numstat", "HEAD", "--", "."],
  },
  {
    args: ["--git-dir", "/g", "--work-tree", "/w", "--literal-pathspecs", "diff-files", "--name-only"],
    expected: ["--git-dir", "/g", "--work-tree", "/w", "--literal-pathspecs", "diff-files", SWITCH, "--name-only"],
  },
  { args: ["-C", "/w", "diff-index", "HEAD"], expected: ["-C", "/w", "diff-index", SWITCH, "HEAD"] },
  {
    args: ["diff", "--no-index", "--", "/dev/null", "a"],
    expected: ["diff", SWITCH, "--no-index", "--", "/dev/null", "a"],
  },
  // A folder named like a command is the value of `-C`, not the command.
  { args: ["-C", "diff", "log", "-1"], expected: ["-C", "diff", "log", "-1"] },
  { args: ["checkout", "main"], expected: ["checkout", "main"] },
  { args: ["add", "-A", "--", "."], expected: ["add", "-A", "--", "."] },
  { args: ["rev-parse", "--show-toplevel"], expected: ["rev-parse", "--show-toplevel"] },
  { args: ["--version"], expected: ["--version"] },
  { args: [], expected: [] },
])("skip($args)", (row) => {
  expect(GitSubmodules.skip(row.args)).toEqual([...SETTING, ...row.expected])
})

test("pinned gives each submodule its setting, which `skip` leaves before the command", () => {
  const pinned = GitSubmodules.pinned(["inner", "a=b"])
  expect(pinned).toEqual([
    `--config-env=submodule.inner.ignore=${GitSubmodules.VARIABLE}`,
    `--config-env=submodule.a=b.ignore=${GitSubmodules.VARIABLE}`,
  ])
  expect(GitSubmodules.skip([...pinned, "merge", "x"])).toEqual([...SETTING, ...pinned, "merge", "x"])
})
