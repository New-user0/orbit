import path from "node:path"
import { describe, expect, test } from "bun:test"
import { ShellAnalysis } from "../../src/shell/analysis"
import { argv, bash, linux, powershell, pwsh, pwshLinux, windows } from "./helper"

describe("dialects", () => {
  const posix = [
    ["/bin/bash", "bash"],
    ["/usr/bin/zsh", "bash"],
    ["/bin/mksh", "bash"],
    ["/bin/ash", "bash"],
    ["/bin/dash", "bash"],
    ["/bin/sh", "bash"],
    ["/bin/ksh", "bash"],
    ["/opt/microsoft/powershell/7/pwsh", "pwsh"],
    ["/bin/tcsh", "unanalysed"],
    ["/bin/csh", "unanalysed"],
    ["/usr/bin/fish", "unanalysed"],
    ["nu", "unanalysed"],
    ["pwsh-preview", "unanalysed"],
  ] as const
  test.each(posix)("%s through path.posix is %s", (shell, expected) => {
    expect(ShellAnalysis.dialect(shell, { platform: "linux", path: path.posix })).toBe(expected)
  })

  const win32 = [
    ["C:\\Program Files\\Git\\bin\\bash.exe", "bash"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh"],
    ["powershell.exe", "powershell-5.1"],
    ["C:\\Windows\\System32\\cmd.exe", "unanalysed"],
  ] as const
  test.each(win32)("%s through path.win32 is %s", (shell, expected) => {
    expect(ShellAnalysis.dialect(shell, { platform: "win32", path: path.win32 })).toBe(expected)
  })

  test.each(["C:\\Windows\\System32\\cmd.exe", "/bin/tcsh", "/bin/csh", "/usr/bin/fish", "nu"])(
    "%s is opaque unsupported and never read-only",
    (shell) => {
      const platform = shell.includes("\\") ? windows({ shell }) : linux({ shell })
      const result = bash("ls", platform)
      expect(result.dialect).toBe("unanalysed")
      expect(result.opaque).toEqual({ class: "unsupported", reason: "dialect" })
      expect(result.readOnly).toBe(false)
      expect(result.commands).toEqual([])
    },
  )
})

describe("limits and empty input", () => {
  test("10,001 characters is opaque limit, without parsing", () => {
    const result = ShellAnalysis.analyze("a".repeat(10_001), linux())
    expect(result.opaque).toEqual({ class: "limit", reason: "length" })
    expect(result.readOnly).toBe(false)
  })
  test("10,000 characters is still analysed", () => {
    expect(bash("echo " + "a".repeat(9_995)).opaque).toBeUndefined()
  })
  test("an aborted parse is opaque limit", () => {
    expect(ShellAnalysis.analyze("ls", linux(), "aborted").opaque?.class).toBe("limit")
  })
  test("a missing parse is opaque, never read-only", () => {
    const result = ShellAnalysis.analyze("ls", linux())
    expect(result.opaque?.class).toBe("unsupported")
    expect(result.readOnly).toBe(false)
  })
  test.each(["", "   ", "\n\t "])("%j gives zero commands and is not read-only", (text) => {
    const result = bash(text)
    expect(result.opaque).toBeUndefined()
    expect(result.count).toBe(0)
    expect(result.readOnly).toBe(false)
    expect(result.sleepLed).toBe(false)
  })
  test("a comment alone is not read-only", () => {
    const result = bash("# nothing")
    expect(result.count).toBe(0)
    expect(result.readOnly).toBe(false)
  })

  // A parse that runs past 50 ms is cancelled in a child process, because a parser that loops blocks the event loop and
  // the test runner's own timeout never fires.
  test("a pathological input trips the parse deadline and is opaque limit", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "limits-child.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(import.meta.dir, "..", ".."),
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    const output = await new Response(child.stdout).text()
    clearTimeout(timer)
    expect(JSON.parse(output)).toEqual({ class: "limit", reason: "parse:aborted" })
  }, 30_000)
})

describe("pre-checks", () => {
  const hits: Array<[string, string]> = [
    ["ls\u00a0x", "unicode-space"],
    ["ls\u200bx", "unicode-space"],
    ["ls\u3000x", "unicode-space"],
    ["cat\\ test", "backslash"],
    ["tr\\\naceroute", "backslash"],
    ["ls x\r\nls y", "control"],
    ["ls\u0000x", "control"],
    ["ls ~[foo]", "zsh-tilde"],
    ["=curl x", "zsh-equals"],
    ["ls; =curl x", "zsh-equals"],
    ["echo {a'}',b}", "brace-quote"],
  ]
  test.each(hits)("%j is opaque unsupported (%s)", (text, code) => {
    const result = bash(text)
    expect(result.opaque).toEqual({ class: "unsupported", reason: `precheck:${code}` })
  })

  test.each(["curl -d '{\"k\":\"v\"}' x", "foo && \\\nbar", "echo A=x --opt=y", "echo \"{'a':1}\""])("%j passes", (text) => {
    expect(bash(text).opaque).toBeUndefined()
  })
  test("curl with a JSON body is not read-only: it is not on the list", () => {
    expect(bash("curl -d '{\"k\":\"v\"}' x").readOnly).toBe(false)
  })
  test("a line continuation after whitespace joins two commands", () => {
    expect(bash("foo && \\\nbar").count).toBe(2)
  })
  test("reasons never carry command text", () => {
    const secret = "TOPSECRETWORD"
    for (const text of [`echo $(${secret}`, `${secret}\u00a0x`, `echo \${${secret}}`, `echo $${secret}`, `f${secret}() { :; }`]) {
      const result = bash(text)
      expect(result.opaque).toBeDefined()
      expect(result.opaque!.reason).not.toContain(secret)
    }
  })
})

describe("structures", () => {
  test.each([
    "ls | wc -l",
    "a && b || c",
    "! grep x f",
    "(ls; pwd)",
    'for f in a b; do echo "f=$f"; done',
    "if test -f x; then cat x; else echo no; fi",
    'while read l; do echo "l=$l"; done',
    "[[ -f x ]]",
    "[ -f x ]",
    "unset X",
    "export A=1",
    "ls |& wc",
    "ls &",
    "cat <<'E'\nbody\nE",
    "cat <<< 'hi there'",
  ])("%j is not opaque", (text) => {
    expect(bash(text).opaque).toBeUndefined()
  })

  test("a statement-level assignment is tracked: X=1; echo $X", () => {
    expect(argv(bash("X=1; echo $X"))).toEqual([["echo", "1"]])
  })

  test.each([
    "{ ls; }",
    "case x in a) ls;; esac",
    "f() { :; }; ls",
    "for ((i=0;i<3;i++)); do :; done",
    "(( 1 + 1 ))",
    "A=1 B=2",
    "echo $'\\x41'",
    "echo ${X}",
    "echo $(ls)",
    "cat <(ls)",
    "cat <<EOF\nbody\nEOF",
    "cat <<'X' | rm y\nbody\nX",
    'for f in a b; do echo "$f"; done',
    "while read l; do echo \"l=$l\"; done < f",
    "echo $(",
    "echo {1..3}",
    "echo a{b,c}",
    "echo $\"x\"",
  ])("%j is opaque unsupported or syntax", (text) => {
    expect(bash(text).opaque).toBeDefined()
    expect(bash(text).readOnly).toBe(false)
  })

  test("a parse error is opaque syntax", () => {
    expect(bash("echo $(").opaque?.class).toBe("syntax")
  })

  test("count includes nested commands", () => {
    expect(bash('a "x$(b "y$(c)")"').count).toBe(3)
    expect(bash('for x in $(seq 3); do echo "n$x"; done').count).toBe(2)
    expect(bash("(a; b) | c").count).toBe(3)
  })

  test("origins say where a command came from", () => {
    const result = bash('echo "sha: $(git rev-parse HEAD)"')
    expect(result.count).toBe(2)
    expect(result.commands.find((command) => command.head === "git")?.origin).toBe("substitution")
    expect(result.readOnly).toBe(false)
    expect(bash("(ls)").commands[0].origin).toBe("subshell")
    expect(bash("a | b").commands[1].origin).toBe("pipeline")
    expect(bash("if x; then y; fi").commands.map((command) => command.origin)).toEqual(["condition", "body"])
  })

  test("features record what the command uses", () => {
    expect(bash("ls &").features.background).toBe(true)
    expect(bash("X=1 ls").features.envPrefix).toBe(true)
    expect(bash("X=1; ls").features.assignment).toBe(true)
    expect(bash("(ls)").features.subshell).toBe(true)
    expect(bash("cat <<'E'\nx\nE").features.heredoc).toBe(true)
    expect(bash("cat <<< x").features.herestring).toBe(true)
    expect(bash("echo $((1+1))").features.arithmetic).toBe(true)
    expect(bash("cd a").features.directoryChange).toBe(true)
    expect(bash("for f in a; do echo x; done").features.loop).toBe(true)
    expect(bash("if x; then y; fi").features.conditional).toBe(true)
    expect(bash('echo "x $(ls)"').features.substitution).toBe(true)
  })

  test("statements are the top-level units with their separators", () => {
    const result = bash("a && b; c &\nd")
    expect(result.statements.map((statement) => statement.commands.length)).toEqual([2, 1, 1])
    expect(result.statements.map((statement) => statement.separator)).toEqual([";", "&", "\n"])
  })
})

describe("variables", () => {
  test("D=src && ls $D resolves and rebuilds the text", () => {
    const result = bash("D=src && ls $D")
    expect(argv(result)).toEqual([["ls", "src"]])
    expect(result.commands[0].text).toBe("ls src")
  })
  test.each([
    'D="a b" && ls $D',
    "D= && ls $D",
    "true || D=x && ls $D",
    "D=x | cat && ls $D",
    'echo "$HOME"',
    "echo $HOME",
    'echo "$@"',
    "IFS=: ls",
    "PS4='$(id)' && set -x",
    "X=~/a && ls $X",
    "declare -n X=Y",
    "declare 'x[$(id)]=1'",
    "1X=y",
    "V=/etc && unset V && ls $V",
    "for PS4 in x; do :; done",
    'X=lit && if true || read X; then echo "$X"; fi',
    "echo $1",
    "echo $?",
  ])("%j is opaque", (text) => {
    expect(bash(text).opaque).toBeDefined()
  })
  test('echo "home: $HOME" is not opaque and not read-only', () => {
    const result = bash('echo "home: $HOME"')
    expect(result.opaque).toBeUndefined()
    expect(result.readOnly).toBe(false)
  })
  test("an assignment on the right of || is unknown afterwards, even when it was known before", () => {
    expect(bash("D=a; true || D=b; ls $D").opaque).toBeDefined()
    expect(bash('D=a; true || D=b; ls "x$D"').opaque).toBeUndefined()
  })
  test("a pipeline stage, a subshell and a substitution do not leak assignments", () => {
    expect(bash("(D=x); ls $D").opaque).toBeDefined()
    expect(bash("D=a; (D=b); ls $D").commands.at(-1)?.argv[1].value).toBe("a")
  })
  test("an assignment before & does not leak", () => {
    expect(bash("D=x & ls $D").opaque).toBeDefined()
  })
  test("read in a condition on a known value is opaque; elsewhere it makes the name unknown", () => {
    expect(bash("X=1; while read X; do :; done").opaque).toBeDefined()
    expect(bash("X=1; read X; ls $X").opaque).toBeDefined()
  })
  test("+= appends and an unknown side makes it unknown", () => {
    expect(argv(bash("D=a; D+=b; ls $D"))).toEqual([["ls", "ab"]])
    expect(bash('D=$(date); D+=b; ls $D').opaque).toBeDefined()
  })
})

describe("substitutions inside strings", () => {
  test("a command substitution in an assignment is pulled out", () => {
    const result = bash('X=$(date) && echo "t $X"')
    expect(result.count).toBe(2)
  })
  test("cat with a quoted heredoc is replaced by its single-line body", () => {
    const result = bash("echo \"$(cat <<'E'\n/etc/passwd\nE\n)\"")
    expect(argv(result)).toEqual([["echo", "/etc/passwd"]])
    expect(result.count).toBe(1)
  })
  test("the same with /proc/self/environ is opaque", () => {
    expect(bash("echo \"$(cat <<'E'\n/proc/self/environ\nE\n)\"").opaque).toBeDefined()
  })
  test("a multi-line body is dropped from the value", () => {
    expect(argv(bash("echo \"$(cat <<'E'\na\nb\nE\n)\""))).toEqual([["echo", ""]])
  })
  test("a string keeps its newline", () => {
    expect(bash('echo "a\nb"').commands[0].argv[1].value).toBe("a\nb")
  })
  test("only the four escapes are removed in a string", () => {
    expect(bash('echo "a\\$b \\" \\\\x \\n"').commands[0].argv[1].value).toBe('a$b " \\x \\n')
  })
})

describe("redirects", () => {
  const redirect = (text: string) => bash(text).commands[0].redirects[0]
  test("a write", () => expect(redirect("cat a > out")).toMatchObject({ write: true, nullSink: false, target: "out" }))
  test("a null sink", () => expect(redirect("cat a 2>/dev/null")).toMatchObject({ write: true, nullSink: true, fd: 2 }))
  test.each(["/dev/stdout", "/dev/stderr", "/dev/fd/3"])("%s is a null sink", (target) => {
    expect(redirect(`cat a > ${target}`).nullSink).toBe(true)
  })
  test("a descriptor copy", () => expect(redirect("ls >&2")).toMatchObject({ write: false, nullSink: false }))
  test("2>&1 is a descriptor copy", () => expect(bash("ls 2>&1").commands[0].redirects[0].write).toBe(false))
  test(">&word is a file write", () => expect(redirect("ls >&out")).toMatchObject({ write: true, nullSink: false }))
  test("<> does not parse in this grammar, so it is opaque", () => expect(bash("cat <> f").opaque?.class).toBe("syntax"))
  test("< is a read", () => expect(bash("cat < f").readPaths).toEqual(["f"]))
  test.each(["ls > $(mktemp)", "ls > {a,b}", 'ls > "$X"'])("%j is opaque", (text) => {
    expect(bash(text).opaque).toBeDefined()
  })
  test("a redirect with no command is one empty command that writes", () => {
    const result = bash("> f")
    expect(result.count).toBe(1)
    expect(result.commands[0].argv).toEqual([])
    expect(result.commands[0].redirects[0].write).toBe(true)
    expect(result.readOnly).toBe(false)
  })
  test("a redirect goes to the command it follows, not to a substitution inside it", () => {
    const result = bash('echo "x $(ls)" > out')
    expect(result.commands.find((command) => command.head === "echo")?.redirects).toHaveLength(1)
    expect(result.commands.find((command) => command.head === "ls")?.redirects).toHaveLength(0)
  })
  test("a here-string with a comment line is opaque", () => {
    expect(bash("cat <<< $'a\\n#b'").opaque).toBeDefined()
    expect(bash('cat <<< "a\n#b"').opaque).toBeDefined()
  })
})

describe("PowerShell aliases by edition and platform", () => {
  const head = (text: string, ctx: ShellAnalysis.Context) => powershell(text, ctx).commands[0].head
  test("ls is Get-ChildItem for pwsh on Windows", () => expect(head("ls", pwsh())).toBe("get-childitem"))
  test("ls is the native ls for pwsh on Linux", () => {
    const result = powershell("ls", pwshLinux())
    expect(result.commands[0].head).toBe("ls")
    expect(result.readOnly).toBe(false)
  })
  test("cat is the native cat for pwsh on darwin", () => {
    const result = powershell("cat a", pwshLinux({ platform: "darwin" }))
    expect(result.commands[0].head).toBe("cat")
    expect(result.readOnly).toBe(false)
  })
  test("sc is Set-Content only in 5.1", () => {
    expect(head("sc x y", windows({ shell: "powershell.exe" }))).toBe("set-content")
    expect(head("sc x y", pwsh())).toBe("sc")
  })
  test("curl is Invoke-WebRequest only in 5.1", () => {
    expect(head("curl u", windows({ shell: "powershell.exe" }))).toBe("invoke-webrequest")
    expect(head("curl u", pwsh())).toBe("curl")
  })
  test("sort is never Sort-Object", () => {
    for (const ctx of [pwsh(), windows({ shell: "powershell.exe" }), pwshLinux()]) expect(head("sort x", ctx)).toBe("sort")
  })
  test("ps e is not read-only on Linux, where ps is the native program", () => {
    expect(powershell("ps e", pwshLinux()).readOnly).toBe(false)
  })
  test("Get-Process e is read-only on Windows, where ps is an alias", () => {
    expect(head("ps e", pwsh())).toBe("get-process")
    expect(powershell("ps e", pwsh()).readOnly).toBe(true)
  })
  test("a module-qualified name is an application", () => {
    const result = powershell("Microsoft.PowerShell.Management\\Get-ChildItem", pwsh())
    expect(result.commands[0].application).toBe(true)
    expect(result.readOnly).toBe(false)
  })
  test("the case of a cmdlet does not matter", () => expect(powershell("GET-CHILDITEM", pwsh()).readOnly).toBe(true))
  test("where.exe is read-only, .\\where.exe is not", () => {
    expect(powershell("where.exe git", pwsh()).readOnly).toBe(true)
    expect(powershell(".\\where.exe git", pwsh()).readOnly).toBe(false)
  })
  test("git.exe is an application", () => {
    const result = powershell("git.exe status", pwsh())
    expect(result.commands[0].application).toBe(true)
    expect(result.commands[0].head).toBe("git")
  })
  test("the edition comes from the shell, not from the parser host", () => {
    expect(ShellAnalysis.dialect("C:\\x\\powershell.exe", { platform: "win32", path: path.win32 })).toBe("powershell-5.1")
    expect(powershell("sc x y", windows({ shell: "C:\\x\\pwsh.exe" })).commands[0].head).toBe("sc")
  })
  test("an invalid parse is opaque and never read-only", () => {
    for (const reason of ["parse-errors", "timeout", "no-host", "spawn", "too-long"] as const) {
      const result = ShellAnalysis.analyze("Get-ChildItem", pwsh(), { valid: false, reason })
      expect(result.opaque).toBeDefined()
      expect(result.opaque!.reason).toBe(`powershell:${reason}`)
      expect(result.readOnly).toBe(false)
    }
    expect(ShellAnalysis.analyze("x", pwsh(), { valid: false, reason: "parse-errors" }).opaque?.class).toBe("syntax")
    expect(ShellAnalysis.analyze("x", pwsh(), { valid: false, reason: "timeout" }).opaque?.class).toBe("unsupported")
  })
  test("a pipeline chain does not parse in 5.1 and so is opaque", () => {
    expect(powershell("Get-ChildItem && Get-Content a", pwsh()).readOnly).toBe(false)
  })
})

describe("wrappers", () => {
  const inner = (text: string) => bash(text).commands[0]
  test.each([
    ["timeout 5 cat x", "cat"],
    ["timeout -k 5 10 cat x", "cat"],
    ["timeout --signal=KILL 10 cat x", "cat"],
    ["timeout -s KILL 10 cat x", "cat"],
    ["timeout -- 10 cat x", "cat"],
    ["nice -n 5 cat x", "cat"],
    ["nice -5 cat x", "cat"],
    ["nice cat x", "cat"],
    ["stdbuf -o0 -eL cat x", "cat"],
    ["stdbuf -o 0 cat x", "cat"],
    ["env A=1 cat x", "cat"],
    ["env -i -u A cat x", "cat"],
    ["env", "env"],
    ["nohup -- cat x", "cat"],
    ["time cat x", "cat"],
    ["sudo cat x", "cat"],
    ["doas cat x", "cat"],
    ["exec cat x", "cat"],
    ["timeout 5 nice -n 2 env A=1 cat x", "cat"],
    ["command -v git", "command"],
    ["builtin echo x", "builtin"],
  ])("%s has the inner head %s and is not read-only", (text, expected) => {
    const command = inner(text)
    expect(command.inner[0]).toBe(expected)
    expect(command.wrapper).toBeUndefined()
    expect(bash(text).readOnly).toBe(false)
  })
  test.each([
    "timeout .5 cat x",
    "timeout --bogus 5 cat x",
    "timeout inf cat x",
    "timeout +5 cat x",
    "timeout 5",
    "nice $((0-5)) jq .",
    "nice -n $X cat",
    "stdbuf --output 0 cat x",
    "stdbuf cat x",
    "env -S 'cat x'",
    "env -C /tmp cat",
    "sudo -u root cat x",
  ])("%s is an unanalysable wrapper and is not read-only", (text) => {
    const result = bash(text)
    // A wrapper whose options cannot be read is a value on the command, or the text is opaque for another reason.
    if (!result.opaque) expect(result.commands[0].wrapper).toBe("unanalysable")
    expect(result.readOnly).toBe(false)
  })
})

describe("sleepLed", () => {
  test.each([
    ["sleep 300", true],
    ["sleep 1; sleep 2", true],
    ["sleep 5 && npm run build", false],
    ["nice sleep 5", false],
    ["sleep 5 | cat", false],
    ["", false],
  ])("bash %j is %p", (text, expected) => {
    expect(bash(text).sleepLed).toBe(expected)
  })
  test("PowerShell Start-Sleep, and sleep as an alias or a program", () => {
    expect(powershell("Start-Sleep 60", pwsh()).sleepLed).toBe(true)
    expect(powershell("sleep 60", pwsh()).sleepLed).toBe(true)
    expect(powershell("sleep 60", pwshLinux()).sleepLed).toBe(true)
    expect(powershell("sleep 5; npm run build", pwsh()).sleepLed).toBe(false)
    expect(powershell("Start-Sleep 5; npm run build", pwsh()).sleepLed).toBe(false)
  })
})

describe("paths through path.win32 on any host", () => {
  test("~ is expanded with the injected home and path module", () => {
    expect(bash("cat ~/a", windows()).readPaths).toEqual(["C:\\Users\\u\\a"])
    expect(bash("cat ~/a", linux()).readPaths).toEqual(["/home/u/a"])
  })
  test("~user is not read-only", () => {
    expect(bash("cat ~u/a", windows()).readOnly).toBe(false)
  })
  test("cat.exe is cat on win32 and its own name elsewhere", () => {
    expect(bash("cat.exe x", windows()).readOnly).toBe(true)
    expect(bash("cat.exe x", linux()).readOnly).toBe(false)
  })
  test("UNC paths are not read-only on win32 only", () => {
    for (const text of ["cat //srv/share/x", "cat '\\\\srv\\share\\x'", "cat x@SSL@443", "cat /dev/DavWWWRoot/x", "cat < //srv/x"]) {
      expect(bash(text, windows()).readOnly).toBe(false)
    }
    expect(bash("cat //srv/share/x", linux()).readOnly).toBe(true)
    expect(bash("cat 'https://x/y'", windows()).readOnly).toBe(true)
  })
  test("a leading cd into the working folder is dropped, in the MSYS spelling too", () => {
    expect(bash("cd /c/work && ls", windows({ cwd: "C:\\work" })).readOnly).toBe(true)
    expect(bash("cd C:/work && ls", windows({ cwd: "C:\\work" })).readOnly).toBe(true)
    expect(bash("cd /work && ls", linux()).readOnly).toBe(true)
    expect(bash("cd /c/other && ls", windows({ cwd: "C:\\work" })).readOnly).toBe(false)
  })
  test("PowerShell on win32 reads the home with path.win32", () => {
    expect(powershell("Set-Location src", pwsh()).readPaths).toEqual(["src"])
  })
})

describe("project-local heads (class 10)", () => {
  test.each(["/usr/bin::/bin", ".:/usr/bin", "bin:/usr/bin", "/usr/bin:", "/usr/bin:relative/dir"])(
    "PATH %j makes ls not read-only",
    (value) => {
      expect(bash("ls", linux({ env: { PATH: value } })).readOnly).toBe(false)
    },
  )
  test("a clean PATH leaves ls read-only", () => {
    expect(bash("ls", linux({ env: { PATH: "/usr/bin:/bin" } })).readOnly).toBe(true)
  })
  test("win32 splits on ; and unquotes", () => {
    expect(bash("ls", windows({ env: { Path: '"C:\\Windows";C:\\bin' } })).readOnly).toBe(true)
    expect(bash("ls", windows({ env: { PATH: "C:\\Windows;." } })).readOnly).toBe(false)
    // An empty entry is dropped by Git Bash and does not search the working folder (FU-M3-180); a relative one does.
    expect(bash("ls", windows({ env: { Path: "C:\\Windows;;C:\\bin" } })).readOnly).toBe(true)
    expect(bash("ls", windows({ env: { Path: "C:\\Windows;;bin" } })).readOnly).toBe(false)
  })
  test("the locator decides for one head only", () => {
    const ctx = linux({ local: (head) => head === "ls" })
    expect(bash("ls", ctx).readOnly).toBe(false)
    expect(bash("cat x", ctx).readOnly).toBe(true)
  })
  test("PowerShell: a native is local, a cmdlet is not looked up on PATH", () => {
    const ctx = pwsh({ local: (head) => head === "hostname" })
    expect(powershell("hostname", ctx).readOnly).toBe(false)
    expect(powershell("Get-ChildItem src", ctx).readOnly).toBe(true)
  })
  test("a statement-level PATH assignment is not read-only", () => {
    expect(bash("PATH=.; ls").readOnly).toBe(false)
    expect(bash("PAGER=sh; man ls").readOnly).toBe(false)
    expect(bash("X=1; ls").readOnly).toBe(true)
  })
})
