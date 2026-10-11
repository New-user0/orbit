import { describe, expect, test } from "bun:test"
import { ShellDestructive } from "../../src/shell/destructive"

describe("ShellDestructive.matches", () => {
  test.each([
    "rm -rf x",
    "git clean -n && git clean -fd",
    "git clean -n; git clean -fdx",
    "git reset --hard; git status",
    "(git reset --hard)",
    "git push -f; echo done",
    "git push --force&& echo done",
    "git commit --amend; git push",
    "git commit --no-verify; ls",
    "rm -fr x",
    "rm -Rf x",
    "rm -r x",
    "rm -f x",
    "ls && rm -rf x",
    "ls\nrm -rf x",
    'rm -rf "x',
    "git reset --hard",
    "git reset HEAD~1 --hard",
    "git push -f",
    "git push origin main --force",
    "git push --force-with-lease",
    "git clean -fd",
    "git clean -xdf",
    "git clean --force",
    "git checkout .",
    "git checkout -- .",
    "git restore .",
    "git stash drop",
    "git stash clear",
    "git branch -D x",
    "git branch --delete --force x",
    "git branch --force --delete x",
    "git commit --no-verify -m x",
    "git push --no-verify",
    "git commit --amend",
    'psql -c "drop table users"',
    "DROP DATABASE x",
    "truncate schema s",
    'sqlite3 db "DELETE FROM t"',
    "kubectl delete pod x",
    "terraform destroy",
  ])("bash: %s is destructive", (command) => {
    expect(ShellDestructive.matches(command, "bash")).toBe(true)
  })

  test.each([
    "ls",
    "git status",
    "rm x",
    "rm --recursive x",
    "rm x -rf",
    "sudo rm -rf x",
    "git rm -rf x",
    "git clean -n -f",
    "git clean -fn",
    "git clean --dry-run -f",
    "git checkout main",
    "git checkout ./src",
    "git push",
    "git branch -d x",
    "git commit -m x",
    'sqlite3 db "DELETE FROM t WHERE id = 1"',
    "echo hi",
  ])("bash: %s is not destructive", (command) => {
    expect(ShellDestructive.matches(command, "bash")).toBe(false)
  })

  test.each([
    "Remove-Item -Recurse -Force x",
    "rm -Force -Recurse x",
    "del -Recurse x",
    "ri -Force x",
    'Remove-Item (Join-Path $root "build") -Recurse -Force',
    "{ del -Force .\\out }",
    "Remove-Item build -Force; npm run build",
    "Remove-Item build -Recurse; ls",
    "(Remove-Item x -Recurse)",
    "Remove-Item x -Recurse:$true",
    "{ rm x -Force}",
    "Remove-Item x -Force|Out-Null",
    "git clean -n; git clean -fd",
    "Clear-Content *.log",
    "Format-Volume",
    "Clear-Disk",
    "Stop-Computer",
    "Restart-Computer",
    "Clear-RecycleBin",
    "git reset --hard",
    "git push -f",
    "git clean -fd",
    "git stash drop",
    "DROP TABLE users",
    "drop table users",
  ])("powershell: %s is destructive", (command) => {
    expect(ShellDestructive.matches(command, "powershell-5.1")).toBe(true)
    expect(ShellDestructive.matches(command, "pwsh")).toBe(true)
  })

  test.each([
    "Remove-Item x",
    "Get-ChildItem",
    "git rm --force x",
    "git checkout .",
    "Clear-Content a.txt",
    "Remove-Item -Rec x",
    "if ($a) { rm x } else { Write-Output -Force }",
  ])("powershell: %s is not destructive", (command) => {
    expect(ShellDestructive.matches(command, "pwsh")).toBe(false)
  })

  test.each(["dir", "echo hi", "ls"])("a shell with no catalogue: %s is destructive", (command) => {
    expect(ShellDestructive.matches(command, "unanalysed")).toBe(true)
  })

  test("find names the category of the first match", () => {
    expect(ShellDestructive.find("rm -rf x", "bash")).toBe("rm-recursive-force")
    expect(ShellDestructive.find("rm -r x", "bash")).toBe("rm-recursive")
    expect(ShellDestructive.find("rm -f x", "bash")).toBe("rm-force")
    expect(ShellDestructive.find("ls", "bash")).toBeUndefined()
  })
})
