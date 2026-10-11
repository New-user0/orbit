import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ShellPaths } from "../../src/shell/paths"
import { CMDLETS, type Entry } from "../../src/shell/paths-table"
import { bash, linux, powershell, pwsh, pwshLinux, windows } from "./helper"
import { pathCases } from "./path-cases"
import win51 from "./cmdlets-win51.json"
import linux7 from "./cmdlets-linux7.json"

// What a command does to which files, as data (src/shell/paths.ts). Each cell is `role candidates [flags] (form)`; a
// dynamic operand has no candidates and shows its spelling. The platform is injected, so the Windows rows run on every
// host, and PowerShell rows use the parser's recorded answers (record-powershell.ts).
type Case = [text: string, files: string[]]

function cell(item: ShellPaths.Operand) {
  const where = item.candidates.length > 0 ? item.candidates.join("|") : item.spelled
  const flags = item.flags.length > 0 ? ` [${item.flags.join(",")}]` : ""
  const form = item.form === "literal" ? "" : ` (${item.form})`
  return `${item.role}${item.via === "redirect" ? "<" : ""} ${where}${flags}${form}`
}

const files = (result: ReturnType<typeof bash>) => result.paths.files.filter((item) => item.role !== "read").map(cell)
const reasons = (result: ReturnType<typeof bash>) => result.paths.unvalidatable.map((item): string => item.reason)

describe("bash extraction", () => {
  const rows: Case[] = [
    ["rm -rf build dist", ["remove /work/build", "remove /work/dist"]],
    ["rm -- -x", ["remove /work/-x"]],
    ["rmdir -p a/b", ["remove /work/a/b"]],
    ["unlink f", ["remove /work/f"]],
    ["shred -u -n 3 f", ["remove /work/f"]],
    ["shred -n 3 f", ["write /work/f"]],
    ["mv a b", ["remove /work/a", "write /work/b"]],
    ["mv a b dir/", ["remove /work/a", "remove /work/b", "write /work/dir"]],
    ["cp a b", ["source /work/a", "write /work/b"]],
    ["cp ~/k ./k", ["source /home/u/k", "write /work/k"]],
    ["install -m 644 a /x", ["source /work/a", "write /x"]],
    ["install -d a b", ["create /work/a", "create /work/b"]],
    ["install -t dest a", ["write /work/dest", "source /work/a"]],
    ["ln -s t l", ["source /work/t", "create /work/l"]],
    ["ln -s t", ["source /work/t", "create /work"]],
    ["mkdir -m 755 d", ["create /work/d"]],
    ["mkdir -p a/b c", ["create /work/a/b", "create /work/c"]],
    ["touch -r ref f", ["source /work/ref", "create /work/f"]],
    ["touch -d 'next week' f", ["create /work/f"]],
    ["tee -a log", ["write /work/log"]],
    ["truncate -s 0 f", ["write /work/f"]],
    ["truncate -r ref f", ["source /work/ref", "write /work/f"]],
    ["chmod -R 755 d", ["write /work/d"]],
    ["chmod -x f", ["write /work/f"]],
    ["chmod --reference=r f", ["source /work/r", "write /work/f"]],
    ["chown u:g f", ["write /work/f"]],
    ["chgrp g f", ["write /work/f"]],
    ["dd if=/dev/zero of=img bs=1M", ["source /dev/zero", "write /work/img"]],
    ["sed -i s/a/b/ f g", ["write /work/f", "write /work/g"]],
    ["sed -i.bak s/a/b/ f", ["write /work/f"]],
    ["sed --in-place -e s/a/b/ f", ["write /work/f"]],
    ["sed -i -f s.sed f", ["source /work/s.sed", "write /work/f"]],
    ["sed -n p f", []],
    ["timeout 5 rm x", ["remove /work/x"]],
    ["nice -n 5 mv a b", ["remove /work/a", "write /work/b"]],
    ["env A=1 rm x", ["remove /work/x"]],
    ["sudo rm x", ["remove /work/x"]],
    ["nohup touch x", ["create /work/x"]],
    ["cat a b", []],
    ["echo hi", []],
  ]
  test.each(rows)("%s", (text, expected) => {
    const result = bash(text)
    expect(files(result)).toEqual(expected)
    expect(reasons(result)).toEqual([])
  })

  const refused: [string, string[], string[]][] = [
    ["rm --frobnicate x", ["remove /work/x"], ["option"]],
    ["rm a -/../x", ["remove /work/a"], ["option"]],
    ["mv -f a b", ["remove /work/a", "write /work/b"], ["option"]],
    ["mv -- a b", ["remove /work/a", "write /work/b"], ["option"]],
    ["mv -t d a", ["write /work/d", "remove /work/a"], ["option"]],
    ["cp -t dest a b", ["write /work/dest", "source /work/a", "source /work/b"], ["option"]],
    ["cp --target-directory=dest a", ["write /work/dest", "source /work/a"], ["option"]],
    ["cp -r a b", ["source /work/a", "write /work/b"], ["option"]],
    ["ls | xargs rm", [], ["stdin"]],
    ["find . -name x | xargs mv", [], ["stdin"]],
    ["dd of", [], ["operand"]],
  ]
  test.each(refused)("%s is unvalidatable but reports what it can", (text, expected, why) => {
    const result = bash(text)
    expect(files(result)).toEqual(expected)
    expect(reasons(result)).toEqual(why)
    expect(result.paths.fileEdit).toBe(false)
  })

  test("macOS tools stop reading options at the first operand, so a later dash word is a path", () => {
    const result = bash("rm a -/../x", linux({ platform: "darwin" }))
    expect(files(result)).toEqual(["remove /work/a", "remove /work/x"])
    expect(reasons(result)).toEqual([])
  })

  test("a wrapper that cannot be read leaves the command unvalidatable", () => {
    expect(reasons(bash("timeout --frob 5 rm x"))).toContain("wrapper")
  })

  test("a path-valued option is reported with its role even clustered", () => {
    expect(files(bash("install -dm755 x"))).toEqual(["create /work/x"])
  })
})

describe("bash redirects", () => {
  const rows: Case[] = [
    ["echo hi > out", ["write< /work/out"]],
    ["> f", ["write< /work/f"]],
    ["echo a >> log", ["write< /work/log"]],
    ["cmd 2>/dev/null", []],
    ["cmd >/dev/null 2>&1", []],
    ["cmd >&2", []],
    ["cmd 2>&1", []],
    ["cmd &> log", ["write< /work/log"]],
    ["cmd &>> log", ["write< /work/log"]],
    ["cmd >| log", ["write< /work/log"]],
    ["cmd >& log", ["write< /work/log"]],
    ["cat < in", []],
    ["cat <<< x", []],
    ["if true; then echo a > f; fi", ["write< /work/f"]],
  ]
  test.each(rows)("%s", (text, expected) => {
    const result = bash(text)
    expect(result.opaque).toBeUndefined()
    expect(files(result)).toEqual(expected)
  })

  test("an input redirect is a read, not a write", () => {
    expect(bash("cat < in").paths.files.map(cell)).toEqual(["read /work/in"])
  })
})

describe("forms and flags", () => {
  const rows: [string, ReturnType<typeof linux>, string[]][] = [
    ["rm *.log", linux(), ["remove /work (glob)"]],
    ["rm build/*", linux(), ["remove /work/build (glob)"]],
    ["rm proj/*/../../etc/x", linux(), ["remove /work/etc/x (glob)"]],
    ["rm 'a*b'", linux(), ["remove /work/a*b"]],
    ["rm 'a*b'", windows(), ["remove C:\\work (glob)"]],
    ['rm "$HOME/x"', linux(), ["remove <unknown>/x (dynamic)"]],
    ['D=/tmp/x; rm "$D"', linux(), ["remove /tmp/x"]],
    ["rm ~/x", linux(), ["remove /home/u/x"]],
    ["rm ~", linux(), ["remove /home/u"]],
    ["rm ~root/x", linux(), ["remove ~root/x (dynamic)"]],
    ["HOME=/etc; rm ~/x", linux(), ["remove ~/x [expansion] (dynamic)"]],
    ["rm ~/x", windows({ env: { HOME: "D:\\h" } }), ["remove D:\\h\\x"]],
    ["rm ~/x", windows(), ["remove C:\\Users\\u\\x"]],
    ["touch 100%.txt", linux(), ["create 100%.txt [expansion] (dynamic)"]],
    ["rm 'a$b'", linux(), ["remove a$b [expansion] (dynamic)"]],
    ["rm /c/Users/u/x", windows(), ["remove C:\\Users\\u\\x"]],
    ["rm C:\\Users\\x", windows(), ["remove C:Usersx [drive-relative] (dynamic)"]],
    ["rm '\\\\srv\\share\\x'", windows(), ["remove \\\\srv\\share\\x [share]"]],
    ["rm '//srv/share/x'", windows(), ["remove //srv/share/x [share]"]],
    ["rm '\\\\10.255.255.1\\s'", windows(), ["remove \\\\10.255.255.1\\s [share]"]],
    ["rm '\\\\?\\C:\\x'", windows(), ["remove \\\\?\\C:\\x [device,share]"]],
    ["rm 'f.txt:s'", windows(), ["remove C:\\work\\f.txt:s [stream]"]],
    ["rm 'f::$DATA'", windows(), ["remove f::$DATA [expansion,stream,drive-relative] (dynamic)"]],
    ["rm 'PROGRA~1/x'", windows(), ["remove C:\\work\\PROGRA~1\\x [short-name]"]],
    ["rm 'x. '", windows(), ["remove C:\\work\\x [trailing]"]],
    ["rm '.../x'", windows(), ["remove C:\\work\\...\\x [dots]"]],
    ["rm '//srv/share/x'", linux(), ["remove /srv/share/x"]],
    ["rm 'f.txt:s'", linux(), ["remove /work/f.txt:s"]],
  ]
  test.each(rows.map((row) => ({ text: row[0], ctx: row[1], expected: row[2], name: `${row[0]} on ${row[1].platform}` })))("$name", ({ text, ctx, expected }) => {
    expect(files(bash(text, ctx))).toEqual(expected)
  })

  test("brace expansion and a bare variable are too complex", () => {
    expect(bash("rm {a,b}").opaque?.reason).toBe("word:brace")
    expect(bash("rm $HOME/x").opaque?.reason).toBe("var:unknown")
    expect(bash("rm {a,b}").paths).toEqual(ShellPaths.empty())
  })

  test("a glob keeps the folder before the wildcard as its prefix", () => {
    const item = bash("rm build/*.log").paths.files[0]
    expect(item.prefix).toBe("build")
    expect(bash("rm *.log").paths.files[0].prefix).toBe(".")
    expect(bash("rm proj/*/../../etc/x").paths.files[0].prefix).toBe("proj/*/../../etc/x")
  })

  test("a share or a device has no candidate place, so the guard never touches the disk for it", () => {
    for (const text of ["rm '\\\\srv\\share\\x'", "rm '//srv/share/x'", "rm '\\\\?\\C:\\x'", "rm '\\\\.\\pipe\\x'"]) {
      const item = bash(text, windows()).paths.files[0]
      expect(item.candidates).toEqual([])
      expect(item.flags.some((flag) => flag === "share" || flag === "device")).toBe(true)
    }
  })

  test("what is shown has control and bidi characters replaced", () => {
    const item = bash("rm 'a\u009b]0;x\u202eb'").paths.files[0]
    expect(item.spelled).not.toMatch(/[\u009b\u202e]/)
  })

  test("an unknown part is shown as a placeholder, never as the marker", () => {
    const item = bash('rm "$(date)/x"').paths.files[0]
    expect(item.spelled).toBe("<unknown>/x")
    expect(item.form).toBe("dynamic")
  })
})

describe("directory changes", () => {
  test("a target adds a base; later operands resolve from every base", () => {
    const result = bash("cd sub && rm x")
    expect(result.paths.directoryChanges).toBe(1)
    expect(files(result)).toEqual(["remove /work/x|/work/sub/x"])
  })

  test("each change adds to the bases", () => {
    const result = bash("cd a; cd b; rm x")
    expect(result.paths.directoryChanges).toBe(2)
    expect(files(result)).toEqual(["remove /work/x|/work/a/x|/work/b/x|/work/a/b/x"])
  })

  test.each(["cd - && rm x", "popd && rm x", "pushd && rm x", "cd a b && rm x", "cd -2 && rm x"])("%s leaves a relative path unknown", (text) => {
    expect(files(bash(text))).toEqual(["remove x [directory] (dynamic)"])
  })

  test("an absolute path stays known after a change that leads nowhere known", () => {
    expect(files(bash("cd - && rm /tmp/x"))).toEqual(["remove /tmp/x"])
  })

  test("CDPATH makes a bare target unknown, but not ./ ../ or /", () => {
    const env = linux({ env: { CDPATH: "/z" } })
    expect(files(bash("cd sub && rm x", env))).toEqual(["remove x [directory] (dynamic)"])
    expect(files(bash("cd ./sub && rm x", env))).toEqual(["remove /work/x|/work/sub/x"])
    expect(files(bash("cd ../up && rm x", env))).toEqual(["remove /work/x|/up/x"])
  })

  test("a leading cd into the working folder changes nothing and is not counted", () => {
    const result = bash("cd /work && mkdir x")
    expect(result.paths.directoryChanges).toBe(0)
    expect(files(result)).toEqual(["create /work/x"])
  })

  test("cd with no argument goes home", () => {
    expect(files(bash("cd; rm x"))).toEqual(["remove /work/x|/home/u/x"])
  })

  test("a wrapped cd is still a directory change", () => {
    expect(bash("timeout 5 cd x; rm y").paths.directoryChanges).toBe(1)
    expect(bash("FOO=1 cd x; rm y").paths.directoryChanges).toBe(1)
  })
})

describe("fileEdit in bash", () => {
  const yes = [
    "mkdir -p build && touch build/a",
    "rm -rf build",
    "rmdir d",
    "mv a b",
    "cp a b",
    "echo hi > notes.txt",
    "mkdir a > log",
    "ls && mkdir x",
    "cat a | tee-not-here",
  ].filter((text) => !text.includes("tee-not-here"))
  test.each(yes)("%s", (text) => expect(bash(text).paths.fileEdit).toBe(true))

  const no = [
    'mv "$A" b',
    "cp -r a b",
    "mv -f a b",
    "timeout 5 rm x",
    "A=1 rm x",
    "sudo rm x",
    "cd sub && touch x",
    "mkdir x && npm test",
    "rm *.log",
    "tee f",
    "install a b",
    "ln -s a b",
    "chmod 600 f",
    "sed -i s/a/b/ f",
    "dd of=x",
    "echo hi > ~root/x",
    "echo hi > $(date)",
    "echo hi >& f; npm test",
    "rm ~root/x",
    "rm a -/../x",
    "ls | xargs rm",
  ]
  test.each(no)("%s", (text) => expect(bash(text).paths.fileEdit).toBe(false))

  test.each(["touch 'x. '", "rm 'f.txt:s'", "rm 'PROGRA~1/x'", "rm '.../x'", "rm '\\\\srv\\s\\x'", "echo a > 'x. '"])("%s on Windows", (text) => {
    expect(bash(text, windows()).paths.fileEdit).toBe(false)
  })

  // Class 4: a reader's operands are reads whatever its redirects are, and a program in the working folder is no `rm`.
  const reading = (text: string, ctx = linux()) =>
    bash(text, ctx)
      .paths.files.filter((item) => item.role === "read")
      .map(cell)
  test.each([
    ["cat ~/.ssh/id_rsa > notes.txt", ["read /home/u/.ssh/id_rsa"], ["write< /work/notes.txt"]],
    ["cat < /etc/shadow > notes", ["read /etc/shadow"], ["write< /work/notes"]],
    ["grep -r secret /etc > out", ["read /etc"], ["write< /work/out"]],
    ["cat /etc/shadow >> log 2>&1", ["read /etc/shadow"], ["write< /work/log"]],
  ])("%s reports the read beside the redirect", (text, read, written) => {
    expect(reading(text)).toEqual(read)
    expect(files(bash(text))).toEqual(written)
  })

  // A read-class command that fails the read-only check still reads what it names; no allow rule may hide that.
  test.each([
    ["sort -o out /etc/shadow", ["read /work/out", "read /etc/shadow"]],
    ["find /etc -delete", ["read /etc"]],
    ["find ~/.ssh -exec cat {} +", ["read /home/u/.ssh", "read /work/cat", "read /work/{}", "read /work/+"]],
    ["timeout 5 cat /etc/shadow > out", ["read /etc/shadow"]],
    ["nice cat /etc/shadow > out", ["read /etc/shadow"]],
    ["A=1 cat /etc/shadow > out", ["read /etc/shadow"]],
    ["cat /etc/shadow > out", ["read /etc/shadow"]],
    ["git diff --no-index /etc/shadow x", ["read /etc/shadow", "read /work/x"]],
    ["git status /etc", []],
  ])("%s reports its reads", (text, read) => {
    expect(reading(text)).toEqual(read)
  })

  test.each(["PATH=bin; rm x", "PATH=/work/bin; rm x", "for PATH in bin; do rm x; done"])("%s is no edit", (text) => {
    expect(bash(text).paths.fileEdit).toBe(false)
  })
  test("an unrelated assignment stays an edit", () => expect(bash("FOO=1; rm x").paths.fileEdit).toBe(true))

  test.each([
    ["echo a > '~/x'", ["write< /work/~/x"]],
    ['echo a > "~"/x', ["write< /work/~/x"]],
    ["dd if='~/x' of=y", ["source /work/~/x", "write /work/y"]],
    ['dd if=~/"x y" of=y', ["source /home/u/x y", "write /work/y"]],
  ])("%s keeps a quoted tilde literal", (text, expected) => {
    expect(files(bash(text))).toEqual(expected)
  })

  test("a reader that is not read-only asks, so it is not an edit", () => {
    for (const text of ["find /etc -delete", "sort -o out /etc/shadow"]) expect(bash(text).paths.fileEdit).toBe(false)
  })

  test("mkdir --context takes an optional value, so the next word is a path", () => {
    const result = bash("mkdir --context /tmp/evil")
    expect(files(result)).toEqual(["create /tmp/evil"])
    expect(reasons(result)).toEqual([])
    expect(files(bash("mkdir --context=x d"))).toEqual(["create /work/d"])
  })

  test.each([
    ["rm x", linux({ local: (head: string) => head === "rm" })],
    ["rm x", linux({ env: { PATH: ":/usr/bin" } })],
    ["rm x", linux({ env: { PATH: "bin:/usr/bin" } })],
    ["cp a b", linux({ env: { PATH: "/usr/bin:" } })],
  ])("%s is no edit when the program may be the project's own", (text, ctx) => {
    expect(bash(text, ctx).paths.fileEdit).toBe(false)
  })

  test("the same commands are edits with a system PATH", () => {
    expect(bash("rm x", linux({ local: (head: string) => head === "other" })).paths.fileEdit).toBe(true)
    expect(bash("rm x", linux({ env: { PATH: "/usr/bin" } })).paths.fileEdit).toBe(true)
  })

  test.each([
    ["rm '~/x'", ["remove /work/~/x"]],
    ["rm ~/x", ["remove /home/u/x"]],
    ["touch --reference=~/x f", ["source /work/~/x", "create /work/f"]],
    ["dd if=~/x of=~/y", ["source /home/u/x", "write /home/u/y"]],
    ["echo a > ~/x", ["write< /home/u/x"]],
  ])("%s", (text, expected) => {
    expect(files(bash(text))).toEqual(expected)
  })

  test("an opaque input has no facts", () => {
    const result = bash("rm {a,b}")
    expect(result.paths).toEqual(ShellPaths.empty())
  })
})

describe("PowerShell extraction", () => {
  type Row = [text: string, windows: string[], linux: string[], reasons?: { windows?: string[]; linux?: string[] }]
  const rows: Row[] = [
    ["Remove-Item -Path a -Recurse", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["ri a", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["del a", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["Remove-Item -LiteralPath:'a b'", ["remove C:\\work\\a b"], ["remove /work/a b"]],
    ["Remove-Item \u2013Path a", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["Remove-Item -Lit a", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["Remove-Item -ErrorAction SilentlyContinue x", ["remove C:\\work\\x"], ["remove /work/x"]],
    ["Remove-Item -Path a -Force -Recurse:$false", ["remove C:\\work\\a"], ["remove /work/a"]],
    ["Copy-Item a b", ["source C:\\work\\a", "write C:\\work\\b"], ["source /work/a", "write /work/b"]],
    ["Copy-Item -Destination b a", ["write C:\\work\\b", "source C:\\work\\a"], ["write /work/b", "source /work/a"]],
    ["Move-Item a b", ["remove C:\\work\\a", "write C:\\work\\b"], ["remove /work/a", "write /work/b"]],
    ["New-Item -ItemType Directory build", ["create C:\\work\\build"], ["create /work/build"]],
    ["New-Item -Path d -Name f", ["create C:\\work\\d", "create C:\\work\\f", "create C:\\work\\d\\f"], ["create /work/d", "create /work/f", "create /work/d/f"]],
    ["Rename-Item a b", ["remove C:\\work\\a", "write C:\\work\\b"], ["remove /work/a", "write /work/b"]],
    ["Set-Content f 'x'", ["write C:\\work\\f"], ["write /work/f"]],
    ["Add-Content -Path f -Value x", ["write C:\\work\\f"], ["write /work/f"]],
    ["Clear-Content f", ["write C:\\work\\f"], ["write /work/f"]],
    ["Out-File o", ["write C:\\work\\o"], ["write /work/o"]],
    ["Out-File -FilePath o", ["write C:\\work\\o"], ["write /work/o"]],
    ["Export-Csv -Path c.csv", ["write C:\\work\\c.csv"], ["write /work/c.csv"]],
    ["epcsv c.csv", ["write C:\\work\\c.csv"], ["write /work/c.csv"]],
    ["Invoke-WebRequest https://h -OutFile o", ["write C:\\work\\o"], ["write /work/o"]],
    ["iwr https://h", [], []],
    ["Set-Content f x -Stream s", ["write C:\\work\\f [stream]"], ["write /work/f [stream]"]],
    // The edition decides what a short name means.
    ["rm a", ["remove C:\\work\\a"], [], { linux: ["native"] }],
    ["mkdir build", ["create C:\\work\\build"], [], { linux: ["native"] }],
    ["md build", ["create C:\\work\\build"], [], { linux: ["native"] }],
    ["tee t", ["write C:\\work\\t"], [], { linux: ["native"] }],
    ["mv a b", ["remove C:\\work\\a", "write C:\\work\\b"], [], { linux: ["native"] }],
    ["touch x", [], [], { windows: ["native"], linux: ["native"] }],
    ["sc f x", [], []],
    // A value that is not a constant, an unknown or ambiguous parameter, an array.
    ["Remove-Item -P a", ["remove C:\\work\\a"], ["remove /work/a"], { windows: ["parameter"], linux: ["parameter"] }],
    ["Remove-Item -Frobnicate a", ["remove C:\\work\\a"], ["remove /work/a"], { windows: ["parameter"], linux: ["parameter"] }],
    ["Remove-Item a,b", ["remove C:\\work\\a", "remove C:\\work\\b"], ["remove /work/a", "remove /work/b"], { windows: ["array"], linux: ["array"] }],
    ["Remove-Item -Path:$x", ["remove $x (dynamic)"], ["remove $x (dynamic)"], { windows: ["dynamic"], linux: ["dynamic"] }],
    ["Remove-Item $x", ["remove $x (dynamic)"], ["remove $x (dynamic)"], { windows: ["dynamic"], linux: ["dynamic"] }],
    ["Remove-Item $HOME\\x", ["remove $HOME\\x (dynamic)"], ["remove $HOME/x (dynamic)"], { windows: ["dynamic"], linux: ["dynamic"] }],
    ["New-Item -Name ..\\x", [], [], { windows: ["leaf", "no-path"], linux: ["leaf", "no-path"] }],
    ["'a' | Remove-Item", [], [], { windows: ["pipeline"], linux: ["pipeline"] }],
    ["'x' | Tee-Object -FilePath t", ["write C:\\work\\t"], ["write /work/t"], { windows: ["pipeline"], linux: ["pipeline"] }],
    ["Get-ChildItem *.log | Remove-Item", [], [], { windows: ["no-path"], linux: ["no-path"] }],
    ["Remove-Item", [], [], { windows: ["no-path"], linux: ["no-path"] }],
    ["Remove-Item -Path", [], [], { windows: ["parameter", "no-path"], linux: ["parameter", "no-path"] }],
  ]
  test.each(rows.map((row) => ({ text: row[0], onWindows: row[1], onLinux: row[2], why: row[3] })))("$text", ({ text, onWindows, onLinux, why }) => {
    const w = powershell(text, pwsh())
    const l = powershell(text, pwshLinux())
    expect(files(w)).toEqual(onWindows)
    expect(files(l)).toEqual(onLinux)
    expect(reasons(w)).toEqual(why?.windows ?? [])
    expect(reasons(l)).toEqual(why?.linux ?? [])
  })

  test("links are noticed by item type, abbreviated or colon-bound", () => {
    for (const text of ["New-Item -ItemType SymbolicLink -Path l -Value /etc", "New-Item -it:Junction -Path j -Value x"]) {
      expect(powershell(text, pwsh()).paths.links).toBe(true)
      expect(powershell(text, pwshLinux()).paths.links).toBe(true)
    }
    expect(powershell("New-Item -ItemType Directory build", pwsh()).paths.links).toBe(false)
  })

  test("a backtick argument is dynamic, like a backtick redirect", () => {
    expect(files(powershell("Remove-Item a`b", pwsh()))[0]).toContain("(dynamic)")
  })

  test("a backtick in a path flags it", () => {
    expect(files(powershell("Remove-Item a`b", pwsh()))[0]).toContain("[escape]")
  })

  test("a path of the cmdlet's own -Stream is an alternate stream whatever the platform", () => {
    expect(powershell("Set-Content f x -Stream s", pwshLinux()).paths.files[0].flags).toContain("stream")
  })
})

describe("PowerShell redirects", () => {
  const rows: Case[] = [
    ["Get-Date > out.txt", ["write< C:\\work\\out.txt"]],
    ["'x' > f", ["write< C:\\work\\f"]],
    ["Get-Date *> log", ["write< C:\\work\\log"]],
    ['Get-Date > "a b"', ["write< C:\\work\\a b"]],
    ["Get-Date > $null", []],
    ["Get-Date 2>&1", []],
    ["Get-Date > a`b", ["write< a� [escape] (dynamic)"]],
    ["Get-Date > $p", ["write< $p (dynamic)"]],
    ["if ($true) { Get-Date > inner }", ["write< C:\\work\\inner"]],
    ["if ($true) { Remove-Item inner }", ["remove C:\\work\\inner"]],
  ]
  test.each(rows)("%s", (text, expected) => {
    expect(files(powershell(text, pwsh()))).toEqual(expected)
  })

  test("the null device on a POSIX host is not a write", () => {
    expect(files(powershell("Get-Date > /dev/null", pwshLinux()))).toEqual([])
  })
})

describe("PowerShell forms", () => {
  const rows: [string, string[], string[]][] = [
    ["Remove-Item ~/x", ["remove C:\\Users\\u\\x"], ["remove /home/u/x"]],
    ["Remove-Item ~root/x", ["remove ~root/x [expansion] (dynamic)"], ["remove ~root/x [expansion] (dynamic)"]],
    ["Remove-Item env:FOO", ["remove env:FOO [provider] (dynamic)"], ["remove env:FOO [provider] (dynamic)"]],
    ["Remove-Item HKCU:\\x", ["remove HKCU:\\x [provider] (dynamic)"], ["remove HKCU:/x [provider] (dynamic)"]],
    ["Remove-Item FileSystem::C:\\x", ["remove FileSystem::C:\\x [provider] (dynamic)"], ["remove FileSystem::C:/x [provider] (dynamic)"]],
    ["Remove-Item Z:/x", ["remove Z:\\x"], ["remove Z:/x [provider] (dynamic)"]],
    ["Remove-Item C:x", ["remove C:x [drive-relative] (dynamic)"], ["remove C:x [provider] (dynamic)"]],
    ["Remove-Item a\\..\\..\\x", ["remove C:\\x"], ["remove /x"]],
    ["Remove-Item //srv/share/x", ["remove //srv/share/x [share]"], ["remove //srv/share/x [share]"]],
    ["Remove-Item \\\\srv\\share\\x", ["remove \\\\srv\\share\\x [share]"], ["remove //srv/share/x [share]"]],
    ["Remove-Item \\\\?\\C:\\x", ["remove \\\\?\\C:\\x [device,share]"], ["remove //?/C:/x [device,share]"]],
    ["Remove-Item 'f.txt:s'", ["remove C:\\work\\f.txt:s [stream]"], ["remove /work/f.txt:s"]],
    ["Remove-Item PROGRA~1\\x", ["remove C:\\work\\PROGRA~1\\x [short-name]"], ["remove /work/PROGRA~1/x"]],
    ["Remove-Item 'x. '", ["remove C:\\work\\x [trailing]"], ["remove /work/x. "]],
    ["Remove-Item .../x", ["remove C:\\work\\...\\x [dots]"], ["remove /work/.../x"]],
    ["Remove-Item *.log", ["remove C:\\work (glob)"], ["remove /work (glob)"]],
  ]
  test.each(rows)("%s", (text, onWindows, onLinux) => {
    expect(files(powershell(text, pwsh()))).toEqual(onWindows)
    expect(files(powershell(text, pwshLinux()))).toEqual(onLinux)
  })

  test("a read glob is reported with its folder", () => {
    for (const ctx of [pwsh(), pwshLinux()]) {
      const item = powershell("Get-Content *.txt", ctx).paths.files[0]
      expect([item.role, item.form, item.prefix]).toEqual(["read", "glob", "."])
    }
  })
})

// PowerShell opens a path as Windows does, so a Git Bash, WSL or Cygwin drive spelling is a folder on the current drive.
describe("PowerShell drive spellings", () => {
  const win51 = windows({ shell: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })
  test.each([
    ["Remove-Item /c/work/x", "remove C:\\c\\work\\x", "remove /c/work/x"],
    ["Remove-Item /x", "remove C:\\x", "remove /x"],
    ["Remove-Item /mnt/c/x", "remove C:\\mnt\\c\\x", "remove /mnt/c/x"],
    ["Remove-Item /cygdrive/d/x", "remove C:\\cygdrive\\d\\x", "remove /cygdrive/d/x"],
  ])("%s", (text, onWindows, onLinux) => {
    expect(files(powershell(text, pwsh()))).toEqual([onWindows])
    expect(files(powershell(text, win51))).toEqual([onWindows])
    expect(files(powershell(text, pwshLinux()))).toEqual([onLinux])
  })

  test("the same spellings in Git Bash are the drive's folders", () => {
    expect(files(bash("rm /c/work/x", windows()))).toEqual(["remove C:\\work\\x"])
  })

  test("an alias that only Windows PowerShell 5.1 defines binds there", () => {
    expect(files(powershell("sc f x", win51))).toEqual(["write C:\\work\\f"])
  })
})

// A named -LiteralPath fills the slot of the first bare argument, so that argument is the next parameter.
describe("PowerShell positional binding beside a named path", () => {
  test.each([
    ["Copy-Item -LiteralPath a b", ["source C:\\work\\a", "write C:\\work\\b"]],
    ["Copy-Item -LP a b", ["source C:\\work\\a", "write C:\\work\\b"]],
    ["Rename-Item -LiteralPath C:\\dir\\a b", ["remove C:\\dir\\a", "write C:\\dir\\b"]],
    ["Set-Content -LiteralPath f '/etc/x'", ["write C:\\work\\f"]],
    ["Out-File -LiteralPath o x", ["write C:\\work\\o"]],
  ])("%s", (text, expected) => {
    expect(files(powershell(text, pwsh()))).toEqual(expected)
  })
})

describe("PowerShell directory changes", () => {
  test.each([
    ["Set-Location sub; Remove-Item x", 1, ["remove C:\\work\\x|C:\\work\\sub\\x"]],
    ["Set-Location sub", 0, []],
    ["Set-Location .; Remove-Item x", 1, ["remove C:\\work\\x"]],
    ["Set-Location -StackName s; Remove-Item x", 1, ["remove x [directory] (dynamic)"]],
    ["Set-Location $d; Remove-Item x", 1, ["remove x [directory] (dynamic)"]],
    ["Pop-Location; Remove-Item x", 1, ["remove x [directory] (dynamic)"]],
  ] as const)("%s", (text, count, expected) => {
    const result = powershell(text, pwsh())
    expect(result.paths.directoryChanges).toBe(count)
    expect(files(result)).toEqual([...expected])
  })

  test("a drive mapped by New-PSDrive leads anywhere", () => {
    const text = "New-PSDrive -Name p -PSProvider FileSystem -Root /etc; Remove-Item p:/x"
    for (const ctx of [pwsh(), pwshLinux()]) {
      const result = powershell(text, ctx)
      expect(result.paths.directoryChanges).toBe(1)
      expect(files(result)).toEqual(["remove p:/x [provider] (dynamic)"])
    }
  })
})

describe("fileEdit in PowerShell", () => {
  const yes = [
    "Set-Content f 'x'",
    "Remove-Item build -Recurse",
    "Set-Content f x | Out-Null",
    "Get-ChildItem; Remove-Item x",
    "Remove-Item x; Get-Date",
    "Clear-Content f",
    "del a",
  ]
  test.each(yes)("%s", (text) => expect(powershell(text, pwsh()).paths.fileEdit).toBe(true))

  const no = [
    "New-Item -ItemType Directory build",
    "Copy-Item a b",
    "Move-Item a b",
    "Set-Content f x > log",
    "Set-Location d; Set-Content f x",
    "Remove-Item $x",
    ".\\Remove-Item f",
    "New-Item -ItemType SymbolicLink -Path l -Value x; Set-Content l\\f y",
    "Set-Content f x -Stream s",
    "Remove-Item -Path a -Force -Recurse:$false",
    "Remove-Item *.log",
    "Remove-Item a,b",
    "Remove-Item -P a",
    "'a' | Remove-Item",
    "Remove-Item a`b",
    "if ($true) { Remove-Item inner }",
  ]
  test.each(no)("%s", (text) => expect(powershell(text, pwsh()).paths.fileEdit).toBe(false))

  test("a content edit is not a candidate where the name is a native program", () => {
    expect(powershell("rm a", pwshLinux()).paths.fileEdit).toBe(false)
    expect(powershell("rm a", pwsh()).paths.fileEdit).toBe(true)
  })
})

describe("the cmdlet table against recorded hosts", () => {
  const hosts = [
    ["Windows PowerShell 5.1", win51],
    ["pwsh 7 on Linux", linux7],
  ] as const
  const common = new Set(
    "Verbose Debug ErrorAction WarningAction InformationAction ErrorVariable WarningVariable InformationVariable OutVariable OutBuffer PipelineVariable ProgressAction WhatIf Confirm UseTransaction".split(" "),
  )
  const table = CMDLETS
  const spellings = (text: string) => text.split(" ").filter(Boolean).map((item) => item.split("|").map((name) => name.toLowerCase()))
  function describeCmdlet(entry: Entry) {
    const paths = entry.paths.map((item) => item.slice(0, item.lastIndexOf(" ")).toLowerCase().split("|"))
    const leaf = (entry.leaf ?? []).map((item) => item.toLowerCase().split("|"))
    const sibling = (entry.sibling ?? []).map((item) => item.toLowerCase().split("|"))
    const switches = spellings(entry.switches)
    const values = spellings(entry.values)
    return { all: [...paths, ...leaf, ...sibling, ...switches, ...values], switches, positional: entry.positional.map((item) => item.toLowerCase()) }
  }

  test("every cmdlet of the table is in the table module, and every table entry is recorded", () => {
    expect(Object.keys(table).sort()).toEqual(ShellPaths.cmdletNames().sort())
    for (const [, host] of hosts) expect(host.cmdlets.map((item) => item.cmdlet.toLowerCase()).sort()).toEqual(ShellPaths.cmdletNames().sort())
  })

  describe.each(hosts)("%s", (_label, host) => {
    test("every recorded parameter is in the table with the same kind, and every alias is known", () => {
      const missing = host.cmdlets.flatMap((cmdlet) => {
        const mine = describeCmdlet(table[cmdlet.cmdlet.toLowerCase()])
        return cmdlet.parameters
          .filter((param) => !common.has(param.name))
          .flatMap((param) => {
            const group = mine.all.find((names) => names[0] === param.name.toLowerCase() || names.includes(param.name.toLowerCase()))
            if (!group) return [`${cmdlet.cmdlet} -${param.name}`]
            const alias = param.aliases.filter((name) => !group.includes(name.toLowerCase()))
            if (alias.length > 0) return [`${cmdlet.cmdlet} -${param.name} aliases ${alias}`]
            const isSwitch = mine.switches.some((names) => names[0] === group[0])
            return isSwitch === param.switch ? [] : [`${cmdlet.cmdlet} -${param.name} switch ${param.switch}`]
          })
      })
      expect(missing).toEqual([])
    })

    test("positional parameters bind in the recorded order", () => {
      const wrong = host.cmdlets.flatMap((cmdlet) => {
        const mine = describeCmdlet(table[cmdlet.cmdlet.toLowerCase()]).positional
        const recorded = cmdlet.parameters
          .filter((param) => param.positions.length > 0 && !common.has(param.name))
          .sort((a, b) => Math.min(...a.positions) - Math.min(...b.positions))
          .map((param) => param.name.toLowerCase())
        // A host may lack a parameter that another has; its own positions must be an ordered subsequence of the table.
        let at = 0
        const ordered = recorded.every((name) => {
          at = mine.indexOf(name, at) + 1
          return at > 0
        })
        return ordered ? [] : [`${cmdlet.cmdlet}: table ${mine}, host ${recorded}`]
      })
      expect(wrong).toEqual([])
    })
  })

  test("mkdir is a function on Windows and a program on Linux, which is how the analysis treats it", () => {
    expect(win51.kinds.find((item) => item.name === "mkdir")?.type).toBe("Function")
    expect(linux7.kinds.find((item) => item.name === "mkdir")?.type).toBe("Application")
    expect(files(powershell("mkdir build", pwsh()))).toEqual(["create C:\\work\\build"])
    expect(reasons(powershell("mkdir build", pwshLinux()))).toEqual(["native"])
  })
})

describe("the module is pure", () => {
  const texts = ["rm -rf a b", "cp ~/k ./k", "cd sub && rm x", "echo a > f", "rm '\\\\srv\\share\\x'", "rm 'f.txt:s'", "mv -t d a"]
  const snapshot = () => [
    ...texts.flatMap((text) => [bash(text, linux()).paths, bash(text, windows()).paths]),
    ...pathCases.flatMap((text) => [powershell(text, pwsh()).paths, powershell(text, pwshLinux()).paths]),
  ]

  test("the answers do not depend on the host's platform", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!
    const baseline = JSON.stringify(snapshot())
    try {
      for (const other of ["linux", "win32", "darwin"]) {
        Object.defineProperty(process, "platform", { ...real, value: other })
        expect(JSON.stringify(snapshot())).toBe(baseline)
      }
    } finally {
      Object.defineProperty(process, "platform", real)
    }
  })

  test("the source never reads the platform or the disk", () => {
    const lines = fs.readFileSync(path.join(import.meta.dir, "../../src/shell/paths.ts"), "utf8").split("\n")
    const source = lines.filter((line) => !line.trimStart().startsWith("//")).join("\n")
    expect(source).not.toMatch(/process\.platform|node:fs|from "fs"|realpath|existsSync/)
  })

  test("a reason is a fixed code, whatever the command says", () => {
    const hostile = ["rm --\u001b]0;pwned\u0007 x", "mv -\u009b31m a b", "cp --evil\u202e a b"]
    const results = [
      ...[...hostile, ...texts].map((text) => bash(text)),
      ...pathCases.flatMap((text) => [powershell(text, pwsh()), powershell(text, pwshLinux())]),
    ]
    const codes = new Set(results.flatMap((result) => result.paths.unvalidatable.map((item) => item.reason)))
    expect([...codes].every((code) => /^[a-z-]+$/.test(code))).toBe(true)
    expect(codes.size).toBeGreaterThan(5)
  })

  test("every path case parses on both hosts", () => {
    for (const text of pathCases) {
      expect(powershell(text, pwsh()).opaque).toBeUndefined()
      expect(powershell(text, pwshLinux()).opaque).toBeUndefined()
    }
  })
})
