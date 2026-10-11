import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { ShellSafety } from "../../src/shell/safety"
import { bash, linux, nest, powershell, pwsh, pwshLinux, windows } from "./helper"

// Pure: no command runs and nothing touches the disk. Windows rows run on any host through the injected path module.

type Context = ShellAnalysis.Context
type Over = Partial<ShellSafety.Options>

function options(ctx: Context, text: string, over: Over = {}): ShellSafety.Options {
  return { platform: ctx.platform, path: ctx.path, home: ctx.home, cwd: ctx.cwd, project: ctx.cwd, location: ctx.cwd, env: ctx.env, text, ...over }
}

const sig = (findings: ShellSafety.Finding[]) => findings.map((item) => `${item.kind}:${item.reason}:${item.decision}`)

function run(text: string, ctx: Context = linux(), over: Over = {}) {
  return ShellSafety.check(nest(bash(text, ctx), ctx), options(ctx, text, over))
}

function runPowershell(text: string, ctx: Context = pwsh(), over: Over = {}) {
  return ShellSafety.check(nest(powershell(text, ctx), ctx), options(ctx, text, over))
}

function expectHit(findings: ShellSafety.Finding[], expected: string) {
  expect(sig(findings)).toContain(expected)
}

const ASK = "critical-removal:critical-place:ask"
const DENY = "critical-removal:critical-place:deny"
const complex = (reason: string) => `too-complex:${reason}:ask`

describe("critical removal in bash", () => {
  const finding = [
    "rm -rf /",
    "rm -rf //",
    "rm -rf /.",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf /*",
    "rm -rf build/*",
    "rm '*'",
    "rm -rf .",
    "rm -rf ..",
    "rm -rf /usr",
    "rm -rf /usr/local",
    "rm -rf /u*",
    "rm -rf ~/[a-z]*",
    "find . -delete",
    "find / -type f -delete",
    "find . ! -name keep -delete",
    "find . -name a -o -delete",
    "find . -exec rm -rf {} +",
    "find / | xargs rm -rf",
    "ls / | xargs rm -rf",
    "ls | xargs rm",
    "mv ~ /tmp/h",
    "sudo rm -rf /",
    "rmdir /tmp",
    "bash -c 'rm -rf ~'",
  ]
  test.each(finding)("%s asks", (text) => {
    expectHit(run(text), ASK)
  })

  test("--no-preserve-root counts whatever the operands are", () => {
    expectHit(run("rm --no-preserve-root -rf /x"), "critical-removal:no-preserve-root:ask")
  })

  test("a folder above the project is critical, a folder of the project is not", () => {
    const over = { project: "/home/u/work/proj", cwd: "/home/u/work/proj", location: "/home/u/work/proj" }
    expectHit(run("rm -rf /home/u/work", linux({ cwd: over.cwd }), over), ASK)
    expect(run("rm -rf build", linux({ cwd: over.cwd }), over)).toEqual([])
  })

  test("a link that leads to the home folder is critical through the guard's real place", () => {
    const text = "rm -rf h/"
    const analysis = bash(text)
    const file = analysis.paths.files.findIndex((item) => item.role === "remove")
    expect(run(text)).toEqual([])
    expectHit(ShellSafety.check(analysis, options(linux(), text, { facts: { real: [{ file, places: ["/home/u"] }] } })), ASK)
  })

  const none = [
    "rm -rf build",
    "rm *.pyc",
    "rm -rf ~/projects/other",
    "rm -rf /tmp/x",
    "find . -name '*.pyc' -delete",
    "find build -exec rm {} +",
    "find src -name x | xargs rm",
    "rm -rf /usr/*/bin",
    "rm h",
  ]
  test.each(none)("%s is not critical", (text) => {
    expect(sig(run(text)).filter((item) => item.startsWith("critical-removal"))).toEqual([])
  })

  test("a removal outside the third spellings is judged on the real place of the parent only", () => {
    const text = "rm h"
    const analysis = bash(text)
    const file = analysis.paths.files.findIndex((item) => item.role === "remove")
    // The guard supplies the parent's real place joined with `h`; that is not the home folder, so nothing is found.
    expect(ShellSafety.check(analysis, options(linux(), text, { facts: { real: [{ file, places: ["/work/h"] }] } }))).toEqual([])
  })

  test("critical removal never lifts through exact: false", () => {
    const [one] = run("rm -rf /")
    expect(one.exact).toBe(false)
    expect(one.place).toBe("/")
  })
})

describe("critical removal: Orbit's own places", () => {
  test("a removal of the home folder spelled by HOME, or its parent, asks", () => {
    const ctx = linux({ env: { HOME: "/root" } })
    expectHit(run("rm -rf /root", ctx), ASK)
    expectHit(run("rm -rf /home", ctx), ASK)
  })

  test("the Windows system and program folders ask", () => {
    const env = { SystemRoot: "D:\\Win", ProgramFiles: "E:\\Apps\\Program Files", ProgramData: "E:\\Data" }
    for (const text of ["rm -rf D:/Win", "rm -rf D:/Win/System32", "rm -rf D:/Win/WinSxS", "rm -rf 'E:/Apps/Program Files'", "rm -rf E:/Data"])
      expectHit(run(text, windows({ env })), ASK)
  })

  test("a darwin path is compared without case and a linux path with it", () => {
    expectHit(run("rm -rf /Private/ETC", linux({ platform: "darwin" })), ASK)
    expect(run("rm -rf /usr/LIB64", linux())).toEqual([])
  })

  test("a link target that is the system folder asks through the real place", () => {
    const text = "rm -rf link/"
    const analysis = bash(text)
    const file = analysis.paths.files.findIndex((item) => item.role === "remove")
    expectHit(ShellSafety.check(analysis, options(linux(), text, { facts: { real: [{ file, places: ["/usr/lib"] }] } })), ASK)
  })
})

describe("critical removal on Windows", () => {
  const dir = { cwd: "C:\\Users\\u\\work\\proj" }
  const git = [
    ["rm -rf /c/", ASK],
    ["rm -rf /c/Users/u", ASK],
    ["rm -rf C:/Windows/System32", ASK],
    ["rm -rf c:/windows/system32", ASK],
    ["rm -rf 'C:\\Windows.'", ASK],
  ] as const
  test.each(git)("Git Bash %s asks", (text, expected) => {
    expectHit(run(text, windows(dir)), expected)
  })

  const denied = [
    "Remove-Item -Recurse C:/",
    "remove-item -recurse c:\\",
    "REMOVE-ITEM ~",
    "ri ~",
    "del C:\\Windows",
    "Remove-Item C:",
    "Remove-Item '\\\\?\\C:\\'",
    "Remove-Item build\\*",
    "if ($true) { Remove-Item / }",
  ]
  test.each(denied)("PowerShell %s is refused", (text) => {
    expectHit(runPowershell(text, pwsh(dir)), DENY)
  })

  test("a real place that is the home folder is refused", () => {
    const text = "Remove-Item h"
    const ctx = pwsh(dir)
    const analysis = powershell(text, ctx)
    const file = analysis.paths.files.findIndex((item) => item.role === "remove")
    expect(runPowershell(text, ctx)).toEqual([])
    expectHit(ShellSafety.check(analysis, options(ctx, text, { facts: { real: [{ file, places: ["C:\\Users\\u"] }] } })), DENY)
  })

  test("Move-Item of the home folder and Remove-Item of the project only ask", () => {
    const ctx = pwsh(dir)
    expectHit(runPowershell("Move-Item ~ x", ctx), ASK)
    expectHit(runPowershell("Remove-Item .", ctx, { project: ctx.cwd }), ASK)
  })

  test("a folder of the project is not critical", () => {
    expect(runPowershell("Remove-Item .\\build", pwsh(dir))).toEqual([])
  })

  test("a nested PowerShell from bash is refused too", () => {
    expectHit(run("pwsh -c 'Remove-Item -Recurse ~'", windows(dir)), DENY)
  })

  const opaque = ["Remove-Item ~ ; <parse error>", "$x = Remove-Item ~", "& 'rm' /"]
  test.each(opaque)("an unparsed PowerShell text %s is still refused through the fragment scan", (text) => {
    const ctx = pwsh(dir)
    const analysis = ShellAnalysis.analyze(text, ctx, { valid: false, reason: "parse-errors" })
    expect(analysis.opaque).toBeDefined()
    const findings = ShellSafety.check(analysis, options(ctx, text))
    expectHit(findings, DENY)
    expectHit(findings, complex("opaque"))
  })

  test("the fragments split as the permission flow does", () => {
    expect(ShellSafety.fragments("$a = $b = Remove-Item `\n ~; if ($x) { & 'del' / } | foo")).toEqual(["Remove-Item  ~", "if", "$x", "'del' /", "foo"])
  })

  test("PowerShell on Linux runs the native rm, which asks", () => {
    const ctx = pwshLinux()
    const text = "rm -rf ~"
    expectHit(runPowershell(text, ctx), ASK)
    expect(sig(runPowershell(text, ctx))).not.toContain(DENY)
  })
})

describe("too-complex", () => {
  const opaque = ["$(printf rm) -rf x", "rm -rf $DIR", "bash -c $X", "echo x > $(echo f)", "rm -rf $HOME", "rm {a,/}", "echo $(pwd)", "cat <<EOF\n$HOME\nEOF"]
  test.each(opaque)("%j is opaque", (text) => {
    expectHit(run(text), complex("opaque"))
  })

  const semantic = [
    ["eval ls", "eval-like"],
    ["source x.sh", "eval-like"],
    [". x.sh", "eval-like"],
    ["exec ls", "eval-like"],
    ["nohup eval x", "eval-like"],
    ["command ls", "eval-like"],
    ["fc -s", "eval-like"],
    ["compgen -C x", "eval-like"],
    ["let x=1", "eval-like"],
    ["trap 'x' EXIT", "eval-like"],
    ["enable -f x y", "eval-like"],
    ["hash -p /x ls", "eval-like"],
    ["alias x=y", "eval-like"],
    ["mapfile -C cb a", "eval-like"],
    ["coproc ls", "eval-like"],
    ["noglob ls", "eval-like"],
    ["zmodload zsh/system", "zsh-builtin"],
    ["test -v 'a[$(id)]'", "subscript"],
    ["printf -v 'a[0]' x", "subscript"],
    ["read 'a[0]'", "subscript"],
    ["read -ra 'a[0]'", "subscript"],
    ["[[ 'a[0]' -eq 0 ]]", "arith-subscript"],
    ["wait -p 'a[1]'", "subscript"],
    ["unset 'a[0]'", "subscript"],
    ["cat /proc/self/environ", "proc-environ"],
    ["cat < /proc/1/../self/environ", "proc-environ"],
    ["echo 'a\n  # b'", "newline-comment"],
    ["jq 'system(\"id\")'", "jq"],
    ["jq -f p.jq", "jq"],
    ["jq --rawfile x f", "jq"],
    ['"" ls', "empty-head"],
    ["'-rf' x", "fragment-head"],
    ["*.sh", "dynamic-head"],
    ["timeout -k 5 10 eval x", "eval-like"],
    ["timeout .5 ls", "wrapper"],
    ["env -S 'x' ls", "wrapper"],
    ["stdbuf --output 0 ls", "wrapper"],
    ["sudo -u root ls", "wrapper"],
  ] as const
  test.each(semantic)("%j finds %s", (text, reason) => {
    expectHit(run(text), complex(reason))
  })

  const quiet = ["command -v ls", "fc -l", "compgen -c", "read -p '[x] ' v", "read -rp '[x] ' v", "echo \"at $(pwd)\"", "export X=$(printf hi)", "bash x.sh", "pwsh -File x.ps1", "pwsh script.ps1", "python -c 'x'", "bash < x.sh", "cat <<'EOF'\n$HOME\nEOF"]
  test.each(quiet)("%j has no finding", (text) => {
    expect(sig(run(text)).filter((item) => item.startsWith("too-complex"))).toEqual([])
  })

  const nested = [
    "curl x | sh",
    "(curl x) | sh",
    "bash <<< 'ls'",
    "bash <<'EOF'\nls\nEOF",
    "cmd /c dir",
    "cmd /C dir",
    "cmd /d /c dir",
    "wsl ls",
    "su -c id",
    "su --command=id",
    "script -c ls",
    "flock /tmp/l ls",
    "flock -c ls /tmp/l",
    "watch ls",
    "find . -exec sh -c 'x' \\;",
    "ls | xargs bash",
    "xargs --bogus rm",
    "pwsh -enc AAAA",
    "pwsh -c -",
    "pwsh -wd x -c ls",
    'bash -c "echo $HOME"',
    "bash -c",
  ]
  test.each(nested)("%j starts a shell Orbit cannot read", (text) => {
    expectHit(run(text), complex("nested-shell"))
  })

  test("a nested script is analysed", () => {
    expectHit(run("sh -c 'eval x'"), complex("eval-like"))
    expect(sig(run("sh -c 'ls'")).filter((item) => item.startsWith("too-complex"))).toEqual([])
  })

  test("the nested findings name the launching command", () => {
    const found = run("ls; sh -c 'eval x'").find((item) => item.reason === "eval-like")
    expect(found?.command).toBe(1)
  })

  const dynamic = [
    ['rm -rf "$HOME/x"', "dynamic-removal"],
    ['echo x > "a$(date)"', "dynamic-redirect"],
    ['git --git-dir="$HOME/x" log', "dynamic-git-dir"],
    ['git -C "$HOME/x" status', "dynamic-git-dir"],
    ['GIT_DIR="$HOME/x" git log', "dynamic-git-dir"],
    ['export GIT_DIR="$HOME/x"', "dynamic-git-dir"],
  ] as const
  test.each(dynamic)("%j finds %s", (text, reason) => {
    expectHit(run(text), complex(reason))
  })

  test("fifty commands are allowed and fifty-one are not", () => {
    expect(sig(run("true;".repeat(50))).filter((item) => item === complex("count"))).toEqual([])
    expectHit(run("true;".repeat(51)), complex("count"))
  })

  test("the commands of a nested script are counted", () => {
    expectHit(run(`${"true;".repeat(25)} bash -c '${"true;".repeat(30)}'`), complex("count"))
  })

  test("four levels of nesting are too deep and three are not", () => {
    const wrap = (script: string) => `bash -c "${script.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    const three = wrap(wrap(wrap("ls")))
    expect(sig(run(three)).filter((item) => item === complex("depth"))).toEqual([])
    expectHit(run(wrap(three)), complex("depth"))
  })

  test("an unanalysed shell gives dialect", () => {
    const ctx = linux({ shell: "/usr/bin/fish" })
    expectHit(ShellSafety.check(ShellAnalysis.analyze("ls", ctx), options(ctx, "ls")), complex("dialect"))
  })

  test("a computed PowerShell command name is a finding and an expression statement is not", () => {
    expectHit(runPowershell("& $cmd x"), complex("dynamic-head"))
    expect(sig(runPowershell("$x = 5")).filter((item) => item.startsWith("too-complex"))).toEqual([])
  })

  test("a too-complex finding may be lifted by an exact allow rule, and nothing else may", () => {
    expect(run("eval x").every((item) => item.exact)).toBe(true)
    expect(run("rm -rf /").every((item) => !item.exact)).toBe(true)
  })
})

describe("cd and git", () => {
  const finding = [
    "cd sub && git status",
    "pushd /tmp/x && git status",
    "cd sub && nice git status",
    "cd sub && timeout 5 git log",
    "cd sub && /usr/bin/git status",
    "cd sub && git ls-files | xargs git log",
    "cd sub && find . -exec git log {} \\;",
    "cd sub && bash -c 'git status'",
    "bash -c 'cd sub && git status'",
    "X=1 cd sub && git status",
  ]
  test.each(finding)("%s asks", (text) => {
    expectHit(run(text), "cd-git:cd-git:ask")
  })

  const none = ["cd /work && git status", "git status && cd /work", "cd sub && ls", "git -C sub status"]
  test.each(none)("%s does not", (text) => {
    expect(sig(run(text)).filter((item) => item.startsWith("cd-git"))).toEqual([])
  })

  const shell = [
    ["Set-Location x; git log", pwsh()],
    ["sl x; git log", pwsh()],
    ["Push-Location x; git.exe status", pwsh()],
    ["Set-Location C:\\work; git status", pwsh({ cwd: "C:\\work" })],
  ] as const
  test.each(shell)("PowerShell %s asks, with no exception for the working folder", (text, ctx) => {
    expectHit(runPowershell(text, ctx), "cd-git:cd-git:ask")
  })

  test("PowerShell needs more than one command", () => {
    expect(runPowershell("Set-Location x")).toEqual([])
  })

  test("a git started by path counts in PowerShell", () => {
    expectHit(runPowershell("& 'C:\\Program Files\\Git\\cmd\\git.exe' status; Set-Location x"), "cd-git:cd-git:ask")
  })
})

describe("bare repositories and git-internal files", () => {
  test("the guard's bare-repository facts ask only when git runs", () => {
    const facts = { bare: [{ base: "/work", why: "indicators" as const }] }
    expectHit(run("git status", linux(), { facts }), "bare-repo:indicators:ask")
    expect(run("ls", linux(), { facts })).toEqual([])
    expect(run("git status", linux(), { facts: { bare: [] } })).toEqual([])
  })

  test.each(["indicators", "unverified-gitdir", "git-dir"] as const)("%s is its own reason", (why) => {
    expectHit(run("git status", linux(), { facts: { bare: [{ base: "/work", why }] } }), `bare-repo:${why}:ask`)
  })

  const writes = [
    "mkdir -p hooks && echo x > hooks/pre-commit && git status",
    "touch HEAD && git status",
    "cp a refs/heads/x && git log",
    "echo x > ./objects/ab && git status",
    "echo x > /work/hooks/x && git status",
    "echo x > ../work/hooks/x && git status",
    "touch hooks/* && git status",
    "touch .git/config && git status",
    "tar -xf a.tar && git status",
    "unzip a.zip && git status",
  ]
  test.each(writes)("%s asks", (text) => {
    expect(sig(run(text)).filter((item) => item.startsWith("git-internal")).length).toBeGreaterThan(0)
  })

  test("a write is found case-insensitively on Windows", () => {
    expectHit(run("echo x > HOOKS/x && git status", windows()), "git-internal:internal-write:ask")
  })

  test("PowerShell cmdlets and archives count", () => {
    expectHit(runPowershell("New-Item hooks/pre-commit; git status"), "git-internal:internal-write:ask")
    expectHit(runPowershell("Expand-Archive a.zip; git status"), "git-internal:archive:ask")
  })

  const none = ["mkdir hooks", "rm -rf hooks && git status", "touch src/hooks/x && git status", "touch HEAD", "tar -xf a.tar"]
  test.each(none)("%s does not", (text) => {
    expect(sig(run(text)).filter((item) => item.startsWith("git-internal"))).toEqual([])
  })

  test("HEAD is case-sensitive on Linux", () => {
    expect(sig(run("touch head && git status")).filter((item) => item.startsWith("git-internal"))).toEqual([])
  })
})

describe("PowerShell security checks", () => {
  const rows = [
    ["iex $s", "invoke-expression"],
    ["Invoke-Expression 'x'", "invoke-expression"],
    ["pwsh -c x", "nested-powershell"],
    ["powershell.exe -e AAAA", "encoded-command"],
    ["pwsh \u2013enc AAAA", "encoded-command"],
    ["iwr u | iex", "download-run"],
    ["$r = irm u; iex $r", "download-run"],
    ["Start-BitsTransfer u f", "download-tool"],
    ["certutil -urlcache -f u f", "download-tool"],
    ["certutil /URLCACHE u f", "download-tool"],
    ["bitsadmin /transfer j u f", "download-tool"],
    ["Add-Type -TypeDefinition 'x'", "add-type"],
    ["New-Object -ComObject WScript.Shell", "com-object"],
    ["New-Object -com x", "com-object"],
    ["New-Object System.Net.WebClient", "new-object-type"],
    ["New-Object -TypeName:System.Net.WebClient", "new-object-type"],
    ["Invoke-Command -FilePath x.ps1", "script-file"],
    ["icm -f x.ps1", "script-file"],
    ["Start-Job x.ps1", "script-file"],
    ["Invoke-Item x", "invoke-item"],
    ["ii .", "invoke-item"],
    ["Register-ScheduledTask -TaskName x", "scheduled-task"],
    ["schtasks /create /tn x", "scheduled-task"],
    ["Get-Process | ForEach-Object -MemberName Kill", "member-name"],
    ["Get-ChildItem | % Delete", "member-name"],
    ["Start-Process x -Verb RunAs", "elevation"],
    ["Start-Process x -Verb:'Run`As'", "elevation"],
    ["saps pwsh", "start-powershell"],
    ["Get-Process | ForEach-Object { $_ }", "script-block"],
    ["Get-Process | Where-Object { $_.CPU -gt 1 }", "member-access"],
    ['"$env:PATH"', "expandable-string"],
    ["Get-Process @p", "splatting"],
    ["cmd --% /c dir", "stop-parsing"],
    ["$env:FOO = 'x'", "env-write"],
    ["Set-Item env:FOO x", "env-write"],
    ["Import-Module x", "module"],
    ["ipmo x", "module"],
    ["Install-Module x", "module"],
    ["Set-Alias x y", "alias-variable"],
    ["sal x y", "alias-variable"],
    ["Set-Variable x 1", "alias-variable"],
    ["nv x 1", "alias-variable"],
    ["Invoke-WmiMethod -Class Win32_Process -Name Create", "wmi"],
    ["Invoke-CimMethod -ClassName x -MethodName y", "wmi"],
    ["using namespace System.Text", "using"],
    ["#Requires -Modules x", "requires"],
    ["[System.Reflection.Assembly]::Load($b)", "type-literal"],
    ["[Diagnostics.Process]::Start('x')", "type-literal"],
    ["[adsi]'LDAP://x'", "type-literal"],
  ] as const
  test.each(rows)("%j finds %s", (text, reason) => {
    expectHit(runPowershell(text), `powershell:${reason}:ask`)
  })

  test("a computed name is reported once, as too-complex", () => {
    expectHit(runPowershell("& ('i'+'ex') x"), complex("dynamic-head"))
  })

  test("a script block that is not a filter asks and a filter does not", () => {
    // Where-Object is a filter, so a script block next to nothing else asks nothing on its own; ForEach-Object is not one.
    expect(sig(runPowershell("Where-Object { 1 }"))).not.toContain("powershell:script-block:ask")
    expect(sig(runPowershell("Get-Process | Where-Object { $_.CPU -gt 1 }"))).toContain("powershell:script-block:ask")
  })

  test("a type from the Constrained Language list is allowed", () => {
    expect(sig(runPowershell("New-Object System.Collections.Hashtable"))).not.toContain("powershell:new-object-type:ask")
  })

  const quiet = ["Get-ChildItem", "Get-Content x | Select-Object -First 5", "Get-Process | Where-Object Name -like 'a*'", "[int]'5'", "[string[]]$a", "'plain'"]
  test.each(quiet)("%j has no finding", (text) => {
    expect(sig(runPowershell(text)).filter((item) => item.startsWith("powershell"))).toEqual([])
  })

  test("the PowerShell checks only ask", () => {
    const all = rows.flatMap(([text]) => runPowershell(text).filter((item) => item.kind === "powershell"))
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((item) => item.decision === "ask" && !item.exact)).toBe(true)
  })
})

describe("nested scripts", () => {
  test("nesting only adds: the outer analysis keeps its commands, paths, count and read-only answer", () => {
    const ctx = linux()
    const outer = bash("bash -c 'rm x'", ctx)
    const nested = nest(outer, ctx)
    expect(nested.nested).toHaveLength(1)
    expect(nested.commands).toEqual(outer.commands)
    expect(nested.paths).toEqual(outer.paths)
    expect(nested.count).toBe(outer.count)
    expect(nested.readOnly).toBe(outer.readOnly)
    // The removal belongs to the nested script only, so a rule for `rm x` never matches the launching command.
    expect(outer.paths.files).toEqual([])
    expect(nested.nested![0].analysis.commands[0].origin).toBe("script")
  })

  test("a script file, an interpreter one-liner and a pipe-free shell are not scripts", () => {
    const ctx = linux()
    for (const text of ["bash x.sh", "pwsh -File x.ps1", "pwsh script.ps1", "python -c 'x'", "bash < x.sh"]) expect(bash(text, ctx).scripts).toBeUndefined()
    expect(bash("bash -c 'ls'", ctx).scripts).toEqual([{ command: 0, dialect: "bash", program: "bash", text: "ls" }])
  })

  test("a script below three levels is marked deep and nothing is parsed past it", () => {
    const ctx = linux()
    const level = (script: string) => `bash -c '${script.replaceAll("'", "'\\''")}'`
    const found = nest(bash(level(level(level(level("ls")))), ctx), ctx)
    const third = found.nested![0].analysis.nested![0].analysis.nested![0].analysis
    expect(third.deep).toBe(true)
    expect(third.nested).toBeUndefined()
  })

  test("a script that cannot be parsed is opaque", () => {
    const ctx = linux()
    const found = ShellAnalysis.nest(bash("pwsh -c 'Get-Thing'", ctx), ctx, () => undefined)
    expect(found.nested![0].analysis.opaque?.reason).toBe("nested:parse")
  })

  test("Windows PowerShell 5.1 takes a first positional argument as a command and pwsh 7 as a file", () => {
    const five = windows({ shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })
    expectHit(runPowershell("powershell Remove-Item ~", five), DENY)
    expect(bash("powershell Remove-Item ~", windows()).scripts?.[0].text).toBe("Remove-Item ~")
    expect(bash("pwsh x.ps1", windows()).scripts).toBeUndefined()
  })

  test("PowerShell launching pwsh or bash is analysed and also asks", () => {
    const ctx = pwsh()
    const found = runPowershell("pwsh -c 'Remove-Item -Recurse ~'", ctx)
    expectHit(found, DENY)
    expectHit(found, "powershell:nested-powershell:ask")
    expectHit(runPowershell("bash -c 'rm -rf ~'", ctx), ASK)
  })

  const piped = ["'ls' | bash", "'ls' | pwsh", "cmd /c dir"]
  test.each(piped)("PowerShell %s starts a shell Orbit cannot read", (text) => {
    expectHit(runPowershell(text), complex("nested-shell"))
  })

  test("PowerShell removal operands that are unknown are too complex, not critical", () => {
    expectHit(runPowershell("Remove-Item ~user/x"), complex("dynamic-removal"))
    expect(sig(runPowershell("Remove-Item ~user/x")).filter((item) => item.startsWith("critical-removal"))).toEqual([])
  })

  test("PowerShell starting a script file is not a nested shell", () => {
    expect(sig(runPowershell("pwsh -File x.ps1")).filter((item) => item.startsWith("too-complex"))).toEqual([])
    expect(sig(runPowershell("pwsh x.ps1")).filter((item) => item.startsWith("too-complex"))).toEqual([])
  })
})

// One removal target spelled in every way a model or a shell can spell it, against every dialect that runs it.
describe("removal targets: spellings by dialects", () => {
  const home = [
    ["bash", "rm -rf ~", linux()],
    ["bash", "rm -rf ~/", linux()],
    ["bash", "rm -rf '/home/u'", linux()],
    ["bash", "rm -rf /home/u/.", linux()],
    ["bash", "rm -rf /home/u/../u", linux()],
    ["bash", "rm -rf /home//u", linux()],
    ["Git Bash", "rm -rf ~", windows()],
    ["Git Bash", "rm -rf /c/Users/u", windows()],
    ["Git Bash", "rm -rf 'C:\\Users\\U'", windows()],
    ["Git Bash", "rm -rf C:/Users/u/", windows()],
  ] as const
  test.each(home)("%s %s asks", (_, text, ctx) => {
    expectHit(run(text, ctx), ASK)
  })

  const refused = [
    ["pwsh", "Remove-Item ~", pwsh()],
    ["pwsh", "Remove-Item C:/", pwsh()],
    ["pwsh", "ri C:\\Windows", pwsh()],
    ["pwsh", "del C:\\Windows", pwsh()],
    ["pwsh", "REMOVE-ITEM ~", pwsh()],
    ["pwsh", "Remove-Item build\\*", pwsh()],
    ["powershell 5.1", "Remove-Item C:", windows({ shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })],
  ] as const
  test.each(refused)("%s %s is refused", (_, text, ctx) => {
    expectHit(runPowershell(text, ctx), DENY)
  })

  test("no allow rule or exact flag lifts a removal", () => {
    for (const [, text, ctx] of home) expect(run(text, ctx).filter((item) => item.kind === "critical-removal").every((item) => !item.exact)).toBe(true)
  })
})

describe("inspect with nested scripts", () => {
  const unused = Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("not used") })

  test("reads nested bash scripts to three levels and only when asked", async () => {
    const ctx = linux()
    const text = "bash -c 'sh -c \"eval x\"'"
    const plain = await Effect.runPromise(ShellAnalysis.inspect(text, ctx).pipe(unused))
    expect(plain.nested).toBeUndefined()
    const found = await Effect.runPromise(ShellAnalysis.inspect(text, ctx, { nested: true }).pipe(unused))
    expect(found.nested?.[0].analysis.nested?.[0].analysis.commands[0].argv[0].value).toBe("eval")
    expectHit(ShellSafety.check(found, options(ctx, text)), complex("eval-like"))
  })

  test("a bash input with no nested script never touches the PowerShell host", async () => {
    const found = await Effect.runPromise(ShellAnalysis.inspect("ls", linux(), { nested: true }).pipe(unused))
    expect(found.nested).toBeUndefined()
  })
})

describe("ordering and fixed text", () => {
  test("a refusal comes first, then the other kinds in order, with every finding present", () => {
    const text = "Remove-Item C:/; iex $s; Set-Location x; git status"
    const analysis = ShellAnalysis.analyze(text, pwsh(), { valid: false, reason: "parse-errors" })
    const found = ShellSafety.check(analysis, options(pwsh(), text))
    expect(sig(found)[0]).toBe(DENY)
    expectHit(found, complex("opaque"))
  })

  test("no message or reason carries text from the command", () => {
    const text = "rm -rf '/SECRET-MARKER'"
    const found = run(text)
    expect(found.length).toBeGreaterThan(0)
    // Only the place, which ShellPaths has already cleaned, is allowed to show the command's own text.
    expect(found.every((item) => !item.message.includes("SECRET-MARKER") && !item.reason.includes("SECRET-MARKER"))).toBe(true)
  })

  test("Windows rows use the injected path module on any host", () => {
    expect(path.win32.sep).toBe("\\")
    expectHit(run("rm -rf C:/Windows", windows()), ASK)
  })
})
